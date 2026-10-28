// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* P0-1 混合注文样本：正文 1 条 + 2 个脚注 + 2 个尾注。
 *
 * 文档顺序不是"先枚举正文、再枚举脚注、再枚举尾注"，而是按注在**正文里的引用锚点**
 * （note.Reference.Start）与正文域位置合并排序：
 *   正文 10 → 脚注1 50 → 尾注1 120 → 脚注2 150 → 尾注2 200
 * 这正是 Zotero 需要的顺序（refresh 时按它重建 citation），也是旧实现最容易错的地方
 * （旧实现只扫 document.Fields，注文里的域完全不可见）。
 */
"use strict";

const S = require("../helpers/wps-stub.js");

const NOTE_INDEX = { fn1: 1, fn2: 2, en1: 1, en2: 2 };

const EXPECTED_ORDER = [
  { citationID: "bodyCite01", container: "body", noteIndex: 0 },
  { citationID: "footCite01", container: "footnote", noteIndex: 1 },
  { citationID: "endCite001", container: "endnote", noteIndex: 1 },
  { citationID: "footCite02", container: "footnote", noteIndex: 2 },
  { citationID: "endCite002", container: "endnote", noteIndex: 2 },
];

function options() {
  return {
    path: "C:/tmp/mixed-notes.docx",
    contentText: "正文[1]引言……注1……注2……尾1……尾2",
    fields: [{ start: 10, code: S.wordItemCode("bodyCite01", ["BODY0001"]), text: "[1]" }],
    notes: {
      footnote: [
        { refStart: 50, fields: [{ code: S.wordItemCode("footCite01", ["FOOT0001"]), text: "1" }] },
        { refStart: 150, fields: [{ code: S.wordItemCode("footCite02", ["FOOT0002"]), text: "2" }] },
      ],
      endnote: [
        { refStart: 120, fields: [{ code: S.wordItemCode("endCite001", ["ENDN0001"]), text: "i" }] },
        { refStart: 200, fields: [{ code: S.wordItemCode("endCite002", ["ENDN0002"]), text: "ii" }] },
      ],
    },
    docData: '{"style":{"styleID":"http://www.zotero.org/styles/chicago-fullnote-bibliography"}}',
  };
}

function build() {
  return S.createWorld(options());
}

module.exports = { options, build, EXPECTED_ORDER, NOTE_INDEX };
