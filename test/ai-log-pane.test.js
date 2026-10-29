#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 左侧栏【AI 对话记录】栏目（AILogPane，0.87.0）真渲染测试
 *
 * 用迷你 DOM 跑真实的 _build / _renderList / _openViewer 代码路径，覆盖：
 *   ① 空态：没有记录时给的是「怎么产生记录」的说明，不是空白；
 *   ② 分组：按文章归档 + 综合对话两组，行数与文案；
 *   ③ 展开：点文章行展开该文的会话，再点会话行打开查看器（含 Q/A 气泡）；
 *   ④ 搜索：按标题过滤，docs 与 multi 同时收窄；
 *   ⑤ 折叠：写 pref aiLogPaneCollapsed，正文 display 切换；
 *   ⑥ 复制 Markdown：内容含「问：/答：」且不含 system 消息；
 *   ⑦ 容错：ChatMemory 缺位时显示「记忆模块不可用」而不是抛错。
 *
 * 运行：node test/ai-log-pane.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const XHTML = 'http://www.w3.org/1999/xhtml';

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }

/* ---------------- 迷你 DOM ---------------- */

function El(tag) {
  this.tagName = tag;
  this.children = [];
  this.attrs = {};
  this._text = '';
  this.style = {};
  this.parentNode = null;
  this._handlers = {};
  this.ownerDocument = null;
}
El.prototype.setAttribute = function (k, v) {
  this.attrs[k] = String(v);
  if (k === 'class') this.className = String(v);
};
El.prototype.getAttribute = function (k) { return this.attrs[k] === undefined ? null : this.attrs[k]; };
El.prototype.appendChild = function (c) { c.parentNode = this; c.ownerDocument = this.ownerDocument; this.children.push(c); return c; };
El.prototype.removeChild = function (c) {
  const i = this.children.indexOf(c);
  if (i >= 0) this.children.splice(i, 1);
  c.parentNode = null;
  return c;
};
El.prototype.remove = function () { if (this.parentNode) this.parentNode.removeChild(this); };
El.prototype.addEventListener = function (type, fn) { (this._handlers[type] = this._handlers[type] || []).push(fn); };
El.prototype.removeEventListener = function (type, fn) {
  const a = this._handlers[type] || [];
  const i = a.indexOf(fn);
  if (i >= 0) a.splice(i, 1);
};
El.prototype.click = function () {
  for (const fn of (this._handlers.click || []).slice()) fn({ target: this, stopPropagation() {} });
};
Object.defineProperty(El.prototype, 'firstChild', {
  get() { return this.children[0] || null; },
});
Object.defineProperty(El.prototype, 'textContent', {
  get() { return this._text + this.children.map((c) => c.textContent).join(''); },
  set(v) { this._text = String(v == null ? '' : v); this.children = []; },
});
Object.defineProperty(El.prototype, 'className', {
  get() { return this.attrs.class || ''; },
  set(v) { this.attrs.class = String(v); },
});
// MdLite 渲染走 innerHTML：桩只剥标签留文本，够验证「内容进没进气泡」
Object.defineProperty(El.prototype, 'innerHTML', {
  get() { return this._text; },
  set(v) { this._text = String(v == null ? '' : v).replace(/<[^>]*>/g, ''); this.children = []; },
});

function walk(node, out) {
  out.push(node);
  for (const c of node.children) walk(c, out);
  return out;
}

/* ---------------- 桩环境 ---------------- */

const store = new Map();
const PREF = (k) => 'extensions.zotero.papilot.' + k;

const pane = new El('vbox');
const doc = {
  documentElement: new El('html'),
  createElementNS: (ns, tag) => {
    const e = new El(tag);
    e.ownerDocument = doc;
    return e;
  },
  getElementById: (id) => {
    if (id === 'zotero-collections-pane') return pane;
    // 栏目挂在 pane 上（不在 documentElement 子树里），两处都要查
    for (const n of walk(pane, []).concat(walk(doc.documentElement, []))) {
      if (n.attrs && n.attrs.id === id) return n;
    }
    return null;
  },
  addEventListener() {},
  removeEventListener() {},
};
doc.documentElement.ownerDocument = doc;
pane.ownerDocument = doc;

const win = {
  document: doc,
  MutationObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
  setTimeout: (fn) => { return 0; },
};

const Zotero = {
  locale: 'zh-CN',
  Prefs: {
    // 注意：Zotero.Prefs.get(k, true) 的第二参是 global 开关，不是默认值；
    // Prefs 包装（utils.js）自己兜 fallback。桩必须返回 undefined 表示「未设置」。
    get(k) { return store.has(k) ? store.get(k) : undefined; },
    set(k, v) { store.set(k, v); },
  },
  getMainWindow: () => win,
  logError() {},
  Utilities: { Internal: { copyTextToClipboard: (t) => { Zotero._clip = t; } } },
};

const sandbox = {
  console, Zotero, Services: {}, JSON, Date, Math, String, Number,
  Array, Object, Set, Map, isFinite, parseInt, RegExp, Error, Promise,
  setTimeout, clearTimeout,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const f of ['chrome/content/scripts/core/utils.js',
  'chrome/content/scripts/panels/ai-log-pane.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f });
}

const P = sandbox.AILogPane;
sandbox.MdLite = { toHtml: (t) => '<p>' + String(t).replace(/[<>]/g, '') + '</p>' };

/* ChatMemory 桩：两份 doc（A 两场、B 一场）+ 一条综合 */
const MEM = {
  listDocs: () => [
    { key: '1:AAAA1111', title: '论文A', itemID: 101, libraryID: 1, itemKey: 'AAAA1111', updatedAt: Date.now() - 60000, count: 6,
      sessions: [{ id: 's2', ts: Date.now() - 60000, count: 4, title: '第二个问题' }, { id: 's1', ts: Date.now() - 120000, count: 2, title: '第一个问题' }] },
    { key: '1:BBBB2222', title: '论文B', itemID: 202, libraryID: 1, itemKey: 'BBBB2222', updatedAt: Date.now() - 3600000, count: 2,
      sessions: [{ id: 't1', ts: Date.now() - 3600000, count: 2, title: 'B 的问题' }] },
  ],
  listMulti: () => [
    { id: 'm1', ts: Date.now() - 30000, count: 4, title: '三篇综述对比', chipsRef: [{ key: '1:AAAA1111', title: '论文A' }, { key: '1:BBBB2222', title: '论文B' }] },
  ],
  stats: () => ({ docs: 2, sessions: 3, multi: 1 }),
  getSession: (kind, key, sid) => {
    if (kind === 'multi' && sid === 'm1') {
      return { doc: null, session: { id: 'm1', ts: Date.now(), count: 2, title: '三篇综述对比', roleId: 'librarian',
        history: [{ role: 'user', content: '对比这三篇' }, { role: 'assistant', content: '共同点是…' }] } };
    }
    if (kind === 'doc' && key === '1:AAAA1111' && sid === 's2') {
      return { doc: { key, title: '论文A' }, session: { id: 's2', ts: Date.now(), count: 2, title: '第二个问题',
        history: [{ role: 'system', content: 'SYS-SHOULD-NOT-APPEAR' }, { role: 'user', content: '它的局限是什么' }, { role: 'assistant', content: '样本量偏小' }] } };
    }
    return null;
  },
  removeSession: () => true,
  itemForDocKey: () => null,
  onChange: () => () => {},
  migrateOldSessions: () => ({}),
};
sandbox.ChatMemory = MEM;

console.log('== ① 空态 ==');
MEM.listDocs = () => [];
MEM.listMulti = () => [];
P.register('test-plugin');
ok(!!doc.getElementById(P.ROOT_ID), '栏目已挂到左侧栏');
P._renderList();
let text = doc.getElementById(P.ROOT_ID).textContent;
ok(text.indexOf('AI 对话记录') >= 0, '标题在');
ok(text.indexOf('还没有对话记录') >= 0, '空态给出说明文案');
ok(text.indexOf('单篇归档到对应文章下') >= 0, '空态说清两类记忆的去向');

console.log('== ② 分组渲染 ==');
MEM.listDocs = () => [
  { key: '1:AAAA1111', title: '论文A', itemID: 101, libraryID: 1, itemKey: 'AAAA1111', updatedAt: Date.now() - 60000, count: 6,
    sessions: [{ id: 's2', ts: Date.now() - 60000, count: 4, title: '第二个问题' }, { id: 's1', ts: Date.now() - 120000, count: 2, title: '第一个问题' }] },
  { key: '1:BBBB2222', title: '论文B', itemID: 202, libraryID: 1, itemKey: 'BBBB2222', updatedAt: Date.now() - 3600000, count: 2,
    sessions: [{ id: 't1', ts: Date.now() - 3600000, count: 2, title: 'B 的问题' }] },
];
MEM.listMulti = () => [
  { id: 'm1', ts: Date.now() - 30000, count: 4, title: '三篇综述对比', chipsRef: [{ key: '1:AAAA1111', title: '论文A' }, { key: '1:BBBB2222', title: '论文B' }] },
];
P._renderList();
text = doc.getElementById(P.ROOT_ID).textContent;
ok(text.indexOf('按文章归档 · 2') >= 0, '按文章分组计数');
ok(text.indexOf('综合对话 · 1') >= 0, '综合对话分组计数');
ok(text.indexOf('论文A') >= 0 && text.indexOf('论文B') >= 0, '文章行都在');
ok(text.indexOf('三篇综述对比') >= 0, '综合对话行在');
eq(P._badgeEl.textContent, '3', '徽标 = docs + multi = 3');

console.log('== ③ 展开与会话行 ==');
const rows = walk(doc.getElementById(P.ROOT_ID), []).filter((n) => (n.className || '').indexOf('pp-ailog-row') >= 0);
const docRow = rows.find((r) => (r.className || '').indexOf('pp-doc') >= 0 && r.textContent.indexOf('论文A') >= 0);
ok(!!docRow, '找到论文A 的文章行');
docRow.click();
ok(!!P._expanded['1:AAAA1111'], '点击后标记为已展开');
const after = walk(doc.getElementById(P.ROOT_ID), []).filter((n) => (n.className || '').indexOf('pp-ses') >= 0);
eq(after.length, 2, '展开后出现 2 场会话行');
ok(after[0].textContent.indexOf('第二个问题') >= 0, '会话行显示标题');

console.log('== ④ 搜索过滤 ==');
P._query = 'B 的问题';
P._renderList();
text = doc.getElementById(P.ROOT_ID).textContent;
ok(text.indexOf('论文B') >= 0, '命中论文B');
ok(text.indexOf('论文A') < 0, '未命中论文A 被过滤');
ok(text.indexOf('三篇综述对比') < 0, '综合对话也被过滤');
P._query = 'zzz-no-hit';
P._renderList();
ok(doc.getElementById(P.ROOT_ID).textContent.indexOf('没有匹配的对话') >= 0, '无命中给空态');
P._query = '';

console.log('== ⑤ 折叠 ==');
const head = walk(doc.getElementById(P.ROOT_ID), []).find((n) => (n.className || '').indexOf('pp-ailog-head') >= 0);
ok(!!head, '标题行存在');
head.click();
eq(store.get(PREF('aiLogPaneCollapsed')), true, '折叠状态写入 pref');
eq(P._bodyEl.style.display, 'none', '正文隐藏');
head.click();
eq(store.get(PREF('aiLogPaneCollapsed')), false, '再点展开');
eq(P._bodyEl.style.display, 'flex', '正文恢复');

console.log('== ⑥ 查看器与复制 ==');
P._renderList();
P._openViewer('doc', '1:AAAA1111', 's2');
ok(!!doc.getElementById(P.VIEWER_ID), '查看器已打开');
let vtext = doc.getElementById(P.VIEWER_ID).textContent;
ok(vtext.indexOf('它的局限是什么') >= 0 && vtext.indexOf('样本量偏小') >= 0, 'Q/A 都在');
ok(vtext.indexOf('SYS-SHOULD-NOT-APPEAR') < 0, 'system 消息不展示');
P._copyMarkdown({ doc: { title: '论文A' }, session: { history: [
  { role: 'system', content: 'SYSTEM-MARKER' }, { role: 'user', content: '问一句' }, { role: 'assistant', content: '答一句' },
] } });
ok(!!Zotero._clip && Zotero._clip.indexOf('# 论文A') === 0, 'Markdown 首行是文章标题');
ok(Zotero._clip.indexOf('**问：** 问一句') > 0 && Zotero._clip.indexOf('**答：** 答一句') > 0, '问答成对');
ok(Zotero._clip.indexOf('SYSTEM-MARKER') < 0, 'system 消息不进 Markdown');
P._closeViewer();
eq(doc.getElementById(P.VIEWER_ID), null, '查看器可关闭');

console.log('== ⑦ 模块缺位容错 ==');
const savedMem = sandbox.ChatMemory;
delete sandbox.ChatMemory;
P._renderList();
ok(doc.getElementById(P.ROOT_ID).textContent.indexOf('记忆模块不可用') >= 0, '缺 ChatMemory 时给提示不抛错');
sandbox.ChatMemory = MEM;

/* ---------------- 汇总 ---------------- */
console.log('');
if (fails.length) {
  console.error('FAILED ' + fails.length + ' / ' + (pass + fails.length));
  for (const f of fails) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log('PASS ' + pass + ' assertions');
