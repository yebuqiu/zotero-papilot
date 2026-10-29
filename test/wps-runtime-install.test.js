#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* WPS 集成「运行环境」安装桥测试（0.87.0）
 *
 * 背景：代理是 .py，用户机器不一定有 Python。0.87.0 起改成「按需下载便携运行时 →
 * 落到 %APPDATA%\PapilotCite\python\」（这正是 _whichPythonw 的第一优先级）。
 *
 * 这段代码要**下载 6MB 二进制并解压到用户磁盘**，是本功能里第二处有破坏性的部分，
 * 而且解压路径直接来自远端 zip —— 必须在单测里把边界钉死：
 *   ① 正常路径：清单里的条目全部落盘、写 python-runtime.json、返回 ok；
 *   ② ★ 路径穿越：`../` / 绝对路径 / 盘符 一律丢弃且不落盘（与载荷安装同一套 _safeRel）；
 *   ③ ★ sha256 不符 → 拒绝安装、不写任何文件（防中间层改写）；
 *   ④ 解压后没有 pythonw.exe → 失败（不能"装了个空壳"还报成功）；
 *   ⑤ 清单缺失（瘦身包）→ 失败但文案指向组件商店，不是"未知错误"；
 *   ⑥ 下载全失败 → 失败文案给出离线搬运方案，而不是让用户干瞪眼；
 *   ⑦ 已装且版本一致 → already:true，不重复下载；
 *   ⑧ startProxy 无解释器时返回 needRuntime:true（面板据此显示安装按钮）。
 *
 * 运行：node test/wps-runtime-install.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const BRIDGE = path.join(ROOT, 'chrome', 'content', 'scripts', 'features', 'wps-bridge.js');

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : ''));
  return false;
}

const APPDATA = 'C:\\Users\\x\\AppData\\Roaming';
const HOME = APPDATA + '\\PapilotCite';
const RUNTIME = HOME + '\\python';

const SHA = 'a'.repeat(64);

const MANIFEST = {
  schema: 1,
  id: 'py312-win64-embed',
  pythonVersion: '3.12.10',
  downloadName: 'papilot-python-embed-win64.zip',
  urls: ['https://pp.example/dl/papilot-python-embed-win64.zip'],
  bytes: 4096,
  sha256: SHA,
  unpackDir: 'python',
  entries: ['python.exe', 'pythonw.exe', 'python312.dll', 'python312.zip', 'python312._pth'],
};

function u8(n, fill) {
  const a = new Uint8Array(n);
  if (fill !== undefined) a.fill(fill);
  return a;
}

/**
 * 造一个世界：内存文件系统 + 假 zip reader（条目由 entries 提供）+ 假 fetch。
 * opts.entries 覆盖清单条目内容；opts.digest 覆盖 sha256 结果；opts.fetchFail 造下载失败。
 */
function makeWorld(opts) {
  opts = opts || {};
  const files = Object.create(null);
  const removed = [];
  const fetchUrls = [];
  const psCalls = [];
  const manifest = opts.manifest !== undefined ? opts.manifest : MANIFEST;
  const entries = opts.entries || {
    'python.exe': u8(4, 1), 'pythonw.exe': u8(8, 2), 'python312.dll': u8(16, 3),
    'python312.zip': u8(32, 4), 'python312._pth': u8(2, 5),
  };

  let current = null;
  const seq = (opts.digestSequence || []).slice();

  const PathUtils = {
    join: (...xs) => xs.filter(Boolean).join('\\').replace(/\\+/g, '\\'),
    filename: (p) => String(p).split('\\').pop().split('/').pop(),
    parent: (p) => String(p).replace(/\\[^\\]+$/, ''),
    tempDir: 'C:\\Temp',
  };

  const IOUtils = {
    async exists(p) { return p in files; },
    async read(p) { return files[p]; },
    async readUTF8(p) { return typeof files[p] === 'string' ? files[p] : ''; },
    async write(p, data) { files[p] = data; },
    async writeUTF8(p, s) { files[p] = s; },
    async makeDirectory() {},
    async remove(p) {
      removed.push(p);
      for (const k of Object.keys(files)) {
        if (k === p || k.startsWith(p + '\\') || k.startsWith(p + '/')) delete files[k];
      }
    },
    async getChildren() { return []; },
  };

  const sandbox = {
    console,
    PathUtils,
    IOUtils,
    setTimeout,
    clearTimeout,
    Services: { dirsvc: { get: () => ({ path: APPDATA }) } },
    Ci: {
      nsIFile: function () {}, nsIProcess: function () {}, nsIEnvironment: function () {},
      nsIZipReader: function () {}, nsIBinaryInputStream: function () {},
    },
    Cc: {
      '@mozilla.org/file/local;1': { createInstance: () => ({ initWithPath(p) { this.path = p; } }) },
      '@mozilla.org/libjar/zip-reader;1': {
        createInstance: () => {
          if (opts.zipReaderFails) throw new Error('NS_ERROR_UNEXPECTED');
          return {
            _path: null,
            open(file) { this._path = file && file.path ? file.path : file; },
            hasEntry(n) { return n in entries; },
            getInputStream(n) { current = n; return { close() {} }; },
            close() { this._closed = true; },
          };
        },
      },
      '@mozilla.org/binaryinputstream;1': {
        createInstance: () => ({
          setInputStream() {},
          available() { return (entries[current] || u8(0)).length; },
          readByteArray() { return entries[current] || u8(0); },
        }),
      },
      '@mozilla.org/process/util;1': {
        createInstance: () => ({
          init() {},
          runw(blocking, args) {
            psCalls.push(args);
            // 模拟真实的 Expand-Archive：把 -DestinationPath 指到的目录填上条目的文件
            const m = /-DestinationPath '((?:[^']|'')*)'/.exec(args.join(' '));
            if (m && /Expand-Archive/.test(args.join(' '))) {
              const dst = m[1].replace(/''/g, "'");
              for (const name of Object.keys(entries)) files[dst + '\\' + name.replace(/\//g, '\\')] = entries[name];
            }
            this.exitValue = 0;
          },
          exitValue: 0,
        }),
      },
      '@mozilla.org/process/environment;1': { getService: () => ({ get: () => '' }) },
    },
    fetch: async (url) => {
      fetchUrls.push(url);
      if (String(url).indexOf('py-runtime.json') >= 0) {
        if (!manifest) return { ok: false, status: 404, text: async () => '' };
        return { ok: true, status: 200, text: async () => JSON.stringify(manifest) };
      }
      if (opts.fetchFail) throw new Error('NS_ERROR_UNKNOWN_HOST');
      return {
        ok: true, status: 200,
        arrayBuffer: async () => new Uint8Array(opts.zipBytes || u8(64, 9)).buffer,
      };
    },
    crypto: opts.noCrypto ? undefined : {
      subtle: {
        digest: async () => {
          // 多源场景：按顺序给不同摘要（第一个源"内容不对"）
          if (seq.length) return seq.shift();
          if (opts.digestBytes) return opts.digestBytes;
          // 默认：返回与清单一致的"摘要"（由 hex 还原成 32 字节）
          const out = new Uint8Array(32);
          for (let i = 0; i < 32; i++) out[i] = parseInt(SHA.slice(i * 2, i * 2 + 2), 16);
          return out;
        },
      },
    },
    Zotero: { Promise: { delay: async () => {} }, HTTP: { request: async () => { throw new Error('offline'); } } },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(BRIDGE, 'utf8'), sandbox, { filename: 'wps-bridge.js' });
  const B = sandbox.WpsBridge;
  B.init({ rootURI: 'jar:file:///C:/x/papilot.xpi!/' });
  return { B, files, removed, fetchUrls, entries, psCalls };
}

(async () => {
  // ① 正常路径
  {
    const w = makeWorld();
    const r = await w.B.installRuntime();
    ok(r.ok === true, '正常路径装好了', r);
    ok(r.version === '3.12.10', '返回 Python 版本', r.version);
    ok(r.shaChecked === true, 'sha256 校验过（crypto 可用时不允许静默跳过）', r);
    for (const name of MANIFEST.entries) {
      ok(RUNTIME + '\\' + name in w.files, '落盘 ' + name);
    }
    ok(RUNTIME + '\\pythonw.exe' in w.files, '★ 关键文件 pythonw.exe 存在');
    const meta = JSON.parse(w.files[HOME + '\\python-runtime.json'] || '{}');
    ok(meta.pythonVersion === '3.12.10' && meta.sha256 === SHA, '写运行环境元数据', meta);
    ok(w.removed.some((p) => /papilot-py-\d+\.zip$/.test(p)), '临时 zip 用完清理');
    ok(w.fetchUrls.some((u) => u.indexOf('v=' + SHA.slice(0, 12)) >= 0), '下载带版本参数破缓存', w.fetchUrls);
  }

  // ② 路径穿越
  {
    const evil = Object.assign({}, MANIFEST, {
      entries: ['pythonw.exe', '../evil.dll', '/abs/evil.dll', 'C:/evil.dll', '..\\evil2.dll'],
    });
    const w = makeWorld({ manifest: evil });
    const r = await w.B.installRuntime();
    ok(r.ok === true, '含非法条目时仍装成合法部分', r);
    ok(RUNTIME + '\\pythonw.exe' in w.files, '合法条目照常落盘');
    const leaked = Object.keys(w.files).filter((p) => /evil/i.test(p));
    ok(leaked.length === 0, '★ ../、绝对路径、盘符条目全部丢弃（一个都没落盘）', leaked);
    ok(Array.isArray(r.skipped) && r.skipped.length === 4, '被丢弃的条目数报给调用方', r.skipped);
  }

  // ③ sha256 不符 → 拒绝
  {
    const w = makeWorld({ digestBytes: new Uint8Array(32).fill(0) });
    const r = await w.B.installRuntime();
    ok(r.ok === false, 'sha256 不符必须失败', r);
    ok(/sha256 不符|校验/.test(r.error || ''), '错误文案点明校验不通过', r.error);
    ok(!Object.keys(w.files).some((p) => p.indexOf('\\python\\') >= 0), '★ 校验失败不落任何运行时文件');
    ok(!(HOME + '\\python-runtime.json' in w.files), '校验失败不写元数据');
  }

  // ③b 多源：第一个源内容不对（镜像返回错误页）→ 自动换下一个源，不许直接判死
  {
    const man = Object.assign({}, MANIFEST, {
      urls: ['https://bad.example/dl/x.zip', 'https://pp.example/dl/papilot-python-embed-win64.zip'],
    });
    const w = makeWorld({ manifest: man, digestSequence: [new Uint8Array(32).fill(7)] });
    const r = await w.B.installRuntime();
    ok(r.ok === true, '★ 第一个源校验不符时换源成功（多源才有意义）', r);
    ok(String(r.url || '').indexOf('pp.example') >= 0, '最终用的是第二个源', r.url);
    ok(w.fetchUrls.filter((u) => /dl\/x\.zip/.test(u)).length >= 1, '确实先试过第一个源');
  }

  // ④ 解压后没有 pythonw.exe
  {
    const man = Object.assign({}, MANIFEST, { entries: ['python.exe', 'python312.dll'] });
    const w = makeWorld({ manifest: man, entries: { 'python.exe': u8(4), 'python312.dll': u8(8) } });
    const r = await w.B.installRuntime();
    ok(r.ok === false, '缺 pythonw.exe 视为失败', r);
    ok(/pythonw\.exe/.test(r.error || ''), '错误文案提到缺 pythonw.exe', r.error);
    ok(!(HOME + '\\python-runtime.json' in w.files), '不写元数据（避免下次误判已装）');
  }

  // ⑤ 瘦身包：清单缺失
  {
    const w = makeWorld({ manifest: null });
    const r = await w.B.installRuntime();
    ok(r.ok === false, '读不到清单就失败', r);
    ok(/组件/.test(r.error || ''), '文案指向组件商店而不是"未知错误"', r.error);
    ok(w.fetchUrls.length === 1, '清单读不到时不去下载');
  }

  // ⑥ 下载全失败
  {
    const w = makeWorld({ fetchFail: true });
    const r = await w.B.installRuntime();
    ok(r.ok === false, '断网时失败', r);
    ok(/拷过来/.test(r.error || ''), '文案给离线搬运方案', r.error);
    ok(Array.isArray(r.tried) && r.tried.length === 1, '列出尝试过的地址', r.tried);
  }

  // ⑦ 已装且一致 → already
  {
    const w = makeWorld();
    await w.B.installRuntime();
    const before = w.fetchUrls.length;
    const r2 = await w.B.installRuntime();
    ok(r2.ok === true && r2.already === true, '第二次不重复下载', r2);
    ok(w.fetchUrls.length === before, '已装时不再请求 zip', w.fetchUrls.slice(before));
  }

  // ⑦b crypto 不可用 → 降级但不冒充校验
  {
    const w = makeWorld({ noCrypto: true });
    const r = await w.B.installRuntime();
    ok(r.ok === true, 'crypto 不可用时仍能装', r);
    ok(r.shaChecked === false, '明确标记未校验（不谎称校验过）', r.shaChecked);
  }

  // ⑦c zip reader 不可用 → 退到 Expand-Archive（两条路任一能用，用户就能装上）
  {
    const w = makeWorld({ zipReaderFails: true });
    const r = await w.B.installRuntime();
    ok(r.ok === true, '★ zip reader 抛错时回退 Expand-Archive 仍装成功', r);
    ok(r.via === 'expand-archive', '回退路径被标明（排障要知道走的是哪条）', r.via);
    ok(w.psCalls.length === 1, 'PowerShell 只调一次');
    ok(/-ExecutionPolicy Bypass/.test((w.psCalls[0] || []).join(' ')), '带了执行策略豁免（否则会被本机策略拦住）');
    ok(RUNTIME + '\\pythonw.exe' in w.files, '回退路径同样落出 pythonw.exe');
  }

  // ⑧ startProxy 无解释器 → needRuntime
  {
    const w = makeWorld();
    const r = await w.B.startProxy();
    ok(r.started === false && r.needRuntime === true, '★ 无 Python 时返回 needRuntime', r);
    ok(/安装运行环境/.test(r.error || ''), '文案指向设置面板按钮', r.error);
  }

  // ⑧b runtimeStatus 契约
  {
    const w = makeWorld();
    const s0 = await w.B.runtimeStatus();
    ok(s0.present === false && s0.exe === RUNTIME + '\\pythonw.exe', '未装时 present=false 且给出路径', s0);
    ok(s0.manifest && s0.manifest.pythonVersion === '3.12.10', '带出随包清单版本');
    await w.B.installRuntime();
    const s1 = await w.B.runtimeStatus();
    ok(s1.present === true && s1.version === '3.12.10', '装完 present=true 且版本正确', s1);
    ok(s1.outdated === false, 'sha 一致时不算过期');
  }

  console.log(`WPS 运行环境安装桥：${pass} 项断言全部通过`);
  if (fails.length) {
    console.log('\n失败：');
    fails.forEach((f) => console.log(' - ' + f));
    process.exit(1);
  }
})();
