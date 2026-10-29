#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 文献检索与综述生成 · 查询编译（0.86.0）测试
 *
 * 覆盖：
 *   ① normalize：默认值、脏源过滤、数值夹紧、权重归一、阈值纠正；
 *   ② validate：主题/关键词/自定义三种模式的阻断条件；
 *   ③ compileFor：PubMed / Europe PMC / 自由文本 的黄金串（含日期、语言、物种、排除类型）；
 *   ④ custom 模式只下发给声明支持的源；
 *   ⑤ hash 稳定性（键序无关）与变化敏感性；
 *   ⑥ JSON 往返与非法输入。
 *
 * 运行：node test/lit-query.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const FILE = path.join(ROOT, 'chrome', 'content', 'scripts', 'features', 'lit-query.js');

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  <- ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }
function has(s, sub, label) { return ok(String(s || '').indexOf(sub) >= 0, label, { missing: sub, got: s }); }
function no(s, sub, label) { return ok(String(s || '').indexOf(sub) < 0, label, { unexpected: sub, got: s }); }

const sb = { console, module: { exports: {} } };
sb.globalThis = sb;
vm.createContext(sb);
vm.runInContext(fs.readFileSync(FILE, 'utf8'), sb, { filename: FILE });
const Q = sb.LitQuery;

if (!ok(Q && typeof Q.normalize === 'function', '模块导出 LitQuery')) {
  console.error(fails.join('\n'));
  process.exit(1);
}

/* ==================== ① normalize ==================== */

{
  const s = Q.normalize({});
  eq(s.sources.enabled.length, 2, '默认两源');
  eq(s.sources.enabled[0], 'pubmed', '默认首源 PubMed');
  eq(s.query.mode, 'topic', '默认主题模式');
  eq(s.screening.thresholds.include, 65, '默认纳入阈值 65');
  eq(s.verification.coverageMin, 0.6, '默认覆盖率阈值 0.6');
}

{
  const s = Q.normalize({ sources: { enabled: ['pubmed', 'pubmed', 'scopus', 'PubMed'] } });
  eq(s.sources.enabled.length, 1, '去重 + 丢未知源');
  eq(s.sources.enabled[0], 'pubmed', '源 id 小写归一');
}

{
  const s = Q.normalize({ sources: { enabled: ['openalex'], perSource: { openalex: { maxRecords: 9999, pageSize: 1 } } } });
  eq(s.sources.perSource.openalex.maxRecords, 200, 'OpenAlex maxRecords 夹紧到接口上限 200');
  eq(s.sources.perSource.openalex.pageSize, 10, 'pageSize 下限 10');
}

{
  const s = Q.normalize({ screening: { weights: { title: 2, abstract: 2, keyword: 0, recency: 0, evidenceType: 0 } } });
  const sum = s.screening.weights.title + s.screening.weights.abstract +
    s.screening.weights.keyword + s.screening.weights.recency + s.screening.weights.evidenceType;
  ok(Math.abs(sum - 1) < 1e-9, '权重自动归一为 1', { sum });
  ok(Math.abs(s.screening.weights.title - 0.5) < 1e-9, '权重按比例分配（title 0.5）', s.screening.weights);
}

{
  const s = Q.normalize({ screening: { thresholds: { include: 40, exclude: 60 } } });
  ok(s.screening.thresholds.exclude < s.screening.thresholds.include, '阈值倒置被纠正');
}

{
  const s = Q.normalize({ query: { filters: { dateFrom: '2020/01/01', dateTo: 'bad' } } });
  eq(s.query.filters.dateFrom, '', '非 ISO 日期清空');
  eq(s.query.filters.dateTo, '', '非法日期清空');
}

/* ==================== ② validate ==================== */

{
  const r = Q.validate(Q.normalize({ query: { mode: 'topic', topic: '' } }));
  ok(!r.ok, '主题模式空主题 → 校验失败');
  has(r.errors.map((e) => e.msg).join('；'), '主题', '错误信息指出主题');
}

{
  const r = Q.validate(Q.normalize({
    sources: { enabled: ['pubmed'] },
    query: { mode: 'custom', customQuery: { syntax: 'pubmed', expression: 'asthma[tiab]' } },
  }));
  eq(r.ok, true, '自定义模式 + PubMed → 通过');
}

{
  const r = Q.validate(Q.normalize({
    sources: { enabled: ['openalex'] },
    query: { mode: 'custom', customQuery: { syntax: 'pubmed', expression: 'asthma[tiab]' } },
  }));
  ok(!r.ok, '自定义模式无 PubMed → 失败（不假装语法通用）');
}

/* ==================== ③ 黄金串 ==================== */

const SPEC = Q.normalize({
  name: 'GLP-1',
  sources: { enabled: ['pubmed', 'europepmc', 'openalex'] },
  query: {
    mode: 'topic',
    concepts: [
      { id: 'c1', label: 'GLP-1', terms: ['semaglutide'], mesh: ['Glucagon-Like Peptide-1 Receptor Agonists'] },
      { id: 'c2', label: '结局', terms: ['MACE'], mesh: [] },
    ],
    conceptLogic: 'AND',
    filters: {
      dateFrom: '2020-01-01',
      languages: ['eng'],
      publicationTypes: [],
      excludePublicationTypes: ['Editorial'],
      species: 'human',
    },
  },
});

{
  const q = Q.compileFor('pubmed', SPEC);
  eq(q, '((semaglutide[tiab] OR "Glucagon-Like Peptide-1 Receptor Agonists"[mh]) AND MACE[tiab])'
    + ' AND (2020/01/01[dp] : 3000[dp]) AND (eng[la]) AND humans[mh] NOT ("Editorial"[pt])',
  'PubMed 检索式黄金串');
}

{
  const q = Q.compileFor('europepmc', SPEC);
  eq(q, '((TITLE_ABS:"semaglutide" OR MESH:"Glucagon-Like Peptide-1 Receptor Agonists") AND TITLE_ABS:"MACE")'
    + ' AND PUB_YEAR:[2020 TO 3000] AND (LANG:"eng") NOT (PUB_TYPE:"Editorial")',
  'Europe PMC 检索式黄金串');
}

{
  const q = Q.compileFor('openalex', SPEC);
  eq(q, 'semaglutide MACE', 'OpenAlex 自由文本 = 每概念首选词拼接');
  no(q, '[tiab]', '自由文本不含 PubMed 字段语法');
}

{
  const spec = Q.normalize({
    query: { mode: 'keywords', topic: 'asthma, COPD', concepts: [] },
  });
  has(Q.compileFor('pubmed', spec), 'asthma[tiab]', '关键词模式拆出第一个词');
  has(Q.compileFor('pubmed', spec), 'AND COPD[tiab]', '关键词模式默认 all → AND');
}

{
  const spec = Q.normalize({
    query: { mode: 'custom', customQuery: { syntax: 'pubmed', expression: 'asthma[tiab] AND 2020:2024[dp]' } },
  });
  eq(Q.compileFor('pubmed', spec), 'asthma[tiab] AND 2020:2024[dp]', '自定义式原样下发（不重写）');
  eq(Q.compileFor('openalex', spec), '', '自定义式不下发给 OpenAlex');
}

{
  const spec = Q.normalize({ query: { mode: 'topic', topic: 'GLP-1 受体激动剂与心血管结局' } });
  const c = Q.conceptsOf(spec);
  ok(c.length >= 2, '无概念组时按连接词粗拆主题', { n: c.length, c });
  has(Q.compileFor('pubmed', spec), '[tiab]', '粗拆后仍能编译出检索式');
}

/* ==================== ③b 空格分词（实机 0 命中回归） ==================== */

{
  // 实机踩到：关键词写成 "semaglutide cardiovascular" 时整串被当短语 → PubMed 0 命中
  const spec = Q.normalize({ query: { mode: 'keywords', topic: 'semaglutide cardiovascular' } });
  const cs = Q.conceptsOf(spec);
  eq(cs.length, 2, '空格分隔的关键词拆成两个概念（AND）', cs);
  const q = Q.compileFor('pubmed', spec);
  ok(q.indexOf('(semaglutide[tiab] AND cardiovascular[tiab])') === 0, '编译为两个 AND 条件，不是短语', q);
  ok(q.indexOf('"semaglutide cardiovascular"') < 0, '不再生成整串短语');
}

{
  const spec = Q.normalize({ query: { mode: 'keywords', topic: 'type 2 diabetes' } });
  const cs = Q.conceptsOf(spec);
  eq(cs.length, 2, 'type 2 diabetes → 两个概念（2 并入前项）', cs);
  eq(cs[0].terms[0], 'type 2', '短词并入前一项');
  ok(Q.compileFor('pubmed', spec).indexOf('("type 2"[tiab] AND diabetes[tiab])') === 0, '带空格的词仍加引号', Q.compileFor('pubmed', spec));
}

{
  const spec = Q.normalize({ query: { mode: 'topic', topic: 'GLP-1 受体激动剂与心血管结局' } });
  const cs = Q.conceptsOf(spec);
  eq(cs.length, 2, '中文主题按连接词切，不被空格切碎', cs);
  ok(cs[0].terms[0].indexOf('GLP-1') >= 0, '中文片段整体保留');
}

/* ==================== ④ 指纹 ==================== */

{
  const a = Q.normalize({ query: { mode: 'topic', topic: 'asthma' }, sources: { enabled: ['pubmed', 'openalex'] } });
  const b = Q.normalize({ sources: { enabled: ['openalex', 'pubmed'] }, query: { topic: 'asthma', mode: 'topic' } });
  eq(Q.hash(a), Q.hash(b), '同内容不同键序 → 同指纹');
  const c = Q.normalize({ query: { mode: 'topic', topic: 'asthma ' }, sources: { enabled: ['pubmed'] } });
  ok(Q.hash(a) !== Q.hash(c), '源集合变化 → 指纹变化');
  ok(/^[0-9a-f]{8}$/.test(Q.hash(a)), '指纹为 8 位十六进制');
}

/* ==================== ⑤ JSON 往返 ==================== */

{
  const json = Q.toJSON(SPEC);
  const back = Q.fromJSON(json);
  eq(back.ok, true, '导出再导入 ok');
  eq(Q.hash(back.spec), Q.hash(SPEC), '往返后指纹不变');
  no(json, 'credentials', '导出剔除凭据引用');
}

{
  const bad = Q.fromJSON('{not json');
  eq(bad.ok, false, '非法 JSON 被拒');
  ok(!!bad.error, '非法 JSON 有错误信息');
}

{
  const arr = Q.fromJSON('[1,2]');
  eq(arr.ok, false, '数组不是合法配置');
}

/* ==================== 汇总 ==================== */

if (fails.length) {
  console.error('\n✗ 查询编译测试失败 ' + fails.length + ' 项：');
  for (const f of fails) console.error('  - ' + f);
  process.exit(1);
}
console.log('✓ 查询编译测试通过：' + pass + ' 项断言');
