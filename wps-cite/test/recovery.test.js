// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* P0-4 安全刷新与自动恢复（+ P1-5 自动化的触发闸门）。
 *
 * 纪律（PRD P0-4）：
 *   - 刷新前必须成功备份，备份失败就禁止写入；
 *   - 失败后只恢复本次 touched 的域/文档数据，并回读验证；未触达的域一个字符都不动；
 *   - 恢复本身失败要如实返回 RESTORE_FAILED、保留备份供导出，且**不循环重试**；
 *   - getFields / setCode / setText / setDocumentData / complete 任一阶段失败，事务都要收尾、
 *     不能永久占用本地锁；日志必须含 operationID、阶段、耗时；
 *   - 自动化默认关闭；保存事件一次保存最多一个事务，忙/未保存/备份失败都不触发。
 *
 * 运行：node test/recovery.test.js
 */
"use strict";

const S = require("./helpers/wps-stub.js");

let failed = 0;
let passed = 0;

async function check(name, fn) {
  try {
    const note = await fn();
    passed += 1;
    console.log("  PASS " + name + (note ? "  [" + note + "]" : ""));
  } catch (e) {
    failed += 1;
    console.log("  FAIL " + name + " -> " + ((e && e.message) || e));
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const D = S.DOCID;
const DOC_DATA = '{"dataVersion":3,"style":{"styleID":"http://www.zotero.org/styles/apa"},"prefs":{"noteType":0}}';

function threeFields(extra) {
  const cfg = Object.assign({
    path: "C:/tmp/recovery.docx",
    contentText: "正文甲乙丙丁戊己庚辛",
    docData: DOC_DATA,
    fields: [
      { start: 10, code: S.wordItemCode("citeRec001", ["AAAA0001"]), text: "[1]" },
      { start: 20, code: S.wordItemCode("citeRec002", ["BBBB0002"]), text: "[2]" },
      { start: 30, code: S.wordItemCode("citeRec003", ["CCCC0003"]), text: "[3]" },
    ],
  }, extra || {});
  return S.createWorld(cfg);
}

function refreshScript(steps) {
  return [
    { cmd: "Application.getActiveDocument" },
    { cmd: "Document.getDocumentData", args: [D] },
    { cmd: "Document.getFields", args: [D, "Http"] },
  ].concat(steps || []).concat([
    { cmd: "Document.activate", args: [D] },
    { cmd: "Document.complete", args: [D] },
  ]);
}

(async function main() {
  console.log("== A. 失败注入：五个阶段都能收尾、不占锁 ==");

  await check("getFields 失败：明确报错、事务走完 complete、busy 释放", async function () {
    const w = threeFields();
    w.host.faults.bodyFields = "throw";
    w.setZotero(refreshScript());
    let err = null;
    try { await w.I.run("refresh"); } catch (e) { err = e; }
    assert(err, "正文域扫描失败却返回成功");
    assert(/正文域扫描失败/.test(err.message), "错误没讲清阶段：" + err.message);
    assert(w.zotero.steps[w.zotero.steps.length - 1].cmd === "Document.complete", "没有走到 complete");
    assert(w.I.__getBusy() === "", "busy 锁没有释放（用户会一直看到“上一个操作还没结束”）");
    return err.message.slice(0, 30);
  });

  await check("setCode 失败：只恢复本次 touched 的域，未触达域逐字不变", async function () {
    const w = threeFields();
    const before = w.snapshot();
    w.setZotero(refreshScript([{ cmd: "Field.setCode", args: [D, "@f1", S.itemCode("citeRec002", ["BBBB0002"])] }]));
    w.host.truncateNextCode = 1;                       // 只让这一次写码失败
    w.host.truncateNextLen = 40;
    let err = null;
    try { await w.I.run("refresh"); } catch (e) { err = e; }
    assert(err, "写码失败却返回成功");
    const after = w.snapshot();
    assert(after.body.length === 3, "域数变了：" + after.body.length);
    assert(after.body[0] === before.body[0], "未触达的第 1 个域被改了");
    assert(after.body[2] === before.body[2], "未触达的第 3 个域被改了");
    assert(after.body[1] === before.body[1], "触达的第 2 个域没有恢复到刷新前");
    const txn = w.I.__getTxn();
    assert(txn.backup && Array.from(txn.backup.touched.keys()).join(",") === "cid:citeRec002",
      "touched 集合不对：" + (txn.backup ? Array.from(txn.backup.touched.keys()).join(",") : "无备份"));
    const restoreLogs = txn.backup.logs.filter(function (l) { return l.stage === "restore"; });
    assert(restoreLogs.some(function (l) { return l.result === "verified"; }), "恢复没有做回读验证");
    return "1 touched / 2 未动";
  });

  await check("setText 失败：恢复到刷新前文本，且不回写未触达内容", async function () {
    const w = threeFields();
    const before = w.snapshot();
    w.setZotero(refreshScript([
      { cmd: "Field.setCode", args: [D, "@f0", S.itemCode("citeRec001", ["AAAA0001"])] },
      { cmd: "Field.setText", args: [D, "@f0", "<sup>[9]</sup>", true] },
    ]));
    w.host.textFailNext = 1;                            // 显示文本没写进去 → 回读不一致
    let err = null;
    try { await w.I.run("refresh"); } catch (e) { err = e; }
    assert(err, "显示文本写失败却返回成功");
    assert(/显示文本/.test(err.message), "错误没讲清阶段：" + err.message);
    const after = w.snapshot();
    assert(after.body[0] === before.body[0], "第 1 个域没有恢复到刷新前代码");
    assert(after.body[1] === before.body[1] && after.body[2] === before.body[2], "未触达域被改了");
    assert(w.state.bodyFields[0].Result.Text === "[1]", "显示文本没有恢复到刷新前：" + JSON.stringify(w.state.bodyFields[0].Result.Text));
    return "文本已恢复";
  });

  await check("setDocumentData 失败：文档数据恢复原样并回读校验", async function () {
    const w = threeFields();
    const original = w.I.__readDocDataForRecovery();
    w.setZotero(refreshScript([{ cmd: "Document.setDocumentData", args: [D, '{"dataVersion":3,"style":{"styleID":"http://www.zotero.org/styles/nature"}}'] }]));
    w.host.truncateNextProps = 1;
    let err = null;
    try { await w.I.run("refresh"); } catch (e) { err = e; }
    assert(err, "文档数据没存住却返回成功");
    assert(/文档数据/.test(err.message), "错误没讲清是文档数据：" + err.message);
    assert(w.I.__readDocDataForRecovery() === original, "文档数据没有恢复原样");
    return "docData 已恢复";
  });

  await check("complete 的应答失败不悬挂事务：结果照常返回、busy 释放", async function () {
    const w = threeFields();
    w.setZotero(refreshScript(), { failComplete: true });
    const r = await w.I.run("refresh");
    assert(r && r.ok === true, "complete 应答失败把正常事务判成了失败");
    assert(w.I.__getBusy() === "", "busy 锁没有释放");
    return "ok / 锁已释放";
  });

  await check("刷新前备份失败 → 禁止写入（一个 execCommand 都不发）", async function () {
    const w = threeFields();
    let exec = 0;
    w.http.handler = async (p) => { if (p.indexOf("execCommand") >= 0) exec += 1; return undefined; };
    const real = w.R.begin;
    w.R.begin = function () { throw new Error("桩：备份写入失败"); };
    let err = null;
    try { await w.I.run("refresh"); } catch (e) { err = e; }
    w.R.begin = real;
    assert(err, "备份失败却发起了事务");
    assert(/备份/.test(err.message), "错误没讲清是备份失败：" + err.message);
    assert(exec === 0, "备份失败后仍然发了 " + exec + " 次 execCommand");
    assert(w.I.__getBusy() === "", "busy 锁没有释放");
    return "0 次写入";
  });

  await check("恢复失败：RESTORE_FAILED、保留备份可导出、不循环重试", async function () {
    const w = threeFields();
    const backup = w.R.begin(w.doc.FullName, w.S.scan(w.doc), w.I.__readDocDataForRecovery());
    w.R.snapshotTouched(backup, { fieldID: "cid:citeRec001", code: "OLD-CODE", text: "old", container: "body" }, false);
    const real = w.sandbox.PPDoc.restoreField;
    let calls = 0;
    w.sandbox.PPDoc.restoreField = function () { calls += 1; throw new Error("桩：恢复写入失败"); };
    const res = w.R.restore(backup);
    w.sandbox.PPDoc.restoreField = real;
    assert(res.ok === false && res.code === "RESTORE_FAILED", "恢复失败没有如实返回：" + JSON.stringify(res));
    assert(res.backupRetained === true, "没有标记保留备份");
    assert(calls === 1, "恢复失败后重试了 " + calls + " 次（PRD 要求失败即停，不循环）");
    assert(w.R.__backups.has(backup.operationID), "失败后备份被删掉了（无法再导出）");
    const diag = w.R.export(backup.operationID);
    assert(diag && diag.operationID === backup.operationID, "备份诊断导不出来");
    return "1 次尝试 / 备份保留";
  });

  await check("事务日志含 operationID / 阶段 / 耗时 / 结果，且诊断不暴露正文", async function () {
    const w = threeFields();
    w.setZotero(refreshScript([{ cmd: "Field.setCode", args: [D, "@f1", S.itemCode("citeRec002", ["BBBB0002"])] }]));
    w.host.truncateNextCode = 1;
    w.host.truncateNextLen = 40;
    let err = null;
    try { await w.I.run("refresh"); } catch (e) { err = e; }
    assert(err, "预期失败但没有");
    const backup = w.I.__getTxn().backup;
    assert(backup && backup.logs.length > 0, "没有事务日志");
    for (const row of backup.logs) {
      assert(row.operationID === backup.operationID, "日志缺少 operationID");
      assert(typeof row.stage === "string" && row.stage, "日志缺少阶段");
      assert(typeof row.elapsed === "number", "日志缺少耗时");
      assert(typeof row.result === "string" && row.result, "日志缺少结果");
    }
    const failedRow = backup.logs.filter(function (l) { return l.stage === "transaction" && l.result === "failed"; })[0];
    assert(failedRow, "没有记录事务失败阶段");
    assert(String(failedRow.detail.error || "").length > 0, "失败日志没有原因");
    return backup.logs.length + " 条日志字段齐全";
  });

  await check("恢复失败时导出的诊断：含日志与数据长度，但不含正文/完整域 JSON", async function () {
    const w = threeFields();
    w.setZotero(refreshScript([{ cmd: "Field.setCode", args: [D, "@f1", S.itemCode("citeRec002", ["BBBB0002"])] }]));
    w.host.truncateNextCode = 1;
    w.host.truncateNextLen = 40;
    const real = w.sandbox.PPDoc.restoreField;
    w.sandbox.PPDoc.restoreField = function () { throw new Error("桩：恢复写入失败"); };
    let err = null;
    try { await w.I.run("refresh"); } catch (e) { err = e; }
    w.sandbox.PPDoc.restoreField = real;
    assert(err, "预期失败但没有");
    assert(/恢复未完全成功|备份已保留/.test(err.message), "错误没有提示备份已保留：" + err.message);
    const opID = w.I.__getTxn().backup.operationID;
    const diag = w.R.export(opID);
    assert(diag, "恢复失败后导不出诊断");
    const text = JSON.stringify(diag);
    assert(text.indexOf(w.host.content.Text) < 0, "诊断里出现了完整正文");
    assert(text.indexOf("citationItems") < 0, "诊断里出现了完整域 JSON");
    assert(typeof diag.docDataLength === "number" && diag.docDataLength > 0, "诊断没有给文档数据长度（无法判断大小）");
    assert(diag.logs.length > 0 && diag.logs[0].operationID === opID, "导出日志缺 operationID");
    assert(diag.touched.length === 1 && diag.touched[0] === "cid:citeRec002", "诊断的 touched 不对：" + JSON.stringify(diag.touched));
    return "日志 + 长度 / 无正文";
  });

  await check("恢复成功后备份转为“最近良好”，临时备份不残留", async function () {
    const w = threeFields();
    w.setZotero(refreshScript([{ cmd: "Field.setCode", args: [D, "@f0", S.itemCode("citeRec001", ["AAAA0001"])] }]));
    w.host.truncateNextCode = 1;
    w.host.truncateNextLen = 40;
    let err = null;
    try { await w.I.run("refresh"); } catch (e) { err = e; }
    assert(err, "预期失败但没有");
    const opID = w.I.__getTxn().backup.operationID;
    assert(!w.R.__backups.has(opID), "恢复成功后临时备份没有清掉");
    return "临时备份已清理";
  });

  console.log("\n== B. 既有行为保持：无变化 / 取消 / 长文档 / 连续刷新 ==");

  await check("无变化刷新：ok:true 且 changed=false（不能判成取消）", async function () {
    const w = threeFields();
    w.setZotero(refreshScript());
    const r = await w.I.run("refresh");
    assert(r.ok === true && r.changed === false, "无变化刷新被判错了：" + JSON.stringify(r));
    return "ok / 无变化";
  });

  await check("用户取消（全程无 setText）：cancelled=true，且不写文档数据", async function () {
    const w = threeFields();
    w.setZotero([
      { cmd: "Application.getActiveDocument" },
      { cmd: "Document.getDocumentData", args: [D] },
      { cmd: "Document.insertField", args: [D, "Http", 0] },
      { cmd: "Field.setCode", args: [D, "@field", "TEMP"] },
      { cmd: "Field.delete", args: [D, "@field"] },
      { cmd: "Document.activate", args: [D] },
      { cmd: "Document.complete", args: [D] },
    ]);
    const before = w.I.__readDocDataForRecovery();
    const r = await w.I.run("addCitation");
    assert(r.ok === false && r.cancelled === true, "取消没被识别：" + JSON.stringify(r));
    assert(w.I.__readDocDataForRecovery() === before, "取消却写了文档数据");
    return "cancelled";
  });

  await check("长文档刷新（800 步）不撞上限、不重入", async function () {
    const w = threeFields();
    const steps = [];
    for (let i = 0; i < 800; i++) steps.push({ cmd: "Field.setText", args: [D, "@f0", "<sup>[1]</sup>", true] });
    w.setZotero(refreshScript(steps));
    const r = await w.I.run("refresh");
    assert(r.ok === true, "长事务失败：" + JSON.stringify(r));
    assert(w.I.__getBusy() === "", "长事务结束后锁没释放");
    return "800 步通过";
  });

  await check("连续两次刷新互不影响（第一次成功后锁已释放，第二次仍能发起）", async function () {
    const w = threeFields();
    let exec = 0;
    w.http.handler = async (p) => {
      if (p.indexOf("execCommand") >= 0) {
        exec += 1;
        return { ok: true, status: 200, text: async () => JSON.stringify({ command: "Document.complete", arguments: [] }) };
      }
      return undefined;
    };
    const a = await w.I.run("refresh");
    const b = await w.I.run("refresh");
    assert(a.ok && b.ok, "连续刷新失败：" + JSON.stringify([a, b]));
    assert(exec === 2, "第二次刷新没有真的发起事务（exec=" + exec + "）");
    return "2/2";
  });

  console.log("\n== C. P1-5 自动化：默认关闭、一次保存最多一事务、闸门齐全 ==");

  await check("默认关闭：autoCheckOnOpen / autoRefreshOnSave 均为 false", async function () {
    const w = threeFields();
    const state = w.Settings.get(w.doc.FullName);
    assert(state.autoCheckOnOpen === false && state.autoRefreshOnSave === false, "自动化不是默认关闭：" + JSON.stringify(state));
    return "false / false";
  });

  await check("保存后自动刷新：一次保存最多触发一个事务", async function () {
    const w = threeFields({ apiEvent: true });
    w.Settings.set(w.doc.FullName, { autoRefreshOnSave: true });
    let exec = 0;
    let release = null;
    const gate = new Promise(function (r) { release = r; });
    w.http.handler = async (p) => {
      if (p.indexOf("execCommand") >= 0) {
        exec += 1;
        await gate;
        return { ok: true, status: 200, text: async () => JSON.stringify({ command: "Document.complete", arguments: [] }) };
      }
      return undefined;
    };
    await w.App.bindAutomationEvents();
    w.sandbox.wps.ApiEvent.__fire("DocumentAfterSave");
    await new Promise(function (r) { setTimeout(r, 15); });
    w.sandbox.wps.ApiEvent.__fire("DocumentAfterSave");     // 同一保存周期内再次触发
    await new Promise(function (r) { setTimeout(r, 15); });
    release();
    await new Promise(function (r) { setTimeout(r, 40); });
    assert(exec === 1, "一次保存触发了 " + exec + " 个事务（PRD 要求最多 1 个）");
    return "1 事务";
  });

  await check("未保存的新文档 / 已关闭选项 → 不触发后台写入", async function () {
    // 未保存：FullName 为空
    const unsaved = S.createWorld({ apiEvent: true, path: "", docData: DOC_DATA });
    unsaved.Settings.set("", { autoRefreshOnSave: true });
    let exec1 = 0;
    unsaved.http.handler = async (p) => { if (p.indexOf("execCommand") >= 0) exec1 += 1; return undefined; };
    await unsaved.App.bindAutomationEvents();
    unsaved.sandbox.wps.ApiEvent.__fire("DocumentAfterSave");
    await new Promise(function (r) { setTimeout(r, 25); });
    assert(exec1 === 0, "未保存文档触发了 " + exec1 + " 个事务");
    // 已关闭（默认）
    const off = threeFields({ apiEvent: true });
    let exec2 = 0;
    off.http.handler = async (p) => { if (p.indexOf("execCommand") >= 0) exec2 += 1; return undefined; };
    await off.App.bindAutomationEvents();
    off.sandbox.wps.ApiEvent.__fire("DocumentAfterSave");
    await new Promise(function (r) { setTimeout(r, 25); });
    assert(exec2 === 0, "关闭选项后仍触发了 " + exec2 + " 个事务");
    return "0 / 0";
  });

  await check("备份失败时保存后刷新不启动（不写文档）", async function () {
    const w = threeFields({ apiEvent: true });
    w.Settings.set(w.doc.FullName, { autoRefreshOnSave: true });
    let exec = 0;
    w.http.handler = async (p) => { if (p.indexOf("execCommand") >= 0) exec += 1; return undefined; };
    await w.App.bindAutomationEvents();
    w.R.begin = function () { throw new Error("桩：备份失败"); };
    w.sandbox.wps.ApiEvent.__fire("DocumentAfterSave");
    await new Promise(function (r) { setTimeout(r, 30); });
    assert(exec === 0, "备份失败仍发起了 " + exec + " 次事务");
    return "0 次";
  });

  await check("打开检查只读扫描：不改域、不写文档数据、不发事务", async function () {
    const w = threeFields({ apiEvent: true });
    w.Settings.set(w.doc.FullName, { autoCheckOnOpen: true });
    const before = w.snapshot();
    const docData = w.I.__readDocDataForRecovery();
    let exec = 0;
    w.http.handler = async (p) => { if (p.indexOf("execCommand") >= 0) exec += 1; return undefined; };
    await w.App.bindAutomationEvents();
    w.sandbox.wps.ApiEvent.__fire("DocumentOpen");
    await new Promise(function (r) { setTimeout(r, 30); });
    assert(exec === 0, "打开检查发起了写事务");
    assert(JSON.stringify(w.snapshot()) === JSON.stringify(before), "打开检查改动了文档");
    assert(w.I.__readDocDataForRecovery() === docData, "打开检查写了文档数据");
    return "只读";
  });

  await check("没有文档事件 API 时隐藏自动化入口，手动检查/刷新仍可用", async function () {
    const w = threeFields();                                 // 未装 wps.ApiEvent
    assert(w.App.GetVisible({ Id: "btnAutomation" }) === false, "无事件 API 时自动化入口没隐藏");
    const r = w.App.automationSettings();
    assert(r && r.hidden === true, "automationSettings 没有明确说明已隐藏");
    assert(w.App.GetVisible({ Id: "btnHealth" }) === true, "其他按钮被自动化入口拖垮了");
    assert(await w.App.bindAutomationEvents() === false, "无事件 API 却绑定成功");
    return "隐藏 + 其余可用";
  });

  console.log("");
  console.log("通过 " + passed + " 项，失败 " + failed + " 项" + (failed === 0 ? "，全部通过" : ""));
  process.exit(failed === 0 ? 0 : 1);
})();
