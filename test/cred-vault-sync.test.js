#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 完整凭据同步包：显式提取、全量覆盖、合并且不覆盖、敏感值边界。 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const CORE = path.join(ROOT, 'chrome', 'content', 'scripts', 'features', 'cred-vault.js');

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return; }
  fails.push(label + (extra === undefined ? '' : ' ← ' + JSON.stringify(extra)));
}
function eq(a, b, label) { ok(a === b, label, { got: a, want: b }); }

function makeSandbox(o) {
  o = o || {};
  const store = Object.assign({}, o.prefs || {});
  const Prefs = { get(k, d) { return store[k] === undefined ? d : store[k]; }, set(k, v) { store[k] = v; } };
  const secrets = o.secrets || {};
  const Account = {
    isLoggedIn: () => o.loggedIn !== false,
    isPro: () => true,
    membership: () => ({ plan: 'Pro', name: '专业版', expiresAt: 0 }),
    async saveHostedSecret(name, value) { secrets[name] = String(value); return {}; },
    async revealHostedSecret(name) { return secrets[name] || ''; },
    async hostedSecrets() { return {}; },
  };
  const channelsDoc = JSON.parse(JSON.stringify(o.channels || { channels: [], active: null }));
  const Channels = {
    OFFICIAL_ID: 'official',
    _load: () => JSON.parse(JSON.stringify(channelsDoc)),
    _save(doc) { channelsDoc.channels = doc.channels; channelsDoc.active = doc.active; store.aiChannels = JSON.stringify(doc); },
    _providerNoKey: (provider, baseUrl) => provider === 'ollama' || /127\.0\.0\.1|localhost/.test(String(baseUrl || '')),
  };
  const Zotero = { locale: 'zh-CN', getMainWindow: () => ({ crypto: require('crypto').webcrypto }), debug() {}, logError() {} };
  const sandbox = { console, Prefs, Account, Channels, Zotero, btoa, atob, TextEncoder, TextDecoder,
    crypto: require('crypto').webcrypto, setTimeout, clearTimeout };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(CORE, 'utf8'), sandbox, { filename: 'cred-vault.js' });
  return { V: sandbox.CredVault, store, secrets, channelsDoc };
}

const source = makeSandbox({
  prefs: {
    cnkiUsername: 'cnki-user', cnkiPassword: btoa(unescape(encodeURIComponent('cnki-pass'))),
    cloudSyncEmail: 'nut@example.com', cloudSyncToken: 'nut-token', easyScholarKey: 'es-key',
    thirdSourceSite: 'site-a', thirdSourceUsername: 'third-user', thirdSourcePassword: btoa('third-pass'),
    s2ApiKey: 's2-key', mcpToken: 'mcp-token', openAlexApiKey: 'oa-key', unpaywallEmail: 'oa@example.com',
    aiApiKey: 'legacy-key',
    translateCfg: JSON.stringify({ active: 'youdao', secrets: { youdao: 'app#secret', deepl: 'deep-key' } }),
    vaultPassHash: 'do-not-sync-passcode', accountToken: 'do-not-sync-account-token',
  },
  channels: {
    active: 'work',
    channels: [
      { id: 'official', baseUrl: '', apiKey: '', model: 'auto' },
      { id: 'work', name: '工作通道', provider: 'openai', baseUrl: 'https://ai.example/v1', apiKey: 'work-key',
        model: 'model-x', models: ['model-x', 'model-y'], extraBody: { temperature: 0.2 }, timeoutMs: 15000 },
      { id: 'local', name: '本地', provider: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', apiKey: '', model: 'qwen' },
    ],
  },
});
const built = source.V.buildSyncPayload();
eq(built.counts.fields, 13, 'B1 收集 12 个静态配置 + 旧版 AI Key');
eq(built.counts.translate, 2, 'B2 收集全部翻译引擎 secrets');
eq(built.counts.channels, 2, 'B3 收集自定义通道且排除官方通道');
eq(built.payload.prefs['openalex.key'], 'oa-key', 'B4 OpenAlex 纳入同步包');
eq(built.payload.prefs['unpaywall.email'], 'oa@example.com', 'B5 Unpaywall 邮箱纳入同步包');
eq(built.payload.prefs['third.site'], 'site-a', 'B6 第三方站点配置纳入同步包');
eq(built.payload.aiChannels[0].baseUrl, 'https://ai.example/v1', 'B7 AI 同步包含接口地址');
eq(built.payload.aiChannels[0].extraBody.temperature, 0.2, 'B8 AI 同步包含 extraBody');
eq(built.payload.aiActive, 'work', 'B9 记录活动自定义通道');
const serialized = JSON.stringify(built.payload);
ok(!serialized.includes('do-not-sync'), 'B10 不同步访问口令/Papilot 会话');
const uiSource = fs.readFileSync(path.join(ROOT, 'chrome', 'content', 'vault.js'), 'utf8');
const bootSource = uiSource.slice(uiSource.indexOf('async function boot'));
ok(!bootSource.includes('V.uploadSyncBundle(') && !bootSource.includes('V.downloadSyncBundle('),
  'B11 启动路径不自动上传或恢复');
const syncUpSource = uiSource.slice(uiSource.indexOf('async function syncUp'), uiSource.indexOf('async function syncDown'));
ok(syncUpSource.indexOf('confirmDlg(') < syncUpSource.indexOf('V.uploadSyncBundle('),
  'B12 上传调用严格位于用户确认之后');

(async () => {
  const notLogged = makeSandbox({ loggedIn: false, prefs: { easyScholarKey: 'x' } });
  const denied = await notLogged.V.uploadSyncBundle();
  ok(!denied.ok && Object.keys(notLogged.secrets).length === 0, 'U1 未登录不能上传同步包');

  const uploaded = await source.V.uploadSyncBundle();
  ok(uploaded.ok && uploaded.counts.total === 17, 'U2 显式上传完整同步包');
  ok(!!source.secrets.credential_bundle, 'U3 使用 credential_bundle 托管名');
  ok(!source.secrets.credential_bundle.includes('do-not-sync'), 'U4 上传正文不含 Papilot 会话/口令');

  const target = makeSandbox({
    secrets: source.secrets,
    prefs: {
      easyScholarKey: 'keep-es', translateCfg: JSON.stringify({ secrets: { deepl: 'keep-deep' } }),
    },
    channels: { active: null, channels: [
      { id: 'work', name: '本机名称', provider: 'openai', baseUrl: 'https://keep.example/v1', apiKey: '', model: 'keep-model' },
    ] },
  });
  const restored = await target.V.downloadSyncBundle({ overwrite: false });
  ok(restored.ok, 'R1 同步恢复成功', restored.errors);
  eq(target.store.easyScholarKey, 'keep-es', 'R2 本机已有静态凭据不覆盖');
  eq(target.store.cloudSyncToken, 'nut-token', 'R3 空缺静态凭据被补齐');
  eq(target.store.openAlexApiKey, 'oa-key', 'R4 新覆盖的 OpenAlex 可恢复');
  eq(target.store.aiApiKey, 'legacy-key', 'R5 旧版 AI Key 可恢复');
  const tr = JSON.parse(target.store.translateCfg);
  eq(tr.secrets.deepl, 'keep-deep', 'R6 本机已有翻译 Key 不覆盖');
  eq(tr.secrets.youdao, 'app#secret', 'R7 空缺翻译密钥被补齐');
  eq(tr.active, undefined, 'R8 不同步翻译其他设置，仅恢复 secrets');
  eq(target.channelsDoc.channels.length, 2, 'R9 缺失 AI 通道被新增，现有通道保留');
  const work = target.channelsDoc.channels.find((c) => c.id === 'work');
  eq(work.baseUrl, 'https://keep.example/v1', 'R10 已有通道地址不被覆盖');
  eq(work.model, 'keep-model', 'R11 已有通道模型不被覆盖');
  eq(work.apiKey, 'work-key', 'R12 已有通道只补空缺 Key');
  eq(target.channelsDoc.active, 'work', 'R13 本机无活动通道时恢复同步包活动通道');
  const journal = target.store.vaultAudit || '';
  ok(!journal.includes('work-key') && !journal.includes('nut-token'), 'R14 审计不含任何凭据明文');

  const empty = makeSandbox({ prefs: { easyScholarKey: 'keep-es' }, secrets: source.secrets });
  const again = await empty.V.downloadSyncBundle();
  ok(again.ok && again.applied > 0 && again.skipped >= 1, 'R15 另一台仅部分配置的机器仍只补空缺');
  eq(empty.store.easyScholarKey, 'keep-es', 'R16 再次验证已有值不覆盖');

  const bad = target.V.applySyncPayload({ v: 999, prefs: { 'rank.key': 'bad' } });
  ok(!bad.ok && target.store.easyScholarKey === 'keep-es', 'X1 不支持版本拒绝且不写本机');
  const malformed = target.V.applySyncPayload({ v: 1, prefs: {}, translateSecrets: {}, aiChannels: [
    { id: 'official', baseUrl: 'https://evil.example', apiKey: 'evil' },
    { id: 'bad id', baseUrl: 'https://evil.example', apiKey: 'evil' },
  ] });
  ok(!malformed.ok && !JSON.stringify(target.channelsDoc).includes('evil'), 'X2 官方/非法通道不注入');

  const failedUpload = makeSandbox({ prefs: {} });
  const none = await failedUpload.V.uploadSyncBundle();
  ok(!none.ok && Object.keys(failedUpload.secrets).length === 0, 'X3 空本机不上传空同步包');

  if (fails.length) {
    console.error('cred-vault-sync: ' + pass + ' 过 / ' + fails.length + ' 败');
    for (const f of fails) console.error('  ✗ ' + f);
    process.exit(1);
  }
  console.log('cred-vault-sync: ' + pass + ' 过 / 0 败');
})().catch((e) => { console.error(e); process.exit(1); });
