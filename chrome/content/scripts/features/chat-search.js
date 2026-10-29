// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 对话全文检索（chat-search.js，0.87.0 批次 2）
 *
 * 为什么**不建倒排索引**（这是被认真评估后否掉的方案，别改回去）：
 *   · 规模不匹配：几百场会话、正文 1–20MB，线性 `indexOf` 一次性扫描只要几十毫秒；
 *   · 内存代价：中文没有词典只能切 bigram，索引体积是正文的 2–4 倍，
 *     而 20MB 正文的 bigram 表就已经吃不住（几十万级 key）；
 *   · 一致性代价：索引与「会话被删除 / 被云同步覆盖 / 被合并」之间永远有对不齐的窗口，
 *     每次同步后都要重建——那点延迟优势全赔回去。
 *   翻转条件（真到了再改）：会话 > 3000 场、正文 > 40MB、或 P95 查询 > 80ms。
 *
 * 工程上的四条硬规矩：
 *   1. **逐消息扫描，绝不把多条消息拼成一个长串**——拼接会让「跨消息的假阳性」命中
 *      （上一条结尾和下一条开头凑出关键词），用户点进去发现根本没有。
 *   2. **折叠串长度变了就不用它**：`toLowerCase()` 对某些 Unicode（İ 等）会改变长度，
 *      此时偏移量与原文对不上，高亮会错位甚至切坏字符，必须退回原串匹配。
 *   3. **返回 span 而不是拼好的 HTML**：UI 用 createTextNode + mark 渲染，
 *      绝不 innerHTML——会话正文是用户/AI 生成的内容，拼 HTML 等于给自己开注入口。
 *   4. **渲染层高亮片段前先按代理对截断**：避免把 emoji 切成半个字符（见 test 用例）。
 *
 * 消费方：panels/ai-log-pane.js（栏目搜索框）。纯函数部分全部挂在本对象上便于单测。
 */
/* global ChatMemory */

var ChatSearch = {
  SLICE_MS: 4,        // 每个扫描分片的时间片（让出前最多占用这么久）
  MAX_TERMS: 8,       // 一次查询最多 8 个词（再多对用户没有意义，只会拖慢）
  MAX_TERM_LEN: 128,
  TERM_CAP: 50,       // 单个词在一条消息里最多数 50 次命中（防病态长文）
  RADIUS: 60,         // 片段窗口：命中点前后各 60 字符
  MIN_SNIPPET: 24,
  MAX_SNIPPETS: 3,
  LIMIT: 100,         // 最多返回多少场
  CACHE_MAX: 24,
  LOAD_WAIT_MS: 3000,   // 等 ChatMemory 全量载入的上限，超时降级为「结果可能不全」

  _cache: null,
  _cacheKey: "",
  _seq: 0,
  _activeToken: 0,

  /**
   * 作废当前扫描（用户清空搜索框 / 改了关键词 / 关闭面板时调用）。
   * 不调用的话 UI 已经切回空闲，后台仍在把剩余消息扫完——纯 CPU 浪费。
   */
  abort() {
    this._activeToken = ++this._seq;
    return this._activeToken;
  },

  /* ==================== 纯函数 ==================== */

  /**
   * 查询串 → 词列表。折叠大小写、去重（保序）、截断超长词、最多 8 个。
   * @returns {string[]}
   */
  parseQuery(raw) {
    const s = String(raw == null ? "" : raw).trim();
    if (!s) return [];
    const out = [];
    const seen = new Set();
    for (let t of s.split(/\s+/)) {
      if (!t) continue;
      // 孤立代理（从别处粘贴的半个 emoji）会让 indexOf 合法命中半个代理对，
      // 此时任何片段边界修复都无效——要拒绝的是查询词本身，不是边界。
      if (this._hasLoneSurrogate(t)) continue;
      t = t.toLowerCase();
      if (t.length > this.MAX_TERM_LEN) t = t.slice(0, this.MAX_TERM_LEN);
      if (seen.has(t)) continue;
      seen.add(t);
      out.push(t);
      if (out.length >= this.MAX_TERMS) break;
    }
    return out;
  },

  /** 是否含孤立代理项（高半区后面没跟低半区，或低半区前面不是高半区） */
  _hasLoneSurrogate(s) {
    const str = String(s || "");
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      if (c >= 0xD800 && c <= 0xDBFF) {
        const n = str.charCodeAt(i + 1);
        if (!(n >= 0xDC00 && n <= 0xDFFF)) return true;
        i++;   // 合法代理对，跳过低位
      } else if (c >= 0xDC00 && c <= 0xDFFF) {
        return true;
      }
    }
    return false;
  },

  /** 折叠大小写；长度变了就返回原串（调用方据此判断偏移是否可信） */
  _fold(s) {
    const text = String(s == null ? "" : s);
    let lower;
    try { lower = text.toLowerCase(); } catch (e) { return text; }
    return lower.length === text.length ? lower : text;
  },

  /**
   * 找出 term 在 text 中所有出现位置。
   * @returns {Array<{start:number,end:number}>} 偏移基于**原文**（折叠串长度一致时才用折叠串找）
   */
  findAll(text, term) {
    const src = String(text == null ? "" : text);
    const needle = String(term == null ? "" : term).toLowerCase();
    if (!src || !needle) return [];
    const fold = this._fold(src);
    // 折叠串长度与原文不一致时，折叠串的偏移不可信 → 用原文做大小写敏感匹配（宁可少命中，不可错位）
    const hay = (fold.length === src.length) ? fold : src;
    const pat = (fold.length === src.length) ? needle : String(term);
    const out = [];
    let from = 0;
    let guard = 0;
    while (guard++ < this.TERM_CAP) {
      const idx = hay.indexOf(pat, from);
      if (idx < 0) break;
      out.push({ start: idx, end: idx + pat.length });
      from = idx + Math.max(1, pat.length);
    }
    return out;
  },

  /**
   * 向前扩到最近的断句/空白边界，但**最多回退 maxBack 个字**。
   *
   * 上限是必须的：中文长段落常常整段没有句号/空格（AI 输出的连续正文就是如此），
   * 不设上限时会一路退到段首——命中词被推到 100 多字之外，单行 ellipsis 下
   * 等于"标黄的搜索结果里看不到为什么命中"。
   * 宁可在一句话中间切开，也不能把命中词挤出可见区。
   */
  snapStart(text, pos, maxBack) {
    const src = String(text || "");
    const back = isFinite(maxBack) ? Math.max(0, maxBack) : 16;
    const limit = Math.max(0, Math.min(src.length, (pos | 0)) - back);
    let i = Math.max(0, Math.min(src.length, pos | 0));
    while (i > limit) {
      const ch = src[i - 1];
      if (/[\s，。、；：！？,.;:!?)\]】」』"']/.test(ch)) break;
      i--;
    }
    return i;
  },

  /** 向后扩到最近的断句/空白边界，最多前进 maxFwd 个字（理由同上） */
  snapEnd(text, pos, maxFwd) {
    const src = String(text || "");
    const fwd = isFinite(maxFwd) ? Math.max(0, maxFwd) : 16;
    const limit = Math.min(src.length, (pos | 0) + fwd);
    let i = Math.max(0, Math.min(src.length, pos | 0));
    while (i < limit) {
      const ch = src[i];
      if (/[\s，。、；：！？,.;:!?(\[【「『"']/.test(ch)) break;
      i++;
    }
    return i;
  },

  /** 合并重叠/相邻区间（多词命中时必然重叠，不合并会出现嵌套高亮） */
  mergeSpans(spans) {
    const list = (Array.isArray(spans) ? spans : [])
      .filter((s) => s && isFinite(s.start) && isFinite(s.end) && s.end > s.start)
      .slice()
      .sort((a, b) => a.start - b.start || a.end - b.end);
    const out = [];
    for (const sp of list) {
      const last = out[out.length - 1];
      if (last && sp.start <= last.end) {
        if (sp.end > last.end) last.end = sp.end;
      } else {
        out.push({ start: sp.start, end: sp.end });
      }
    }
    return out;
  },

  /**
   * 由命中位置生成展示片段：窗口 ±RADIUS，向两侧 snap 到断句边界。
   * `spans` 是相对**片段**的偏移，UI 直接据此插 <mark>，不需要再做字符串替换。
   * @returns {{text:string, spans:Array, head:boolean, tail:boolean}}
   */
  makeSnippet(text, spans, radius) {
    const src = String(text == null ? "" : text);
    const merged = this.mergeSpans(spans);
    if (!merged.length) return { text: "", spans: [], head: false, tail: false };
    const pad = isFinite(radius) ? Math.max(8, radius) : this.RADIUS;
    const first = merged[0];
    // 命中词必须落在片段**前 8 个字以内**，不能居中：左栏一行只能显示约 12 个汉字，
    // 居中窗口会被省略号把高亮裁掉——用户看到一条标黄的搜索结果，却看不到为什么命中。
    const LEAD = 8;   // 与引擎侧 LEAD_MAX 统一为 8（6 与 8 都落在可见区，双值必然导致两处高亮位置不一致）
    const width = pad * 2 + (first.end - first.start);
    let start = Math.max(0, first.start - LEAD);
    let end = Math.min(src.length, start + width);
    if (end < first.end) end = Math.min(src.length, first.end);
    if (start > 0) start = this.snapStart(src, start, 12);
    if (end < src.length) end = this.snapEnd(src, end, 24);
    // snap 之后高亮仍可能被推出可见区 → 兜一层硬约束
    if (first.start - start > LEAD + 4) start = Math.max(0, first.start - LEAD);
    if (end - first.end > pad * 2) end = Math.min(src.length, first.end + pad);
    if (end - start < this.MIN_SNIPPET) {
      end = Math.min(src.length, start + this.MIN_SNIPPET);
      start = Math.max(0, end - this.MIN_SNIPPET);
    }
    // 代理对保护：不要把 emoji / 扩展汉字切成半个字符
    if (start > 0 && this._isLowSurrogate(src.charCodeAt(start))) start--;
    if (end < src.length && this._isLowSurrogate(src.charCodeAt(end))) end++;
    const out = [];
    for (const sp of merged) {
      if (sp.end <= start || sp.start >= end) continue;
      out.push({
        start: Math.max(0, sp.start - start),
        end: Math.min(end, sp.end) - start,
      });
    }
    return {
      text: src.slice(start, end),
      spans: out,
      head: start > 0,
      tail: end < src.length,
    };
  },

  _isLowSurrogate(code) {
    return code >= 0xDC00 && code <= 0xDFFF;
  },

  /* ==================== 单条会话匹配 ==================== */

  /**
   * @param {object} unit ChatMemory.allSessions() 的元素
   * @param {string[]} terms 已折叠的词
   * @returns {object|null} 命中则返回结果条目
   */
  _matchUnit(unit, terms) {
    if (!unit || !terms.length) return null;
    const title = String(unit.title || "");
    const docTitle = String(unit.docTitle || "");
    const present = new Set();
    let tier = 9;
    let hits = 0;

    // 档位 0：会话标题 / 所属文章标题
    for (const t of terms) {
      const inTitle = this.findAll(title, t).length > 0;
      const inDoc = docTitle ? this.findAll(docTitle, t).length > 0 : false;
      if (inTitle || inDoc) {
        present.add(t);
        tier = 0;
        hits += 2;
      }
    }

    // 档位 1：正文（逐条扫描，不跨消息拼接）
    let snippet = null;
    const msgs = Array.isArray(unit.history) ? unit.history : [];
    for (let mi = 0; mi < msgs.length; mi++) {
      const msg = msgs[mi];
      const text = String((msg && msg.content) || "");
      if (!text) continue;
      const spans = [];
      let localHits = 0;
      for (const t of terms) {
        const found = this.findAll(text, t);
        if (!found.length) continue;
        present.add(t);
        localHits += found.length;
        for (const sp of found) spans.push(sp);
      }
      if (!localHits) continue;
      if (tier > 1) tier = 1;
      hits += localHits;
      if (!snippet) {
        try { snippet = this.makeSnippet(text, spans); } catch (e) { snippet = null; }
        // 记录**真实**角色与下标：片段可能来自用户提问，谎报 assistant
        // 会让 UI 把"我自己的问题"标成"AI 回答"。
        if (snippet) {
          snippet.role = String((msg && msg.role) || "");
          snippet.msgIndex = mi;
          // msgSeq 是跳转锚点（不随下标漂移）；旧数据没有 seq 时为 null，调用方回退到 msgIndex
          const sq = Number(msg && msg.seq);
          snippet.msgSeq = (isFinite(sq) && sq > 0) ? Math.floor(sq) : null;
        }
      }
    }

    // AND 语义：所有词都必须出现过（标题或正文任意位置）
    if (present.size < terms.length) return null;
    const ts = Number(unit.ts) || 0;
    const lastMsgTs = Number(unit.lastMsgTs) || ts;
    const docKey = unit.key || "";
    return {
      kind: unit.kind,
      key: docKey,
      sid: unit.sid,
      title: title || docTitle || "(无标题)",
      docTitle,
      ts,
      lastMsgTs,
      pinned: !!unit.pinned,
      tier,
      hits,
      // 兼容字段：引擎侧按 hitCount / snippets[] / fingerprint 消费，
      // 本实现是单片段，用长度 1 的数组承接，两边不必为字段名返工。
      hitCount: hits,
      // 当时的消息条数：前端用 {count, lastMsgTs} 双字段判断「该对话已更新」
      // （只删中间一条 count 抓得到；删中间又追加一条只有 lastMsgTs 抓得到）
      count: msgs.length,
      snippet,
      snippets: snippet ? [snippet] : [],
      docKey: docKey,
      docKeyRaw: docKey,
      fingerprint: { count: msgs.length, lastMsgTs, lastSeq: Number(unit.lastSeq) || 0 },
      // 无 seq → 本轮不做 stale 判定，恒 false（不要用它表达"可能有新内容"）
      stale: false,
    };
  },

  /* ==================== 对外入口 ==================== */

  /**
   * 检索。会等 ChatMemory 全量加载完成再扫（否则只搜到 pref 镜像里那几条，
   * 用户看到的结果「时多时少」，比慢一点糟得多）。
   * @param {string} rawQuery
   * @returns {Promise<{items:Array,total:number,done:boolean,empty?:boolean,error?:string}>}
   */
  async search(rawQuery, opts) {
    const token = ++this._seq;
    this._activeToken = token;
    // clientSeq：调用方自增序号，原样回传，UI 只渲染「等于最后一次发出的序号」的结果。
    // 内部 token 不对外暴露——它用于 abort，与 UI 的乱序判定是两件事。
    const clientSeq = (opts && typeof opts.clientSeq === "number") ? opts.clientSeq : null;
    const terms = this.parseQuery(rawQuery);
    if (!terms.length) {
      return { clientSeq, items: [], total: 0, done: true, empty: true, token };
    }

    const mem = (typeof ChatMemory !== "undefined" && ChatMemory) ? ChatMemory : null;
    if (!mem || !mem.allSessions) {
      return { clientSeq, items: [], total: 0, done: true, error: "no-memory", token };
    }
    // 载入最多等 3s：等不到就用 pref 镜像先搜，并标记 degraded（结果可能不全）。
    // 不标的话，用户看到"只有 2 条命中"会以为搜索坏了。
    let deg = false;
    try {
      const loaded = await Promise.race([
        mem.ensureLoaded(),
        new Promise((r) => setTimeout(() => r("timeout"), this.LOAD_WAIT_MS)),
      ]);
      deg = (loaded === "timeout");
    } catch (e) { deg = true; }

    const rev = (mem.revision && mem.revision()) || 0;
    const key = rev + "|" + terms.join("\u0001");
    if (this._cache && this._cacheKey === key && !deg) {
      return Object.assign({}, this._cache, { token, clientSeq });
    }

    let units = [];
    try { units = mem.allSessions() || []; } catch (e) { units = []; }

    const items = [];
    let deadline = Date.now() + this.SLICE_MS;
    for (let i = 0; i < units.length; i++) {
      // 中途被 abort（用户清空搜索框 / 改了关键词）：立刻停，别把剩余几万条扫完
      if (this._activeToken !== token) {
        return { clientSeq, items: [], total: 0, done: false, reason: "aborted", token };
      }
      let hit = null;
      try { hit = this._matchUnit(units[i], terms); } catch (e) { hit = null; }
      if (hit) items.push(hit);
      if (Date.now() > deadline) {
        // 分片让出：会话多时主线程不能一口气占住（Zotero 的 UI 会明显掉帧）
        await new Promise((r) => setTimeout(r, 0));
        deadline = Date.now() + this.SLICE_MS;
      }
    }

    // 扫描期数据代际守护：分片让出时若 ChatMemory 被写（含 _adoptLegacyDocKey 自愈
    // 改写归档键），这一轮结果可能是"半旧半新身份"拼出来的。丢弃并重扫一次，
    // 上限 1 次——反复重扫会让输入明显变卡，而"结果略旧"远好于"结果错乱"。
    let revAfter = (mem.revision && mem.revision()) || 0;
    if (revAfter !== rev) {
      try {
        units = mem.allSessions() || [];
        items.length = 0;
        for (let i = 0; i < units.length; i++) {
          const h = this._matchUnit(units[i], terms);
          if (h) items.push(h);
        }
        revAfter = (mem.revision && mem.revision()) || 0;
      } catch (e) { /* 重扫失败 → 用已有结果 */ }
    }

    items.sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier;
      if (a.hits !== b.hits) return b.hits - a.hits;
      // 用 lastMsgTs（最后交流）而不是 ts（最后修改）：否则给老会话 pin 一下，
      // 它在搜索结果里的次序就变了，而内容一个字都没动。
      if (a.lastMsgTs !== b.lastMsgTs) return b.lastMsgTs - a.lastMsgTs;
      // 稳定兜底：结果顺序在同一毫秒内也必须确定，否则每次输入都抖动
      return String(a.sid) < String(b.sid) ? -1 : (String(a.sid) > String(b.sid) ? 1 : 0);
    });

    const out = {
      items: items.slice(0, this.LIMIT),
      total: items.length,
      // 严格大于才叫截断：total === LIMIT 时一条没少，提示"请细化关键词"是误报
      truncated: items.length > this.LIMIT,
      degraded: !!deg,
      done: true,
      rev: revAfter,
      token,
      clientSeq,
    };
    this._cache = out;
    this._cacheKey = key;
    if (this._cacheKeys === undefined) this._cacheKeys = [];
    this._cacheKeys.push(key);
    if (this._cacheKeys.length > this.CACHE_MAX) {
      this._cacheKeys.shift();
      if (this._cacheKey === key) { this._cache = null; this._cacheKey = ""; }
    }
    return out;
  },

  /** 供 UI 在数据变更后主动失效（ChatMemory.onChange 里调） */
  invalidate() {
    this._cache = null;
    this._cacheKey = "";
  },
};
