// SPDX-License-Identifier: Apache-2.0
/* 刷新前真实快照、阶段日志与 touched 最小恢复。完整正文/域 JSON 不进入诊断。 */
(function (root) {
  "use strict";
  const backups = new Map(), good = new Map(), operations = new Map();
  function operationID() { return "pp-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8); }
  function snapshotField(ref) {
    return { fieldID: ref.fieldID || ref.id, code: String(ref.code || ""), text: String(ref.text || ""), container: ref.container || "body", noteID: ref.noteID || null, noteIndex: Number(ref.noteIndex) || 0, field: ref.field, bookmarks: ref.bookmarks || [] };
  }
  function begin(documentID, scan, docData) {
    const id = operationID();
    if (!scan || !Array.isArray(scan.all)) throw new Error("无法建立刷新前域快照，已禁止写入");
    if (typeof docData !== "string") throw new Error("无法读取 Zotero 文档数据备份，已禁止写入");
    const fields = scan.all.map(snapshotField);
    const backup = { operationID: id, documentID: String(documentID), docData: docData, fields: fields, createdAt: new Date().toISOString(), touched: new Map(), newFields: new Map(), docDataTouched: false, logs: [], retained: true };
    backups.set(id, backup); operations.set(String(documentID), backup);
    stage(backup, "backup", "complete", { fields: fields.length });
    return backup;
  }
  function stage(backup, name, result, detail) {
    if (!backup) return;
    backup.logs.push({ at: new Date().toISOString(), operationID: backup.operationID, stage: name, result: result, elapsed: Date.now() - new Date(backup.createdAt).getTime(), detail: detail || {} });
    if (backup.logs.length > 6000) backup.logs.shift();
  }
  function snapshotTouched(backup, ref, isNew) {
    if (!backup || !ref) return;
    const id = String(ref.fieldID || ref.id);
    if (!id) return;
    if (isNew) { if (!backup.newFields.has(id)) backup.newFields.set(id, { id: id, field: ref.field, note: ref.note || null }); return; }
    if (!backup.touched.has(id)) {
      const old = backup.fields.find(function (f) { return String(f.fieldID) === id; });
      if (old) backup.touched.set(id, old);
    }
  }
  function touchDocumentData(backup) { if (backup) backup.docDataTouched = true; }
  function commit(backup) {
    if (!backup) return;
    stage(backup, "commit", "complete", { touched: backup.touched.size, created: backup.newFields.size });
    good.set(backup.documentID, backup); backups.delete(backup.operationID);
    if (operations.get(backup.documentID) === backup) operations.delete(backup.documentID);
  }
  function restore(backup) {
    if (!backup) return { ok: true, restored: 0 };
    stage(backup, "restore", "begin", { touched: backup.touched.size });
    const failures = [];
    let restored = 0;
    try {
      const refs = root.PPDoc.scanFieldRefs(root.PPDoc.doc());
      backup.newFields.forEach(function (entry) {
        try { root.PPDoc.deleteInsertedField(entry.field, entry.note); restored++; }
        catch (e) { failures.push("删除本次新域失败"); }
      });
    } catch (e) { failures.push("重扫描失败"); }
    // 逆序最小恢复，避免较早 Range 移动影响后续位置。
    const touched = Array.from(backup.touched.values()).reverse();
    for (const old of touched) {
      try { root.PPDoc.restoreField(old); restored++; }
      catch (e) { failures.push(String(old.fieldID) + " 恢复失败"); break; }
    }
    if (!failures.length && backup.docDataTouched) {
      try {
        root.PPIntegration.__writeDocDataForRecovery(backup.docData);
        if (root.PPIntegration.__readDocDataForRecovery() !== backup.docData) throw new Error("docData 回读不一致");
        restored++;
      } catch (e) { failures.push("文档数据恢复失败"); }
    }
    const result = { ok: failures.length === 0, code: failures.length ? "RESTORE_FAILED" : "RESTORED", restored: restored, failures: failures, backupRetained: true, operationID: backup.operationID };
    stage(backup, "restore", result.ok ? "verified" : "failed", { failures: failures });
    if (result.ok) backups.delete(backup.operationID); else backups.set(backup.operationID, backup);
    if (operations.get(backup.documentID) === backup) operations.delete(backup.documentID);
    return result;
  }
  function diagnostic(id) {
    const b = backups.get(id) || operations.get(String(id));
    if (!b) return null;
    return { operationID: b.operationID, documentID: b.documentID, createdAt: b.createdAt, docDataLength: b.docData.length, fieldCount: b.fields.length, touched: Array.from(b.touched.keys()), logs: b.logs.slice(-100), failures: b.logs.filter(function (x) { return x.result === "failed"; }) };
  }
  const api = { begin: begin, stage: stage, snapshotTouched: snapshotTouched, touchDocumentData: touchDocumentData, commit: commit, restore: restore, export: diagnostic, __backups: backups, __good: good };
  root.PPRecovery = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
