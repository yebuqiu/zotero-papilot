#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 文献检索与综述生成 · 综述编排（0.86.0）测试
 *
 * 覆盖：
 *   ① outline：固定六段、每节材料数、refs 由代码生成；
 *   ② pick：主要发现优先取有数字的、争议节优先取含局限表述的；
 *   ③ buildSectionPrompt：六条证据纪律、只给编号不给数字、材料截断；
 *   ④ draft：无 Key 降级、正常成稿（编号 + 参考文献 + 审计）、预算耗尽即停、全失败；
 *   ⑤ saveNote：无父条目时建独立笔记、zotero 标记不外泄。
 *
 * 运行：node test/lit-review.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'chrome', 'content', 'scripts', 'features');
const FILES = ['lit-query.js', 'lit-corpus.js', 'lit-audit.js', 'lit-review.js'];

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  <- ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }
function has(s, sub, label) { return ok(String(s || '').indexOf(sub) >= 0, label, { missing: sub, got: s }); }

function makeSandbox(extra) {
  const sb = Object.assign({ console, module: { exports: {} }, Date, Math, JSON, Map, Set, Promise, setTimeout }, extra || {});
  sb.globalThis = sb;
  vm.createContext(sb);
  for (const f of FILES) vm.runInContext(fs.readFileSync(path.join(DIR, f), 'utf8'), sb, { filename: path.join(DIR, f) });
  return sb;
}

const SPEC = {
  name: '测试综述',
  sources: { enabled: ['pubmed'] },
  query: { mode: 'keywords', topic: 'semaglutide', filters: { languages: [] } },
  writing: { language: 'zh', maxWorksPerSection: 5, maxEvidencePerSection: 10 },
  budget: { maxAiCalls: 10 },
  verification: { strictness: 'warn', coverageMin: 0.1 },
};

function work(id, o) {
  return Object.assign({
    id: id, title: 'Semaglutide and cardiovascular outcomes ' + id, authors: ['Smith J', 'Doe A'],
    year: 2021, journal: 'NEJM', abstract: 'Semaglutide reduced MACE (HR 0.86) in 3204 patients.',
    type: 'journal-article', publicationTypes: [], citationCount: 10, sources: ['pubmed'], doi: '10.1/' + id,
  }, o || {});
}

const WORKS = [
  work('w_001'),
  work('w_002', { abstract: 'However, limitations include short follow-up; no significant benefit in subgroup.', citationCount: 50 }),
  work('w_003', { abstract: 'A qualitative review without numbers.', type: 'review', citationCount: 200 }),
  work('w_004', { abstract: 'No abstract numbers here either.', citationCount: 1 }),
];

/* ==================== ① outline ==================== */

{
  const sb = makeSandbox();
  const R = sb.LitReview;
  const o = R.outline(SPEC, WORKS);
  eq(o.length, 6, '六节');
  eq(o[0].title, '引言', '第一节引言');
  eq(o[2].title, '主要发现', '第三节主要发现');
  eq(o[4].title, '结论', '第五节结论');
  eq(o[5].id, 'refs', '第六节为参考文献');
  eq(o[5].generated, true, '参考文献由代码生成');
  ok(o[0].pool > 0, '引言有可用材料');
}

/* ==================== ② pick ==================== */

{
  const sb = makeSandbox();
  const R = sb.LitReview;
  const spec = sb.LitQuery.normalize(SPEC);
  const findings = R.pick('findings', WORKS, spec);
  ok(findings.length >= 1, '主要发现有材料');
  ok(findings.every((w) => /\d/.test(w.abstract || '')), '主要发现只取有数字的摘要', findings.map((w) => w.id));
  const debate = R.pick('debate', WORKS, spec);
  ok(debate.length > 0 && debate[0].id === 'w_002', '争议节优先取含局限表述的', debate.map((w) => w.id));
  const capped = R.pick('state', WORKS.concat([work('w_005'), work('w_006')]), spec);
  eq(capped.length, 5, '每节材料数为配置上限');
}

/* ==================== ③ prompt ==================== */

{
  const sb = makeSandbox();
  const R = sb.LitReview;
  const p = R.buildSectionPrompt({ n: 3, title: '主要发现', desc: '一致结论', budget: 1500 }, WORKS.slice(0, 2), ['第1节《引言》（100 字）'], SPEC);
  has(p.system, '[[W:作品编号]]', '要求标签式引用');
  has(p.system, '绝对不要写 [1]', '禁止模型自己编号');
  has(p.system, '不得写出材料中没有的数字', '禁止编造数字');
  has(p.user, '第 3 节《主要发现》', '带本节标题');
  has(p.user, '1500 字', '带字数预算');
  has(p.user, '[[w_001]]', '材料以作品 id 开头');
  has(p.user, '第1节《引言》', '带已完成节（防重复）');
}

/* ==================== ④ draft ==================== */

const pending = [];

pending.push((async () => {
  const sb = makeSandbox();
  const r = await sb.LitReview.draft({ spec: SPEC, works: WORKS }, {});
  eq(r.ok, false, '无 Key → 不成稿');
  eq(r.reason, 'no_key', '无 Key 原因明确');
  ok(!!r.guidance, '无 Key 给指引');
})());

pending.push((async () => {
  const calls = [];
  const ai = {
    hasKey: () => true,
    guidance: () => '',
    async chat(messages) {
      calls.push(messages);
      const m = /第 (\d) 节《([^》]+)》/.exec(messages[1].content);
      const ids = ['w_001', 'w_002', 'w_003', 'w_004', 'w_001'];
      const id = m ? ids[Number(m[1]) - 1] || 'w_001' : 'w_001';
      return '本节结论 [[W:' + id + ']]。\n\n补充说明 [[W:w_002]]。';
    },
  };
  const sb = makeSandbox({ AIClient: ai });
  const r = await sb.LitReview.draft({ spec: SPEC, works: WORKS }, {});
  eq(r.ok, true, '有 Key → 成稿');
  eq(r.sections.length, 5, '五节正文（refs 由代码生成）', r.sections.map((s) => s.id));
  eq(r.calls, 5, '五节五次调用');
  eq(calls.length, 5, '实际调用 5 次');
  has(r.draft, '# 测试综述', '带标题');
  has(r.draft, '## 1. 引言', '带第一节');
  has(r.draft, '## 参考文献', '带参考文献');
  has(r.draft, '## 附：引用审计', 'warn 模式附审计');
  ok(r.draft.indexOf('[[W:') < 0, '成稿里不残留标签');
  ok(!!r.audit && r.audit.v2.total === 4, '审计以全部纳入作品为分母');
  eq(r.rendered.order[0], 'w_001', '编号按首次出现');
})());

pending.push((async () => {
  const ai = { hasKey: () => true, async chat() { return '只有一句话 [[W:w_001]]。'; } };
  const sb = makeSandbox({ AIClient: ai });
  const spec = Object.assign({}, SPEC, { budget: { maxAiCalls: 2 } });
  const r = await sb.LitReview.draft({ spec: spec, works: WORKS }, {});
  eq(r.calls, 2, '预算 2 次即停');
  eq(r.stopped, 'budget', '标记为预算耗尽');
  eq(r.sections.filter((s) => s.status === 'skipped').length, 3, '剩余三节标记 skipped');
  ok(r.draft.indexOf('## 3.') < 0, '跳过的节不出空标题');
})());

pending.push((async () => {
  const ai = { hasKey: () => true, async chat() { throw new Error('网关 502'); } };
  const sb = makeSandbox({ AIClient: ai });
  const r = await sb.LitReview.draft({ spec: SPEC, works: WORKS }, {});
  eq(r.ok, false, '全节失败 → 不成稿');
  eq(r.reason, 'all_sections_failed', '失败原因明确');
  eq(r.sections.filter((s) => s.status === 'failed').length, 5, '每节都记录失败');
})());

/* ==================== ⑤ saveNote ==================== */

pending.push((async () => {
  const saved = [];
  class FakeItem {
    constructor(type) { this.type = type; this.id = 99; this.libraryID = 1; }
    setNote(html) { this.html = html; }
    async saveTx() { saved.push(this); }
  }
  const sb = makeSandbox({
    Zotero: {
      Libraries: { userLibraryID: 1 },
      Items: { getByLibraryAndKey: () => null },
      Item: FakeItem,
      logError() {},
    },
  });
  const r = await sb.LitReview.saveNote({ draft: '# 标题\n\n正文 [[Z:ABCD1234]]', title: '测试', itemKeys: [] });
  eq(r.ok, true, '无父条目 → 建独立笔记');
  eq(r.standalone, true, '标记 standalone');
  eq(saved.length, 1, '笔记已保存');
  ok(saved[0].html.indexOf('[[Z:') < 0, '内部标记不外泄');
  has(saved[0].html, '标题', '正文进入笔记');
})());

/* ==================== ⑥ 窗口接线（静态） ==================== */

{
  const fsx = fs.readFileSync(path.join(ROOT, 'chrome', 'content', 'lit-review.xhtml'), 'utf8');
  const ui = fs.readFileSync(path.join(ROOT, 'chrome', 'content', 'lit-review-ui.js'), 'utf8');
  ok(fsx.indexOf('windowtype="papilot:lit-review"') >= 0, '窗口 windowtype 与模块常量一致');
  ok(fsx.indexOf('lit-review-ui.js') >= 0, '窗口脚本已挂载');
  ok(ui.indexOf('window.arguments') >= 0, '窗口脚本从 arguments 取 api');
  ok(fsx.indexOf('&nbsp;') < 0, '无 XML 未定义实体（&nbsp; 会让整窗空白）');
  ok(fsx.indexOf('@import url("chrome://papilot/content/ui-tokens.css")') >= 0, '首条样式引入统一令牌');
  const used = new Set();
  const re = /\$\("([A-Za-z0-9_-]+)"\)/g;
  let m;
  while ((m = re.exec(ui))) used.add(m[1]);
  const missing = [];
  for (const id of used) if (fsx.indexOf('id="' + id + '"') < 0) missing.push(id);
  ok(!missing.length, '窗口脚本引用的元素 id 都在 xhtml 里', missing);
  for (const id of ['lr-try', 'lr-build', 'lr-import', 'lr-gen', 'lr-save-note', 'lr-rows', 'lr-draft', 'lr-audit']) {
    ok(fsx.indexOf('id="' + id + '"') >= 0, '关键控件存在 #' + id);
  }
}

/* ==================== 汇总 ==================== */

Promise.all(pending).then(() => {
  if (fails.length) {
    console.error('\n✗ 综述编排测试失败 ' + fails.length + ' 项：');
    for (const f of fails) console.error('  - ' + f);
    process.exit(1);
  }
  console.log('✓ 综述编排测试通过：' + pass + ' 项断言');
}).catch((e) => {
  console.error('✗ 测试执行异常：', e && e.stack || e);
  process.exit(1);
});
