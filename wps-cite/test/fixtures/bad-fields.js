// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* P0-2 六类体检样本。每类单独一份，避免"一条坏域遮住另一类问题"时测试看不出是哪类命中。
 *
 *   1) MISSING_ITEM        引用了当前文献库里不存在的条目
 *   2) DUPLICATE_FIELD_ID  两个物理域 citationID 相同（复制粘贴引文）
 *   3) BAD_FIELD           域代码截断/坏 JSON
 *   4) BIBLIOGRAPHY_STALE  文献表/引文指纹与最近一次成功刷新不同
 *   5) MANUAL_CITATION_EDIT 域结果被手改（与 Zotero formattedCitation 规范化后不同）
 *   6) UNREACHABLE_FIELD   域范围失效（locate 失败）
 */
"use strict";

const S = require("../helpers/wps-stub.js");

const LIBRARY = {
  "AAAA0001": {
    itemType: "journalArticle", title: "Alpha Study", DOI: "10.1000/alpha", pages: "1-20",
    creators: [{ family: "Zhang" }], issued: { "date-parts": [[2020]] },
  },
  "BBBB0002": {
    itemType: "journalArticle", title: "Beta Study", DOI: "10.1000/beta", pages: "21-40",
    creators: [{ family: "Li" }], issued: { "date-parts": [[2021]] },
  },
};

const CODE_A = S.wordItemCode("citeAAAA01", ["AAAA0001"], { formattedCitation: "<sup>[1]</sup>" });
const CODE_B = S.wordItemCode("citeBBBB02", ["BBBB0002"], { formattedCitation: "<sup>[2]</sup>" });

function citation(keys, citationID, formattedCitation) {
  return S.wordItemCode(citationID, keys, { formattedCitation: formattedCitation });
}

function baseOptions() {
  return { path: "C:/tmp/bad-fields.docx" };
}

/** 正常文档：一条引文 + 一个文献表，条目齐全、指纹一致、可定位。零误报。 */
function normal() {
  const opts = baseOptions();
  opts.fields = [{ start: 10, code: CODE_A, text: "[1]" }];
  const w = S.createWorld(opts);
  const bib = w.host.addField(null, w.doc.Range(80, 80), S.wordBiblCode());
  bib.Result.Text = "[1] Alpha Study";
  return { world: w, library: Object.assign({}, LIBRARY), canLocate: () => true, zoteroConnected: true };
}

/** 六类集中在一份文档里，逐项都要命中。 */
function all() {
  const opts = baseOptions();
  opts.fields = [
    { start: 10, code: citation(["MISS0001"], "citeMiss001", "<sup>[1]</sup>"), text: "[1]" },              // MISSING_ITEM
    { start: 20, code: citation(["AAAA0001"], "citeDup0001", "<sup>[2]</sup>"), text: "[2]" },              // DUPLICATE_FIELD_ID
    { start: 30, code: citation(["AAAA0001"], "citeDup0001", "<sup>[2]</sup>"), text: "[2]" },
    { start: 40, code: 'ADDIN ZOTERO_ITEM CSL_CITATION {"citationID":"citeBad001",', text: "[3]" },        // BAD_FIELD
    { start: 50, code: citation(["BBBB0002"], "citeEdit01", "<sup>[4]</sup>"), text: "Smith 2020（手改）" }, // MANUAL_CITATION_EDIT
    { start: 60, code: citation(["BBBB0002"], "citeLost01", "<sup>[5]</sup>"), text: "[5]" },              // UNREACHABLE_FIELD
  ];
  const w = S.createWorld(opts);
  const bib = w.host.addField(null, w.doc.Range(90, 90), S.wordBiblCode());
  bib.Result.Text = "[1] Alpha Study\n[2] Beta Study";
  return {
    world: w,
    library: Object.assign({}, LIBRARY),
    canLocate: (field) => field.citationID !== "citeLost01",
    lastSuccess: { fingerprint: "fingerprint-from-last-success" },
    fingerprint: "fingerprint-now",
    zoteroConnected: true,
  };
}

/** 单类样本：只命中某一种，便于断言"逐项命中"而不是"总有一条命中"。 */
function only(kind) {
  const opts = baseOptions();
  if (kind === "MISSING_ITEM") opts.fields = [{ start: 10, code: citation(["MISS0001"], "citeMiss001", "<sup>[1]</sup>"), text: "[1]" }];
  if (kind === "DUPLICATE_FIELD_ID") {
    opts.fields = [
      { start: 10, code: CODE_A, text: "[1]" },
      { start: 20, code: CODE_A, text: "[1]" },
    ];
  }
  if (kind === "BAD_FIELD") opts.fields = [{ start: 10, code: 'ADDIN ZOTERO_ITEM CSL_CITATION {"citationID":"citeBad001",', text: "[1]" }];
  if (kind === "MANUAL_CITATION_EDIT") opts.fields = [{ start: 10, code: citation(["AAAA0001"], "citeEdit01", "<sup>[1]</sup>"), text: "Zhang 2020" }];
  if (kind === "UNREACHABLE_FIELD") opts.fields = [{ start: 10, code: CODE_A, text: "[1]" }];
  const w = S.createWorld(opts);
  const bib = w.host.addField(null, w.doc.Range(80, 80), S.wordBiblCode());
  bib.Result.Text = "[1] Alpha Study";
  return {
    world: w,
    library: Object.assign({}, LIBRARY),
    canLocate: kind === "UNREACHABLE_FIELD" ? () => false : () => true,
    lastSuccess: kind === "BIBLIOGRAPHY_STALE" ? { fingerprint: "old" } : undefined,
    fingerprint: kind === "BIBLIOGRAPHY_STALE" ? "new" : undefined,
    zoteroConnected: true,
  };
}

module.exports = { LIBRARY, normal, all, only, CODE_A, CODE_B };
