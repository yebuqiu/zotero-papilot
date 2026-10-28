// SPDX-License-Identifier: Apache-2.0
/* 引文管理数据模型：一行一个物理域，搜索与界面降级共用同一份快照。 */
(function (root) {
  "use strict";
  let rows = [];
  let scanSnapshot = null;
  let healthIssues = [];
  const selected = new Set();

  function itemMeta(item) {
    const d = item && item.itemData || {};
    const creators = d.author || d.editor || d.contributor || [];
    const first = creators[0] || {};
    const parts = d.issued && d.issued["date-parts"];
    const date = parts && parts[0] && parts[0][0] || d.date || d.issued && d.issued.raw || "";
    const year = /(\d{4})/.exec(String(date));
    return {
      identity: root.PPZFields ? root.PPZFields.canonicalIdentity(item) : String(item && item.key || ""),
      item: item, title: String(d.title || "(无标题)"),
      author: String(first.family || first.literal || first.name || ""),
      year: year ? year[1] : "", locator: String(item && item.locator || ""),
    };
  }
  function chapterOf(field) {
    try {
      const p = field && field.range && field.range.Paragraphs && field.range.Paragraphs.Item(1);
      return String(field.chapter || p && (p.OutlineLevel || p.Style) || "");
    } catch (e) { return String(field && field.chapter || ""); }
  }
  function load(scan, health) {
    scanSnapshot = scan || { fields: [], issues: [] };
    healthIssues = Array.isArray(health) ? health : health && health.issues || scanSnapshot.issues || [];
    selected.clear();
    rows = (scanSnapshot.fields || []).map(function (field, index) {
      const issues = healthIssues.filter(function (x) { return x && x.fieldID === field.fieldID; });
      const items = (field.items || []).map(itemMeta);
      return {
        n: index + 1, fieldID: field.fieldID, citationID: field.citationID || "",
        field: field, text: String(field.text || ""), items: items,
        title: items.map(function (x) { return x.title; }).join(" / "),
        author: items.map(function (x) { return x.author; }).filter(Boolean).join(" / "),
        year: items.map(function (x) { return x.year; }).filter(Boolean).join(" / "),
        locator: items.map(function (x) { return x.locator; }).filter(Boolean).join(" / "),
        container: field.container || "body", noteIndex: Number(field.noteIndex) || 0,
        chapter: chapterOf(field), issues: issues, broken: !!field.parseError || issues.length > 0,
        issueText: issues.map(function (x) { return x.summary + "：" + x.reason; }).join("；"),
      };
    });
    return rows.slice();
  }
  function search(query, abnormalOnly) {
    const q = String(query || "").trim().toLocaleLowerCase();
    return rows.filter(function (row) {
      if (abnormalOnly && !row.broken) return false;
      if (!q) return true;
      return [row.text, row.title, row.author, row.year, row.locator, row.chapter,
        row.container, String(row.noteIndex || ""), row.issueText].join(" ").toLocaleLowerCase().indexOf(q) >= 0;
    });
  }
  function row(fieldID) { return rows.find(function (x) { return x.fieldID === fieldID; }) || null; }
  function setSelected(fieldID, checked) {
    if (!row(fieldID)) return false;
    if (checked) selected.add(fieldID); else selected.delete(fieldID);
    return true;
  }
  function selectedIdentities() {
    const seen = new Set(), out = [];
    selected.forEach(function (id) {
      const r = row(id);
      (r && r.items || []).forEach(function (x) {
        if (!seen.has(x.identity)) { seen.add(x.identity); out.push(x.item); }
      });
    });
    return out;
  }
  function command(action, fieldID) {
    return { action: action, fieldID: fieldID, documentID: scanSnapshot && scanSnapshot.documentID || "" };
  }
  const api = { load: load, search: search, row: row, selectedIdentities: selectedIdentities,
    setSelected: setSelected, command: command, rows: function () { return rows.slice(); } };
  root.PPManager = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
