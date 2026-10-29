#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 文献检索与综述生成 · 引用绑定与审计（0.86.0）测试
 *
 * 覆盖：
 *   ① render：按首次出现编号、跨节复用同一编号、相邻合并、未知标记保留；
 *   ② assemble：空节跳过、参考文献只列被引、itemKey → zotero 链接标记；
 *   ③ check：V1 未知/越界、V2 覆盖率、V3 数字出处（有/无）、空节警告；
 *   ④ summary/appendix/linkifyHtml 文案与转义。
 *
 * 运行：node test/lit-audit.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const FILE = path.join(ROOT, 'chrome', 'content', 'scripts', 'features', 'lit-audit.js');

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  <- ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }
function has(s, sub, label) { return ok(String(s || '').indexOf(sub) >= 0, label, { missing: sub, got: s }); }

const sb = { console, module: { exports: {} } };
sb.globalThis = sb;
vm.createContext(sb);
vm.runInContext(fs.readFileSync(FILE, 'utf8'), sb, { filename: FILE });
const A = sb.LitAudit;

const WORKS = [
  {
    id: 'w_001', title: 'Semaglutide and cardiovascular outcomes', year: 2021, journal: 'NEJM',
    authors: ['Smith J', 'Doe A'], volume: '384', issue: '2', pages: '101-110', doi: '10.1/a', itemKey: 'ABCD1234',
    abstract: 'Semaglutide reduced MACE (HR 0.86, 95% CI 0.79-0.93) in 3204 patients.',
  },
  {
    id: 'w_002', title: 'Metformin in type 2 diabetes', year: 2019, journal: 'Lancet',
    authors: ['Brown B'], doi: '10.1/b', abstract: 'Metformin lowered HbA1c by 0.5%.',
  },
  {
    id: 'w_003', title: 'An uncited paper', year: 2020, journal: 'J', authors: [], abstract: 'nothing here',
  },
];

/* ==================== ① render ==================== */

const SECTIONS = [
  { n: 1, id: 'intro', title: '引言', md: '背景见 [[W:w_001]]，另见 [[W:w_002]]。' },
  { n: 2, id: 'findings', title: '主要发现', md: '再次引用 [[W:w_001]]；并列 [[W:w_001]][[W:w_002]]。' },
  { n: 3, id: 'debate', title: '争议', md: '未知标记 [[W:w_999]] 保留。' },
];

{
  const r = A.render(SECTIONS, WORKS);
  eq(r.sections[0].md, '背景见 [1]，另见 [2]。', '第一节按出现顺序编号');
  eq(r.sections[1].md, '再次引用 [1]；并列 [1,2]。', '跨节复用编号 + 相邻合并');
  has(r.sections[2].md, '[[W:w_999]]', '未知标记原样保留（交给 V1，不静默删）');
  eq(r.order.length, 2, '被引作品 2 篇');
  eq(r.order[0], 'w_001', '首次出现者为 1 号');
  eq(r.unknown.length, 1, '未知标记记录 1 条');
  eq(r.bindings.length, 5, '每次出现都留绑定（含重复引用）');
}

{
  const r = A.render([{ n: 1, title: 'x', md: '证据 [[E:ev_1]]' }], WORKS, { evidence: [{ id: 'ev_1', workId: 'w_002' }] });
  eq(r.sections[0].md, '证据 [1]', 'P1 证据 id 可解析到作品');
  eq(r.order[0], 'w_002', '证据指向的作品被编号');
}

/* ==================== ② assemble ==================== */

{
  const r = A.render(SECTIONS.slice(0, 2), WORKS);
  const md = A.assemble({ title: '测试综述', rendered: r, works: WORKS, style: 'numeric', notice: '质量声明' });
  has(md, '# 测试综述', '标题');
  has(md, '> 质量声明', '声明引用块');
  has(md, '## 1. 引言', '第一节标题');
  has(md, '## 2. 主要发现', '第二节标题');
  has(md, '## 参考文献', '参考文献节');
  has(md, '[1] Smith J, Doe A. Semaglutide and cardiovascular outcomes. NEJM, 2021, 384(2): 101-110. doi:10.1/a', '参考文献行格式');
  has(md, '[[Z:ABCD1234]]', '有 itemKey 时插入 zotero 链接标记');
  ok(md.indexOf('[2] Brown B') > md.indexOf('[1] Smith J'), '按被引顺序排列');
  ok(md.indexOf('An uncited paper') < 0, '未被引作品不进参考文献');
}

{
  const r = A.render([{ n: 1, title: '空节', md: '   ' }], WORKS);
  const md = A.assemble({ title: 'T', rendered: r, works: WORKS });
  ok(md.indexOf('## 1. 空节') < 0, '空节不占标题');
  ok(md.indexOf('## 参考文献') < 0, '零被引不出参考文献节');
}

/* ==================== ③ check ==================== */

{
  const r = A.render(SECTIONS, WORKS);
  const audit = A.check({ sections: r.sections, works: WORKS, rendered: r, spec: { verification: { coverageMin: 0.6 } } });
  eq(audit.v1.ok, false, 'V1 因未知标记不通过');
  eq(audit.v1.unknown.length, 1, 'V1 报出未知标记');
  eq(audit.v2.cited, 2, 'V2 被引 2 篇');
  eq(audit.v2.total, 3, 'V2 纳入 3 篇');
  eq(audit.v2.coverage, 0.667, 'V2 覆盖率四舍五入到三位');
  eq(audit.v2.ok, true, 'V2 0.667 ≥ 0.6 通过');
  eq(audit.v2.uncitedCount, 1, 'V2 列出未引用 1 篇');
}

{
  const works = WORKS.slice();
  const r = A.render([{ n: 1, title: 'x', md: '结论 [[W:w_001]]。' }], works);
  const audit = A.check({ sections: r.sections, works: works, rendered: r, spec: { verification: { coverageMin: 0.9 } } });
  eq(audit.v2.ok, false, '覆盖率低于阈值 → 不通过');
}

{
  const r = A.render([
    { n: 1, title: 'x', md: '风险下降（HR 0.86）[[W:w_001]]。' },
    { n: 2, title: 'y', md: '风险下降 14%[[W:w_001]]。' },
  ], WORKS);
  const audit = A.check({ sections: r.sections, works: WORKS, rendered: r, spec: { verification: { coverageMin: 0.1 } } });
  eq(audit.v3.ok, false, 'V3：14% 不在摘要里 → 报问题');
  eq(audit.v3.issues.length, 1, 'V3 只报一处', audit.v3.issues);
  eq(audit.v3.issues[0].token, '14%', 'V3 命中 14%');
  eq(audit.v3.issues[0].section, 2, 'V3 定位到第二节');
  ok(audit.v3.issues[0].workIds.indexOf('w_001') >= 0, 'V3 带上所引作品');
}

{
  const r = A.render([{ n: 1, title: 'x', md: '风险下降（HR 0.86，3204 例）[[W:w_001]]。' }], WORKS);
  const audit = A.check({ sections: r.sections, works: WORKS, rendered: r, spec: { verification: { coverageMin: 0.1 } } });
  eq(audit.v3.ok, true, 'V3：数字都在摘要里 → 通过', audit.v3.issues);
}

{
  const r = A.render([{ n: 1, title: 'x', md: '[9] 手写编号' }], WORKS);
  const audit = A.check({ sections: r.sections, works: WORKS, rendered: r, spec: {} });
  eq(audit.v1.outOfRange.length, 1, 'V1 报越界编号（模型手写 [9]）');
  eq(audit.v1.ok, false, 'V1 越界即不通过');
}

{
  const r = A.render([{ n: 1, title: 'x', md: '' }], WORKS);
  const audit = A.check({ sections: r.sections, works: WORKS, rendered: r, spec: {} });
  has((audit.warnings || []).join('；'), '空节', '空节进警告');
}

/* ==================== ④ 文案与转义 ==================== */

{
  const audit = {
    v1: { ok: false, unknown: ['W:w_9'], outOfRange: [{ section: 2, n: 5 }] },
    v2: { ok: true, coverage: 0.6, cited: 6, total: 10, coverageMin: 0.6, uncitedCount: 4, uncited: [{ title: 'A' }] },
    v3: { ok: false, issueCount: 2, issues: [{ section: 3, token: '14%', sentence: '风险下降 14%。' }] },
    warnings: [],
  };
  const s = A.summary(audit);
  has(s, '覆盖率 60%', 'summary 覆盖率');
  has(s, '未知标记 1 处', 'summary 未知标记');
  has(s, '越界 1 处', 'summary 越界');
  has(s, '2 处数字', 'summary 数字问题');
  const ap = A.appendix(audit);
  has(ap, '## 附：引用审计', 'appendix 标题');
  has(ap, '**未通过**', 'appendix 标注未通过');
  has(ap, '「14%」', 'appendix 列出待核数字');
}

{
  const html = A.linkifyHtml('见 [[Z:ABCD1234]] 与 [[Z:"bad"]]');
  has(html, '<a href="zotero://select/library/items/ABCD1234">在库中打开</a>', '链接标记转锚点');
  ok(html.indexOf('[[Z:"bad"]]') < 0, '非法 key 不生成链接');
}

/* ==================== 汇总 ==================== */

if (fails.length) {
  console.error('\n✗ 引用审计测试失败 ' + fails.length + ' 项：');
  for (const f of fails) console.error('  - ' + f);
  process.exit(1);
}
console.log('✓ 引用审计测试通过：' + pass + ' 项断言');
