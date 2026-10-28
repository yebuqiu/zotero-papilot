// SPDX-License-Identifier: Apache-2.0
/* 引文上下文五动作。没有原生右键 API 时由 Ribbon 的“引文操作”调用同一模型。 */
(function (root) {
  "use strict";
  const ACTION_IDS = ["edit", "bibliography", "zotero", "pdf", "info"];
  const LABELS = { edit: "编辑引文", bibliography: "转至参考文献", zotero: "在 Zotero 中显示", pdf: "打开 PDF", info: "引用信息" };
  function current() {
    if (!root.PPDoc) return null;
    const at = root.PPDoc.fieldAtCursor && root.PPDoc.fieldAtCursor();
    if (!at) return null;
    const parsed = root.PPZFields && root.PPZFields.parseField(at.code || at.Code && at.Code.Text || "");
    if (!parsed || parsed.kind !== "item") return null;
    return { field: at.field || at, code: at.code || at.Code && at.Code.Text || "",
      citationID: parsed.citationID, items: parsed.items || [], parseError: parsed.error || "" };
  }
  function describe(item) {
    const d = item && item.itemData || {};
    const creators = d.author || d.editor || [];
    const first = creators[0] || {};
    const parts = d.issued && d.issued["date-parts"];
    const year = parts && parts[0] && parts[0][0] || (String(d.date || "").match(/\d{4}/) || [""])[0];
    return [d.title || item && item.key || "(无标题)", first.family || first.literal || "未知作者", year || "年份未知"].join(" · ");
  }
  function actions(fieldRef, pdfAvailable) {
    const ref = fieldRef || null;
    return ACTION_IDS.map(function (id) {
      const action = { id: id, label: LABELS[id], enabled: !!ref, reason: ref ? "" : "光标不在引文上", items: ref ? ref.items || [] : [] };
      if (id === "pdf" && ref && pdfAvailable === false) { action.enabled = false; action.reason = "该条目没有可用 PDF，其他引文操作仍可使用"; }
      if (id === "edit" && ref && ref.parseError) { action.enabled = false; action.reason = "域代码损坏，请先定位修复"; }
      return action;
    });
  }
  function registerNative(handler) {
    const w = root.wps;
    if (!w || !w.contextMenus || typeof w.contextMenus.create !== "function") return false;
    try {
      ACTION_IDS.forEach(function (id) {
        w.contextMenus.create({ id: "papilot-cite-" + id, title: LABELS[id], contexts: ["selection"], onclick: function () {
          const ref = current();
          if (ref) handler(id, ref);
        } });
      });
      return true;
    } catch (e) { return false; }
  }
  function execute(id, ref) {
    if (!ref) return { ok: false, error: "光标不在引文上" };
    if (!root.PPApp) return { ok: false, error: "主命令模块未就绪" };
    if (id === "edit") return root.PPApp.editFieldCitation(ref);
    if (id === "bibliography") return root.PPNav.toBibliography(ref);
    if (id === "zotero" || id === "pdf") return root.PPApp.openCitationTarget(ref, id);
    if (id === "info") return root.PPApp.citationInfo(ref);
    return { ok: false, error: "未知引文动作" };
  }
  const api = { actions: actions, current: current, describe: describe, execute: execute,
    registerNative: registerNative, ACTION_IDS: ACTION_IDS };
  root.PPContext = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
