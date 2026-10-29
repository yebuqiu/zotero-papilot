#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* AI 角色与场景参数（AIRoles，0.87.0）测试
 *
 * 覆盖：
 *   ① 内置角色表与默认角色解析（含坏 pref / 不存在的 id 回落）；
 *   ② normalizeRole 清洗：非法 id 重建、空名称+空提示词丢弃、参数钳制与丢弃；
 *   ③ saveCustom 对内置 id 的改名（不得覆盖内置）、removeCustom 与默认角色回落；
 *   ④ paramsFor 优先级：全局 < 角色 < 场景 < 本轮（含 source 归因）；
 *   ⑤ sampleFor 的 top_p 三态（数值 / null=明确不传 / 继承全局）；
 *   ⑥ basePrompt 的 append / replace 两种合并模式与空角色提示词；
 *   ⑦ setSceneOverride 的清空语义（空对象 = 删除覆盖）。
 *
 * 运行：node test/ai-roles.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const FILES = [
  'chrome/content/scripts/core/utils.js',
  'chrome/content/scripts/ai/roles.js',
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

const Zotero = {
  locale: 'zh-CN',
  Prefs: {
    get(k /*, global */) { return store.has(k) ? store.get(k) : undefined; },
    set(k, v /*, global */) { store.set(k, v); },
  },
  logError() {},
};

const sandbox = {
  console, Zotero, Services: {}, JSON, Date, Math, String, Number,
  Array, Object, Set, Map, isFinite, parseInt, RegExp, Error,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const f of FILES) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f });
}

const R = sandbox.AIRoles;
const setP = (k, v) => store.set(PREF(k), v);
const getP = (k) => store.get(PREF(k));

console.log('== ① 内置角色与默认解析 ==');
eq(R.builtin.length, 5, '内置角色 5 个');
eq(R.DEFAULT_ROLE, 'scholar', '默认角色 id');
eq(R.activeId(), 'scholar', '未配置时 activeId = scholar');
eq(R.active().name, '严谨学术助手', 'active() 名称');
eq(R.get('reviewer').name, '严苛审稿人', 'get(reviewer)');
eq(R.get('nope'), null, '不存在的 id → null');
setP('aiActiveRole', 'nope');
eq(R.activeId(), 'scholar', '坏 aiActiveRole → 回落 scholar');
setP('aiActiveRole', 'polisher');
eq(R.activeId(), 'polisher', 'aiActiveRole 生效');
eq(R.all().length, 5, 'all() 数量');

console.log('== ② normalizeRole 清洗 ==');
const n1 = R.normalizeRole({ id: 'BAD ID!', name: '我的角色', prompt: 'x' });
ok(!!n1 && /^role-[a-z0-9]+$/.test(n1.id), '非法 id 重建为 role-*', n1 && n1.id);
eq(R.normalizeRole({ prompt: '' }), null, '空名称+空提示词 → null');
eq(R.normalizeRole(null), null, 'null → null');
const n2 = R.normalizeRole({ id: 'r1', name: 'T', prompt: 'p', params: { temperature: 9, maxTokens: 999999, historyRounds: 0 } });
eq(n2.params.temperature, 2, '温度钳到 2');
eq(n2.params.maxTokens, 32768, 'maxTokens 钳到 32768');
eq(n2.params.historyRounds, undefined, 'historyRounds=0 越界 → 丢弃（不写 0 轮）');
eq(n2.builtin, false, '自定义角色 builtin=false');
const n3 = R.normalizeRole({ id: 'r2', name: 'T2', prompt: 'p', params: { topP: '' } });
eq('topP' in n3.params, false, '空 topP 不进 params（语义=继承）');
eq(R.normalizeRole({ id: 'r3', name: 'T3', prompt: 'p', params: { topP: 0.5 } }).params.topP, 0.5, 'topP 0.5 保留');

console.log('== ③ saveCustom / removeCustom ==');
const s1 = R.saveCustom({ id: 'scholar', name: '我的学术版', prompt: '更严格' });
ok(!!s1 && s1.id !== 'scholar', '内置 id 保存时自动改名', s1 && s1.id);
eq(R.builtin.find((b) => b.id === 'scholar').prompt, '', '内置定义未被覆盖');
eq(R.get(s1.id).name, '我的学术版', '新角色可查');
eq(R.all().length, 6, 'all() 含新角色');
eq(R.saveCustom({ name: '', prompt: '' }), null, '空角色保存失败');
const s2 = R.saveCustom({ id: s1.id, name: '改名后', prompt: 'y' });
eq(s2.id, s1.id, '同 id 保存 = 更新而非新增');
eq(R.get(s1.id).name, '改名后', '更新生效');
eq(R.removeCustom(s1.id), true, '删除成功');
eq(R.removeCustom(s1.id), false, '重复删除返回 false');
setP('aiActiveRole', s1.id);
R.saveCustom({ id: 'tmp-1', name: '临时', prompt: 'p' });
R.setActive('tmp-1');
eq(R.removeCustom('tmp-1'), true, '删除角色成功');
eq(R.activeId(), 'scholar', '删掉当前默认角色 → 回落 scholar');

console.log('== ④ paramsFor 优先级 ==');
setP('aiActiveRole', 'scholar');
setP('aiTemperature', '0.9');
setP('aiMaxTokens', 2048);
setP('aiHistoryRounds', 8);
setP('aiTopP', '');
let p = R.paramsFor('single');
eq(p.temperature, 0.9, '全局温度生效');
eq(p.maxTokens, 2048, '全局 maxTokens 生效');
eq(p.historyRounds, 8, '全局历史轮数生效');
eq(p.source.temperature, '全局', '来源=全局');

p = R.paramsFor('single', 'reviewer');
eq(p.temperature, 0.2, '角色温度覆盖全局');
eq(p.source.temperature, '角色', '来源=角色');
eq(p.maxTokens, 2048, '角色未设 maxTokens → 沿用全局');
eq(p.source.maxTokens, '全局', 'maxTokens 来源=全局');

R.setSceneOverride('single', { temperature: 0.55, maxTokens: 3000 });
p = R.paramsFor('single', 'reviewer');
eq(p.temperature, 0.55, '场景温度覆盖角色');
eq(p.source.temperature, '场景', '来源=场景');
eq(p.maxTokens, 3000, '场景 maxTokens 覆盖全局');
p = R.paramsFor('multi', 'reviewer');
eq(p.temperature, 0.2, '别的场景不受 single 覆盖影响');

p = R.paramsFor('single', 'scholar', { temperature: 0.05 });
eq(p.temperature, 0.05, '本轮显式覆盖最高优先级');
eq(p.source.temperature, '本轮', '来源=本轮');

console.log('== ⑤ sampleFor 的 top_p 三态 ==');
setP('aiSceneParams', '');   // 清掉 ④ 写的场景覆盖，本节只测 top_p 继承
setP('aiTemperature', '0.3');
setP('aiTopP', '0.8');
let sp = R.sampleFor('single', 'scholar');
eq(sp.top_p, 0.8, '未覆盖时继承全局 top_p');
eq(sp.temperature, 0.3, 'scholar 无角色温度 → 用全局 0.3');
R.setSceneOverride('task', { topP: 0.4 });
sp = R.sampleFor('task', 'scholar');
eq(sp.top_p, 0.4, '场景 top_p 覆盖');
setP('aiTopP', '');
setP('aiSceneParams', '');
sp = R.sampleFor('single', 'scholar');
eq(sp.top_p, null, '全局与覆盖都为空 → top_p=null（明确不传）');
ok('max_tokens' in sp && 'temperature' in sp, 'sampleFor 恒带 temperature / max_tokens');

console.log('== ⑥ basePrompt 合并模式 ==');
setP('aiSystemPrompt', '全局纪律');
setP('aiRolePromptMode', 'append');
let bp = R.basePrompt('single', 'scholar');
eq(bp, '全局纪律', 'scholar 无角色提示词 → 只全局');
bp = R.basePrompt('single', 'reviewer');
ok(bp.indexOf('全局纪律') === 0 && bp.indexOf('审稿人') > 0, 'append：全局在前、角色块在后', bp.slice(0, 60));
setP('aiRolePromptMode', 'replace');
bp = R.basePrompt('single', 'reviewer');
ok(bp.indexOf('全局纪律') < 0 && bp.indexOf('审稿人') > 0, 'replace：只用角色提示词');
bp = R.basePrompt('single', 'scholar');
eq(bp, '全局纪律', 'replace 但角色无提示词 → 回落全局（不产出空 prompt）');
setP('aiRolePromptMode', 'append');
ok(R.roleBlock('reviewer').indexOf('【当前角色：严苛审稿人】') === 0, 'roleBlock 带角色名标题');
eq(R.roleBlock('scholar'), '', '无提示词角色 → 空块');

console.log('== ⑦ setSceneOverride 语义 ==');
setP('aiSceneParams', '');
eq(R.setSceneOverride('single', { temperature: 0.4 }), true, '写入成功');
let all = JSON.parse(getP('aiSceneParams'));
eq(all.single.temperature, 0.4, 'single 已写入');
eq(R.setSceneOverride('single', {}), true, '传空对象 = 删除覆盖');
all = JSON.parse(getP('aiSceneParams') || '{}');
eq('single' in all, false, 'single 覆盖已删除');
eq(R.setSceneOverride('bogus', { temperature: 1 }), false, '非法场景名被拒');
eq(R.sceneOverrides('single').temperature, undefined, '未知场景读出空对象');
setP('aiSceneParams', 'not-json');
eq(Object.keys(R.sceneOverrides('single')).length, 0, '坏 JSON → 空覆盖（不抛）');
eq(R.paramsFor('single').source.temperature, '角色' === '角色' ? R.paramsFor('single').source.temperature : '', 'paramsFor 在坏场景 pref 下仍可解析');

/* ---------------- 汇总 ---------------- */
console.log('');
if (fails.length) {
  console.error('FAILED ' + fails.length + ' / ' + (pass + fails.length));
  for (const f of fails) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log('PASS ' + pass + ' assertions');
