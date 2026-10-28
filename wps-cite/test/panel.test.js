// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* P1 写作效率：返回栈 / 身份重定位 / 同文献遍历 / 常用样式与最近三种 / 引文管理面板。
 *
 * 重点不是"功能存在"，而是 PRD 里那些**容易静默出错**的边界：
 *   - 返回栈 20 层上限、刷新导致范围变化后按身份重定位、目标删除要跳过而不是选错位置；
 *   - 多篇选择器取消不压栈、不改选区；
 *   - 最近样式只记"切换并刷新成功"的，失败要回滚且不污染历史；
 *   - 管理面板一行一个物理域、坏域保留、搜索覆盖标题/作者/年份/正文/页码、命令按文档隔离。
 *
 * 运行：node test/panel.test.js
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

function navWorld(count) {
  const fields = [];
  for (let i = 0; i < count; i++) fields.push({ start: 10 + i * 10, code: S.wordItemCode("citeNav0" + i, ["AAAA0001"]), text: "[1]" });
  return S.createWorld({ path: "C:/tmp/panel.docx", fields: fields, selection: { start: 0, end: 0 } });
}

function completeOnly(world) {
  world.http.handler = async (p) => (p.indexOf("execCommand") >= 0
    ? { ok: true, status: 200, text: async () => JSON.stringify({ command: "Document.complete", arguments: [] }) }
    : undefined);
}

(async function main() {
  console.log("== A. 导航：20 层返回栈、身份重定位、删除跳过 ==");

  await check("返回栈最多 20 层（25 次跳转后仍只有 20）", async function () {
    const w = navWorld(3);
    for (let i = 0; i < 25; i++) await w.N.next();
    const stack = w.N.__stackFor(w.doc.FullName);
    assert(stack.length === 20, "返回栈应为 20 层，实际 " + stack.length);
    return "20 层";
  });

  await check("返回：连续 20 次成功，用尽后给出可读提示", async function () {
    const w = navWorld(3);
    for (let i = 0; i < 25; i++) await w.N.next();
    let ok = 0;
    for (let i = 0; i < 20; i++) if ((await w.N.back()).ok) ok += 1;
    assert(ok === 20, "只成功返回 " + ok + " 次");
    const last = await w.N.back();
    assert(last.ok === false && /没有可返回/.test(last.error), "栈空时提示不清楚：" + JSON.stringify(last));
    return "20 + 1 提示";
  });

  await check("刷新导致范围变化：返回时按 citationID 重定位（不按旧字符偏移）", async function () {
    const w = navWorld(2);
    await w.N.next();                                  // 跳到第 1 条
    w.state.selection = { Start: 11, End: 12 };        // 光标在第 1 条内
    await w.N.next();                                  // 跳到第 2 条，压栈来源 = 第 1 条
    // 模拟 Zotero 刷新：域的包装对象与位置都变了，citationID 不变
    const idx = w.state.bodyFields.findIndex(function (f) { return String(f.Code.Text).indexOf("citeNav00") >= 0; });
    w.state.bodyFields.splice(idx, 1);
    const moved = w.host.addField(null, w.doc.Range(500, 500), S.wordItemCode("citeNav00", ["AAAA0001"]));
    moved.Result.Text = "[1]";
    const r = await w.N.back();
    assert(r.ok === true, "刷新后返回失败：" + JSON.stringify(r));
    assert(r.relocated === true, "没有走身份重定位（而是用了旧偏移）");
    assert(w.state.selection.Start === 500, "没有落到重定位后的域：" + w.state.selection.Start);
    return "relocated → 500";
  });

  await check("目标已删除：返回跳过失效位置并明确提示，绝不按旧偏移误选", async function () {
    const w = navWorld(2);
    w.state.selection = { Start: 11, End: 12 };        // 光标停在第 1 条引文里
    await w.N.next();                                  // 压栈来源 = 第 1 条（带 citationID），跳到第 2 条
    const selAfterJump = JSON.stringify(w.state.selection);
    w.state.bodyFields[0].Delete();                    // 刷新/编辑时第 1 条被删除
    const r = await w.N.back();
    assert(r.ok === false, "目标删除后仍声称返回成功（会停在旧偏移上）");
    assert(/已删除|跳过/.test(r.error), "提示没说清是目标已删除：" + r.error);
    assert(JSON.stringify(w.state.selection) === selAfterJump,
      "返回失败却改了选区（旧偏移被拿去选中了别的引文）：" + JSON.stringify(w.state.selection));
    return r.error.slice(0, 30);
  });

  await check("同文献遍历循环：3 处引用可 prev/next 循环", async function () {
    const w = S.createWorld({
      path: "C:/tmp/panel.docx",
      fields: [
        { start: 10, code: S.wordItemCode("citeSame01", ["AAAA0001"]), text: "[1]" },
        { start: 50, code: S.wordItemCode("citeSame02", ["AAAA0001"]), text: "[1]" },
        { start: 90, code: S.wordItemCode("citeSame03", ["AAAA0001"]), text: "[1]" },
      ],
      selection: { start: 11, end: 12 },
    });
    const seq = [];
    for (let i = 0; i < 4; i++) seq.push((await w.N.sameNext()).citationID);
    assert(seq[0] === "citeSame02" && seq[1] === "citeSame03", "下一次顺序不对：" + seq.join(","));
    assert(seq[2] === "citeSame01", "没有循环回第一处：" + seq.join(","));
    assert(seq[3] === "citeSame02", "循环后续不对：" + seq.join(","));
    const back = await w.N.samePrev();
    assert(back.ok && back.citationID === "citeSame01", "上一处没有反向循环：" + JSON.stringify(back));
    return seq.join("→");
  });

  await check("同文献遍历：已删除的那一处被跳过，不选空位置", async function () {
    const w = S.createWorld({
      path: "C:/tmp/panel.docx",
      fields: [
        { start: 10, code: S.wordItemCode("citeSkip01", ["AAAA0001"]), text: "[1]" },
        { start: 50, code: S.wordItemCode("citeSkip02", ["AAAA0001"]), text: "[1]" },
        { start: 90, code: S.wordItemCode("citeSkip03", ["AAAA0001"]), text: "[1]" },
      ],
      selection: { start: 11, end: 12 },
    });
    w.state.bodyFields[1].Delete();                     // 删掉第 2 处
    const r = await w.N.sameNext();
    assert(r.ok === true, "跳过被删位置后应还能遍历：" + JSON.stringify(r));
    assert(r.citationID === "citeSkip03", "没有跳过被删的 citeSkip02：" + r.citationID);
    assert(r.total === 2, "有效位置数应为 2，实际 " + r.total);
    return "skip → citeSkip03";
  });

  await check("多篇引文：选择器取消不压栈、不改选区", async function () {
    const w = S.createWorld({
      path: "C:/tmp/panel.docx",
      fields: [
        { start: 10, code: S.wordItemCode("citeMulti1", ["AAAA0001", "BBBB0002"]), text: "[1,2]" },
        { start: 50, code: S.wordItemCode("citeMulti2", ["AAAA0001"]), text: "[1]" },
      ],
      selection: { start: 11, end: 12 },
    });
    w.sandbox.prompt = function () { return null; };     // 用户点取消
    const stackBefore = w.N.__stackFor(w.doc.FullName).length;
    const selBefore = JSON.stringify(w.state.selection);
    const r = await w.N.sameNext();
    assert(r.ok === false && r.cancelled === true, "取消没有被识别：" + JSON.stringify(r));
    assert(w.N.__stackFor(w.doc.FullName).length === stackBefore, "取消却压了返回栈");
    assert(JSON.stringify(w.state.selection) === selBefore, "取消却改了选区");
    return "cancelled / 栈与选区不变";
  });

  console.log("\n== B. 样式：四种常用 + 最近三种（只记成功） ==");

  await check("最近样式最多 3 条、按最近使用排序、重复切换去重", async function () {
    const w = S.createWorld({ path: "C:/tmp/styles.docx", docData: '{"style":{"styleID":"http://www.zotero.org/styles/apa"}}' });
    completeOnly(w);
    const seq = ["nature", "ieee", "vancouver", "apa", "chicago-note-bibliography"].map(function (k) {
      return k.indexOf("/") >= 0 ? k : "http://www.zotero.org/styles/" + k;
    });
    for (const id of seq) {
      const r = await w.App.switchZoteroStyle(id);
      assert(r.ok === true, "切换失败：" + id + " → " + JSON.stringify(r));
    }
    const recent = w.App.recentStyles();
    assert(recent.length === 3, "最近样式应为 3 条，实际 " + recent.length);
    assert(recent[0].id.indexOf("chicago") >= 0 && recent[1].id.indexOf("/apa") >= 0 && recent[2].id.indexOf("vancouver") >= 0,
      "最近顺序不对：" + recent.map(function (s) { return s.label; }).join(","));
    // 再切回 nature：应置顶且不重复
    await w.App.switchZoteroStyle("http://www.zotero.org/styles/nature");
    const again = w.App.recentStyles().map(function (s) { return s.id; });
    assert(again[0].indexOf("nature") >= 0, "再次切换没有置顶");
    assert(again.length === 3 && new Set(again).size === 3, "最近样式出现重复：" + again.join(","));
    return again.map(function (x) { return x.split("/").pop(); }).join(",");
  });

  await check("切换失败：渲染回滚原样式、不进最近历史、错误可读", async function () {
    const w = S.createWorld({ path: "C:/tmp/styles.docx", docData: '{"style":{"styleID":"http://www.zotero.org/styles/apa"}}' });
    completeOnly(w);
    await w.App.switchZoteroStyle("http://www.zotero.org/styles/nature");
    const recentBefore = JSON.stringify(w.App.recentStyles().map(function (s) { return s.id; }));
    const docDataBefore = w.I.__readDocDataForRecovery();
    w.http.handler = async (p) => (p.indexOf("execCommand") >= 0 ? { ok: false, status: 500, text: async () => "boom" } : undefined);
    const r = await w.App.switchZoteroStyle("http://www.zotero.org/styles/mla");
    assert(r.ok === false, "失败切换却返回成功");
    assert(w.I.__readDocDataForRecovery() === docDataBefore, "失败后没有回滚文档数据里的样式");
    assert(JSON.stringify(w.App.recentStyles().map(function (s) { return s.id; })) === recentBefore, "失败样式被记进了最近历史");
    return "回滚 + 不入历史";
  });

  await check("重开加载项后最近样式历史仍在（按文档隔离）", async function () {
    const shared = {
      __data: new Map(),
      getItem(k) { return this.__data.has(k) ? this.__data.get(k) : null; },
      setItem(k, v) { this.__data.set(k, String(v)); },
      removeItem(k) { this.__data.delete(k); },
    };
    const a = S.createWorld({ path: "C:/tmp/styles-reopen.docx", localStorage: shared, docData: '{"style":{"styleID":"http://www.zotero.org/styles/apa"}}' });
    completeOnly(a);
    await a.App.switchZoteroStyle("http://www.zotero.org/styles/nature");
    await a.App.switchZoteroStyle("http://www.zotero.org/styles/ieee");
    const b = S.createWorld({ path: "C:/tmp/styles-reopen.docx", localStorage: shared, docData: '{"style":{"styleID":"http://www.zotero.org/styles/ieee"}}' });
    const recent = b.App.recentStyles().map(function (s) { return s.id.split("/").pop(); });
    assert(recent.length === 2 && recent[0] === "ieee" && recent[1] === "nature", "重开后历史丢失：" + recent.join(","));
    // 另一份文档不应读到这份历史
    const other = S.createWorld({ path: "C:/tmp/another-doc.docx", localStorage: shared });
    assert(other.App.recentStyles().length === 0, "最近样式串到别的文档了");
    return "2 条 / 按文档隔离";
  });

  console.log("\n== C. 管理面板：200 行、搜索、坏域保留、命令隔离 ==");

  await check("200 条引文可完整列出，一行一个物理域", async function () {
    const fields = [];
    const itemData = {};
    for (let i = 0; i < 200; i++) {
      const key = "ITEM" + String(i).padStart(4, "0");
      itemData[key] = {
        itemType: "journalArticle",
        title: "Title " + i + " of Citation Management",
        author: [{ family: "Author" + (i % 7) }],
        issued: { "date-parts": [[2000 + (i % 20)]] },
      };
      fields.push({ start: i * 10, code: S.wordItemCode("citeMgr" + String(i).padStart(3, "0"), [key], { itemData: itemData }), text: "[" + (i + 1) + "]" });
    }
    const w = S.createWorld({ path: "C:/tmp/manager.docx", fields: fields });
    const scan = w.S.scan(w.doc);
    const rows = w.M.load(scan, scan.issues);
    assert(rows.length === 200, "管理列表应有 200 行，实际 " + rows.length);
    assert(rows[0].n === 1 && rows[199].n === 200, "序号不连续");
    assert(rows[17].title.indexOf("Title 17") >= 0, "第 18 行标题不对：" + rows[17].title);
    return "200 行";
  });

  await check("搜索覆盖标题 / 作者 / 年份 / 正文 / 页码，且异常筛选保留坏域", async function () {
    const fields = [];
    const itemData = {};
    for (let i = 0; i < 200; i++) {
      const key = "ITEM" + String(i).padStart(4, "0");
      itemData[key] = {
        itemType: "journalArticle",
        title: "Title " + i + " of Citation Management",
        author: [{ family: "Author" + (i % 7) }],
        issued: { "date-parts": [[2000 + (i % 20)]] },
      };
      fields.push({ start: i * 10, code: S.wordItemCode("citeMgr" + String(i).padStart(3, "0"), [key], { itemData: itemData }), text: "[" + (i + 1) + "]" });
    }
    // 一条坏域：必须保留在列表里并标异常
    fields.push({ start: 3000, code: 'ADDIN ZOTERO_ITEM CSL_CITATION {"citationID":"citeBroken1",', text: "[x]" });
    const w = S.createWorld({ path: "C:/tmp/manager.docx", fields: fields });
    const scan = w.S.scan(w.doc);
    const rows = w.M.load(scan, scan.issues);
    assert(rows.length === 201, "坏域应从列表消失或数量不对：" + rows.length);
    const broken = rows.filter(function (r) { return r.broken; });
    assert(broken.length === 1 && /坏|损坏|BAD_JSON/.test(broken[0].issueText), "坏域没有被标记：" + JSON.stringify(broken[0] && broken[0].issueText));
    assert(w.M.search("Title 19").length >= 10, "标题搜索命中太少：" + w.M.search("Title 19").length);
    assert(w.M.search("Author3").length > 0, "作者搜索没命中");
    assert(w.M.search("2019").length > 0, "年份搜索没命中");
    assert(w.M.search("[19").length > 0, "正文显示文本搜索没命中");
    assert(w.M.search("", true).length === 1, "异常筛选应只剩 1 条坏域");
    return "201 行 / 4 类搜索 / 异常筛选 1";
  });

  await check("locator（页码）能进列表与搜索", async function () {
    const w = S.createWorld({
      path: "C:/tmp/manager.docx",
      fields: [{ start: 10, code: S.wordItemCode("citeLoc001", ["AAAA0001"], { json: { citationItems: [{ id: S.LIB + "/items/AAAA0001", locator: "42-45" }] } }), text: "[1, 42]" }],
    });
    const scan = w.S.scan(w.doc);
    const rows = w.M.load(scan, scan.issues);
    assert(rows[0].locator === "42-45", "页码没有进列表：" + rows[0].locator);
    assert(w.M.search("42-45").length === 1, "页码搜索没命中");
    return "locator=42-45";
  });

  await check("多文档快照不复用：重新 load 后行与 documentID 都跟着换", async function () {
    const a = S.createWorld({ path: "C:/tmp/doc-a.docx", fields: [{ start: 10, code: S.wordItemCode("citeAAA001", ["AAAA0001"]), text: "[1]" }] });
    const b = S.createWorld({ path: "C:/tmp/doc-b.docx", fields: [
      { start: 10, code: S.wordItemCode("citeBBB001", ["BBBB0002"]), text: "[1]" },
      { start: 20, code: S.wordItemCode("citeBBB002", ["BBBB0003"]), text: "[2]" },
    ] });
    const scanA = a.S.scan(a.doc), scanB = b.S.scan(b.doc);
    a.M.load(scanA, scanA.issues);
    const cmdA = a.M.command("locate", a.M.rows()[0].fieldID);
    assert(cmdA.documentID === "C:/tmp/doc-a.docx", "A 文档命令的 documentID 不对：" + cmdA.documentID);
    const rowsB = a.M.load(scanB, scanB.issues);          // 同一个 manager 模块切到 B
    assert(rowsB.length === 2, "切到 B 后行数不对：" + rowsB.length);
    const cmdB = a.M.command("locate", rowsB[0].fieldID);
    assert(cmdB.documentID === "C:/tmp/doc-b.docx", "B 文档命令的 documentID 不对：" + cmdB.documentID);
    assert(a.M.row(cmdA.fieldID) === null, "B 快照里还能查到 A 的域（快照串了）");
    return "A(1) → B(2)";
  });

  await check("命令按文档隔离：来自另一文档的命令被拒绝执行", async function () {
    const w = S.createWorld({ path: "C:/tmp/doc-current.docx", fields: [{ start: 10, code: S.wordItemCode("citeCur001", ["AAAA0001"]), text: "[1]" }] });
    const scan = w.S.scan(w.doc);
    w.M.load(scan, scan.issues);
    const selBefore = JSON.stringify(w.state.selection);
    const bad = await w.App.runManagerCommand({ action: "locate", fieldID: w.M.rows()[0].fieldID, documentID: "C:/tmp/doc-other.docx" });
    assert(bad.ok === false && bad.code === "WRONG_DOCUMENT", "跨文档命令没有被拒绝：" + JSON.stringify(bad));
    assert(JSON.stringify(w.state.selection) === selBefore, "被拒绝的命令还是动了选区");
    return "WRONG_DOCUMENT";
  });

  await check("无任务窗格/对话框 API 时退化为列表：仍能搜索并定位", async function () {
    const w = S.createWorld({
      path: "C:/tmp/panel-fallback.docx",
      fields: [
        { start: 10, code: S.wordItemCode("citeFb0001", ["AAAA0001"]), text: "[1]" },
        { start: 50, code: S.wordItemCode("citeFb0002", ["BBBB0002"]), text: "[2]" },
      ],
      selection: { start: 0, end: 0 },
    });
    let firstAsk = null, calls = 0;
    w.sandbox.prompt = function (text) {
      calls += 1;
      if (calls === 1) firstAsk = String(text);        // 第一次是搜索词
      if (calls === 1) return "";                      // 搜索词留空 = 列出全部
      return "2 定位";                                  // 第 2 条 → 定位
    };
    const r = await w.App.openManager();
    assert(r.ok === true, "降级列表打开失败：" + JSON.stringify(r));
    assert(calls === 2, "降级列表应弹两次输入框（搜索词 + 选择），实际 " + calls);
    assert(firstAsk && firstAsk.indexOf("引文管理") >= 0, "没有走降级列表（第一次 prompt 不是搜索词）");
    assert(w.state.selection.Start === 50, "降级列表没有定位到第 2 条：" + w.state.selection.Start);
    return "list → locate 50";
  });

  console.log("");
  console.log("通过 " + passed + " 项，失败 " + failed + " 项" + (failed === 0 ? "" : "，见上") + (failed === 0 ? "，全部通过" : ""));
  process.exit(failed === 0 ? 0 : 1);
})();
