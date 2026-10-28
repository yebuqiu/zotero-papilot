#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
let pass = 0;
const failures = [];
function ok(condition, label, detail) {
  if (condition) { pass++; return; }
  failures.push(label + (detail === undefined ? '' : ' ← ' + JSON.stringify(detail)));
}
function eq(actual, expected, label) { ok(actual === expected, label, { actual, expected }); }

const prefData = {};
const context = vm.createContext({
  console, URL, Set, Date,
  Prefs: {
    get(key, fallback) { return Object.prototype.hasOwnProperty.call(prefData, key) ? prefData[key] : fallback; },
    set(key, value) { prefData[key] = String(value); },
  },
  Zotero: { debug() {}, HTTP: { request: async () => { throw new Error('not stubbed'); } } },
  fetch: async () => { throw new Error('fetch not stubbed'); },
});
for (const rel of ['chrome/content/scripts/core/catalog-client.js', 'chrome/content/scripts/core/community.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), context, { filename: rel });
}
const C = context.Community;
const builtin = JSON.parse(fs.readFileSync(path.join(ROOT, 'chrome/content/community.json'), 'utf8'));

/* 配置结构与清洗 */
ok(C.validate(builtin).ok, '包内配置通过结构校验');
eq(C.normalize(builtin).items.length, 0, '未提供真实联系方式的占位条目全部隐藏');
ok(!C.validate({ version: 2, items: [] }).ok, '拒绝未知配置版本');
ok(!C.validate({ version: 1, items: {} }).ok, '拒绝非数组 items');
eq(C.safeUrl('javascript:alert(1)'), '', '拒绝 javascript 链接');
eq(C.safeUrl('http://example.com/insecure'), '', '拒绝明文 HTTP 链接');
eq(C.safeUrl('https://example.com/group'), 'https://example.com/group', '保留 HTTPS 链接');
eq(C.validEmail('not-an-email'), '', '拒绝非法邮箱');

const normalized = C.normalize({ version: 1, updatedAt: '2026-10-27', items: [
  { id: 'off', type: 'link', enabled: false, title: '关闭项' },
  { id: 'mail', type: 'email', group: 'support', order: 40, title: '售后', value: 'support@example.com' },
  { id: 'qq', type: 'qq', order: 20, title: 'QQ 群', value: '123456', url: 'https://example.com/join' },
  { id: 'qq', type: 'qq', order: 1, title: '重复 ID' },
  { id: 'wx', type: 'wechat', order: 10, title: '微信群', qrUrl: 'https://example.com/wx.png', expiresAt: '2026-10-01' },
  { id: 'bad', type: 'unknown', order: 0, title: '未知类型' },
] }, Date.parse('2026-10-27T00:00:00+08:00'));
eq(normalized.items.length, 3, '过滤关闭项、重复 ID 和未知类型');
eq(normalized.items.map((x) => x.id).join(','), 'wx,qq,mail', '按 order 排序');
eq(normalized.items[0].qrUrl, '', '过期微信群不再暴露二维码');
ok(normalized.items[0].expired, '过期项保留用于显示更新提示');
eq(normalized.items[1].url, 'https://example.com/join', '群链接规范化后保留');
const badExpiry = C.normalize({ version: 1, items: [
  { id: 'wx', type: 'wechat', title: '微信群', qrUrl: 'https://example.com/wx.png', expiresAt: 'not-a-date' },
] });
ok(badExpiry.items[0].expired && !badExpiry.items[0].qrUrl, '非法过期日期按失效处理，不展示旧二维码');

/* 在线配置与包内降级 */
(async () => {
  const remote = { version: 1, updatedAt: 'remote', items: [
    { id: 'qq', type: 'qq', title: 'QQ 群', value: '123456', enabled: true },
  ] };
  const client = C._getClient();
  client._c.httpGet = async () => remote;
  const online = await C.getConfig(true);
  eq(online.source, 'server', '在线配置首选账号后台公开接口');
  eq(C.URLS[0], 'https://pp.xinglintools.top/api/public/community', '首源固定为官方公开接口');
  ok(C.URLS[1].includes('gitee.com') && C.URLS[2].includes('github'), 'Gitee/GitHub 作为只读兜底');
  eq(online.config.items.length, 1, '在线条目正常返回');
  eq(online.config.updatedAt, 'remote', '在线更新时间透传');
  ok(!!prefData[C.CACHE_PREF], '在线配置写入持久化缓存');

  C._builtin = null;
  C.init({ rootURI: 'chrome://papilot/' });
  context.fetch = async (url) => {
    eq(url, 'chrome://papilot/chrome/content/community.json', '包内备用配置路径正确');
    return { ok: true, json: async () => builtin };
  };
  client._c.httpGet = async () => { throw new Error('offline'); };
  delete prefData[C.CACHE_PREF];
  const offline = await C.getConfig(true);
  eq(offline.source, 'builtin', '无缓存且离线时回退包内配置');
  eq(offline.config.items.length, 0, '包内空占位配置不制造虚构联系方式');

  /* 面板与装配静态契约 */
  const xhtml = fs.readFileSync(path.join(ROOT, 'chrome/content/prefs.xhtml'), 'utf8');
  const panel = fs.readFileSync(path.join(ROOT, 'chrome/content/prefs-community.js'), 'utf8');
  const main = fs.readFileSync(path.join(ROOT, 'chrome/content/scripts/main.js'), 'utf8');
  const menus = fs.readFileSync(path.join(ROOT, 'chrome/content/scripts/menus.js'), 'utf8');
  ok(xhtml.includes('data-fold="community"'), '设置页含联系与社群折叠卡');
  ok(xhtml.indexOf('data-fold="community"') > xhtml.indexOf('data-fold="cloud"'), '联系与社群位于数据与同步之后');
  ok(xhtml.includes('23 项 · 8 类'), '工具条计数同步为 23 项 8 类');
  ok(panel.includes('textContent') && !panel.includes('innerHTML'), '远程文本只按纯文本渲染');
  ok(panel.includes('MutationObserver') && panel.includes('pp-fold-closed'), '仅展开卡片时触发加载');
  ok(panel.includes('addEventListener("toggle"') && panel.includes('referrerpolicy'), '二维码按需加载且禁止引用来源跟踪');
  ok(main.includes('core/community.js') && main.includes('prefs-community.js'), '主入口注册核心域与面板脚本');
  ok(menus.includes('openCommunity()') && menus.includes('_prefsFocus = "community"'), '工具菜单复用设置卡深链');

  if (failures.length) {
    console.error('联系与社群测试失败 ' + failures.length + ' 项：\n- ' + failures.join('\n- '));
    process.exit(1);
  }
  console.log('联系与社群测试通过：' + pass + ' 项');
})().catch((error) => {
  console.error(error && error.stack || error);
  process.exit(1);
});
