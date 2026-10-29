// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 问答记忆双通道（chat-memory.js，0.87.0）
 *
 * 两类问答的存储目标是不同的，混在一个数组里会同时伤到「找得到」和「同步得动」：
 *   · 单篇问答（doc）——属于某篇文献的阅读过程，必须**跟着文章走**：
 *     以 `libraryID:itemKey` 归档（**不是 itemID**：itemID 是本机自增，换机器/换库
 *     就对不上，而 itemKey 随 Zotero 官方同步稳定不变）。
 *   · 多篇综合（multi）——跨文献的对话，不属于任何一篇，统一进【AI 对话记录】。
 *
 * 存储（两个独立文件，便于各自作为云同步数据集，互不拖累）：
 *   <数据目录>/papilot-chat-docs.json    { "<lib>:<key>": {key,libraryID,itemKey,itemID,title,updatedAt,sessions[]} }
 *   <数据目录>/papilot-chat-multi.json   [ {id,ts,count,title,history,roleId,chips[]} ]
 *   无 IOUtils 的环境（测试桩 / 旧宿主）→ 退回 pref `chatDocs` / `chatMulti` 全量，行为一致。
 *
 * 会话粒度（0.87.0 的关键修正）：旧 ChatSessions **每轮问答存一份快照**，
 * 50 条上限很快被同一篇文献的同一场对话挤满，`/history` 也只能恢复「最近一条」。
 * 现在每场对话有稳定 `sid`，同一场对话**原地更新**，一篇文章下可以有多场对话。
 *
 * 纪律：
 *   1. 写入只有一条路径 `save()`；空历史不落盘（清空不产生空壳）。
 *   2. 任何读都容错——坏 JSON / 坏条目 / 缺字段一律跳过，绝不抛给 UI。
 *   3. 删除不传播到云端（云同步侧的铁律），本模块只做本地删除 + 墓碑由同步层负责。
 *   4. 防抖写 500ms，但 `flush()` 必须能在云同步/卸载前立刻落盘。
 */
/* global Zotero, IOUtils, Prefs */

/* ⚠️ 跨模块硬规则：`docKey` 字符串**不是身份**，只是一条"尽量稳定"的路径键。
 *
 * 为什么：单链解析（`Zotero.Libraries.get()`）失败时会回退旧数字键，于是**同一次运行内**
 * 可能一部分记录是 `g123:ABCD`、一部分是 `5:ABCD`（同一篇文献的两种写法）。
 * 任何"拿 docKey 做等值比较"的代码在半新半旧时都会判错——把同一场对话判成两场，
 * 或把同一篇文献判成两篇，而且不报错。
 *
 * 按场景选判据：
 *   · 同一个 payload / 同一个 index 文件内的 key 一致       → 可以用 docKey 等值
 *   · 跨文件的排除名单、墓碑、合并时判"是不是同一篇"        → 必须 canonical（本文件的 docKeyOf）
 *   · 判"是不是同一场对话"                                 → **用 sid**（多篇合议用 id）
 *   · 判"是不是同一篇"的另一条路                            → itemKey
 */

var ChatMemory = {
  KIND_DOC: "doc",
  KIND_MULTI: "multi",

  FILE_DOCS: "papilot-chat-docs.json",
  FILE_MULTI: "papilot-chat-multi.json",
  PREF_DOCS: "chatDocs",
  PREF_MULTI: "chatMulti",

  MAX_DOCS: 500,
  MAX_SESSIONS_PER_DOC: 20,
  MAX_MULTI: 200,
  MAX_MESSAGES: 60,
  TITLE_MAX: 40,
  WRITE_DEBOUNCE_MS: 500,

  // 同步合并期标志：为 true 时 UI 应抑制「未读点刷新」类瞬时变化
  // （否则云同步落地瞬间会闪一屏红点）。合并接线前恒为 false。
  replacing: false,

  /** 在「正在替换数据」窗口内执行 fn（fn 内不得再次调用） */
  async withReplacing(fn) {
    const prev = this.replacing;
    this.replacing = true;
    try { return await fn(); } finally { this.replacing = prev; }
  },

  _docs: null,
  _multi: null,
  _loaded: false,
  _timer: null,

  /* ==================== 路径与能力 ==================== */

  _dir() {
    try {
      const d = Zotero.DataDirectory && Zotero.DataDirectory.dir;
      if (!d) return "";
      return String(d).replace(/[\\/]+$/, "");
    } catch (e) { return ""; }
  },

  _fileSupported() {
    if (!this._dir()) return false;
    try {
      return typeof IOUtils !== "undefined" && IOUtils &&
        typeof IOUtils.writeUTF8 === "function" && typeof IOUtils.readUTF8 === "function";
    } catch (e) { return false; }
  },

  _path(name) {
    const dir = this._dir();
    return dir ? (dir + "/" + name) : "";
  },

  /* ==================== 加载 ==================== */

  _ensure() {
    if (this._loaded) return;
    this._loaded = true;
    this._docs = this._readStore(this.PREF_DOCS, true);
    this._multi = this._readStore(this.PREF_MULTI, false);
    // 真机的全量在文件里，首次任意调用只是「pref 镜像 + 启动一次异步补全」。
    // 检索必须能等这次补全（否则会在半个库上搜索，命中率看起来莫名很低）。
    this._loadPromise = this._loadFiles();
  },

  /** 等全量加载完成（非文件模式 / 已加载 → 立即 resolve） */
  ensureLoaded() {
    this._ensure();
    return this._loadPromise || Promise.resolve(false);
  },

  /** 内容版本号：每次写盘自增。检索缓存用它判失效（比时间戳可靠，同毫秒也能区分） */
  revision() {
    return this._rev || 0;
  },

  /**
   * 读一个存储单元。文件优先（真机全量），读不到 / 解析失败回退 pref 全量。
   * @param {string} prefKey @param {string} fileName @param {boolean} asMap
   */
  _readStore(prefKey, asMap) {
    const empty = asMap ? {} : [];
    // 只做同步的 pref 读取；文件由 _loadFiles 异步补全（主线程上 IOUtils 没有同步读）
    let fromPref = empty;
    try {
      let raw = Prefs.get(prefKey, "");
      if (raw) {
        const v = (typeof raw === "string") ? JSON.parse(raw) : raw;
        if (asMap && v && typeof v === "object" && !Array.isArray(v)) fromPref = v;
        if (!asMap && Array.isArray(v)) fromPref = v;
      }
    } catch (e) { /* 坏 JSON：用空值 */ }
    return asMap ? this._normDocs(fromPref) : this._normMulti(fromPref);
  },

  /** 异步读两个存储文件（真机唯一全量来源），合并进内存并通知 */
  async _loadFiles() {
    if (!this._fileSupported()) return false;
    const jobs = [[this.FILE_DOCS, true], [this.FILE_MULTI, false]];
    let any = false;
    for (const [name, asMap] of jobs) {
      try {
        const p = this._path(name);
        if (!p) continue;
        const exists = await IOUtils.exists(p).catch(() => false);
        if (!exists) continue;
        const v = JSON.parse(await IOUtils.readUTF8(p));
        if (asMap) {
          if (!v || typeof v !== "object" || Array.isArray(v)) continue;
          const merged = this._normDocs(v);
          const cur = this._docs || {};
          for (const k of Object.keys(cur)) {
            if (!merged[k]) merged[k] = cur[k];
            else if ((merged[k].updatedAt || 0) < (cur[k].updatedAt || 0)) merged[k] = cur[k];
          }
          this._docs = merged;
        } else {
          if (!Array.isArray(v)) continue;
          const merged = this._normMulti(v);
          const cur = this._multi || [];
          const seen = new Set(merged.map((m) => m.id));
          for (const m of cur) if (!seen.has(m.id)) merged.push(m);
          merged.sort((a, b) => (b.ts || 0) - (a.ts || 0));
          this._multi = merged.slice(0, this.MAX_MULTI);
        }
        any = true;
      } catch (e) { /* 单个文件坏/缺失：另一个照读 */ }
    }
    this._rev = (this._rev || 0) + 1;
    this._loadDone = true;
    // 数据齐了才做存量已读初始化（文件模式在 _ensure 那次拿不到全量）
    try { this._initSeenOnce(); } catch (e) { /* ignore */ }
    // 跨容器 sid 唯一性自检（**只读**）：前端按 sessionId 做 keyed 复用、
    // 同步层按 sid 索引 tomb/excl —— 一旦重复会把两场会话合成一条且不报错
    // （用户只会说"搜到 2 条只显示 1 条"）。新数据由 cm- 生成器保证，
    // 这里兜的是迁移来的存量；不改任何数据，只在 debug 日志里留证据。
    try {
      const seenIds = new Set();
      const dup = [];
      const check = (x) => {
        if (!x || !x.id) return;
        if (seenIds.has(x.id)) { if (dup.length < 5) dup.push(x.id); }
        else seenIds.add(x.id);
      };
      for (const k of Object.keys(this._docs || {})) {
        for (const x of (this._docs[k].sessions || [])) check(x);
      }
      for (const m of (this._multi || [])) check(m);
      if (dup.length) {
        Zotero.debug("Papilot: 检测到重复会话 id（渲染/同步可能串档）：" + dup.join(", "));
      }
    } catch (e) { /* 自检失败不影响加载 */ }
    if (any) this._notify();
    return any;
  },

  _loadFile(prefKey, fileName, asMap) {
    const self = this;
    Promise.resolve().then(async () => {
      try {
        const p = self._path(fileName);
        if (!p) return;
        const exists = await IOUtils.exists(p).catch(() => false);
        if (!exists) return;
        const txt = await IOUtils.readUTF8(p);
        const v = JSON.parse(txt);
        if (asMap) {
          if (!v || typeof v !== "object" || Array.isArray(v)) return;
          const merged = self._normDocs(v);
          // 文件为准；pref 里多出来的（另一台机器刚写、文件还没落）也并进来
          const cur = self._docs || {};
          for (const k of Object.keys(cur)) {
            if (!merged[k]) merged[k] = cur[k];
            else if ((merged[k].updatedAt || 0) < (cur[k].updatedAt || 0)) merged[k] = cur[k];
          }
          self._docs = merged;
        } else {
          if (!Array.isArray(v)) return;
          const merged = self._normMulti(v);
          const cur = self._multi || [];
          const seen = new Set(merged.map((m) => m.id));
          for (const m of cur) if (!seen.has(m.id)) merged.push(m);
          merged.sort((a, b) => (b.ts || 0) - (a.ts || 0));
          self._multi = merged.slice(0, self.MAX_MULTI);
        }
        self._notify();
      } catch (e) { /* 文件缺失/坏 JSON：保持 pref 内容 */ }
    }).catch(() => {});
  },

  /* ==================== 规范化 ==================== */

  _num(v) {
    const n = Number(v);
    return isFinite(n) && n > 0 ? Math.floor(n) : 0;
  },

  _normHistory(history) {
    const out = [];
    for (const h of (Array.isArray(history) ? history : [])) {
      if (!h || typeof h !== "object") continue;
      if (h.role !== "user" && h.role !== "assistant" && h.role !== "system") continue;
      if (h.content == null) continue;
      const c = String(h.content);
      if (!c) continue;
      const rec = { role: h.role, content: c };
      const sq = Number(h.seq);
      if (isFinite(sq) && sq > 0) rec.seq = Math.floor(sq);
      out.push(rec);
    }
    // 超限时保留**首条问 + 最近 59 条**：只留尾部会把会话的起点（用户到底问了什么）切掉，
    // 合并两边时还会让「同一条会话」看起来完全不像同一场。
    if (out.length > this.MAX_MESSAGES) {
      return [out[0]].concat(out.slice(out.length - (this.MAX_MESSAGES - 1)));
    }
    return out;
  },

  _titleFrom(history, fallback) {
    for (const h of history) {
      if (h.role !== "user") continue;
      const flat = String(h.content || "").replace(/\s+/g, " ").trim();
      if (!flat) continue;
      return flat.slice(0, this.TITLE_MAX) + (flat.length > this.TITLE_MAX ? "…" : "");
    }
    return fallback || "";
  },

  _normChips(chips) {
    const out = [];
    for (const c of (Array.isArray(chips) ? chips : [])) {
      const n = this._num(c);
      if (n && out.indexOf(n) < 0) out.push(n);
    }
    return out;
  },

  _normSession(raw, fallbackId) {
    if (!raw || typeof raw !== "object") return null;
    const history = this._normHistory(raw.history);
    if (!history.length) return null;
    const id = String(raw.id || fallbackId || "").trim() || this.newId();
    const ts = this._num(raw.ts) || Date.now();
    const rec = {
      id,
      // ts = 最后**修改**时间（pin / 改名都会 bump，用于合并仲裁与冲突判定）
      ts,
      // lastMsgTs = 最后**追加消息**时间（只增不减，用于展示排序与未读判定）。
      // 两个字段必须分开：否则给老会话 pin 一下，它就跳到搜索结果第一页。
      lastMsgTs: this._num(raw.lastMsgTs) || ts,
      count: history.length,
      history,
      roleId: String(raw.roleId || "").trim(),
      chips: this._normChips(raw.chips),
    };
    const title = String(raw.title || "").replace(/\s+/g, " ").trim();
    rec.title = (title || this._titleFrom(history, "")).slice(0, this.TITLE_MAX + 1);
    if (!rec.roleId) delete rec.roleId;
    // 置顶（用户显式标记，跨设备保留；0.87.0 批次 2）
    if (raw.pinned === true) rec.pinned = true;
    // 迁移来源标记：回滚只删这些，用户自己新问的会话不受影响
    if (raw.migrated === true) rec.migrated = true;
    return rec;
  },

  _normDocs(obj) {
    const out = {};
    if (!obj || typeof obj !== "object") return out;
    for (const k of Object.keys(obj)) {
      const d = obj[k];
      if (!d || typeof d !== "object") continue;
      const key = String(d.key || k || "").trim();
      // 三种键并存：u:/g<groupID>:（新）、纯数字（0.87.0 早期）、id:（无 itemKey 的兜底）
      if (!/^\d+:[A-Za-z0-9]{1,32}$/.test(key) && !/^(?:u|g\d+):[A-Za-z0-9]{1,32}$/.test(key)
        && !/^id:\d+$/.test(key)) continue;
      const sessions = [];
      const seen = new Set();
      for (const s of (Array.isArray(d.sessions) ? d.sessions : [])) {
        const rec = this._normSession(s);
        if (!rec || seen.has(rec.id)) continue;
        seen.add(rec.id);
        sessions.push(rec);
      }
      if (!sessions.length) continue;
      sessions.sort((a, b) => (b.ts || 0) - (a.ts || 0));
      out[key] = {
        key,
        libraryID: this._num(d.libraryID) || (Number(key.split(":")[0]) || 0),
        itemKey: String(d.itemKey || (key.indexOf(":") > 0 ? key.split(":")[1] : "")),
        itemID: this._num(d.itemID),
        title: String(d.title || "").slice(0, 200),
        updatedAt: this._num(d.updatedAt) || (sessions[0].ts || 0),
        sessions: sessions.slice(0, this.MAX_SESSIONS_PER_DOC),
      };
    }
    return out;
  },

  _normMulti(arr) {
    const out = [];
    const seen = new Set();
    for (const raw of (Array.isArray(arr) ? arr : [])) {
      const rec = this._normSession(raw);
      if (!rec || seen.has(rec.id)) continue;
      seen.add(rec.id);
      const chips = [];
      for (const c of (Array.isArray(raw.chipsRef) ? raw.chipsRef : [])) {
        if (!c || typeof c !== "object") continue;
        const k = String(c.key || "").trim();
        if (!k || chips.length >= 5) continue;
        chips.push({ key: k, title: String(c.title || "").slice(0, 200) });
      }
      if (chips.length) rec.chipsRef = chips;
      out.push(rec);
    }
    out.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    return out.slice(0, this.MAX_MULTI);
  },

  /* ==================== 写 ==================== */

  newId() {
    return "cm-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  },

  /**
   * 条目 → 稳定归档键。
   *
   * **不能用 libraryID 做键**：用户库恒为 1，但 group library 的 libraryID 是**本机分配的自增值**
   * （加入群组的顺序不同 → A 机 5、B 机 7）。用它做键，同一篇文献在两台机器上会落成两条归档，
   * 墓碑（按 docKey 匹配）也会失效 → 删掉的会话在另一台机器上复活。
   * 所以用库的**稳定身份**：用户库 `u`，群组库 `g<groupID>`（groupID 是 Zotero 服务的全局 id）。
   * 旧数据里的纯数字键仍能读（_normDocs 兼容），只是不再新写。
   */
  docKeyOf(item) {
    if (!item) return "";
    let key = "";
    try { key = String(item.key || ""); } catch (e) { key = ""; }
    if (!/^[A-Za-z0-9]{1,32}$/.test(key)) {
      const id = this._num(item && item.id);
      return id ? ("id:" + id) : "";
    }
    let scope = "";
    try {
      const libID = Number(item.libraryID) || 0;
      const lib = (Zotero.Libraries && Zotero.Libraries.get) ? Zotero.Libraries.get(libID) : null;
      if (lib && lib.libraryType === "group" && lib.groupID) scope = "g" + lib.groupID;
      else if (lib) scope = "u";
    } catch (e) { scope = ""; }
    // 拿不到 Libraries API（测试桩 / 极老宿主）：退回旧格式，保证行为不退化
    if (!scope) {
      const libID = this._num(item.libraryID);
      return libID ? (libID + ":" + key) : "";
    }
    return scope + ":" + key;
  },

  /**
   * 存量数字键自愈：0.87.0 早期把 libraryID 写进了键，而 group 库的 libraryID 跨机不稳定。
   * 同一篇文献在 canonical 键下重写时，把旧键的记录搬过来并删除旧键——
   * 否则升级后同一篇文章会同时出现两条归档（一条新、一条永不更新）。
   * 用 itemForDocKey 精确比对条目 id，避免"不同库里同 itemKey 的文献"被误合并。
   */
  _adoptLegacyDocKey(key, item) {
    const itemID = this._num(item && item.id);
    if (!itemID || !this._docs) return 0;
    let moved = 0;
    for (const k of Object.keys(this._docs)) {
      if (k === key) continue;
      if (!/^\d+:[A-Za-z0-9]{1,32}$/.test(k)) continue;
      let it = null;
      try { it = this.itemForDocKey(k); } catch (e) { it = null; }
      if (!it || it.id !== itemID) continue;
      const legacy = this._docs[k];
      const cur = this._docs[key];
      if (!cur) {
        this._docs[key] = Object.assign({}, legacy, {
          key,
          itemKey: String(item.key || legacy.itemKey || ""),
        });
      } else {
        const byId = new Map((cur.sessions || []).map((x) => [x.id, x]));
        for (const x of (legacy.sessions || [])) {
          const old = byId.get(x.id);
          if (!old || (x.ts || 0) > (old.ts || 0)) byId.set(x.id, x);
        }
        cur.sessions = Array.from(byId.values())
          .sort((a, b) => (b.ts || 0) - (a.ts || 0))
          .slice(0, this.MAX_SESSIONS_PER_DOC);
        cur.updatedAt = Math.max(cur.updatedAt || 0, legacy.updatedAt || 0);
        if (!cur.title && legacy.title) cur.title = legacy.title;
      }
      delete this._docs[k];
      moved++;
    }
    return moved;
  },

  /**
   * 归档键规范化（幂等）。本模块写出去的一律已是 canonical（u: / g<groupID>:），
   * 这里只做"对外统一入口"：传入旧数字键原样返回（无法反推 groupID），
   * 传入 null/空 → ""。存在是为了让消费方不必判断"这个 key 是哪种格式"。
   */
  canonicalOf(docKey) {
    return String(docKey == null ? "" : docKey).trim();
  },

  /** 重新从磁盘载入（云同步落地后，让内存与文件对齐；调用方用 withReplacing 包住） */
  async reload() {
    this._loadDone = false;
    this._loaded = false;
    this._ensure();
    try { return await this.ensureLoaded(); } catch (e) { return false; }
  },

  /** 归档键 → 本机条目（找不到返回 null；跨库/已删除都算找不到） */
  itemForDocKey(docKey) {
    const raw = String(docKey || "");
    let m = /^u:([A-Za-z0-9]{1,32})$/.exec(raw);
    if (m) {
      try {
        const libID = (Zotero.Libraries && Zotero.Libraries.userLibraryID) || 1;
        return Zotero.Items.getByLibraryAndKey(libID, m[1]) || null;
      } catch (e) { return null; }
    }
    m = /^g(\d+):([A-Za-z0-9]{1,32})$/.exec(raw);
    if (m) {
      try {
        const libID = Zotero.Groups && Zotero.Groups.getLibraryIDFromGroupID
          ? Zotero.Groups.getLibraryIDFromGroupID(Number(m[1])) : 0;
        if (!libID) return null;
        return Zotero.Items.getByLibraryAndKey(libID, m[2]) || null;
      } catch (e) { return null; }
    }
    m = /^(\d+):([A-Za-z0-9]{1,32})$/.exec(raw);
    if (!m) return null;
    try {
      const it = Zotero.Items.getByLibraryAndKey(Number(m[1]), m[2]);
      return it || null;
    } catch (e) { return null; }
  },

  /**
   * 会话分类（唯一真源）。判定顺序不可调换：
   *   1. 显式 kind（迁移/测试用）优先；
   *   2. 上下文献 ≥2 篇 → 综合对话（这是「多篇文章的综合对话」的定义）；
   *   3. 有归属文章（当前锁定条目 / 唯一上下文文献）→ 单篇归档；
   *   4. 都没有 → 综合对话（无文献的自由问答同样不属于任何文章）。
   */
  classify(sess) {
    const s = sess || {};
    if (s.kind === this.KIND_DOC || s.kind === this.KIND_MULTI) return s.kind;
    const chips = Array.isArray(s.chips) ? s.chips.filter((c) => this._num(c)) : [];
    if (chips.length >= 2) return this.KIND_MULTI;
    if (s.item && this.docKeyOf(s.item)) return this.KIND_DOC;
    if (chips.length === 1) {
      const it = this._itemById(chips[0]);
      if (it) return this.KIND_DOC;
    }
    return this.KIND_MULTI;
  },

  _itemById(id) {
    const n = this._num(id);
    if (!n) return null;
    try { return Zotero.Items.get(n) || null; } catch (e) { return null; }
  },

  /**
   * 保存一场对话（**原地更新**，靠 sid 合并）。
   * @param {{sid?:string, kind?:string, item?:object, chips?:number[], history:Array, roleId?:string, title?:string}} sess
   * @returns {{kind:string,id:string,key:string,entry:object}|null}
   */
  save(sess) {
    try {
      this._ensure();
      if (!sess || typeof sess !== "object") return null;
      const history = this._normHistory(sess.history);
      if (!history.length) return null;

      const kind = this.classify(sess);
      const sid = String(sess.sid || "").trim() || this.newId();
      const roleId = String(sess.roleId || "").trim();
      const chips = this._normChips(sess.chips);

      const now = Date.now();
      const base = {
        id: sid,
        ts: now,
        lastMsgTs: now,
        count: history.length,
        history,
        roleId,
        chips,
        title: String(sess.title || "").replace(/\s+/g, " ").trim(),
      };
      if (!base.title) base.title = this._titleFrom(history, "");
      // 写盘是整场覆盖，用户显式标记（置顶 / 迁移来源）不能被一次保存冲掉；
      // 同时保证 lastMsgTs **严格单调**（同毫秒连发两轮时 Date.now() 可能相等，
      // 未读判定就会漏一次 —— 用 prev+1 兜住，代价是时间戳可能比真实时间早 1ms）。
      const inheritFlags = (old) => {
        if (!old) return;
        const prevTs = Number(old.lastMsgTs) || Number(old.ts) || 0;
        if (prevTs > 0) {
          base.lastMsgTs = Math.max(now, prevTs + 1);
          // **必须一起抬 ts**：读侧有 `lastMsgTs <= ts` 的夹紧（防脏数据），
          // 只抬 lastMsgTs 会被它夹回 now，"同毫秒连发两轮"的单调保护等于白做。
          base.ts = Math.max(now, base.lastMsgTs);
        }
        if (old.pinned === true) base.pinned = true;
        if (old.migrated === true) base.migrated = true;
      };
      if (sess.migrated === true) base.migrated = true;
      if (sess.pinned === true) base.pinned = true;

      if (kind === this.KIND_DOC) {
        const key = this.docKeyOf(sess.item);
        if (!key) return null;
        const item = sess.item;
        // 升级自愈：同一篇文献的旧数字键记录并入 canonical 键（只搬一次）
        try {
          if (this._adoptLegacyDocKey(key, item)) this._writeDocs();
        } catch (e) { /* 自愈失败不影响本次保存 */ }
        let title = "";
        try { title = String(item.getField("title") || ""); } catch (e) { title = ""; }
        const doc = this._docs[key] || {
          key,
          libraryID: this._num(item.libraryID),
          itemKey: String(item.key || ""),
          itemID: this._num(item.id),
          title: "",
          updatedAt: 0,
          sessions: [],
        };
        const oldSess = (doc.sessions || []).find((s) => s.id === sid);
        inheritFlags(oldSess);
        this._assignSeq(history, oldSess);
        if (title) doc.title = title.slice(0, 200);
        doc.itemID = this._num(item.id) || doc.itemID;
        doc.updatedAt = base.ts;
        const entry = this._normSession(base, sid);
        if (entry && base.pinned) entry.pinned = true;
        if (entry && base.migrated) entry.migrated = true;
        doc.sessions = [entry].concat(doc.sessions.filter((s) => s.id !== sid))
          .slice(0, this.MAX_SESSIONS_PER_DOC);
        this._docs[key] = doc;
        this._trimDocs();
        this._writeDocs();
        return { kind, id: sid, key, entry };
      }

      this._assignSeq(history, (this._multi || []).find((m) => m.id === sid));
      const entry = this._normSession(base, sid);
      const chipsRef = [];
      if (entry && base.pinned) entry.pinned = true;
      if (entry && base.migrated) entry.migrated = true;
      for (let i = 0; i < chips.length && chipsRef.length < 5; i++) {
        const it = this._itemById(chips[i]);
        const k = it ? this.docKeyOf(it) : "";
        if (!k) continue;
        let t = "";
        try { t = String(it.getField("title") || ""); } catch (e) { t = ""; }
        chipsRef.push({ key: k, title: t.slice(0, 200) });
      }
      if (chipsRef.length) entry.chipsRef = chipsRef;
      this._multi = [entry].concat(this._multi.filter((m) => m.id !== sid))
        .slice(0, this.MAX_MULTI);
      this._writeMulti();
      return { kind, id: sid, key: "", entry };
    } catch (e) {
      try { Zotero.logError(e); } catch (_) { /* ignore */ }
      return null;
    }
  },

  _trimDocs() {
    const keys = Object.keys(this._docs || {});
    if (keys.length <= this.MAX_DOCS) return;
    keys.sort((a, b) => (this._docs[a].updatedAt || 0) - (this._docs[b].updatedAt || 0));
    for (let i = 0; i < keys.length - this.MAX_DOCS; i++) delete this._docs[keys[i]];
  },

  /* ==================== 读 API ==================== */

  /** 按文章分组的摘要（不含 history 全文），最新在前 */
  listDocs() {
    this._ensure();
    const out = [];
    for (const k of Object.keys(this._docs || {})) {
      const d = this._docs[k];
      out.push({
        key: d.key,
        // 别名：消费方统一读 docKeyCanonical 就不用猜 key 是哪种格式
        docKeyCanonical: d.key,
        title: d.title || d.key,
        itemID: d.itemID,
        libraryID: d.libraryID,
        itemKey: d.itemKey,
        updatedAt: d.updatedAt,
        count: (d.sessions || []).reduce((n, s) => n + (s.count || 0), 0),
        sessions: (d.sessions || []).map((s) => ({
          id: s.id, ts: s.ts, lastMsgTs: this._msgTs(s), count: s.count,
          lastSeq: this._lastSeq(s),
          title: s.title || "", pinned: !!s.pinned, lastRole: this._lastRole(s),
        })),
      });
    }
    out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return out;
  },

  /** 综合对话摘要，最新在前 */
  listMulti(limit) {
    this._ensure();
    const out = [];
    for (const m of (this._multi || [])) {
      out.push({
        id: m.id,
        ts: m.ts,
        lastMsgTs: this._msgTs(m),
        lastSeq: this._lastSeq(m),
        lastRole: this._lastRole(m),
        count: m.count,
        title: m.title || "(无标题)",
        pinned: !!m.pinned,
        chipsRef: (m.chipsRef || []).slice(0, 5),
      });
    }
    const n = Number(limit);
    return (isFinite(n) && n >= 0) ? out.slice(0, Math.floor(n)) : out;
  },

  /**
   * 扁平化全部会话（含 history），供全文检索扫描。
   * 排序：置顶优先，其次时间倒序（与左栏展示顺序一致，检索结果不必再排一次）。
   * @param {number=} limit 最多返回多少场（防一次性把 200MB 文本搬进检索）
   */
  allSessions(limit) {
    this._ensure();
    const out = [];
    for (const k of Object.keys(this._docs || {})) {
      const d = this._docs[k];
      for (const s of (d.sessions || [])) {
        out.push({
          kind: this.KIND_DOC, key: k, docTitle: d.title || "",
          sid: s.id, title: s.title || "", ts: s.ts || 0,
          lastMsgTs: this._msgTs(s), lastSeq: this._lastSeq(s),
          pinned: !!s.pinned, history: s.history || [],
        });
      }
    }
    for (const m of (this._multi || [])) {
      out.push({
        kind: this.KIND_MULTI, key: "", docTitle: "",
        sid: m.id, title: m.title || "", ts: m.ts || 0,
        lastMsgTs: this._msgTs(m), lastSeq: this._lastSeq(m),
        pinned: !!m.pinned, history: m.history || [],
      });
    }
    out.sort((a, b) => {
      if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
      return (b.ts || 0) - (a.ts || 0);
    });
    const n = Number(limit);
    return (isFinite(n) && n > 0) ? out.slice(0, Math.floor(n)) : out;
  },

  getDoc(key) {
    this._ensure();
    return (this._docs || {})[String(key || "")] || null;
  },

  /** 取一场对话的完整记录；kind=doc 时 key 为归档键 */
  getSession(kind, key, sid) {
    this._ensure();
    const id = String(sid || "").trim();
    if (!id) return null;
    if (kind === this.KIND_DOC) {
      const d = this.getDoc(key);
      if (!d) return null;
      for (const s of d.sessions) if (s.id === id) return { doc: d, session: s };
      return null;
    }
    for (const m of (this._multi || [])) if (m.id === id) return { doc: null, session: m };
    return null;
  },

  /** 某条目最近一场对话（跨会话；本机解析不到条目也能靠 key 命中） */
  latestForItem(item) {
    const key = this.docKeyOf(item);
    if (!key) return null;
    const d = this.getDoc(key);
    if (!d || !d.sessions.length) return null;
    return { doc: d, session: d.sessions[0] };
  },

  latestMulti() {
    this._ensure();
    return (this._multi && this._multi[0]) || null;
  },

  /**
   * 追加一条消息（公开写入口）。
   *
   * 为什么要有它：`save()` 需要 item 对象与**完整** history，外部（集成测试 /
   * 将来的同步落地）想"往某场会话里加一条"只能靠私有字段改内存——那样测到的
   * 不是真实写入路径。一条只能靠私有字段驱动的写路径，等于没有可执行定义。
   * 本方法只做「读出既有历史 → push → 交给 save」，写盘仍然只有 save 一条路。
   *
   * @param {string} docKey 归档键（canonical 或旧数字键）
   * @param {string} sid 会话 id
   * @param {{role:string, content:string}} msg
   * @returns {{kind,id,key,entry}|null} 条目解析不到 / 会话不存在 → null
   */
  appendMessage(docKey, sid, msg) {
    try {
      if (!msg || (msg.role !== "user" && msg.role !== "assistant")) return null;
      const content = String(msg.content == null ? "" : msg.content);
      if (!content) return null;
      const key = this.canonicalOf(docKey);
      const item = this.itemForDocKey(key);
      const doc = this.getDoc(key);
      if (!item || !doc) return null;
      const prev = (doc.sessions || []).find((x) => x.id === String(sid || ""));
      if (!prev) return null;
      return this.save({
        sid: prev.id,
        item,
        history: (prev.history || []).concat([{ role: msg.role, content }]),
        roleId: prev.roleId,
        chips: [],
        title: prev.title,
      });
    } catch (e) { return null; }
  },

  /**
   * 幂等设置置顶（公开写入口）。与 `togglePin` 的区别：本方法给**目标状态**，
   * 重复调用结果一致——参考实现里 pin 是最容易出现"点两次回到原点"的地方。
   * 只 bump ts（修改时间），不碰 lastMsgTs（最后交流时间），见两条时间字段的分工。
   * @param {string} docKey 归档键；传空串 / null 表示在综合对话里找
   * @returns {boolean|null} 设置后的状态；找不到会话 → null
   */
  pinSession(docKey, sid, on) {
    try {
      this._ensure();
      const id = String(sid || "").trim();
      if (!id) return null;
      const want = on !== false;
      const key = this.canonicalOf(docKey);
      if (key) {
        const d = this.getDoc(key);
        if (!d) return null;
        const s = (d.sessions || []).find((x) => x.id === id);
        if (!s) return null;
        if (!!s.pinned === want) return want;
        if (want) s.pinned = true; else delete s.pinned;
        s.ts = Date.now();
        this._writeDocs();
        this._notify();
        return want;
      }
      const m = (this._multi || []).find((x) => x.id === id);
      if (!m) return null;
      if (!!m.pinned === want) return want;
      if (want) m.pinned = true; else delete m.pinned;
      m.ts = Date.now();
      this._writeMulti();
      this._notify();
      return want;
    } catch (e) { return null; }
  },

  /* ==================== 同步墓碑（会话级合并的前置） ====================
   * 只写不读（本文件不消费墓碑，消费方是 features/chat-sync.js 的合并函数）。
   * 为什么必须有：删除只写进本地文件，对端那份还在 → 合并时按并集**复活**。
   * 墓碑是唯一能跨机表达「这个是我主动删的，不是从来没有」的载体。
   */

  _syncStatePath() {
    const dir = this._dir();
    return dir ? (dir + "/" + "papilot-chat-sync-state.json") : "";
  },

  /** 读墓碑状态（坏文件 → 空状态；绝不因墓碑坏了阻断删除/保存） */
  loadSyncState() {
    this._ensure();
    if (this._syncState) return Promise.resolve(this._syncState);
    const self = this;
    this._syncStatePromise = this._syncStatePromise || Promise.resolve().then(async () => {
      let raw = null;
      try {
        const p = self._syncStatePath();
        if (p && self._fileSupported() && await IOUtils.exists(p).catch(() => false)) {
          raw = JSON.parse(await IOUtils.readUTF8(p));
        }
      } catch (e) { raw = null; }
      const norm = (typeof ChatSync !== "undefined" && ChatSync && ChatSync.normState)
        ? ChatSync.normState(raw) : null;
      self._syncState = norm;
      return norm;
    });
    return this._syncStatePromise;
  },

  /** 写墓碑（合并调用；失败静默——墓碑丢了只会导致该次删除将来复活，不能阻断删除本身） */
  _tombWrite(mutator) {
    const self = this;
    Promise.resolve().then(async () => {
      try {
        const st = await self.loadSyncState();
        if (!st) return;
        const next = mutator(st);
        self._syncState = next;
        const p = self._syncStatePath();
        if (!p || !self._fileSupported()) return;
        const tmp = p + ".tmp";
        await IOUtils.writeUTF8(tmp, JSON.stringify(next));
        await IOUtils.move(tmp, p);
      } catch (e) { /* 墓碑写失败不影响本地删除 */ }
    }).catch(() => {});
    return true;
  },

  /** 该条目下的全部对话（最新在前） */
  sessionsForItem(item) {
    const key = this.docKeyOf(item);
    const d = key ? this.getDoc(key) : null;
    return d ? d.sessions.slice() : [];
  },

  /* ==================== 删 ==================== */

  removeSession(kind, key, sid) {
    this._ensure();
    const id = String(sid || "").trim();
    if (!id) return false;
    if (kind === this.KIND_DOC) {
      const d = this.getDoc(key);
      if (!d) return false;
      const victim = (d.sessions || []).find((s) => s.id === id);
      const before = d.sessions.length;
      d.sessions = d.sessions.filter((s) => s.id !== id);
      if (d.sessions.length === before) return false;
      if (!d.sessions.length) delete this._docs[d.key];
      else d.updatedAt = Math.max(d.updatedAt || 0, d.sessions[0].ts || 0);
      this._writeDocs();
      // 墓碑：记录「谁在什么时候被删」，时间取被删会话的最后修改时间
      if (victim && typeof ChatSync !== "undefined" && ChatSync) {
        this._tombWrite((st) => ChatSync.tombAddSession(st, d.key, id, victim.ts));
      }
      return true;
    }
    const victimMulti = (this._multi || []).find((m) => m.id === id);
    const before = (this._multi || []).length;
    this._multi = (this._multi || []).filter((m) => m.id !== id);
    if (this._multi.length === before) return false;
    this._writeMulti();
    if (victimMulti && typeof ChatSync !== "undefined" && ChatSync) {
      this._tombWrite((st) => ChatSync.tombAddSession(st, "", id, victimMulti.ts));
    }
    return true;
  },

  /** 清空某文章下的全部对话 */
  removeDoc(key) {
    this._ensure();
    const k = String(key || "");
    if (!this._docs || !this._docs[k]) return false;
    const victim = this._docs[k];
    delete this._docs[k];
    this._writeDocs();
    if (victim && typeof ChatSync !== "undefined" && ChatSync) {
      this._tombWrite((st) => ChatSync.tombAddDoc(st, k, victim.updatedAt || Date.now()));
    }
    return true;
  },

  clearAll() {
    this._ensure();
    this._docs = {};
    this._multi = [];
    this._writeDocs();
    this._writeMulti();
    return true;
  },

  /** 概览数字（左栏栏目标题 / 设置面板用） */
  stats() {
    this._ensure();
    let docs = 0;
    let docSessions = 0;
    for (const k of Object.keys(this._docs || {})) {
      docs++;
      docSessions += (this._docs[k].sessions || []).length;
    }
    return { docs, sessions: docSessions, multi: (this._multi || []).length };
  },

  /* ==================== 落盘 ==================== */

  _writeDocs() {
    this._persist(this.PREF_DOCS, this.FILE_DOCS, this._docs || {});
  },

  _writeMulti() {
    this._persist(this.PREF_MULTI, this.FILE_MULTI, this._multi || []);
  },

  _persist(prefKey, fileName, value) {
    // pref 镜像：无文件能力的环境它是唯一副本；有文件时它也是「另一台机器刚写完还没传」
    // 场景下的兜底（体积可控：只镜像最近 20 条会话/40 条综合对话）。
    try {
      const mirror = this._mirror(value, prefKey === this.PREF_DOCS);
      Prefs.set(prefKey, JSON.stringify(mirror));
    } catch (e) { /* pref 写失败不影响内存态 */ }
    this._schedule();
    this._rev = (this._rev || 0) + 1;
    this._notify();
  },

  _mirror(value, isDocs) {
    if (!isDocs) return (value || []).slice(0, 40);
    const out = {};
    const keys = Object.keys(value || {})
      .sort((a, b) => (value[b].updatedAt || 0) - (value[a].updatedAt || 0))
      .slice(0, 20);
    for (const k of keys) {
      const d = value[k];
      out[k] = Object.assign({}, d, { sessions: (d.sessions || []).slice(0, 3) });
    }
    return out;
  },

  _schedule() {
    if (!this._fileSupported()) return;
    if (this._timer) { try { clearTimeout(this._timer); } catch (e) { /* ignore */ } }
    const self = this;
    this._timer = setTimeout(() => {
      self._timer = null;
      Promise.resolve().then(() => self.flush()).catch(() => {});
    }, this.WRITE_DEBOUNCE_MS);
  },

  /** 立刻落盘（云同步 / 卸载 / 面板打开前调用；失败静默，pref 镜像仍在） */
  async flush() {
    if (this._timer) {
      try { clearTimeout(this._timer); } catch (e) { /* ignore */ }
      this._timer = null;
    }
    if (!this._fileSupported()) return false;
    const jobs = [
      [this.FILE_DOCS, this._docs || {}],
      [this.FILE_MULTI, this._multi || []],
    ];
    for (const [name, value] of jobs) {
      try {
        const p = this._path(name);
        if (!p) continue;
        const tmp = p + ".tmp";
        await IOUtils.writeUTF8(tmp, JSON.stringify(value));
        await IOUtils.move(tmp, p);
      } catch (e) { /* 单文件失败不影响另一个 */ }
    }
    return true;
  },

  /* ==================== 变更通知（UI 订阅） ==================== */

  _listeners: [],
  onChange(fn) {
    if (typeof fn !== "function") return () => {};
    this._listeners.push(fn);
    return () => {
      const i = this._listeners.indexOf(fn);
      if (i >= 0) this._listeners.splice(i, 1);
    };
  },

  _notify() {
    for (const fn of (this._listeners || []).slice()) {
      try { fn(this.stats()); } catch (e) { /* 订阅者异常不得影响写入 */ }
    }
  },

  /* ==================== 迁移（旧 chatSessions → 双通道） ==================== */

  /**
   * 旧数据迁移：ChatSessions 的 50 条快照按条目分流。
   * 同一篇文章的多份快照会合并成**同一场对话**（取消息最多的那份），
   * 否则迁完一打开就是十几条几乎一样的记录。
   * @returns {{doc:number, multi:number, skipped:number}}
   */
  migrateOldSessions() {
    const res = { doc: 0, multi: 0, skipped: 0 };
    try {
      if (typeof ChatSessions === "undefined" || !ChatSessions || !ChatSessions.list) return res;
      let done = false;
      try { done = !!Prefs.get("chatMemoryMigrated", false); } catch (e) { done = false; }
      if (done) return res;

      this._ensure();
      // 迁移是单向的，出问题必须能回到迁移前：先把旧 pref 原文备份成文件。
      // 备份与回滚的分工：备份 = 物理保险（人工可查），回滚 = 按 migrated 标记撤销。
      const backup = this._backupOldSessions();
      const list = ChatSessions.list() || [];
      const bestByKey = new Map();
      for (const item of list) {
        const full = ChatSessions.load(item.id);
        if (!full || !Array.isArray(full.history) || !full.history.length) { res.skipped++; continue; }
        const chips = this._normChips(full.chips);
        const it = this._itemById(item.itemID) || (chips.length === 1 ? this._itemById(chips[0]) : null);
        const kind = (chips.length >= 2 || !it) ? this.KIND_MULTI : this.KIND_DOC;
        if (kind === this.KIND_MULTI) {
          if (this._multi.some((m) => m.id === full.id)) continue;
          const entry = this._normSession({
            id: full.id, ts: full.ts, history: full.history, chips, title: full.title,
          });
          if (!entry) { res.skipped++; continue; }
          entry.migrated = true;
          this._multi.push(entry);
          res.multi++;
        } else {
          const key = this.docKeyOf(it);
          if (!key) { res.skipped++; continue; }
          const prev = bestByKey.get(key);
          // 同一篇文章的多份旧快照只留**消息最多**的那份（迁移后是「一场对话」，
          // 不是十几条几乎一样的记录）；同长度取更新的（list 已最新在前）。
          if (!prev || (full.history || []).length > (prev.full.history || []).length) {
            bestByKey.set(key, { item: it, full });
          }
        }
      }
      for (const [key, v] of bestByKey) {
        const it = v.item;
        const full = v.full;
        let title = "";
        try { title = String(it.getField("title") || ""); } catch (e) { title = ""; }
        const saved = this.save({
          kind: this.KIND_DOC,
          sid: full.id,
          item: it,
          chips: [],
          history: full.history,
          title,
          migrated: true,
        });
        if (saved) res.doc++;
      }
      this._multi = this._normMulti(this._multi);
      this._writeDocs();
      this._writeMulti();
      try { Prefs.set("chatMemoryMigrated", true); } catch (e) { /* ignore */ }
      // 报告让迁移结果可见（设置面板展示）：没有这份记录，用户迁移完只能猜有没有成功
      try {
        Prefs.set("chatMemoryMigrateReport", JSON.stringify({
          at: Date.now(), doc: res.doc, multi: res.multi,
          skipped: res.skipped, backup: backup || "", version: 1,
        }));
      } catch (e) { /* 报告写失败不影响迁移本身 */ }
      return res;
    } catch (e) {
      try { Zotero.logError(e); } catch (_) { /* ignore */ }
      return res;
    }
  },

  /** 旧 pref 原文备份到数据目录（异步；失败静默，不影响迁移） */
  _backupOldSessions() {
    try {
      if (!this._fileSupported()) return "";
      let raw = "";
      try { raw = Prefs.get("chatSessions", ""); } catch (e) { return ""; }
      if (!raw) return "";
      const p = this._path("papilot-chat-sessions.bak.json");
      if (!p) return "";
      if (typeof raw !== "string") raw = JSON.stringify(raw);
      Promise.resolve()
        .then(() => IOUtils.writeUTF8(p, raw))
        .catch(() => { /* 备份失败：迁移照做，回滚仍可用 migrated 标记 */ });
      return p;
    } catch (e) { return ""; }
  },

  /** 迁移报告（没有迁移过 → null） */
  migrateReport() {
    let raw = "";
    try { raw = Prefs.get("chatMemoryMigrateReport", ""); } catch (e) { return null; }
    if (!raw) return null;
    try {
      const v = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (!v || typeof v !== "object") return null;
      return {
        at: Number(v.at) || 0,
        doc: Number(v.doc) || 0,
        multi: Number(v.multi) || 0,
        skipped: Number(v.skipped) || 0,
        backup: String(v.backup || ""),
      };
    } catch (e) { return null; }
  },

  /**
   * 回滚迁移：只删「迁移进来的」会话（migrated 标记），用户迁完自己新问的一概不动。
   * 清掉迁移标记，下次启动会再迁一次（这是有意的：回滚 = 回到未迁移状态）。
   * @returns {number} 实际删除的会话数
   */
  rollbackMigration() {
    this._ensure();
    let removed = 0;
    try {
      for (const k of Object.keys(this._docs || {})) {
        const d = this._docs[k];
        const keep = (d.sessions || []).filter((s) => !s.migrated);
        removed += (d.sessions || []).length - keep.length;
        if (!keep.length) { delete this._docs[k]; continue; }
        d.sessions = keep;
        d.updatedAt = keep[0].ts || d.updatedAt;
      }
      const before = (this._multi || []).length;
      this._multi = (this._multi || []).filter((m) => !m.migrated);
      removed += before - this._multi.length;
      this._writeDocs();
      this._writeMulti();
      try { Prefs.set("chatMemoryMigrated", false); } catch (e) { /* ignore */ }
      try { Prefs.set("chatMemoryMigrateReport", ""); } catch (e) { /* ignore */ }
    } catch (e) {
      try { Zotero.logError(e); } catch (_) { /* ignore */ }
    }
    return removed;
  },

  /* ==================== 置顶与未读 ==================== */

  /**
   * 置顶：会话级开关（跨设备保留）。返回切换后的状态，找不到 → null。
   * 只动 pinned 字段，不动 ts——置顶不该改变「最近使用」的时间序，
   * 否则取消置顶后它仍会赖在顶部。
   */
  togglePin(kind, key, sid) {
    this._ensure();
    const id = String(sid || "").trim();
    if (!id) return null;
    const flip = (s) => {
      if (!s || s.id !== id) return null;
      if (s.pinned) delete s.pinned; else s.pinned = true;
      // pin 是「内容修改」：bump ts 让合并仲裁能识别这个变更；
      // lastMsgTs 不动，否则置顶会把老会话顶到最近使用的位置。
      s.ts = Date.now();
      return !!s.pinned;
    };
    let out = null;
    if (kind === this.KIND_DOC) {
      const d = this.getDoc(key);
      if (!d) return null;
      out = flip((d.sessions || []).find((s) => s.id === id));
      if (out === null) return null;
      this._writeDocs();
    } else {
      out = flip((this._multi || []).find((m) => m.id === id));
      if (out === null) return null;
      this._writeMulti();
    }
    this._notify();
    return out;
  },

  /* 未读判定：会话的 ts 晚于「上次看过」即未读。存 pref chatLogSeen（sid → ts，LRU 800）。
   * 为什么不存进会话本体：已读是**设备级**状态，同步到另一台机器会导致「那边看过这边就没了」。 */
  PREF_SEEN: "chatLogSeen",
  SEEN_MAX: 800,

  _seenMap() {
    let raw = "";
    try { raw = Prefs.get(this.PREF_SEEN, ""); } catch (e) { return {}; }
    if (!raw) return {};
    try {
      const v = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (!v || typeof v !== "object" || Array.isArray(v)) return {};
      const out = {};
      for (const k of Object.keys(v)) {
        const n = Number(v[k]);
        if (isFinite(n) && n > 0) out[k] = n;
      }
      return out;
    } catch (e) { return {}; }
  },

  /**
   * 标记已读。写的是**该会话当前的内容时间戳**而不是 Date.now()：
   * 写 Date.now() 之后，这条会话再追加新消息（ts 变大）就永远算已读，未读点再也不会出现。
   * @param {string} sid @param {number=} ts 会话 ts（缺省用当前时间，仅用于兜底）
   */
  markSeen(sid, ts) {
    const id = String(sid || "").trim();
    if (!id) return false;
    const t = Number(ts);
    const stamp = (isFinite(t) && t > 0) ? t : Date.now();
    const map = this._seenMap();
    if ((map[id] || 0) >= stamp) return true;   // 单调不回退
    map[id] = stamp;
    const keys = Object.keys(map);
    if (keys.length > this.SEEN_MAX) {
      keys.sort((a, b) => map[a] - map[b]);
      for (let i = 0; i < keys.length - this.SEEN_MAX; i++) delete map[keys[i]];
    }
    try { Prefs.set(this.PREF_SEEN, JSON.stringify(map)); } catch (e) { return false; }
    return true;
  },

  /** 会话的「最后交流时间」（未读判定与展示排序的唯一口径） */
  _msgTs(session) {
    if (!session) return 0;
    const ts = Number(session.ts) || 0;
    let t = Number(session.lastMsgTs);
    if (!isFinite(t) || t <= 0) t = ts;
    // 不变量：lastMsgTs <= ts（pin / 改名只 bump ts）。
    // ⚠️ 读侧 clamp 是给**脏数据**的兜底（手工改文件 / 跨版本写坏），
    // 不是给写侧擦屁股：写侧必须自己保证不变量（save 里两者同抬），
    // 否则会出现"写侧想抬高、读侧又压回去"的两个防御互相抵消——
    // 这种 bug 单看任何一侧的单测都是绿的。
    // 否则这条会话会永远判"未读"，并永久钉在时间序最前。
    if (ts > 0 && t > ts) t = ts;
    return t;
  },

  /**
   * 分配消息序号 `seq`（会话内单调、永不复用）。
   *
   * 为什么要它：片段跳转需要一个**不随下标漂移**的锚点。`history` 的下标在
   * 「删中间一条 / 重新生成 / 云同步回滚」后都会指向另一条消息，用它跳转会把用户
   * 精确地送到一条不相干的内容上，而且不报错。
   *
   * 规则：已有 seq 的原样保留（原地编辑不换号）；没有的按位置对齐旧消息的 seq，
   * 对不上的从 `maxSeq+1` 续。裁剪（保留首条 + 末 59）会让序号出现空洞，这是正常的
   * ——seq 只做标识，不承担"第几条"的语义。
   */
  _assignSeq(list, prev) {
    const prevList = (prev && prev.history) || [];
    let maxSeq = 0;
    for (const h of prevList) {
      const n = Number(h && h.seq);
      if (isFinite(n) && n > maxSeq) maxSeq = Math.floor(n);
    }
    for (let i = 0; i < list.length; i++) {
      const h = list[i];
      const sq = Number(h && h.seq);
      if (isFinite(sq) && sq > 0) {
        if (sq > maxSeq) maxSeq = Math.floor(sq);
        continue;
      }
      const old = prevList[i];
      const oldSq = Number(old && old.seq);
      if (isFinite(oldSq) && oldSq > 0) h.seq = Math.floor(oldSq);
      else h.seq = ++maxSeq;
    }
    return maxSeq;
  },

  /** 会话内最大消息序号（版本计数器的单调量，不是"最后一条的下标"） */
  _lastSeq(session) {
    const h = session && Array.isArray(session.history) ? session.history : null;
    if (!h || !h.length) return 0;
    let max = 0;
    for (const m of h) {
      const n = Number(m && m.seq);
      if (isFinite(n) && n > max) max = Math.floor(n);
    }
    return max;
  },

  /** 最后一条消息的角色（未读判定用；空会话 → ""） */
  _lastRole(session) {
    const h = session && Array.isArray(session.history) ? session.history : null;
    if (!h || !h.length) return "";
    const last = h[h.length - 1];
    return String((last && last.role) || "");
  },

  /**
   * 存量会话的已读初始化（**只跑一次**）。
   * 不初始化的话，升级后 seen 表是空的 → 所有历史会话同时变未读 → 满屏红点，
   * 用户只会认为插件坏了，这个功能再也拿不回信任。全标已读是唯一安全的初值
   * （绝不试图推断用户读到哪一条）。
   */
  _initSeenOnce() {
    if (this._seenInitDone) return false;
    let done = false;
    try { done = Prefs.get("chatLogSeenInit", false) === true; } catch (e) { done = false; }
    if (done) {
      // 标记与水位表必须成对：标记在、表空（pref 被清/损坏/迁移中途崩）→ 重跑一次初始化。
      // 不重跑的唯一后果是满屏红点，比"多标一次已读"严重得多。
      // 反过来，表非空时**绝不能**再全标——否则同步下来的新会话会被一起吞掉未读提示。
      if (Object.keys(this._seenMap()).length) { this._seenInitDone = true; return false; }
    }
    // 文件模式必须等全量加载完，否则文件里的存量会话不会被写进 seen
    if (this._fileSupported() && !this._loadDone) return false;
    this._ensure();
    const map = this._seenMap();
    const touch = (s) => {
      if (!s || !s.id) return;
      const ts = this._msgTs(s);
      if (ts && !((map[s.id] || 0) >= ts)) map[s.id] = ts;
    };
    for (const k of Object.keys(this._docs || {})) {
      for (const ss of (this._docs[k].sessions || [])) touch(ss);
    }
    for (const m of (this._multi || [])) touch(m);
    try { Prefs.set(this.PREF_SEEN, JSON.stringify(map)); } catch (e) { /* ignore */ }
    try { Prefs.set("chatLogSeenInit", true); } catch (e) { /* ignore */ }
    this._seenInitDone = true;
    // 初值与"真的都读过了"在数据上不可区分，将来若怀疑"升级后全变未读被吞掉"，
    // 只有这条日志能区分「跑过初始化」与「从未跑过」。
    try {
      Zotero.debug("Papilot: 存量会话已读初始化完成（" +
        Object.keys(map).length + " 场标记为已读）");
    } catch (e) { /* ignore */ }
    return true;
  },

  /** 是否有「上次看过之后的新内容」 */
  isUnread(session) {
    if (!session || !session.id) return false;
    // 最后一条是 user = 还在等回答，不该算「有新内容」。
    // 理论上保存只在成功轮次后发生（user+assistant 成对），但那是上层约定；
    // 这里加一道自证，避免流式中断的历史永远标红。
    let lastRole = session.lastRole;
    if (!lastRole && Array.isArray(session.history) && session.history.length) {
      const last = session.history[session.history.length - 1];
      lastRole = last && last.role;
    }
    if (lastRole === "user") return false;
    this._initSeenOnce();
    const seen = this._seenMap()[session.id] || 0;
    return this._msgTs(session) > seen;
  },

  /** 未读场次（栏目计数用） */
  unreadCount() {
    this._ensure();
    this._initSeenOnce();
    let n = 0;
    const seen = this._seenMap();
    for (const k of Object.keys(this._docs || {})) {
      for (const s of (this._docs[k].sessions || [])) {
        if (this._msgTs(s) > (seen[s.id] || 0)) n++;
      }
    }
    for (const m of (this._multi || [])) {
      if (this._msgTs(m) > (seen[m.id] || 0)) n++;
    }
    return n;
  },

  /* ==================== 可选：归档为子笔记 ==================== */

  /**
   * 把一场对话写成该文献下的一条子笔记（**同标题替换**，不会每轮新增）。
   * 默认关闭（pref chatArchiveNote）：写用户文库会占用 Zotero 官方同步流量，
   * 必须由用户显式打开。任何失败都静默——归档是增强路径，不能拖崩问答。
   * @returns {Promise<boolean>}
   */
  async archiveToNote(item, session) {
    try {
      let on = false;
      try { on = !!Prefs.get("chatArchiveNote", false); } catch (e) { on = false; }
      if (!on || !item || !session || !Array.isArray(session.history) || !session.history.length) {
        return false;
      }
      const NOTE_TITLE = "Papilot 对话记录";
      const html = this._noteHtml(item, session, NOTE_TITLE);

      let noteItem = null;
      try {
        for (const id of (item.getNotes() || [])) {
          const n = Zotero.Items.get(id);
          if (n && String(n.getNoteTitle ? n.getNoteTitle() : "") === NOTE_TITLE) { noteItem = n; break; }
        }
      } catch (e) { noteItem = null; }

      if (noteItem) {
        noteItem.setNote(html);
        await noteItem.saveTx();
      } else {
        noteItem = new Zotero.Item("note");
        noteItem.libraryID = item.libraryID;
        noteItem.parentID = item.id;
        noteItem.setNote(html);
        await noteItem.saveTx();
      }
      return true;
    } catch (e) {
      try { Zotero.logError(e); } catch (_) { /* ignore */ }
      return false;
    }
  },

  _esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  },

  _noteHtml(item, session, title) {
    const lines = [];
    lines.push("<h1>" + this._esc(title) + "</h1>");
    let t = "";
    try { t = String(item.getField("title") || ""); } catch (e) { t = ""; }
    lines.push("<p><em>" + this._esc(t) + "</em> · " +
      new Date(session.ts || Date.now()).toLocaleString() +
      " · " + (session.roleId ? ("角色 " + this._esc(session.roleId)) : "默认角色") + "</p>");
    for (const h of session.history) {
      if (h.role === "user") {
        lines.push("<h2>问</h2><blockquote>" + this._esc(h.content).replace(/\n/g, "<br/>") + "</blockquote>");
      } else if (h.role === "assistant") {
        lines.push("<h2>答</h2><div>" + this._esc(h.content).replace(/\n/g, "<br/>") + "</div>");
      }
    }
    lines.push("<p><small>由 Papilot 自动维护，重新生成会覆盖本笔记。</small></p>");
    return lines.join("\n");
  },
};
