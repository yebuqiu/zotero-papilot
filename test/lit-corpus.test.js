#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 文献检索与综述生成 · 语料编排（0.86.0）测试
 *
 * 覆盖：
 *   ① recordOf：DOI 归一、年份解析、作者清洗；
 *   ② titleSim / dedupe：DOI+PMID 并查集、预印本合并、同名不同年不合并、字段互补；
 *   ③ score：相关度单调、撤稿归零、缺摘要扣分；
 *   ④ screen：硬规则、阈值分档、理由可读；
 *   ⑤ stats / toCsv / toImportRecord；
 *   ⑥ searchAll：多页 offset、单源失败不拖累、冷却源跳过；
 *   ⑦ build：一次跑通并给出统计与 CSV。
 *
 * 运行：node test/lit-corpus.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const F_Q = path.join(ROOT, 'chrome', 'content', 'scripts', 'features', 'lit-query.js');
const F_C = path.join(ROOT, 'chrome', 'content', 'scripts', 'features', 'lit-corpus.js');

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
  const sb = Object.assign({ console, module: { exports: {} }, Date, Math, JSON, Map, Set, Promise }, extra || {});
  sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(F_Q, 'utf8'), sb, { filename: F_Q });
  vm.runInContext(fs.readFileSync(F_C, 'utf8'), sb, { filename: F_C });
  return sb;
}

const SPEC = {
  name: 'GLP-1 综述',
  sources: { enabled: ['pubmed'], perSource: { pubmed: { pageSize: 100, maxRecords: 150 } } },
  query: {
    mode: 'keywords',
    topics: '',
    topic: 'semaglutide, cardiovascular',
    booleanMode: 'all',
    filters: { dateFrom: '', languages: [], publicationTypes: [], excludePublicationTypes: [], hasAbstract: true, openAccessOnly: false, species: 'any' },
  },
  screening: { thresholds: { include: 60, exclude: 30 }, hardFilters: { minYear: 0, requireAbstract: true, excludeRetracted: true, minCitations: 0 } },
};

function rec(o) {
  return Object.assign({
    source: 'pubmed', sourceId: 'x', doi: '', pmid: '', arxivId: '',
    title: '', abstract: '', authors: [], date: '', year: 0, journal: '', volume: '', issue: '', pages: '',
    type: 'journal-article', publicationTypes: [], language: 'eng', citationCount: 0,
    isRetracted: false, oaUrl: '', url: '', issn: '',
  }, o);
}

/* ==================== ① recordOf ==================== */

{
  const sb = makeSandbox();
  const C = sb.LitCorpus;
  const r = C.recordOf('openalex', {
    id: 'W123', doi: 'https://doi.org/10.1056/NEJMoa1504720', title: '  A  Trial ',
    summary: 'line1\nline2', authors: ['Smith J', ' Doe A '], published: '2015-06-01',
    venue: 'NEJM', citationCount: '42', pdfUrl: 'https://x/y.pdf',
  });
  eq(r.doi, '10.1056/nejmoa1504720', 'DOI 去前缀并小写');
  eq(r.title, 'A Trial', '标题空白折叠');
  eq(r.abstract, 'line1 line2', '摘要换行折叠');
  eq(r.year, 2015, '年份从日期解析');
  eq(r.citationCount, 42, '被引量转数字');
  eq(r.authors.length, 2, '作者去空但保留');
  eq(r.sourceId, 'W123', 'sourceId 取源 id');
}

/* ==================== ② 去重 ==================== */

{
  const sb = makeSandbox();
  const C = sb.LitCorpus;
  ok(C.titleSim('Attention is all you need', 'Attention Is All You Need!') > 0.99, '同标题标点差异相似度≈1');
  ok(C.titleSim('Deep learning for asthma', 'Asthma: a review of guidelines') < 0.5, '不同标题相似度低');

  const records = [
    rec({ source: 'pubmed', pmid: '111', doi: '10.1/a', title: 'Semaglutide and cardiovascular outcomes', abstract: 'short', year: 2021, date: '2021-01-01' }),
    rec({ source: 'openalex', doi: '10.1/A', title: 'Semaglutide and cardiovascular outcomes', abstract: 'a much longer abstract with numbers 0.86 and 3204 patients', year: 2021, citationCount: 120, type: 'article' }),
    rec({ source: 'europepmc', pmid: '111', title: 'Semaglutide and cardiovascular outcomes', abstract: 'epmc abstract', year: 2021 }),
    rec({ source: 'arxiv', doi: '10.48550/arxiv.2001.00001', arxivId: '2001.00001', title: 'Semaglutide and cardiovascular outcomes', abstract: 'preprint', year: 2020, type: 'preprint' }),
    rec({ source: 'pubmed', pmid: '222', title: 'Semaglutide and cardiovascular outcomes', abstract: 'editorial', year: 2018 }),
    rec({ source: 'pubmed', pmid: '333', title: 'Metformin in type 2 diabetes', abstract: 'different', year: 2019 }),
  ];
  const d = C.dedupe(records, { titleThreshold: 0.92 });
  eq(d.works.length, 3, '6 条记录合并为 3 篇作品（DOI+PMID 并查集 + 预印本）', d.works.map((w) => w.title));
  eq(d.merged, 3, '合并掉 3 条');
  const w = d.works.find((x) => x.pmid === '111');
  ok(!!w, '主记录按 DOI 找到');
  eq(w.sources.length, 4, '合并后保留 4 个来源（含预印本源）');
  eq(w.abstract.length > 20, true, '摘要取最长');
  eq(w.citationCount, 120, '被引取最大');
  ok(w.versions.length >= 2, '保留预印本/正式版关系');
  const sameTitleDiffYear = d.works.filter((x) => /Semaglutide/.test(x.title));
  eq(sameTitleDiffYear.length, 2, '同名但年份差 ≥2 年不合并（社论独立成篇）');
}

{
  const sb = makeSandbox();
  const C = sb.LitCorpus;
  const d = C.dedupe([
    rec({ pmid: '1', title: 'Trial of X', year: 2021, isRetracted: true }),
    rec({ pmid: '2', title: 'Trial of X', year: 2022 }),
  ]);
  eq(d.works.length, 1, '同年相邻合并');
  eq(d.works[0].isRetracted, true, '撤稿状态宁严勿松（任一源标记即撤稿）');
}

/* ==================== ③ 打分 ==================== */

{
  const sb = makeSandbox();
  const C = sb.LitCorpus;
  const spec = sb.LitQuery.normalize(SPEC);
  const high = C.score({
    title: 'Semaglutide and cardiovascular outcomes in type 2 diabetes',
    abstract: 'Semaglutide reduced cardiovascular events; HR 0.74, 95% CI 0.58-0.95, n=3297.',
    year: new Date().getFullYear(), type: 'journal-article', publicationTypes: ['Randomized Controlled Trial'],
    language: 'eng', citationCount: 300, isRetracted: false,
  }, spec);
  const low = C.score({
    title: 'A note on hospital billing', abstract: 'Unrelated content about billing systems.',
    year: 2005, type: 'editorial', publicationTypes: ['Editorial'], language: 'eng', citationCount: 0, isRetracted: false,
  }, spec);
  ok(high.score > low.score + 30, '相关文献分数显著更高', { high: high.score, low: low.score });
  ok(high.T >= 0.99, '高相关标题命中全部概念', high);
  const retracted = C.score({ title: 'Semaglutide', abstract: 'x', year: 2020, isRetracted: true }, spec);
  eq(retracted.score, 0, '撤稿直接归零');
  const noAbs = C.score({ title: 'Semaglutide cardiovascular', abstract: '', year: 2020 }, spec);
  ok(noAbs.score < C.score({ title: 'Semaglutide cardiovascular', abstract: 'semaglutide cardiovascular outcomes', year: 2020 }, spec).score,
    '无摘要扣分');
}

/* ==================== ④ 筛选 ==================== */

{
  const sb = makeSandbox();
  const C = sb.LitCorpus;
  const spec = sb.LitQuery.normalize(Object.assign({}, SPEC, {
    screening: {
      hardFilters: { minYear: 2020, requireAbstract: true, excludeRetracted: true, minCitations: 0 },
      thresholds: { include: 50, exclude: 20 },
      minConceptCoverage: 0.5,
    },
  }));
  const works = [
    { id: 'w_001', title: 'Semaglutide and cardiovascular outcomes', abstract: 'semaglutide cardiovascular', year: 2021, isRetracted: false, citationCount: 10, type: 'journal-article', publicationTypes: [], sources: ['pubmed'], language: 'eng' },
    { id: 'w_002', title: 'Semaglutide and cardiovascular outcomes', abstract: '', year: 2021, isRetracted: false, citationCount: 0, type: 'journal-article', publicationTypes: [], sources: ['pubmed'], language: 'eng' },
    { id: 'w_003', title: 'Old paper on semaglutide', abstract: 'semaglutide cardiovascular', year: 2010, isRetracted: false, citationCount: 0, type: 'journal-article', publicationTypes: [], sources: ['pubmed'], language: 'eng' },
    { id: 'w_004', title: 'Semaglutide', abstract: 'semaglutide cardiovascular', year: 2021, isRetracted: true, citationCount: 0, type: 'journal-article', publicationTypes: [], sources: ['pubmed'], language: 'eng' },
  ];
  const ds = C.screen(works, spec);
  const by = new Map(ds.map((d) => [d.workId, d]));
  eq(by.get('w_001').decision, 'include', '符合条件 → include');
  eq(by.get('w_002').decision, 'exclude', '无摘要 → exclude');
  has((by.get('w_002').reasons || []).join('；'), '无摘要', '无摘要理由可读');
  has((by.get('w_003').reasons || []).join('；'), '早于', '年份理由可读');
  has((by.get('w_004').reasons || []).join('；'), '撤稿', '撤稿理由可读');
  const st = C.stats(works, ds);
  eq(st.total, 4, 'stats total');
  eq(st.include + st.maybe + st.exclude, 4, 'stats 三档之和等于总数');
  eq(st.retracted, 1, 'stats 统计撤稿数');
}

/* ==================== ⑤ 导出 ==================== */

{
  const sb = makeSandbox();
  const C = sb.LitCorpus;
  const works = [{ id: 'w_001', title: 'Trial, "quoted"', authors: ['Smith J'], year: 2021, journal: 'NEJM', doi: '10.1/a', pmid: '1', sources: ['pubmed'], volume: '1', issue: '2', pages: '3-4', type: 'journal-article', abstract: 'x' }];
  const csv = C.toCsv(works, [{ workId: 'w_001', decision: 'include', score: 80, reasons: ['ok, fine'] }]);
  has(csv, 'workId,decision,score', 'CSV 表头');
  has(csv, '"Trial, ""quoted"""', 'CSV 引号转义');
  has(csv, '"ok, fine"', 'CSV 理由内逗号加引号');
  ok(csv.endsWith('\r\n'), 'CSV 行尾 CRLF');

  const r = C.toImportRecord(works[0]);
  eq(r.itemType, 'journalArticle', '导入类型');
  eq(r.authors[0].family, 'Smith', '作者姓抽取');
  eq(r.authors[0].given, 'J', '作者名缩写抽取');
  eq(r.container, 'NEJM', '期刊映射到 container');
}

/* ==================== ⑥ 检索编排 ==================== */

function mkSub(calls, opts) {
  const o = opts || {};
  return {
    _isDead: () => !!o.dead,
    _scrub: (s) => s,
    _markDead(id) { o.marked = id; },
    async searchOne(id, sub, opts2) {
      calls.push({ id, offset: opts2.offset, limit: opts2.limit, q: sub && sub._q });
      if (o.fail && o.fail[id]) throw new Error(o.fail[id]);
      const start = opts2.offset || 0;
      const n = Math.min(opts2.limit, 100 - start);
      const out = [];
      for (let i = 0; i < n; i++) {
        const k = start + i;
        out.push({
          id: 'pmid' + k, pmid: String(k), title: 'Semaglutide cardiovascular ' + k,
          summary: 'semaglutide cardiovascular outcomes n=100', authors: ['A B'], published: '2021-01-01',
          venue: 'J', type: 'journal-article',
        });
      }
      return out;
    },
  };
}

{
  const calls = [];
  const sb = makeSandbox({ SubSources: mkSub(calls) });
  const C = sb.LitCorpus;
  (async () => {
    const r = await C.searchAll(SPEC, { now: new Date('2026-10-28') });
    eq(r.ok, true, 'searchAll 成功');
    eq(r.records.length, 100, '单源两页共 100 条（第二页只有 50）', calls.map((c) => c.offset));
    eq(calls.length, 2, '分页两次');
    eq(calls[0].offset, 0, '首页 offset 0');
    eq(calls[1].offset, 100, '第二页 offset 100');
    ok(!!calls[0].q, '单源条件带预编译检索式');
    has(calls[0].q, 'semaglutide[tiab]', 'PubMed 编译式下发');

    const badSpec = Object.assign({}, SPEC, {
      sources: { enabled: ['openalex'] },
      query: { mode: 'custom', customQuery: { syntax: 'pubmed', expression: 'asthma[tiab]' }, filters: { languages: [] } },
    });
    const r2 = await C.searchAll(badSpec, { now: new Date('2026-10-28') });
    eq(r2.ok, false, '自定义语法无支持源 → 启动前拒绝（不空跑）');
    has(r2.reason, '不支持', '拒绝理由可读', r2.reason);
  })();
}

{
  const calls = [];
  const sb = makeSandbox({
    SubSources: Object.assign(mkSub(calls, { fail: { pubmed: '请求超时（25s）' }, marked: '' }), {}),
  });
  const C = sb.LitCorpus;
  (async () => {
    const r = await C.searchAll(SPEC, { now: new Date('2026-10-28') });
    eq(r.ok, false, '单源唯一源失败 → 整体失败');
    eq(r.bySource.pubmed.ok, false, 'bySource 标注失败');
    has(r.bySource.pubmed.reason, '超时', '失败原因保留');
  })();
}

/* ==================== ⑦ build ==================== */

{
  const calls = [];
  const sb = makeSandbox({ SubSources: mkSub(calls) });
  const C = sb.LitCorpus;
  (async () => {
    const r = await C.build(SPEC, { now: new Date('2026-10-28') });
    eq(r.ok, true, 'build 成功');
    ok(r.works.length > 0, '有语料');
    eq(r.decisions.length, r.works.length, '每条作品都有判定');
    ok(!!r.stats && r.stats.total === r.works.length, 'stats 与语料一致');
    has(r.csv, 'decision', 'CSV 产出');
  })();
}

/* ==================== 汇总（等异步用例跑完） ==================== */

setTimeout(() => {
  if (fails.length) {
    console.error('\n✗ 语料编排测试失败 ' + fails.length + ' 项：');
    for (const f of fails) console.error('  - ' + f);
    process.exit(1);
  }
  console.log('✓ 语料编排测试通过：' + pass + ' 项断言');
}, 50);
