#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 问答记忆双通道（ChatMemory，0.87.0）测试
 *
 * 覆盖：
 *   ① 归档键：libraryID:itemKey 优先，缺 key 回落 id:*，反向解析（itemForDocKey）；
 *   ② 分类（classify）：≥2 篇上下文 → multi；有归属文章 → doc；无 → multi；显式 kind 优先；
 *   ③ doc 通道：save / listDocs / getDoc / latestForItem / sessionsForItem；
 *   ④ 会话粒度：同 sid 原地更新（不是每轮一份快照）、不同 sid 各自成场、最新在前；
 *   ⑤ 上限：单场消息 60 条截断、每文档 20 场、summary 计数；
 *   ⑥ multi 通道：chipsRef 落 key（跨机可解析）+ 顺序；
 *   ⑦ 删除：removeSession（doc/multi）、removeDoc、clearAll；
 *   ⑧ 容错：坏 JSON / 坏条目 / 空历史不落盘；
 *   ⑨ 旧 chatSessions 迁移：同文多份快照合并成一场、多篇 chip 进 multi、幂等；
 *   ⑩ archiveToNote 默认关闭（不写文库）。
 *
 * 运行：node test/chat-memory.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
// utils.js 提供全局 Prefs 包装（本模块经它读写 pref，前缀在包装里加）
const FILES = [
  'chrome/content/scripts/core/utils.js',
  'chrome/content/scripts/features/chat-memory.js',
];

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }

/* ---------------- 桩环境 ---------------- */

const store = new Map();
const PREF = (k) => 'extensions.zotero.papilot.' + k;

function mkItem(id, lib, key, title) {
  return {
    id, libraryID: lib, key,
    isRegularItem: () => true,
    getField: (f) => (f === 'title' ? title : ''),
    getDisplayTitle: () => title,
    getNotes: () => [],
  };
}

const A = mkItem(101, 1, 'AAAA1111', '论文A');
const B = mkItem(202, 1, 'BBBB2222', '论文B');
const C = mkItem(303, 1, 'CCCC3333', '论文C');
const ITEMS = { 101: A, 202: B, 303: C };

const Zotero = {
  locale: 'zh-CN',
  Prefs: {
    get(k) { return store.has(k) ? store.get(k) : undefined; },
    set(k, v) { store.set(k, v); },
  },
  Items: {
    get(id) { return ITEMS[id] || null; },
    getByLibraryAndKey(lib, key) {
      for (const it of Object.values(ITEMS)) if (it.libraryID === lib && it.key === key) return it;
      return null;
    },
  },
  logError() {},
};

// 不给 DataDirectory / IOUtils → 走 pref 全量模式（与真机同一套规范化逻辑）
const sandbox = {
  console, Zotero, Services: {}, JSON, Date, Math, String, Number,
  Array, Object, Set, Map, isFinite, parseInt, RegExp, Error, Promise,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const f of FILES) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f });
}

const M = sandbox.ChatMemory;
const setP = (k, v) => store.set(PREF(k), v);
const getP = (k) => store.get(PREF(k));
const hist = (n, tag) => {
  const out = [];
  for (let i = 0; i < n; i++) out.push({ role: i % 2 ? 'assistant' : 'user', content: (tag || 'q') + i });
  return out;
};

console.log('== ① 归档键 ==');
eq(M.docKeyOf(A), '1:AAAA1111', 'libraryID:itemKey');
eq(M.docKeyOf({ id: 9 }), 'id:9', '缺 key → id:*');
eq(M.docKeyOf(null), '', 'null → 空');
eq(M.itemForDocKey('1:AAAA1111'), A, '反向解析命中');
eq(M.itemForDocKey('1:ZZZZ9999'), null, '解析不到 → null');

console.log('== ② 分类 ==');
eq(M.classify({ item: A, chips: [] }), 'doc', '单篇 + 有文章 → doc');
eq(M.classify({ item: A, chips: [B.id, C.id] }), 'multi', '≥2 篇上下文 → multi');
eq(M.classify({ item: null, chips: [B.id] }), 'doc', '单 chip 且能解析 → doc');
eq(M.classify({ item: null, chips: [] }), 'multi', '无文章无上下文 → multi');
eq(M.classify({ kind: 'multi', item: A }), 'multi', '显式 kind 优先');

console.log('== ③ doc 通道 ==');
M.clearAll();
let saved = M.save({ sid: 's1', item: A, history: hist(4, 'a'), roleId: 'reviewer' });
eq(saved.kind, 'doc', '保存进 doc 通道');
eq(saved.id, 's1', 'sid 沿用');
eq(saved.key, '1:AAAA1111', '归档键正确');
let docs = M.listDocs();
eq(docs.length, 1, 'listDocs 1 篇');
eq(docs[0].title, '论文A', '标题取条目 title');
eq(docs[0].count, 4, '消息计数');
eq(docs[0].sessions.length, 1, '一场对话');
eq(M.getDoc('1:AAAA1111').sessions[0].roleId, 'reviewer', '角色随会话落盘');
eq(M.latestForItem(A).session.id, 's1', 'latestForItem 命中');
eq(M.latestForItem(B), null, '别的条目没有记录');

console.log('== ④ 会话粒度（同 sid 原地更新） ==');
M.save({ sid: 's1', item: A, history: hist(6, 'a'), roleId: 'reviewer' });
docs = M.listDocs();
eq(docs[0].sessions.length, 1, '同 sid 不新增快照');
eq(docs[0].sessions[0].count, 6, '同 sid 消息数更新');
M.save({ sid: 's2', item: A, history: hist(2, 'b') });
docs = M.listDocs();
eq(docs[0].sessions.length, 2, '不同 sid 各自成场');
eq(docs[0].sessions[0].id, 's2', '最新在前');
eq(M.sessionsForItem(A).length, 2, 'sessionsForItem 返回两场');
eq(M.save({ sid: 's3', item: A, history: [] }), null, '空历史不落盘');

console.log('== ⑤ 上限 ==');
M.clearAll();
M.save({ sid: 'long', item: B, history: hist(65, 'x') });
eq(M.getDoc('1:BBBB2222').sessions[0].history.length, 60, '单场截到 60 条');
for (let i = 0; i < 25; i++) {
  M.save({ sid: 'k' + i, item: B, history: hist(2, 'y' + i) });
}
eq(M.getDoc('1:BBBB2222').sessions.length, 20, '每文档最多 20 场');
const st0 = M.stats();
eq(st0.docs, 1, 'stats 文档数');
eq(st0.sessions, 20, 'stats 场次');
eq(st0.multi, 0, 'stats 综合为 0');

console.log('== ⑥ multi 通道 ==');
M.clearAll();
let ms = M.save({ sid: 'm1', item: null, chips: [A.id, B.id, C.id], history: hist(3, 'm') });
eq(ms.kind, 'multi', '进综合通道');
eq(ms.key, '', 'multi 无归档键');
let list = M.listMulti();
eq(list.length, 1, 'listMulti 1 条');
eq(list[0].chipsRef.length, 3, 'chipsRef 记 3 篇');
eq(list[0].chipsRef[0].key, '1:AAAA1111', 'chipsRef 存 key（跨机可解析）');
eq(list[0].chipsRef[0].title, '论文A', 'chipsRef 存标题');
eq(M.listDocs().length, 0, '综合对话不进 doc 通道');
eq(M.latestMulti().id, 'm1', 'latestMulti');
eq(M.getSession('multi', '', 'm1').session.count, 3, 'getSession 取回');
eq(M.getSession('multi', '', 'nope'), null, '不存在的 sid → null');

console.log('== ⑦ 删除 ==');
eq(M.removeSession('multi', '', 'm1'), true, '删综合对话');
eq(M.removeSession('multi', '', 'm1'), false, '重复删 → false');
eq(M.listMulti().length, 0, '综合列表已空');
M.clearAll();
M.save({ sid: 'd1', item: A, history: hist(2) });
M.save({ sid: 'd2', item: A, history: hist(2) });
eq(M.removeSession('doc', '1:AAAA1111', 'd1'), true, '按 sid 删单场');
eq(M.getDoc('1:AAAA1111').sessions.length, 1, '另一场保留（关键：不再误删同文全部快照）');
M.save({ sid: 'd3', item: C, history: hist(2) });
eq(M.removeDoc('1:AAAA1111'), true, '删整篇归档');
eq(M.getDoc('1:AAAA1111'), null, '该篇已消失');
eq(M.listDocs().length, 1, '其他篇仍在');
M.clearAll();
eq(M.listDocs().length + M.listMulti().length, 0, 'clearAll 清空');

console.log('== ⑧ 容错 ==');
setP('chatDocs', 'not-json');
setP('chatMulti', '{"bad":1}');
M._loaded = false;
eq(M.listDocs().length, 0, '坏 chatDocs → 空列表不抛');
eq(M.listMulti().length, 0, 'chatMulti 非数组 → 空列表');
setP('chatDocs', JSON.stringify({ '1:AAAA1111': { sessions: [{ history: [] }, { nope: 1 }] } }));
M._loaded = false;
eq(M.listDocs().length, 0, '坏条目（空 history / 缺字段）被丢弃');
setP('chatDocs', JSON.stringify({
  '1:AAAA1111': { key: '1:AAAA1111', libraryID: 1, itemKey: 'AAAA1111', title: 'T', sessions: [{ id: 'x', history: [{ role: 'user', content: 'hi' }] }] },
  'garbage-key': { sessions: [{ id: 'y', history: [{ role: 'user', content: 'hi' }] }] },
}));
M._loaded = false;
eq(M.listDocs().length, 1, '非法归档键被丢弃、合法条目保留');

console.log('== ⑨ 旧 chatSessions 迁移 ==');
M.clearAll();
store.delete(PREF('chatMemoryMigrated'));
const legacy = [
  { id: 'L1', itemID: 101, title: '旧A-1', ts: Date.now() - 3000, count: 4 },
  { id: 'L2', itemID: 101, title: '旧A-2', ts: Date.now() - 2000, count: 8 },
  { id: 'L3', itemID: 0, title: '旧综合', ts: Date.now() - 1000, count: 4 },
];
sandbox.ChatSessions = {
  list: () => legacy.slice(),
  load: (id) => {
    const base = legacy.find((x) => x.id === id);
    if (!base) return null;
    const h = hist(base.count);
    return Object.assign({}, base, {
      history: h,
      chips: id === 'L3' ? [A.id, B.id] : [],
    });
  },
};
let mr = M.migrateOldSessions();
eq(mr.doc, 1, '同文两份快照 → 合并成 1 场');
eq(mr.multi, 1, '多篇上下文 → 综合 1 条');
eq(getP('chatMemoryMigrated'), true, '迁移标记已写');
eq(M.listDocs().length, 1, 'doc 通道 1 篇');
eq(M.getDoc('1:AAAA1111').sessions[0].count, 8, '取消息最多的那份（8 条）');
eq(M.listMulti().length, 1, '综合通道 1 条');
mr = M.migrateOldSessions();
eq(mr.doc + mr.multi, 0, '二次迁移幂等（标记生效）');

console.log('== ⑪ 公开写入口与落盘不变量 ==');
M.clearAll();
store.delete(PREF('chatDocs'));
M.save({ sid: 'p1', item: A, history: hist(2, 'p') });
const diskDoc = () => {
  const raw = sandbox.Prefs.get('chatDocs', '{}');
  const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return (v && v['1:AAAA1111'] && v['1:AAAA1111'].sessions[0]) || null;
};
let rec0 = diskDoc();
ok(!!rec0, '落盘里能读到该场会话');
ok(typeof rec0.lastMsgTs === 'number', 'lastMsgTs 落盘为 number（不是字符串/缺失）');
ok(rec0.lastMsgTs <= rec0.ts, '不变量 lastMsgTs <= ts');
const beforePin = rec0.lastMsgTs;
eq(M.pinSession('1:AAAA1111', 'p1', true), true, 'pinSession 返回目标状态');
let rec1 = diskDoc();
eq(rec1.lastMsgTs, beforePin, 'pin 不改 lastMsgTs（否则会跳到"最近使用"）');
ok(rec1.ts >= rec0.ts, 'pin bump 了 ts（修改时间）');
eq(!!rec1.pinned, true, 'pinned 落盘');
eq(M.pinSession('1:AAAA1111', 'p1', true), true, '重复 pin 幂等');
eq(M.pinSession('1:AAAA1111', 'p1', false), false, '取消置顶');
eq(diskDoc().pinned, undefined, '取消后字段被删除而不是置 false');

const appendOk = M.appendMessage('1:AAAA1111', 'p1', { role: 'user', content: '追问' });
ok(!!appendOk, 'appendMessage 走通真实写路径');
let rec2 = diskDoc();
ok(rec2.lastMsgTs > beforePin, 'append 后 lastMsgTs 增大');
ok(rec2.lastMsgTs <= rec2.ts, 'append 后仍满足不变量');
M.appendMessage('1:AAAA1111', 'p1', { role: 'assistant', content: '回答' });
let rec3 = diskDoc();
ok(rec3.lastMsgTs > rec2.lastMsgTs, '同毫秒连续追加仍严格递增（单调保护生效）');
eq(rec3.count, 4, '两条消息都写进了同一场');
eq(M.appendMessage('1:AAAA1111', 'nope', { role: 'user', content: 'x' }), null, '会话不存在 → null');
eq(M.appendMessage('1:AAAA1111', 'p1', { role: 'system', content: 'x' }), null, '非 user/assistant 被拒');
eq(M.pinSession('', 'nope', true), null, 'multi 找不到 → null');

console.log('== ⑩ 子笔记归档默认关闭 ==');
M.clearAll();
M.save({ sid: 'n1', item: A, history: hist(2) });
(async () => {
  const rec = M.getDoc('1:AAAA1111').sessions[0];
  const wrote = await M.archiveToNote(A, rec);
  eq(wrote, false, 'chatArchiveNote 默认关 → 不写文库');
  setP('chatArchiveNote', true);
  let created = 0;
  sandbox.Zotero.Item = function (type) { this.type = type; this.libraryID = 0; this.parentID = 0; };
  sandbox.Zotero.Item.prototype.setNote = function (html) { this.html = html; };
  sandbox.Zotero.Item.prototype.saveTx = async function () { created++; };
  const wrote2 = await M.archiveToNote(A, rec);
  eq(wrote2, true, '开启后写入成功');
  eq(created, 1, '新建一条子笔记');

  console.log('');
  if (fails.length) {
    console.error('FAILED ' + fails.length + ' / ' + (pass + fails.length));
    for (const f of fails) console.error('  ✗ ' + f);
    process.exit(1);
  }
  console.log('PASS ' + pass + ' assertions');
})();
