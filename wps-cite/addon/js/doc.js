// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* WPS 文档适配层：所有直接碰 wps.* 的代码都收在这里
 *
 * 纪律：别的模块不许直接调 wps.*，一律经本层。这样换 WPS 版本/换 Word 时只改一个文件，
 * 也让上层（model / styles / links）保持纯函数、可单测。
 *
 * 与旧实现的关键差别：**不用 Word 域（Field）**。
 *   WPS 12 对 Fields.Add / field.Result 的兼容性不稳，且域代码藏在二进制里、用户看不见也编不动。
 *   这里用「书签 + 命名编码」：书签是两端都稳定的原生对象，名字里带条目 key / 页码 / 标注 id，
 *   刷新时扫一遍书签就能重建全部引文——文档就是自己的数据库。
 */
(function (root) {
  "use strict";
  const codes = root.PPCodes;
  const BIB = "PPCBIB";      // 文献表锚（不匹配引文命名规范，不会被当作引文）
  const BIB_HEAD = "PPCBIBHEAD";

  function app() {
    if (typeof wps === "undefined" || !wps.WpsApplication) throw new Error("WPS jsapi 不可用");
    return wps.WpsApplication();
  }

  /**
   * 取当前文档。
   * 注意：加载项页面（含任务窗格）**没有焦点**时，ActiveDocument 可能是 null——
   * 旧实现直接抛错，于是"点了没反应"。这里退化为"取第一个打开的文档"。
   */
  function doc() {
    const a = app();
    let d = null;
    try {
      d = a.ActiveDocument;
    } catch (e) {
      d = null;
    }
    if (d) return d;
    try {
      if (a.Documents && a.Documents.Count > 0) return a.Documents.Item(1);
    } catch (e) { /* 继续往下抛 */ }
    throw new Error("拿不到文档对象（WPS 里没有打开的文档，或接口不可用）");
  }

  function docPath() {
    try {
      return String(doc().FullName || "");
    } catch (e) {
      return "";
    }
  }

  /** 扫出所有引文书签（只解析，不排序——排序在 model 里做） */
  function scan() {
    const d = doc();
    const out = [];
    const bms = d.Bookmarks;
    const n = bms.Count;
    for (let i = 1; i <= n; i++) {
      let bm;
      try {
        bm = bms.Item(i);
      } catch (e) {
        continue;                 // 书签可能在枚举中被删（刷新时正常）
      }
      const name = String(bm.Name || "");
      if (!codes.parse(name)) continue;
      let start = 0;
      try {
        start = Number(bm.Range.Start) || 0;
      } catch (e) { /* 取不到位置就排后面 */ }
      out.push({ name: name, start: start });
    }
    return out;
  }

  function exists(name) {
    try {
      return !!doc().Bookmarks.Exists(name);
    } catch (e) {
      return false;
    }
  }

  /** 替换书签范围内的文本；WPS 有可能在覆写后丢掉书签，这里补回来 */
  function setText(name, text) {
    const d = doc();
    const bm = d.Bookmarks.Item(name);
    const r = bm.Range;
    r.Text = text == null ? "" : String(text);
    if (!d.Bookmarks.Exists(name)) {
      const again = d.Bookmarks.Add(name, r);
      return again ? true : false;
    }
    return true;
  }

  function remove(name) {
    try {
      if (doc().Bookmarks.Exists(name)) doc().Bookmarks.Item(name).Delete();
    } catch (e) { /* 已经没了 */ }
  }

  /** 在光标处写入文本并给它挂一个书签名；返回 {name, ok} */
  function insertAtCursor(text, name) {
    const d = doc();
    let sel = null;
    try {
      sel = app().Selection.Range;
    } catch (e) {
      sel = null;
    }
    if (!sel) {
      // 无选区（页面没焦点）：退化为在文末插入
      // ★ 0 = wdCollapseEnd（Word/WPS 的 WdCollapseDirection：End=0，Start=1）。
      //   我曾凭印象改成 1，那会折到文首、把内容插到文章最前面，已改回。
      sel = d.Content;
      try { sel.Collapse(0); } catch (e) { /* 不支持就保持整段 */ }
    }
    sel.Text = String(text == null ? "" : text);
    // 用写入后的范围挂书签（sel 会随文本更新）。
    // ★ Selection.Range 这一步也可能抛（页面没焦点时 ActiveDocument 拿不到 Selection），
    //   原来不包 try，异常直接冒到 insertCitation 的 catch，书签建不出来、用户只看到
    //   "插入失败"，但文本其实**已经写进正文了**。取不到 Selection 就退化到写入用的 sel，
    //   sel 本身就是"刚写入那段文本"的范围。
    let r = null;
    try {
      r = app().Selection.Range;
    } catch (e) {
      r = sel;
    }
    if (!r) r = sel;
    try {
      if (Number(r.Start) > 0) {
        r.Start = r.Start - String(text).length;
        r.End = r.Start + String(text).length;
      }
    } catch (e) { /* 取不到就整段挂 */ }
    try {
      d.Bookmarks.Add(name, r);
    } catch (e) {
      return { name: name, ok: false, error: String(e && e.message || e) };
    }
    return { name: name, ok: true };
  }

  /** 把光标移到某个书签（用于"从台账跳回文档"） */
  function gotoBookmark(name) {
    const d = doc();
    if (!d.Bookmarks.Exists(name)) return false;
    const bm = d.Bookmarks.Item(name);
    bm.Range.Select();
    try { app().ActiveWindow.ScrollIntoView(bm.Range, true); } catch (e) { /* 选中已成功，滚动不可用不算失败 */ }
    return true;
  }

  // ---------- 正文引文 ↔ 参考文献条目锚点 ----------
  // 书签由 integration.js 在 Zotero 每次重写文献表后重建；刷新删除旧书签是正常的。
  const BIB_ITEM_PREFIX = "PPBIB_";

  function bibBookmarkName(item) {
    const key = String(item && item.key || "").toUpperCase();
    const group = item && item.libType === "groups";
    const lib = Number(item && item.libId) || (group ? 0 : 1);
    return BIB_ITEM_PREFIX + (group ? "g" : "u") + lib + "_" + key;
  }

  function parseBibBookmark(name) {
    const m = /^PPBIB_([gu])(\d+)_([A-Z0-9]{8})$/.exec(String(name || ""));
    if (!m) return null;
    return { key: m[3], libId: Number(m[2]), libType: m[1] === "g" ? "groups" : "users" };
  }

  /** entries: [{item, start, end}]，start/end 是相对于文献表域结果起点的字符偏移。 */
  function replaceBibBookmarks(field, entries) {
    const d = doc();
    const bms = d.Bookmarks;
    for (let i = Number(bms.Count) || 0; i >= 1; i--) {
      try {
        const bm = bms.Item(i);
        if (String(bm.Name || "").indexOf(BIB_ITEM_PREFIX) === 0) bm.Delete();
      } catch (e) { /* 枚举期间被 WPS 删除则跳过 */ }
    }
    let base = -1;
    try { base = Number(field.Result.Start); } catch (e) { base = -1; }
    if (!(base >= 0)) return { mapped: 0, failed: (entries || []).length };
    let mapped = 0, failed = 0;
    const used = new Set();
    for (const entry of entries || []) {
      const item = entry && entry.item;
      const name = bibBookmarkName(item || {});
      if (!parseBibBookmark(name) || used.has(name)) continue;
      used.add(name);
      try {
        const s = base + Number(entry.start);
        const e2 = base + Number(entry.end);
        if (!(s >= base && e2 > s)) throw new Error("无效条目范围");
        d.Bookmarks.Add(name, d.Range(s, e2));
        mapped++;
      } catch (e) { failed++; }
    }
    return { mapped: mapped, failed: failed };
  }

  function gotoBibItem(item) {
    try {
      const name = bibBookmarkName(item);
      if (!doc().Bookmarks.Exists(name)) return false;
      return gotoBookmark(name);
    } catch (e) {
      return false;
    }
  }

  function bibEntryAtCursor() {
    try {
      const d = doc();
      const pos = Number(app().Selection.Range.Start);
      const bms = d.Bookmarks;
      for (let i = 1; i <= (Number(bms.Count) || 0); i++) {
        const bm = bms.Item(i);
        const item = parseBibBookmark(bm.Name);
        if (!item) continue;
        const r = bm.Range;
        if (pos >= Number(r.Start) && pos <= Number(r.End)) return item;
      }
    } catch (e) { /* 光标/书签不可用时按未命中 */ }
    return null;
  }

  /** 选区当前落在哪个引文书签里？返回 {name, parsed} 或 null */
  function citationAtCursor() {
    const d = doc();
    const pos = Number(app().Selection.Range.Start) || 0;
    let best = null;
    const bms = d.Bookmarks;
    for (let i = 1; i <= bms.Count; i++) {
      let bm;
      try {
        bm = bms.Item(i);
      } catch (e) { continue; }
      const p = codes.parse(String(bm.Name || ""));
      if (!p) continue;
      let r;
      try {
        r = bm.Range;
      } catch (e) { continue; }
      if (pos >= Number(r.Start) - 1 && pos <= Number(r.End) + 1) {
        best = { name: p.name, parsed: p };
      }
    }
    return best;
  }

  function listDocuments() {
    const a = app(), out = [];
    const docs = a.Documents;
    if (!docs) return out;
    const count = Number(docs.Count) || 0;
    for (let i = 1; i <= count; i++) {
      try { const d = docs.Item(i); if (d) out.push(d); } catch (e) { /* 单个文档不可访问不拖垮总览 */ }
    }
    return out;
  }

  function paragraphSnapshot(target) {
    const d = target || doc(), out = [];
    const paragraphs = d.Paragraphs;
    if (!paragraphs) throw new Error("当前 WPS 不支持段落枚举，无法可靠识别章节");
    const count = Number(paragraphs.Count) || 0;
    for (let i = 1; i <= count; i++) {
      try {
        const p = paragraphs.Item(i), r = p.Range;
        let style = "";
        try { style = String(p.Style && (p.Style.NameLocal || p.Style.Name) || p.Style || ""); } catch (e) { style = ""; }
        out.push({ index: i, start: Number(r.Start) || 0, end: Number(r.End) || 0,
          text: String(r.Text || "").replace(/[\r\n]+/g, "").trim(), outlineLevel: Number(p.OutlineLevel) || 0, style: style });
      } catch (e) { /* 单段不可读时保留其他段落 */ }
    }
    return out;
  }

  /* 仅用于 Papilot 自己创建的纯文本分章块。每块都有书签，更新不碰 Zotero 域；
   * 任一块写入/回读失败，逆序恢复本次已触达块，不拿整篇 Content.Text 做恢复。 */
  function writeStaticBlocks(blocks) {
    const d = doc(), applied = [];
    function restore() {
      applied.slice().reverse().forEach(function (old) {
        try {
          if (d.Bookmarks.Exists(old.name)) {
            const range = d.Bookmarks.Item(old.name).Range;
            range.Text = old.existed ? old.text : "";
            if (old.existed && !d.Bookmarks.Exists(old.name)) d.Bookmarks.Add(old.name, range);
            if (!old.existed && d.Bookmarks.Exists(old.name)) d.Bookmarks.Item(old.name).Delete();
          } else if (old.existed) {
            const range = d.Range(old.start, old.end); range.Text = old.text; d.Bookmarks.Add(old.name, range);
          }
        } catch (e) { /* 恢复异常由上层提示立即撤销，不能伪报完整恢复 */ }
      });
    }
    try {
      (blocks || []).forEach(function (block) {
        const name = String(block.bookmark || "");
        if (!/^PPCHAPBIB_[A-Za-z0-9_]{1,24}$/.test(name)) throw new Error("分章书签名无效");
        const existed = d.Bookmarks.Exists(name);
        const old = { name: name, existed: existed, text: "", start: 0, end: 0 };
        let range;
        if (existed) {
          range = d.Bookmarks.Item(name).Range;
          old.text = String(range.Text || ""); old.start = Number(range.Start) || 0; old.end = Number(range.End) || old.start;
        } else range = d.Range(Number(block.position) || 0, Number(block.position) || 0);
        applied.push(old);
        range.Text = String(block.text || "");
        if (!d.Bookmarks.Exists(name)) d.Bookmarks.Add(name, range);
        const check = d.Bookmarks.Item(name).Range;
        if (String(check.Text || "") !== String(block.text || "")) throw new Error(name + " 写入回读不一致");
      });
      return { ok: true, count: (blocks || []).length };
    } catch (e) {
      restore();
      throw new Error("分章文献表写入失败，已尝试恢复本次分章块：" + String((e && e.message) || e));
    }
  }

  function documentID(d) {
    const target = d || doc();
    try {
      const value = String(target.FullName || target.Name || "");
      if (value) return value;
    } catch (e) { /* 未保存文档使用会话对象键 */ }
    if (!target.__papilotDocumentID) {
      try { Object.defineProperty(target, "__papilotDocumentID", { value: "unsaved-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8), configurable: true }); }
      catch (e) { return "unsaved-current"; }
    }
    return String(target.__papilotDocumentID);
  }

  function noteDescriptor(note, container, ordinal) {
    const index = Number(note && note.Index) || ordinal;
    let start = 0, anchor = null, anchorError = "";
    try { start = Number(note.Range.Start) || 0; } catch (e) { start = 0; }
    try {
      const value = Number(note.Reference.Start);
      if (isFinite(value) && value >= 0) anchor = value;
    } catch (e) { anchorError = String((e && e.message) || e); }
    const desc = { note: note, container: container, noteIndex: index, noteID: container + ":" + index + ":" + start, anchor: anchor };
    if (anchor === null) {
      desc.orderIssue = { kind: "CONTAINER_ORDER_UNSUPPORTED", severity: "warning", summary: container + " 缺少正文引用锚点，无法保证全文档域顺序", reason: anchorError || "note.Reference.Start 不可用", action: "升级支持 note.Reference.Start 的 WPS；顺序敏感操作前请核对引文" };
    }
    return desc;
  }

  /**
   * 唯一全容器域枚举。正文按结果位置排序，注文按真实 Index 再按域位置排序；
   * 每个集合、每条注、每个域均独立捕获异常，坏容器不会吞掉其他域。
   */
  function bookmarksForField(d, field) {
    const out = [];
    try {
      const start = Number(field.Result.Start), end = Number(field.Result.End), bookmarks = d.Bookmarks;
      for (let i = 1; i <= (Number(bookmarks.Count) || 0); i++) {
        const bm = bookmarks.Item(i), name = String(bm.Name || "");
        if (name.indexOf("PP") !== 0) continue;
        const bs = Number(bm.Range.Start), be = Number(bm.Range.End);
        if (bs >= start && be <= Math.max(end, bs)) out.push({ name: name, start: bs, end: be });
      }
    } catch (e) { /* 书签不可用时域快照仍然有效 */ }
    return out;
  }

  function scanFieldRefs(target) {
    const d = target || doc(), descriptors = [{ note: null, container: "body", noteIndex: 0, noteID: null, fields: null }];
    try { descriptors[0].fields = d.Fields; } catch (e) { descriptors[0].issue = { kind: "CONTAINER_SCAN_FAILED", severity: "warning", summary: "正文域枚举不可用", reason: String((e && e.message) || e), action: "检查 WPS 域 API" }; }
    ["Footnotes", "Endnotes"].forEach(function (name) {
      const container = name === "Footnotes" ? "footnote" : "endnote";
      let notes = null;
      try { notes = d[name]; } catch (e) { return; }
      if (!notes) return;
      let count = 0;
      try { count = Number(notes.Count) || 0; } catch (e) { return; }
      for (let i = 1; i <= count; i++) {
        try {
          const note = notes.Item(i);
          if (!note) continue;
          const desc = noteDescriptor(note, container, i);
          desc.fields = note.Range && note.Range.Fields;
          descriptors.push(desc);
        } catch (e) { /* 单条异常注隔离 */ }
      }
    });
    const out = [];
    descriptors.forEach(function (desc) {
      const fields = desc.fields;
      if (desc.orderIssue) out.push({ container: desc.container, noteIndex: desc.noteIndex, noteID: desc.noteID, code: "", text: "", start: 0, orderAnchor: Number.MAX_SAFE_INTEGER, issue: desc.orderIssue });
      if (!fields) { if (desc.issue) out.push({ container: desc.container, noteIndex: desc.noteIndex, noteID: desc.noteID, code: "", text: "", start: 0, issue: desc.issue }); return; }
      let count = 0;
      try { count = Number(fields.Count) || 0; }
      catch (e) {
        out.push({ container: desc.container, noteIndex: desc.noteIndex, noteID: desc.noteID, code: "", text: "", start: 0, issue: { kind: "CONTAINER_SCAN_FAILED", severity: desc.container === "body" ? "error" : "warning", summary: desc.container + " 域枚举失败", reason: String((e && e.message) || e), action: "重试扫描；正文不可用时禁止刷新写入" } });
        return;
      }
      const local = [];
      for (let i = 1; i <= count; i++) {
        try {
          const f = fields.Item(i);
          if (!f) continue;
          let code = "", text = "", start = 0, end = 0;
          try { code = String((f.Code && f.Code.Text) || f.Code || ""); } catch (e) { code = ""; }
          try { text = String(f.Result && f.Result.Text || ""); } catch (e) { text = ""; }
          try { start = Number(f.Result && f.Result.Start) || 0; end = Number(f.Result && f.Result.End) || start; } catch (e) { start = 0; end = 0; }
          local.push({ field: f, index: i, code: code, text: text, start: start, end: end, orderAnchor: desc.container === "body" ? start : (desc.anchor === null ? Number.MAX_SAFE_INTEGER : desc.anchor), container: desc.container, noteIndex: desc.noteIndex, noteID: desc.noteID, note: desc.note || null, bookmarks: bookmarksForField(d, f), adjacent: false });
        } catch (e) { /* 单域异常不阻断 */ }
      }
      local.sort(function (a, b) { return a.start - b.start || a.index - b.index; });
      for (let i = 0; i < local.length; i++) {
        if (i + 1 < local.length) local[i].adjacent = local[i].end === local[i + 1].start;
        out.push(local[i]);
      }
    });
    /* Zotero 要求按引文在正文中的出现顺序返回域。注文 Range.Start 是注文区
     * 内部位置，不能拿来和正文位置比较；统一使用 Reference.Start 作为正文锚点。
     * 同一注内再按域结果位置排列，正文同位置时保持容器枚举次序。 */
    out.sort(function (a, b) {
      const aa = a.orderAnchor === undefined ? Number.MAX_SAFE_INTEGER : a.orderAnchor;
      const bb = b.orderAnchor === undefined ? Number.MAX_SAFE_INTEGER : b.orderAnchor;
      return aa - bb || (Number(a.start) || 0) - (Number(b.start) || 0)
        || (Number(a.noteIndex) || 0) - (Number(b.noteIndex) || 0)
        || (Number(a.index) || 0) - (Number(b.index) || 0);
    });
    return out;
  }

  /** 兼容旧调用：正文仍保留原 Fields 序号，注文带稳定容器元数据。 */
  function scanFields(target) {
    return scanFieldRefs(target).filter(function (r) { return !!r.field; }).map(function (r) {
      return { index: r.index, code: r.code, start: r.start, end: r.end, text: r.text, field: r.field, container: r.container, noteIndex: r.noteIndex, noteID: r.noteID, note: r.note, adjacent: r.adjacent };
    });
  }

  function addFieldAtRange(d, range) {
    let first = null;
    try { return d.Fields.Add(range, 81, " ", false); }
    catch (e) { first = e; }
    try { return d.Fields.Add(range, -1, " ", false); }
    catch (e) { const error = new Error("Fields.Add 失败：" + String((e && e.message) || e) + "（wdFieldAddin: " + String((first && first.message) || first) + "）"); error.cause = e; throw error; }
  }

  function deleteInsertedField(field, note) {
    let error = null;
    try { if (field && typeof field.Delete === "function") field.Delete(); } catch (e) { error = e; }
    if (note) { try { if (typeof note.Delete === "function") note.Delete(); } catch (e) { if (!error) error = e; } }
    if (error) throw error;
    return true;
  }

  /** 建注与建域是一个小事务；Fields.Add 任一路径失败都删除本次空注。 */
  function insertNativeField(noteType, range) {
    const d = doc(), type = Number(noteType) || 0;
    if (!type) return { field: addFieldAtRange(d, range), note: null, container: "body", noteIndex: 0, noteID: null };
    const isFoot = type === 1, collectionName = isFoot ? "Footnotes" : "Endnotes";
    let notes = null;
    try { notes = d[collectionName]; } catch (e) { notes = null; }
    if (!notes || typeof notes.Add !== "function") {
      try { const selection = app().Selection; notes = selection && selection[collectionName]; } catch (e) { notes = null; }
    }
    if (!notes || typeof notes.Add !== "function") throw new Error("这个 WPS 版本不支持" + (isFoot ? "脚注" : "尾注") + "集合 Add，已禁止正文兜底写入");
    let note = null;
    try {
      note = notes.Add(range, "");
      if (!note || !note.Range) throw new Error("新建注没有 Range");
      const field = addFieldAtRange(d, note.Range);
      if (!field) throw new Error("Fields.Add 返回 null，未建立可用域");
      const desc = noteDescriptor(note, isFoot ? "footnote" : "endnote", 0);
      return { field: field, note: note, container: desc.container, noteIndex: desc.noteIndex, noteID: desc.noteID };
    } catch (e) {
      if (note) { try { if (typeof note.Delete === "function") note.Delete(); } catch (ignored) { /* 原错误优先，诊断如实保留 */ } }
      throw e;
    }
  }

  function restoreField(old) {
    const f = old && old.field;
    if (!f) throw new Error("原域引用不可用");
    f.Code.Text = String(old.code || "");
    if (String(f.Code.Text || "") !== String(old.code || "")) throw new Error("域代码恢复回读不一致");
    f.Result.Text = String(old.text || "");
    if (String(f.Result.Text || "") !== String(old.text || "")) throw new Error("域文本恢复回读不一致");
    const d = doc();
    (old.bookmarks || []).forEach(function (bm) {
      if (!d.Bookmarks.Exists(bm.name)) d.Bookmarks.Add(bm.name, d.Range(Number(bm.start), Number(bm.end)));
    });
    return true;
  }

  function fieldRichSnapshot(field) {
    const result = field && field.Result;
    const snap = { code: String(field.Code.Text || ""), text: String(result.Text || ""), rich: null };
    try { snap.rich = result.FormattedText || null; } catch (e) { snap.rich = null; }
    return snap;
  }

  /** 无 FormattedText 时，只有宿主明确报告所有字符装饰均为关闭才允许纯文本复制。 */
  function provablyPlainResult(result, text) {
    if (!text) return true;
    if (!result || !result.Font) return false;
    const flags = ["Superscript", "Subscript", "Italic", "Bold", "SmallCaps", "Underline",
      "StrikeThrough", "DoubleStrikeThrough", "Outline", "Shadow", "Emboss", "Engrave", "AllCaps", "Hidden"];
    try {
      for (let i = 0; i < flags.length; i++) {
        const value = result.Font[flags[i]];
        // wdUndefined(9999999) 表示混合格式；未知值同样不能证明无格式。
        if (value !== false && value !== 0) return false;
      }
      return true;
    } catch (e) { return false; }
  }

  /**
   * 单个域跨容器安全重建。先建目标并回读代码/文本，再删旧域；失败删本次目标注和半域。
   * 富文本优先 FormattedText；不可用时明确返回不支持，不用纯文本冒充无损转换。
   */
  function convertOne(ref, targetNoteType) {
    const targetType = Number(targetNoteType) || 0, source = ref.field, oldType = ref.container === "footnote" ? 1 : ref.container === "endnote" ? 2 : 0;
    if (!source || oldType === targetType) return { ok: true, changed: false, field: source };
    const snap = fieldRichSnapshot(source);
    // 同注集合间优先使用 WPS 原生 Convert；成功后仍由上层重扫验证。
    if (oldType > 0 && targetType > 0) {
      if (!ref.note || typeof ref.note.Convert !== "function") {
        throw new Error("CONVERT_UNSUPPORTED: 当前 WPS 不支持注文容器之间的原生 Convert，已禁止可能丢锚点的重建");
      }
      let nativeCalled = false;
      try {
        ref.note.Convert();
        nativeCalled = true;                 // 只有 Convert 成功返回才算“已执行”
        let convertedField = null;
        const fields = ref.note.Range && ref.note.Range.Fields;
        for (let i = 1; fields && i <= (Number(fields.Count) || 0); i++) {
          const candidate = fields.Item(i);
          if (String(candidate.Code.Text || "") === snap.code) { convertedField = candidate; break; }
        }
        if (!convertedField) throw new Error("原生 Convert 后无法回读原域");
        const container = targetType === 1 ? "footnote" : "endnote";
        const noteIndex = Number(ref.note.Index) || ref.noteIndex;
        const noteID = container + ":" + noteIndex;
        /* 原生 Convert 可能“调用成功但什么都没做”（部分 WPS 版本）。必须用统一扫描
         * 确认域真的落在目标注集合里，否则会把脚注当成尾注写进映射。 */
        let located = false;
        try {
          located = scanFieldRefs(doc()).some(function (row) {
            return row.container === container && (row.field === convertedField || String(row.code || "") === snap.code);
          });
        } catch (e) { located = true; }   // 扫描不可用时不让正常转换失败
        if (!located) throw new Error("原生 Convert 返回成功但域没有进入" + (targetType === 1 ? "脚注" : "尾注") + "集合，已停止后续转换");
        /* 原生转换也必须显式带回逆序恢复引用。上层不能只依赖普通返回值
         * 碰巧带有 field/note，否则批量转换中后续失败时会漏掉本次原生转换。 */
        const rollback = { field: convertedField, note: ref.note, container: container, noteIndex: noteIndex, noteID: noteID };
        return { ok: true, changed: true, native: true, field: convertedField, note: ref.note, container: container, noteIndex: noteIndex, noteID: noteID, rollback: rollback };
      } catch (e) {
        if (nativeCalled) throw new Error("原生 Convert 已执行但回读验证失败，已停止后续转换：" + String((e && e.message) || e));
        /* 同注集合之间没有安全的重建路径：原生 Convert 失败就明确失败，
         * 绝不用“新建另一个注 + 删旧注”冒充等价转换（锚点/编号可能改变）。 */
        throw new Error("原生 Convert 失败，无法在脚注/尾注之间安全重建：" + String((e && e.message) || e));
      }
    }
    let range = null;
    try {
      if (oldType === 0) {
        range = doc().Range(Number(source.Result.End), Number(source.Result.End));
      } else if (ref.note && ref.note.Reference) {
        const reference = ref.note.Reference;
        range = doc().Range(Number(reference.End), Number(reference.End));
      }
    } catch (e) { range = null; }
    if (!range) throw new Error("CONVERT_UNSUPPORTED: 无法取得安全的源/目标 Range");
    if (!snap.rich && !provablyPlainResult(source.Result, snap.text)) {
      throw new Error("CONVERT_UNSUPPORTED: 当前 WPS 未提供可验证的 FormattedText 通道，且无法证明原域没有字符格式，已禁止可能丢格式的转换");
    }
    let made = null, sourceDeleted = false;
    if (oldType > 0 && targetType === 0 && (!ref.note || typeof ref.note.Delete !== "function")) {
      throw new Error("CONVERT_UNSUPPORTED: 注文转正文后必须删除原空注，但当前 WPS 未提供 note.Delete");
    }
    const oldBodyRange = oldType === 0 ? { start: Number(source.Result.Start), end: Number(source.Result.End) } : null;
    try {
      made = insertNativeField(targetType, range);
      made.field.Code.Text = snap.code;
      if (String(made.field.Code.Text || "") !== snap.code) throw new Error("目标域代码回读不一致");
      let richWritten = false;
      if (snap.rich) {
        try { made.field.Result.FormattedText = snap.rich; richWritten = String(made.field.Result.Text || "") === snap.text; } catch (e) { richWritten = false; }
      }
      if (!richWritten) {
        // 无富文本通道时仅允许本身无字符级格式的域，仍保留显示文本。
        made.field.Result.Text = snap.text;
        if (String(made.field.Result.Text || "") !== snap.text) throw new Error("目标域文本回读不一致");
      }
      source.Delete();
      sourceDeleted = true;
      if (ref.note && typeof ref.note.Delete === "function") ref.note.Delete();
      return { ok: true, changed: true, field: made.field, note: made.note, container: made.container, noteIndex: made.noteIndex, noteID: made.noteID };
    } catch (e) {
      if (sourceDeleted) {
        // 删除旧注失败等异常：先在原位置恢复原域，再清理目标，不丢 citationID。
        try {
          const originalRange = oldType === 0 ? doc().Range(oldBodyRange.start, oldBodyRange.end) : ref.note.Range;
          const restored = addFieldAtRange(doc(), originalRange);
          restored.Code.Text = snap.code;
          if (snap.rich) restored.Result.FormattedText = snap.rich; else restored.Result.Text = snap.text;
        } catch (restoreError) {
          e.message = String(e.message || e) + "；原域恢复也失败，请立即撤销并保留备份";
        }
      }
      if (made) { try { deleteInsertedField(made.field, made.note); } catch (ignored) { /* 保留原失败 */ } }
      throw e;
    }
  }

  /** 光标是否落在某个域里？正文与注文共用统一扫描，返回可定位域引用。 */
  function fieldAtCursor() {
    const d = doc();
    let pos = 0;
    try { pos = Number(app().Selection.Range.Start) || 0; } catch (e) { return null; }
    let refs = [];
    try { refs = scanFieldRefs(d); } catch (e) { return null; }
    for (let i = 0; i < refs.length; i++) {
      const ref = refs[i], f = ref.field;
      if (!f) continue;
      let s = 0, e2 = 0;
      try { s = Number(f.Result.Start) || 0; e2 = Number(f.Result.End) || 0; } catch (e) { continue; }
      if (pos >= s - 1 && pos <= e2 + 1) {
        return { index: ref.index, code: ref.code, field: f, container: ref.container,
          noteIndex: ref.noteIndex, noteID: ref.noteID, start: s, end: e2 };
      }
    }
    return null;
  }

  /** 文献表：没有锚就建一个（文末），有就返回它的范围 */
  function bibAnchor() {
    const d = doc();
    if (d.Bookmarks.Exists(BIB)) return { name: BIB, fresh: false };
    const end = d.Content;
    // 0 = wdCollapseEnd（端点在末尾）。WdCollapseDirection 是 End=0 / Start=1。
    try { end.Collapse(0); } catch (e) { /* 不支持就整段 */ }
    d.Bookmarks.Add(BIB, end);
    return { name: BIB, fresh: true };
  }

  /** 用段落数组替换文献表锚点范围 */
  function setBib(lines) {
    const d = doc();
    bibAnchor();
    const bm = d.Bookmarks.Item(BIB);
    const r = bm.Range;
    r.Text = "";
    const text = (lines || []).join("\r");
    if (text) {
      r.InsertAfter(text);
      r.End = r.Start + text.length;
    }
    if (!d.Bookmarks.Exists(BIB)) d.Bookmarks.Add(BIB, r);
    return true;
  }

  /** 文档属性探测（存在就用它存样式名等非关键元数据，失败静默降级） */
  function meta(key, value) {
    try {
      const props = doc().CustomDocumentProperties;
      if (value === undefined) {
        for (let i = 1; i <= props.Count; i++) {
          if (String(props.Item(i).Name) === key) return String(props.Item(i).Value);
        }
        return "";
      }
      for (let i = 1; i <= props.Count; i++) {
        if (String(props.Item(i).Name) === key) {
          props.Item(i).Value = String(value);
          return String(value);
        }
      }
      props.Add(key, false, 4 /* msoPropertyTypeString */, String(value));
      return String(value);
    } catch (e) {
      return "";
    }
  }

  const api = {
    BIB, BIB_HEAD, app, doc, docPath, documentID, listDocuments, paragraphSnapshot, writeStaticBlocks,
    scan, scanFields, scanFieldRefs, fieldAtCursor, exists, setText, remove,
    insertAtCursor, insertNativeField, deleteInsertedField, restoreField, convertOne, fieldRichSnapshot,
    gotoBookmark, citationAtCursor, bibAnchor, setBib, meta,
    bibBookmarkName, parseBibBookmark, replaceBibBookmarks, gotoBibItem, bibEntryAtCursor,
  };
  root.PPDoc = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
