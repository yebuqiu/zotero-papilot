// SPDX-License-Identifier: Apache-2.0
"use strict";
const assert = require("assert");
const Z = require("../addon/js/zfields.js");
global.PPZFields = Z;
global.PPBibliographyMap = require("../addon/js/bibliography-map.js");
const T = require("../addon/js/citation-tools.js");
const H = require("../addon/js/health.js");
let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log("  PASS " + name); }
  catch (e) { failed++; console.log("  FAIL " + name + " -> " + e.message); }
}
function item(key, title) {
  return { id: "http://zotero.org/users/local/local/items/" + key,
    itemData: { itemType: "journalArticle", title: title, author: [{ family: "Author" }], issued: { "date-parts": [[2025]] } } };
}
function code(items) { return 'ADDIN ZOTERO_ITEM CSL_CITATION ' + JSON.stringify({ citationID: "citeTool1", citationItems: items, properties: { formattedCitation: "[1]" } }); }
function field(key, title, start) {
  const parsed = Z.parseField(code([item(key, title)]));
  return { fieldID: "cid:" + parsed.citationID, citationID: parsed.citationID, code: code([item(key, title)]), text: "[1]", start: start, container: "body", items: parsed.items, kind: "item" };
}
const oldIdentity = Z.canonicalIdentity(Z.idToItem(item("AAAA0001", "Old").id));
const candidate = { key: "BBBB0002", libId: 1, libType: "users", data: { title: "New title", itemType: "journalArticle" } };

check("重连只替换目标身份并保留域头、citationID 与其他条目", () => {
  const src = code([item("AAAA0001", "Old"), item("CCCC0003", "Other")]);
  const out = T.reconnect(src, oldIdentity, candidate);
  const parsed = Z.parseField(out.code);
  assert.strictEqual(parsed.citationID, "citeTool1");
  assert.strictEqual(parsed.items[0].key, "BBBB0002");
  assert.strictEqual(parsed.items[1].key, "CCCC0003");
  assert.strictEqual(parsed.items[0].itemData.title, "New title");
  assert(out.code.startsWith("ADDIN ZOTERO_ITEM CSL_CITATION "));
});

check("跨个人库缺少完整 URI 时禁止猜地址", () => {
  assert.throws(() => T.reconnect(code([item("AAAA0001", "Old")]), oldIdentity, { key: "BBBB0002", libId: 999, libType: "users" }), /完整 URI/);
  const uri = "https://zotero.org/users/12345/items/BBBB0002";
  const out = T.reconnect(code([item("AAAA0001", "Old")]), oldIdentity, { key: "BBBB0002", uri: uri });
  assert.strictEqual(Z.parseField(out.code).items[0].libId, 12345);
});

check("Zotero 原始条目转换为 CSL 元数据，避免重连后作者/类型失效", () => {
  const data = T.cslData({ itemType: "journalArticle", title: "T", creators: [{ firstName: "A", lastName: "Zhang" }], date: "2026-03-04" });
  assert.strictEqual(data.type, "article-journal");
  assert.strictEqual(data.author[0].family, "Zhang");
  assert.deepStrictEqual(data.issued["date-parts"][0], [2026, 3, 4]);
});

check("坏 JSON、缺失目标和重复目标都不写入", () => {
  assert.throws(() => T.reconnect("ADDIN ZOTERO_ITEM {bad", oldIdentity, candidate), /完整 JSON|损坏/);
  assert.throws(() => T.reconnect(code([item("CCCC0003", "Other")]), oldIdentity, candidate), /重新扫描/);
  const dup = code([item("AAAA0001", "A"), item("AAAA0001", "A2")]);
  assert.throws(() => T.reconnect(dup, oldIdentity, candidate), /歧义/);
});

check("locator 与 label 可写入、更新和清空", () => {
  const src = code([item("AAAA0001", "Old")]);
  const changed = T.updateLocator(src, oldIdentity, { locator: "42-45", label: "page" });
  let ci = Z.extractJSON(changed.code).citationItems[0];
  assert.strictEqual(ci.locator, "42-45"); assert.strictEqual(ci.label, "page");
  const cleared = T.updateLocator(changed.code, oldIdentity, { locator: "" });
  ci = Z.extractJSON(cleared.code).citationItems[0];
  assert(!("locator" in ci)); assert(!("label" in ci));
});

check("章节按标题 1 和下一个章节边界分组", () => {
  const paragraphs = [{ start: 50, text: "第一章", outlineLevel: 1 }, { start: 400, text: "第二章", outlineLevel: 1 }];
  const groups = T.chapters(paragraphs, [field("AAAA0001", "A", 100), field("BBBB0002", "B", 500)], 900);
  assert.strictEqual(groups.length, 2); assert.strictEqual(groups[0].end, 400); assert.strictEqual(groups[1].end, 900);
  assert.strictEqual(groups[0].entries, undefined);
  assert.throws(() => T.chapters(paragraphs, [{ start: 100, container: "footnote" }], 900), /脚注\/尾注/);
});

check("分章计划从总文献表提取唯一条目并保留编号文本", () => {
  const scan = { fields: [field("AAAA0001", "Alpha", 100), field("BBBB0002", "Beta", 500)],
    bibliography: [{ text: "[1] Alpha. Author. 2025.\n[2] Beta. Author. 2025.", start: 900 }] };
  const paragraphs = [{ start: 50, text: "第一章", outlineLevel: 1 }, { start: 400, text: "第二章", outlineLevel: 1 }];
  const groups = T.plan(scan, paragraphs, { styleID: "http://www.zotero.org/styles/ieee" });
  assert.strictEqual(groups.length, 2); assert.strictEqual(groups[0].entries.length, 1); assert.strictEqual(groups[1].entries.length, 1);
  assert(groups[0].text.includes("[1] Alpha")); assert(groups[1].text.includes("[2] Beta"));
  assert(groups[0].text.includes("静态快照"));
});

check("任一条目无法唯一映射时整批禁止生成", () => {
  const scan = { fields: [field("AAAA0001", "Alpha", 100), field("BBBB0002", "Beta", 500)], bibliography: [{ text: "无法匹配", start: 900 }] };
  const paragraphs = [{ start: 50, text: "第一章", outlineLevel: 1 }, { start: 400, text: "第二章", outlineLevel: 1 }];
  assert.throws(() => T.plan(scan, paragraphs, { styleID: "apa" }), /禁止生成不完整/);
});

check("投稿方案只过滤对应建议，完整性问题保留", () => {
  const report = { kind: "preflight", styleID: "apa", findings: [
    { kind: "MISSING_DOI", severity: "info" }, { kind: "MISSING_PAGE", severity: "info" },
    { kind: "UNCITED_ITEM", severity: "info" }, { kind: "BAD_FIELD", severity: "error" },
  ], suggestions: [{ kind: "MISSING_DOI" }, { kind: "MISSING_PAGE" }], uncited: [{ title: "U" }] };
  const out = H.applyProfile(report, { name: "简洁方案", requireDOI: false, requirePages: false, checkUncited: false, styleID: "nature" });
  assert.deepStrictEqual(out.findings.map(x => x.kind), ["STYLE_MISMATCH", "BAD_FIELD"]);
  assert.strictEqual(out.suggestions.length, 0); assert.strictEqual(out.uncited.length, 0);
  assert.strictEqual(report.findings.length, 4);
});

console.log("\n通过 " + passed + " 项，失败 " + failed + " 项");
process.exit(failed ? 1 : 0);
