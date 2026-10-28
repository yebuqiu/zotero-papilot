// SPDX-License-Identifier: Apache-2.0
/* WPS 能力矩阵：逐能力探测、按文档缓存，任何探测失败只降级对应能力。 */
(function (root) {
  "use strict";
  const cache = new Map();

  function call(fn, fallback) {
    try { return fn(); } catch (e) { return fallback; }
  }
  function collection(d, name) {
    return call(function () { return d && d[name]; }, null);
  }
  function probe(documentID, d) {
    const selection = call(function () { return root.PPDoc.app().Selection; }, null);
    const footnotes = collection(d, "Footnotes") || collection(selection, "Footnotes");
    const endnotes = collection(d, "Endnotes") || collection(selection, "Endnotes");
    const bodyFields = collection(d, "Fields");
    const bookmarks = collection(d, "Bookmarks");
    const footRange = call(function () { return footnotes.Count > 0 ? footnotes.Item(1).Range : null; }, null);
    const endRange = call(function () { return endnotes.Count > 0 ? endnotes.Item(1).Range : null; }, null);
    const matrix = {
      documentID: String(documentID || "unknown"),
      bodyFields: !!bodyFields && typeof bodyFields.Item === "function",
      footnotes: !!footnotes && typeof footnotes.Item === "function",
      endnotes: !!endnotes && typeof endnotes.Item === "function",
      footnoteAdd: !!footnotes && typeof footnotes.Add === "function",
      endnoteAdd: !!endnotes && typeof endnotes.Add === "function",
      noteFields: !!(footRange || endRange) || ((!!footnotes && typeof footnotes.Item === "function") || (!!endnotes && typeof endnotes.Item === "function")),
      noteConvert: call(function () {
        return !!((footnotes.Count > 0 && typeof footnotes.Item(1).Convert === "function") ||
          (endnotes.Count > 0 && typeof endnotes.Item(1).Convert === "function"));
      }, false),
      bookmarks: !!bookmarks && typeof bookmarks.Add === "function" && typeof bookmarks.Exists === "function",
      range: !!d && typeof d.Range === "function",
      richText: call(function () {
        const r = d.Content;
        return !!r && ("FormattedText" in r);
      }, false),
      warnings: [],
      probedAt: Date.now(),
    };
    matrix.convert = !!matrix.range && (matrix.noteConvert || matrix.richText);
    matrix.bodyToFootnote = matrix.convert && matrix.footnoteAdd;
    matrix.bodyToEndnote = matrix.convert && matrix.endnoteAdd;
    return matrix;
  }
  function get(documentID, d, refresh) {
    const key = String(documentID || "unknown");
    if (!refresh && cache.has(key)) return cache.get(key);
    const value = probe(key, d || call(function () { return root.PPDoc.doc(); }, null));
    if (!value.bodyFields) value.warnings.push("正文域枚举不可用");
    if (!value.footnotes || !value.endnotes) value.warnings.push("部分注文集合不可用，对应注文能力已禁用");
    if (!value.bookmarks) value.warnings.push("书签不可用，条目跳转采用明确失败而非猜测");
    cache.set(key, value);
    return value;
  }
  function clear(documentID) {
    if (documentID == null) cache.clear(); else cache.delete(String(documentID));
  }
  const api = { get: get, probe: probe, clear: clear };
  root.PPCapabilities = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
