#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 记忆隐私分级（ChatPrivacy，0.87.0 批次 2）测试
 *
 * 覆盖：
 *   ① subject 构造：doc 带 docKey/lib，multi 结构上无 docKey/lib；
 *   ② 判定顺序 sids → items → libs（越具体越优先），以及 multi 只看 sid；
 *   ③ 排除键规范化：非法 key / 非法库 token 一律拒绝；
 *   ④ 脱敏：邮箱 / 手机号 / 本机路径被替换，DOI / 年份 / 公式保留；
 *   ⑤ 上传投影：整篇排除 → 骨架（无 title、无 sessions、excluded 标记）；
 *      单场排除 → 只少那一场；脱敏开启 → 正文被替换但输入不被修改；
 *   ⑥ privacyRevision 随写入递增（云同步指纹依赖它）。
 *
 * 运行：node test/chat-privacy.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const FILES = [
  'chrome/content/scripts/core/utils.js',
  'chrome/content/scripts/features/chat-privacy.js',
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
  // 不给 DataDirectory / IOUtils → 走 pref 后备（与真机同一套规范化逻辑）
};
const sandbox = {
  console, Zotero, Services: {}, JSON, Date, Math, String, Number,
  Array, Object, Set, Map, isFinite, parseInt, RegExp, Error, Promise,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const f of FILES) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f });
}
const P = sandbox.ChatPrivacy;

console.log('== ① subject 构造 ==');
const docSub = P.makeExclusionSubject('doc', 'u:AAAA1111', 'u', 's1');
eq(docSub.kind, 'doc', 'doc 主体 kind');
eq(docSub.docKey, 'u:AAAA1111', 'doc 主体带 docKey');
eq(docSub.lib, 'u', 'doc 主体带 lib');
eq(docSub.sid, 's1', 'doc 主体带 sid');
const multiSub = P.makeExclusionSubject('multi', 'u:AAAA1111', 'u', 'm1');
eq(multiSub.docKey, null, 'multi 结构上没有 docKey（不是靠判空）');
eq(multiSub.lib, null, 'multi 结构上没有 lib');
eq(multiSub.sid, 'm1', 'multi 仍带 sid');
eq(P.subjectForDocKey('g123:BBBB2222').lib, 'g123', 'subjectForDocKey 从键前缀取库身份');
eq(P.subjectForDocKey(null).docKey, null, 'null 键安全');

console.log('== ② 判定顺序与命中级别 ==');
const excl = {
  libs: ['u'],
  items: ['u:AAAA1111'],
  sids: { s9: true },
  redact: false,
};
eq(P.exclusionSource(P.makeExclusionSubject('doc', 'u:AAAA1111', 'u', null), excl), 'item',
  'item 优先于 lib');
eq(P.exclusionSource(P.makeExclusionSubject('doc', 'u:AAAA1111', 'u', 's9'), excl), 'sid',
  'sid 最优先');
eq(P.exclusionSource(P.makeExclusionSubject('doc', 'u:CCCC3333', 'u', null), excl), 'lib',
  '只命中库 → lib');
eq(P.exclusionSource(P.makeExclusionSubject('doc', 'u:CCCC3333', 'u', 's9'), excl), 'sid',
  '单场排除优先于库排除（整库排除下仍可单点标记）');
eq(P.exclusionSource(P.makeExclusionSubject('multi', null, null, 's9'), excl), 'sid',
  'multi 只按 sid 判定');
eq(P.exclusionSource(P.makeExclusionSubject('multi', null, null, 'zzz'), excl), null,
  'multi 不受 items/libs 影响');
eq(P.isExcluded(P.makeExclusionSubject('doc', 'u:DDDD4444', 'u', null), excl), true, 'isExcluded 布尔');
eq(P.isExcluded(P.makeExclusionSubject('doc', 'u:DDDD4444', 'g7', null), excl), false, '换库不命中');
eq(P.isExcluded(P.makeExclusionSubject('multi', null, null, null), excl), false, '无 sid 的 multi 安全');

console.log('== ③ 写入校验 ==');
eq(P.setItemExcluded('not-a-key', true), false, '非法归档键被拒');
eq(P.setItemExcluded('g12:ABCD1234', true), true, 'group 键可写');
eq(P.isExcluded(P.makeExclusionSubject('doc', 'g12:ABCD1234', 'g12', null)), true, '写入后即生效');
eq(P.setLibExcluded('123', true), false, '非法库 token 被拒');
eq(P.setLibExcluded('g99', true), true, 'group 库 token 可写');
eq(P.setSessionExcluded('', true), false, '空 sid 被拒');
eq(P.setSessionExcluded('sid-x', true), true, 'sid 可写');
const rev1 = P.privacyRevision();
P.setItemExcluded('g12:ABCD1234', false);
ok(P.privacyRevision() > rev1, '每次写入 revision 递增（指纹依赖）', { before: rev1, after: P.privacyRevision() });
eq(P.setRedact(true), true, '脱敏开关可写');

console.log('== ④ 脱敏 ==');
const DOI = 'See 10.1038/s41586-020-2649-2 (2020) for details.';
eq(P.redactText(DOI), DOI, 'DOI / 年份原样保留');
ok(P.redactText('联系 zhang.san@example.edu 询问').indexOf('<邮箱>') >= 0, '邮箱被替换');
ok(P.redactText('联系 zhang.san@example.edu 询问').indexOf('@') < 0, '邮箱不再残留');
ok(P.redactText('电话 13800138000').indexOf('<手机>') >= 0, '手机号被替换');
ok(P.redactText('路径 C:\\Users\\bob\\data\\raw.csv').indexOf('<本机路径>') >= 0, 'Windows 路径被替换');
eq(P.redactText('路径 C:\\Users\\bob\\data\\raw.csv').indexOf('bob'), -1, '路径里的用户名不残留');
ok(P.redactText('文件 /home/bob/notes.md 里').indexOf('<本机路径>') >= 0, 'Unix 家目录被替换');
eq(P.redactText(''), '', '空串安全');
eq(P.redactText(null), '', 'null 安全');

console.log('== ⑤ 上传投影 ==');
const docsPayload = {
  'u:AAAA1111': {
    key: 'u:AAAA1111', libraryID: 1, itemKey: 'AAAA1111', itemID: 101,
    title: '敏感情报标题', updatedAt: 100,
    sessions: [
      { id: 's1', ts: 100, history: [{ role: 'user', content: '邮箱 a@b.com 的问题' },
        { role: 'assistant', content: '回答' }] },
      { id: 's2', ts: 200, history: [{ role: 'user', content: '第二场' }] },
    ],
  },
  'u:BBBB2222': {
    key: 'u:BBBB2222', libraryID: 1, itemKey: 'BBBB2222', itemID: 202,
    title: '普通标题', updatedAt: 300,
    sessions: [{ id: 's3', ts: 300, history: [{ role: 'user', content: '正常问题' }] }],
  },
};
const pExcl = { libs: [], items: ['u:AAAA1111'], sids: { s3: true }, redact: true };
const proj = P.projectForUpload('chatDocs', docsPayload, pExcl);
eq(proj.dropped.docs, 1, '整篇排除计数 1');
const skeleton = proj.payload['u:AAAA1111'];
eq(skeleton.sessions.length, 0, '骨架不带任何会话');
eq(skeleton.title, '', '骨架连标题都去掉（标题也可能敏感）');
eq(skeleton.excluded, true, '骨架带 excluded 标记（云端知道"这篇存在但不同步"）');
eq(skeleton.key, 'u:AAAA1111', '骨架保留 key');
const normal = proj.payload['u:BBBB2222'];
eq(normal.sessions.length, 0, '单场排除 → 该篇只剩 0 场');
eq(proj.dropped.sessions, 1, '单场排除计数 1');
ok(proj.payload !== docsPayload, '返回新对象，不修改入参');
eq(docsPayload['u:AAAA1111'].sessions.length, 2, '入参未被改动（本地原文不动）');

const proj2 = P.projectForUpload('chatDocs', docsPayload, { libs: [], items: [], sids: {}, redact: true });
ok(proj2.redacted >= 1, '脱敏计数 > 0', proj2.redacted);
const kept = proj2.payload['u:AAAA1111'].sessions[0].history[0].content;
ok(kept.indexOf('<邮箱>') >= 0, '上传副本已脱敏');
eq(docsPayload['u:AAAA1111'].sessions[0].history[0].content.indexOf('<邮箱>'), -1,
  '本地原文未脱敏（脱敏只作用于投影）');

const multiPayload = [
  { id: 'm1', ts: 1, chipsRef: [{ key: 'u:AAAA1111' }, { key: 'u:BBBB2222' }], history: [] },
  { id: 'm2', ts: 2, chipsRef: [{ key: 'u:AAAA1111' }], history: [] },
];
const pm = P.projectForUpload('chatMulti', multiPayload, { libs: [], items: ['u:AAAA1111'], sids: {}, redact: false });
eq(pm.payload.length, 1, '来源文章全被排除的多篇对话不上云');
eq(pm.payload[0].id, 'm1', '仍有一篇允许 → 保留');
const pm2 = P.projectForUpload('chatMulti', multiPayload, { libs: [], items: [], sids: { m1: true }, redact: false });
eq(pm2.payload.length, 1, '按 sid 排除多篇对话');
eq(pm2.payload[0].id, 'm2', '被排除的是 m1');

console.log('');
if (fails.length) {
  console.error('FAILED ' + fails.length + ' / ' + (pass + fails.length));
  for (const f of fails) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log('PASS ' + pass + ' assertions');
