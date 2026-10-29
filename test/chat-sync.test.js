#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 会话级合并（ChatSync，0.87.0 批次 3）测试
 *
 * 覆盖：
 *   ① prefixOf：严格前缀 / 等长不算 / 无关；
 *   ② mergeSession 的四级优先级：前缀延展 > ts > 内容哈希（对称裁决）；
 *   ③ 合并后 ts 取 max（否则更晚的删除判不过期）；
 *   ④ pinned 跟胜出侧（取消置顶会 bump ts，所以 ts 大的一侧就是最新意图）；
 *   ⑤ trimHistory 保留首条（丢首条用户就不知道当时问了什么）；
 *   ⑥ mergeDocs：key 并集、itemID 只留本地、title 取较新、墓碑过滤（整篇 / 单场）、裁剪；
 *   ⑦ mergeMulti 与墓碑；
 *   ⑧ normState / mergeStates：坏值丢弃、并集取较晚；
 *   ⑨ serialize 确定性（不定序会让云同步永远传不完）。
 *
 * 运行：node test/chat-sync.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const FILE = 'chrome/content/scripts/features/chat-sync.js';

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }

const Zotero = { logError() {}, debug() {} };
const sandbox = { console, Zotero, JSON, Date, Math, String, Number, Array, Object, Set, Map, isFinite, RegExp, Error };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, FILE), 'utf8'), sandbox, { filename: FILE });
const S = sandbox.ChatSync;

const msg = (role, content) => ({ role, content });
const sess = (id, ts, history, extra) => Object.assign({ id, ts, history }, extra || {});

console.log('== ① prefixOf ==');
const h1 = [msg('user', 'a'), msg('assistant', 'b')];
const h2 = h1.concat([msg('user', 'c')]);
eq(S.prefixOf(h1, h2), 1, 'h1 是 h2 的严格前缀');
eq(S.prefixOf(h2, h1), 2, '反向');
eq(S.prefixOf(h1, h1), 0, '等长不算前缀（否则永远取不到"更长"）');
eq(S.prefixOf([msg('user', 'x')], [msg('assistant', 'y')]), 0, '内容不同 → 无关');
eq(S.prefixOf([], h2), 0, '空数组不构成前缀');

console.log('== ② mergeSession 优先级 ==');
// 关键用例：A 机 pin 过（ts 大但内容短），B 机追加过（ts 小但内容长）→ 必须取 B
const aPin = sess('s1', 100, h1, { pinned: true });
const bAppend = sess('s1', 99, h2);
const m1 = S.mergeSession(aPin, bAppend);
eq(m1.session.history.length, 3, '前缀延展优先：取更长的一侧（无视 ts）');
eq(m1.from, 'remote', 'from 标记为 remote');
eq(m1.session.ts, 100, '合并后 ts 取两侧最大值（不因胜出侧 ts 小而倒退）');

const d1 = sess('s2', 50, [msg('user', 'one')]);
const d2 = sess('s2', 80, [msg('user', 'two')]);
eq(S.mergeSession(d1, d2).session.history[0].content, 'two', '真正分歧 → 取 ts 更大者');
const r1 = S.mergeSession(d1, d2);
const r2 = S.mergeSession(d2, d1);
eq(r1.session.history[0].content, r2.session.history[0].content,
  '对称裁决：调换入参得到同一赢家（否则两端永不收敛）');

console.log('== ③ pinned 与 ts 的联动 ==');
const pinOn = sess('s3', 200, h1, { pinned: true });
const pinOff = sess('s3', 300, h1);
eq(!!S.mergeSession(pinOn, pinOff).session.pinned, false, '取消置顶（ts 更大）生效');
const pinOffEarly = sess('s3', 200, h1);
const pinOnLater = sess('s3', 300, h1, { pinned: true });
eq(!!S.mergeSession(pinOffEarly, pinOnLater).session.pinned, true, '置顶（ts 更大）生效');

console.log('== ④ trimHistory ==');
const long = [];
for (let i = 0; i < 80; i++) long.push(msg(i % 2 ? 'assistant' : 'user', 'm' + i));
const tr = S.trimHistory(long, 60);
eq(tr.length, 60, '裁到 60 条');
eq(tr[0].content, 'm0', '保留首条（用户最初问了什么）');
eq(tr[tr.length - 1].content, 'm79', '保留最后一条');
eq(S.trimHistory([msg('user', 'only')], 60).length, 1, '不足上限原样返回');

console.log('== ⑤ mergeDocs ==');
const localDocs = {
  'u:AAAA1111': { key: 'u:AAAA1111', libraryID: 1, itemKey: 'AAAA1111', itemID: 101, title: 'A 本地',
    updatedAt: 100, sessions: [sess('s1', 100, h1), sess('s2', 90, [msg('user', 'local only')])] },
  'u:CCCC3333': { key: 'u:CCCC3333', libraryID: 1, itemKey: 'CCCC3333', itemID: 303, title: 'C',
    updatedAt: 50, sessions: [sess('c1', 50, [msg('user', 'c')])] },
};
const remoteDocs = {
  'u:AAAA1111': { key: 'u:AAAA1111', libraryID: 7, itemKey: 'AAAA1111', itemID: 999, title: 'A 云端',
    updatedAt: 200, sessions: [sess('s1', 99, h2), sess('s3', 150, [msg('user', 'remote only')])] },
  'u:BBBB2222': { key: 'u:BBBB2222', libraryID: 7, itemKey: 'BBBB2222', itemID: 888, title: 'B',
    updatedAt: 120, sessions: [sess('b1', 120, [msg('user', 'b')])] },
};
const md = S.mergeDocs(localDocs, remoteDocs, null);
eq(Object.keys(md.payload).length, 3, 'key 取并集（A / B / C 都在）');
const A = md.payload['u:AAAA1111'];
eq(A.sessions.length, 3, '会话按 sid 并集（s1 合并、s2 与 s3 各留）');
eq(A.sessions.find((x) => x.id === 's1').history.length, 3, 's1 取更长的一侧');
eq(A.itemID, 101, 'itemID 只保留本机值（远端 999 被丢弃）');
eq(A.libraryID, 1, 'libraryID 用本机值');
eq(A.title, 'A 云端', 'title 取 updatedAt 较大的一侧');
eq(A.updatedAt, 200, 'updatedAt 取 max');
eq(md.payload['u:BBBB2222'].itemID, 0, '本机没有的文档 itemID 归 0（不采纳远端）');

console.log('== ⑥ 墓碑 ==');
const st = S.normState({ tomb: { docs: { 'u:CCCC3333': { doc: 60, sids: {} } } } });
const md2 = S.mergeDocs(localDocs, remoteDocs, st);
eq(md2.payload['u:CCCC3333'], undefined, '整篇墓碑（doc ts >= updatedAt）→ 该篇不出现');
const st2 = S.normState({ tomb: { docs: { 'u:AAAA1111': { doc: 0, sids: { s2: 95 } } } } });
const md3 = S.mergeDocs(localDocs, remoteDocs, st2);
eq(md3.payload['u:AAAA1111'].sessions.some((x) => x.id === 's2'), false,
  '单场墓碑（ts >= 会话 ts）→ 该场被删');
eq(md3.payload['u:AAAA1111'].sessions.some((x) => x.id === 's3'), true, '未被墓碑覆盖的场次保留');
const st3 = S.normState({ tomb: { docs: { 'u:AAAA1111': { doc: 0, sids: { s2: 10 } } } } });
eq(S.mergeDocs(localDocs, remoteDocs, st3).payload['u:AAAA1111'].sessions.some((x) => x.id === 's2'), true,
  '墓碑早于会话最后修改 → 说明删后又重建，保留');

console.log('== ⑦ mergeMulti ==');
const lm = [sess('m1', 10, h1), sess('m2', 20, [msg('user', 'local')])];
const rm = [sess('m1', 12, h2), sess('m3', 30, [msg('user', 'remote')])];
const mm = S.mergeMulti(lm, rm, null);
eq(mm.payload.length, 3, 'multi 按 id 并集');
eq(mm.payload.find((x) => x.id === 'm1').history.length, 3, '同 id 走同一套合并规则');
const stM = S.normState({ tomb: { multi: { m2: 20 } } });
eq(S.mergeMulti(lm, rm, stM).payload.some((x) => x.id === 'm2'), false, 'multi 墓碑生效');

console.log('== ⑧ 状态规范化与并集 ==');
eq(S.normState(null).tomb.docs && Object.keys(S.normState(null).tomb.docs).length, 0, 'null → 空墓碑');
eq(Object.keys(S.normState({ tomb: { docs: { bad: { sids: { x: 'nope' } } } } }).tomb.docs).length, 0,
  '坏墓碑（无有效时间）被丢弃');
const stA = S.normState({ tomb: { docs: { 'u:A': { doc: 5, sids: { s1: 30 } } }, multi: { m1: 10 } } });
const stB = S.normState({ tomb: { docs: { 'u:A': { doc: 9, sids: { s1: 20, s2: 40 } } }, multi: { m1: 7 } } });
const stC = S.mergeStates(stA, stB);
eq(stC.tomb.docs['u:A'].doc, 9, 'doc 墓碑取较晚');
eq(stC.tomb.docs['u:A'].sids.s1, 30, '同 sid 取较晚');
eq(stC.tomb.docs['u:A'].sids.s2, 40, '并集保留对方独有的 sid');
eq(stC.tomb.multi.m1, 10, 'multi 墓碑取较晚');

console.log('== ⑨ 确定性序列化与幂等 ==');
const s1 = S.serialize({ b: 1, a: 2 });
const s2 = S.serialize({ a: 2, b: 1 });
eq(s1, s2, '键序不同 → 字节相同（否则永远传不完）');
const once = S.mergeDocs(localDocs, remoteDocs, null).payload;
const twice = S.mergeDocs(once, remoteDocs, null).payload;
eq(S.serialize(once), S.serialize(twice), '合并幂等：再合一次结果不变');
eq(S.merge('.', {}, {}).stats.docs, 0, '空输入安全');

console.log('');
if (fails.length) {
  console.error('FAILED ' + fails.length + ' / ' + (pass + fails.length));
  for (const f of fails) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log('PASS ' + pass + ' assertions');
