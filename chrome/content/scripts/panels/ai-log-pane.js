// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 左侧栏【AI 对话记录】栏目（ai-log-pane.js，0.87.0）
 *
 * 为什么**不**往 Zotero 的收藏夹树里插虚拟行：Zotero 的虚拟集合类型是闭集
 * （duplicates / unfiled / recentlyRead / retracted / publications，见 collectionTree.js
 * 的 toggleVirtualCollection 校验，非法类型直接 throw），插件没有官方扩展点。
 * 硬插 `_rows` 要在每次 refresh 后重挂、还要替 CollectionTreeRow 实现十几个谓词
 * （isCollection / isSearch / isLibrary / getItems…），任何一处漏实现都会让
 * 右键菜单、标签选择器、条目列表在选中该行时出现异常——代价远大于收益。
 *
 * 因此这里采用**旁挂**：在 `#zotero-collections-pane` 内部、树的下方插入一块
 * 自己的折叠区（max-height 45%，折叠时只占一行）。它：
 *   · 完全不改 collection tree 的数据模型与选中态，零污染；
 *   · 数据只读 ChatMemory（两级：按文章归档 / 综合对话）；
 *   · 点击任一记录可**继续对话**（灌回 ChatFloat 的全局 session 并显示浮窗）。
 *
 * 保活：Zotero 重渲染左侧栏时会把我们的节点冲掉 → MutationObserver 轻量重挂
 * （只在根节点不存在时重建，避免无谓重绘）。
 */
/* global Zotero, Services, Prefs, I18n, ChatMemory, ChatFloat, MdLite, Components */

var AILogPane = {
  ROOT_ID: "papilot-ai-log",
  STYLE_ID: "papilot-ai-log-style",
  VIEWER_ID: "papilot-ai-log-viewer",
  XHTML: "http://www.w3.org/1999/xhtml",

  _pluginID: "",
  _obs: null,
  _obsTimer: null,
  _unsub: null,
  _renderTimer: null,
  _expanded: {},   // 已展开的文章归档键（跨重绘保留）
  _query: "",
  _viewer: null,   // {root, kind, key, sid}

  /* ==================== 生命周期 ==================== */

  register(pluginID) {
    this._pluginID = pluginID || "";
    try {
      const win = Zotero.getMainWindow();
      if (!win || !win.document) return false;
      this._injectStyle(win.document);
      // 首次挂载常常赶在左侧栏渲染之前（面板树是异步填的）——必须重试，
      // 否则「注册成功但永远不显示」，而且没有任何报错可查。
      this._retryLeft = 12;
      this._retry();
      if (typeof ChatMemory !== "undefined" && ChatMemory && ChatMemory.onChange) {
        this._unsub = ChatMemory.onChange(() => {
          try { if (typeof ChatSearch !== "undefined" && ChatSearch) ChatSearch.invalidate(); } catch (e) { /* ignore */ }
          this._scheduleRender();
        });
      }
      // 旧数据一次性迁移（旧 chatSessions 快照 → 双通道）；幂等
      try {
        if (ChatMemory && ChatMemory.migrateOldSessions) ChatMemory.migrateOldSessions();
      } catch (e) { /* 迁移失败不阻塞栏目 */ }
      // 文件是异步预热的，首帧可能是 pref 镜像；稍后再刷一次
      this._scheduleRender(800);
      return true;
    } catch (e) {
      try { Zotero.logError(e); } catch (_) { /* ignore */ }
      return false;
    }
  },

  /** 挂载重试：成功即装上保活观察器，失败则 500ms 后再试（上限 12 次 ≈ 6s） */
  _retry() {
    const win = Zotero.getMainWindow();
    if (!win) return;
    if (this._ensure(win)) {
      this._watch(win);
      return;
    }
    if (this._retryLeft-- <= 0) return;
    const self = this;
    try {
      win.setTimeout(() => { try { self._retry(); } catch (e) { /* ignore */ } }, 500);
    } catch (e) { /* 窗口已销毁：放弃 */ }
  },

  unregister() {
    try { if (this._unsub) this._unsub(); } catch (e) { /* ignore */ }
    this._unsub = null;
    try { if (this._obs) this._obs.disconnect(); } catch (e) { /* ignore */ }
    this._obs = null;
    try { if (this._obsTimer) clearTimeout(this._obsTimer); } catch (e) { /* ignore */ }
    try { if (this._renderTimer) clearTimeout(this._renderTimer); } catch (e) { /* ignore */ }
    this._closeViewer();
    try {
      const win = Zotero.getMainWindow();
      const doc = win && win.document;
      const root = doc && doc.getElementById(this.ROOT_ID);
      if (root && root.parentNode) root.parentNode.removeChild(root);
      const st = doc && doc.getElementById(this.STYLE_ID);
      if (st && st.parentNode) st.parentNode.removeChild(st);
    } catch (e) { /* ignore */ }
  },

  /* ==================== 挂载 ==================== */

  _enabled() {
    try { return Prefs.get("aiLogPaneEnabled", true) !== false; } catch (e) { return true; }
  },

  _collapsed() {
    try { return Prefs.get("aiLogPaneCollapsed", false) === true; } catch (e) { return false; }
  },

  _setCollapsed(v) {
    try { Prefs.set("aiLogPaneCollapsed", !!v); } catch (e) { /* ignore */ }
  },

  _pane(doc) {
    return doc.getElementById("zotero-collections-pane") ||
      doc.getElementById("zotero-collections-tree-container");
  },

  /** 幂等挂载：根节点在且 parent 正确就什么都不做 */
  _ensure(win) {
    try {
      const doc = (win || Zotero.getMainWindow() || {}).document;
      if (!doc) return false;
      if (!this._enabled()) {
        const old = doc.getElementById(this.ROOT_ID);
        if (old && old.parentNode) old.parentNode.removeChild(old);
        return false;
      }
      const pane = this._pane(doc);
      if (!pane) return false;
      const existing = doc.getElementById(this.ROOT_ID);
      if (existing) {
        if (existing.parentNode === pane) return true;
        if (existing.parentNode) existing.parentNode.removeChild(existing);
      }
      this._injectStyle(doc);
      pane.appendChild(this._build(doc));
      return true;
    } catch (e) {
      try { Zotero.logError(e); } catch (_) { /* ignore */ }
      return false;
    }
  },

  _watch(win) {
    try {
      const doc = win.document;
      const pane = this._pane(doc);
      if (!pane || typeof win.MutationObserver !== "function") return;
      try { if (this._obs) this._obs.disconnect(); } catch (e) { /* 旧观察器已失效 */ }
      const self = this;
      this._obs = new win.MutationObserver(() => {
        // 只做「根节点是否还在」的判定：整棵子树变化都可能命中，必须去抖
        if (self._obsTimer) return;
        self._obsTimer = setTimeout(() => {
          self._obsTimer = null;
          try {
            const d = Zotero.getMainWindow().document;
            if (!d.getElementById(self.ROOT_ID)) self._ensure();
          } catch (e) { /* 窗口已销毁 */ }
        }, 300);
      });
      this._obs.observe(pane, { childList: true });
      // 树容器被整体替换时 pane 自身可能也换了 → 同时对父级挂一个
      const parent = pane.parentNode;
      if (parent) this._obs.observe(parent, { childList: true });
    } catch (e) { /* 观察失败不影响栏目可用性 */ }
  },

  _scheduleRender(delay) {
    if (this._renderTimer) { try { clearTimeout(this._renderTimer); } catch (e) { /* ignore */ } }
    const self = this;
    this._renderTimer = setTimeout(() => {
      self._renderTimer = null;
      try { self._render(); } catch (e) { /* 渲染失败不影响 Zotero */ }
    }, delay == null ? 120 : delay);
  },

  /* ==================== 样式 ==================== */

  _injectStyle(doc) {
    if (!doc || doc.getElementById(this.STYLE_ID)) return;
    const css =
      "#" + this.ROOT_ID + "{" +
        "display:flex;flex-direction:column;flex:0 0 auto;max-height:45%;" +
        "border-top:1px solid var(--fill-quinary,rgba(128,128,128,.25));" +
        "font-size:12px;color:var(--fill-primary,inherit);background:transparent;}" +
      "#" + this.ROOT_ID + " .pp-ailog-head{" +
        "display:flex;align-items:center;gap:6px;padding:5px 8px;cursor:pointer;user-select:none;" +
        "font-weight:600;}" +
      "#" + this.ROOT_ID + " .pp-ailog-head:hover{background:var(--fill-quinary,rgba(128,128,128,.12));}" +
      "#" + this.ROOT_ID + " .pp-ailog-caret{font-size:10px;opacity:.7;width:10px;}" +
      "#" + this.ROOT_ID + " .pp-ailog-count{" +
        "font-weight:400;opacity:.65;font-size:11px;margin-left:auto;}" +
      "#" + this.ROOT_ID + " .pp-ailog-body{" +
        "display:flex;flex-direction:column;min-height:0;overflow:hidden;padding:0 6px 6px;}" +
      "#" + this.ROOT_ID + " .pp-ailog-search{" +
        "appearance:none;width:100%;box-sizing:border-box;margin:2px 0 6px;padding:3px 6px;" +
        "font-size:11px;border-radius:4px;border:1px solid var(--fill-quinary,rgba(128,128,128,.35));" +
        "background:var(--material-background,transparent);color:var(--fill-primary,inherit);}" +
      "#" + this.ROOT_ID + " .pp-ailog-list{overflow-y:auto;min-height:0;}" +
      "#" + this.ROOT_ID + " .pp-ailog-group{" +
        "font-size:10.5px;text-transform:none;letter-spacing:.02em;opacity:.6;padding:6px 2px 3px;}" +
      "#" + this.ROOT_ID + " .pp-ailog-row{" +
        "display:flex;align-items:baseline;gap:6px;padding:3px 4px;border-radius:4px;cursor:pointer;}" +
      "#" + this.ROOT_ID + " .pp-ailog-row:hover{background:var(--fill-quinary,rgba(128,128,128,.16));}" +
      "#" + this.ROOT_ID + " .pp-ailog-row.pp-doc{font-weight:500;}" +
      "#" + this.ROOT_ID + " .pp-ailog-row.pp-ses{padding-left:16px;opacity:.9;}" +
      "#" + this.ROOT_ID + " .pp-ailog-name{" +
        "flex:1 1 auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}" +
      "#" + this.ROOT_ID + " .pp-ailog-meta{flex:0 0 auto;font-size:10.5px;opacity:.55;}" +
      "#" + this.ROOT_ID + " .pp-ailog-dot{" +
        "flex:0 0 8px;font-size:8px;line-height:1;color:var(--pp-accent,#2d6cdf);}" +
      "#" + this.ROOT_ID + " .pp-ailog-star{" +
        "flex:0 0 auto;font-size:11px;cursor:pointer;padding:0 1px;line-height:1;}" +
      "#" + this.ROOT_ID + " .pp-ailog-star:hover{opacity:1 !important;}" +
      "#" + this.ROOT_ID + " .pp-ailog-empty{opacity:.6;padding:6px 2px;line-height:1.5;}" +
      "#" + this.ROOT_ID + " .pp-ailog-more{opacity:.7;padding:4px 2px;cursor:pointer;font-size:11px;}" +
      "#" + this.ROOT_ID + " .pp-ailog-snip{" +
        "font-size:10.5px;opacity:.62;padding:0 4px 3px 15px;white-space:nowrap;" +
        "overflow:hidden;text-overflow:ellipsis;}" +
      "#" + this.ROOT_ID + " .pp-ailog-snip mark{" +
        "background:rgba(255,196,0,.38);color:inherit;border-radius:2px;padding:0 1px;}" +
      "#" + this.VIEWER_ID + "{" +
        "position:fixed;inset:0;z-index:99990;display:flex;align-items:center;justify-content:center;" +
        "background:rgba(0,0,0,.28);}" +
      "#" + this.VIEWER_ID + " .pp-ailog-dlg{" +
        "width:min(680px,88vw);max-height:78vh;display:flex;flex-direction:column;" +
        "background:var(--material-background,#fff);color:var(--fill-primary,#222);" +
        "border-radius:10px;box-shadow:0 12px 40px rgba(0,0,0,.3);overflow:hidden;}" +
      "#" + this.VIEWER_ID + " .pp-ailog-dlg-head{" +
        "display:flex;align-items:center;gap:8px;padding:10px 14px;" +
        "border-bottom:1px solid var(--fill-quinary,rgba(128,128,128,.25));font-weight:600;}" +
      "#" + this.VIEWER_ID + " .pp-ailog-dlg-title{" +
        "flex:1 1 auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}" +
      "#" + this.VIEWER_ID + " .pp-ailog-dlg-body{" +
        "padding:10px 14px;overflow-y:auto;display:flex;flex-direction:column;gap:8px;font-size:13px;}" +
      "#" + this.VIEWER_ID + " .pp-ailog-msg{" +
        "padding:7px 10px;border-radius:8px;white-space:pre-wrap;word-break:break-word;line-height:1.55;}" +
      "#" + this.VIEWER_ID + " .pp-ailog-msg.pp-q{background:rgba(45,108,223,.12);border:1px solid rgba(45,108,223,.25);}" +
      "#" + this.VIEWER_ID + " .pp-ailog-msg.pp-a{background:rgba(128,128,128,.10);border:1px solid rgba(128,128,128,.2);white-space:normal;}" +
      "#" + this.VIEWER_ID + " .pp-ailog-msg .pp-ailog-role{font-size:10.5px;opacity:.55;margin-bottom:2px;}" +
      "#" + this.VIEWER_ID + " .pp-ailog-dlg-foot{" +
        "display:flex;gap:8px;padding:10px 14px;border-top:1px solid var(--fill-quinary,rgba(128,128,128,.25));" +
        "align-items:center;}" +
      "#" + this.VIEWER_ID + " .pp-ailog-btn{" +
        "appearance:none;padding:4px 10px;border-radius:5px;font-size:12px;cursor:pointer;" +
        "border:1px solid var(--fill-quinary,rgba(128,128,128,.4));" +
        "background:var(--material-button,#f5f5f5);color:var(--fill-primary,#222);}" +
      "#" + this.VIEWER_ID + " .pp-ailog-btn:hover{filter:brightness(.97);}" +
      "#" + this.VIEWER_ID + " .pp-ailog-spacer{flex:1 1 auto;}";
    try {
      const st = doc.createElementNS(this.XHTML, "style");
      st.setAttribute("id", this.STYLE_ID);
      st.textContent = css;
      doc.documentElement.appendChild(st);
    } catch (e) { /* 样式注入失败：功能仍可用，只是不美观 */ }
  },

  /* ==================== 构建与环境 ==================== */

  _h(doc, tag, attrs, text) {
    const el = doc.createElementNS(this.XHTML, tag);
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        if (attrs[k] == null) continue;
        if (k === "style") el.style.cssText = attrs[k];
        else if (k === "class") el.className = attrs[k];
        else el.setAttribute(k, attrs[k]);
      }
    }
    if (text != null) el.textContent = text;
    return el;
  },

  _relTime(ts) {
    const t = Number(ts) || 0;
    if (!t) return "";
    const diff = Math.max(0, Date.now() - t);
    const min = Math.floor(diff / 60000);
    if (min < 1) return I18n.isZh ? "刚刚" : "now";
    if (min < 60) return (I18n.isZh ? min + " 分钟前" : min + "m");
    const hr = Math.floor(min / 60);
    if (hr < 24) return (I18n.isZh ? hr + " 小时前" : hr + "h");
    const day = Math.floor(hr / 24);
    if (day < 30) return (I18n.isZh ? day + " 天前" : day + "d");
    try { return new Date(t).toLocaleDateString(); } catch (e) { return ""; }
  },

  _memory() {
    return (typeof ChatMemory !== "undefined" && ChatMemory) ? ChatMemory : null;
  },

  /* ==================== 渲染 ==================== */

  _build(doc) {
    const self = this;
    const root = this._h(doc, "div", { id: this.ROOT_ID, role: "region",
      "aria-label": I18n.isZh ? "AI 对话记录" : "AI chat log" });

    const head = this._h(doc, "div", { class: "pp-ailog-head", title: I18n.isZh
      ? "单篇问答归档到对应文章下，多篇综合对话集中在这里" : "Per-paper chats are filed under the paper; multi-paper chats live here" });
    this._countEl = this._h(doc, "span", { class: "pp-ailog-caret" }, this._collapsed() ? "▸" : "▾");
    head.appendChild(this._countEl);
    head.appendChild(this._h(doc, "span", null, I18n.isZh ? "AI 对话记录" : "AI Chat Log"));
    this._badgeEl = this._h(doc, "span", { class: "pp-ailog-count" }, "");
    head.appendChild(this._badgeEl);
    head.addEventListener("click", () => {
      const next = !this._collapsed();
      this._setCollapsed(next);
      this._applyCollapsed();
    });
    root.appendChild(head);

    const body = this._h(doc, "div", { class: "pp-ailog-body" });
    this._bodyEl = body;
    const search = this._h(doc, "input", { class: "pp-ailog-search", type: "search",
      placeholder: I18n.isZh ? "搜索对话…" : "Search chats…", value: this._query });
    search.addEventListener("input", () => {
      self._query = String(search.value || "");
      self._scheduleSearch();
    });
    body.appendChild(search);
    this._listEl = this._h(doc, "div", { class: "pp-ailog-list" });
    body.appendChild(this._listEl);
    root.appendChild(body);

    this._applyCollapsed();
    this._renderList();
    return root;
  },

  /**
   * 搜索防抖 + 异步检索。检索是异步的（等 ChatMemory 全量加载 + 分片扫描），
   * 期间先显示「检索中…」，拿到结果再整表重绘一次——不做两阶段投递，
   * 用户不会看到列表先出现一批再突然插进另一批（滚动位置会被打乱）。
   */
  _scheduleSearch(delay) {
    if (this._searchTimer) { try { clearTimeout(this._searchTimer); } catch (e) { /* ignore */ } }
    const self = this;
    this._searchTimer = setTimeout(() => {
      self._searchTimer = null;
      self._runSearch().catch(() => { /* 检索失败按无结果处理 */ });
    }, delay == null ? 200 : delay);
  },

  async _runSearch() {
    const q = this._query.trim();
    if (!q) {
      this._hits = null;
      this._searching = false;
      this._renderList();
      return;
    }
    const hasSearch = (typeof ChatSearch !== "undefined" && ChatSearch && ChatSearch.search);
    if (!hasSearch) { this._renderList(); return; }
    this._searching = true;
    this._renderList();
    let res = null;
    try { res = await ChatSearch.search(q); } catch (e) { res = null; }
    this._searching = false;
    // 结果回来时用户可能已经改了关键词：过期的结果直接丢弃
    if (String(this._query).trim() !== q) return;
    const items = (res && res.items) || [];
    this._hits = new Map(items.map((it) => [it.sid, it]));
    this._searchTotal = (res && res.total) || 0;
    this._renderList();
  },

  _applyCollapsed() {
    const collapsed = this._collapsed();
    if (this._bodyEl) this._bodyEl.style.display = collapsed ? "none" : "flex";
    if (this._countEl) this._countEl.textContent = collapsed ? "▸" : "▾";
  },

  _render() {
    const win = Zotero.getMainWindow();
    const doc = win && win.document;
    if (!doc) return;
    if (!this._enabled()) {
      const old = doc.getElementById(this.ROOT_ID);
      if (old && old.parentNode) old.parentNode.removeChild(old);
      return;
    }
    if (!doc.getElementById(this.ROOT_ID)) {
      this._ensure(win);
      return;
    }
    this._applyCollapsed();
    this._renderList();
  },

  _renderList() {
    if (!this._listEl) return;
    const doc = this._listEl.ownerDocument;
    while (this._listEl.firstChild) this._listEl.removeChild(this._listEl.firstChild);

    const mem = this._memory();
    if (!mem) {
      this._listEl.appendChild(this._h(doc, "div", { class: "pp-ailog-empty" },
        I18n.isZh ? "记忆模块不可用" : "Memory module unavailable"));
      return;
    }

    let docs = [];
    let multi = [];
    try { docs = mem.listDocs() || []; } catch (e) { docs = []; }
    try { multi = mem.listMulti() || []; } catch (e) { multi = []; }

    const q = this._query.trim();
    const hit = (s) => !q || String(s || "").toLowerCase().indexOf(q.toLowerCase()) >= 0;
    if (q && this._hits) {
      // 全文命中集合（sid）决定显示哪些会话；文章标题本身命中时保留该篇文章下全部会话
      const bySid = this._hits;
      docs = docs.map((d) => {
        if (hit(d.title)) return d;
        const sessions = (d.sessions || []).filter((s) => bySid.has(s.id));
        return Object.assign({}, d, { sessions });
      }).filter((d) => (d.sessions || []).length > 0 || hit(d.title));
      multi = multi.filter((m) => bySid.has(m.id));
    } else if (q) {
      // 检索还没回来：先按标题过滤，避免列表完全不动像卡死
      docs = docs.filter((d) => hit(d.title) ||
        (d.sessions || []).some((s) => hit(s.title)));
      multi = multi.filter((m) => hit(m.title));
    }

    if (this._badgeEl) {
      const st = (() => { try { return mem.stats(); } catch (e) { return null; } })();
      this._badgeEl.textContent = st ? (st.docs + st.multi) + "" : "";
    }

    if (!docs.length && !multi.length) {
      const msg = this._searching
        ? (I18n.isZh ? "正在检索…" : "Searching…")
        : (I18n.isZh ? "没有匹配的对话。" : "No matching chats.");
      this._listEl.appendChild(this._h(doc, "div", { class: "pp-ailog-empty" },
        q ? msg
          : (I18n.isZh
            ? "还没有对话记录。\n在 AI 问答浮窗或右侧「AI 问答」面板提问后，记录会自动出现在这里：单篇归档到对应文章下，多篇综合对话留在本栏目。"
            : "No chats yet. Ask in the AI popup or the AI Chat sidebar section — per-paper chats get filed under the paper, multi-paper chats show up here.")));
      return;
    }

    if (docs.length) {
      this._listEl.appendChild(this._h(doc, "div", { class: "pp-ailog-group" },
        (I18n.isZh ? "按文章归档 · " : "By paper · ") + docs.length));
      const shown = docs.slice(0, 30);
      for (const d of shown) this._appendDocRow(doc, d);
      if (docs.length > shown.length) {
        this._listEl.appendChild(this._h(doc, "div", { class: "pp-ailog-more" },
          (I18n.isZh ? "还有 " + (docs.length - shown.length) + " 篇…（用搜索定位）"
            : (docs.length - shown.length) + " more — use search")));
      }
    }

    if (multi.length) {
      this._listEl.appendChild(this._h(doc, "div", { class: "pp-ailog-group" },
        (I18n.isZh ? "综合对话 · " : "Multi-paper · ") + multi.length));
      const shown = this._sortPinned(multi).slice(0, 30);
      for (const m of shown) {
        const chips = (m.chipsRef || []).length;
        this._appendSessionRow(doc, {
          kind: "multi",
          key: "",
          sid: m.id,
          title: m.title,
          ts: m.ts,
          meta: (chips ? chips + (I18n.isZh ? " 篇 · " : "p · ") : "") + this._relTime(m.ts),
          pinned: !!m.pinned,
        });
      }
    }
  },

  /**
   * 置顶优先，其余按时间倒序。
   * 注意**只在本组内**生效：置顶的会话不会跨到「按文章归档」组去。
   */
  _sortPinned(list) {
    return (list || []).slice().sort((a, b) => {
      const pa = a.pinned ? 1 : 0;
      const pb = b.pinned ? 1 : 0;
      if (pa !== pb) return pb - pa;
      // 用 lastMsgTs 而不是 ts：ts 会被 pin 撞一下，用它排序会让行位置莫名跳动
      const ta = Number(a.lastMsgTs) || Number(a.ts) || 0;
      const tb = Number(b.lastMsgTs) || Number(b.ts) || 0;
      return tb - ta;
    });
  },

  /**
   * 会话行（doc 与 multi 共用）：[未读点] 标题 [★] 元信息
   * 置顶星标常驻（不是悬停才出现）——窄面板里悬停按钮最容易点不到，
   * 而且触摸板用户根本没有「悬停」这回事。
   */
  _appendSessionRow(doc, opts) {
    const self = this;
    const mem = this._memory();
    const unread = (() => {
      try { return mem && mem.isUnread ? mem.isUnread({ id: opts.sid, ts: opts.ts }) : false; }
      catch (e) { return false; }
    })();
    const row = this._h(doc, "div", {
      class: "pp-ailog-row " + (opts.kind === "multi" ? "" : "pp-ses"),
      title: opts.title || "",
    });

    // 未读圆点：固定 8px 占位，读过的也占位（否则整行会左右跳动）
    const dot = this._h(doc, "span", { class: "pp-ailog-dot" }, unread ? "●" : "");
    dot.style.opacity = unread ? "0.85" : "0";
    row.appendChild(dot);

    const name = this._h(doc, "span", { class: "pp-ailog-name" }, opts.title || "(无标题)");
    if (unread) name.style.fontWeight = "600";
    row.appendChild(name);

    const star = this._h(doc, "span", {
      class: "pp-ailog-star",
      title: opts.pinned ? (I18n.isZh ? "取消置顶" : "Unpin") : (I18n.isZh ? "置顶" : "Pin"),
    }, opts.pinned ? "★" : "☆");
    star.style.opacity = opts.pinned ? "0.95" : "0.35";
    star.addEventListener("click", (ev) => {
      try { ev.stopPropagation(); } catch (e) { /* ignore */ }
      try { mem.togglePin(opts.kind, opts.key, opts.sid); } catch (e) { /* ignore */ }
      self._renderList();
    });
    row.appendChild(star);

    row.appendChild(this._h(doc, "span", { class: "pp-ailog-meta" }, opts.meta || ""));

    // 全文命中信息：既用于片段渲染，也用于"打开后定位到那条消息"
    const hitInfo = (this._hits && this._hits.get) ? this._hits.get(opts.sid) : null;
    const anchorSeq = (hitInfo && hitInfo.snippet && hitInfo.snippet.msgSeq) || 0;
    row.addEventListener("click", () => this._openViewer(opts.kind, opts.key, opts.sid, anchorSeq));

    if (hitInfo && hitInfo.snippet && hitInfo.snippet.text) {
      const boxEl = this._h(doc, "div", { style: "display:flex;flex-direction:column;gap:1px;" });
      boxEl.appendChild(row);
      boxEl.appendChild(this._snippetEl(doc, hitInfo.snippet));
      this._listEl.appendChild(boxEl);
    } else {
      this._listEl.appendChild(row);
    }
  },

  /** 片段渲染：snip.spans 是相对片段文本的偏移，直接切串插 <mark> */
  _snippetEl(doc, snip) {
    const wrap = this._h(doc, "div", { class: "pp-ailog-snip" });
    const text = String(snip.text || "");
    const prefix = snip.head ? "…" : "";
    if (prefix) wrap.appendChild(this._h(doc, "span", null, prefix));
    let cursor = 0;
    for (const sp of (snip.spans || [])) {
      const s0 = Math.max(cursor, sp.start | 0);
      const e0 = Math.min(text.length, sp.end | 0);
      if (e0 <= s0) continue;
      if (s0 > cursor) wrap.appendChild(this._h(doc, "span", null, text.slice(cursor, s0)));
      wrap.appendChild(this._h(doc, "mark", null, text.slice(s0, e0)));
      cursor = e0;
    }
    if (cursor < text.length) wrap.appendChild(this._h(doc, "span", null, text.slice(cursor)));
    if (snip.tail) wrap.appendChild(this._h(doc, "span", null, "…"));
    return wrap;
  },

  _appendDocRow(doc, d) {
    const self = this;
    const expanded = !!this._expanded[d.key];
    const row = this._h(doc, "div", { class: "pp-ailog-row pp-doc", title: d.title });
    row.appendChild(this._h(doc, "span", { class: "pp-ailog-name" },
      (expanded ? "▾ " : "▸ ") + (d.title || d.key)));
    row.appendChild(this._h(doc, "span", { class: "pp-ailog-meta" },
      (d.sessions.length || 0) + (I18n.isZh ? " 场 · " : " · ") + this._relTime(d.updatedAt)));
    row.addEventListener("click", () => {
      self._expanded[d.key] = !expanded;
      self._renderList();
    });
    this._listEl.appendChild(row);

    if (!expanded) return;
    for (const s of this._sortPinned(d.sessions || []).slice(0, 10)) {
      this._appendSessionRow(doc, {
        kind: "doc",
        key: d.key,
        sid: s.id,
        title: s.title,
        ts: s.ts,
        meta: s.count + (I18n.isZh ? " 条 · " : " · ") + this._relTime(s.ts),
        pinned: !!s.pinned,
      });
    }
  },

  /* ==================== 查看器 ==================== */

  /**
   * 打开会话查看器。
   * @param {number=} msgSeq 片段所在消息的 seq —— **只用 seq，不回退到下标**：
   *   下标在「删中间一条 / 重新生成 / 云同步回滚」后指向另一条消息，
   *   用它定位会把用户精确地送到一条不相干的回答上，比不定位糟得多。
   */
  _openViewer(kind, key, sid, msgSeq) {
    const mem = this._memory();
    if (!mem) return;
    const got = mem.getSession(kind, key, sid);
    if (!got || !got.session) return;
    // 打开即已读；列表上的未读点稍后重绘掉（不阻塞查看器）
    try { if (mem.markSeen) mem.markSeen(sid); } catch (e) { /* ignore */ }
    this._scheduleRender(80);
    const win = Zotero.getMainWindow();
    const doc = win && win.document;
    if (!doc) return;
    this._closeViewer();

    const ses = got.session;
    const root = this._h(doc, "div", { id: this.VIEWER_ID });
    const dlg = this._h(doc, "div", { class: "pp-ailog-dlg", role: "dialog" });

    const head = this._h(doc, "div", { class: "pp-ailog-dlg-head" });
    const docTitle = got.doc ? got.doc.title : "";
    head.appendChild(this._h(doc, "span", { class: "pp-ailog-dlg-title" },
      ses.title || docTitle || (I18n.isZh ? "对话记录" : "Chat log")));
    const closeBtn = this._h(doc, "button", { class: "pp-ailog-btn" }, I18n.isZh ? "关闭" : "Close");
    closeBtn.addEventListener("click", () => this._closeViewer());
    head.appendChild(closeBtn);
    dlg.appendChild(head);

    const body = this._h(doc, "div", { class: "pp-ailog-dlg-body" });
    const items = Array.isArray(ses.history) ? ses.history : [];
    for (const h of items) {
      if (h.role === "system") continue;
      const isQ = h.role === "user";
      const b = this._h(doc, "div", { class: "pp-ailog-msg " + (isQ ? "pp-q" : "pp-a") });
      b.appendChild(this._h(doc, "div", { class: "pp-ailog-role" },
        isQ ? (I18n.isZh ? "问" : "Q") : (I18n.isZh ? "答" : "A")));
      const content = this._h(doc, "div");
      const sq = Number(h.seq);
      if (isFinite(sq) && sq > 0) b.setAttribute("data-seq", String(Math.floor(sq)));
      if (!isQ && typeof MdLite !== "undefined" && MdLite && MdLite.toHtml) {
        try { content.innerHTML = MdLite.toHtml(String(h.content || "")); }
        catch (e) { content.textContent = String(h.content || ""); }
      } else {
        content.textContent = String(h.content || "");
      }
      b.appendChild(content);
      body.appendChild(b);
    }
    dlg.appendChild(body);

    // 底部：元信息 + 操作
    const foot = this._h(doc, "div", { class: "pp-ailog-dlg-foot" });
    const meta = this._h(doc, "span", { class: "pp-ailog-meta" },
      (ses.count || items.length) + (I18n.isZh ? " 条 · " : " msgs · ") +
      this._relTime(ses.ts) + (ses.roleId ? (" · " + ses.roleId) : ""));
    foot.appendChild(meta);
    foot.appendChild(this._h(doc, "span", { class: "pp-ailog-spacer" }));

    const copyBtn = this._h(doc, "button", { class: "pp-ailog-btn" }, I18n.isZh ? "复制 Markdown" : "Copy MD");
    copyBtn.addEventListener("click", () => this._copyMarkdown(got));
    foot.appendChild(copyBtn);

    const delBtn = this._h(doc, "button", { class: "pp-ailog-btn" }, I18n.isZh ? "删除" : "Delete");
    delBtn.addEventListener("click", () => {
      try {
        mem.removeSession(kind, key, sid);
      } catch (e) { /* ignore */ }
      this._closeViewer();
      this._render();
    });
    foot.appendChild(delBtn);

    const contBtn = this._h(doc, "button", { class: "pp-ailog-btn" },
      I18n.isZh ? "继续这场对话" : "Continue");
    contBtn.addEventListener("click", () => this._continue(got));
    foot.appendChild(contBtn);

    dlg.appendChild(foot);
    root.appendChild(dlg);
    root.addEventListener("click", (ev) => {
      if (ev.target === root) this._closeViewer();
    });
    // Esc 关闭（只在本查看器处于顶层时生效）
    this._escHandler = (ev) => {
      if (ev.key === "Escape") {
        try { ev.stopPropagation(); } catch (e) { /* ignore */ }
        this._closeViewer();
      }
    };
    try { doc.addEventListener("keydown", this._escHandler, true); } catch (e) { /* ignore */ }

    doc.documentElement.appendChild(root);
    this._viewer = { root, kind, key, sid };

    // 定位到命中消息：滚到中间 + 短时高亮。拿不到 querySelector 的环境（测试桩）静默跳过。
    const target = Number(msgSeq) || 0;
    if (target) {
      try {
        const el = dlg.querySelector ? dlg.querySelector('[data-seq="' + target + '"]') : null;
        if (el && el.scrollIntoView) {
          el.scrollIntoView({ block: "center" });
          el.style.outline = "2px solid rgba(255,196,0,.85)";
          setTimeout(() => {
            try { el.style.outline = ""; } catch (e) { /* ignore */ }
          }, 1400);
        }
      } catch (e) { /* 定位失败不影响打开 */ }
    }
  },

  _closeViewer() {
    try {
      if (this._escHandler) {
        const win = Zotero.getMainWindow();
        if (win && win.document) win.document.removeEventListener("keydown", this._escHandler, true);
      }
    } catch (e) { /* ignore */ }
    this._escHandler = null;
    try {
      if (this._viewer && this._viewer.root && this._viewer.root.parentNode) {
        this._viewer.root.parentNode.removeChild(this._viewer.root);
      }
    } catch (e) { /* ignore */ }
    this._viewer = null;
  },

  _copyMarkdown(got) {
    const ses = got && got.session;
    if (!ses) return;
    const title = (got.doc && got.doc.title) || ses.title || "";
    const lines = [];
    if (title) lines.push("# " + title + "\n");
    for (const h of (ses.history || [])) {
      if (h.role === "system") continue;
      lines.push((h.role === "user" ? "**问：** " : "**答：** ") + h.content);
      lines.push("");
    }
    const md = lines.join("\n");
    try {
      if (Zotero.Utilities && Zotero.Utilities.Internal &&
        Zotero.Utilities.Internal.copyTextToClipboard) {
        Zotero.Utilities.Internal.copyTextToClipboard(md);
        return true;
      }
    } catch (e) { /* 回退剪贴板失败 */ }
    try {
      const win = Zotero.getMainWindow();
      win.navigator.clipboard.writeText(md);
      return true;
    } catch (e) { return false; }
  },

  /**
   * 继续一场历史对话：解析归属条目 → 灌回 ChatFloat 全局 session → 显示浮窗。
   * 顺序是「先 show 再灌」：show() 会创建 entry 并可能自动续上最近一场，
   * 随后 _applySession 带 entry 覆盖成用户点的那一场并重绘。
   * 条目已删除时只恢复文本（不锁定条目），并提示原因——不能让用户点了没反应。
   */
  _continue(got) {
    const mem = this._memory();
    const ses = got && got.session;
    if (!mem || !ses) return false;
    try {
      if (typeof ChatFloat === "undefined" || !ChatFloat) return false;
      let item = null;
      if (got.doc) item = mem.itemForDocKey(got.doc.key);
      if (item && ChatFloat.setSessionItem) ChatFloat.setSessionItem(item);
      // 清内存会话，避免 show() 自动恢复的另一场与被点开的这场混在一起
      const s = ChatFloat.session;
      if (s) { s.history = []; s.contextItems = []; s.sid = ""; }
      if (ChatFloat.show) ChatFloat.show();
      const win = Zotero.getMainWindow();
      const entry = (ChatFloat._wins && ChatFloat._wins.get) ? ChatFloat._wins.get(win) : null;
      const ok = ChatFloat._applySession({ session: ses }, entry || null);
      if (!ok) return false;
      this._closeViewer();
      try {
        if (!item && entry && ChatFloat._appendBubble) {
          ChatFloat._appendBubble(entry, "sys",
            I18n.isZh ? "原文条目已不在库中，已仅恢复对话文本" : "The source item is gone; text restored only",
            "#c0392b");
        }
      } catch (e) { /* 提示失败不影响恢复 */ }
      return true;
    } catch (e) {
      try { Zotero.logError(e); } catch (_) { /* ignore */ }
      return false;
    }
  },
};
