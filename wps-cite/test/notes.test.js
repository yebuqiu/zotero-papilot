// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* P0-1 注文引文：混合正文/脚注/尾注的统一扫描、真实 noteIndex、逐域转换、失败回滚。
 *
 * 与既有套件的分工：
 *   qa-protocol  —— Zotero 协议形状（getFields 返回值能不能被 client 消费）
 *   notes（本文件）—— PRD P0-1 的五条验收：扫描顺序/注序号、插入落到注正文、
 *                    建域/写码/写文本失败不留空注半域、正文↔脚注↔尾注转换、能力缺失局部降级
 *
 * 运行：node test/notes.test.js
 */
"use strict";

const S = require("./helpers/wps-stub.js");
const MIXED = require("./fixtures/mixed-notes.js");

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

function refWithNote(world, ref) {
  const kind = ref.container === "footnote" ? "footnote" : ref.container === "endnote" ? "endnote" : null;
  const note = kind ? world.state.notes[kind][ref.noteIndex - 1] : null;
  return Object.assign({}, ref, { note: note });
}

/** 只回一条 Document.complete 的事务桩：用于"一次会话"的失败注入。 */
function completeOnly(world) {
  world.http.handler = async (p) => (p.indexOf("execCommand") >= 0
    ? { ok: true, status: 200, text: async () => JSON.stringify({ command: "Document.complete", arguments: [] }) }
    : undefined);
}

function addCitationScript(noteType, extra) {
  return [
    { cmd: "Application.getActiveDocument" },
    { cmd: "Document.getDocumentData", args: [D] },
    { cmd: "Document.insertField", args: [D, "Http", noteType] },
    { cmd: "Field.setCode", args: [D, "@field", S.itemCode("citeSess01", ["AAAA0001"])] },
    { cmd: "Field.setText", args: [D, "@field", "<sup>[1]</sup>", true] },
    { cmd: "Document.activate", args: [D] },
    { cmd: "Document.complete", args: [D] },
  ].concat(extra || []);
}

(async function main() {
  console.log("== A. 统一扫描：混合正文 + 2 脚注 + 2 尾注 ==");

  await check("容器类型/数量/文档顺序正确（按注在正文里的引用锚点合并排序）", async function () {
    const w = MIXED.build();
    const scan = w.S.scan(w.doc);
    const got = scan.fields.map(function (f) { return { citationID: f.citationID, container: f.container, noteIndex: f.noteIndex }; });
    assert(got.length === 5, "域数量应为 5（正文 1 + 脚注 2 + 尾注 2），实际 " + got.length);
    const want = MIXED.EXPECTED_ORDER;
    for (let i = 0; i < want.length; i++) {
      assert(got[i].citationID === want[i].citationID,
        "第 " + (i + 1) + " 个域顺序不对：期望 " + want[i].citationID + "，实际 " + got[i].citationID);
      assert(got[i].container === want[i].container, want[i].citationID + " 容器不对：" + got[i].container);
      assert(got[i].noteIndex === want[i].noteIndex, want[i].citationID + " noteIndex 不对：期望 " + want[i].noteIndex + "，实际 " + got[i].noteIndex);
    }
    return "body/fn1/en1/fn2/en2";
  });

  await check("连续两次扫描的 fieldID / citationID 完全一致（ID 稳定）", async function () {
    const w = MIXED.build();
    const a = w.S.scan(w.doc), b = w.S.scan(w.doc);
    assert(a.fields.length === b.fields.length, "两次扫描数量不同");
    for (let i = 0; i < a.fields.length; i++) {
      assert(a.fields[i].fieldID === b.fields[i].fieldID, "fieldID 漂移：" + a.fields[i].fieldID + " → " + b.fields[i].fieldID);
      assert(a.fields[i].citationID === b.fields[i].citationID, "citationID 漂移");
    }
    return a.fields.map(function (f) { return f.fieldID; }).join(",");
  });

  await check("Document.getFields 的 noteIndex 是真实注序号（不能退化成 0）", async function () {
    const w = MIXED.build();
    const list = await w.I.handle("Document.getFields", [D, "Http"]);
    const notes = list.filter(function (f) { return f.noteIndex > 0; });
    assert(notes.length === 4, "注文域应为 4 条，实际 " + notes.length);
    assert(list[0].noteIndex === 0, "正文域 noteIndex 必须是 0");
    assert(notes[0].noteIndex === 1 && notes[1].noteIndex === 1 && notes[2].noteIndex === 2 && notes[3].noteIndex === 2,
      "注序号不对：" + notes.map(function (f) { return f.noteIndex; }).join(","));
    return "noteIndex=" + notes.map(function (f) { return f.noteIndex; }).join("/");
  });

  await check("单容器不可用（属性不存在）只降级该容器，正文与尾注仍被扫描", async function () {
    const opts = MIXED.options();
    opts.faults = { footnotes: "missing" };
    const w = S.createWorld(opts);
    const scan = w.S.scan(w.doc);
    const containers = scan.fields.map(function (f) { return f.container; });
    assert(containers.indexOf("body") >= 0, "正文域被脚注故障带走了");
    assert(containers.indexOf("endnote") >= 0, "尾注域被脚注故障带走了");
    assert(containers.indexOf("footnote") < 0, "脚注属性不存在却扫出了脚注域");
    return "仍扫到 " + scan.fields.length + " 条";
  });

  await check("单个坏域不阻断其余域（坏 JSON 只影响自己）", async function () {
    const w = S.createWorld({
      fields: [
        { start: 10, code: S.wordItemCode("citeGood01", ["AAAA0001"]), text: "[1]" },
        { start: 20, code: 'ADDIN ZOTERO_ITEM CSL_CITATION {"citationID":"citeBadd01",', text: "[2]" },
        { start: 30, code: S.wordItemCode("citeGood02", ["BBBB0002"]), text: "[3]" },
      ],
    });
    const scan = w.S.scan(w.doc);
    assert(scan.fields.length === 3, "坏域把其他域吞了：" + scan.fields.length);
    assert(scan.fields.filter(function (f) { return f.parseError; }).length === 1, "坏域没有被标出来");
    assert(scan.issues.some(function (i) { return i.kind === "BAD_FIELD"; }), "缺少 BAD_FIELD 问题项");
    return "2 好 1 坏";
  });

  console.log("\n== B. 插入：必须落在注正文，失败不留空注/半域 ==");

  await check("insertField(noteType=1/2) 返回真实 noteIndex，且域落在注正文而不是正文", async function () {
    const w = S.createWorld({});
    const foot = await w.I.handle("Document.insertField", [D, "Http", 1]);
    const end = await w.I.handle("Document.insertField", [D, "Http", 2]);
    assert(foot.noteIndex === 1, "脚注 noteIndex 应为 1，实际 " + foot.noteIndex);
    assert(end.noteIndex === 1, "尾注 noteIndex 应为 1，实际 " + end.noteIndex);
    assert(w.state.bodyFields.length === 0, "注文引文被写进了正文（body 域 " + w.state.bodyFields.length + " 个）");
    assert(w.state.notes.footnote.length === 1 && w.state.notes.endnote.length === 1, "注没有真正创建");
    assert(w.state.notes.footnote[0].__fields.length === 1, "脚注正文里没有域");
    assert(w.state.notes.endnote[0].__fields.length === 1, "尾注正文里没有域");
    return "正文 0 域；脚注/尾注各 1 域";
  });

  await check("Fields.Add 抛错 → 明确报错并删除本次空注（不留编号）", async function () {
    const w = S.createWorld({ faults: { fieldAdd: "throw" } });
    let err = null;
    try { w.sandbox.PPDoc.insertNativeField(1, w.doc.Range(10, 10)); } catch (e) { err = e; }
    assert(err, "Fields.Add 抛错却返回成功");
    assert(/Fields\.Add|建域/.test(err.message), "错误没说清是建域失败：" + err.message);
    assert(w.state.notes.footnote.length === 0, "留下了空脚注：仍剩 " + w.state.notes.footnote.length + " 个");
    return err.message.slice(0, 34);
  });

  await check("Fields.Add 返回 null → 明确报错并删除本次空注", async function () {
    const w = S.createWorld({ faults: { fieldAdd: "null" } });
    let err = null;
    try { w.sandbox.PPDoc.insertNativeField(2, w.doc.Range(10, 10)); } catch (e) { err = e; }
    assert(err, "Fields.Add 返回 null 却返回成功");
    assert(/null|空域/.test(err.message), "错误没说清：" + err.message);
    assert(w.state.notes.endnote.length === 0, "留下了空尾注");
    return err.message.slice(0, 34);
  });

  await check("jsapi 四类差异：注集合属性不存在 / Add 抛错 / Add 返回 null / Add 返回不完整对象", async function () {
    const cases = [
      { faults: { footnotes: "missing" }, pattern: /不支持脚注集合|脚注/ },
      { faults: { footnotesAdd: "throw" }, pattern: /脚注|Add/ },
      { faults: { footnotesAdd: "null" }, pattern: /Range|注/ },
      { faults: { footnotesAdd: "incomplete" }, pattern: /Range|注/ },
    ];
    for (const c of cases) {
      const w = S.createWorld({ faults: c.faults });
      let err = null;
      try { w.sandbox.PPDoc.insertNativeField(1, w.doc.Range(10, 10)); } catch (e) { err = e; }
      assert(err, "故障 " + JSON.stringify(c.faults) + " 没有报错");
      assert(c.pattern.test(err.message), "故障 " + JSON.stringify(c.faults) + " 的错误不清楚：" + err.message);
      assert(w.state.notes.footnote.length === 0, "故障 " + JSON.stringify(c.faults) + " 留下空注");
      assert(w.state.bodyFields.length === 0, "故障 " + JSON.stringify(c.faults) + " 静默写进了正文");
    }
    return "4 类差异均局部失败且不写正文";
  });

  await check("写码失败（WPS 截断域代码）→ 新注与新域一起回滚，事务走完 complete", async function () {
    const w = S.createWorld({});
    w.setZotero(addCitationScript(1));
    w.host.truncateNextCode = 1;                 // 只截断这条引文的域代码写
    w.host.truncateNextLen = 40;
    let err = null;
    try { await w.I.run("addCitation"); } catch (e) { err = e; }
    assert(err, "域代码被截断却返回成功");
    assert(/域代码/.test(err.message), "错误没说清是域代码：" + err.message);
    assert(w.state.notes.footnote.length === 0, "写码失败后留下了空脚注");
    assert(w.state.bodyFields.length === 0, "写码失败后正文里留下了半域");
    assert(w.zotero.steps[w.zotero.steps.length - 1].cmd === "Document.complete", "没有走到 complete，Zotero 会卡在 inProgress");
    assert(w.I.__getBusy() === "", "busy 锁没有释放");
    return "空注 0 / 半域 0 / complete 已应答";
  });

  await check("写文本失败（宿主静默丢弃写入）→ 回滚到无空注，且明确报不一致", async function () {
    const w = S.createWorld({ faults: { textWrite: "ignore" } });
    w.setZotero(addCitationScript(1));
    let err = null;
    try { await w.I.run("addCitation"); } catch (e) { err = e; }
    assert(err, "显示文本没写进去却返回成功");
    assert(/显示文本/.test(err.message), "错误没说清是显示文本：" + err.message);
    assert(w.state.notes.footnote.length === 0, "写文本失败后留下了空脚注");
    assert(w.I.__getBusy() === "", "busy 锁没有释放");
    return "无空注 / 无半域";
  });

  console.log("\n== C. 转换：正文 ↔ 脚注 ↔ 尾注（逐域目标 + 逆序恢复）==");

  await check("正文 → 脚注：citationID/域代码/显示文本保留，原正文域删除", async function () {
    const w = S.createWorld({ fields: [{ start: 10, code: S.wordItemCode("citeBody01", ["AAAA0001"]), text: "[1]" }] });
    const scan = w.S.scan(w.doc);
    const before = scan.fields[0];
    const out = w.sandbox.PPDoc.convertOne(refWithNote(w, before), 1);
    assert(out.ok && out.changed, "转换没有发生");
    assert(out.container === "footnote" && out.noteIndex === 1, "目标容器/注序号不对：" + out.container + "/" + out.noteIndex);
    assert(w.state.bodyFields.length === 0, "原正文域没有删除");
    const noteField = w.state.notes.footnote[0].__fields[0];
    assert(String(noteField.Code.Text).indexOf("citeBody01") >= 0, "脚注里的域代码没有保留 citationID");
    assert(noteField.Result.Text === "[1]", "显式文本没有保留：" + JSON.stringify(noteField.Result.Text));
    assert(w.S.scan(w.doc).fields.length === 1, "转换后域数不是 1（有嵌套或丢域）");
    return "footnote:1";
  });

  await check("脚注 → 尾注（WPS 原生 Convert）：域数不变、citationID 不变", async function () {
    const w = S.createWorld({ notes: { footnote: [{ refStart: 50, fields: [{ code: S.wordItemCode("citeFoot01", ["AAAA0001"]), text: "1" }] }] } });
    const before = w.S.scan(w.doc);
    const out = w.sandbox.PPDoc.convertOne(refWithNote(w, before.fields[0]), 2);
    assert(out.ok && out.changed && out.native, "原生 Convert 路径没有生效");
    assert(out.container === "endnote", "目标容器不是尾注：" + out.container);
    assert(w.state.notes.footnote.length === 0 && w.state.notes.endnote.length === 1, "注集合没有真的搬过去");
    const after = w.S.scan(w.doc);
    assert(after.fields.length === 1 && after.fields[0].citationID === "citeFoot01", "转换后域身份变了");
    assert(after.fields[0].container === "endnote" && after.fields[0].noteIndex === 1, "扫描结果没反映新容器");
    return "footnote → endnote";
  });

  await check("尾注 → 正文：需要 note.Delete；缺失时明确拒绝且不改文档", async function () {
    const w = S.createWorld({
      faults: { noteDelete: "absent" },
      notes: { endnote: [{ refStart: 50, fields: [{ code: S.wordItemCode("citeEnd001", ["AAAA0001"]), text: "i" }] }] },
    });
    const before = w.snapshot();
    let err = null;
    try { w.sandbox.PPDoc.convertOne(refWithNote(w, w.S.scan(w.doc).fields[0]), 0); } catch (e) { err = e; }
    assert(err, "缺少 note.Delete 却声称转换成功（会留下空尾注）");
    assert(/CONVERT_UNSUPPORTED|note\.Delete/.test(err.message), "错误没说清原因：" + err.message);
    assert(JSON.stringify(w.snapshot()) === JSON.stringify(before), "拒绝转换时文档被改动了");
    return err.message.slice(0, 40);
  });

  await check("尾注 → 正文（有 note.Delete）：域回到正文，尾注被删除", async function () {
    const w = S.createWorld({ notes: { endnote: [{ refStart: 50, fields: [{ code: S.wordItemCode("citeEnd001", ["AAAA0001"]), text: "i" }] }] } });
    const out = w.sandbox.PPDoc.convertOne(refWithNote(w, w.S.scan(w.doc).fields[0]), 0);
    assert(out.ok && out.changed && out.container === "body", "没有转到正文");
    assert(w.state.notes.endnote.length === 0, "原尾注没有删除");
    assert(w.state.bodyFields.length === 1, "正文里没有新域");
    assert(w.state.bodyFields[0].Result.Text === "i", "显示文本没有保留");
    return "endnote → body";
  });

  await check("原生 Convert 抛错：明确失败且文档逐字不变（可逆）", async function () {
    const w = S.createWorld({
      faults: { noteConvert: "throw" },
      notes: { footnote: [{ refStart: 50, fields: [{ code: S.wordItemCode("citeFoot01", ["AAAA0001"]), text: "1" }] }] },
    });
    const before = w.snapshot();
    let err = null;
    try { w.sandbox.PPDoc.convertOne(refWithNote(w, w.S.scan(w.doc).fields[0]), 2); } catch (e) { err = e; }
    assert(err, "原生 Convert 抛错却返回成功");
    assert(JSON.stringify(w.snapshot()) === JSON.stringify(before), "原生转换失败后文档被破坏了（不可逆）");
    assert(w.state.notes.footnote.length === 1 && w.state.notes.endnote.length === 0, "注集合被改乱了");
    return err.message.slice(0, 40);
  });

  await check("原生 Convert“行为不完整”（返回成功但注没搬过去）→ 必须报错，不许冒充成功", async function () {
    const w = S.createWorld({
      faults: { noteConvert: "incomplete" },
      notes: { footnote: [{ refStart: 50, fields: [{ code: S.wordItemCode("citeFoot01", ["AAAA0001"]), text: "1" }] }] },
    });
    const before = w.snapshot();
    let err = null;
    try { w.sandbox.PPDoc.convertOne(refWithNote(w, w.S.scan(w.doc).fields[0]), 2); } catch (e) { err = e; }
    assert(err, "原生 Convert 什么都没做却返回成功（用户以为切到尾注了）");
    assert(/没有进入|回读验证失败/.test(err.message), "错误没讲清是回读验证失败：" + err.message);
    assert(JSON.stringify(w.snapshot()) === JSON.stringify(before), "失败后文档被改动");
    return err.message.slice(0, 36);
  });

  await check("FormattedText 不可用且无法证明无字符格式（上标）→ 拒绝转换，不冒充无损", async function () {
    const w = S.createWorld({
      faults: { richText: "missing" },
      fields: [{ start: 10, code: S.wordItemCode("citeSup001", ["AAAA0001"]), text: "[1]", font: { Superscript: true } }],
    });
    const before = w.snapshot();
    let err = null;
    try { w.sandbox.PPDoc.convertOne(w.S.scan(w.doc).fields[0], 1); } catch (e) { err = e; }
    assert(err, "无法验证格式却照样转换（会静默丢上标）");
    assert(/CONVERT_UNSUPPORTED|FormattedText/.test(err.message), "错误没说清原因：" + err.message);
    assert(JSON.stringify(w.snapshot()) === JSON.stringify(before), "被拒绝的转换改动了文档");
    return err.message.slice(0, 40);
  });

  await check("FormattedText 不可用但能证明是纯文本 → 允许转换并保留文本", async function () {
    const w = S.createWorld({
      faults: { richText: "missing" },
      fields: [{ start: 10, code: S.wordItemCode("citePlain1", ["AAAA0001"]), text: "[1]" }],
    });
    const out = w.sandbox.PPDoc.convertOne(w.S.scan(w.doc).fields[0], 1);
    assert(out.ok && out.changed, "纯文本域被拒绝转换（过度保守）");
    assert(w.state.notes.footnote[0].__fields[0].Result.Text === "[1]", "文本没有保留");
    return "纯文本允许无损转换";
  });

  await check("Document.convert 逐域目标 [1,2,0]：三向各转一次，citationID 集合不变", async function () {
    const w = S.createWorld({
      fields: [
        { start: 10, code: S.wordItemCode("citeConv01", ["AAAA0001"]), text: "[1]" },
        { start: 20, code: S.wordItemCode("citeConv02", ["BBBB0002"]), text: "[2]" },
        { start: 30, code: S.wordItemCode("citeConv03", ["CCCC0003"]), text: "[3]" },
      ],
      docData: '{"style":{"styleID":"http://www.zotero.org/styles/chicago-fullnote-bibliography"}}',
    });
    const list = await w.I.handle("Document.getFields", [D, "Http"]);
    const ids = list.map(function (f) { return f.id; });
    assert(ids.length === 3, "前置条件不对：应有 3 个正文域");
    const before = w.S.scan(w.doc).fields.map(function (f) { return f.citationID; }).sort();
    await w.I.handle("Document.convert", [D, [ids[0], ids[1], ids[2]], "Http", [1, 2, 0]]);
    const after = w.S.scan(w.doc);
    assert(after.fields.length === 3, "转换后域数变了：" + after.fields.length + "（应仍为 3）");
    assert(JSON.stringify(after.fields.map(function (f) { return f.citationID; }).sort()) === JSON.stringify(before),
      "citationID 集合变了：" + before.join(",") + " → " + after.fields.map(function (f) { return f.citationID; }).join(","));
    const byID = {};
    after.fields.forEach(function (f) { byID[f.citationID] = f; });
    assert(byID.citeConv01.container === "footnote" && byID.citeConv01.noteIndex === 1, "第 1 条没有转到脚注 1");
    assert(byID.citeConv02.container === "endnote" && byID.citeConv02.noteIndex === 1, "第 2 条没有转到尾注 1");
    assert(byID.citeConv03.container === "body", "第 3 条应该留在正文");
    return "body/fn1/en1 → fn1/en1/body";
  });

  await check("Document.convert 之后旧协议 ID 仍可用（重扫后按 citationID 重绑）", async function () {
    const w = S.createWorld({
      fields: [
        { start: 10, code: S.wordItemCode("citeBind01", ["AAAA0001"]), text: "[1]" },
        { start: 20, code: S.wordItemCode("citeBind02", ["BBBB0002"]), text: "[2]" },
      ],
    });
    const list = await w.I.handle("Document.getFields", [D, "Http"]);
    const ids = list.map(function (f) { return f.id; });
    await w.I.handle("Document.convert", [D, [ids[0], ids[1]], "Http", [1, 2]]);
    const fm = w.I.__fieldMapForTest;
    assert(fm.get(ids[0]) && fm.get(ids[0]).container === "footnote", "旧 id 没有指向脚注里的新域");
    assert(fm.get(ids[1]) && fm.get(ids[1]).container === "endnote", "旧 id 没有指向尾注里的新域");
    // Zotero 后续仍用旧 id 下发 setCode/setText：必须写到新容器里的那个域
    await w.I.handle("Field.setCode", [D, ids[0], S.itemCode("citeBind01", ["AAAA0001"])]);
    assert(w.state.notes.footnote[0].__fields[0].Code.Text.indexOf("citeBind01") >= 0, "setCode 没写到脚注里的新域");
    return "旧 id → 新容器";
  });

  await check("Document.convert 参数非法（逐域数组长度不一致 / 目标非法）→ 明确报错", async function () {
    const w = S.createWorld({ fields: [{ start: 10, code: S.wordItemCode("citeArg001", ["AAAA0001"]), text: "[1]" }] });
    const list = await w.I.handle("Document.getFields", [D, "Http"]);
    let e1 = null;
    try { await w.I.handle("Document.convert", [D, [list[0].id], "Http", [1, 2]]); } catch (e) { e1 = e; }
    assert(e1 && /长度不一致/.test(e1.message), "长度不一致没有报错");
    let e2 = null;
    try { await w.I.handle("Document.convert", [D, [list[0].id], "Http", [9]]); } catch (e) { e2 = e; }
    assert(e2 && /目标注类型无效/.test(e2.message), "非法目标类型没有报错");
    return "2 类参数错误均拒绝";
  });

  await check("转换失败后逆序恢复：批量中第二条失败时第一条回到原位", async function () {
    // 从创建时就缺尾注集合：第二条（正文→尾注）必然失败，第一条已完成，必须逆序转回
    const w = S.createWorld({
      faults: { endnotes: "missing" },
      fields: [
        { start: 10, code: S.wordItemCode("citeRoll01", ["AAAA0001"]), text: "[1]" },
        { start: 20, code: S.wordItemCode("citeRoll02", ["BBBB0002"]), text: "[2]" },
      ],
    });
    const beforeScan = w.S.scan(w.doc);
    const codeOf = {};
    beforeScan.fields.forEach(function (f) { codeOf[f.citationID] = f.code; });
    const list = await w.I.handle("Document.getFields", [D, "Http"]);
    let err = null;
    try { await w.I.handle("Document.convert", [D, [list[0].id, list[1].id], "Http", [1, 2]]); } catch (e) { err = e; }
    assert(err, "第二条无法转换却没有报错");
    const after = w.S.scan(w.doc);
    assert(after.fields.length === 2, "逆序恢复后域数应为 2，实际 " + after.fields.length);
    assert(after.fields.map(function (f) { return f.citationID; }).join(",") === "citeRoll01,citeRoll02",
      "恢复后文档顺序/身份不对：" + after.fields.map(function (f) { return f.citationID; }).join(","));
    after.fields.forEach(function (f) {
      assert(f.code === codeOf[f.citationID], f.citationID + " 恢复后的域代码与转换前不一致");
      assert(f.container === "body", f.citationID + " 没有回到正文：" + f.container);
    });
    assert(w.state.notes.footnote.length === 0, "残留了转换出来的脚注");
    return "逆序恢复成功";
  });

  console.log("");
  console.log("通过 " + passed + " 项，失败 " + failed + " 项" + (failed === 0 ? "，全部通过" : ""));
  process.exit(failed === 0 ? 0 : 1);
})();
