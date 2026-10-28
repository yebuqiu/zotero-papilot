// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* P2 投稿与迁移工具：投稿前检查 / 无域副本 / 迁移兼容 / 修改记录 / 批量打开。
 *
 * 这一层的共同纪律：**只读或只写副本，绝不碰原稿**。
 *   - 投稿检查、迁移检查只读：不写域、不写文档属性、不动选区；
 *   - 无域副本：目标已存在不静默覆盖、取消/失败都不触碰原稿、原稿代码/docData/dirty 逐字不变；
 *   - 修改记录：一次操作一条、取消不记、200 条裁剪、导出/清空要确认；
 *   - 批量打开：按身份去重、默认 10 项上限、取消零打开、只重试 failed。
 *
 * 运行：node test/tools.test.js
 */
"use strict";

const S = require("./helpers/wps-stub.js");
const MIGRATION = require("./fixtures/migration.js");

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

/* ------------------------------------------------------------------ */
/* 投稿前检查样本                                                      */
/* ------------------------------------------------------------------ */

function preflightFixture() {
  const itemData = {
    AAAA1111: {
      itemType: "journalArticle", title: "Journal One", DOI: "10.1000/same",
      pages: "1-10", author: [{ family: "Zhang" }], issued: { "date-parts": [[2020]] },
    },
    BBBB2222: {
      itemType: "journalArticle", title: "Journal Two", DOI: "10.1000/same",
      author: [{ family: "Li" }], issued: { "date-parts": [[2021]] },
    },
    CCCC3333: {
      itemType: "book", title: "Book Without Pages", author: [{ family: "Wang" }], issued: { "date-parts": [[2018]] },
    },
    DDDD4444: {
      // 与 AAAA1111 标题+作者+年份一致，但身份与 DOI 不同 → 疑似重复
      itemType: "journalArticle", title: "Journal One", pages: "1-10",
      author: [{ family: "Zhang" }], issued: { "date-parts": [[2020]] },
    },
    EEEE5555: {
      itemType: "webpage", title: "A Web Page", author: [{ family: "Zhao" }], issued: { "date-parts": [[2022]] },
    },
    FFFF6666: {
      itemType: "book", title: "Uncited Reading", author: [{ family: "Qian" }], issued: { "date-parts": [[2017]] },
    },
  };
  const w = S.createWorld({
    path: "C:/tmp/preflight.docx",
    fields: [
      { start: 10, code: S.wordItemCode("citePf00001", ["AAAA1111"], { itemData: itemData }), text: "(Zhang, 2020)" },
      { start: 20, code: S.wordItemCode("citePf00002", ["BBBB2222"], { itemData: itemData }), text: "(Li, 2021)" },
      { start: 30, code: S.wordItemCode("citePf00003", ["CCCC3333"], { itemData: itemData }), text: "(Wang, 2018)" },
      { start: 40, code: S.wordItemCode("citePf00004", ["DDDD4444"], { itemData: itemData }), text: "(Zhang, 2020)" },
      { start: 50, code: S.wordItemCode("citePf00005", ["EEEE5555"], { itemData: itemData }), text: "(Zhao, 2022)" },
    ],
  });
  const bib = w.host.addField(null, w.doc.Range(90, 90), S.wordBiblCode({ uncited: [[S.LIB + "/items/FFFF6666"]] }));
  bib.Result.Text = "[1] Zhang. Journal One\n[2] Li. Journal Two\n[3] Wang. Book\n[4] Zhang. Journal One\n[5] Zhao. Web\n[6] Qian. Uncited Reading";
  const scan = w.S.scan(w.doc);
  return { world: w, scan: scan, library: itemData };
}

/* ------------------------------------------------------------------ */
/* 无域副本样本                                                        */
/* ------------------------------------------------------------------ */

const SOURCE = "C:/tmp/thesis.docx";
const TARGET = "C:/tmp/thesis_无引文域.docx";

function exportWorld() {
  return S.createWorld({
    path: SOURCE,
    contentText: "正文[1]与脚注[2]结束",
    fields: [
      { start: 10, code: S.wordItemCode("citeExp001", ["AAAA1111"]), text: "[1]" },
      { start: 20, code: 'PAGE \\* MERGEFORMAT', text: "1" },                       // 非 Zotero 域：必须原样保留
    ],
    notes: { footnote: [{ refStart: 40, fields: [{ code: S.wordItemCode("citeExp002", ["BBBB2222"]), text: "[2]" }] }] },
    docData: '{"style":{"styleID":"http://www.zotero.org/styles/apa"}}',
  });
}

/** 造一个"副本世界"（同内容、独立域），并把它设为 ActiveDocument。 */
function makeCopy(w, path) {
  const copy = S.createWorld({
    path: path,
    contentText: w.host.content.Text,
    fields: [
      { start: 10, code: S.wordItemCode("citeExp001", ["AAAA1111"]), text: "[1]" },
      { start: 20, code: 'PAGE \\* MERGEFORMAT', text: "1" },
    ],
    notes: { footnote: [{ refStart: 40, fields: [{ code: S.wordItemCode("citeExp002", ["BBBB2222"]), text: "[2]" }] }] },
    docData: '{"style":{"styleID":"http://www.zotero.org/styles/apa"}}',
  });
  w.app.ActiveDocument = copy.doc;
  return copy;
}

function exportOptions(w, overrides) {
  const o = {
    doc: w.doc,
    app: w.app,
    targetPath: TARGET,
    pathExists: async function (p) { return S.normalizePath(p) === S.normalizePath(SOURCE); },
    saveAs: function (doc, path) { makeCopy(w, path); return "custom"; },
    unlink: function (field) { field.Unlink(); },
    confirm: function () { return true; },
  };
  return Object.assign(o, overrides || {});
}

(async function main() {
  console.log("== A. 投稿前检查：数量 / 未引 / 重复 / 按类型字段建议 ==");

  await check("计数：引文域、正文/注文、唯一文献、文献表条目、差异", async function () {
    const f = preflightFixture();
    const r = f.world.H.preflight(f.scan, { zoteroConnected: true, styleID: "http://www.zotero.org/styles/apa" });
    assert(r.readOnly === true, "投稿检查必须是只读的");
    assert(r.counts.citationFields === 5, "引文域数不对：" + r.counts.citationFields);
    assert(r.counts.bodyCitations === 5 && r.counts.footnoteCitations === 0, "正文/注文计数不对");
    assert(r.counts.uniqueItems === 5, "唯一文献数不对：" + r.counts.uniqueItems);
    assert(r.counts.bibliographyEntries === 6, "文献表条目数不对：" + r.counts.bibliographyEntries);
    assert(r.counts.uncitedItems === 1, "未引用条目数不对：" + r.counts.uncitedItems);
    assert(r.counts.difference === 1, "差异（文献表 - 唯一文献）不对：" + r.counts.difference);
    return "5 域 / 5 唯一 / 6 条 / 1 未引";
  });

  await check("uncited 条目单独列出，带身份与元数据", async function () {
    const f = preflightFixture();
    const r = f.world.H.preflight(f.scan, { zoteroConnected: true, library: f.library });
    assert(r.uncited.length === 1, "uncited 列表长度不对：" + r.uncited.length);
    const row = r.uncited[0];
    assert(row.identity === "users:1:FFFF6666", "uncited 身份不对：" + row.identity);
    assert(row.title === "Uncited Reading", "uncited 标题没带出来：" + row.title);
    assert(r.findings.some(function (x) { return x.kind === "UNCITED_ITEM"; }), "没有 UNCITED_ITEM 问题项");
    return row.title;
  });

  await check("重复判定顺序：身份 → DOI → 元数据（最后一级只标“疑似”）", async function () {
    const f = preflightFixture();
    const r = f.world.H.preflight(f.scan, { zoteroConnected: true });
    const byKind = {};
    r.duplicates.forEach(function (d) { byKind[d.kind] = d; });
    assert(byKind.DUPLICATE_DOI, "同一 DOI 没被识别为重复：" + JSON.stringify(r.duplicates.map(function (d) { return d.kind; })));
    assert(byKind.DUPLICATE_DOI.count === 2, "DOI 重复数量不对：" + byKind.DUPLICATE_DOI.count);
    assert(byKind.DUPLICATE_METADATA, "标题+作者+年份相同没被标疑似重复");
    assert(byKind.DUPLICATE_METADATA.suspected === true, "元数据级重复必须标“疑似”");
    assert(/仅标疑似|人工核对/.test(byKind.DUPLICATE_METADATA.action), "疑似重复的建议动作不清楚");
    const finding = r.findings.filter(function (x) { return x.kind === "DUPLICATE_METADATA"; })[0];
    assert(finding && finding.severity === "info" && finding.suspected === true, "疑似重复不应升级成错误");
    return "DOI + 疑似元数据";
  });

  await check("页码/DOI 按文献类型只给建议：期刊缺则提示，书籍/网页不误报", async function () {
    const f = preflightFixture();
    const r = f.world.H.preflight(f.scan, { zoteroConnected: true, styleID: "http://www.zotero.org/styles/apa" });
    const byTitle = {};
    r.suggestions.forEach(function (x) { byTitle[x.item.key] = x; });
    assert(byTitle.BBBB2222, "期刊缺页码应给建议");
    assert(byTitle.BBBB2222.kind === "MISSING_PAGE" && byTitle.BBBB2222.severity === "info", "页码建议的级别不对");
    assert(byTitle.BBBB2222.reason.indexOf("建议") >= 0 || /建议/.test(byTitle.BBBB2222.summary), "页码问题没有标成建议级");
    assert(!byTitle.CCCC3333, "书籍被误报缺页码/DOI");
    assert(!byTitle.EEEE5555, "网页被误报缺页码/DOI");
    // 期刊缺 DOI 也应该提示（DDDD4444 是期刊且没有 DOI）
    const doiSuggestion = r.suggestions.filter(function (x) { return x.kind === "MISSING_DOI"; }).map(function (x) { return x.item.key; });
    assert(doiSuggestion.indexOf("DDDD4444") >= 0, "期刊缺 DOI 没有建议：" + doiSuggestion.join(","));
    assert(doiSuggestion.indexOf("CCCC3333") < 0, "书籍不应提示缺 DOI");
    assert(doiSuggestion.indexOf("EEEE5555") < 0, "网页不应提示缺 DOI");
    return "期刊 2 类建议 / 书籍网页 0";
  });

  await check("报告可导出为文本，且每条问题都能定位（含 fieldID/容器）", async function () {
    const f = preflightFixture();
    const r = f.world.H.preflight(f.scan, { zoteroConnected: true, library: f.library });
    const text = f.world.H.reportText(r);
    assert(text.indexOf("投稿前检查") >= 0, "导出文本没有标题");
    assert(text.indexOf("未引用条目") >= 0 && text.indexOf("Uncited Reading") >= 0, "导出文本没列出未引用条目");
    assert(text.indexOf("页码 / DOI 建议") >= 0, "导出文本没有建议段");
    const locatable = r.findings.filter(function (x) { return x.target && x.target.fieldID; });
    assert(locatable.length > 0, "没有任何问题能定位到域");
    return text.split("\n").length + " 行";
  });

  await check("投稿检查只读：不改域、不改选区、不写属性", async function () {
    const f = preflightFixture();
    const before = f.world.snapshot();
    f.world.H.preflight(f.world.S.scan(f.world.doc), { zoteroConnected: true });
    assert(JSON.stringify(f.world.snapshot()) === JSON.stringify(before), "投稿检查改动了文档");
    return "只读";
  });

  console.log("\n== B. 另存无 Zotero 域副本：原稿逐字不变 ==");

  await check("成功路径：副本 Zotero 域=0、非 Zotero 域/注文/文本保留、原稿代码/docData/dirty 不变", async function () {
    const w = exportWorld();
    const before = w.snapshot();
    const docDataBefore = w.I.__readDocDataForRecovery();
    const r = await w.T.exportUnlinkedCopy(exportOptions(w));
    assert(r.ok === true, "导出失败：" + JSON.stringify(r));
    assert(r.code === "OK", "code 不对：" + r.code);
    assert(r.counts.zoteroFieldsAfter === 0, "副本里还有 Zotero 域：" + r.counts.zoteroFieldsAfter);
    assert(r.counts.removedFields === 2, "移除的 Zotero 域数不对：" + r.counts.removedFields);
    assert(r.counts.nonZoteroFields === 1, "非 Zotero 域数不对：" + r.counts.nonZoteroFields);
    assert(r.copyPath === TARGET, "副本路径不对：" + r.copyPath);
    // 原稿：路径/域代码/文档数据/修改状态/注文数量/文件存在性 全部不变
    assert(r.original.pathUnchanged && r.original.codesUnchanged && r.original.docDataUnchanged && r.original.dirtyUnchanged,
      "原稿回读校验没通过：" + JSON.stringify(r.original));
    assert(JSON.stringify(w.snapshot()) === JSON.stringify(before), "原稿被改动了（域/选区/文本/属性）");
    assert(w.I.__readDocDataForRecovery() === docDataBefore, "原稿 Zotero 文档数据被改了");
    assert(w.doc.Saved === true, "原稿的“已保存”状态被改了");
    return "副本 0 域 / 原稿不变";
  });

  await check("目标文件已存在：拒绝覆盖（不调用另存）", async function () {
    const w = exportWorld();
    let saved = 0;
    const r = await w.T.exportUnlinkedCopy(exportOptions(w, {
      pathExists: async function () { return true; },
      saveAs: function () { saved += 1; return "custom"; },
    }));
    assert(r.ok === false && r.code === "TARGET_EXISTS", "已存在目标没有拒绝：" + JSON.stringify(r));
    assert(saved === 0, "已存在目标却调用了另存（会静默覆盖）");
    assert(/换一个路径/.test(r.error), "提示没有让用户换路径：" + r.error);
    return "TARGET_EXISTS";
  });

  await check("默认文件名已存在：自动生成不重名的唯一名（_无引文域 (2)）", async function () {
    const w = exportWorld();
    let usedPath = "";
    const r = await w.T.exportUnlinkedCopy(exportOptions(w, {
      targetPath: "",
      pathExists: async function (p) {
        const norm = S.normalizePath(p);
        return norm === S.normalizePath(SOURCE) || norm === S.normalizePath(TARGET);
      },
      saveAs: function (doc, path) { usedPath = path; makeCopy(w, path); return "custom"; },
    }));
    assert(r.ok === true, "唯一名导出失败：" + JSON.stringify(r));
    assert(/_无引文域 \(2\)\.docx$/.test(usedPath), "没有生成唯一名：" + usedPath);
    return usedPath.split("/").pop();
  });

  await check("用户取消确认：不创建副本、原稿不变", async function () {
    const w = exportWorld();
    let saved = 0;
    const before = w.snapshot();
    const r = await w.T.exportUnlinkedCopy(exportOptions(w, {
      confirm: function () { return false; },
      saveAs: function () { saved += 1; return "custom"; },
    }));
    assert(r.ok === false && r.cancelled === true && r.code === "CANCELLED", "取消没有如实返回：" + JSON.stringify(r));
    assert(saved === 0, "取消后仍然调用了另存");
    assert(JSON.stringify(w.snapshot()) === JSON.stringify(before), "取消后原稿被改动");
    return "CANCELLED";
  });

  await check("另存失败：SAVE_FAILED，原稿未移除任何域", async function () {
    const w = exportWorld();
    const r = await w.T.exportUnlinkedCopy(exportOptions(w, {
      saveAs: function () { throw new Error("磁盘已满"); },
    }));
    assert(r.ok === false && r.code === "SAVE_FAILED", "另存失败没有如实返回：" + r.code);
    assert(/原稿未被修改/.test(r.error), "没有说明原稿未受影响：" + r.error);
    assert(w.state.bodyFields.length === 2 && w.state.notes.footnote[0].__fields.length === 1, "原稿的域被动了");
    return "SAVE_FAILED";
  });

  await check("移除域失败：UNLINK_FAILED + copyIncomplete，原稿未被移除任何域", async function () {
    const w = exportWorld();
    const r = await w.T.exportUnlinkedCopy(exportOptions(w, {
      unlink: function () { throw new Error("该字段不支持 Unlink"); },
    }));
    assert(r.ok === false && r.code === "UNLINK_FAILED", "移除失败没有如实返回：" + r.code);
    assert(r.copyIncomplete === true, "没有标记副本不完整");
    assert(w.state.bodyFields.length === 2, "原稿的域被移除了");
    return "UNLINK_FAILED";
  });

  await check("另存后活动文档不是副本：立即停止，绝不继续移除域", async function () {
    const w = exportWorld();
    let unlinked = 0;
    const r = await w.T.exportUnlinkedCopy(exportOptions(w, {
      saveAs: function () { return "custom"; },        // 什么都没切换
      copyDoc: w.doc,
      unlink: function () { unlinked += 1; },
    }));
    assert(r.ok === false && r.code === "ACTIVE_DOCUMENT_MISMATCH", "活动文档不是副本却没有停：" + r.code);
    assert(unlinked === 0, "在错误的文档上执行了移除域");
    assert(w.state.bodyFields.length === 2, "原稿被改了");
    return "ACTIVE_DOCUMENT_MISMATCH";
  });

  await check("宿主把 SaveAs2 实现成“改名原稿”：检出原稿路径变化并停止", async function () {
    const w = exportWorld();
    w.doc.SaveAs2 = function (path) { w.doc.FullName = path; makeCopy(w, path); };
    let unlinked = 0;
    const r = await w.T.exportUnlinkedCopy(exportOptions(w, {
      saveAs: undefined,                                // 走真实 saveAs 分支 → SaveAs2
      unlink: function () { unlinked += 1; },
    }));
    assert(r.ok === false && r.code === "ORIGINAL_PATH_CHANGED", "改名原稿没有被检出：" + r.code + " / " + r.error);
    assert(unlinked === 0, "原稿路径变了还继续移除域");
    return "ORIGINAL_PATH_CHANGED";
  });

  await check("未保存的新文档：拒绝生成副本（先另存为 .docx）", async function () {
    const w = S.createWorld({ path: "", fields: [{ start: 10, code: S.wordItemCode("citeUnsave", ["AAAA1111"]), text: "[1]" }] });
    const r = await w.T.exportUnlinkedCopy({ doc: w.doc, app: w.app });
    assert(r.ok === false && r.code === "UNSAVED_DOCUMENT", "未保存文档没有拒绝：" + r.code);
    return "UNSAVED_DOCUMENT";
  });

  await check("同一文档并发导出：第二次直接 BUSY（不会两个事务一起改副本）", async function () {
    const w = exportWorld();
    let release = null;
    const gate = new Promise(function (r) { release = r; });
    const first = w.T.exportUnlinkedCopy(exportOptions(w, {
      confirm: async function () { await gate; return false; },
    }));
    await new Promise(function (r) { setTimeout(r, 10); });
    const second = await w.T.exportUnlinkedCopy(exportOptions(w));
    assert(second.ok === false && second.code === "BUSY", "并发导出没有拦住：" + JSON.stringify(second));
    release();
    await first;
    assert(w.T.isBusy(w.sandbox.PPDoc.documentID(w.doc)) === false, "导出结束后 busy 标记没有清掉");
    return "BUSY";
  });

  console.log("\n== C. 迁移兼容：direct / reconnect / plainText / unverified ==");

  for (const c of MIGRATION.cases()) {
    await check("迁移：" + c.name, async function () {
      const built = c.make();
      const ctx = Object.assign({}, c.context || {});
      if (built.docData !== undefined) ctx.docData = built.docData;
      const r = built.world.H.compatibility(built.scan, c.caps || null, c.target, ctx);
      assert(r.readOnly === true, "迁移检查必须是只读的");
      assert(r.verdict === c.expect, "结论应为 " + c.expect + "，实际 " + r.verdict + "（" + r.reason + "）");
      assert(r.note.indexOf("只读") >= 0, "报告没有声明只读");
      const text = built.world.H.reportText(r);
      assert(text.indexOf("迁移兼容检查") >= 0 && text.indexOf(r.verdictLabel) >= 0, "导出文本没有结论");
      return r.verdict;
    });
  }

  await check("迁移检查不改文档、不自动转换", async function () {
    const built = MIGRATION.cases()[0].make();
    const before = built.world.snapshot();
    built.world.H.compatibility(built.scan, MIGRATION.CAPS_FULL, "wps", { docData: built.docData });
    assert(JSON.stringify(built.world.snapshot()) === JSON.stringify(before), "迁移检查改动了文档");
    return "只读";
  });

  console.log("\n== D. 修改记录：一次操作一条、取消不记、200 裁剪、确认门禁 ==");

  await check("各操作各记一条，取消不记，字段含时间/操作/结果/数量", async function () {
    const w = S.createWorld({ path: "C:/tmp/audit.docx" });
    w.A.record(w.doc.FullName, { operation: "addCitation", ok: true, count: 1, summary: "插入 1 条" });
    w.A.record(w.doc.FullName, { operation: "refresh", ok: true, count: 12, summary: "刷新完成" });
    w.A.record(w.doc.FullName, { operation: "refresh", cancelled: true });
    const rows = w.A.list(w.doc.FullName);
    assert(rows.length === 2, "记录条数不对（取消不应记）：" + rows.length);
    assert(rows[0].operation === "addCitation" && rows[0].label === "插入引文", "操作名/标签不对：" + JSON.stringify(rows[0]));
    assert(rows[0].at && rows[0].result === "success" && rows[0].count === 1, "记录字段不全");
    assert(rows[1].count === 12 && rows[1].mode === "manual", "刷新记录的计数/模式不对");
    return "2 条 / 取消未记";
  });

  await check("超过 200 条滚动裁剪（只留最近 200）", async function () {
    const w = S.createWorld({ path: "C:/tmp/audit.docx" });
    for (let i = 0; i < 205; i++) w.A.record(w.doc.FullName, { operation: "refresh", count: i });
    const rows = w.A.list(w.doc.FullName);
    assert(rows.length === 200, "裁剪后应为 200 条，实际 " + rows.length);
    assert(rows[rows.length - 1].count === 204, "最后一条不是最新的：" + rows[rows.length - 1].count);
    assert(rows[0].count === 5, "最早一条没有被裁掉：" + rows[0].count);
    return "205 → 200";
  });

  await check("重开后可读；记录里不出现完整路径", async function () {
    const shared = {
      __data: new Map(),
      getItem(k) { return this.__data.has(k) ? this.__data.get(k) : null; },
      setItem(k, v) { this.__data.set(k, String(v)); },
      removeItem(k) { this.__data.delete(k); },
    };
    const a = S.createWorld({ path: "C:/Users/someone/secret/thesis.docx", localStorage: shared });
    a.A.record(a.doc.FullName, { operation: "styleChange", ok: true, from: "apa", to: "nature", count: 3 });
    const b = S.createWorld({ path: "C:/Users/someone/secret/thesis.docx", localStorage: shared });
    const rows = b.A.list(b.doc.FullName);
    assert(rows.length === 1, "重开后记录丢失：" + rows.length);
    assert(rows[0].document === "thesis.docx", "记录里出现了完整路径：" + rows[0].document);
    assert(rows[0].from === "apa" && rows[0].to === "nature", "前后样式没记准");
    return "1 条 / 仅文件名";
  });

  await check("导出与清空必须显式确认；记录失败不阻断业务", async function () {
    const w = S.createWorld({ path: "C:/tmp/audit.docx" });
    w.A.record(w.doc.FullName, { operation: "refresh", count: 1 });
    assert(w.A.exportRows(w.doc.FullName).code === "CONFIRM_REQUIRED", "未确认就能导出");
    assert(w.A.clear(w.doc.FullName).code === "CONFIRM_REQUIRED", "未确认就能清空");
    const exp = w.A.exportRows(w.doc.FullName, true);
    assert(exp.ok === true && exp.text.indexOf("引文修改记录") >= 0, "确认后导出失败");
    assert(exp.text.indexOf("正文") >= 0 || exp.text.indexOf("导出不包含正文全文") >= 0, "导出文本没有声明不含正文");
    assert(w.A.clear(w.doc.FullName, true).ok === true && w.A.list(w.doc.FullName).length === 0, "确认后清空失败");
    // 记录失败（localStorage 抛错）不影响返回
    const broken = S.createWorld({
      path: "C:/tmp/audit2.docx",
      localStorage: { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); } },
    });
    const r = broken.A.record(broken.doc.FullName, { operation: "refresh", count: 2 });
    assert(r.ok === true, "存储失败把记录变成了业务失败：" + JSON.stringify(r));
    return "确认门禁 + 容错";
  });

  console.log("\n== E. 批量打开：去重 / 10 项上限 / 只重试失败 ==");

  function targets() {
    return [
      { key: "AAAA1111", libType: "users", libId: 1, itemData: { title: "A", DOI: "10.1000/a" } },
      { key: "AAAA1111", libType: "users", libId: 1, itemData: { title: "A", DOI: "10.1000/a" } },
      { key: "BBBB2222", libType: "groups", libId: 42, itemData: { title: "B" } },
      { key: "CCCC3333", libType: "users", libId: 1, itemData: { title: "C" } },
    ];
  }

  await check("按身份去重；个人库/群组库 URI 正确；无 DOI 的项跳过并说明", async function () {
    const w = S.createWorld({});
    const opened = [];
    const r = await w.E.openTargets(targets(), "zotero", { openUri: async function (u) { opened.push(u); } });
    assert(r.ok === true && r.count === 3, "去重后应只打开 3 项，实际 " + r.count);
    assert(opened[0] === "zotero://select/library/items/AAAA1111", "个人库 URI 不对：" + opened[0]);
    assert(opened[1] === "zotero://select/groups/42/items/BBBB2222", "群组库 URI 不对：" + opened[1]);
    const doiResult = await w.E.openTargets(targets(), "doi", { openUri: async function (u) { opened.push(u); } });
    assert(doiResult.skipped.length === 2, "无 DOI 的项应跳过（B、C），实际 " + doiResult.skipped.length);
    assert(/没有 DOI/.test(doiResult.skipped[0].reason), "跳过原因不清楚：" + doiResult.skipped[0].reason);
    const openedDOI = doiResult.opened.map(function (x) { return x.uri; })[0];
    assert(openedDOI === "https://doi.org/10.1000/a", "DOI URI 不对：" + openedDOI);
    return "3 打开 / 2 跳过";
  });

  await check("默认 10 项上限：11 项需确认，取消则零打开", async function () {
    const w = S.createWorld({});
    const many = [];
    for (let i = 0; i < 11; i++) many.push({ key: "ITEM" + String(i).padStart(4, "0"), libType: "users", libId: 1 });
    let opened = 0;
    const r1 = await w.E.openTargets(many, "zotero", { openUri: async function () { opened += 1; } });
    assert(r1.ok === false && r1.code === "CONFIRM_REQUIRED" && r1.max === 10, "超限没有要求确认：" + JSON.stringify(r1));
    assert(opened === 0, "要求确认之前就打开了 " + opened + " 项");
    const r2 = await w.E.openTargets(many, "zotero", { confirm: function () { return false; }, openUri: async function () { opened += 1; } });
    assert(r2.cancelled === true && opened === 0, "取消后仍打开了 " + opened + " 项");
    let asked = null;
    const r3 = await w.E.openTargets(many, "zotero", {
      confirm: function (info) { asked = info; return true; },
      openUri: async function () { opened += 1; },
    });
    assert(r3.ok === true && opened === 11, "确认后应打开 11 项，实际 " + opened);
    assert(asked && asked.count === 11 && asked.max === 10, "确认信息不对：" + JSON.stringify(asked));
    return "11 需确认，取消 0 打开";
  });

  await check("部分失败：只重试 failed，成功项不重复打开", async function () {
    const w = S.createWorld({});
    const opened = [];
    let firstTry = true;
    const openUri = async function (u) {
      if (firstTry && u.indexOf("AAAA1111") >= 0) { firstTry = false; throw new Error("系统拒绝打开"); }
      opened.push(u);
    };
    const r1 = await w.E.openTargets(targets(), "zotero", { openUri: openUri });
    assert(r1.ok === false && r1.code === "PARTIAL_FAILED", "部分失败没有如实返回：" + r1.code);
    assert(r1.failed.length === 1 && r1.opened.length === 2, "成功/失败计数不对：" + r1.opened.length + "/" + r1.failed.length);
    const openedBefore = opened.length;
    const r2 = await w.E.retry(r1, { openUri: openUri });
    assert(r2.ok === true && r2.retried === 1, "只应重试 1 项，实际 " + r2.retried);
    assert(opened.length === openedBefore + 1, "重试把成功项又打开了一遍");
    assert(r2.opened.length === 3 && r2.failed.length === 0, "重试后的汇总不对");
    // 没有失败项时重试是空操作
    const r3 = await w.E.retry(r2, { openUri: openUri });
    assert(r3.code === "NOTHING_TO_RETRY", "无失败项时不应重试：" + r3.code);
    return "1 重试 / 0 重复";
  });

  await check("未知打开类型被拒绝（不会静默当成 Zotero 打开）", async function () {
    const w = S.createWorld({});
    const r = await w.E.openTargets(targets(), "ftp", { openUri: async function () {} });
    assert(r.ok === false && r.code === "UNKNOWN_KIND", "未知类型没有拒绝：" + r.code);
    return "UNKNOWN_KIND";
  });

  console.log("");
  console.log("通过 " + passed + " 项，失败 " + failed + " 项" + (failed === 0 ? "，全部通过" : ""));
  process.exit(failed === 0 ? 0 : 1);
})();
