#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/* 组件商店窗口状态回归：最小内存 DOM，无真实窗口/网络。 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'chrome', 'content', 'module-store-window.js'), 'utf8');
let pass = 0;
const fails = [];
function ok(c, label, extra) { if (c) pass++; else fails.push(label + (extra === undefined ? '' : ' <- ' + JSON.stringify(extra))); }
function eq(a, b, label) { ok(a === b, label, { got: a, want: b }); }
function has(a, b, label) { ok(String(a).indexOf(b) >= 0, label, String(a)); }

class El {
  constructor(tag, id) {
    this.tagName = tag; this.id = id || ''; this.children = []; this.attrs = {};
    this.style = {}; this.listeners = {}; this.textContent = ''; this.disabled = false;
    this.value = ''; this.parent = null;
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  appendChild(n) { this.children.push(n); n.parent = this; return n; }
  addEventListener(k, fn) { (this.listeners[k] || (this.listeners[k] = [])).push(fn); }
  focus() {}
  querySelectorAll(tag) {
    const out = [];
    for (const c of this.children) {
      if (c.tagName === tag) out.push(c);
      out.push(...c.querySelectorAll(tag));
    }
    return out;
  }
  all() { return [this].concat(...this.children.map(c => c.all())); }
  async click() { for (const fn of this.listeners.click || []) await fn({ stopPropagation() {} }); }
}
const IDS = ['pp-ms-root', 'pp-ms-search', 'pp-ms-refresh', 'pp-ms-chipbar', 'pp-ms-chips',
  'pp-ms-updates-entry', 'pp-ms-main', 'pp-ms-view-list', 'pp-ms-view-detail', 'pp-ms-view-updates',
  'pp-ms-grid', 'pp-ms-empty', 'pp-ms-empty-title', 'pp-ms-empty-sub', 'pp-ms-retry',
  'pp-ms-upd-summary', 'pp-ms-upd-list', 'pp-ms-upd-empty', 'pp-ms-update-all',
  'pp-ms-status', 'pp-ms-status-text', 'pp-ms-spinner'];
function flush() { return new Promise(resolve => setImmediate(resolve)); }
async function boot(result, rows) {
  const els = {};
  for (const id of IDS) els[id] = new El('div', id);
  const document = {
    readyState: 'complete',
    getElementById(id) { return els[id] || null; },
    createElementNS(ns, tag) { return new El(tag); },
  };
  const store = {
    async fetchCatalog(force) { return typeof result === 'function' ? result(force) : result; },
    listRows() { return typeof rows === 'function' ? rows() : (rows || []); },
    async rollback() { return { ok: true }; },
    async uninstall() { return { ok: true }; },
    async install() { return { ok: true }; },
  };
  const window = {
    arguments: [{ Zotero: { Papilot: { moduleStore: store, moduleLoader: { list() { return []; } } } } }],
    addEventListener() {}, matchMedia() { return { matches: false }; }, close() {},
  };
  const sandbox = { window, document, console, addEventListener() {}, setTimeout, clearTimeout };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'module-store-window.js' });
  await flush(); await flush();
  return { els, store };
}
function buttons(root, label) { return root.all().filter(n => n.tagName === 'button' && (!label || n.textContent === label)); }

async function main() {
  for (const source of ['stale-cache', 'builtin']) {
    const env = await boot({ ok: true, source, modules: [] }, []);
    has(env.els['pp-ms-status-text'].textContent, source === 'stale-cache' ? '缓存' : '内置', 'P2 ' + source + '：状态明确为降级来源');
  }
  {
    const env = await boot({ ok: false, error: 'HTTP 503', modules: [] }, []);
    has(env.els['pp-ms-status-text'].textContent, '目录加载失败', 'P2 res.ok=false：显示失败状态');
    has(env.els['pp-ms-status-text'].textContent, 'HTTP 503', 'P2 res.ok=false：透出错误原因');
    eq(env.els['pp-ms-status'].attrs.class, 'pp-ms-status pp-ms-st-err', 'P2 res.ok=false：错误样式');
  }
  for (const canRollback of [false, true]) {
    const rows = [{ id: 'papilot-mod-a', name: 'A', installed: true, version: '1.0.0', canRollback }];
    const env = await boot({ ok: true, modules: rows }, rows);
    const rb = buttons(env.els['pp-ms-grid'], '回滚');
    eq(rb.length, canRollback ? 1 : 0, 'P2：canRollback 控制卡片回滚按钮 ' + canRollback);
    if (rb.length) eq(rb[0].disabled, false, 'P2：可用回滚按钮保持启用');
    await env.els['pp-ms-grid'].children[0].click(); await flush();
    const detailRb = buttons(env.els['pp-ms-view-detail'], '回滚');
    eq(detailRb.length, canRollback ? 1 : 0, 'P2：canRollback 控制详情回滚按钮 ' + canRollback);
  }
  {
    // null/畸形行与 null loader 均不得让启动抛错。
    const env = await boot({ ok: true, modules: [null] }, [null, { id: 'papilot-mod-a', installed: true }]);
    eq(env.els['pp-ms-grid'].children.length, 1, 'P2：null 行被安全过滤');
    has(env.els['pp-ms-status-text'].textContent, '共 1 个组件', 'P2：null 安全状态计数');
  }
  console.log(fails.length ? fails.map(f => '✗ ' + f).join('\n') : '✓ ' + pass + ' assertions  (module-store-window)');
  if (fails.length) console.log('module-store-window：' + pass + ' 通过，' + fails.length + ' 失败');
  process.exitCode = fails.length ? 1 : 0;
}
main().catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });
