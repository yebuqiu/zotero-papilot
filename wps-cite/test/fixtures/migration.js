// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* P2-3 迁移兼容样本：Word 官方域 / 旧版文档数据 / 注文 / 截断域 / LibreOffice 参考域 / 未知能力。
 *
 * 期望一律按 PRD 的口径：
 *   - 只有"域方言标准 + 文档数据完整 + 目标能力已验证"才是 direct；
 *   - 任何无法证明的部分 → reconnect / unverified，绝不 direct；
 *   - 截断域与缺失文档数据 → plainText（任何编辑器都无法可靠重连）。
 */
"use strict";

const S = require("../helpers/wps-stub.js");

const VALID_DOC_DATA = '{"dataVersion":3,"style":{"styleID":"http://www.zotero.org/styles/apa"},"prefs":{"noteType":0}}';
const LEGACY_DOC_DATA = '{"dataVersion":2,"prefs":{"noteType":0}}';        // 有数据但缺样式信息

function world(fields, docData, notes) {
  const cfg = { path: "C:/tmp/migration.docx", fields: fields };
  if (docData !== undefined) cfg.docData = docData;
  if (notes) cfg.notes = notes;
  const w = S.createWorld(cfg);
  return { world: w, scan: w.S.scan(w.doc), docData: docData };
}

const WORD_FIELD = { start: 10, code: S.wordItemCode("citeWord01", ["AAAA0001"]), text: "[1]" };
const WORD_NOTE = { refStart: 50, fields: [{ code: S.wordItemCode("citeFoot01", ["BBBB0002"]), text: "1" }] };
const TRUNCATED_FIELD = { start: 10, code: 'ADDIN ZOTERO_ITEM CSL_CITATION {"citationID":"citeTrunc1",', text: "[1]" };
// LibreOffice 侧 Zotero 的域方言（Zotero 内部就是这一种）
const LO_FIELD = { start: 10, code: 'ITEM CSL_CITATION {"citationID":"citeLo0001","citationItems":[{"id":"' + S.LIB + '/items/AAAA0001"}]}', text: "[1]" };

const CAPS_FULL = { bodyFields: true, footnotes: true, endnotes: true, footnoteAdd: true, endnoteAdd: true, bookmarks: true, noteConvert: true };
const CAPS_NO_NOTES = { bodyFields: true, footnotes: false, endnotes: false, footnoteAdd: false, endnoteAdd: false, bookmarks: true, noteConvert: false };

function cases() {
  return [
    {
      name: "Word 官方域 + 完整文档数据 → Word 可直接迁移",
      target: "word", make: () => world([WORD_FIELD], VALID_DOC_DATA), context: {}, expect: "direct",
    },
    {
      name: "Word 官方域 + 完整文档数据 + 目标 WPS 能力齐全 → 可直接迁移",
      target: "wps", make: () => world([WORD_FIELD], VALID_DOC_DATA), context: {}, caps: CAPS_FULL, expect: "direct",
    },
    {
      name: "未探测目标 WPS 能力 → 未验证（不许猜 direct）",
      target: "wps", make: () => world([WORD_FIELD], VALID_DOC_DATA), context: {}, caps: null, expect: "unverified",
    },
    {
      name: "旧版文档数据 → 迁移后需重连",
      target: "word", make: () => world([WORD_FIELD], LEGACY_DOC_DATA), context: {}, expect: "reconnect",
    },
    {
      name: "缺文档数据 → 只能给纯文本副本",
      target: "word", make: () => world([WORD_FIELD], ""), context: {}, expect: "plainText",
    },
    {
      name: "文档数据损坏（非 JSON）→ 只能给纯文本副本",
      target: "word", make: () => world([WORD_FIELD], "{not json"), context: {}, expect: "plainText",
    },
    {
      name: "截断域 → 任何编辑器都无法可靠重连，给纯文本副本",
      target: "word", make: () => world([TRUNCATED_FIELD], VALID_DOC_DATA), context: {}, expect: "plainText",
    },
    {
      name: "注文引文 + 目标 WPS 缺注集合 → 需重连验证",
      target: "wps", make: () => world([WORD_FIELD], VALID_DOC_DATA, { footnote: [WORD_NOTE] }), context: {}, caps: CAPS_NO_NOTES, expect: "reconnect",
    },
    {
      name: "LibreOffice 参考域（ITEM CSL_CITATION）→ 需 Zotero 重连，不是 direct",
      target: "word", make: () => world([LO_FIELD], VALID_DOC_DATA), context: {}, expect: "reconnect",
    },
    {
      name: "LibreOffice 参考域 + 目标 WPS 能力齐全 → 仍需重连（内部方言不能冒充 Word 域）",
      target: "wps", make: () => world([LO_FIELD], VALID_DOC_DATA), context: {}, caps: CAPS_FULL, expect: "reconnect",
    },
    {
      name: "未指定目标编辑器 → 未验证",
      target: "notepad", make: () => world([WORD_FIELD], VALID_DOC_DATA), context: {}, expect: "unverified",
    },
    {
      name: "没有 Zotero 域 → 无需迁移域，direct",
      target: "word", make: () => world([], VALID_DOC_DATA), context: {}, expect: "direct",
    },
  ];
}

module.exports = { cases, VALID_DOC_DATA, LEGACY_DOC_DATA, CAPS_FULL, CAPS_NO_NOTES, LO_FIELD, WORD_FIELD, TRUNCATED_FIELD };
