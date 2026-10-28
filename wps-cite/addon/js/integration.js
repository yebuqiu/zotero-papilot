// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Zotero 集成协议客户端：让 WPS 里的三个按钮驱动 **Zotero 原生**的插入引文 / 文献表 / 刷新。
 *
 * 协议（逆向 xpcom/httpIntegrationClient.js + 实测确认，见 docs/DESIGN.md §5.5）：
 *   反向 RPC —— 我们 POST /connector/document/execCommand，Zotero 把"下一条要执行的命令"
 *   当作 HTTP 响应下发；我们执行后 POST /connector/document/respond 回结果；
 *   循环直到收到 Document.complete。
 *
 * 关键契约（实测撞出来的，别改）：
 *   - getActiveDocument 返回 { documentID, outputFormat, processorName, …能力位 }；
 *     key 必须是 documentID（写成 docId 会让后续所有 docId 变 null）
 *   - canInsertField 必须返回 true
 *   - insertField 返回 { id }（Field 构造取 retVal.id，裸数字会变 null）
 *   - getDocumentData 返回字符串（空=falsy 时 Zotero 会先弹「文档首选项」）
 *   - 事务有状态：中途断线会让 Zotero 卡在 inProgress（之后的请求全 503），重启 Zotero 解除
 *
 * Field 用 WPS 的 ADDIN 域承载（wdFieldAddin=81），与官方 Word 插件同构，
 * 因此「双向链接」的域解析（zfields.js）对这里插入的引文同样生效。
 */
(function (root) {
  "use strict";

  /* ★ 惰性取用 WPS 适配层（别改回顶层解构）。
   * 踩过的坑：这里原本写 `const Doc = root.PPDoc;`，而 index.html 里本文件排在
   * doc.js 之前执行——那一刻 root.PPDoc 还不存在，Doc 就永远是 undefined，
   * 于是第一次点「插入引文」直接抛
   *     Cannot read properties of undefined (reading 'doc')
   * 修法两道保险：① index.html 把本文件排到 doc.js 之后；② 这里按需取用并给出人话报错。
   */
  function D() {
    const d = root.PPDoc;
    if (!d) throw new Error("内部错误：文档适配层未就绪（doc.js 未加载或加载顺序错误）");
    return d;
  }
  // 维持原来的调用写法（Doc.doc() / Doc.app() / Doc.meta()），只是把取值推到调用时
  const Doc = {
    doc: function () { return D().doc(); },
    app: function () { return D().app(); },
    meta: function (k, v) { return v === undefined ? D().meta(k) : D().meta(k, v); },
    scanFields: function () { return D().scanFields(); },
    scanFieldRefs: function () { return D().scanFieldRefs(Doc.doc()); },
    documentID: function () { return D().documentID(Doc.doc()); },
  };
  // 注意：不能直连 23119——Zotero 本地服务不带 CORS 头，file:// 页面的 fetch 会被拦（Failed to fetch）。
  // 必须经代理（代理补 Access-Control-Allow-Origin，见 proxy.py 的 /zit 路由）。
  const BASE = "http://127.0.0.1:21932/zit";
  const WD_FIELD_ADDIN = 81;
  const WD_FIELD_EMPTY = -1;
  // Word/WPS 的单个自定义文档属性常见 255 字符上限；分段保存 Zotero 会话数据。
  const DOC_DATA_KEY = "ZoteroDocData";
  const DOC_DATA_PARTS_KEY = "ZoteroDocDataParts";
  const DOC_DATA_CHUNK = 240;

  const DOC_ID = "papilot-wps-doc";
  /* 超时口径（很重要，别随手调小）：
   * Zotero 的 execCommand/respond 是长轮询——它把"下一条要执行的命令"当 HTTP 响应下发，
   * 期间可能一直在等用户在它自己的对话框里挑文献。给短了就会断链，而断链的后果是
   * Zotero 侧事务永远停在 inProgress，之后所有请求 503，只能重启 Zotero。 */
  const LONG = 1800000;           // 30 分钟：等用户操作
  const SHORT = 30000;            // 收尾/错误通道
  /* 单事务命令数上限（原来是硬编码 200，是个纯粹的 bug）。
   * 一条要更新的引文 ≈ 2 条命令（Field.setCode + Field.setText），固定开销约 8~10 条，
   * 所以 ≈95 条引文的文档一刷新就撞上限，报"步数超限或链路中断"——学位论文正是目标场景，
   * 等于让功能不可用。5000 条命令在本地也就几秒，真撞上了才是真异常（链路死循环）。 */
  const MAX_STEPS = 5000;

  /* Zotero.Integration.Interface.prototype 上真实存在的命令（integration.js:708-1013）。
   * 名字写错 → Zotero 抛 TypeError → 连 document.complete() 都执行不到 →
   * inProgress 永久为 true，之后所有请求 503，只能重启 Zotero。别再"猜"名字。 */
  const KNOWN_COMMANDS = {
    addCitation: 1, editCitation: 1, addEditCitation: 1,
    addNote: 1, addAnnotation: 1,
    addBibliography: 1, editBibliography: 1, addEditBibliography: 1,
    citationExplorer: 1, refresh: 1, removeCodes: 1, setDocPrefs: 1, exportDocument: 1,
  };
  /* 插入类命令（会写正文文本）：只有它们才用"没写过文本 = 用户点 X 取消"来判定。
   * refresh / removeCodes / setDocPrefs 在内容无变化时本来就不写文本，不能当取消。 */
  const INSERT_COMMANDS = {
    addCitation: 1, editCitation: 1, addEditCitation: 1,
    addBibliography: 1, editBibliography: 1, addEditBibliography: 1,
    addNote: 1, addAnnotation: 1,
  };
  /* ★ 只有**引注类**命令才存在"用户点 X 取消"这回事（Zotero 会弹那个能取消的对话框）。
   *   文献表命令是自动执行的，没有对话框可取消；它"没写文本"只有一个原因：
   *   当前没有引文/文献表本来就是空的 —— 那是正常结果，不是取消。
   *   曾经把它算进"取消"：第一次插入文献表时域被判空表 removeCode → 没写文本 →
   *   我们回 cancelled → 界面什么都不提示，用户看到的就是"点了没反应"。 */
  const CANCEL_ASKS = { addCitation: 1, editCitation: 1, addEditCitation: 1 };
  /* 第一条命令（Application.getActiveDocument）应当秒回。原来是拿 LONG(30 分钟) 等，
   * 于是"命令名写错"这类 Zotero 侧静默失败表现为"点了没反应"，半小时都不报错。 */
  const FIRST_WAIT = 90000;

  const fieldMap = new Map();     // id → { field, key }
  const keyMap = new Map();       // 稳定身份 → id（详见 fieldIdentity）
  let nextId = 1;

  /* ---------- Zotero 的 HTML → WPS 富文本 ----------
   * citeproc 在 outputFormat:"html" 下给的是 `<sup>[1]</sup>`、`<i>Nature</i>`、
   * `<span style="font-variant:small-caps">…</span>` 这样的片段。
   * 官方 Word 插件靠剪贴板粘贴让 Word 自己换成格式；WPS 没有这条路，
   * 所以这里解析成 run 列表，写入文本后按字符区间补格式。
   * 不解析的后果就是把标签当文字塞进域里，用户看到的是
   *   【<sup>[1,1,2,2,3,3–5]</sup>】
   */
  function decodeEntities(s) {
    return String(s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, function (m, body) {
      if (body.charAt(0) === "#") {
        const hex = body.charAt(1) === "x" || body.charAt(1) === "X";
        const n = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
        return isFinite(n) && n >= 0 ? String.fromCodePoint(n) : m;
      }
      const map = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };
      return map[body] !== undefined ? map[body] : m;
    });
  }

  /* 手写扫描而不是用 DOMParser：这段逻辑要在 Node 里也能被单测覆盖，
   * 而 citeproc 的 HTML 只有 sup/sub/i/b/span[style] 和少量块级元素，自己扫更可控。
   * 块级元素必须换成换行——文献表是 <div class="csl-entry"> 一行一条，
   * 不处理的话整张表会被挤成一整行。
   *
   * ★ 但 second-field-align 的样式（GB/T 7714、Nature 等数字制）长这样：
   *     <div class="csl-entry">
   *       <div class="csl-left-margin">[1]</div><div class="csl-right-inline">作者. 题名[J]…</div>
   *     </div>
   *   这**两个 div 是同一行的左右两半**（官方 Word 插件在这里放一个制表符 + 悬挂缩进）。
   *   把它们也当块级 → 每个 [1] 独占一行、正文折到下一行，就是用户看到的
   *   "[1]↵刘广运, 白莉…" 那种排版。所以这两个 class 要按行内处理。 */
  const HTML_BLOCK = {
    div: 1, p: 1, li: 1, tr: 1, blockquote: 1,
    h1: 1, h2: 1, h3: 1, h4: 1, h5: 1, h6: 1,
  };
  /** 行内的"假 div"：citeproc 用它们做左右分栏，实际不该断行 */
  function inlineDivKind(cls) {
    const c = String(cls || "").toLowerCase();
    if (c.indexOf("csl-left-margin") >= 0) return "left";
    if (c.indexOf("csl-right-inline") >= 0) return "right";
    if (c.indexOf("csl-indent") >= 0) return "block";     // 缩进块，确实换行
    return "";
  }
  function htmlToRuns(html) {
    const s = String(html == null ? "" : html);
    if (!s) return [];
    const base = { sup: false, sub: false, italic: false, bold: false, smallcaps: false };
    const runs = [];
    const stack = [Object.assign({}, base)];
    function pushText(t, st) {
      if (!t) return;
      runs.push(Object.assign({}, st, { text: t }));
    }
    function newline(st) {
      const last = runs.length ? runs[runs.length - 1].text : "\n";
      if (!/\n$/.test(last)) pushText("\n", st);
    }
    /** 行内分隔（[1] 与正文之间）：前一个字符已经是空白就不再加 */
    function space(st) {
      const last = runs.length ? runs[runs.length - 1].text : "";
      const tail = last.slice(-1);
      if (!tail || /[\s\u00a0]/.test(tail)) return;
      pushText(" ", st);
    }
    const re = /<!--[\s\S]*?-->|<\/([a-zA-Z][a-zA-Z0-9]*)\s*>|<([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>|([^<]+)/g;
    let m;
    while ((m = re.exec(s)) !== null) {
      if (m[1]) {                                    // 闭合标签
        const tag = m[1].toLowerCase();
        const cur = stack.length > 1 ? stack.pop() : stack[0];
        if (cur.__kind === "left") space(cur);       // [1] 之后补一个空格，跟正文同行
        else if (HTML_BLOCK[tag] && cur.__kind !== "right") newline(cur);
      } else if (m[2]) {                             // 开标签
        const tag = m[2].toLowerCase();
        const attrs = m[3] || "";
        const cur = Object.assign({}, stack[stack.length - 1]);
        if (tag === "sup") cur.sup = true;
        if (tag === "sub") cur.sub = true;
        if (tag === "i" || tag === "em") cur.italic = true;
        if (tag === "b" || tag === "strong") cur.bold = true;
        let css = "";
        const sm = /style\s*=\s*("([^"]*)"|'([^']*)')/i.exec(attrs);
        if (sm) css = String(sm[2] !== undefined ? sm[2] : sm[3]).toLowerCase().replace(/\s+/g, "");
        if (css.indexOf("font-variant:small-caps") >= 0) cur.smallcaps = true;
        if (css.indexOf("font-style:italic") >= 0) cur.italic = true;
        if (css.indexOf("font-weight:bold") >= 0 || css.indexOf("font-weight:700") >= 0) cur.bold = true;
        if (css.indexOf("vertical-align:super") >= 0) cur.sup = true;
        if (css.indexOf("vertical-align:sub") >= 0) cur.sub = true;
        const cm = /class\s*=\s*("([^"]*)"|'([^']*)')/i.exec(attrs);
        const kind = inlineDivKind(cm ? String(cm[2] !== undefined ? cm[2] : cm[3]) : "");
        if (kind) cur.__kind = kind;
        if (tag === "br") pushText("\n", cur);
        else if (HTML_BLOCK[tag] && kind !== "left" && kind !== "right") { newline(cur); stack.push(cur); }
        else stack.push(cur);
      } else if (m[4]) {                             // 文本
        const raw = decodeEntities(m[4]);
        /* citeproc 的 HTML 是格式化过的：块级标签之间有大量缩进换行。
         * 这些空白不是内容，留着会在文献表里堆出空行与前导空格；
         * 但行内元素之间**单个空格**是有意义的（`<i>a</i> <i>b</i>`），要保留。 */
        if (/^[ \t\r\n\u00a0]*$/.test(raw)) {
          if (/[\r\n\t]/.test(raw)) continue;        // 纯缩进 → 丢掉
          if (/^ +$/.test(raw) && raw.length > 1) { pushText(" ", stack[stack.length - 1]); continue; }
        }
        pushText(raw, stack[stack.length - 1]);
      }
    }
    while (runs.length && /^\n*$/.test(runs[runs.length - 1].text)) runs.pop();  // 去尾部空行
    // 去前导空行/空格：csl-bib-body 开标签会先产生一个换行
    while (runs.length && /^[\s\u00a0]+$/.test(runs[0].text)) runs.shift();
    if (runs.length) {
      runs[0] = Object.assign({}, runs[0], { text: runs[0].text.replace(/^[\s\u00a0]+/, "") });
      if (!runs[0].text) runs.shift();
    }
    return runs;
  }

  /* WPS 的 Range.Text 可把 \n 规范化为 \r（段落标记），这不属于内容写坏。
   * 只统一换行，不放宽空格、NBSP、标点或正文，避免把真实截断/漏写误判为成功。 */
  function normalizeFieldText(value) { return String(value == null ? "" : value).replace(/\r\n?/g, "\n"); }
  function fieldTextEqual(actual, expected) { return normalizeFieldText(actual) === normalizeFieldText(expected); }

  /** 把 run 列表写进域结果（先文本，再按绝对字符区间补格式）；返回写入的纯文本 */
  function writeRuns(field, runs, d) {
    const plain = runs.map(function (r) { return r.text; }).join("");
    try {
      field.Result.Text = plain === "" ? " " : plain;
    } catch (e) {
      // ★ 不能静默回 plain：上层靠 txn.wroteText 判"插入 vs 用户取消"，
      //   写失败却回 plain 会把一次失败误判成"插入成功"，最后文档里什么都没有
      //   界面却显示"已插入"。这里留痕并回空串，让上层走失败/取消分支。
      log("writeRuns 写文本失败", { err: String((e && e.message) || e), len: plain.length });
      return "";
    }
    if (!d || plain === "") return plain;

    let start = -1;
    try { start = Number(field.Result.Start); } catch (e) { start = -1; }
    if (!(start >= 0)) return plain;
    // 写入后 Zotero 可能再改字号一类，先按当前起点算偏移
    let off = 0;
    for (let i = 0; i < runs.length; i++) {
      const r = runs[i];
      const n = r.text.length;
      if (n > 0 && (r.sup || r.sub || r.italic || r.bold || r.smallcaps)) {
        let rr = null;
        try { rr = d.Range(start + off, start + off + n); } catch (e) { rr = null; }
        if (rr && rr.Font) {
          if (r.sup) { try { rr.Font.Superscript = true; } catch (e) { /* 不支持就退化成普通文字 */ } }
          if (r.sub) { try { rr.Font.Subscript = true; } catch (e) { /* 同上 */ } }
          if (r.italic) { try { rr.Font.Italic = true; } catch (e) { /* 同上 */ } }
          if (r.bold) { try { rr.Font.Bold = true; } catch (e) { /* 同上 */ } }
          if (r.smallcaps) { try { rr.Font.SmallCaps = true; } catch (e) { /* 同上 */ } }
        }
      }
      off += n;
    }
    return plain;
  }

  /* ---------- 文献表条目锚点：供正文引文 ↔ 参考文献双向跳转 ----------
   * 不把 HYPERLINK 域嵌进 Zotero 域（刷新会重写且容易破坏引文），而是在每次
   * Field.setText 后为每个 csl-entry 建普通书签。条目身份来自 citationItems.id，
   * 数字编号只作兜底；APA 等作者—年制优先按 itemData.title 匹配，歧义时不猜。 */
  function normBibText(s) {
    return String(s || "").toLowerCase().replace(/[\s\u00a0"'‘’“”.,;:!?()\[\]{}<>《》〈〉，。；：！？、·\-–—_/\\]+/g, "");
  }

  function citationItemsForBib(d) {
    const out = [], seen = new Set();
    if (!d || !root.PPZFields) return out;
    const refs = D().scanFieldRefs(d);
    for (let i = 0; i < refs.length; i++) {
      try {
        const code = String(refs[i].code || "");
        if (!/CSL_CITATION|ZOTERO_ITEM/i.test(code)) continue;
        const json = root.PPZFields.extractJSON(code);
        for (const ci of (json && json.citationItems) || []) {
          const item = root.PPZFields.idToItem(ci && ci.id);
          if (!item) continue;
          const k = item.libType + ":" + item.libId + ":" + item.key;
          if (seen.has(k)) continue;
          seen.add(k);
          item.title = String(ci.itemData && ci.itemData.title || "");
          out.push(item);
        }
      } catch (e) { /* 一条坏域不影响其他条目 */ }
    }
    return out;
  }

  function bibEntryTexts(html) {
    const s = String(html || ""), out = [];
    const re = /<div\b[^>]*class\s*=\s*(?:"[^"]*csl-entry[^"]*"|'[^']*csl-entry[^']*')[^>]*>/gi;
    const starts = [];
    let m;
    while ((m = re.exec(s)) !== null) starts.push({ head: m.index, body: re.lastIndex });
    for (let i = 0; i < starts.length; i++) {
      const end = i + 1 < starts.length ? starts[i + 1].head : s.length;
      const text = htmlToRuns(s.slice(starts[i].body, end)).map(function (r) { return r.text; }).join("");
      if (text) out.push(text);
    }
    return out;
  }

  function syncBibWithStableMap(field, html, plain, d, texts, styleID) {
    const scan = root.PPFieldScanner.scan(d);
    const settings = root.PPSettings ? root.PPSettings.get(root.PPDoc.documentID(d)) : { bibliographyMap: {} };
    const records = texts.map(function (text) { return { text: text }; });
    // 支持 citeproc/宿主提供可验证条目级 URI 的场景；普通 HTML 不做虚假 ID 推断。
    const entryRe = /<div\b[^>]*class\s*=\s*(?:"[^"]*csl-entry[^"]*"|'[^']*csl-entry[^']*')[^>]*>/gi;
    let match, index = 0;
    while ((match = entryRe.exec(String(html || ""))) !== null && index < records.length) {
      const id = /(?:data-item-id|data-item-uri|data-csl-item-id)\s*=\s*["']([^"']+)["']/i.exec(match[0]);
      if (id) records[index].id = id[1];
      index++;
    }
    const citationOrderNumeric = /ieee|nature|vancouver|china-national-standard-gb-t-7714-2015-numeric|gb-t-7714-2015-numeric/i.test(styleID);
    const result = root.PPBibliographyMap.rebuild(scan, records, { previous: settings.bibliographyMap || {}, citationOrderNumeric: citationOrderNumeric });
    let cursor = 0;
    result.entries.forEach(function (entry) {
      const at = plain.indexOf(entry.text, cursor);
      if (at >= 0) { entry.start = at; entry.end = at + entry.text.length; cursor = entry.end; }
      else { entry.start = -1; entry.end = -1; }
    });
    const valid = result.entries.filter(function (entry) { return entry.start >= 0; });
    const replaced = D().replaceBibBookmarks(field, valid);
    if (root.PPSettings) root.PPSettings.set(root.PPDoc.documentID(d), { bibliographyMap: result.persistent });
    log("稳定文献表映射", { entries: texts.length, mapped: replaced.mapped, ambiguous: result.issues.length });
    return result;
  }

  function syncBibBookmarks(field, html, plain, d) {
    if (!d || typeof D().replaceBibBookmarks !== "function") return;
    const items = citationItemsForBib(d);
    const texts = bibEntryTexts(html);
    const entries = [], used = new Set();
    let styleID = "";
    try { styleID = String((JSON.parse(readDocData() || "{}").style || {}).styleID || ""); } catch (e) { styleID = ""; }
    // 只有明确的“按首次引用编号”样式可用序号兜底；排序数字制不能猜。
    const citationOrderNumeric = /ieee|nature|vancouver|china-national-standard-gb-t-7714-2015-numeric|gb-t-7714-2015-numeric/i.test(styleID);
    if (root.PPBibliographyMap && root.PPFieldScanner) {
      return syncBibWithStableMap(field, html, plain, d, texts, styleID);
    }
    let cursor = 0;
    function itemKey(it) { return it.libType + ":" + it.libId + ":" + it.key; }
    for (let i = 0; i < texts.length; i++) {
      const text = texts[i];
      const at = plain.indexOf(text, cursor);
      if (at < 0) continue;
      cursor = at + text.length;
      const hay = normBibText(text);
      let candidates = items.filter(function (it) {
        const title = normBibText(it.title);
        return title && hay.indexOf(title) >= 0 && !used.has(itemKey(it));
      });
      // 标题匹配优先；数字制只有无法按标题识别时才按首次引用顺序兜底。
      if (candidates.length === 0 && citationOrderNumeric) {
        const num = /^\s*\[(\d+)\]/.exec(text);
        if (num) {
          const byNumber = items[Number(num[1]) - 1];
          if (byNumber && !used.has(itemKey(byNumber))) candidates = [byNumber];
        }
      }
      if (candidates.length !== 1 && texts.length === 1 && items.length === 1) candidates = [items[0]];
      if (candidates.length !== 1) continue;  // 同题或无法识别时宁可不跳，也不跳错
      const item = candidates[0];
      used.add(itemKey(item));
      entries.push({ item: item, start: at, end: at + text.length });
    }
    try {
      const r = D().replaceBibBookmarks(field, entries);
      log("文献表跳转锚点", { entries: texts.length, citedItems: items.length, mapped: r.mapped, failed: r.failed });
    } catch (e) {
      log("文献表跳转锚点不可用", { err: String((e && e.message) || e) });
    }
  }

  /* 域身份：必须跨 getFields 调用保持稳定。
   * 原因（踩过）：Zotero 的 Field.equals() 比的是 `_id`。我们原来用 COM 对象引用判断，
   * 而 WPS 每次 Fields.Item(i) 都可能返回新的包装对象，`===` 永远 false，
   * 于是同一个域每次扫描都被当成新域 → Zotero 认为引文重复 → 渲染成 [1,1,2,2,3,3–5]。
   * 改成用域代码里的 citationID（CSL_CITATION 自带，跨刷新不变），文献表域退化为位置。 */
  function fieldIdentity(f) {
    let code = "";
    try { code = String(f.Code.Text || ""); } catch (e) { code = ""; }
    const m = /citationID[^A-Za-z0-9]{0,4}([A-Za-z0-9_\-]{6,})/.exec(code);
    if (m) return "cid:" + m[1];
    let pos = "";
    try { pos = String(f.Result.Start); } catch (e) { pos = ""; }
    return "pos:" + pos + "|" + code.replace(/\s+/g, "").slice(0, 24);
  }

  /* ---------- 域代码的两种方言 ----------
   * Zotero 内部（integration.js:2950）用 LibreOffice 风格：
   *     ITEM CSL_CITATION {json}      /  BIBL {json} CSL_BIBLIOGRAPHY
   * 并且靠**代码开头**判类型（integration.js:3013 loadExisting）：
   *     ITEM / CITATION → 引文域；BIBL → 文献表域；其他 → 普通域（等于不认）
   * 而落地到 Word 时是：
   *     ADDIN ZOTERO_ITEM CSL_CITATION {json}  /  ADDIN ZOTERO_BIBL {json} CSL_BIBLIOGRAPHY
   * 官方 Word 插件在这两种之间做转换；HTTP 协议下这活儿归我们，而且两头都要顾：
   *   - 写进文档 → 用 Word 方言：换到 Word 里 Zotero 认得出，我们的双向链接也能解析
   *   - 读回给 Zotero → 用内部方言：否则 loadExisting 判不出类型，会被当普通域忽略
   */
  function toWordCode(code) {
    const s = String(code == null ? "" : code);
    let m = /^ITEM\s+CSL_CITATION\s*/i.exec(s);
    if (m) return "ADDIN ZOTERO_ITEM CSL_CITATION " + s.slice(m[0].length);
    m = /^CITATION\s+CSL_CITATION\s*/i.exec(s);
    if (m) return "ADDIN ZOTERO_ITEM CSL_CITATION " + s.slice(m[0].length);
    m = /^BIBL\s+/i.exec(s);
    if (m) return "ADDIN ZOTERO_BIBL " + s.slice(m[0].length);
    return s;
  }

  function toZoteroCode(code) {
    const s = String(code == null ? "" : code);
    let m = /^\s*ADDIN\s+ZOTERO_ITEM\s+CSL_CITATION\s*/i.exec(s);
    if (m) return "ITEM CSL_CITATION " + s.slice(m[0].length);
    m = /^\s*ADDIN\s+ZOTERO_BIBL\s*/i.exec(s);
    if (m) return "BIBL " + s.slice(m[0].length);
    return s;
  }

  /* 当前事务的旁路状态。事务由 busy 锁串行，所以一个模块级对象就够。
   * wroteText：这次事务有没有真的往文档里写过内容。
   * 用户在 Zotero 对话框里点 X 取消时，序列是
   *   insertField → setCode("TEMP") → Field.delete → setDocumentData → activate → complete
   * 全程没有 setText，据此判定"取消"，免得外面还去同步台账、弹"本文档还没有引文"。 */
  let txn = { wroteText: false, backup: null, committed: false };

  function recovery() { return root.PPRecovery || null; }
  function scanForRecovery() {
    if (root.PPFieldScanner) return root.PPFieldScanner.scan(Doc.doc());
    const all = Doc.scanFieldRefs().filter(function (r) { return !!r.field; }).map(function (r) {
      return { fieldID: "raw:" + r.container + ":" + r.noteIndex + ":" + r.index + ":" + r.start, code: r.code, text: r.text, container: r.container, noteIndex: r.noteIndex, noteID: r.noteID, field: r.field, bookmarks: r.bookmarks || [] };
    });
    return { all: all };
  }
  function beginRecovery(command) {
    const R = recovery();
    if (!R) return null;
    const documentID = Doc.documentID(), scan = scanForRecovery();
    const backup = R.begin(documentID, scan, readDocData());
    txn.backup = backup;
    R.stage(backup, "command", "begin", { command: command });
    return backup;
  }
  function touchField(id, isNew) {
    const R = recovery();
    if (!R || !txn.backup) return;
    const e = fieldMap.get(id);
    if (!e) return;
    if (isNew || e.isNew) {
      R.snapshotTouched(txn.backup, { id: id, field: e.field, note: e.note }, true);
      return;
    }
    let old = txn.backup.fields.find(function (f) { return f.field === e.field; });
    if (!old && e.key) {
      old = txn.backup.fields.find(function (f) {
        return String(f.fieldID) + "@" + f.container + ":" + String(f.noteID) === String(e.key);
      });
    }
    if (!old) {
      // COM 包装对象不能按 === 比较；用容器、citationID 与位置回配同一物理域。
      let start = -1;
      try { start = Number(e.field.Result.Start); } catch (err) { start = -1; }
      old = txn.backup.fields.find(function (f) {
        let oldStart = -2;
        try { oldStart = Number(f.field.Result.Start); } catch (err) { oldStart = -2; }
        return f.container === (e.container || "body") && String(f.noteID) === String(e.noteID || null) && start >= 0 && oldStart === start;
      });
    }
    if (old) R.snapshotTouched(txn.backup, old, false);
  }
  function touchDocData() { if (recovery() && txn.backup) recovery().touchDocumentData(txn.backup); }
  function commitRecovery(command, result) {
    const R = recovery();
    if (!R || !txn.backup || txn.committed) return;
    R.stage(txn.backup, "complete", "complete", { command: command, changed: !!txn.wroteText, cancelled: !!(result && result.cancelled) });
    R.commit(txn.backup); txn.committed = true;
  }

  function log(msg, extra) {
    try {
      fetch("http://127.0.0.1:21932/log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ msg: "ITG " + msg, extra: extra || null }),
      });
    } catch (e) { /* 日志失败不影响 */ }
  }

  async function post(path, payload, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs || LONG);
    try {
      const res = await fetch(BASE + path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload === undefined ? null : payload),
        signal: ctrl.signal,
      });
      const text = await res.text();
      if (!res.ok) throw new Error("HTTP " + res.status + " " + text.slice(0, 80));
      return text.trim().startsWith("{") ? JSON.parse(text) : null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** 上一次成功读到的插入点（Selection 取不到时靠它兜底） */
  let lastPos = -1;

  /**
   * 让 Zotero 弹出的「添加引注」浮窗浮到最前。
   * 引注框是 Zotero 自己的窗口，加载项（浏览器页）碰不到操作系统窗口层级，
   * 只能让代理进程代劳（代理会轮询最多 15 秒等窗口出现）。
   * **必须在事务开始之前调用**：事务循环里每多发一个请求，都可能被当成一次 respond；
   * 而且 fire-and-forget 也不会拖慢插入。失败一律静默。
   */
  function raiseWindow() {
    try {
      fetch("http://127.0.0.1:21932/raise", { method: "POST" })
        .then(function (r) { return r.text(); })
        .then(function (t) { log("raise", { r: String(t || "").slice(0, 200) }); })
        .catch(function () { /* 置顶失败无妨 */ });
    } catch (e) { /* 忽略 */ }
  }

  /**
   * 取插入点。
   *
   * ★ Collapse 的方向常量：**wdCollapseEnd = 0，wdCollapseStart = 1**
   *   （Microsoft Learn / MSDN ff195290 的 WdCollapseDirection 原文就是
   *    "wdCollapseEnd 0 … wdCollapseStart 1"；默认参数是 1，所以不传方向时折到开头）。
   *   这跟我最初凭印象以为的相反 —— 一度把这里的 `Collapse(0)` 改成 `Collapse(1)`，
   *   差点把「退化到文末」改成「退化到文首」。现在**不依赖常量**：
   *   直接取 `Content.End` 造一个空 Range，哪种枚举顺序都对。
   *
   * 兜底顺序：Selection → 上次记住的插入点（夹在有效范围内）→ 文末。
   *   每次走兜底都打一条 ★ 日志：真机上「位置不对」时，先看日志有没有这条，
   *   有就是这里退化，没有就不是定位的锅。
   */
  function selRange() {
    const d = Doc.doc();
    let r = null;
    try {
      const s = Doc.app().Selection;
      if (s && s.Range) r = s.Range;
    } catch (e) {
      r = null;
    }
    if (r) {
      try {
        const p = Number(r.Start);
        if (isFinite(p) && p >= 0) lastPos = p;
      } catch (e) { /* 读不到位置不影响插入 */ }
      return r;
    }

    if (lastPos >= 0) {
      try {
        const end = Number(d.Content.End) || 0;
        const p = Math.max(0, Math.min(lastPos, end));
        log("★ 取不到选区，退化到上次插入点", { pos: p, end: end });
        return d.Range(p, p);
      } catch (e) { /* 继续往下兜底 */ }
    }

    log("★ 取不到选区，退化到文末（用 Content.End 造空 Range，不依赖 Collapse 常量）");
    try {
      const end = Number(d.Content.End) || 0;
      return d.Range(end, end);
    } catch (e) { /* Range() 都不可用就退回老写法 */ }
    r = d.Content;
    try { r.Collapse(0); } catch (e) { /* 0 = wdCollapseEnd */ }
    return r;
  }

  /**
   * 位置 pos 是否落在某个已有域的结果区**内部**。
   * 边界取 [start, end)：光标紧跟在引文后面时 pos === end，**不算**在域内——
   * 否则每插一条引文都会并进上一条，用户会发现"插了没反应"。
   */
  function fieldSpanAt(pos, d) {
    const p = Number(pos);
    if (!(p >= 0) || !d) return null;
    let fields;
    try { fields = d.Fields; } catch (e) { return null; }
    const n = Number(fields && fields.Count) || 0;
    for (let i = 1; i <= n; i++) {
      let s = -1, e = -1;
      try {
        const f = fields.Item(i);
        s = Number(f.Result.Start);
        e = Number(f.Result.End);
      } catch (err) { continue; }
      if (!(s >= 0) || !(e > s)) continue;
      if (p >= s && p < e) return { index: i, start: s, end: e };
    }
    return null;
  }

  async function handle(cmd, args) {
    // 文档对象取不到不该让整条命令炸掉：Application.* 这类命令本来就与具体文档无关
    let d = null;
    try { d = Doc.doc(); } catch (e) { d = null; }

    switch (cmd) {

      case "Application.getActiveDocument": {
        let supportedNotes = ["footnotes", "endnotes"];
        if (root.PPCapabilities && d) {
          const caps = root.PPCapabilities.get(Doc.documentID(), d);
          supportedNotes = [];
          if (caps.footnoteAdd) supportedNotes.push("footnotes");
          if (caps.endnoteAdd) supportedNotes.push("endnotes");
        }
        // ★ 这里**绝对不能抛错**。Zotero 拿不到合法 documentID 就没有 document 对象，
        //   它 execCommand 的 finally（唯一会复位 inProgress 的地方）就调不到 complete()，
        //   结果是 Zotero 永久卡在 inProgress，之后点什么都 503，只能重启 Zotero。
        //   真没文档的话，让后面的命令去失败——那时 document 已存在，错误能正常收尾。
        return {
          documentID: DOC_ID,
          outputFormat: "html",
          processorName: "Papilot Cite for WPS",
          supportsCitationMerging: true,
          supportsTextInsertion: true,
          supportsImportExport: false,
          /* ★ 必须用 Zotero 的**复数**枚举，别"纠正"成单数。
           * 这个数组会原样塞进「文档首选项」对话框的 io.supportedNotes
           * （integration.js:2036）决定脚注/尾注选项是否出现；Zotero 自己的
           * HTTP 客户端默认值就是 ['footnotes']（httpIntegrationClient.js:62）。
           * 写成单数（footnote/endnote）与 Zotero 的枚举对不上，
           * 轻则该选项消失、重则选错注文制。 */
          supportedNotes: supportedNotes,
        };
      }

      case "Document.getDocumentData": {
        // 返回空字符串时 Zotero 会先弹「文档首选项」——正是我们要的第一次体验。
        // 长数据自动读取分段，兼容旧版单属性文档。
        const d2 = readDocData();
        log("getDocumentData", { len: d2.length });
        return d2;
      }

      case "Document.setDocumentData": {
        const data = String(args[1] || "");
        const old = readDocData();
        touchDocData();
        writeDocDataChecked(data, old);
        log("setDocumentData", { want: data.length, got: readDocData().length, ok: true });
        return true;
      }

      case "Document.canInsertField":
        return true;

      case "Document.cursorInField": {
        /* 官方「添加/编辑引注」靠这条命令决定**编辑光标处那条**还是新建一条
         * （integration.js:740 addEditCitation → `_doc.cursorInField(fieldType)`）。
         * 原来恒 false，于是点插入永远新建；配合没有任何防嵌域处理，就出现了
         * 真机日志里那条 "[1[5,5–7]–4]"（新引注嵌进旧引注、把旧引注的显示撕开）。
         *
         * 返回结构必须和 getFields 的单项完全一致：客户端 `new Field(documentID, retVal)`
         * 之后 `getCode()` **直接读缓存 _code，不回环查询**（httpIntegrationClient.js:197），
         * 所以 code 必须是真的域代码，否则 Zotero 拿着空 code 去 unserialize 会毁掉这条引注。 */
        if (!d) return false;
        let pos = -1;
        try { pos = Number(Doc.app().Selection.Range.Start); } catch (e) { pos = -1; }
        if (!(pos >= 0)) return false;
        const refs = Doc.scanFieldRefs().filter(function (r) { return !!r.field; });
        const all = await handle("Document.getFields", [args[0], args[1]]);
        for (let i = 0; i < refs.length; i++) {
          const raw = refs[i];
          if (!(pos >= raw.start && pos < raw.end)) continue;
          const result = all[i];
          if (!result || !/CSL_CITATION|CSL_BIBLIOGRAPHY|ZOTERO_ITEM|ZOTERO_BIBL/i.test(result.code)) continue;
          log("cursorInField", { pos: pos, id: result.id, codeLen: result.code.length, noteIndex: result.noteIndex });
          return result;
        }
        return false;
      }

      case "Document.insertField": {
        /* args = [docId, fieldType, noteType]；noteType: 0=正文 1=脚注 2=尾注。
         * ★ 脚注/尾注必须把域写进**脚注正文**里，不能留在正文——否则编号与脚注序号
         *   全错，而用户只会看到"引文跑到段落里了"。
         *   WPS jsapi 的 Footnotes/Endnotes 与 Word 同构但没有离线文档可查，所以这里是
         *   "试一次，不成就明确报错"：宁可在这一步停住并说清原因，也不要静默写错位置。
         *   （这一步失败会在 Zotero 侧弹 alert，事务照常收尾，文档不会留半个域。） */
        const noteType = Number(args[2]) || 0;
        let r = selRange();
        let noteIndex = 0;
        let made = null;
        /* ★ 插入点若落在**已有域的结果区里**，绝不能就地建域：Word/WPS 会把新域嵌进旧域，
         *   旧域的显示文本被撕裂成 "[1[5,5–7]–4]" 这种（真机日志实拍：原文 [1–4] → 修改
         *   [1[5,5–7]–4]），Zotero 随后还会弹「您做了修改，要保留吗」。
         *   处理：把插入点挪到该域之后——语义上等于"紧跟在这条引文后面另起一条"，
         *   老域一个字符都不动，也就不会再触发那条告警。 */
        try {
          const pos = Number(r.Start);
          const hit = fieldSpanAt(pos, d);
          if (hit) {
            log("★ 插入点在已有域内，改插到该域之后", { pos: pos, from: hit.start, to: hit.end });
            r = d.Range(hit.end, hit.end);
          }
        } catch (e) { /* 定位失败就按原样插入 */ }
        try {
          made = D().insertNativeField(noteType, r);
        } catch (e) {
          const label = noteType === 1 ? "脚注" : noteType === 2 ? "尾注" : "正文";
          throw new Error("无法在" + label + "建立引文域：" + String((e && e.message) || e) + "。本次空注/半域已回滚，未写入正文兜底。");
        }
        const f = made.field;
        if (!f) throw new Error("Fields.Add 返回空域，本次注已回滚");
        noteIndex = Number(made.noteIndex) || 0;
        const id = nextId++;
        fieldMap.set(id, { field: f, key: fieldIdentity(f), id: id, isNew: true, note: made.note, container: made.container, noteIndex: noteIndex, noteID: made.noteID });
        touchField(id, true);
        /* ★ text 必须给一个**非空**占位（零宽空格），不能是 ""。
         *   客户端 `Field.getText()` 返回的是构造时缓存的 _text，**不回环问文档**
         *   （httpIntegrationClient.js:186-188）。而 Zotero 在汇总文档时有这么一段
         *   （integration.js:1226）：
         *       if (this.ignoreEmptyBibliography && (await field.getText()).trim() === "") {
         *         this._removeCodeFields[i] = true;      // 随后 removeCode
         *       }
         *   于是"刚建好、结果还是空"的文献表域被判为空表 → removeCode → 整笔事务一个 setText
         *   都没有 → 我们又把它判成"用户取消"。
         *   真机症状就是：第一次点【插入/更新文献表】毫无反应，点第二次才成功
         *   （因为第二次那个域已经有 BIBL 代码、我们的 getFields 会给它 \u200b）。
         *   \u200b 的 trim() 不是空（U+200B 不在 ECMAScript 的 WhiteSpace 里），肉眼看不出。 */
        return { id: id, code: " ", text: "\u200b", noteIndex: noteIndex, adjacent: false };
      }

      case "Field.setCode": {
        const e = fieldMap.get(args[1]);
        const raw = String(args[2] == null ? " " : args[2]);
        const code = toWordCode(raw);          // 落盘用 Word 方言，见 toWordCode 的说明
        if (e && e.field) {
          touchField(args[1], false);
          let wrote = false;
          try {
            e.field.Code.Text = code;
            wrote = true;
          } catch (err) {
            log("setCode 失败", { err: String((err && err.message) || err) });
          }
          /* ★ 回读校验不通过就**抛错**（原来只写日志、照样回成功 = 静默损坏）。
           * WPS 若把域代码截断，Zotero 的 JSON 就残缺：文献表插不进去、刷新时
           * unserialize 失败 → 被当成新文档 → 编号从头来（就是 [1,1,2,2,3,3–5] 那个症状），
           * 而用户全程不知道发生了什么。静默损坏比报错危险得多，所以这里宁可失败：
           * 抛出去会走 runInner 的错误通道 {error:"Alert"}，事务照常收尾，用户能看到原因。 */
          let back = "";
          try { back = String(e.field.Code.Text || ""); } catch (err) { back = ""; }
          if (!wrote || back !== code) {
            log("★ setCode 回读不一致，域代码被截断", {
              want: code.length, got: back.length, wrote: wrote,
            });
            throw new Error("WPS 没能完整保存域代码（写入 " + code.length + " 字符，回读 "
              + back.length + " 字符）。再继续会让文档里的引文数据残缺、下次刷新编号错乱，"
              + "所以这里停下了。请换一个更短的样式重试，或把这个问题反馈给我们。");
          }
          /* 代码一落地，域就有了稳定身份（citationID），登记下来供后续 getFields 复用。
           * ★ 但别把 getFields 分配的 #2/#3 去重后缀覆盖掉（踩过）：
           *   两个域同 citationID（复制粘贴引文）时 scan1 给出 [1, 2]；此时对其中一个域
           *   setCode，fieldIdentity 拿到的是**裸** "cid:X"，若直接赋给 e.key 并 keyMap.set，
           *   就把 "cid:X → 域1" 覆盖成 "cid:X → 域2"，下次扫描两个域又塌回同一个 id，
           *   之后的 setText/setCode 全打到同一个物理域 —— 去重等于白做。
           *   所以：后缀只在 base 没变时保留；base 变了（换了新 citationID）才丢掉后缀。 */
          const base = fieldIdentity(e.field);
          const suffixed = /^(.*)#(\d+)$/.exec(String(e.key || ""));
          e.key = (suffixed && suffixed[1] === base) ? e.key : base;
          keyMap.set(e.key, args[1]);
        }
        log("setCode", {
          id: args[1], rawLen: raw.length, len: code.length, head: code.slice(0, 110),
        });
        return null;
      }

      case "Field.getText": {
        const e = fieldMap.get(args[1]);
        if (!e || !e.field) return "";
        try {
          return String(e.field.Result.Text || "");
        } catch (err) {
          return "";
        }
      }

      case "Field.setText": {
        const e = fieldMap.get(args[1]);
        if (!e || !e.field) return false;
        // args[2] 是 HTML（<sup>[1]</sup> 之类），必须渲染成富文本，不能当纯文字塞进去
        const runs = htmlToRuns(String(args[2] == null ? "" : args[2]));
        touchField(args[1], false);
        let plain = "";
        try {
          plain = writeRuns(e.field, runs, d);
        } catch (err) {
        log("setText 失败", { err: String((err && err.message) || err) });
        plain = "";
      }
      const expectedText = runs.map(function (r) { return r.text; }).join("");
      const actualText = String(e.field.Result && e.field.Result.Text || "");
      if ((!plain && expectedText) || !fieldTextEqual(actualText, expectedText || actualText)) {
        log("★ setText 回读不一致", { id: args[1], wantLen: expectedText.length, gotLen: actualText.length,
          wantHead: expectedText.slice(0, 100), gotHead: actualText.slice(0, 100),
          newlineNormalized: normalizeFieldText(actualText) === normalizeFieldText(expectedText) });
        throw new Error("WPS 引文显示文本写入/回读不一致，本次操作将按恢复快照回滚");
      }
        /* 文献表排版：文本落地之后再设悬挂缩进（顺序不能反——先设缩进再写文本，
         * 有些 WPS 版本会把整段格式重置掉）。只作用于文献表域，引文域跳过。 */
        try { hangingIndent(e.field); } catch (err) { /* 排版失败绝不能影响事务 */ }
        try {
          const storedCode = String(e.field.Code.Text || "");
          if (BIB_RE.test(toZoteroCode(storedCode))) syncBibBookmarks(e.field, String(args[2] || ""), plain, d);
        } catch (err) {
          log("文献表锚点刷新失败（不影响文献表本身）", { err: String((err && err.message) || err) });
        }
        log("setText", {
          id: args[1], html: String(args[2] || "").slice(0, 160),
          plain: plain.slice(0, 80), nRuns: runs.length,
        });
        if (plain) txn.wroteText = true;      // 有真实内容落进文档 → 不是取消
        return runs.length > 0;      // 非空 = 富文本，告诉 Zotero 这次是带格式的
      }

      case "Field.delete":
      case "Field.remove": {
        const e = fieldMap.get(args[1]);
        if (e && e.field) {
          touchField(args[1], false);
          try {
            e.field.Delete();
          } catch (err) { /* 已不在文档里 */ }
        }
        if (e && e.key) keyMap.delete(e.key);
        fieldMap.delete(args[1]);
        return null;
      }

      case "Field.removeCode": {
        /* ★ 绝对不能 Unlink。
         * Zotero 在 addBibliography 里会扫一遍域，判断条件是
         *   field.type == BIBLIOGRAPHY && getText().trim() === ""
         * 就把域标记成"空文献表"并调 removeCode（integration.js:1226）。
         * 而文献表域刚 insertField 时结果必然是空的，于是刚建好就被判死刑。
         * 真删/真 Unlink 的后果是文献表永远插不进来（实测）。
         * 所以这里保持域原样，只留痕。 */
        const e = fieldMap.get(args[1]);
        log("removeCode 被调用（保持域不变）", { id: args[1], hasField: !!(e && e.field) });
        return null;
      }

      case "Field.isAdjacentToNextField": {
        const adjacentEntry = fieldMap.get(args[1]);
        return !!(adjacentEntry && adjacentEntry.adjacent);
      }

      case "Field.select": {
        const e = fieldMap.get(args[1]);
        if (e && e.field) {
          try {
            e.field.Result.Select();
          } catch (err) { /* 忽略 */ }
        }
        return null;
      }

      case "Document.getFields": {
        const out = [], seenKeys = new Map();
        if (!d) return out;
        const refs = Doc.scanFieldRefs();
        refs.forEach(function (raw) {
          const f = raw.field;
          if (!f) {
            if (raw.issue && raw.container === "body") throw new Error("正文域扫描失败，已停止刷新：" + raw.issue.reason);
            return;
          }
          const code = toZoteroCode(raw.code);
          let text = raw.text;
          const key0 = fieldIdentity(f);
          const seen = (seenKeys.get(key0) || 0) + 1;
          seenKeys.set(key0, seen);
          // 同一 citationID 在不同容器也必须成为不同物理域。
          const containerKey = key0.indexOf("cid:") === 0 ? key0 + "@" + raw.container + ":" + raw.noteID : key0;
          const key = seen > 1 ? containerKey + "#" + seen : containerKey;
          let fid = keyMap.get(key);
          if (fid === undefined) { fid = nextId++; keyMap.set(key, fid); }
          const previous = fieldMap.get(fid);
          fieldMap.set(fid, { field: f, key: key, id: fid, isNew: !!(previous && previous.isNew), note: raw.note, container: raw.container, noteIndex: raw.noteIndex, noteID: raw.noteID, adjacent: !!raw.adjacent });
          if (!text && /CSL_BIBLIOGRAPHY|ZOTERO_BIBL/i.test(code)) text = "\u200b";
          out.push({ id: fid, code: code, text: text, noteIndex: Number(raw.noteIndex) || 0, adjacent: !!raw.adjacent });
        });
        log("getFields", { count: out.length, ids: out.map(function (o) { return o.id; }).join(","), codes: out.map(function (o) { return o.code.length; }).join(","), notes: out.filter(function (o) { return o.noteIndex > 0; }).length });
        return out;
      }

      case "Document.convert": {
        /* 官方契约：[docId, fieldIDs, fieldType, targetNoteTypes]。
         * args[3] 是与 fieldIDs 等长的逐域目标数组，不是域数量；不存在 args[4]。 */
        const ids = Array.isArray(args[1]) ? args[1] : [];
        const targets = Array.isArray(args[3]) ? args[3] : null;
        if (!targets || targets.length !== ids.length) throw new Error("Document.convert 的逐域目标数组与 fieldIDs 长度不一致");
        const converted = [], wanted = [];
        try {
          // 按 Zotero 下发顺序处理；每一步使用本域自己的目标注类型。
          for (let i = 0; i < ids.length; i++) {
            const entry = fieldMap.get(ids[i]);
            if (!entry || !entry.field) throw new Error("找不到待转换域 " + ids[i]);
            const targetType = Number(targets[i]);
            if (targetType !== 0 && targetType !== 1 && targetType !== 2) throw new Error("域 " + ids[i] + " 的目标注类型无效：" + String(targets[i]));
            let citationID = "";
            try { const parsed = root.PPZFields.parseField(toWordCode(entry.field.Code.Text || "")); citationID = parsed && parsed.citationID || ""; }
            catch (e) { citationID = ""; }
            if (!citationID) throw new Error("待转换域 " + ids[i] + " 缺少可用于回读映射的 citationID");
            const ref = { field: entry.field, note: entry.note, container: entry.container || "body", noteIndex: entry.noteIndex || 0, noteID: entry.noteID || null };
            touchField(ids[i], false);
            const result = D().convertOne(ref, targetType);
            const rollback = result.rollback || (result.field ? {
              field: result.field, note: result.note || null,
              container: result.container || (targetType === 1 ? "footnote" : targetType === 2 ? "endnote" : "body"),
              noteIndex: Number(result.noteIndex) || 0, noteID: result.noteID || null,
            } : null);
            if (result.changed && !rollback) throw new Error("域 " + ids[i] + " 转换后缺少可逆引用，已停止后续转换");
            converted.push({ id: ids[i], old: ref, result: result, rollback: rollback });
            wanted.push({ oldID: ids[i], citationID: citationID });
            if (result.field) {
              entry.field = result.field; entry.note = result.note || null;
              entry.container = result.container || (targetType === 1 ? "footnote" : targetType === 2 ? "endnote" : "body");
              entry.noteIndex = Number(result.noteIndex) || 0; entry.noteID = result.noteID || null;
              entry.isNew = true;
              touchField(ids[i], true);
            }
          }
          /* getFields 强制重扫所有物理域。随后按 citationID（含重复 ID 的出现次序）
           * 把原协议 ID 映射到刚扫出的新 Field 对象；Zotero 后续仍持旧 ID，
           * 绝不能让旧 Field 包装对象继续接收 setCode/setText。 */
          const after = await handle("Document.getFields", [args[0], args[2]]);
          const pools = new Map();
          after.forEach(function (field) {
            /* Document.getFields 回传 Zotero 内部方言（ITEM CSL_CITATION / BIBL ...），
             * 直接 parseField 会得到 null、池子为空、所有 citationID 都“找不到新域”。
             * 归一成 Word 方言再解析；zfields.parseField 也已直接支持内部方言。 */
            const parsed = root.PPZFields.parseField(toWordCode(field.code));
            const cid = parsed && parsed.citationID || "";
            if (!cid) return;
            if (!pools.has(cid)) pools.set(cid, []);
            pools.get(cid).push(field);
          });
          const usedNew = new Set();
          wanted.forEach(function (want) {
            const current = (pools.get(want.citationID) || []).find(function (field) { return !usedNew.has(field.id); });
            if (!current) throw new Error("转换后回读验证失败：找不到 citationID " + want.citationID + " 对应的新域");
            usedNew.add(current.id);
            const fresh = fieldMap.get(current.id);
            if (!fresh || !fresh.field) throw new Error("转换后新域映射不可用：" + want.citationID);
            keyMap.forEach(function (mappedID, key) {
              if (mappedID === want.oldID || mappedID === current.id) keyMap.delete(key);
            });
            if (current.id !== want.oldID) fieldMap.delete(current.id);
            fresh.id = want.oldID;
            fieldMap.set(want.oldID, fresh);
            keyMap.set(fresh.key, want.oldID);
          });
          return null;
        } catch (e) {
          // 已完成的逆向转换仅针对本次 converted；原生路径使用显式 rollback，
          // 快照重建路径使用目标域引用，二者都必须纳入逆序恢复。
          const restoreErrors = [];
          for (let i = converted.length - 1; i >= 0; i--) {
            const item = converted[i];
            try {
              if (item.rollback) D().convertOne(item.rollback, item.old.container === "footnote" ? 1 : item.old.container === "endnote" ? 2 : 0);
            } catch (restoreError) { restoreErrors.push(String((restoreError && restoreError.message) || restoreError)); }
          }
          const suffix = restoreErrors.length ? "；逆序恢复也未完全成功，请保留备份并撤销：" + restoreErrors.join("；") : "；本次已按逆序恢复";
          throw new Error("引文容器转换失败：" + String((e && e.message) || e) + suffix);
        }
      }

      case "Document.insertText": {
        /* args[1] 是 Zotero 的 _processNote 产出的**整段编码过的 HTML**
         * （`<html><body>见引文<a href='…?ph1'>[1]</a>&#20013;</body></html>`）。
         * 原来直接 r.Text = args[1]，用户会在正文里看到 HTML 源码和没解码的数字实体。
         * 这里复用 setText 那条路的 htmlToRuns()：去标签、解实体、块级元素转换行，
         * 落成纯文本（正文不需要 run 级格式，超链接也不该原样带过来）。 */
        const raw = String(args[1] == null ? "" : args[1]);
        let plain = "";
        if (raw.indexOf("<") < 0) {
          plain = decodeEntities(raw);                       // 纯文本：只解实体
        } else {
          const runs0 = htmlToRuns(raw.replace(/<!DOCTYPE[^>]*>/gi, "")
            .replace(/<\?xml[^>]*\?>/gi, ""));
          plain = runs0.map(function (r1) { return r1.text; }).join("");
          if (!plain) plain = decodeEntities(raw.replace(/<[^>]*>/g, ""));  // 畸形 HTML 的兜底
        }
        const r = selRange();
        try {
          r.Text = plain;
        } catch (err) {
          log("insertText 失败", { err: String((err && err.message) || err) });
        }
        log("insertText", { htmlLen: raw.length, plainLen: plain.length, head: plain.slice(0, 80) });
        return null;
      }

      case "Document.getDocument":
        if (!d) return { text: "" };
        return { text: String(d.Content.Text || "") };

      case "Document.activate":
        // ⚠ 只应答，什么都不做。绝对不要在这里调用 WPS 的窗口激活（d.Activate）。
        //
        // 原因：激活 WPS 窗口会让加载项页面（隐藏的 Chromium 内嵌页）转到后台，
        // CEF 对后台页面的 fetch 会节流甚至直接掐断；我们 respond 之后就一直等
        // 不到 Zotero 下发的 Document.complete，事务永远停在 inProgress，
        // 前端互斥锁（busy）一直被占，用户点任何按钮都提示"上一个操作还没结束"。
        //
        // 证据：C:\Users\Administrator\AppData\Roaming\PapilotCite\proxy.log 里 ITG
        // 序列每次都停在下面这一行，之后再没有 done addCitation / complete：
        //   i:10 cmd | {"i": 10, "cmd": "Document.activate"}
        // （延迟到 setTimeout 里激活同样会触发，只是把卡死往后推一点，一样不行。）
        //
        // 后来者请勿"好心"把窗口激活加回来：Zotero 只需要宿主对这个命令有个应答，
        // 并不要求真的把文档窗口拉到前台。
        return null;

      case "Document.displayAlert": {
        /* args = [docId, 消息文本, 图标, 按钮组合]；Zotero 用它报错，必须留痕才知道说了什么。
         *
         * ★ 不能恒返回 1（原来那样）。Zotero 按 buttons 解释这个数字
         *   （httpIntegrationClient.js:97-136）：
         *     buttons=0 OK            → 返回值不用
         *     buttons=1 OK_CANCEL     → 1=确定 0=取消
         *     buttons=2 YES_NO        → 1=是   0=否
         *     buttons=3 YES_NO_CANCEL → 2=是   1=否 0=取消
         * 恒回 1 的两个后果：
         *   ① _handleCommandError 对非 Alert 类错误用的是 YES_NO，index==1 就走
         *      Zotero.launchURL(supportURL) —— 任何内部异常都替用户"点是"并**打开浏览器**；
         *   ② YES_NO_CANCEL 场景（刷新超 5 秒时提议"延迟更新引文"）我们回 1 恰好等于"否"
         *      → 用户永远开不了延迟更新，还会被置 dontAskDelayCitationUpdates 以后不再问。
         * 现在按按钮组合真正问一次；问不到（环境不支持 confirm / 异常）就回 0 ——
         * 保守方向错不了：最坏是"这事不干"，而不是"悄悄替用户开浏览器"。 */
        const text = String(args[1] || "");
        const buttons = Number(args[3]);
        log("★ displayAlert", { text: text.slice(0, 400), icon: args[2], buttons: args[3] });
        /* buttons=0 是"只有确定"的单向提示（Zotero 也不看返回值），不能弹成
         * "确定/取消"二选一 —— 那会让用户以为自己要做一个不存在的决定。
         * 只有真有多按钮时才问 confirm。 */
        if (!(buttons > 0)) {
          try { alert(text); } catch (e) { /* 无法弹窗也不影响返回 */ }
          return 0;
        }
        let yes = false;
        if (typeof confirm === "function") {
          try { yes = !!confirm(text); } catch (e) { yes = false; }
        } else {
          try { alert(text); } catch (e) { /* 无法弹窗也不影响返回 */ }
        }
        if (!yes) return 0;                       // 0 = 取消 / 否，绝不替用户答应
        return buttons === 3 ? 2 : 1;             // 3 键框的"是"是 2，其余是 1
      }

      /* 笔记里的占位超链接 → 引文域。我们**暂不做**转换（需要先把超链接里的
       * citationID 读出来再重写域，属于后续功能），但返回值**必须是数组**：
       * Zotero 侧 httpIntegrationClient.js:157 拿到 retVal 直接 `retVal.map(...)`，
       * 回 null 会 TypeError，用户只看到一个通用错误，而笔记内容已经写进文档了。
       * 触发场景：往文档里插入带引文的 Zotero 笔记（addNote / 从 Zotero 拖笔记进来）。 */
      case "Document.convertPlaceholdersToFields":
        log("convertPlaceholdersToFields 暂不支持，返回空数组", {
          n: Array.isArray(args[1]) ? args[1].length : 0,
        });
        return [];

      case "Document.setBibliographyStyle":
      case "Document.cleanup":
        return null;

      default:
        log("未实现命令", { cmd: cmd, args: String(JSON.stringify(args || [])).slice(0, 200) });
        return null;
    }
  }

  /**
   * 执行一个集成命令（addCitation / addBibliography / refreshDocument / …）。
   * Zotero 会弹它自己的对话框（文档首选项 / 添加引文），由用户操作。
   *
   * ★ 失败的收尾纪律（这一条是用"必须重启 Zotero"换来的）：
   *   Zotero 的 inProgress 只在它自己调 Document.complete() 时复位，而 complete()
   *   在 execCommand 的 finally 里——finally 还要 await cleanup/activate，全都要我们 respond。
   *   所以「handle 抛错就直接 return」会让 Zotero 永久卡在 inProgress，之后点什么都 503。
   *   正确做法：先 respond 一个 {error:"Alert"} 让 Zotero 自己走错误分支，
   *   然后**继续把这个事务的所有后续命令都 respond 掉**，直到 Document.complete。
   */
  /* 事务互斥：Zotero 同一时刻只允许一个集成事务，重叠会被它拒成 503。
   *
   * ★ 但不能"忙就直接拒绝"——踩过：用户在 Zotero 的添加引文框里点 X 取消，
   *   Zotero 还要走一段收尾（Field.delete → setDocumentData → activate → complete），
   *   这期间点按钮就会被硬拒绝，看着像"再也打不开了"。
   *   现在改成：先等一会儿（收尾通常几秒内结束），超过阈值才提示；
   *   锁被占用超过 STALE 视为僵尸锁（事务真挂了），强制释放，不让 UI 永久卡死。 */
  let busy = "";
  let busySince = 0;
  let BUSY_WAIT_MS = 10000;     // 愿意为上一个事务的收尾等多久
  /* ★ STALE 不能随便放掉：用户在 Zotero 的「添加引文」框里挑 3 分钟很正常
   *   （原来的 180s 就是"挑文献挑到一半锁被强制释放"的 bug），
   *   而 Zotero 自己侧**已经**会靠 inProgress 把并发拦成 503 —— 我们这层再
   *   强制释放，等于把人家的"拒 503"机会抢掉，而且放掉的是一把假锁：
   *   老事务其实还活着，只是我们这里看不见了。
   *   所以：阈值抬到与 LONG 同量级（30 分钟），且**只打日志不释放**，
   *   把并发裁决权交回给 Zotero。 */
  let BUSY_STALE_MS = 1800000;

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  async function run(command, options) {
    const opts = options || {};
    const t0 = Date.now();
    while (busy && Date.now() - t0 < BUSY_WAIT_MS) {
      if (Date.now() - busySince > BUSY_STALE_MS) {
        // 只留痕不放手：真挂死的情况是 Zotero 进程死了，那种情况下 respond 会 503
        // 自然失败，不需要我们在这里越权放锁。
        log("★ busy 已持有超过 STALE 阈值（不释放，交给 Zotero 的 503 兜并发）",
          { held: Date.now() - busySince, cmd: busy });
        break;
      }
      await sleep(150);
    }
    if (busy) {
      throw new Error("Zotero 还在收尾上一个操作（" + busy + "），请过几秒再点一次。");
    }
    busy = command;
    busySince = Date.now();
    try {
      return await runInner(command, opts);
    } catch (error) {
      const R = recovery();
      if (R && txn.backup && !txn.committed) {
        R.stage(txn.backup, "transaction", "failed", { error: String((error && error.message) || error).slice(0, 240), elapsed: Date.now() - busySince });
        let restored = null;
        try { restored = R.restore(txn.backup); }
        catch (restoreError) { restored = { ok: false, failures: [String((restoreError && restoreError.message) || restoreError)] }; }
        const suffix = restored && restored.ok ? "；已仅恢复本次触达的域与文档数据并回读验证" : "；恢复未完全成功，备份已保留，请立即另存副本并撤销本次操作";
        error.message = String(error.message || error) + suffix;
        if (root.PPAudit && opts.audit !== false) {
          try {
            root.PPAudit.record(txn.backup.documentID, {
              operation: opts.auditOperation || command, ok: false, mode: opts.mode,
              operationID: txn.backup.operationID,
              summary: restored && restored.ok ? "失败并已恢复本次触达内容" : "失败且恢复未完全成功，备份已保留",
              from: opts.auditFrom, to: opts.auditTo,
            });
          } catch (ignored) { /* 记录失败不阻断业务 */ }
        }
      }
      throw error;
    } finally {
      busy = "";
      busySince = 0;
    }
  }

  async function runInner(command, options) {
    const opts = options || {};
    log("run " + command);
    txn = { wroteText: false, command: command, backup: null, committed: false };

    /* ★ 前置闸门：拿不到文档就**绝不发起事务**。
     *   事务一旦发起却在 getActiveDocument 之前失败，Zotero 会永久卡在 inProgress
     *   （必须重启 Zotero 才能恢复，这是实测结论）。所以前提检查必须放在 execCommand 之前。 */
    try {
      Doc.doc();
    } catch (e) {
      throw new Error("请先在 WPS 里打开一个文档再点这个按钮（" + String((e && e.message) || e) + "）");
    }

    /* ★ 命令名白名单：写错名字 Zotero 侧会抛 TypeError 且**走不到 complete**，
     *   于是既不报错也不回应，表现就是"点了没反应"。这里在发请求之前就拦住。 */
    if (!KNOWN_COMMANDS[command]) {
      throw new Error("内部错误：命令名 \"" + command + "\" 不是 Zotero 认识的名字（"
        + Object.keys(KNOWN_COMMANDS).join(" / ") + "）。请把这个提示反馈给我们。");
    }
    // 快照必须在任何 Zotero 写命令之前完成；备份失败会直接禁止发起事务。
    beginRecovery(command);

    let resp;
    try {
      /* 第一条命令应当秒回（Application.getActiveDocument）。用 LONG(30 分钟) 等它，
       * 一旦 Zotero 侧静默失败，用户看到的就是"点完没反应"，半小时后才可能超时。
       * 90 秒足够覆盖 Zotero 冷启动，超时直接给可执行的提示。 */
      resp = await post("/connector/document/execCommand", { command: command, docId: DOC_ID }, FIRST_WAIT);
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (msg.indexOf("503") >= 0) {
        throw new Error("Zotero 还在处理上一个操作（没走完收尾）。请等几秒再点一次；"
          + "如果一直这样，把 Zotero 完全退出再打开。");
      }
      if (/abort|timeout|aborted|超时/i.test(msg)) {
        throw new Error("Zotero 没有回应（等了 " + Math.round(FIRST_WAIT / 1000) + " 秒）。"
          + "请把 Zotero 完全退出再打开，然后重试；如果每次都这样，请把 proxy.log 发给我们。");
      }
      throw new Error("连接 Zotero 失败：" + msg);
    }

    let failure = null;             // 第一个业务错误：先收尾，最后再抛给界面

    for (let i = 0; i < MAX_STEPS; i++) {
      if (!resp || !resp.command) {
        if (failure) throw failure;
        log("bad response", { resp: String(JSON.stringify(resp)).slice(0, 200) });
        throw new Error("Zotero 返回了无法理解的响应");
      }
      const cmd = resp.command;
      const args = resp.arguments || [];

      // 事务终点。Zotero 侧 inProgress 在它调 complete() 时就已复位，这里只是把连接收干净
      if (cmd.indexOf("complete") >= 0) {
        /* ★ 不能 await 这次 respond（原来 await + SHORT=30s，是"点完按钮转圈 30 秒"的真凶）。
         * complete 是最后一条命令：Zotero 的 respond 端点只做两件事——解掉上一个 deferred、
         * 把这次请求的 sendResponse 存起来当下一条命令的通道（server_connectorIntegration.js:80-84）。
         * 之后不会再有 sendCommand，所以这次 respond 的 HTTP 响应**永远不会产生**，
         * await 只能等满 SHORT(30s) 超时才被 AbortController 掐断。代价：
         *   ① 用户点完按钮界面转圈 30 秒；
         *   ② busy 锁被占 30 秒，这期间再点就是"还在收尾上一个操作"；
         *   ③ 代理侧 forward(timeout=1800) 的线程被这次请求占住。
         * 而 Zotero 侧 inProgress 是在 complete() 第一行就复位的（httpIntegrationClient.js:160），
         * 不依赖这次 respond 的返回值 —— 所以发出去即可，不等。 */
        post("/connector/document/respond", null, 2000).catch(function () { /* 收尾失败无妨 */ });
        log("done " + command + (failure ? "（有错误，已收尾）" : "")
          + (txn.wroteText ? "" : "（用户取消，未写入）"));
        if (failure) throw failure;
        /* 只有"插入类"命令才需要用"有没有写过文本"来判取消。
         * refresh 在内容没变化时本来就不写文本，不能当成取消，
         * 否则点了刷新会既没动作也不报错，像死了一样。 */
        const isInsert = INSERT_COMMANDS[command] === 1;
        const asksCancel = CANCEL_ASKS[command] === 1;
        let completedResult;
        if (asksCancel && !txn.wroteText) completedResult = { ok: false, cancelled: true };
        else if (isInsert && !txn.wroteText) completedResult = { ok: true, empty: true };
        else completedResult = { ok: true, changed: !!txn.wroteText };
        commitRecovery(command, completedResult);
        if (txn.backup) {
          completedResult.operationID = txn.backup.operationID;
          if (root.PPSettings) {
            const documentID = txn.backup.documentID;
            let count = 0;
            try { count = Doc.scanFieldRefs().filter(function (r) { return /CSL_CITATION|ZOTERO_ITEM/i.test(r.code); }).length; } catch (e) { count = 0; }
            let fingerprint = "";
            try { if (root.PPFieldScanner) fingerprint = root.PPFieldScanner.fingerprint(root.PPFieldScanner.scan(Doc.doc())); } catch (e) { fingerprint = ""; }
            let bibliographyCount = 0, issueCount = 0;
            try {
              const statusScan = root.PPFieldScanner.scan(Doc.doc());
              bibliographyCount = statusScan.bibliography.length;
              issueCount = statusScan.issues.length;
              const health = root.PPSettings.get(documentID).lastHealth;
              if (health && Number(health.count) > issueCount) issueCount = Number(health.count);
            } catch (e) { bibliographyCount = 0; }
            const status = { count: count, citationCount: count, bibliographyCount: bibliographyCount, issueCount: issueCount,
              changed: !!txn.wroteText, fingerprint: fingerprint, operationID: txn.backup.operationID };
            if (completedResult.ok) root.PPSettings.refreshSucceeded(documentID, status);
            else root.PPSettings.refreshFinished(documentID, Object.assign(status, { ok: false, cancelled: true }));
          }
          /* P2-4：一次操作最终完成后只写一条记录；取消由 record 内部跳过；
           * 记录失败只吞掉自身异常，绝不阻断已完成的事务。 */
          if (root.PPAudit && opts.audit !== false) {
            let auditCount = opts.auditCount == null ? null : (Number(opts.auditCount) || 0);
            if (auditCount == null) {
              if (command === "refresh") {
                try { auditCount = Doc.scanFieldRefs().filter(function (r) { return /CSL_CITATION|ZOTERO_ITEM/i.test(r.code); }).length; }
                catch (e) { auditCount = 0; }
              } else auditCount = completedResult.changed ? 1 : 0;
            }
            const summary = opts.auditSummary || (command === "refresh"
              ? (completedResult.changed ? "刷新完成，已写入新内容" : "刷新完成，内容无变化")
              : (completedResult.changed ? "命令写入完成" : "命令完成，文档无变化"));
            try {
              root.PPAudit.record(txn.backup.documentID, {
                operation: opts.auditOperation || command, ok: !!completedResult.ok,
                cancelled: !!completedResult.cancelled, count: auditCount, mode: opts.mode,
                operationID: txn.backup.operationID, summary: summary,
                from: opts.auditFrom, to: opts.auditTo,
              });
            } catch (ignored) { /* 记录失败不阻断业务 */ }
          }
        }
        return completedResult;
      }

      if (failure) {
        // 出错后的收尾轮：只回安全值，把 Zotero 的 finally 走完
        let safe = null;
        if (cmd === "Document.displayAlert") safe = 0;   // 0 = 不点「是」，别让它去开帮助网页
        log("unwind", { cmd: cmd });
        try {
          resp = await post("/connector/document/respond", safe, SHORT);
        } catch (e) {
          break;
        }
        continue;
      }

      log("cmd", { i: i, cmd: cmd });
      if (recovery() && txn.backup) recovery().stage(txn.backup, cmd, "begin", { step: i });
      let result;
      try {
        result = await handle(cmd, args);
      } catch (e) {
        failure = e;
        log("handle failed", { cmd: cmd, err: String((e && e.message) || e) });
        // 顺着协议的错误通道把这一次等待 reject 掉，Zotero 会走 _handleCommandError
        let next = null;
        try {
          next = await post("/connector/document/respond", {
            error: "Alert",
            message: "Papilot Cite：" + String((e && e.message) || e),
            stack: String((e && e.stack) || ""),
          }, SHORT);
        } catch (e2) {
          next = null;
        }
        resp = next;
        continue;
      }
      resp = await post("/connector/document/respond", result, LONG);
    }

    if (failure) throw failure;
    throw new Error("集成命令没有正常结束（命令数超过上限 " + MAX_STEPS + "，或与 Zotero 的链路中断）。"
      + "如果是超大文档，请先拆成章节再分别刷新。");
  }

  /* ==================== 换样式 / 补入未引用条目 / 文献表缩进 ==================== */

  /** 文献表域的判定（Word 方言与 Zotero 内部方言都要认） */
  const BIB_RE = /CSL_BIBLIOGRAPHY|ZOTERO_BIBL/i;

  function docDataPartKey(i) {
    return i === 0 ? DOC_DATA_KEY : DOC_DATA_KEY + "_" + i;
  }

  /** 读 ZoteroDocData：新版按 Parts 计数拼接，旧版没有 Parts 时直接读单属性。 */
  function readDocData() {
    try {
      const base = String(Doc.meta(DOC_DATA_KEY) || "");
      const rawParts = String(Doc.meta(DOC_DATA_PARTS_KEY) || "");
      const parts = Number(rawParts);
      if (!(parts > 1) || Math.floor(parts) !== parts) return base;
      const chunks = [base];
      for (let i = 1; i < parts; i++) chunks.push(String(Doc.meta(docDataPartKey(i)) || ""));
      return chunks.join("");
    } catch (e) {
      return "";
    }
  }

  /** 分段写入，最后写 Parts 计数；多余旧分段清空但不会影响读取。 */
  function writeDocData(raw) {
    const want = String(raw == null ? "" : raw);
    const oldParts = Number(Doc.meta(DOC_DATA_PARTS_KEY)) || 1;
    const parts = Math.max(1, Math.ceil(want.length / DOC_DATA_CHUNK));
    for (let i = 0; i < parts; i++) {
      Doc.meta(docDataPartKey(i), want.slice(i * DOC_DATA_CHUNK, (i + 1) * DOC_DATA_CHUNK));
    }
    Doc.meta(DOC_DATA_PARTS_KEY, String(parts));
    for (let i = parts; i < oldParts; i++) Doc.meta(docDataPartKey(i), "");
  }

  /**
   * 写 ZoteroDocData 并**逐字**回读校验。240 字符一段，避开单属性 255 上限；
   * 不一致时恢复旧值，绝不让半个 JSON 留在文档里。
   */
  function writeDocDataChecked(json, oldRaw) {
    const want = String(json == null ? "" : json);
    try { writeDocData(want); } catch (e) { /* 写失败靠回读发现 */ }
    const back = readDocData();
    if (back === want) return true;

    let restored = false;
    if (oldRaw != null) {
      try { writeDocData(String(oldRaw)); } catch (e) { /* 尽力恢复 */ }
      restored = readDocData() === String(oldRaw);
    }
    log("★ 文档数据回读不一致", { want: want.length, got: back.length, restored: restored });
    throw new Error("WPS 没能完整保存 Zotero 文档数据（写入 " + want.length + " 字符，回读 "
      + back.length + " 字符）。继续下去会让引文编号错乱，所以停在这里。"
      + (restored ? "文档数据已恢复原样。"
        : "原数据也没能恢复，请撤销本次操作（Ctrl+Z）后重试。"));
  }

  /**
   * 换引注样式：**不调 setDocPrefs**（那会弹 Zotero 的「文档首选项」对话框，
   * 而且 setDocPrefs 在 HTTP 路径下还要额外几条命令），直接改文档数据里的 style，
   * 再跑一次 refresh 让 Zotero 按新样式重排全文（正文引注 + 文献表一起）。
   */
  async function changeStyle(styleID, options) {
    const opts = options || {};
    const want = String(styleID == null ? "" : styleID).trim();
    if (!want) throw new Error("没有指定要换成的样式（styleID 是空的）。");

    const raw = readDocData();
    if (!raw) {
      throw new Error("这个文档还没有 Zotero 文档数据：先插入一条引文让 Zotero 建立会话，再来换样式。");
    }
    let data = null;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      throw new Error("文档里的 Zotero 数据解析失败：" + String((e && e.message) || e));
    }
    if (!data || typeof data !== "object") {
      throw new Error("文档里的 Zotero 数据不是对象，没法换样式。");
    }
    if (!data.style || typeof data.style !== "object") {
      throw new Error("文档里的 Zotero 数据没有样式信息（style），没法换样式。");
    }

    const old = String(data.style.styleID || "");
    if (old === want) return { ok: true, changed: false };

    data.style.styleID = want;
    writeDocDataChecked(JSON.stringify(data), raw);
    /* ★ refresh 失败必须回滚文档数据。
     *   最典型的失败是"本机没装这个样式"（Zotero 取样式失败）——如果不回滚，
     *   文档数据里就钉着一个不存在的 styleID，之后点多少次【刷新】都失败，
     *   用户只能手动去文档首选项里改回来，等于把文档弄坏了。 */
    try {
      /* 内层 refresh 只负责重排；修改记录由本函数写一条“样式切换”，
       * 避免一次用户动作落成两条记录。 */
      await run("refresh", { audit: false, mode: opts.mode });
    } catch (e) {
      let back = false;
      try { back = writeDocDataChecked(raw, raw) === true; } catch (e2) { back = false; }
      log("★ 换样式后 refresh 失败，已回滚", { to: want, restored: back,
        err: String((e && e.message) || e).slice(0, 200) });
      if (root.PPAudit) {
        let count = 0;
        try { count = Doc.scanFieldRefs().filter(function (r) { return /CSL_CITATION|ZOTERO_ITEM/i.test(r.code); }).length; } catch (e2) { count = 0; }
        try {
          root.PPAudit.record(Doc.documentID(), {
            operation: "styleChange", ok: false, mode: opts.mode, count: count,
            from: old, to: want,
            summary: (back ? "样式切换失败，已回滚原样式；" : "样式切换失败，原样式写回也失败，请撤销；")
              + String((e && e.message) || e).slice(0, 120),
          });
        } catch (ignored) { /* 记录失败不阻断业务 */ }
      }
      throw new Error("换成这个样式后重排失败（多半是本机没有这个样式，或 Zotero 取样式超时）。"
        + (back ? "已恢复原来的样式。" : "原样式也没能写回，请按 Ctrl+Z 撤销后重试。")
        + "原因：" + String((e && e.message) || e));
    }
    log("changeStyle", { from: old, to: want });
    if (root.PPAudit) {
      let count = 0;
      try { count = Doc.scanFieldRefs().filter(function (r) { return /CSL_CITATION|ZOTERO_ITEM/i.test(r.code); }).length; } catch (e) { count = 0; }
      try {
        root.PPAudit.record(Doc.documentID(), {
          operation: "styleChange", ok: true, mode: opts.mode, count: count,
          from: old, to: want, summary: "样式切换并刷新成功",
        });
      } catch (ignored) { /* 记录失败不阻断业务 */ }
    }
    return { ok: true, changed: true, from: old, to: want };
  }

  /**
   * 从域代码里取 Zotero 库的 URI 前缀。
   * 引文域里 citationItems[].id 形如 http://zotero.org/users/local/XXXX/items/KEY，
   * 去掉 /items/KEY 就是前缀。**不要自己拼前缀**：本地库、群组库、不同 Zotero 版本
   * 的 users 段都不一样，猜错了补进去的条目 Zotero 认不出来（表现为文献表没变化）。
   */
  function uriPrefixFromFields(fields) {
    for (let i = 0; i < fields.length; i++) {
      const code = String((fields[i] && fields[i].code) || "");
      if (!/CSL_CITATION|ZOTERO_ITEM/i.test(code)) continue;
      const m = /"id"\s*:\s*"(https?:\/\/[^"]+?)\/items\/[^"\/]+"/.exec(code);
      if (m) return m[1];
    }
    return "";
  }

  /**
   * 规整 uncited：Zotero 的新格式是**数组的数组**（每组是一个 URI 数组，
   * 对应一次「补入未引用条目」操作）。老数据里可能混着裸字符串，这里一并归一。
   */
  function normUncited(u) {
    const out = [];
    if (!Array.isArray(u)) return out;
    for (let i = 0; i < u.length; i++) {
      const it = u[i];
      if (Array.isArray(it)) {
        const g = [];
        for (let j = 0; j < it.length; j++) {
          const s = String(it[j] == null ? "" : it[j]).trim();
          if (s) g.push(s);
        }
        if (g.length) out.push(g);
      } else if (typeof it === "string" && it.trim()) {
        out.push([it.trim()]);
      }
    }
    return out;
  }

  /**
   * 把未引用条目补进文献表：改写文献表域代码里的 uncited，再 refresh 让 Zotero 重排。
   * 格式（Zotero 源码 integration.js:3536-3556）：
   *   ADDIN ZOTERO_BIBL {"uncited":[["http://zotero.org/users/local/XXXX/items/KEY1"]],
   *                      "omitted":[],"custom":[]} CSL_BIBLIOGRAPHY
   * ★ 写回必须保留 Word 方言前缀 —— 域头/域尾都按原文切片带回去，不做重建。
   */
  async function addUncited(keys) {
    const arr = Array.isArray(keys) ? keys : (keys == null || keys === "" ? [] : [keys]);
    const want = [];
    for (let i = 0; i < arr.length; i++) {
      const k = String(arr[i] == null ? "" : arr[i]).trim();
      if (k && want.indexOf(k) < 0) want.push(k);
    }
    if (!want.length) throw new Error("没有要补入的条目（条目 key 列表是空的）。");

    let fields = [];
    try { fields = Doc.scanFields() || []; } catch (e) { fields = []; }

    let bib = null;
    for (let i = 0; i < fields.length; i++) {
      if (BIB_RE.test(String((fields[i] && fields[i].code) || ""))) { bib = fields[i]; break; }
    }
    if (!bib) {
      throw new Error("本文档还没有文献表，先点【插入/更新文献表】，再来补入未引用条目。");
    }

    const prefix = uriPrefixFromFields(fields);
    if (!prefix) {
      throw new Error("取不到 Zotero 库的地址：先插入一条引文（需要从它身上取库的 URI 前缀），再来补入未引用条目。");
    }

    const src = String(bib.code || "");
    const i0 = src.indexOf("{");
    const i1 = src.lastIndexOf("}");
    if (i0 < 0 || i1 <= i0) {
      throw new Error("文献表的域代码不完整（找不到数据段），可能被 WPS 截断了。请重新点【插入/更新文献表】。");
    }
    let obj = null;
    try {
      obj = JSON.parse(src.slice(i0, i1 + 1));
    } catch (e) {
      throw new Error("文献表的数据解析失败：" + String((e && e.message) || e));
    }
    if (!obj || typeof obj !== "object") {
      throw new Error("文献表的数据不是一个对象，没法补入未引用条目。");
    }

    const uncited = normUncited(obj.uncited);
    const have = {};
    for (let i = 0; i < uncited.length; i++) {
      for (let j = 0; j < uncited[i].length; j++) have[uncited[i][j]] = true;
    }

    let added = 0;
    for (let i = 0; i < want.length; i++) {
      const uri = prefix + "/items/" + want[i];
      if (have[uri]) continue;
      uncited.push([uri]);
      have[uri] = true;
      added++;
    }
    let total = 0;
    for (let i = 0; i < uncited.length; i++) total += uncited[i].length;

    /* 全都在表里了：一个字节都不用改，也就没必要去打扰 Zotero（少开一次事务）。 */
    if (!added) {
      log("addUncited 全部已存在", { want: want.length, total: total });
      return { ok: true, added: 0, uncited: total };
    }

    obj.uncited = uncited;                              // omitted / custom 原值不动
    const code = src.slice(0, i0) + JSON.stringify(obj) + src.slice(i1 + 1);

    let f = null;
    try { f = Doc.doc().Fields.Item(bib.index); } catch (e) { f = null; }
    if (!f) {
      throw new Error("找不到文献表所在的域（可能刚被删掉）。请重新点【插入/更新文献表】。");
    }
    let wrote = false;
    try { f.Code.Text = code; wrote = true; } catch (e) { wrote = false; }
    let back = "";
    try { back = String(f.Code.Text || ""); } catch (e) { back = ""; }
    if (!wrote || back !== code) {
      try { f.Code.Text = src; } catch (e) { /* 尽力恢复 */ }
      log("★ addUncited 域代码回读不一致", { want: code.length, got: back.length, wrote: wrote });
      throw new Error("WPS 没能完整保存文献表的域代码（写入 " + code.length + " 字符，回读 "
        + back.length + " 字符）。继续会让文献表损坏，所以停在这里。");
    }

    await run("refresh", { auditOperation: "addUncited", auditSummary: "补入 " + added + " 条未引用文献（文献表共 " + total + " 条）", auditCount: total });
    log("addUncited", { added: added, total: total, prefix: prefix });
    return { ok: true, added: added, uncited: total };
  }

  /**
   * 文献表悬挂缩进：LeftIndent=21（≈两个五号字）、FirstLineIndent=-21（首行顶格）。
   * 只对**文献表域**做；引文域绝不动（引文是上标，段落缩进会把整段正文带偏）。
   * 某些 WPS 版本的 Result 上没有 ParagraphFormat —— 静默跳过，不能因此让 setText 失败。
   */
  function hangingIndent(field) {
    let code = "";
    try { code = String((field && field.Code && field.Code.Text) || ""); } catch (e) { return false; }
    if (!BIB_RE.test(code)) return false;
    try {
      const pf = field.Result && field.Result.ParagraphFormat;
      if (!pf) {
        log("文献表缩进跳过：ParagraphFormat 不存在（该 WPS 版本不支持）");
        return false;
      }
      pf.LeftIndent = 21;
      pf.FirstLineIndent = -21;
      return true;
    } catch (e) {
      log("文献表缩进设置失败（静默跳过）", { err: String((e && e.message) || e) });
      return false;
    }
  }

  // __fieldMapForTest / __setBusyTimings 只给单测用；生产路径不会读它们
  root.PPIntegration = {
    run: run, handle: handle, htmlToRuns: htmlToRuns, __fieldMapForTest: fieldMap,
    toWordCode: toWordCode, toZoteroCode: toZoteroCode, raiseWindow: raiseWindow,
    changeStyle: changeStyle, addUncited: addUncited,
    __setBusyTimings: function (waitMs, staleMs) {
      if (waitMs != null) BUSY_WAIT_MS = waitMs;
      if (staleMs != null) BUSY_STALE_MS = staleMs;
    },
    __getBusy: function () { return busy; },
    /* 测试专用：场景构造出"fetch 永远悬挂"的真僵尸时，locked 状态没法通过
     * 正常路径清掉（await 卡死 → finally 跑不到）。只在测试收尾时调。 */
    __resetBusy: function () { busy = ""; busySince = 0; },
    __writeDocDataForRecovery: function (raw) { writeDocData(String(raw == null ? "" : raw)); },
    __readDocDataForRecovery: function () { return readDocData(); },
    __getTxn: function () { return txn; },
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
