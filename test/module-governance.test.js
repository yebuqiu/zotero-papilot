#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 组件投稿、打包、目录、签名与发布不可变性离线回归测试。
 * 不访问网络、不读取私钥；Python 临时目录与 Node 内存桩隔离全部写入。
 * 运行：node test/module-governance.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PYTHON = process.env.PP_PYTHON || 'python';
let pass = 0;
const fails = [];

function ok(cond, label, extra) {
  if (cond) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  <- ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(actual, expected, label) {
  return ok(require('util').isDeepStrictEqual(actual, expected), label, { got: actual, want: expected });
}
function pyValue(value) { return 'json.loads(' + JSON.stringify(JSON.stringify(value)) + ')'; }
function has(haystack, needle, label) {
  return ok(String(haystack).includes(needle), label, String(haystack));
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }

function loadPython(scriptName) {
  return [
    'import importlib.util, json, sys',
    'from pathlib import Path',
    'spec = importlib.util.spec_from_file_location("subject", ' + JSON.stringify(path.join(ROOT, 'scripts', scriptName)) + ')',
    'subject = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(subject)',
  ].join('\n') + '\n';
}

function python(script, label) {
  const result = spawnSync(PYTHON, ['-c', script], {
    cwd: ROOT, encoding: 'utf8', timeout: 30000,
    env: Object.assign({}, process.env, { PYTHONDONTWRITEBYTECODE: '1' }),
  });
  if (result.error || result.status !== 0) {
    throw new Error((label || 'Python 夹具') + ' 执行失败: ' +
      JSON.stringify({ status: result.status, error: String(result.error || ''), stdout: result.stdout, stderr: result.stderr }));
  }
  const lines = String(result.stdout).trim().split(/\r?\n/);
  return JSON.parse(lines[lines.length - 1]);
}

const GOV = loadPython('module-governance.py');
const BUILD = GOV + loadPython('build-module.py');
const PUBLISH = GOV + loadPython('publish-modules.py');
const UPLOAD = loadPython('upload-module-assets.py');
const PATROL = loadPython('patrol-modules.py');

function gov(expression, label) { return python(GOV + 'print(json.dumps(' + expression + '))', label); }
function errorsWithCode(errors, code) { return errors.some(e => e.code === code); }
function codes(expression, label) { return gov('[e["code"] for e in ' + expression + ']', label); }

function baseManifest() {
  const body = 'export function register() {}\n';
  return {
    id: 'papilot-mod-community-demo', name: 'Community demo', version: '1.2', minHost: '0.70.0',
    apiVersion: 1, mode: 'sandbox', entry: 'main.js', requires: ['storage'],
    permissions: ['network'], depends: [], author: 'Example Author', license: 'MIT',
    origin: 'community', sourceRevision: '0123456789abcdef',
    files: [{ path: 'main.js', sha256: crypto.createHash('sha256').update(body).digest('hex'), size: Buffer.byteLength(body) }],
  };
}

function manifestExpression(overrides) {
  const manifest = baseManifest();
  Object.assign(manifest, overrides || {});
  return 'subject.validate_manifest(' + pyValue(manifest) + ', new_component=True)';
}

function testVersionsAndManifests() {
  eq(gov('subject.compare_version("2.0", "1.9.9")'), 1, '版本比较：升版按数字段判定');
  eq(gov('subject.compare_version("1.0", "1.0.0")'), 0, '版本比较：短版本补零后同版');
  eq(gov('subject.compare_version("0.9", "1.0")'), -1, '版本比较：降版按数字段判定');
  eq(gov('[subject.is_valid_version(v) for v in ["1", "1.2", "1.2.3", "1.2.3.4"]]'), [true, true, true, true], '版本格式：合法旧版 1–4 段数字点分均接受');
  eq(gov('[subject.is_valid_version(v) for v in ["1.0-beta", "", "1.2.3.4.5", "v1.0"]]'), [false, false, false, false], '版本格式：prerelease、空值与超段数拒绝');

  eq(gov('subject.validate_manifest(subject.json.loads(Path(' + JSON.stringify(path.join(ROOT, 'modules', 'papilot-mod-pdf', 'module.json')) + ').read_text(encoding="utf-8")))'), [], '合法旧版：现有官方 scope 清单保持兼容');
  eq(gov('subject.validate_map(subject.json.loads(Path(' + JSON.stringify(path.join(ROOT, 'scripts', 'module-map.json')) + ').read_text(encoding="utf-8")))'), [], '现有官方默认：真实 module-map 离线校验通过');
  eq(gov(manifestExpression()), [], '新社区组件：显式 sandbox、身份与独立数字版本可接受');
  eq(gov(manifestExpression({ mode: 'scope' })).some(e => e.code === 'GOV-SANDBOX'), true, '新社区组件：scope 例外不可扩展');
  eq(gov(manifestExpression({ id: 'Bad_ID' })).some(e => e.code === 'GOV-ID'), true, '非法 id：大写与下划线硬失败');
  eq(gov(manifestExpression({ version: '1.0-beta' })).some(e => e.code === 'GOV-VERSION'), true, '非法 version：prerelease 硬失败');
  eq(gov(manifestExpression({ files: [{ path: 'main.js', sha256: 'abc', size: 1 }] })).some(e => e.code === 'GOV-HASH'), true, '非法 hash：非 64 位十六进制硬失败');
  eq(gov(manifestExpression({ files: [{ path: 'main.js', sha256: 'a'.repeat(64), size: -1 }] })).some(e => e.code === 'GOV-SIZE'), true, '非法 size：负数硬失败');
  eq(gov(manifestExpression({ files: [{ path: 'main.js', sha256: 'a'.repeat(64), size: true }] })).some(e => e.code === 'GOV-SIZE'), true, '非法 size：布尔值不冒充整数');
  eq(gov(manifestExpression({ entry: '' })).some(e => e.code === 'GOV-ENTRY'), true, '非法 entry：sandbox 缺入口硬失败');
  eq(gov(manifestExpression({ entry: 'other.js' })).some(e => e.code === 'GOV-ENTRY'), true, '非法 entry：入口不在 files 内硬失败');
  for (const badPath of ['../escape.js', '/absolute.js', 'C:/absolute.js', 'dir\\evil.js', './main.js']) {
    eq(gov(manifestExpression({ files: [{ path: badPath, sha256: 'a'.repeat(64), size: 0 }] })).some(e => e.code === 'GOV-PATH'), true,
      '非法路径：拒绝 ' + badPath);
  }
  const duplicateFiles = [
    { path: 'main.js', sha256: 'a'.repeat(64), size: 0 },
    { path: 'main.js', sha256: 'b'.repeat(64), size: 0 },
  ];
  eq(gov(manifestExpression({ files: duplicateFiles })).some(e => e.code === 'GOV-DUPLICATE'), true, 'manifest：重复文件路径硬失败');
  eq(gov(manifestExpression({ permissions: ['shell'] })).some(e => e.code === 'GOV-VOCAB'), true, '未知权限：不在白名单硬失败');
  eq(gov(manifestExpression({ permissions: ['network', 'network'] })).some(e => e.code === 'GOV-DUPLICATE'), true, '权限：重复声明硬失败');
  eq(gov(manifestExpression({ requires: ['ai'] })).some(e => e.code === 'GOV-CAPABILITY'), true, '能力：宿主 v1 未提供的 ai 硬失败');
  eq(gov(manifestExpression({ author: 'Papilot' })).some(e => e.code === 'GOV-IDENTITY'), true, '社区身份：不得冒充 Papilot 官方作者');
}

function dependencySet() {
  const a = baseManifest(); a.id = 'papilot-mod-a'; a.depends = [];
  const b = baseManifest(); b.id = 'papilot-mod-b'; b.depends = [];
  return [a, b];
}
function testDependenciesAndCatalog() {
  const good = dependencySet();
  eq(gov('subject.validate_dependencies(' + JSON.stringify(good) + ')'), [], '依赖：无依赖的合法组件集合通过');
  const missing = dependencySet(); missing[0].depends = ['papilot-mod-missing'];
  eq(gov('subject.validate_dependencies(' + JSON.stringify(missing) + ')').some(e => e.code === 'GOV-DEPEND-MISSING'), true, '依赖缺失：未知 id 硬失败');
  const self = dependencySet(); self[0].depends = [self[0].id];
  eq(gov('subject.validate_manifest(' + JSON.stringify(self[0]) + ', new_component=True)').some(e => e.code === 'GOV-DEPEND-SELF'), true, '自依赖：组件不能依赖自身');
  const cycle = dependencySet(); cycle[0].depends = [cycle[1].id]; cycle[1].depends = [cycle[0].id];
  eq(gov('subject.validate_dependencies(' + JSON.stringify(cycle) + ')').some(e => e.code === 'GOV-DEPEND-CYCLE'), true, '依赖环：A→B→A 硬失败');

  const entry = {
    id: 'papilot-mod-a', version: '1.0', minHost: '0.70.0', apiVersion: 1, mode: 'sandbox',
    requires: [], permissions: [], depends: [], zipSha256: 'a'.repeat(64),
  };
  const catalog = { schema: 1, hostMin: '0.70.0', modules: [entry] };
  eq(gov('subject.validate_catalog(' + JSON.stringify(catalog) + ')'), [], '目录：完整治理字段通过');
  for (const field of ['mode', 'requires', 'permissions', 'depends', 'minHost']) {
    const broken = clone(catalog); delete broken.modules[0][field];
    eq(gov('subject.validate_catalog(' + JSON.stringify(broken) + ')').some(e => e.code === 'GOV-CATALOG-FIELD'), true,
      '目录字段缺失：' + field + ' 硬失败');
  }
  const previous = clone(catalog);
  eq(gov('subject.check_immutable(' + JSON.stringify(previous) + ', ' + JSON.stringify(catalog) + ')'), [], '不可变性：同版同 hash 幂等通过');
  const changed = clone(catalog); changed.modules[0].zipSha256 = 'b'.repeat(64);
  eq(gov('subject.check_immutable(' + JSON.stringify(previous) + ', ' + JSON.stringify(changed) + ')').some(e => e.code === 'GOV-IMMUTABLE'), true, '不可变性：同版不同 hash 硬失败');
  previous.modules[0].version = '1.0.0';
  eq(gov('subject.check_immutable(' + JSON.stringify(previous) + ', ' + JSON.stringify(changed) + ')').some(e => e.code === 'GOV-IMMUTABLE'), true, '不可变性：1.0 与 1.0.0 同义也不得换 hash');
  const upgraded = clone(changed); upgraded.modules[0].version = '1.1';
  eq(gov('subject.check_immutable(' + JSON.stringify(previous) + ', ' + JSON.stringify(upgraded) + ')'), [], '不可变性：升版允许新 hash');
}

function zipScenario(kind) {
  const manifest = baseManifest();
  manifest.files.push({ path: 'LICENSE', sha256: crypto.createHash('sha256').update('MIT\n').digest('hex'), size: 4 });
  const pre = GOV + 'import io, zipfile, hashlib\nmanifest = ' + JSON.stringify(manifest) + '\nbuf = io.BytesIO()\nz = zipfile.ZipFile(buf, "w")\n';
  const common = 'z.writestr("module.json", json.dumps(manifest))\nz.writestr("main.js", b"export function register() {}\\n")\nz.writestr("LICENSE", b"MIT\\n")\n';
  const variants = {
    valid: common,
    duplicate: common + 'z.writestr("main.js", b"duplicate")\n',
    traversal: common + 'z.writestr("../evil.js", b"evil")\n',
    absolute: common + 'z.writestr("/evil.js", b"evil")\n',
    backslash: common + 'z.writestr("dirXevil.js", b"evil")\n',
    executable: common + 'z.writestr("extra.exe", b"MZ")\n',
    malformed: '',
  };
  let script = pre + variants[kind];
  if (kind === 'malformed') script += 'z.close()\ndata = b"not a zip"\n';
  else script += 'z.close()\ndata = buf.getvalue()\n';
  // Windows Python 3.13 写 ZIP 时会规范化反斜杠，直接改原始条目字节构造攻击夹具。
  if (kind === 'backslash') script += 'data = data.replace(b"dirXevil.js", b"dir" + bytes([92]) + b"evil.js")\n';
  script += 'print(json.dumps([e["code"] for e in subject.validate_zip(data, manifest)]))';
  return python(script, 'ZIP ' + kind);
}
function testZipRules() {
  eq(zipScenario('valid'), [], 'ZIP 正常路径：module.json、JS 与 LICENSE 非 JS 资源精确同集合通过');
  ok(zipScenario('duplicate').includes('GOV-ZIP-DUPLICATE'), 'ZIP：重复 entry 硬失败');
  ok(zipScenario('traversal').includes('GOV-ZIP-PATH'), 'ZIP：路径穿越 entry 硬失败');
  ok(zipScenario('absolute').includes('GOV-ZIP-PATH'), 'ZIP：绝对路径 entry 硬失败');
  const backslashErrors = zipScenario('backslash');
  ok(backslashErrors.includes('GOV-ZIP-PATH') || backslashErrors.includes('GOV-ZIP-SET'), 'ZIP：反斜杠 entry 硬失败（Windows 读取规范化后至少集合不符）', backslashErrors);
  ok(zipScenario('executable').includes('GOV-ZIP-SET'), 'ZIP：未声明额外可执行文件硬失败');
  ok(zipScenario('malformed').includes('GOV-ZIP'), '异常分支：畸形 ZIP 返回明确错误而不抛出');
}

function testBuildAndPublishIndexes() {
  const script = PUBLISH + `
import tempfile, hashlib
with tempfile.TemporaryDirectory() as td:
    subject.ZIP_DIR = Path(td)
    mods = ${JSON.stringify([baseManifest(), Object.assign(baseManifest(), { id: 'papilot-mod-b', version: '2.0', minHost: '0.80.0' })])}
    for m in mods:
        p = subject.ZIP_DIR / (m["id"] + "-" + m["version"] + ".zip")
        p.write_bytes((m["id"] + "-zip").encode())
    idx = subject.build_index(mods)
    print(json.dumps(idx))
`;
  const index = python(script, '多版本公开目录');
  eq(index.modules[0].download.github.includes('/releases/download/v1.2/'), true, '多版本 tag：首组件 URL 使用自身 v1.2');
  eq(index.modules[1].download.github.includes('/releases/download/v2.0/'), true, '多版本 tag：第二组件 URL 使用自身 v2.0');
  eq(index.hostMin, '0.70.0', '多版本 hostMin：目录取全条目最低基线');
  eq(index.modules[1].minHost, '0.80.0', '多版本 hostMin：条目保留真实较高约束');
  for (const field of ['mode', 'requires', 'permissions', 'depends', 'author', 'license', 'origin', 'sourceRevision']) {
    eq(Object.prototype.hasOwnProperty.call(index.modules[0], field), true, '公开目录：保留治理字段 ' + field);
  }

  const prep = BUILD + `
doc = ${pyValue({
    version: '9.9', hostMin: '9.9',
    governance: { officialDefaults: { author: 'Papilot', license: 'Apache-2.0', origin: 'official', sourceRevision: 'git:HEAD' } },
    modules: [{ id: 'papilot-mod-pdf', name: 'PDF', description: 'PDF', order: 1, provides: [], depends: [], tags: [], repo: { github: 'g', gitee: 'e' }, recommended: false, pro: false, hot: false, files: ['scripts/a.js'], mode: 'scope' }],
    bundles: [],
  })}
subject.source_revision = lambda: "test-revision"
subject.prepare(doc)
print(json.dumps(doc["modules"][0]))
`;
  const official = python(prep, '官方默认继承');
  eq(official.version, '9.9', '官方默认：遗产组件继续继承 auto 版本');
  eq(official.author, 'Papilot', '官方默认：仅遗产白名单继承 Papilot 身份');
  eq(official.sourceRevision, 'test-revision', '审计：git:HEAD 占位解析为实际 revision');

  const communityAuto = BUILD + `
doc = {"version":"9.9", "hostMin":"9.9", "governance":{}, "modules":[{"id":"papilot-mod-community", "origin":"community", "name":"c", "description":"c", "order":1, "provides":[], "depends":[], "tags":[], "repo":{"github":"g","gitee":"e"}, "recommended":False,"pro":False,"hot":False,"files":["scripts/a.js"],"mode":"sandbox","entry":"scripts/a.js","author":"A","license":"MIT","sourceRevision":"r"}],"bundles":[]}
try:
    subject.prepare(doc)
    result = "accepted"
except SystemExit as exc:
    result = "exit-" + str(exc.code)
print(json.dumps(result))
`;
  eq(python(communityAuto, '社区 auto 拒绝'), 'exit-1', '社区版本：缺独立 version 时准备阶段硬退出');

  const mixedBundle = BUILD + `
doc = ${JSON.stringify({
    version: '1.0', hostMin: '1.0', governance: {},
    modules: [Object.assign(baseManifest(), { id: 'papilot-mod-a', hostMin: '1.0' }), Object.assign(baseManifest(), { id: 'papilot-mod-b', version: '2.0', hostMin: '1.0' })],
    bundles: [{ id: 'papilot-bundle-community', modules: ['papilot-mod-a', 'papilot-mod-b'] }],
  })}
for m in doc["modules"]:
    m["hostMin"] = m.pop("minHost")
    m["order"] = 1; m["provides"] = []; m["tags"] = []; m["repo"] = {"github":"g","gitee":"e"}; m["recommended"] = False; m["pro"] = False; m["hot"] = False
try:
    subject.prepare(doc)
    result = "accepted"
except SystemExit as exc:
    result = "exit-" + str(exc.code)
print(json.dumps(result))
`;
  eq(python(mixedBundle, '合集混合版本'), 'exit-1', '合集：成员混合版本硬退出，不能共用一个 tag');
}

function stageFixture(mode) {
  const manifest = baseManifest();
  manifest.id = 'papilot-mod-pdf'; manifest.mode = 'scope'; manifest.entry = ''; manifest.origin = 'official'; manifest.author = 'Papilot';
  const previous = { schema: 1, hostMin: '0.70.0', modules: [Object.assign({}, manifest, { version: '0.9', zipSha256: 'c'.repeat(64), files: undefined })] };
  delete previous.modules[0].files;
  return PUBLISH + `
import tempfile, io, zipfile, subprocess, sys
with tempfile.TemporaryDirectory() as td:
    root = Path(td)
    subject.MODULES_DIR = root / "modules"
    subject.ZIP_DIR = root / "dist"
    subject.INDEX_FILE = root / "public.json"
    subject.STAGE_DIR = root / "stage"
    (subject.MODULES_DIR / "papilot-mod-pdf").mkdir(parents=True)
    subject.ZIP_DIR.mkdir()
    manifest = ${JSON.stringify(manifest)}
    (subject.MODULES_DIR / "papilot-mod-pdf" / "module.json").write_text(json.dumps(manifest), encoding="utf-8")
    zp = subject.ZIP_DIR / "papilot-mod-pdf-1.2.zip"
    with zipfile.ZipFile(zp, "w") as z:
        z.writestr("module.json", json.dumps(manifest))
        z.writestr("main.js", b"export function register() {}\\n")
    previous = ${JSON.stringify(previous)}
    subject.INDEX_FILE.write_text(json.dumps(previous), encoding="utf-8")
    before = subject.INDEX_FILE.read_bytes()
    class Result: returncode = ${mode === 'nonzero' ? 2 : 0}
    def fake_run(*args, **kwargs):
        ${mode === 'exception' ? 'raise OSError("offline signer failure")' : 'return Result()'}
    subject.subprocess.run = fake_run
    sys.argv = ["publish-modules.py", "--stage"]
    try:
        subject.main()
        outcome = "accepted"
    except SystemExit as exc:
        outcome = "exit-" + str(exc.code)
    print(json.dumps({"outcome":outcome,"unchanged":subject.INDEX_FILE.read_bytes()==before,"tmp":subject.INDEX_FILE.with_name(subject.INDEX_FILE.name+".tmp").exists(),"stage":subject.STAGE_DIR.exists()}))
`;
}
function testSigningGatesAndAtomicity() {
  for (const mode of ['nonzero', 'exception']) {
    const result = python(stageFixture(mode), 'stage 签名失败 ' + mode);
    eq(result.outcome, 'exit-1', 'stage：签名命令' + (mode === 'nonzero' ? '非零' : '异常') + '硬退出');
    eq(result.unchanged, true, 'stage 原子性：签名' + mode + ' 时旧公开目录不变');
    eq(result.tmp, false, 'stage 清理：签名' + mode + ' 后临时目录文件删除');
    eq(result.stage, false, 'stage 清理：签名' + mode + ' 后不汇总 zip');
  }

  const manifest = baseManifest(); manifest.id = 'papilot-mod-pdf'; manifest.mode = 'scope'; manifest.entry = ''; manifest.origin = 'official'; manifest.author = 'Papilot';
  const buildFailure = BUILD + `
import tempfile, subprocess
with tempfile.TemporaryDirectory() as td:
    root = Path(td)
    subject.MODULES_DIR = root / "modules"; subject.DIST_DIR = root / "dist"; subject.BUNDLES_DIR = root / "bundles"
    subject.INDEX_FILE = root / "builtin.json"; subject.CONTENT_DIR = root / "content"; subject.ROOT = root
    subject.CONTENT_DIR.mkdir(); (subject.CONTENT_DIR / "main.js").write_bytes(b"export function register() {}\\n")
    subject.INDEX_FILE.write_bytes(b"old-index")
    subject.main_js_order = lambda: {}
    class Result: returncode = 2; stdout = ""; stderr = "no key"
    subprocess.run = lambda *args, **kwargs: Result()
    mod = ${JSON.stringify(manifest)}
    mod["hostMin"] = mod.pop("minHost"); mod["description"] = "PDF"; mod["files"] = ["main.js"]; mod["order"] = 1; mod["provides"] = []; mod["tags"] = []; mod["repo"] = {"github":"g","gitee":"e"}; mod["recommended"] = False; mod["pro"] = False; mod["hot"] = False; mod["whatsNew"] = "test"
    doc = {"version":"1.2", "hostMin":"0.70.0", "modules":[mod], "bundles":[]}
    try:
        subject.cmd_all(doc, False)
        outcome = "accepted"
    except SystemExit as exc:
        outcome = "exit-" + str(exc.code)
    print(json.dumps({"outcome":outcome,"unchanged":subject.INDEX_FILE.read_bytes()==b"old-index"}))
`;
  const built = python(buildFailure, 'build 签名硬门槛');
  eq(built.outcome, 'exit-1', 'build：签名失败硬退出而不是打印后继续');
}

function testUploadAndPatrol() {
  eq(python(UPLOAD + 'print(json.dumps(subject.compare_remote_asset(b"same", b"same")))', '上传同 hash').same, true, '上传：同名同 hash 判定幂等一致');
  const diff = python(UPLOAD + 'print(json.dumps(subject.compare_remote_asset(b"local", b"remote")))', '上传不同 hash');
  eq(diff.same, false, '上传：同名不同 hash 判定冲突');
  ok(diff.localSha256 !== diff.remoteSha256, '上传：冲突结果保留双端 sha256 证据');

  const same = python(UPLOAD + `
import tempfile
with tempfile.TemporaryDirectory() as td:
    p = Path(td) / "a.zip"; p.write_bytes(b"local")
    subject.http_bytes = lambda url, token: b"local"
    print(json.dumps(subject.verify_existing({"browser_download_url":"offline://fixture/a.zip"}, p, "fake-token")))
`, '远端同 hash');
  eq(same, crypto.createHash('sha256').update('local').digest('hex'), '上传：远端同字节时返回本地 hash 并允许跳过');

  const conflict = python(UPLOAD + `
import tempfile
with tempfile.TemporaryDirectory() as td:
    p = Path(td) / "a.zip"; p.write_bytes(b"local")
    subject.http_bytes = lambda url, token: b"remote"
    try:
        subject.verify_existing({"browser_download_url":"offline://fixture/a.zip"}, p, "fake-token")
        result = "accepted"
    except SystemExit as exc:
        result = "exit-" + str(exc.code)
    print(json.dumps(result))
`, '远端冲突');
  eq(conflict, 'exit-1', '上传：远端同名不同内容硬退出，禁止覆盖');

  const noUrl = python(UPLOAD + `
import tempfile
with tempfile.TemporaryDirectory() as td:
    p = Path(td) / "a.zip"; p.write_bytes(b"local")
    subject.http_bytes = lambda url, token: (_ for _ in ()).throw(AssertionError("不应下载"))
    try:
        subject.verify_existing({}, p, "fake-token")
        result = "accepted"
    except SystemExit as exc:
        result = "exit-" + str(exc.code)
    print(json.dumps(result))
`, '远端缺 URL');
  eq(noUrl, 'exit-1', '上传异常：同名附件缺下载 URL 不得视为一致');

  const network = python(UPLOAD + `
import tempfile
with tempfile.TemporaryDirectory() as td:
    p = Path(td) / "a.zip"; p.write_bytes(b"local")
    def offline(url, token): raise OSError("offline fixture")
    subject.http_bytes = offline
    try:
        subject.verify_existing({"download_url":"offline://fixture/a.zip"}, p, "fake-token")
        result = "accepted"
    except OSError as exc:
        result = str(exc)
    print(json.dumps(result))
`, '远端网络失败');
  eq(network, 'offline fixture', '上传异常：网络失败向上传播，绝不降级记成功');

  const a = { id: 'papilot-mod-a', version: '1.0', zipSha256: 'a'.repeat(64), mode: 'sandbox', permissions: ['network'], download: { github: 'g' } };
  const left = { modules: [a] }, right = { modules: [clone(a)] };
  eq(python(PATROL + 'print(json.dumps(subject.compare_indexes(' + JSON.stringify(left) + ', ' + JSON.stringify(right) + ')))', 'patrol 一致'), [], 'patrol：双端完整治理字段一致通过');
  right.modules[0].permissions = [];
  const drift = python(PATROL + 'print(json.dumps(subject.compare_indexes(' + JSON.stringify(left) + ', ' + JSON.stringify(right) + ')))', 'patrol 字段漂移');
  ok(drift.some(x => x.includes('permissions')), 'patrol：双端权限字段漂移被报告');
  const conflicted = { modules: [a, Object.assign(clone(a), { zipSha256: 'b'.repeat(64) })] };
  const sameVersion = python(PATROL + 'print(json.dumps(subject.compare_indexes(' + JSON.stringify(conflicted) + ', ' + JSON.stringify(conflicted) + ')))', 'patrol 同版冲突');
  ok(sameVersion.every(x => !x.includes('双端字段不一致')) && sameVersion.some(x => x.includes('同版 hash 冲突')), 'patrol：单侧同 id/version 不同 hash 被报告');
}

const STORE_SRC = fs.readFileSync(path.join(ROOT, 'chrome', 'content', 'scripts', 'core', 'module-store.js'), 'utf8');
const CAT_SRC = fs.readFileSync(path.join(ROOT, 'chrome', 'content', 'scripts', 'core', 'catalog-client.js'), 'utf8');
const P = {
  join: function () { return '/' + Array.from(arguments).join('/').split('/').filter(x => x && x !== '.').join('/'); },
  parent: function (p) { const i = p.lastIndexOf('/'); return i <= 0 ? '/' : p.slice(0, i); },
};
function makeStore(options) {
  const o = options || {};
  const prefs = new Map();
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    Zotero: { Papilot: { rootURI: 'chrome://papilot/' } }, PathUtils: P,
    IOUtils: { makeDirectory: async () => {}, write: async () => {}, remove: async () => {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(CAT_SRC, sandbox, { filename: 'catalog-client.js' });
  vm.runInContext(STORE_SRC, sandbox, { filename: 'module-store.js' });
  const diagnostics = [];
  sandbox.ModuleStore.init({ loader: o.loader || null, deps: {
    prefGet: (k, d) => prefs.has(k) ? prefs.get(k) : d, prefSet: (k, v) => prefs.set(k, v),
    httpGet: async () => { throw new Error('offline'); }, httpGetBytes: async () => { throw new Error('offline'); },
    diag: m => diagnostics.push(String(m)), now: () => 1750000000000,
  } });
  return { store: sandbox.ModuleStore, sandbox, diagnostics };
}
function payloadOf(index) {
  const mods = (index.modules || []).slice().sort((a, b) => String(a.id).localeCompare(String(b.id)));
  let text = 'papilot-modules-v1\n' + String(index.hostMin || '') + '\n';
  for (const m of mods) text += String(m.id) + '|' + String(m.version) + '|' + String(m.zipSha256 || '') + '\n';
  return Buffer.from(text + mods.length + '\n', 'utf8');
}
async function testSignatureClassification() {
  const pair = crypto.generateKeyPairSync('ed25519');
  const spki = Buffer.from(pair.publicKey.export({ type: 'spki', format: 'der' })).toString('base64');
  const raw = { schema: 1, hostMin: '0.70.0', updated: '2026-10-24T00:00:00Z', modules: [] };
  const signed = Object.assign(clone(raw), { signature: crypto.sign(null, payloadOf(raw), pair.privateKey).toString('base64'), signatureAlgo: 'ed25519' });
  function signedStore(data, pub, subtle) {
    const st = makeStore();
    st.sandbox.fetch = async () => ({ ok: true, json: async () => ({ key: pub }) });
    if (subtle !== undefined) st.sandbox.crypto = { subtle };
    st.sandbox.TextEncoder = TextEncoder;
    st.sandbox.atob = atob;
    return st;
  }
  eq((await signedStore(signed, spki, crypto.webcrypto.subtle).store._verifyCatalogSignature(signed)).ok, true, '验签：临时 Ed25519 密钥生成的有效签名通过');
  const missing = clone(raw);
  eq((await signedStore(missing, spki, crypto.webcrypto.subtle).store._verifyCatalogSignature(missing)).ok, false, '验签：有公钥但缺签名硬拒绝');
  const wrongAlgo = Object.assign(clone(signed), { signatureAlgo: 'rsa' });
  eq((await signedStore(wrongAlgo, spki, crypto.webcrypto.subtle).store._verifyCatalogSignature(wrongAlgo)).ok, false, '验签：错误算法硬拒绝');
  const badKeyResult = await signedStore(signed, 'not-a-key', crypto.webcrypto.subtle).store._verifyCatalogSignature(signed);
  eq(badKeyResult.ok, false, '畸形公钥：importKey 异常不得降级接受');
  eq(badKeyResult.degraded, undefined, '畸形公钥：结果不带 degraded 标志');
  const badSig = Object.assign(clone(signed), { signature: '%%%not-base64%%%' });
  eq((await signedStore(badSig, spki, crypto.webcrypto.subtle).store._verifyCatalogSignature(badSig)).ok, false, '畸形签名：base64 解码异常不得降级接受');
  const wrongSig = Object.assign(clone(signed), { signature: crypto.sign(null, Buffer.from('other'), pair.privateKey).toString('base64') });
  eq((await signedStore(wrongSig, spki, crypto.webcrypto.subtle).store._verifyCatalogSignature(wrongSig)).ok, false, '验签失败：有效格式但错误签名硬拒绝');
  const throwingSubtle = { importKey: async () => { throw new Error('import failed'); }, verify: async () => true };
  eq((await signedStore(signed, spki, throwingSubtle).store._verifyCatalogSignature(signed)).ok, false, '验签异常：importKey 抛出时硬拒绝');
  const verifyThrows = { importKey: async () => ({}), verify: async () => { throw new Error('verify failed'); } };
  eq((await signedStore(signed, spki, verifyThrows).store._verifyCatalogSignature(signed)).ok, false, '验签异常：verify 抛出时硬拒绝');
  const degraded = await signedStore(signed, spki, null).store._verifyCatalogSignature(signed);
  eq(degraded.ok && degraded.degraded, true, '老宿主边界：仅明确缺 WebCrypto API 时降级接受');
  const noPub = await signedStore(raw, '', crypto.webcrypto.subtle).store._verifyCatalogSignature(raw);
  eq(noPub.ok, true, '旧宿主边界：无公钥过渡期保持接受');
}

function testRuntimeVersionPlanAndDelisting() {
  const sandbox = { console: { log() {}, warn() {}, error() {} } };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'chrome', 'content', 'scripts', 'core', 'module-loader.js'), 'utf8'), sandbox);
  const pure = sandbox.ModuleLoader._pure;
  const plan = (incoming, installed, allowDowngrade) => pure.planInstall.call(pure, incoming, installed, allowDowngrade);
  eq(plan({ version: '1.0' }, null, false).action, 'install', '运行时语义：未安装 → install');
  eq(plan({ version: '1.1' }, { version: '1.0' }, false).action, 'upgrade', '运行时语义：更高版本 → upgrade');
  eq(plan({ version: '1.0.0' }, { version: '1.0' }, false).action, 'same', '运行时语义：等值同版 → same/noop');
  eq(plan({ version: '0.9' }, { version: '1.0' }, false).action, 'blocked', '运行时语义：普通降级默认 blocked');
  eq(plan({ version: '0.9' }, { version: '1.0' }, true).action, 'downgrade', '运行时语义：仅显式 allowDowngrade 才放行');

  const loader = {
    API_VERSION: 1, _pure: sandbox.ModuleLoader._pure,
    list: () => [{ id: 'papilot-mod-retired', version: '1.0', broken: false, previous: { version: '0.9', dir: 'old' } }],
  };
  const st = makeStore({ loader });
  st.store._catalog = { schema: 1, modules: [] };
  const rows = st.store.listRows();
  eq(rows.length, 1, '软下架：fresh 目录无条目时已装组件仍显示');
  eq(rows[0]._catalog, null, '软下架：已装条目以 _catalog=null 标记目录中已下架');
  eq(rows[0].canRollback, true, '软下架：已装用户仍可使用本地 previous 回滚');
}

function testCliAndMaterials() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-governance-cli-'));
  try {
    const malformed = path.join(temp, 'bad.json');
    fs.writeFileSync(malformed, '{bad json', 'utf8');
    const result = spawnSync(PYTHON, [path.join(ROOT, 'scripts', 'module-governance.py'), '--manifest', malformed], {
      cwd: ROOT, encoding: 'utf8', timeout: 30000, env: Object.assign({}, process.env, { PYTHONDONTWRITEBYTECODE: '1' }),
    });
    eq(result.status, 1, 'CLI 异常：畸形 JSON 非零退出');
    has(result.stderr, 'GOV-INPUT', 'CLI 异常：畸形 JSON 返回 GOV-INPUT');
    eq(fs.readdirSync(temp).length, 1, '临时隔离：失败 CLI 不产生旁路文件');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }

  const template = fs.readFileSync(path.join(ROOT, '.github', 'PULL_REQUEST_TEMPLATE', 'component.md'), 'utf8');
  const requiredMaterials = [
    ['作者、维护者与联系方式', 'PR 材料：作者/维护者/联系方式'],
    ['license 与许可证文本/NOTICE', 'PR 材料：许可证与 NOTICE'],
    ['source revision', 'PR 材料：精确源码 revision'],
    ['version / minHost / apiVersion', 'PR 材料：版本与宿主兼容'],
    ['依赖 id、用途及加载顺序', 'PR 材料：依赖及加载顺序'],
    ['实际网络域名', 'PR 材料：实际网络与数据申报'],
    ['第三方依赖/二进制/压缩资源', 'PR 材料：第三方载荷'],
    ['测试环境、命令与结果', 'PR 材料：测试证据'],
    ['已知风险、隐私影响与限制', 'PR 材料：风险与隐私'],
    ['id + version + source revision + zipSha256', 'PR 材料：审批绑定不可变制品'],
  ];
  for (const [needle, label] of requiredMaterials) has(template, needle, label);

  const doc = fs.readFileSync(path.join(ROOT, 'docs', 'module-governance.md'), 'utf8');
  has(doc, '已安装条目仍须显示、可卸载/回滚', '撤销文档：软下架不删除本地组件且保留卸载/回滚');
  has(doc, 'signed revoked 列表、已装实例禁用、缓存防回放', '撤销文档：安全撤销明确需要额外运行时机制');
  has(doc, '无法承诺即时触达离线用户', '撤销文档：静态目录不得宣称远程即时禁用');
  has(doc, '仓库没有作者在线上传后台', '投稿文档：上传边界为主仓 PR 而非虚构在线后台');
  has(doc, '自动检查通过**不等于安全审批通过**', '审批文档：自动检查不替代人工安全审批');
}

async function main() {
  testVersionsAndManifests();
  testDependenciesAndCatalog();
  testZipRules();
  testBuildAndPublishIndexes();
  testSigningGatesAndAtomicity();
  testUploadAndPatrol();
  await testSignatureClassification();
  testRuntimeVersionPlanAndDelisting();
  testCliAndMaterials();

  if (fails.length) {
    console.log('');
    for (const failure of fails) console.log('✗ ' + failure);
    console.log('');
    console.log('module-governance：' + pass + ' 通过，' + fails.length + ' 失败，0 跳过');
    process.exitCode = 1;
    return;
  }
  console.log('✓ ' + pass + ' assertions，0 失败，0 跳过  (module-governance)');
  process.exitCode = 0;
}

main().catch(error => {
  console.error(error && error.stack || error);
  if (fails.length) for (const failure of fails) console.error('✗ ' + failure);
  console.error('module-governance：' + pass + ' 通过，' + (fails.length + 1) + ' 失败，0 跳过（框架异常）');
  process.exitCode = 1;
});
