#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* WPS 运行环境「清单 × 产物」一致性（0.87.0）
 *
 * 为什么要有它：插件端下载完要按清单里的 sha256 校验，而清单随 xpi 分发、zip 由
 * scripts/build-python-runtime.py 生成并部署到服务端。**两边任何一边单独更新**，
 * 用户端就会「下载成功但校验失败」，而且要等到外机装的时候才发现。
 *
 * 这里把三件事钉在门禁里：
 *   ① 清单结构合法（https 地址 / 64 位 hex sha256 / entries 含 pythonw.exe）；
 *   ② 桥接读的路径与文件名 = 磁盘上真实存在的那份（改名字必须两处一起改）；
 *   ③ 若构建机上有产物（server/public/dl/*.zip，受 gitignore 不入库），
 *      sha256 / 字节数 / 条目集合必须与清单**逐字一致**；没有产物则只做结构校验并明说跳过。
 *
 * 运行：node test/wps-runtime-manifest.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const MANIFEST = path.join(ROOT, 'chrome', 'content', 'tools', 'py-runtime.json');
const BRIDGE = path.join(ROOT, 'chrome', 'content', 'scripts', 'features', 'wps-bridge.js');

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : ''));
  return false;
}

const man = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const bridgeSrc = fs.readFileSync(BRIDGE, 'utf8');

// ① 结构
ok(man.schema === 1, '清单 schema 为 1', man.schema);
ok(/^\d+\.\d+\.\d+$/.test(String(man.pythonVersion || '')), 'pythonVersion 是 x.y.z', man.pythonVersion);
ok(Array.isArray(man.urls) && man.urls.length > 0, 'urls 非空', man.urls);
ok((man.urls || []).every((u) => /^https:\/\//.test(u)), '★ 下载地址必须是 https（明文通道会被中间人改写）', man.urls);
ok(/^[0-9a-f]{64}$/.test(String(man.sha256 || '')), 'sha256 是 64 位小写 hex', man.sha256);
ok(Number(man.bytes) > 1024 * 1024, '字节数合理（大于 1MB）', man.bytes);
ok(man.unpackDir === 'python', 'unpackDir 固定为 python（= 桥接 _whichPythonw 的第一优先级目录）', man.unpackDir);
ok(Array.isArray(man.entries) && man.entries.length > 0, 'entries 非空', man.entries);
ok((man.entries || []).indexOf('pythonw.exe') >= 0, '★ entries 含 pythonw.exe（桥接就是靠它判断装没装）');
ok((man.entries || []).indexOf('python.exe') >= 0, 'entries 含 python.exe（看门狗/install.py 会用）');
ok((man.entries || []).indexOf('python312.dll') >= 0, 'entries 含解释器主体 python312.dll');
ok((man.entries || []).indexOf('python312.zip') >= 0, 'entries 含标准库 python312.zip');
ok((man.entries || []).every((n) => !n.startsWith('/') && !n.includes('..') && !/^[a-zA-Z]:/.test(n)),
  'entries 里没有绝对路径/穿越路径', man.entries.filter((n) => n.startsWith('/') || n.includes('..')));

// ② 桥接与清单对齐
ok(bridgeSrc.includes('chrome/content/tools/py-runtime.json'),
  '★ 桥接读的清单路径与磁盘一致（chrome/content/tools/py-runtime.json）');
ok(bridgeSrc.includes('RUNTIME_MANIFEST_REL'), '桥接通过常量读取清单，没散落硬编码');
ok(bridgeSrc.includes('"python"') && bridgeSrc.includes('runtimeHome()'),
  '桥接把运行环境落在 PapilotCite\\python');

// ③ 有产物就逐字比对
const dlDir = path.join(ROOT, 'server', 'public', 'dl');
const zipPath = path.join(dlDir, man.downloadName || 'papilot-python-embed-win64.zip');
if (fs.existsSync(zipPath)) {
  const buf = fs.readFileSync(zipPath);
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  ok(sha === man.sha256, '★ 产物 sha256 与清单一致（不一致 = 外机下载后必然校验失败）',
    { 清单: man.sha256, 产物: sha });
  ok(buf.length === Number(man.bytes), '产物字节数与清单一致', { 清单: man.bytes, 产物: buf.length });

  // zip 中央目录里能读到的条目名（不依赖第三方库：按签名扫 End of Central Directory）
  const names = [];
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd >= 0) {
    const count = buf.readUInt16LE(eocd + 10);
    let off = buf.readUInt32LE(eocd + 16);
    for (let i = 0; i < count; i++) {
      if (buf.readUInt32LE(off) !== 0x02014b50) break;
      const nameLen = buf.readUInt16LE(off + 28);
      const extraLen = buf.readUInt16LE(off + 30);
      const cmtLen = buf.readUInt16LE(off + 32);
      names.push(buf.toString('utf8', off + 46, off + 46 + nameLen));
      off += 46 + nameLen + extraLen + cmtLen;
    }
  }
  const entrySet = new Set(names.filter((n) => !n.endsWith('/')));
  const manSet = new Set(man.entries);
  const missing = [...manSet].filter((n) => !entrySet.has(n));
  const extra = [...entrySet].filter((n) => !manSet.has(n));
  ok(names.length > 0, '从产物里读到了 zip 条目（中央目录解析成功）', names.slice(0, 3));
  ok(missing.length === 0, '★ 清单里每个条目在产物中都存在（少一个就装不起来）', missing);
  ok(extra.length === 0, '产物里没有清单外的条目（多出来的不会被解压，属于清单过期）', extra);
  console.log(`（已比对产物 ${path.basename(zipPath)}，${(buf.length / 1048576).toFixed(2)} MB / ${name0(names)})`);
} else {
  console.log('（未发现 server/public/dl 下的运行时产物 —— 只做了结构校验；'
    + '构建机请先跑 python scripts/build-python-runtime.py）');
}

function name0(names) { return (names.filter((n) => !n.endsWith('/')).length) + ' 个文件'; }

console.log(`WPS 运行环境清单：${pass} 项断言通过`);
if (fails.length) {
  console.log('\n失败：');
  fails.forEach((f) => console.log(' - ' + f));
  process.exit(1);
}
