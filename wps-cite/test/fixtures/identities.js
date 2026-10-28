// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* P0-3 文献表身份样本：数字制/作者年制的重排、增删，以及"绝不猜"的三类歧义。 */
"use strict";

const S = require("../helpers/wps-stub.js");

const LIB = S.LIB;

const ITEMS = {
  AAAA0001: {
    itemType: "journalArticle", title: "Alpha Study of Citation Reliability",
    DOI: "10.1000/alpha", pages: "1-20", creators: [{ family: "Zhang" }], issued: { "date-parts": [[2020]] },
  },
  BBBB0002: {
    itemType: "journalArticle", title: "Beta Study of Note Cascades",
    DOI: "10.1000/beta", pages: "21-40", creators: [{ family: "Li" }], issued: { "date-parts": [[2021]] },
  },
  CCCC0003: {
    itemType: "book", title: "Gamma Handbook", creators: [{ family: "Wang" }], issued: { "date-parts": [[2019]] },
  },
};

/** 造一份"正文引用 A、B 两条"的文档，返回扫描快照。
 * 域里带 itemData（Zotero 落盘时对引用条目会带上一份元数据快照），
 * 这是"按唯一完整元数据映射文献表"这条路径的真实输入。 */
function scanWith(citationIDs) {
  const ids = citationIDs || [["AAAA0001"], ["BBBB0002"]];
  const fields = ids.map(function (keys, i) {
    return { start: 10 + i * 10, code: S.wordItemCode("cite" + String(i).padStart(4, "0") + "AA", keys, { itemData: ITEMS }), text: "[" + (i + 1) + "]" };
  });
  const w = S.createWorld({ path: "C:/tmp/identities.docx", fields: fields });
  return { world: w, scan: w.S.scan(w.doc) };
}

/** 作者—年制：条目顺序与正文引用顺序不同，必须按唯一元数据 / 条目级 ID 命中。 */
const AUTHOR_YEAR_ENTRIES = [
  { text: "Li, B. (2021). Beta Study of Note Cascades. Journal of Tests.", start: 0, end: 68 },
  { text: "Zhang, A. (2020). Alpha Study of Citation Reliability. Journal of Tests.", start: 69, end: 143 },
];

/** 数字制：按首次引用顺序编号，条目顺序稳定但正文增删后会重排。 */
const NUMERIC_ENTRIES = [
  { text: "[1] Zhang A. Alpha Study of Citation Reliability. 2020.", start: 0, end: 60 },
  { text: "[2] Li B. Beta Study of Note Cascades. 2021.", start: 61, end: 105 },
];

/** 带条目级 URI 的 citeproc 输出（最可靠的身份来源）。 */
const DIRECT_ENTRIES = [
  { id: LIB + "/items/BBBB0002", text: "[1] Li B. Beta Study of Note Cascades. 2021.", start: 0, end: 50 },
  { id: LIB + "/items/AAAA0001", text: "[2] Zhang A. Alpha Study of Citation Reliability. 2020.", start: 51, end: 110 },
];

/** 同题同作者：两条不同身份，元数据完全一样 → 不得建立猜测链接。 */
const SAME_TITLE_ENTRIES = [
  { text: "Zhang, A. (2020). Alpha Study of Citation Reliability. Journal A.", start: 0, end: 70 },
];

/** 无标题条目：只有作者与年份 → 不得猜测。 */
const NO_TITLE_ENTRIES = [{ text: "Zhang, A. (2020). [untitled manuscript].", start: 0, end: 45 }];

module.exports = { ITEMS, LIB, scanWith, AUTHOR_YEAR_ENTRIES, NUMERIC_ENTRIES, DIRECT_ENTRIES, SAME_TITLE_ENTRIES, NO_TITLE_ENTRIES };
