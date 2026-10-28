// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 被引量列（0.6.0 新增，0.85.0 取数链路重写）
 * 数据来源：Semantic Scholar Graph API（免费公开）。
 * 架构与期刊分区列同构：查询队列 + 本地持久缓存 + 负缓存 + 限速。
 * 缓存文件：DataDirectory/papilot-s2-citations.json
 * 缓存键："doi:<规范化doi>" 或 "title:<规范化标题>"
 * 值：{c: 被引量, ic: 高影响被引, venue, year, t} 或 {neg:1, reason, t, retryAfter}
 *
 * ⚠️ 0.85.0（2026-10-27 用户报「被引量一列全是空白」）根因与修法：
 *  根因一 · 批量端点被 S2 强制限流。**未配 API Key 时 POST /paper/batch 恒 429**
 *    （本机实测连续 6 次全 429；同期 GET /paper/{id} 连打 8 次全 200）。
 *    旧实现只有批量一条链路：429 后被 `_handleFetchError` 无上限地「退避 10s 再整批
 *    回队」，形成**永不收敛的重试环**——列永远停在「…」，而且这圈空转持续占用共享
 *    额度，把本来能用的单条接口也拖垮。实测缓存里 307 条 http-400、225 条 http-net
 *    就是这条坏链路的残骸。
 *    现：无 Key 直接走**逐条 GET**（可靠），有 Key 才批量；批量一旦判定不可用
 *    （429/400）本会话内自动降级为逐条，不再回头打批量端点。
 *  根因二 · 数据到了行不重绘。旧实现只有 `refreshColumns()` 一条通道（分区列 0.18.0
 *    就踩过同样的坑并已改成双通道）。现按分区列同款：refreshColumns +
 *    `Notifier.trigger("redraw","item",等待中的 ids)`，并只在结果真正到达后发一次。
 *  根因三 · 失败与「加载中」不可区分：429 永远显示「…」，用户无法判断是慢还是坏。
 *    现：单条查询有重试上限（超过即写负缓存 1 小时后再试），悬停可看到失败原因，
 *    设置面板可看到在线状态（`s2Status()`）。
 */

/* 数据新鲜度：正结果 7 天后后台静默刷新（stale-while-revalidate——旧值继续显示，
 * 不闪成「…」）。此前正结果永不过期，与设置面板「缓存 24 小时」的说法不符。 */
/* global Zotero, IOUtils, PathUtils, Prefs, I18n, S2Client, ItemSel */

var CitationColumn = {
  COLUMN_KEY: "papilot-citations",

  /** 正结果的新鲜度：超期后仍旧显示旧值，同时后台重查（stale-while-revalidate） */
  POS_TTL: 7 * 24 * 3600 * 1000,
  /** 单条查询遇到 429 的最大重试次数（超过即写负缓存，避免无限环） */
  MAX_ATTEMPTS: 4,
  /** 429 指数退避基数（测试可下调；上限 5 分钟） */
  BACKOFF_BASE: 4000,
  /** 单条查询字段（只要被引量相关，字段越少越省额度） */
  SINGLE_FIELDS: "title,year,venue,citationCount,influentialCitationCount",
  /** 标题检索的应用层超时：S2 对中文标题常「挂住不回」，长超时会把队列卡死 */
  TITLE_TIMEOUT_MS: 8000,

  _cache: new Map(),        // cacheKey -> 上述值
  _lookupCache: new Map(),  // itemID -> 显示值
  _doiQueue: [],
  _titleQueue: [],
  _queued: new Set(),       // cacheKey 去重
  _working: false,
  _backoffUntil: 0,         // 429 退避截止时间戳
  _refreshTimer: null,
  _saveTimer: null,
  _cacheLoaded: false,
  _registered: false,
  _pendingRefresh: new Set(), // 等待结果的 itemID（数据到达后精准 redraw）

  /* 取数链路状态（0.85.0） */
  _batchOk: null,      // null=未判定 / true=批量可用 / false=已降级为逐条
  _consecutive429: 0,  // 连续 429 次数（指数退避用）
  _lastError: "",      // 最近一次失败原因（设置面板与悬停可见）
  _lastOkAt: 0,        // 最近一次成功取数时间

  /* ================= 规范化 ================= */

  normalizeDOI(doi) {
    let d = String(doi || "").trim().toLowerCase();
    d = d.replace(/^https?:\/\/(dx\.)?doi\.org\//, "").replace(/^doi:\s*/, "").trim();
    return d;
  },

  normalizeTitle(title) {
    return String(title || "").toLowerCase().replace(/[^a-z0-9一-鿿]/g, "");
  },

  _enabled() {
    return !!Prefs.get("citationColumnEnabled", true);
  },

  /* ================= 持久缓存 ================= */

  _cacheFile() {
    return PathUtils.join(Zotero.DataDirectory.dir, "papilot-s2-citations.json");
  },

  async loadCache() {
    if (this._cacheLoaded) return;
    this._cacheLoaded = true;
    try {
      const obj = JSON.parse(await IOUtils.readUTF8(this._cacheFile()));
      for (const k of Object.keys(obj || {})) this._cache.set(k, obj[k]);
      Zotero.debug(`Papilot: S2 被引量缓存 ${this._cache.size} 条`);
    } catch (e) { /* 无缓存文件属正常 */ }
  },

  _saveCacheSoon() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(async () => {
      this._saveTimer = null;
      try {
        const obj = {};
        for (const [k, v] of this._cache) obj[k] = v;
        await IOUtils.writeUTF8(this._cacheFile(), JSON.stringify(obj));
      } catch (e) {
        Zotero.debug("Papilot: S2 被引量缓存写入失败 " + e);
      }
    }, 3000);
  },

  async clearCache() {
    this._cache.clear();
    this._queued.clear();
    this._doiQueue.length = 0;
    this._titleQueue.length = 0;
    this._lookupCache.clear();
    this._pendingRefresh.clear();
    this._batchOk = null;
    this._backoffUntil = 0;
    this._consecutive429 = 0;
    this._lastError = "";
    try { await IOUtils.remove(this._cacheFile()); } catch (e) { /* ignore */ }
    this._refreshColumns();
  },

  cacheSize() {
    return this._cache.size;
  },

  /* ================= 查询队列 ================= */

  _keyFor(item) {
    const get = (f) => { try { return item.getField(f) || ""; } catch (e) { return ""; } };
    const doi = this.normalizeDOI(get("DOI"));
    // DOI 必须形如 10.xxxx/yyy：脏值（"待补"、"见附件"、粘贴了半截链接）进批量会
    // 让整批返回 400（缓存里的 http-400 就是这么来的），直接判为无 DOI。
    if (doi && /^10\.\d{4,9}\//.test(doi)) return { cacheKey: "doi:" + doi, batchId: "DOI:" + doi, kind: "doi" };
    const title = get("title");
    if (title && Prefs.get("s2TitleSearch", true)) {
      return { cacheKey: "title:" + this.normalizeTitle(title), title, kind: "title" };
    }
    return null;
  },

  /** force=true 时即使缓存已有也重新入队（正结果过期后的后台刷新用） */
  _enqueue(entry, force) {
    if (!entry) return;
    if (!force) {
      if (this._cache.has(entry.cacheKey) || this._queued.has(entry.cacheKey)) return;
    } else if (this._queued.has(entry.cacheKey)) {
      return;
    }
    this._queued.add(entry.cacheKey);
    (entry.kind === "doi" ? this._doiQueue : this._titleQueue).push(entry);
    if (!this._working) this._work();
  },

  /** 命中条目写入缓存 */
  _storeHit(cacheKey, p) {
    this._cache.set(cacheKey, {
      c: typeof p.citationCount === "number" ? p.citationCount : 0,
      ic: typeof p.influentialCitationCount === "number" ? p.influentialCitationCount : 0,
      venue: p.venue || "",
      year: p.year || 0,
      title: p.title || "",
      t: Date.now(),
    });
  },

  _storeNeg(cacheKey, reason, retryMs) {
    this._cache.set(cacheKey, {
      neg: 1,
      reason: reason || "",
      t: Date.now(),
      retryAfter: Date.now() + (retryMs || 7 * 24 * 3600 * 1000),
    });
  },

  /* ================= 取数主循环（0.85.0 重写） =================
   * 队列骨架不变；改变的是每一步**走哪条链路**与**失败怎么退**：
   *   DOI 队列：有 Key（批量额度充足）→ 批量；无 Key 或批量已判定不可用 → 逐条 GET
   *   标题队列：检索接口（限流更紧），失败按次数上限写负缓存，绝不无限回队
   */
  async _work() {
    if (this._working) return;
    this._working = true;
    try {
      while (this._doiQueue.length || this._titleQueue.length) {
        const wait = this._backoffUntil - Date.now();
        // 单次最多睡 20s：退避期间新入队的条目仍能及时被发现（且不阻塞事件循环）
        if (wait > 0) await new Promise((r) => setTimeout(r, Math.min(wait, 20000)));

        if (this._doiQueue.length) await this._doiStep();
        else if (this._titleQueue.length) await this._titleStep();
        else break;

        this._saveCacheSoon();
        this._refreshSoon();
      }
    } finally {
      this._working = false;
      // 队列清空后补一次刷新：最后一批结果也要落到行上
      if (!this._doiQueue.length && !this._titleQueue.length) this._refreshSoon();
    }
  },

  /** 是否配了 S2 API Key（客户端可能尚未装配 → 一律按「没有」处理，不抛） */
  _hasKey() {
    try {
      return !!(typeof S2Client !== "undefined" && S2Client
        && typeof S2Client._apiKey === "function" && S2Client._apiKey());
    } catch (e) { return false; }
  },

  _gap() {
    return this._hasKey() ? 250 : 1100;
  },

  async _doiStep() {
    // 无 Key 时批量端点**恒 429**（2026-10-27 实测），别浪费那一轮请求与 10s 退避
    if (this._hasKey() && this._batchOk !== false) return this._doiBatch();
    return this._doiSingle();
  },

  /** 批量（仅在有 Key 时走）：每批最多 50 条，响应与请求顺序对齐 */
  async _doiBatch() {
    const batch = this._doiQueue.splice(0, 50);
    for (const e of batch) this._queued.delete(e.cacheKey);
    try {
      const papers = await S2Client.batch(batch.map((e) => e.batchId));
      for (let i = 0; i < batch.length; i++) {
        const p = papers && papers[i];
        if (p && typeof p.citationCount === "number") this._storeHit(batch[i].cacheKey, p);
        else this._storeNeg(batch[i].cacheKey, "not-found");
      }
      this._consecutive429 = 0;
      this._lastError = "";
      this._lastOkAt = Date.now();
    } catch (e) {
      const status = this._statusOf(e);
      // 批量端点被限流/拒绝 → 本会话彻底降级为逐条，整批回队（不计入条目重试次数）
      if (status === 429 || status === 400 || status === 403 || status === 401) {
        if (this._batchOk !== false) {
          Zotero.debug(`Papilot: S2 批量端点不可用（HTTP ${status}），本会话改为逐条查询`);
        }
        this._batchOk = false;
        for (const entry of batch) {
          this._queued.add(entry.cacheKey);
          this._doiQueue.unshift(entry);
        }
        return;   // 下一步即走 _doiSingle，不再额外等待
      }
      this._handleFetchError(batch, e);
    }
    await new Promise((r) => setTimeout(r, this._gap()));
  },

  /** 逐条（无 Key 时的主链路）：GET /paper/DOI:xxxx，实测 1.1s 间隔稳定可用 */
  async _doiSingle() {
    const entry = this._doiQueue.shift();
    if (!entry) return;
    this._queued.delete(entry.cacheKey);
    const doi = String(entry.cacheKey).replace(/^doi:/, "");
    try {
      const p = await S2Client.paperById("DOI:" + doi, this.SINGLE_FIELDS);
      if (p && typeof p.citationCount === "number") {
        this._storeHit(entry.cacheKey, p);
        this._consecutive429 = 0;
        this._lastError = "";
        this._lastOkAt = Date.now();
      } else {
        this._storeNeg(entry.cacheKey, "not-found");
      }
    } catch (e) {
      this._handleFetchError([entry], e);
    }
    await new Promise((r) => setTimeout(r, this._gap()));
  },

  async _titleStep() {
    const entry = this._titleQueue.shift();
    if (!entry) return;
    this._queued.delete(entry.cacheKey);
    try {
      const cands = await S2Client.searchByTitle(entry.title, 5, undefined, this.TITLE_TIMEOUT_MS);
      const want = this.normalizeTitle(entry.title);
      const hit = cands.find((p) => this.normalizeTitle(p.title) === want);
      if (hit && typeof hit.citationCount === "number") {
        this._storeHit(entry.cacheKey, hit);
        this._consecutive429 = 0;
        this._lastOkAt = Date.now();
      } else {
        this._storeNeg(entry.cacheKey, "not-found");
      }
    } catch (e) {
      this._handleFetchError([entry], e);
    }
    await new Promise((r) => setTimeout(r, this._gap()));
  },

  _statusOf(e) {
    return (e && e.xmlhttp && e.xmlhttp.status)
      || (e && e.response && e.response.status) || 0;
  },

  /**
   * 失败分类退避（0.85.0 关键修复：**绝不再无限回队**）
   *   404        → 未收录，写负缓存 7 天
   *   429        → 指数退避（4s→8s→…→5min），单条最多重试 MAX_ATTEMPTS 次，
   *                超过即写负缓存 1 小时后再试（否则就是旧版那个永不收敛的空转环）
   *   其他网络   → 30 分钟后重试
   */
  _handleFetchError(entries, e) {
    const status = this._statusOf(e);
    const msg = (e && (e.message || e)) || "";
    Zotero.debug(`Papilot: S2 查询失败（${status || msg}），${entries.length} 条`);
    this._lastError = status ? "HTTP " + status : String(msg).slice(0, 120);

    if (status === 404) {
      for (const entry of entries) this._storeNeg(entry.cacheKey, "not-found");
      this._consecutive429 = 0;
      return;
    }

    if (status === 429) {
      this._consecutive429++;
      const backoff = Math.min(5 * 60 * 1000, this.BACKOFF_BASE * Math.pow(2, Math.min(this._consecutive429, 7)));
      this._backoffUntil = Date.now() + backoff;
      this._lastError = "S2 限流（429），退避 " + Math.round(backoff / 1000) + "s";
      for (const entry of entries) {
        entry._attempts = (entry._attempts || 0) + 1;
        if (entry._attempts >= this.MAX_ATTEMPTS) {
          // 放弃本条：1 小时后再试（负缓存到期由 lookup 自动重查）
          this._storeNeg(entry.cacheKey, "rate-limited", 60 * 60 * 1000);
        } else {
          // 幂等：同一条目已在队里就不要再插一次（否则队列会因重复项膨胀）
          if (!this._queued.has(entry.cacheKey)) {
            this._queued.add(entry.cacheKey);
            (entry.kind === "doi" ? this._doiQueue : this._titleQueue).unshift(entry);
          }
        }
      }
      return;
    }

    // 超时（S2 对中文标题常挂住）单独标记：别 30 分钟就回来再挂一次，冷却 6 小时
    if (!status && /超时|timeout|timed out/i.test(msg)) {
      this._lastError = "S2 请求超时";
      for (const entry of entries) this._storeNeg(entry.cacheKey, "timeout", 6 * 60 * 60 * 1000);
      return;
    }

    for (const entry of entries) {
      this._storeNeg(entry.cacheKey, "http-" + (status || "net"), 30 * 60 * 1000);
    }
  },

  /* ================= 刷新与查找 ================= */

  _refreshSoon() {
    if (this._refreshTimer) return;
    this._refreshTimer = setTimeout(() => {
      this._refreshTimer = null;
      this._refreshColumns();
    }, 800);
  },

  /** 双通道刷新（与分区列 0.18.0 同款）：refreshColumns + 精准 redraw。
   *  只发 refreshColumns 时，不同 Zotero 版本对行数据的缓存处理不一致——
   *  数据早就到了，行上还挂着「…」，用户看到的就是「这一列不显示」。 */
  _refreshColumns() {
    try { Zotero.ItemTreeManager.refreshColumns(); } catch (e) { /* ignore */ }
    const ids = [...this._pendingRefresh];
    this._pendingRefresh.clear();
    try {
      if (ids.length) Zotero.Notifier.trigger("redraw", "item", ids, {}, true);
      else Zotero.Notifier.trigger("redraw", "item", []);
    } catch (e) {
      try { Zotero.Notifier.trigger("redraw", "item", []); } catch (e2) { /* ignore */ }
    }
  },

  /** dataProvider：返回数字（数值排序）；"…" 为查询中占位 */
  lookup(item) {
    if (!item || !item.isRegularItem || !item.isRegularItem()) return "";
    if (!this._enabled()) return "";
    if (this._lookupCache.has(item.id)) {
      const cached = this._lookupCache.get(item.id);
      // 已显示的值 + 正结果过期 → 后台刷新，但**不**把已显示的值抹成「…」
      if (cached !== "" && typeof cached === "number") this._maybeStaleRefresh(item);
      return cached;
    }
    const entry = this._keyFor(item);
    if (!entry) {
      this._lookupCache.set(item.id, "");
      return "";
    }
    const hit = this._cache.get(entry.cacheKey);
    let val;
    if (!hit) {
      this._enqueue(entry);
      this._pendingRefresh.add(item.id);
      val = "…";
    } else if (hit.neg) {
      if (hit.retryAfter && Date.now() > hit.retryAfter) {
        this._cache.delete(entry.cacheKey);
        this._enqueue(entry);
        this._pendingRefresh.add(item.id);
        val = "…";
      } else {
        val = "";
      }
    } else {
      val = hit.c;
      this._maybeStaleRefresh(item);
    }
    if (this._lookupCache.size > 5000) this._lookupCache.clear();
    if (val !== "…") this._lookupCache.set(item.id, val);
    return val;
  },

  /** 正结果超过 POS_TTL → 入队后台刷新（stale-while-revalidate，界面保持旧值） */
  _maybeStaleRefresh(item) {
    if (!this._enabled()) return;
    const entry = this._keyFor(item);
    if (!entry) return;
    const hit = this._cache.get(entry.cacheKey);
    if (!hit || hit.neg) return;
    if (!hit.t || Date.now() - hit.t < this.POS_TTL) return;
    hit.t = Date.now();          // 先打戳，避免每次 render 都重复入队
    this._enqueue(entry, true);
  },

  /** 单元格悬停详情 */
  lookupDetail(item) {
    if (!item || !item.isRegularItem || !item.isRegularItem()) return "";
    const zh = I18n.isZh;
    const entry = this._keyFor(item);
    if (!entry) return zh ? "该条目没有 DOI，无法查询被引量" : "No DOI for this item";
    const hit = this._cache.get(entry.cacheKey);
    if (!hit) return zh ? "查询中…" : "Looking up…";
    if (hit.neg) {
      const zhMap = {
        "not-found": "Semantic Scholar 未收录该文献",
        "timeout": "Semantic Scholar 响应超时（稍后自动重试）",
        "rate-limited": "Semantic Scholar 限流（稍后自动重试）",
      };
      const enMap = {
        "not-found": "Not indexed by Semantic Scholar",
        "timeout": "Semantic Scholar timed out (will retry)",
        "rate-limited": "Rate limited by Semantic Scholar (will retry)",
      };
      const m = hit.reason && (zh ? zhMap[hit.reason] : enMap[hit.reason]);
      let s = m || (zh ? "查询失败：" + (hit.reason || "未知") : "Lookup failed: " + (hit.reason || "unknown"));
      if (hit.retryAfter) {
        try {
          s += "\n" + (zh ? "下次自动重试：" : "Retry after: ")
            + new Date(hit.retryAfter).toLocaleString();
        } catch (e) { /* ignore */ }
      }
      return s;
    }
    const lines = [`${zh ? "被引" : "Citations"}: ${hit.c}`];
    if (hit.ic) lines.push(`${zh ? "高影响被引" : "Influential"}: ${hit.ic}`);
    if (hit.venue) lines.push(`${zh ? "来源" : "Venue"}: ${hit.venue}${hit.year ? " (" + hit.year + ")" : ""}`);
    if (hit.t) {
      try { lines.push((zh ? "更新于 " : "Updated ") + new Date(hit.t).toLocaleString()); } catch (e) { /* ignore */ }
    }
    lines.push("Semantic Scholar");
    return lines.join("\n");
  },

  /* ================= 状态自检（设置面板 / 排障用） ================= */

  /**
   * 在线状态：
   *   "ok"          = 最近有成功取数
   *   "rate_limited"= 正在 429 退避（下次重试时间见 nextRetryAt）
   *   "no_key"      = 未配 Key，走逐条查询（可靠但慢，约 1 条/秒）
   *   "idle"        = 尚未取数
   */
  s2Status() {
    const hasKey = this._hasKey();
    let state = "idle";
    if (this._consecutive429 > 0 && this._backoffUntil > Date.now()) state = "rate_limited";
    else if (this._lastOkAt) state = "ok";
    else if (!hasKey) state = "no_key";
    return {
      state,
      hasKey,
      batch: hasKey && this._batchOk !== false,
      error: this._lastError,
      lastOkAt: this._lastOkAt,
      nextRetryAt: state === "rate_limited" ? this._backoffUntil : 0,
      queue: this._doiQueue.length + this._titleQueue.length,
    };
  },

  /** 手动重置限流状态（设置面板按钮 / 排障） */
  resetRateLimit() {
    this._backoffUntil = 0;
    this._consecutive429 = 0;
    this._batchOk = null;
    this._lastError = "";
    for (const [, v] of this._cache) {
      if (v && v.neg && v.reason === "rate-limited") v.retryAfter = 0;
    }
    this._lookupCache.clear();
    this._refreshColumns();
    if (!this._working) this._work();
    return this.s2Status();
  },

  /** 菜单入口：强制重新抓取选中条目的被引量 */
  async refreshForSelected() {
    const zp = Zotero.getActiveZoteroPane();
    if (!zp) return;
    const items = ItemSel.regularOnly(zp.getSelectedItems() || []);
    if (!items.length) {
      ItemSel.alertEmpty();
      return;
    }
    let n = 0;
    for (const item of items) {
      const entry = this._keyFor(item);
      if (!entry) continue;
      this._cache.delete(entry.cacheKey);
      this._lookupCache.delete(item.id);
      this._enqueue(entry);
      n++;
    }
    this._refreshColumns();
    const pw = new Zotero.ProgressWindow({ closeOnClick: true });
    pw.changeHeadline("Papilot");
    const prog = new pw.ItemProgress(
      "chrome://papilot/content/icons/chat.svg",
      (I18n.isZh ? "已重新排队 " : "Re-queued ") + n + (I18n.isZh ? " 篇的被引量查询" : " item(s) for citation lookup")
    );
    prog.setProgress(100);
    pw.show();
    pw.startCloseTimer(2000);
  },

  /* ================= 注册 ================= */

  async register(pluginID) {
    if (this._registered) return;
    await this.loadCache();
    await Zotero.ItemTreeManager.registerColumns({
      pluginID,
      dataKey: this.COLUMN_KEY,
      label: I18n.t("citationColumnLabel"),
      dataProvider: (item) => this.lookup(item),
      renderCell: (index, data, column, isFirstColumn, doc) => {
        const span = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
        span.className = `cell ${column.className}`;
        if (data !== "" && data !== null && data !== undefined) {
          span.textContent = String(data);
          if (typeof data === "number" && data >= 100) {
            span.style.cssText = "color:var(--accent-red,#c0392b);font-weight:600;";
          }
        }
        return span;
      },
    });
    this._registered = true;
  },

  unregister() {
    if (this._registered) {
      Zotero.ItemTreeManager.unregisterColumns(this.COLUMN_KEY);
      this._registered = false;
    }
    this._lookupCache.clear();
  },
};
