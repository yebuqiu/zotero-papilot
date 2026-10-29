#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 对话全文检索（ChatSearch，0.87.0 批次 2）测试
 *
 * 覆盖：
 *   ① parseQuery：多词 / 去重 / 孤立代理剔除 / 超长截断；
 *   ② findAll：大小写不敏感、偏移正确、命中上限；
 *   ③ mergeSpans：重叠与相邻合并；
 *   ④ makeSnippet：命中词落在片段前 8 字内、代理对不被切断、head/tail 标记；
 *   ⑤ _matchUnit：AND 语义（少一个词就不算命中）、tier（标题优先）、片段角色真实；
 *   ⑥ search：等载入、clientSeq 回传、abort 返回而非 reject、排序与 truncated。
 *
 * 运行：node test/chat-search.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const FILES = [
  'chrome/content/scripts/core/utils.js',
  'chrome/content/scripts/features/chat-search.js',
];

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }

const store = new Map();
const Zotero = {
  locale: 'zh-CN',
  Prefs: {
    get(k) { return store.has(k) ? store.get(k) : undefined; },
    set(k, v) { store.set(k, v); },
  },
  logError() {},
  debug() {},
};
const sandbox = {
  console, Zotero, Services: {}, JSON, Date, Math, String, Number,
  Array, Object, Set, Map, isFinite, parseInt, RegExp, Error, Promise,
  setTimeout, clearTimeout,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const f of FILES) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f });
}
const S = sandbox.ChatSearch;

console.log('== ① parseQuery ==');
eq(S.parseQuery('图 神经  网络').join('|'), '图|神经|网络', '多词 + 折叠空白');
eq(S.parseQuery('GPT gpt GPT').join('|'), 'gpt', '大小写折叠 + 去重');
eq(S.parseQuery('   ').length, 0, '空查询 → 空数组');
eq(S.parseQuery('\uD83D').length, 0, '孤立高代理被剔除');
eq(S.parseQuery('\uDE00').length, 0, '孤立低代理被剔除');
eq(S.parseQuery('\uD83D\uDE00').length, 1, '合法代理对保留');
eq(S.parseQuery('a'.repeat(200))[0].length, S.MAX_TERM_LEN, '超长词截断');
eq(S.parseQuery(Array.from({ length: 20 }, (_, i) => 'w' + i).join(' ')).length, S.MAX_TERMS,
  '词数上限');

console.log('== ② findAll ==');
const spans = S.findAll('Attention is all you need. attention again', 'attention');
eq(spans.length, 2, '大小写不敏感命中两次');
eq(spans[0].start, 0, '首处偏移 0');
eq(spans[1].start, 27, '次处偏移正确');
eq(S.findAll('abc', '').length, 0, '空词 → 无命中');
eq(S.findAll('', 'x').length, 0, '空文 → 无命中');

console.log('== ③ mergeSpans ==');
const merged = S.mergeSpans([{ start: 5, end: 10 }, { start: 8, end: 14 }, { start: 20, end: 22 }]);
eq(merged.length, 2, '重叠合并为 1 段');
eq(merged[0].start, 5, '合并起点取最小');
eq(merged[0].end, 14, '合并终点取最大');
eq(S.mergeSpans([{ start: 3, end: 2 }]).length, 0, '倒序区间被丢弃');

console.log('== ④ makeSnippet ==');
const long = ('前置废话'.repeat(40)) + '关键词在这里' + ('后续内容'.repeat(40));
const sn = S.makeSnippet(long, S.findAll(long, '关键词'));
const at = sn.text.indexOf('关键词');
ok(at >= 0, '片段包含命中词');
ok(at <= 8, '命中词落在片段前 8 字内（否则单行会被省略号裁掉）', at);
ok(sn.spans.length >= 1 && sn.text.slice(sn.spans[0].start, sn.spans[0].end) === '关键词',
  'span 切出来的正是命中词');
ok(sn.head === true, '前部有截断 → head 标记');
const emoji = 'a\uD83D\uDE00b 关键词 c\uD83D\uDE00d';
const se = S.makeSnippet(emoji, S.findAll(emoji, '关键词'));
let lone = false;
for (let i = 0; i < se.text.length; i++) {
  const c = se.text.charCodeAt(i);
  if (c >= 0xD800 && c <= 0xDBFF) {
    const n = se.text.charCodeAt(i + 1);
    if (!(n >= 0xDC00 && n <= 0xDFFF)) lone = true;
  } else if (c >= 0xDC00 && c <= 0xDFFF) {
    const p = se.text.charCodeAt(i - 1);
    if (!(p >= 0xD800 && p <= 0xDBFF)) lone = true;
  }
}
ok(!lone, '片段中没有被切坏的代理对（emoji 完整）');

console.log('== ⑤ _matchUnit ==');
const terms = ['bayes', '校准'];
const u1 = {
  kind: 'doc', key: 'u:AAAA1111', sid: 's1', title: '贝叶斯方法', ts: 1000, lastMsgTs: 1000,
  history: [
    { role: 'user', content: '请解释 bayes 的校准问题' },
    { role: 'assistant', content: '校准指……' },
  ],
};
const m1 = S._matchUnit(u1, terms);
ok(!!m1, '两个词都出现 → 命中');
eq(m1.tier, 1, '仅正文命中 → tier 1');
eq(m1.hits > 0, true, '命中计数 > 0');
eq(m1.snippet.role, 'user', '片段角色是真实的 user，不是硬编码 assistant');
eq(m1.snippet.msgIndex, 0, '片段下标正确');
eq(m1.snippets.length, 1, 'snippets 数组长度 1');
eq(S._matchUnit(u1, ['bayes', '不存在的词']), null, 'AND 语义：缺一个词就不算命中');
// 注意：不能复用 u1.history —— 那会让"校准"也命中，AND 语义就测不出来了
const u2 = { kind: 'doc', key: 'u:BBBB2222', sid: 's2', title: 'Bayes 与先验',
  ts: 2000, lastMsgTs: 2000, history: [{ role: 'assistant', content: '先验分布的选取' }] };
const m2 = S._matchUnit(u2, ['bayes']);
eq(m2.tier, 0, '标题命中 → tier 0');

console.log('== ⑥ search ==');
const UNITS = [u1, u2];
sandbox.ChatMemory = {
  ensureLoaded: () => Promise.resolve(true),
  revision: () => 7,
  allSessions: () => UNITS.slice(),
};
(async () => {
  S.invalidate();
  const r1 = await S.search('bayes 校准', { clientSeq: 3 });
  eq(r1.clientSeq, 3, 'clientSeq 原样回传');
  eq(r1.done, true, '正常完成 done=true');
  eq(r1.items.length, 1, 'AND 过滤后只剩 1 条');
  eq(r1.items[0].sid, 's1', '命中的是正文那条');
  eq(r1.items[0].docKey, 'u:AAAA1111', '结果带 canonical docKey');
  eq(r1.items[0].hitCount, r1.items[0].hits, 'hitCount 与 hits 同值（兼容字段）');
  eq(r1.items[0].stale, false, '本轮不做 stale，恒 false');
  ok(r1.items[0].fingerprint && r1.items[0].fingerprint.lastMsgTs === 1000, 'fingerprint 是值');

  const r2 = await S.search('bayes');
  eq(r2.items.length, 2, '单词命中两条');
  eq(r2.items[0].tier, 0, '标题命中的排第一');
  const r3 = await S.search('bayes');
  eq(r3.rev, 7, '缓存命中仍带 rev');

  const r4 = await S.search('   ');
  eq(r4.empty, true, '空查询 → empty 标记');

  // abort：先发起，再作废，返回值不应 reject
  S.invalidate();
  const p = S.search('bayes');
  S.abort();
  const r5 = await p;
  ok(r5 && (r5.reason === 'aborted' || r5.done === true), 'abort 后返回对象而不是 reject', r5 && r5.reason);

  console.log('');
  if (fails.length) {
    console.error('FAILED ' + fails.length + ' / ' + (pass + fails.length));
    for (const f of fails) console.error('  ✗ ' + f);
    process.exit(1);
  }
  console.log('PASS ' + pass + ' assertions');
})();
