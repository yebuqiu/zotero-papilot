// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 问答记忆的隐私分级（chat-privacy.js，0.87.0 批次 2）
 *
 * 解决的问题：问答正文里可能夹着未发表数据、临床信息、本机路径。
 * 用户需要能说「这篇/这个库的对话不出本机」，同时**不能**因此把本地记录删掉。
 *
 * 三条设计决定（都是被推翻过的方案，别改回去）：
 *
 * 1. **排除域必须「直通」，不能「剥离」。**
 *    把排除项从上传 payload 里剥掉，会导致云端那棵树里没有它；
 *    另一台机器拉下来时，本地这份「被排除的记录」在合并里成了孤儿，
 *    再上传一次又出现——每轮同步翻一次，永远收敛不了。
 *    正确做法：云端保留**骨架**（key + excluded 标记，无 title、无正文），
 *    合并时排除域一律以本地为准（见 chat-sync 契约）。
 *
 * 2. **排除键用 libraryToken（`u` / `g<groupID>`），不用 libraryID。**
 *    group library 的 libraryID 是本机分配的自增值（加入群组顺序不同 → 5 vs 7），
 *    用它做排除键会变成「这台排除了、那台没排除」，等于没排除。
 *
 * 3. **脱敏只作用于上传投影，本地永远保留原文。**
 *    对本地也做脱敏 = 用户自己在自己机器上都看不到原文，
 *    而且不可逆（写回文件后原文就没了）。这是数据损坏，不是隐私保护。
 *
 * 存储：`<数据目录>/papilot-privacy.json`（单文件、人可读、可 git 备份）
 *   { schema:1, revision:n, libs:["u","g123"], items:["u:ABCD1234"],
 *     sids:{ "<sid>": true }, redact:true, updatedAt:ms }
 *   revision 变更会进云同步的本地指纹（否则改了排除名单，云端版本永远"更新"）。
 *
 * 消费方：cloud-sync（上传投影）、ai-log-pane / 查看器（「不同步」徽标）、prefs-roles（管理入口）。
 */
/* global Zotero, IOUtils, Prefs */

var ChatPrivacy = {
  FILE_NAME: "papilot-privacy.json",
  SCHEMA: 1,

  _state: null,
  _loadPromise: null,

  /* ==================== 存储 ==================== */

  _dir() {
    try {
      const d = Zotero.DataDirectory && Zotero.DataDirectory.dir;
      if (!d) return "";
      return String(d).replace(/[\\/]+$/, "");
    } catch (e) { return ""; }
  },

  _path() {
    const dir = this._dir();
    return dir ? (dir + "/" + this.FILE_NAME) : "";
  },

  _fileSupported() {
    try {
      return !!this._path() && typeof IOUtils !== "undefined" && IOUtils &&
        typeof IOUtils.readUTF8 === "function";
    } catch (e) { return false; }
  },

  _blank() {
    return { schema: this.SCHEMA, revision: 0, libs: [], items: [], sids: {}, redact: true, updatedAt: 0 };
  },

  /** 规范化：坏值一律丢弃，绝不让一条脏数据把整份排除表带崩 */
  _norm(raw) {
    const out = this._blank();
    if (!raw || typeof raw !== "object") return out;
    out.revision = Number(raw.revision) > 0 ? Math.floor(Number(raw.revision)) : 0;
    out.updatedAt = Number(raw.updatedAt) > 0 ? Number(raw.updatedAt) : 0;
    out.redact = raw.redact !== false;   // 默认开：宁可多脱一层，也不默认外泄
    const libs = Array.isArray(raw.libs) ? raw.libs : [];
    for (const v of libs) {
      const s = String(v || "").trim();
      if (/^u$/.test(s) || /^g\d+$/.test(s)) out.libs.push(s);
    }
    const items = Array.isArray(raw.items) ? raw.items : [];
    for (const v of items) {
      const s = String(v || "").trim();
      if (/^(?:u|g\d+):[A-Za-z0-9]{1,32}$/.test(s) || /^id:\d+$/.test(s)) out.items.push(s);
    }
    if (raw.sids && typeof raw.sids === "object" && !Array.isArray(raw.sids)) {
      for (const k of Object.keys(raw.sids)) {
        const id = String(k || "").trim();
        if (id && raw.sids[k]) out.sids[id] = true;
      }
    }
    out.libs = Array.from(new Set(out.libs));
    out.items = Array.from(new Set(out.items));
    return out;
  },

  /** 同步读（首次调起异步加载；调用方拿到的第一帧可能是空表，属可接受） */
  exclusions() {
    if (!this._state) {
      this._state = this._blank();
      this._loadPromise = this._load();
      // pref 后备：没有 IOUtils 的环境（测试桩 / 旧宿主）只靠它
      if (!this._fileSupported()) {
        try {
          const raw = Prefs.get("chatPrivacy", "");
          if (raw) this._state = this._norm(typeof raw === "string" ? JSON.parse(raw) : raw);
        } catch (e) { /* 坏值用空表 */ }
      }
    }
    return this._state;
  },

  async _load() {
    if (!this._fileSupported()) return false;
    try {
      const p = this._path();
      const exists = await IOUtils.exists(p).catch(() => false);
      if (!exists) return false;
      const v = JSON.parse(await IOUtils.readUTF8(p));
      const norm = this._norm(v);
      // 内存里若已有更新（用户刚改过），不以文件为准
      if ((this._state && this._state.revision) > norm.revision) return false;
      this._state = norm;
      return true;
    } catch (e) { return false; }
  },

  /** 等首次加载完成（云同步前必须等，否则投影用的是空排除表 → 该排的没排） */
  ready() {
    this.exclusions();
    return this._loadPromise || Promise.resolve(false);
  },

  /** 版本号：进云同步指纹用 */
  revision() {
    const s = this.exclusions();
    return Number(s.revision) || 0;
  },

  async flush() {
    const s = this.exclusions();
    try { Prefs.set("chatPrivacy", JSON.stringify(s)); } catch (e) { /* pref 后备 */ }
    if (!this._fileSupported()) return false;
    try {
      const p = this._path();
      const tmp = p + ".tmp";
      await IOUtils.writeUTF8(tmp, JSON.stringify(s));
      await IOUtils.move(tmp, p);
      return true;
    } catch (e) { return false; }
  },

  _bump() {
    const s = this.exclusions();
    s.revision = (Number(s.revision) || 0) + 1;
    s.updatedAt = Date.now();
    this.flush().catch(() => {});
    return s.revision;
  },

  /* ==================== 判定 ==================== */

  KIND_DOC: "doc",
  KIND_MULTI: "multi",

  /**
   * 构造判定主体（**唯一入口**，别再造可空位置参数的版本）。
   *
   * 为什么不用 `isExcluded(docKey, meta, excl, sid)` 四参：
   *   多篇合议天生既没有 docKey 也没有所属库。四参版只能靠"每个人记得判空"来避免崩溃，
   *   而这里用 kind 把结构差异摆在类型上——`kind:'multi'` 时 item/lib 两级在**结构上**不参与判定，
   *   不存在"读到 null 再兜底"这种要靠自觉的写法。
   *
   * @param {"doc"|"multi"} kind
   * @param {string|null} docKey canonical 归档键（u:KEY / g<groupID>:KEY）
   * @param {string|null} libraryToken 库身份（u / g<groupID>）
   * @param {string|null} sid 会话 id
   */
  makeExclusionSubject(kind, docKey, libraryToken, sid) {
    const id = String(sid == null ? "" : sid).trim() || null;
    if (kind === this.KIND_MULTI) {
      return { kind: this.KIND_MULTI, docKey: null, lib: null, sid: id };
    }
    return {
      kind: this.KIND_DOC,
      docKey: docKey ? String(docKey) : null,
      lib: libraryToken ? String(libraryToken) : null,
      sid: id,
    };
  },

  /** 由归档键直接造 doc 主体（库身份就是冒号前缀） */
  subjectForDocKey(docKey, sid) {
    const key = docKey ? String(docKey) : "";
    const lib = key.indexOf(":") > 0 ? key.slice(0, key.indexOf(":")) : null;
    return this.makeExclusionSubject(this.KIND_DOC, key || null, lib, sid || null);
  },

  /** 命中的是哪一级：'sid' | 'item' | 'lib' | null（UI 要据此说清"为什么不同步"） */
  exclusionSource(subject, excl) {
    const sub = subject || {};
    let e = excl;
    if (!e) {
      try { e = this.exclusions(); } catch (err) { return null; }
    }
    if (!e) return null;
    // 越具体越优先：单场 → 单篇 → 整库。
    // 反过来（items 先于 sids）会让"整篇不同步但单独恢复其中一场"永远失效。
    if (sub.sid && e.sids && e.sids[String(sub.sid)]) return "sid";
    if (sub.kind === this.KIND_MULTI) return null;   // 合议无归属：结构上跳过 item/lib
    if (sub.docKey && Array.isArray(e.items) && e.items.indexOf(sub.docKey) >= 0) return "item";
    if (sub.lib && Array.isArray(e.libs) && e.libs.indexOf(sub.lib) >= 0) return "lib";
    return null;
  },

  isExcluded(subject, excl) {
    return this.exclusionSource(subject, excl) !== null;
  },

  /** 隐私配置版本：与数据代际严格分开（前端据此重画徽标，不失效搜索缓存） */
  privacyRevision() {
    return this.revision();
  },

  /* ==================== 写接口（设置面板 / 查看器） ==================== */

  setItemExcluded(docKey, on) {
    const key = String(docKey || "").trim();
    if (!/^(?:u|g\d+):[A-Za-z0-9]{1,32}$/.test(key) && !/^id:\d+$/.test(key)) return false;
    const s = this.exclusions();
    const list = new Set(s.items);
    if (on) list.add(key); else list.delete(key);
    s.items = Array.from(list);
    this._bump();
    return true;
  },

  setLibExcluded(token, on) {
    const t = String(token || "").trim();
    if (!/^u$/.test(t) && !/^g\d+$/.test(t)) return false;
    const s = this.exclusions();
    const list = new Set(s.libs);
    if (on) list.add(t); else list.delete(t);
    s.libs = Array.from(list);
    this._bump();
    return true;
  },

  setSessionExcluded(sid, on) {
    const id = String(sid || "").trim();
    if (!id) return false;
    const s = this.exclusions();
    if (on) s.sids[id] = true; else delete s.sids[id];
    this._bump();
    return true;
  },

  setRedact(on) {
    const s = this.exclusions();
    s.redact = !!on;
    this._bump();
    return true;
  },

  /** 供设置面板展示：{ libs, items, sids:count, redact, revision } */
  summary() {
    const s = this.exclusions();
    return {
      libs: s.libs.slice(),
      items: s.items.slice(),
      sids: Object.keys(s.sids || {}).length,
      redact: s.redact !== false,
      revision: Number(s.revision) || 0,
    };
  },

  /* ==================== 脱敏 ==================== */

  /**
   * 上传前脱敏。**只作用于投影副本**，本地原文一概不动。
   * 保留：DOI、年份、公式、引用编号、URL 的域名与路径（学术定位信息）。
   * 替换：邮箱、手机号、Windows/Unix 绝对路径（泄露用户名与目录结构）。
   */
  redactText(text) {
    let s = String(text == null ? "" : text);
    if (!s) return "";
    // 邮箱：保留域名形态会暴露所属机构，整体替换
    s = s.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "<邮箱>");
    // 中国大陆手机号；前面不能紧邻数字（避免切掉 DOI/年份的一部分）
    s = s.replace(/(^|[^\d])1[3-9]\d{9}(?!\d)/g, "$1<手机>");
    // Windows 绝对路径（含用户名）；保留文件名不影响语义
    s = s.replace(/\b[A-Za-z]:\\(?:[^\\\s"'<>|]+\\)*([^\\\s"'<>|]+)/g, "<本机路径>/$1");
    // Unix 家目录与常见绝对路径
    s = s.replace(/(?:^|\s)\/(?:home|Users|root)\/[^\s"'<>]*/g, " <本机路径>");
    return s;
  },

  /* ==================== 上传投影 ==================== */

  /**
   * 生成上传用的副本（云端可见的那一份）。**不修改入参，也不写本地**。
   *
   * 语义：
   *   · 整篇被排除 → 只留骨架 {key, libraryID, itemKey, excluded:true, sessions:[]}
   *     （title 也去掉：标题本身就可能是敏感信息）
   *   · 单场被排除 → 该场不进 sessions，父文档保留其余场次
   *   · 保留的场次若开了脱敏 → history 逐条脱敏
   *
   * @param {"chatDocs"|"chatMulti"} kind
   * @param {object|Array} payload 解析后的文件内容
   * @param {object=} excl 排除表（测试注入）
   * @returns {{payload:*, dropped:{docs:number, sessions:number}, redacted:number}}
   */
  projectForUpload(kind, payload, excl) {
    const e = excl || this.exclusions();
    const redact = e.redact !== false;
    const stat = { docs: 0, sessions: 0, redacted: 0 };
    const doRedact = (sess) => {
      if (!redact || !sess || !Array.isArray(sess.history)) return sess;
      const history = sess.history.map((h) => {
        if (!h || typeof h.content !== "string") return h;
        const out = this.redactText(h.content);
        if (out !== h.content) stat.redacted++;
        return { role: h.role, content: out };
      });
      return Object.assign({}, sess, { history });
    };

    if (kind === "chatMulti") {
      const arr = Array.isArray(payload) ? payload : [];
      const out = [];
      for (const m of arr) {
        if (!m || typeof m !== "object") continue;
        const sid = String(m.id || "").trim();
        if (sid && this.isExcluded(this.makeExclusionSubject("multi", null, null, sid), e)) {
          stat.sessions++; continue;
        }
        // 多篇合议：所有来源文章都被排除时，这场也不该上云（没有一篇是允许的）
        const refs = Array.isArray(m.chipsRef) ? m.chipsRef : [];
        if (refs.length) {
          const allExcluded = refs.every((r) => this.isExcluded(this.subjectForDocKey(r && r.key, null), e));
          if (allExcluded) { stat.sessions++; continue; }
        }
        out.push(doRedact(m));
      }
      return { payload: out, dropped: stat, redacted: stat.redacted };
    }

    // chatDocs：map<docKey, doc>
    const src = (payload && typeof payload === "object" && !Array.isArray(payload)) ? payload : {};
    const out = {};
    for (const k of Object.keys(src)) {
      const d = src[k];
      if (!d || typeof d !== "object") continue;
      const key = String(d.key || k || "");
      if (this.isExcluded(this.subjectForDocKey(key, null), e)) {
        stat.docs++;
        // 骨架直通：让云端知道「这篇存在但内容不同步」，避免每轮同步把它当删除/新增来回翻
        out[key] = {
          key,
          libraryID: 0,
          itemKey: String(d.itemKey || ""),
          itemID: 0,
          title: "",
          updatedAt: Number(d.updatedAt) || 0,
          excluded: true,
          sessions: [],
        };
        continue;
      }
      const sessions = [];
      for (const s of (Array.isArray(d.sessions) ? d.sessions : [])) {
        const sid = String((s && s.id) || "").trim();
        if (sid && this.isExcluded(this.subjectForDocKey(key, sid), e)) { stat.sessions++; continue; }
        sessions.push(doRedact(s));
      }
      const copy = Object.assign({}, d, { sessions });
      out[key] = copy;
    }
    return { payload: out, dropped: stat, redacted: stat.redacted };
  },
};
