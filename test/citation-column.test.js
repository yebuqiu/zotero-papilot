#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 被引量列 · 取数链路与刷新契约测试（0.85.0；Node vm 桩）
 *
 * 为什么要有它：2026-10-27 用户报「被引量整列空白」。真因是 **未配 API Key 时
 * Semantic Scholar 的 POST /paper/batch 恒 429**，而旧实现只有批量一条链路，且
 * 429 后无上限地把整批重新入队 —— 永不收敛的空转环：列永远停在「…」，还持续
 * 占用共享额度。这里把修好的行为钉死：
 *   ① 无 Key → 不走批量，直接逐条 GET（实测稳定可用）；
 *   ② 404 → 负缓存 not-found（7 天内不再重复问）；
 *   ③ 429 → 指数退避 + 单条重试上限，超过即写负缓存（队列必须能排空，不许死循环）；
 *   ④ 有 Key → 走批量；批量失败（429/400）→ 本会话降级逐条，不回头打批量；
 *   ⑤ 脏 DOI（"待补"之类）不产生任何请求（旧版会把整批打成 400）；
 *   ⑥ 正结果超过 TTL → 后台刷新，但界面保持旧值（不闪成「…」）；
 *   ⑦ 结果到达后要发 Notifier redraw（只有 refreshColumns 时行不重绘）。
 *
 * 运行：node test/citation-column.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const FILE = 'chrome/content/scripts/columns/citation-column.js';

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }

/* ---------------- 桩环境 ---------------- */

const PREFIX = 'extensions.zotero.papilot.';
const PrefStore = new Map();
const Prefs = {
  get: (k, d) => (PrefStore.has(PREFIX + k) ? PrefStore.get(PREFIX + k) : d),
  set: (k, v) => { PrefStore.set(PREFIX + k, v); },
  clear: (k) => { PrefStore.delete(PREFIX + k); },
};

let refreshCalls = 0;
const redraws = [];

const sandbox = {
  console, Prefs,
  Zotero: {
    debug() {}, logError() {},
    ItemTreeManager: { refreshColumns() { refreshCalls++; } },
    Notifier: { trigger(t, type, ids) { redraws.push({ t, type, ids: (ids || []).slice() }); } },
  },
  I18n: { t: (k) => k, isZh: true },
  PathUtils: { join: (...a) => a.join('/') },
  IOUtils: {
    readUTF8: async () => { throw new Error('no file'); },
    writeUTF8: async () => {},
    remove: async () => {},
  },
  setTimeout, clearTimeout, Promise, Date, Math, JSON,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

/* S2Client 桩：可切换「有无 Key」「成功/失败」 */
let apiKey = '';
let batchCalls = 0;
let singleCalls = 0;
let searchCalls = 0;
let batchImpl = async (ids) => ids.map(() => ({ citationCount: 1 }));
let singleImpl = async () => ({ citationCount: 7 });
let searchImpl = async () => [];

const httpErr = (status) => ({ xmlhttp: { status }, message: 'HTTP ' + status });

sandbox.S2Client = {
  _apiKey: () => apiKey,
  batch: async (ids) => { batchCalls++; return batchImpl(ids); },
  paperById: async (id, fields) => { singleCalls++; return singleImpl(id, fields); },
  searchByTitle: async (t) => { searchCalls++; return searchImpl(t); },
};

vm.runInContext(fs.readFileSync(path.join(ROOT, FILE), 'utf8'), sandbox, { filename: FILE });
const CC = sandbox.CitationColumn;

/* 测试提速：真实限速 1.1s/条、退避 4s 起，这里压到毫秒级 */
CC._gap = () => 2;
CC.BACKOFF_BASE = 5;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const mkItem = (id, doi, title) => ({
  id,
  isRegularItem: () => true,
  getField: (f) => (f === 'DOI' ? (doi || '') : f === 'title' ? (title || '') : ''),
});
function resetState() {
  CC._cache = new Map();
  CC._lookupCache = new Map();
  CC._doiQueue = [];
  CC._titleQueue = [];
  CC._queued = new Set();
  CC._pendingRefresh = new Set();
  CC._backoffUntil = 0;
  CC._consecutive429 = 0;
  CC._batchOk = null;
  CC._lastError = '';
  CC._lastOkAt = 0;
  CC._working = false;
  if (CC._refreshTimer) { clearTimeout(CC._refreshTimer); CC._refreshTimer = null; }
  if (CC._saveTimer) { clearTimeout(CC._saveTimer); CC._saveTimer = null; }
  refreshCalls = 0; redraws.length = 0;
  batchCalls = 0; singleCalls = 0; searchCalls = 0;
}

(async () => {
/* ---------------- ① 无 Key：走逐条，不碰批量端点 ---------------- */

resetState();
apiKey = '';
batchImpl = async (ids) => ids.map(() => ({ citationCount: 99 }));
singleImpl = async () => ({ citationCount: 42, influentialCitationCount: 3, venue: 'Nature', year: 2020, title: 'X' });

const it1 = mkItem(1, '10.1038/nature12373', 'X');
eq(CC.lookup(it1), '…', '① 首次 lookup 给「…」占位');
ok(CC._pendingRefresh.has(1), '① 占位条目记入待刷新集合（数据到达后精准 redraw）');
await wait(80);
eq(batchCalls, 0, '① ★ 无 Key 时完全不调批量端点（旧版唯一链路，恒 429）');
eq(singleCalls, 1, '① 改走单条 GET');
eq(CC._cache.get('doi:10.1038/nature12373').c, 42, '① 命中写入缓存');
eq(redraws.length, 0, '① 数据刚入缓存，redraw 由 800ms 合并器统一发（下一段验证）');

await wait(900);
ok(redraws.length >= 1, '① ★ 结果到达后发出了 Notifier redraw（旧版只有 refreshColumns，行不重绘）');
const firstRedraw = redraws[0];
eq(firstRedraw.t, 'redraw', '① redraw 事件名');
eq(firstRedraw.type, 'item', '① redraw 作用于 item');
ok(refreshCalls >= 1, '① 同时走了 refreshColumns 通道（双通道）');
eq(CC.lookup(mkItem(1, '10.1038/nature12373', 'X')), 42, '① 再查命中缓存，直接返回数字');

/* ---------------- ② 404：负缓存 not-found ---------------- */

resetState();
apiKey = '';
singleImpl = async () => { throw httpErr(404); };
const it2 = mkItem(2, '10.9999/nope', 'Nope');
eq(CC.lookup(it2), '…', '② 首次查询占位');
await wait(80);
const neg2 = CC._cache.get('doi:10.9999/nope');
ok(neg2 && neg2.neg === 1 && neg2.reason === 'not-found', '② ★ 404 记为 not-found 负缓存');
ok(neg2.retryAfter - Date.now() > 3600 * 1000, '② 未收录的重试间隔足够长（不是 30 分钟）');

/* ---------------- ③ 429：指数退避 + 上限（队列必须排空） ---------------- */

resetState();
apiKey = '';
CC.MAX_ATTEMPTS = 3;
singleImpl = async () => { throw httpErr(429); };
const t0 = Date.now();
eq(CC.lookup(mkItem(3, '10.1000/rate', 'R')), '…', '③ 首次查询占位');
await wait(400);
eq(CC._doiQueue.length, 0, '③ ★ 队列排空（旧版无上限回队 → 永不收敛的空转环）');
eq(CC._queued.size, 0, '③ 去重集合同步清空');
const neg3 = CC._cache.get('doi:10.1000/rate');
eq(neg3 && neg3.reason === 'rate-limited', true, '③ ★ 超过重试上限 → 负缓存 rate-limited');
ok(CC._consecutive429 >= 1, '③ 连续 429 计数保留到下一次成功（退避不会立刻复位）');
ok(Date.now() - t0 >= 0, '③ 计时基线');

// 退避递增：直接驱动 _handleFetchError，看 _backoffUntil 是否指数增长
resetState();
CC.BACKOFF_BASE = 100;
const e1 = { cacheKey: 'doi:10.1000/a', batchId: 'DOI:10.1000/a', kind: 'doi' };
CC._handleFetchError([e1], httpErr(429));
const b1 = CC._backoffUntil - Date.now();
CC._handleFetchError([e1], httpErr(429));
const b2 = CC._backoffUntil - Date.now();
ok(b1 > 150 && b1 < 350, '③ 第一次 429 退避 ≈ 200ms（100×2¹）', b1);
ok(b2 > 350 && b2 < 700, '③ ★ 第二次 429 退避翻倍（指数退避，不是固定 10s）', b2);
ok(CC._doiQueue.length === 1 && CC._queued.has(e1.cacheKey), '③ 上限内重新入队（等待退避后重试）');
for (let i = 0; i < CC.MAX_ATTEMPTS; i++) CC._handleFetchError([e1], httpErr(429));
ok(CC._cache.get(e1.cacheKey) && CC._cache.get(e1.cacheKey).reason === 'rate-limited',
  '③ ★ 达到 MAX_ATTEMPTS 后落负缓存，不再回队');
CC.BACKOFF_BASE = 5;

/* ---------------- ④ 有 Key：走批量；批量 429 → 降级逐条 ---------------- */

resetState();
apiKey = 'k-123';
batchImpl = async () => { throw httpErr(429); };
singleImpl = async () => ({ citationCount: 55 });
const it4 = mkItem(4, '10.1000/batch', 'B');
eq(CC.lookup(it4), '…', '④ 首次占位');
await wait(120);
eq(batchCalls, 1, '④ 有 Key 时先试批量');
eq(CC._batchOk, false, '④ ★ 批量 429 → 本会话降级标记');
eq(singleCalls, 1, '④ ★ 降级后立即改走逐条');
eq(CC._cache.get('doi:10.1000/batch').c, 55, '④ 逐条结果正常入库');

// 已降级后，新的条目不再打批量
const it5 = mkItem(5, '10.1000/batch2', 'B2');
CC.lookup(it5);
await wait(120);
eq(batchCalls, 1, '④ ★ 降级后不再重试批量端点（省一轮 429）');
eq(singleCalls, 2, '④ 新条目直接走逐条');

// 有 Key 且批量正常：一次批量刷多条
resetState();
apiKey = 'k-123';
batchImpl = async (ids) => ids.map(() => ({ citationCount: 3 }));
CC.lookup(mkItem(6, '10.1000/x1', 'X1'));
CC.lookup(mkItem(7, '10.1000/x2', 'X2'));
await wait(120);
ok(batchCalls >= 1, '④ 批量可用时走批量（队列先到先处理，条目可能分成多批）');
eq(singleCalls, 0, '④ 批量成功则不逐条');
eq(CC._cache.get('doi:10.1000/x1').c, 3, '④ 批量结果入库 x1');
eq(CC._cache.get('doi:10.1000/x2').c, 3, '④ 批量结果入库 x2');

/* ---------------- ⑤ 脏 DOI 不产生请求 ---------------- */

resetState();
apiKey = '';
singleImpl = async () => ({ citationCount: 1 });
CC.lookup(mkItem(8, '待补充', '脏 DOI 条目'));
CC.lookup(mkItem(9, 'doi.org/10.1000/half', '半截链接'));
await wait(60);
eq(singleCalls + batchCalls, 0, '⑤ ★ 非 10.xxxx/yyy 形态的 DOI 不发请求（旧版会让整批 400）');
eq(CC._doiQueue.length, 0, '⑤ 也不进入 DOI 队列');

/* ---------------- ⑥ 正结果过期：后台刷新但界面保持旧值 ---------------- */

resetState();
apiKey = '';
singleImpl = async () => ({ citationCount: 88 });
CC._cache.set('doi:10.1000/old', { c: 12, ic: 0, venue: '', year: 0, t: Date.now() - CC.POS_TTL - 1000 });
const itOld = mkItem(10, '10.1000/old', 'Old');
eq(CC.lookup(itOld), 12, '⑥ 过期正结果仍显示旧值（不闪成「…」）');
await wait(80);
eq(singleCalls, 1, '⑥ ★ 后台静默重查了一次');
eq(CC._cache.get('doi:10.1000/old').c, 88, '⑥ 刷新后缓存更新');
eq(CC._lookupCache.get(10), 12, '⑥ 条目级缓存仍是旧值（由 redraw 触发重取）');
// 再查不会重复入队（t 已打戳）
singleImpl = async () => ({ citationCount: 88 });
CC.lookup(mkItem(10, '10.1000/old', 'Old'));
await wait(40);
eq(singleCalls, 1, '⑥ 同一轮不重复入队（避免每行渲染都发请求）');

/* ---------------- ⑧ 标题兜底：短超时 + 超时冷却 6 小时 ---------------- */

resetState();
apiKey = '';
let titleArgs = null;
searchImpl = async () => { throw new Error('S2 请求应用层超时（8s），可能限流，请稍后重试'); };
sandbox.S2Client.searchByTitle = async (t, limit, fields, timeoutMs) => {
  searchCalls++; titleArgs = [t, limit, fields, timeoutMs];
  return searchImpl(t);
};
const itT = mkItem(12, '', '没有 DOI 的中文标题');
eq(CC.lookup(itT), '…', '⑧ 无 DOI → 走标题兜底（占位）');
await wait(80);
ok(titleArgs && titleArgs[3] === CC.TITLE_TIMEOUT_MS, '⑧ ★ 标题检索传短超时（不再用默认 25s 卡队列）', titleArgs);
const negT = CC._cache.get('title:' + CC.normalizeTitle('没有 DOI 的中文标题'));
ok(negT && negT.neg === 1 && negT.reason === 'timeout', '⑧ ★ 超时记为 timeout（不是笼统的 http-net）');
ok(negT.retryAfter - Date.now() > 5 * 3600 * 1000, '⑧ 超时冷却 6 小时（避免 30 分钟回来再挂一次）');

/* ---------------- ⑦ 状态自检与重置 ---------------- */

resetState();
apiKey = '';
singleImpl = async () => { throw httpErr(429); };
CC.lookup(mkItem(11, '10.1000/st', 'S'));
await wait(300);
let st = CC.s2Status();
ok(st.state === 'rate_limited' || st.state === 'no_key', '⑦ 限流/未配 Key 状态可见', st.state);
eq(st.hasKey, false, '⑦ hasKey=false');
CC.resetRateLimit();
st = CC.s2Status();
eq(st.state === 'rate_limited', false, '⑦ ★ 重置后不再处于退避中');
eq(CC._backoffUntil, 0, '⑦ 退避时间戳清零');

/* ---------------- 输出 ---------------- */

if (CC._refreshTimer) { clearTimeout(CC._refreshTimer); CC._refreshTimer = null; }
if (CC._saveTimer) { clearTimeout(CC._saveTimer); CC._saveTimer = null; }

console.log('='.repeat(60));
if (fails.length) {
  for (const f of fails) console.log('  x ' + f);
  console.log('-'.repeat(60));
}
console.log('被引量列取数链路测试：' + pass + ' 通过 / ' + fails.length + ' 失败');
console.log('='.repeat(60));
process.exit(fails.length ? 1 : 0);
})().catch((e) => {
  console.error('测试执行异常：', e);
  process.exit(1);
});
