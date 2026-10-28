// SPDX-License-Identifier: Apache-2.0
/* 统一正文/脚注/尾注扫描快照。Range 仅在当前事务内使用。 */
(function (root) {
  "use strict";
  let revision = 0;
  function zfields() {
    if (root.PPZFields) return root.PPZFields;
    if (typeof require === "function") return require("./zfields.js");
    throw new Error("zfields.js 未加载");
  }
  function identityOf(item) { return zfields().canonicalIdentity(item); }
  function scan(document, options) {
    const d = document || root.PPDoc.doc();
    const refs = root.PPDoc.scanFieldRefs(d);
    const out = { documentID: root.PPDoc.documentID(d), revision: ++revision, fields: [], bibliography: [], issues: [], all: [] };
    const seen = new Map();
    refs.forEach(function (raw, order) {
      const code = String(raw.code || "");
      /* 候选判定必须覆盖 Word 方言、Zotero 内部方言与 LibreOffice 参考域；
       * 否则 LO 的 ITEM CSL_CITATION 会被归为 other，scan.fields/bibliography 双空，
       * 迁移检查误报 direct。 */
      const zoteroCandidate = /ZOTERO_ITEM|ZOTERO_BIBL|CSL_CITATION|CSL_BIBLIOGRAPHY|(?:^|\s)(?:ITEM|BIBL)\s+\{/i.test(code);
      const parsed = zoteroCandidate ? zfields().parseField(code) : null;
      const base = parsed && parsed.citationID ? "cid:" + parsed.citationID : "pos:" + raw.container + ":" + raw.noteID + ":" + raw.start + ":" + code.replace(/\s+/g, "").slice(0, 24);
      const occurrence = (seen.get(base) || 0) + 1;
      seen.set(base, occurrence);
      const ref = {
        fieldID: base + (occurrence > 1 ? "#" + occurrence : ""), citationID: parsed ? parsed.citationID : "",
        container: raw.container, noteIndex: raw.noteIndex, noteID: raw.noteID, range: raw.field && raw.field.Result,
        field: raw.field, index: raw.index, code: code, text: raw.text, start: raw.start, end: raw.end,
        items: parsed ? parsed.items : [], formattedCitation: parsed ? parsed.formattedCitation : "",
        parseError: parsed ? parsed.error || "" : (zoteroCandidate ? "BAD_JSON" : ""),
        kind: parsed ? parsed.kind : "other", order: order, adjacent: !!raw.adjacent, bookmarks: raw.bookmarks || [],
        identityKey: base, occurrence: occurrence,
      };
      Object.defineProperty(ref, "itemKeys", { enumerable: false, get: function () { return ref.items.map(identityOf); } });
      out.all.push(ref);
      if (ref.kind === "item" || (ref.parseError && /ZOTERO_ITEM|CSL_CITATION/i.test(code))) out.fields.push(ref);
      if (ref.kind === "bibl" || (ref.parseError && /ZOTERO_BIBL|CSL_BIBLIOGRAPHY/i.test(code))) out.bibliography.push(ref);
      if (raw.issue) out.issues.push(raw.issue);
      if (ref.parseError) out.issues.push({ kind: "BAD_FIELD", severity: "error", fieldID: ref.fieldID, noteIndex: ref.noteIndex, summary: "域代码损坏或不完整", reason: ref.parseError, action: "定位并恢复该引文域", target: ref });
    });
    return out;
  }
  function locate(ref, snapshot) {
    const all = snapshot && snapshot.all || [];
    if (!ref) return null;
    let matches = all.filter(function (x) { return x.fieldID === ref.fieldID; });
    if (!matches.length && ref.citationID) matches = all.filter(function (x) { return x.citationID === ref.citationID && x.container === ref.container && x.noteID === ref.noteID; });
    if (matches.length === 1) return matches[0].range || null;
    if (matches.length > 1) { const e = new Error("目标身份有歧义"); e.code = "AMBIGUOUS_TARGET"; throw e; }
    return null;
  }
  function fingerprint(scanResult) {
    const rows = scanResult.fields.concat(scanResult.bibliography).map(function (f) { return [f.fieldID, f.code, f.text, f.container, f.noteIndex]; });
    const s = JSON.stringify(rows);
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(16) + ":" + s.length;
  }
  const api = { scan: scan, locate: locate, fingerprint: fingerprint };
  root.PPFieldScanner = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
