// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* P0-2 文档引文体检 + P0-3 文献表条目身份。
 *
 * 体检的六类：缺失条目 / 重复域身份 / 坏 JSON 截断 / 文献表未刷新 / 手改引文 / 无法定位。
 * 身份的核心纪律：只用可验证条目 ID 或唯一完整元数据；同题、无标题、重复条目一律不猜。
 *
 * 运行：node test/health.test.js
 */
"use strict";

const S = require("./helpers/wps-stub.js");
const BAD = require("./fixtures/bad-fields.js");
const IDS = require("./fixtures/identities.js");

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

function inspectAll(world, context) {
  const scan = world.S.scan(world.doc);
  return world.H.inspect(scan, context);
}

(async function main() {
  console.log("== A. 体检：六类逐项命中，正常文档零误报 ==");

  await check("正常文档零误报（条目齐全 / 指纹一致 / 可定位 / 已连接）", async function () {
    const f = BAD.normal();
    const issues = inspectAll(f.world, {
      library: f.library, lastSuccess: { fingerprint: f.world.S.fingerprint(f.world.S.scan(f.world.doc)) },
      fingerprint: f.world.S.fingerprint(f.world.S.scan(f.world.doc)), canLocate: f.canLocate, zoteroConnected: true,
    });
    assert(issues.length === 0, "正常文档误报了 " + issues.length + " 条：" + issues.map(function (i) { return i.kind; }).join(","));
    return "0 条";
  });

  await check("六类集中命中：缺失 / 重复身份 / 坏域 / 未刷新 / 手改 / 无法定位", async function () {
    const f = BAD.all();
    const issues = inspectAll(f.world, {
      library: f.library, canLocate: f.canLocate, lastSuccess: f.lastSuccess, fingerprint: f.fingerprint, zoteroConnected: true,
    });
    const kinds = new Set(issues.map(function (i) { return i.kind; }));
    const want = ["MISSING_ITEM", "DUPLICATE_FIELD_ID", "BAD_FIELD", "BIBLIOGRAPHY_STALE", "MANUAL_CITATION_EDIT", "UNREACHABLE_FIELD"];
    const missing = want.filter(function (k) { return !kinds.has(k); });
    assert(!missing.length, "缺少问题类型：" + missing.join(",") + "（实际：" + Array.from(kinds).join(",") + "）");
    const sev = issues.find(function (i) { return i.kind === "MISSING_ITEM"; });
    assert(sev.severity === "error", "缺失条目应为 error 级");
    const manual = issues.find(function (i) { return i.kind === "MANUAL_CITATION_EDIT"; });
    assert(manual.severity === "warning", "手改应为 warning 级");
    return want.length + " 类";
  });

  await check("六类各自单独命中（分类不串味）", async function () {
    const expect = {
      MISSING_ITEM: "MISSING_ITEM", DUPLICATE_FIELD_ID: "DUPLICATE_FIELD_ID", BAD_FIELD: "BAD_FIELD",
      MANUAL_CITATION_EDIT: "MANUAL_CITATION_EDIT", UNREACHABLE_FIELD: "UNREACHABLE_FIELD", BIBLIOGRAPHY_STALE: "BIBLIOGRAPHY_STALE",
    };
    for (const kind of Object.keys(expect)) {
      const f = BAD.only(kind);
      const issues = inspectAll(f.world, { library: f.library, canLocate: f.canLocate, lastSuccess: f.lastSuccess, fingerprint: f.fingerprint, zoteroConnected: true });
      const kinds = issues.map(function (i) { return i.kind; });
      assert(kinds.indexOf(kind) >= 0, kind + " 单独样本没有命中（实际：" + kinds.join(",") + "）");
      const others = kinds.filter(function (k) { return k !== kind; });
      assert(others.length === 0, kind + " 样本误报了其他类型：" + others.join(","));
    }
    return "6/6";
  });

  await check("每条问题都带 severity / 位置 / 摘要 / 原因 / 建议动作", async function () {
    const f = BAD.all();
    const issues = inspectAll(f.world, { library: f.library, canLocate: f.canLocate, lastSuccess: f.lastSuccess, fingerprint: f.fingerprint, zoteroConnected: true });
    for (const i of issues) {
      assert(i.severity === "error" || i.severity === "warning" || i.severity === "info", "严重级别非法：" + i.severity);
      assert(String(i.summary || "").length > 0, i.kind + " 缺摘要");
      assert(String(i.reason || "").length > 0, i.kind + " 缺原因");
      assert(String(i.action || "").length > 0, i.kind + " 缺建议动作（用户不知道怎么办）");
      if (i.kind !== "ZOTERO_OFFLINE" && i.kind !== "BIBLIOGRAPHY_MISSING" && i.kind !== "BIBLIOGRAPHY_STALE") {
        assert(typeof i.noteIndex === "number", i.kind + " 缺位置信息");
      }
    }
    return issues.length + " 条字段齐全";
  });

  await check("坏域不阻断其余扫描：好域仍然被逐条检查", async function () {
    const w = S.createWorld({
      fields: [
        { start: 10, code: S.wordItemCode("citeGood01", ["MISS0001"]), text: "[1]" },
        { start: 20, code: 'ADDIN ZOTERO_ITEM CSL_CITATION {"citationID":"citeBadd01",', text: "[2]" },
        { start: 30, code: S.wordItemCode("citeGood02", ["MISS0002"]), text: "[3]" },
      ],
    });
    const scan = w.S.scan(w.doc);
    const issues = w.H.inspect(scan, { library: new Map(), zoteroConnected: true });
    const missing = issues.filter(function (i) { return i.kind === "MISSING_ITEM"; });
    assert(missing.length === 2, "坏域把好域的检查挡住了：只有 " + missing.length + " 条缺失命中");
    assert(issues.some(function (i) { return i.kind === "BAD_FIELD"; }), "坏域本身没有被报出来");
    return "2 条缺失 + 1 条坏域";
  });

  await check("无文献表 / 无 Zotero 连接 / 无法定位分别给出可执行提示", async function () {
    const w = S.createWorld({ fields: [{ start: 10, code: S.wordItemCode("citeOnly01", ["AAAA0001"]), text: "[1]" }] });
    const scan = w.S.scan(w.doc);
    const issues = w.H.inspect(scan, { library: new Map([["AAAA0001", {}]]), zoteroConnected: false, canLocate: () => false });
    const byKind = {};
    issues.forEach(function (i) { byKind[i.kind] = i; });
    assert(byKind.BIBLIOGRAPHY_MISSING && /插入|文献表/.test(byKind.BIBLIOGRAPHY_MISSING.action), "缺文献表提示不可执行");
    assert(byKind.ZOTERO_OFFLINE && /Zotero/.test(byKind.ZOTERO_OFFLINE.action), "离线提示不可执行");
    assert(byKind.UNREACHABLE_FIELD && /定位|重建|扫描/.test(byKind.UNREACHABLE_FIELD.action), "无法定位提示不可执行");
    return "3 类提示";
  });

  await check("体检不改域、不改选区、不改文档属性（只读）", async function () {
    const f = BAD.all();
    const w = f.world;
    const before = w.snapshot();
    inspectAll(w, { library: f.library, canLocate: f.canLocate, lastSuccess: f.lastSuccess, fingerprint: f.fingerprint, zoteroConnected: true });
    const after = w.snapshot();
    assert(JSON.stringify(before) === JSON.stringify(after), "体检改动了文档（域/选区/属性/书签）");
    assert(w.state.props.length === 0, "体检写入了文档属性");
    return "前后逐字一致";
  });

  await check("手改判定做规范化：只有空白/标签/实体差异时不误报", async function () {
    const w = S.createWorld({
      fields: [
        { start: 10, code: S.wordItemCode("citeNorm01", ["AAAA0001"], { formattedCitation: "<sup>[1,&#160;2]</sup>" }), text: "[1, 2]" },
        { start: 20, code: S.wordItemCode("citeNorm02", ["BBBB0002"], { formattedCitation: "<i>Nature</i> 2020" }), text: "Nature 2020" },
      ],
    });
    const scan = w.S.scan(w.doc);
    const issues = w.H.inspect(scan, { library: new Map([["AAAA0001", {}], ["BBBB0002", {}]]), zoteroConnected: true });
    const manual = issues.filter(function (i) { return i.kind === "MANUAL_CITATION_EDIT"; });
    assert(manual.length === 0, "格式噪声被当成手改误报：" + manual.map(function (i) { return i.fieldID; }).join(","));
    return "0 误报";
  });

  console.log("\n== B. 文献表身份：重排/增删保持，歧义不猜 ==");

  await check("作者—年制：条目顺序与正文引用顺序不同，仍逐条命中正确身份", async function () {
    const { world, scan } = IDS.scanWith();
    const r = world.BM.rebuild(scan, IDS.AUTHOR_YEAR_ENTRIES, {});
    assert(r.entries.length === 2, "两条条目都应映射，实际 " + r.entries.length + "（issues: " + JSON.stringify(r.issues.map(function (i) { return i.kind; })) + "）");
    const byText = {};
    r.entries.forEach(function (e) { byText[e.text.slice(0, 3)] = e.identity; });
    assert(byText["Li,"] === "users:1:BBBB0002", "Li 条目没映射到 BBBB0002：" + byText["Li,"]);
    assert(byText["Zha"] === "users:1:AAAA0001", "Zhang 条目没映射到 AAAA0001：" + byText["Zha"]);
    return "2/2 身份正确";
  });

  await check("数字制：按首次引用顺序编号，正文增删后重排仍对上身份", async function () {
    const first = IDS.scanWith([["AAAA0001"], ["BBBB0002"]]);
    const r1 = first.world.BM.rebuild(first.scan, IDS.NUMERIC_ENTRIES, { citationOrderNumeric: true });
    assert(r1.entries.length === 2, "首轮应有 2 条映射");
    // 删掉第一条引文后，原 [2] 变成 [1]（Zotero 会重排编号）
    const second = IDS.scanWith([["BBBB0002"]]);
    const r2 = second.world.BM.rebuild(second.scan, [{ text: "[1] Li B. Beta Study of Note Cascades. 2021.", start: 0, end: 44 }], { citationOrderNumeric: true });
    assert(r2.entries.length === 1 && r2.entries[0].identity === "users:1:BBBB0002",
      "重排后没有对上身份：" + JSON.stringify(r2.entries.map(function (e) { return e.identity; })));
    return "[1]→BBBB0002";
  });

  await check("条目级 ID 优先：乱序的 citeproc 输出按 id 命中，不看文本顺序", async function () {
    const { world, scan } = IDS.scanWith();
    const r = world.BM.rebuild(scan, IDS.DIRECT_ENTRIES, {});
    const byIndex = r.mappings;
    assert(byIndex[0] === "users:1:BBBB0002" && byIndex[1] === "users:1:AAAA0001",
      "条目级 ID 没被优先使用：" + JSON.stringify(byIndex));
    return "2/2 按 id";
  });

  await check("同题同作者：不得建立猜测链接，标身份歧义", async function () {
    const w = S.createWorld({
      fields: [
        { start: 10, code: S.wordItemCode("citeSame01", ["AAAA0001"], { formattedCitation: "Zhang 2020" }), text: "(Zhang, 2020)" },
        { start: 20, code: S.wordItemCode("citeSame02", ["AAAA0002"], { formattedCitation: "Zhang 2020" }), text: "(Zhang, 2020)" },
        { start: 30, code: S.wordItemCode("citeSame03", ["AAAA0003"], { formattedCitation: "Zhang 2020" }), text: "(Zhang, 2020)" },
      ],
    });
    // 三条不同身份，但元数据（标题+作者+年份）完全一样
    const data = { itemType: "journalArticle", title: "Alpha Study of Citation Reliability", creators: [{ family: "Zhang" }], issued: { "date-parts": [[2020]] } };
    const scan = w.S.scan(w.doc);
    const r = w.BM.rebuild(scan, IDS.SAME_TITLE_ENTRIES, {});
    assert(r.entries.length === 0, "同题同作者被猜成了 " + r.entries.length + " 条链接");
    assert(r.issues.length === 1 && r.issues[0].kind === "IDENTITY_AMBIGUOUS", "没有标身份歧义：" + JSON.stringify(r.issues));
    assert(data.title.length > 0, "样本元数据不完整");
    return "0 链接 / 1 歧义";
  });

  await check("无标题条目：不建立猜测链接", async function () {
    const w = S.createWorld({ fields: [{ start: 10, code: S.wordItemCode("citeNoTit1", ["AAAA0001"]), text: "(Zhang, 2020)" }] });
    const scan = w.S.scan(w.doc);
    const r = w.BM.rebuild(scan, IDS.NO_TITLE_ENTRIES, {});
    assert(r.entries.length === 0, "无标题条目被猜成了链接");
    assert(r.issues[0] && r.issues[0].kind === "IDENTITY_AMBIGUOUS", "没有标歧义");
    return "0 链接";
  });

  await check("文献表里出现重复条目：第二条不重复建链，标歧义", async function () {
    const { world, scan } = IDS.scanWith([["AAAA0001"]]);
    const text = "Zhang, A. (2020). Alpha Study of Citation Reliability. Journal of Tests.";
    const r = world.BM.rebuild(scan, [{ text: text, start: 0, end: text.length }, { text: text, start: 100, end: 100 + text.length }], {});
    assert(r.entries.length === 1, "重复条目被建了两条链接");
    assert(r.issues.length === 1 && r.issues[0].kind === "IDENTITY_AMBIGUOUS", "重复条目没有标歧义");
    assert(r.unresolved === 1, "unresolved 计数不对：" + r.unresolved);
    return "1 链接 + 1 歧义";
  });

  await check("旧映射指纹不匹配时绝不复用（缺 metadata 字段的老记录不参与）", async function () {
    const { world, scan } = IDS.scanWith([["BBBB0002"]]);
    const legacy = { 0: { identity: "users:1:BBBB0002", text: "完全不同的旧文本" } };   // 老版本：没有 metadata 指纹
    const r = world.BM.rebuild(scan, [{ text: "[9] 无法识别的条目文本", start: 0, end: 20 }], { previous: legacy });
    assert(r.entries.length === 0, "老映射被直接继承了（会把链接指到错误条目）");
    assert(r.issues[0] && r.issues[0].kind === "IDENTITY_AMBIGUOUS", "没有标歧义");
    return "0 复用";
  });

  await check("旧映射完整匹配（identity + metadata + 文本）才复用", async function () {
    const { world, scan } = IDS.scanWith([["BBBB0002"]]);
    const text = "[2] Li B. Beta Study of Note Cascades. 2021.";
    // 先跑一次，拿到真实 persistent 记录（含 metadata 指纹）
    const first = world.BM.rebuild(scan, [{ text: text, start: 0, end: text.length }], {});
    assert(first.persistent[0], "首轮没有产出可复用记录");
    const again = world.BM.rebuild(scan, [{ text: text, start: 0, end: text.length }], { previous: first.persistent });
    assert(again.entries.length === 1 && again.entries[0].identity === "users:1:BBBB0002", "完整匹配的旧映射没有被复用");
    return "复用成功";
  });

  await check("resolve：唯一命中返回条目，多候选抛 IDENTITY_AMBIGUOUS", async function () {
    const { world, scan } = IDS.scanWith();
    const r = world.BM.rebuild(scan, IDS.AUTHOR_YEAR_ENTRIES, {});
    const hit = world.BM.resolve({ libType: "users", libId: 1, key: "AAAA0001" }, r);
    assert(hit && hit.identity === "users:1:AAAA0001", "唯一身份没有命中");
    assert(world.BM.resolve({ libType: "users", libId: 1, key: "ZZZZ9999" }, r) === null, "不存在的身份应返回 null");
    // r.entries[0] 是 Li（BBBB0002）：把同一条目放两份 → 多候选必须抛歧义
    const dup = { entries: [r.entries[0], r.entries[0]] };
    let err = null;
    try { world.BM.resolve({ libType: "users", libId: 1, key: "BBBB0002" }, dup); } catch (e) { err = e; }
    assert(err && err.code === "IDENTITY_AMBIGUOUS", "多候选没有抛歧义");
    return "唯一/缺失/歧义三态";
  });

  await check("prune：只保留仍然有效的身份，过期映射被清掉", async function () {
    const { world } = IDS.scanWith();
    const mappings = { 0: "users:1:AAAA0001", 1: "users:1:BBBB0002", 2: "users:1:CCCC0003" };
    const kept = world.BM.prune(["users:1:AAAA0001", "users:1:CCCC0003"], mappings);
    assert(Object.keys(kept).length === 2, "prune 没有清掉过期映射：" + JSON.stringify(kept));
    assert(kept[0] === "users:1:AAAA0001" && kept[2] === "users:1:CCCC0003", "prune 保留的键不对");
    return "3 → 2";
  });

  await check("刷新不累积书签：重复重建文献表锚点数量不变", async function () {
    const w = S.createWorld({
      fields: [{ start: 10, code: S.wordItemCode("citeBib001", ["AAAA0001"]), text: "[1]" }],
      bookmarks: [{ Name: "PPBIB_u1_AAAA0001", Start: 1, End: 2 }],
    });
    const bib = w.host.addField(null, w.doc.Range(60, 60), S.wordBiblCode());
    bib.Result.Text = "[1] Alpha Study";
    const entries = [{ item: { key: "AAAA0001", libType: "users", libId: 1 }, start: 0, end: 16 }];
    w.sandbox.PPDoc.replaceBibBookmarks(bib, entries);
    const n1 = w.state.bookmarks.filter(function (b) { return b.Name.indexOf("PPBIB_") === 0; }).length;
    w.sandbox.PPDoc.replaceBibBookmarks(bib, entries);
    const n2 = w.state.bookmarks.filter(function (b) { return b.Name.indexOf("PPBIB_") === 0; }).length;
    assert(n1 === 1 && n2 === 1, "书签累积了：" + n1 + " → " + n2);
    return "1 → 1";
  });

  console.log("");
  console.log("通过 " + passed + " 项，失败 " + failed + " 项" + (failed === 0 ? "，全部通过" : ""));
  process.exit(failed === 0 ? 0 : 1);
})();
