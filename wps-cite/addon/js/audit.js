// SPDX-License-Identifier: Apache-2.0
/* 引文修改记录：每文档最多 200 条；同步内存接口 + localStorage + 本地代理持久化。
 *
 * P2-4 契约：
 *   - 一次操作最终完成后只写一条；取消（cancelled）不记；记录失败不阻断业务。
 *   - 字段：时间 / 操作 / 文档 / 数量 / 前后摘要 / 结果 / operationID / 手动或自动。
 *   - 不记录完整正文、完整域 JSON 或 DOI 列表，摘要统一截断。
 *   - 查看、导出、清空：导出与清空必须显式确认。
 */
(function (root) {
  "use strict";
  const PREFIX = "papilot-cite.audit.v1.";
  const CONFIG_URL = "http://127.0.0.1:21932/config";
  const CONFIG_KEY = "citeDocumentAudit";
  const LIMIT = 200;
  const memory = new Map();
  let hydratePromise = null;
  let writeQueue = Promise.resolve();
  let pendingWrites = 0;
  let lastPersistenceError = "";

  const OPERATION_LABELS = {
    addCitation: "插入引文", editCitation: "编辑引文", addEditCitation: "插入/编辑引文",
    addBibliography: "插入文献表", editBibliography: "编辑文献表", addEditBibliography: "插入/编辑文献表",
    addNote: "插入注释", addAnnotation: "插入标注", citationExplorer: "引文浏览器",
    refresh: "刷新", removeCodes: "移除域代码", setDocPrefs: "文档首选项", exportDocument: "导出文档",
    styleChange: "样式切换", addUncited: "补入未引文献",
  };
  const KIND_BY_OPERATION = {
    addCitation: "create", editCitation: "edit", addEditCitation: "edit",
    addBibliography: "bibliography", editBibliography: "bibliography", addEditBibliography: "bibliography",
    styleChange: "style", addUncited: "edit", refresh: "refresh",
    removeCodes: "unlink", exportDocument: "export",
  };

  function keyOf(documentID) { return PREFIX + String(documentID || "unknown"); }
  function request(options) {
    if (typeof root.fetch !== "function") return Promise.reject(new Error("fetch 不可用"));
    return Promise.resolve().then(function () { return root.fetch(CONFIG_URL, options || {}); });
  }
  function mergeRemote(config) {
    const rows = config && config[CONFIG_KEY];
    if (!rows || typeof rows !== "object" || Array.isArray(rows)) return;
    Object.keys(rows).forEach(function (documentID) {
      const key = keyOf(documentID), value = rows[documentID];
      if (!memory.has(key) && Array.isArray(value)) memory.set(key, JSON.stringify(value.slice(-LIMIT)));
    });
  }
  function hydrate() {
    if (hydratePromise) return hydratePromise;
    hydratePromise = request({ method: "GET" }).then(function (res) {
      if (!res || !res.ok) throw new Error("审计水合 HTTP " + (res && res.status || "未知"));
      return res.json ? res.json() : res.text().then(function (text) { return JSON.parse(text || "{}"); });
    }).then(function (config) {
      mergeRemote(config);
      lastPersistenceError = "";
      return true;
    }).catch(function (e) {
      lastPersistenceError = String((e && e.message) || e);
      hydratePromise = null;       // 下次读/写可重试，不能永久退成内存态
      return false;
    });
    return hydratePromise;
  }
  function snapshot() {
    const out = {};
    memory.forEach(function (raw, key) {
      try {
        const rows = JSON.parse(raw);
        if (Array.isArray(rows)) out[key.slice(PREFIX.length)] = rows.slice(-LIMIT);
      } catch (e) { /* 只持久化合法记录 */ }
    });
    return out;
  }
  function persist() {
    pendingWrites++;
    writeQueue = writeQueue.then(function () {
      return hydrate().then(function (hydrated) {
        if (!hydrated) return false;
        const body = {};
        body[CONFIG_KEY] = snapshot();
        return request({
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        }).then(function (res) {
          if (!res || !res.ok) throw new Error("审计落盘 HTTP " + (res && res.status || "未知"));
          lastPersistenceError = "";
          return true;
        });
      });
    }).catch(function (e) {
      lastPersistenceError = String((e && e.message) || e);
      return false;
    }).then(function (result) {
      pendingWrites--;
      return result;
    });
    return writeQueue;
  }
  function list(documentID) {
    hydrate();
    const key = keyOf(documentID);
    let raw = memory.get(key) || "[]";
    try { if (root.localStorage) raw = root.localStorage.getItem(key) || raw; } catch (e) { /* 代理仍是持久化通道 */ }
    try { const a = JSON.parse(raw); return Array.isArray(a) ? a.slice(-LIMIT) : []; } catch (e) { return []; }
  }
  function save(documentID, rows) {
    const raw = JSON.stringify(rows.slice(-LIMIT));
    memory.set(keyOf(documentID), raw);
    try { if (root.localStorage) root.localStorage.setItem(keyOf(documentID), raw); } catch (e) { /* 不依赖 localStorage */ }
    persist();
  }
  function clip(value, max) {
    return String(value == null ? "" : value).replace(/\s+/g, " ").trim().slice(0, max || 160);
  }
  function record(documentID, entry) {
    const e = entry || {};
    if (e.cancelled) return { ok: true, skipped: true };
    try {
      const operation = String(e.operation || "unknown");
      const rows = list(documentID);
      const result = String(e.result || (e.ok === false ? "failed" : "success"));
      rows.push({
        at: new Date().toISOString(), operation: operation,
        label: OPERATION_LABELS[operation] || operation,
        kind: String(e.kind || KIND_BY_OPERATION[operation] || "other"),
        result: result, ok: result !== "failed",
        count: Math.max(0, Number(e.count) || 0),
        from: clip(e.from, 160), to: clip(e.to, 160),
        summary: clip(e.summary, 160),
        mode: e.mode === "auto" ? "auto" : "manual",
        /* 只留文件名，不把完整本地路径写进记录/导出。 */
        document: clip(String(documentID || "unknown").split(/[\\/]/).pop(), 120),
        operationID: String(e.operationID || ""),
      });
      save(documentID, rows);
      return { ok: true };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  }
  function clear(documentID, confirmed) {
    if (!confirmed) return { ok: false, code: "CONFIRM_REQUIRED" };
    save(documentID, []); return { ok: true };
  }
  function exportRows(documentID, confirmed) {
    if (!confirmed) return { ok: false, code: "CONFIRM_REQUIRED" };
    const rows = list(documentID);
    return { ok: true, rows: rows, text: rowsText(rows) };
  }
  function rowsText(rows) {
    const listRows = Array.isArray(rows) ? rows : [];
    const doc = listRows.length && listRows[listRows.length - 1].document || "当前文档";
    const lines = [
      "Papilot Cite 引文修改记录（每文档最多 " + LIMIT + " 条）",
      "文档：" + doc,
      "共 " + listRows.length + " 条；导出不包含正文全文。",
      "",
    ];
    listRows.forEach(function (row, i) {
      lines.push((i + 1) + ". " + (row.at || "") + " · " + (row.label || row.operation || "未知操作")
        + " · " + (row.result || "") + (row.mode === "auto" ? "（自动）" : "（手动）")
        + " · 数量 " + (row.count == null ? "0" : row.count));
      if (row.from || row.to) lines.push("   前：" + (row.from || "—") + " → 后：" + (row.to || "—"));
      if (row.summary) lines.push("   " + row.summary);
      if (row.operationID) lines.push("   operationID：" + row.operationID);
    });
    return lines.join("\n");
  }
  function persistenceStatus() { return { hydrated: !!hydratePromise, pending: pendingWrites > 0, error: lastPersistenceError }; }

  const api = {
    record: record, list: list, clear: clear, exportRows: exportRows, rowsText: rowsText,
    hydrate: hydrate, flush: function () { return writeQueue; }, persistenceStatus: persistenceStatus,
    LIMIT: LIMIT, labelOf: function (operation) { return OPERATION_LABELS[operation] || String(operation || ""); },
    OPERATION_LABELS: OPERATION_LABELS,
  };
  root.PPAudit = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  hydrate();
})(typeof globalThis !== "undefined" ? globalThis : this);
