#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 Cassiuschen. All rights reserved.
"""Papilot 组件链真实 Zotero E2E。

只使用 build/verify 下的独立 profile/data 目录，绝不读写用户真实 profile。
正向/反向目录均由 127.0.0.1:0 临时 HTTP 服务提供，并用项目签名脚本签名。
每轮启动都断言真实 boot 日志和 installed.json，而不是只检查函数/文件存在。

用法：
  python scripts/verify-modules-e2e.py
  python scripts/verify-modules-e2e.py --scenario upgrade --keep
  python scripts/verify-modules-e2e.py --full dist/full.xpi --slim dist/slim.xpi
"""
import argparse
import datetime
import functools
import hashlib
import http.server
import json
import re
import shutil
import subprocess
import sys
import threading
import time
import traceback
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ADDON_ID = "papilot@dev.local"
DEFAULT_ZOTERO = Path(r"C:\Program Files\Zotero\zotero.exe")
SCENARIOS = ("full", "slim", "upgrade", "tamper", "corrupt", "matrix")


class ScenarioFailure(AssertionError):
    pass


def require(condition, message):
    if not condition:
        raise ScenarioFailure(message)


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def write_json(path, value):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n",
                          encoding="utf-8")


def read_text(path):
    try:
        return Path(path).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def kill_tree(pid):
    """先结束 Popen PID；实际 Zotero 再由 profile 精确匹配收尾。"""
    try:
        subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"],
                       capture_output=True, timeout=20)
    except (OSError, subprocess.SubprocessError):
        pass


def kill_profile_zotero(profile, pid):
    kill_tree(pid)
    # Windows 上 zotero.exe 可能把真实进程转为另一 PID。只按本场景完整临时
    # profile 路径匹配 CommandLine，绝不按进程名误杀用户实例。
    script = (
        "$target=$args[0]; "
        "$ps=Get-CimInstance Win32_Process -Filter \"Name='zotero.exe'\" | "
        "Where-Object { $_.CommandLine -and $_.CommandLine.Contains($target) }; "
        "$ids=@($ps | ForEach-Object { $_.ProcessId }); "
        "foreach($id in $ids){ Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }; "
        "foreach($id in $ids){ Wait-Process -Id $id -Timeout 15 -ErrorAction SilentlyContinue }"
    )
    try:
        subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script,
                        str(profile)], capture_output=True, timeout=40)
    except (OSError, subprocess.SubprocessError):
        pass


def sign_index(path):
    proc = subprocess.run(
        ["node", str(ROOT / "scripts" / "sign-modules-index.js"), str(path)],
        capture_output=True, text=True, timeout=60)
    require(proc.returncode == 0,
            "目录签名失败：%s%s" % (proc.stdout, proc.stderr))
    index = read_json(path)
    require(index.get("signatureAlgo") == "ed25519" and index.get("signature"),
            "签名脚本未写入 Ed25519 签名")


def start_catalog_server(dest, version="0.78.0"):
    """构造完整本地目录；HTTP 直接 listen(0)，不预留端口、不碰公网。"""
    dest = Path(dest)
    (dest / "dist").mkdir(parents=True, exist_ok=True)
    (dest / "modules").mkdir(parents=True, exist_ok=True)
    class QuietHandler(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *args):
            return None

        def do_GET(self):
            path = self.path.split("?", 1)[0]
            server.requestCounts[path] = server.requestCounts.get(path, 0) + 1
            super().do_GET()

    handler = functools.partial(QuietHandler, directory=str(dest))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    server.requestCounts = {}
    server.daemon_threads = True
    base_url = "http://127.0.0.1:%d" % server.server_address[1]
    entries = []

    def add_entry(manifest, zip_path, manifest_url, bundle=False):
        shutil.copy2(zip_path, dest / "dist" / zip_path.name)
        entry = {
            "id": manifest["id"], "name": manifest.get("name", manifest["id"]),
            "version": manifest["version"],
            "description": manifest.get("description", ""),
            "sizeBytes": zip_path.stat().st_size,
            "zipSha256": sha256(zip_path),
            "fileCount": 0 if bundle else len(manifest.get("files") or []),
            "tags": manifest.get("tags") or [], "recommended": False,
            "pro": False, "hot": False,
            "whatsNew": manifest.get("whatsNew", ""),
            "download": {"github": "%s/dist/%s" % (base_url, zip_path.name)},
            "manifest": {"github": manifest_url},
        }
        if bundle:
            entry.update(bundle=True, contains=manifest.get("modules") or [])
        entries.append(entry)

    for mf in sorted((ROOT / "modules").glob("*/module.json")):
        manifest = read_json(mf)
        mid = manifest["id"]
        out = dest / "modules" / mid / "module.json"
        write_json(out, manifest)
        zip_path = ROOT / "dist" / "modules" / ("%s-%s.zip" % (mid, manifest["version"]))
        require(zip_path.is_file(), "缺少组件包：%s" % zip_path)
        add_entry(manifest, zip_path, "%s/modules/%s/module.json" % (base_url, mid))
    for bf in sorted((ROOT / "bundles").glob("*/module.json")):
        manifest = read_json(bf)
        bid = manifest["id"]
        out = dest / "bundles" / bid / "module.json"
        write_json(out, manifest)
        zip_path = ROOT / "dist" / "modules" / ("%s-%s.zip" % (bid, manifest["version"]))
        require(zip_path.is_file(), "缺少合集包：%s" % zip_path)
        add_entry(manifest, zip_path, "%s/bundles/%s/module.json" % (base_url, bid), True)

    index_path = dest / "index.json"
    write_json(index_path, {
        "schema": 1,
        "updated": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "hostMin": version,
        "modules": entries,
    })
    sign_index(index_path)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, base_url + "/index.json", index_path


def stop_server(server):
    if server is not None:
        server.shutdown()
        server.server_close()


def validate_xpi(path, version):
    path = Path(path)
    require(path.is_file(), "XPI 不存在：%s" % path)
    with zipfile.ZipFile(path) as archive:
        names = set(archive.namelist())
        require("manifest.json" in names, "XPI 缺 manifest.json：%s" % path)
        manifest = json.loads(archive.read("manifest.json").decode("utf-8"))
        require(manifest.get("applications", {}).get("zotero", {}).get("id") == ADDON_ID,
                "XPI 插件 id 错误：%s" % path)
        require(manifest.get("version") == version,
                "XPI 版本应为 %s：%s" % (version, path))
        for name in ("bootstrap.js", "chrome/content/scripts/main.js",
                     "chrome/content/scripts/core/module-loader.js",
                     "chrome/content/modules/builtin-index.json"):
            require(name in names, "XPI 缺核心文件 %s：%s" % (name, path))


def base_prefs(data_dir, catalog_url="", install=""):
    prefs = [
        'user_pref("extensions.zotero.dataDir", %s);' % json.dumps(str(data_dir)),
        'user_pref("extensions.zotero.useDataDir", true);',
        'user_pref("app.update.auto", false);',
        'user_pref("extensions.autoDisableScopes", 0);',
        'user_pref("extensions.zotero.firstRunGuid", "verified");',
        'user_pref("extensions.zotero.httpServer.enabled", false);',
        'user_pref("extensions.zotero.papilot.wizardDone", "verified");',
        'user_pref("extensions.zotero.papilot.modulesAutoUpdate", true);',
    ]
    if catalog_url:
        prefs.append('user_pref("extensions.zotero.papilot.modulesCatalogUrl", %s);'
                     % json.dumps(catalog_url))
    if install:
        prefs.append('user_pref("extensions.zotero.papilot.modulesSelftestInstall", %s);'
                     % json.dumps(install))
    return prefs


class Harness:
    def __init__(self, args, output):
        self.args = args
        self.zotero = Path(args.zotero)
        self.version = args.version
        self.full = Path(args.full)
        self.slim = Path(args.slim)
        self.output = Path(output)
        self.output.mkdir(parents=True, exist_ok=True)

    def workspace(self, scenario):
        work = self.output / (scenario + "-profile")
        require(not work.exists(), "验证工作目录已存在，请换新 --output：%s" % work)
        profile = work / "profile"
        data = work / "data"
        profile.mkdir(parents=True)
        data.mkdir(parents=True)
        return work, profile, data

    def install_xpi(self, profile, xpi):
        extdir = profile / "extensions"
        extdir.mkdir(parents=True, exist_ok=True)
        destination = extdir / (ADDON_ID + ".xpi")
        # Zotero 退出后 Windows 仍可能短暂保留 XPI 映射；同包第二轮绝不覆盖该文件。
        if not destination.is_file() or sha256(destination) != sha256(xpi):
            shutil.copy2(xpi, destination)
        cache = profile / "addonStartup.json.lz4"
        if cache.exists():
            cache.unlink()

    def run_zotero(self, scenario, round_name, profile, data, xpi,
                   catalog_url="", install="", wait_selftest=False, wait_update=False,
                   extra_prefs=None, settle_floor=0):
        prefs = base_prefs(data, catalog_url, install)
        prefs.extend(extra_prefs or [])
        (profile / "prefs.js").write_text("\n".join(prefs) + "\n", encoding="utf-8")
        self.install_xpi(profile, xpi)
        log_path = data / "papilot-boot.log"
        alternate = profile / "papilot-boot.log"
        for path in (log_path, alternate):
            if path.exists():
                path.unlink()
        proc = subprocess.Popen([str(self.zotero), "-profile", str(profile), "-no-remote"],
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        log = ""
        deadline = time.monotonic() + self.args.timeout
        try:
            while time.monotonic() < deadline:
                log = max((read_text(log_path), read_text(alternate)), key=len)
                if "STARTUP FAILED" in log:
                    break
                if "init complete" in log:
                    init_at = time.monotonic()
                    settle = init_at + self.args.settle
                    while time.monotonic() < settle:
                        log = max((read_text(log_path), read_text(alternate)), key=len)
                        selftest_done = (not wait_selftest or re.search(
                            r"module selftest: (?:ok|FAILED)", log))
                        update_done = (not wait_update or
                                       "module auto-update: updated=" in log)
                        if (selftest_done and update_done and
                                time.monotonic() - init_at >= settle_floor):
                            break
                        time.sleep(1)
                    break
                time.sleep(1)
        finally:
            kill_profile_zotero(profile, proc.pid)
            try:
                proc.wait(timeout=15)
            except subprocess.TimeoutExpired:
                pass
        log = max((read_text(log_path), read_text(alternate), log), key=len)
        require("init complete" in log,
                "%s/%s 未出现 init complete；日志：\n%s" % (scenario, round_name, tail(log)))
        saved = self.output / ("%s-%s-boot.log" % (scenario, round_name))
        saved.write_text(log, encoding="utf-8")
        return log

    def registry_path(self, profile):
        return profile / "papilot" / "modules" / "installed.json"

    def registry(self, profile):
        path = self.registry_path(profile)
        require(path.is_file(), "注册表未落盘：%s" % path)
        return read_json(path)

    def cleanup(self, work):
        # 真机证据默认全部保留；也不做递归删除，避免误伤或触发批量删除闸门。
        return None

    def scenario_full(self):
        work, profile, data = self.workspace("full")
        try:
            log = self.run_zotero("full", "init", profile, data, self.full)
            require("STARTUP FAILED" not in log, "full init 出现 STARTUP FAILED")
            for marker in ("loadSubScript FAILED", "module loadModule FAILED",
                           "module runtime init FAILED"):
                require(marker not in log, "full init 出现 %s：\n%s" % (marker, tail(log)))
            print("✓ full：完整 XPI 初始化成功")
        finally:
            self.cleanup(work)

    def scenario_slim(self):
        work, profile, data = self.workspace("slim")
        server = None
        try:
            server, url, _ = start_catalog_server(work / "serve", self.version)
            first = self.run_zotero("slim", "install-pdf", profile, data, self.slim,
                                    url, "papilot-mod-pdf", wait_selftest=True)
            require(re.search(r"module selftest: ok " + re.escape(self.version), first),
                    "slim PDF 自检未成功：\n%s" % tail(first))
            require("module loaded papilot-mod-pdf@" + self.version in first,
                    "slim PDF 未热加载 0.78.0")
            require("module loadModule FAILED papilot-mod-pdf" not in first and
                    "业务脚本加载失败" not in first,
                    "slim PDF 出现业务脚本失败：\n%s" % tail(first))
            entry = self.registry(profile)["modules"].get("papilot-mod-pdf")
            require(entry and entry["version"] == self.version and not entry.get("broken"),
                    "slim PDF 注册表条目异常：%r" % entry)
            print("✓ slim：本地签名目录首装 PDF、热加载和注册表均成功")

            # 同版 broken 修复：直接破坏临时 profile 注册表，再经真实自检入口重装。
            reg_path = self.registry_path(profile)
            registry = read_json(reg_path)
            registry["modules"]["papilot-mod-pdf"]["broken"] = True
            write_json(reg_path, registry)
            second = self.run_zotero("slim", "repair-broken", profile, data, self.slim,
                                     url, "papilot-mod-pdf", wait_selftest=True)
            require(re.search(r"module selftest: ok " + re.escape(self.version), second),
                    "broken 同版重装未成功：\n%s" % tail(second))
            repaired = self.registry(profile)["modules"]["papilot-mod-pdf"]
            require(repaired["version"] == self.version and repaired.get("broken") is False,
                    "broken 同版重装未清 broken：%r" % repaired)
            print("✓ slim：broken 同版重装非 noop 且清 broken")
        finally:
            stop_server(server)
            self.cleanup(work)

    def seed_old_ai(self, profile):
        zip_path = ROOT / "dist" / "modules" / "papilot-mod-ai-0.74.1.zip"
        require(zip_path.is_file(), "缺少旧 AI 包：%s" % zip_path)
        module_dir = profile / "papilot" / "modules" / "papilot-mod-ai" / "0.74.1"
        module_dir.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(zip_path) as archive:
            archive.extractall(module_dir)
        now = datetime.datetime.now(datetime.timezone.utc).isoformat()
        write_json(self.registry_path(profile), {"schema": 1, "modules": {
            "papilot-mod-ai": {
                "version": "0.74.1", "dir": "papilot-mod-ai/0.74.1",
                "mode": "scope", "enabled": True, "broken": False,
                "installedAt": now, "updatedAt": now, "previous": None,
            },
        }})

    def catalog_cache_prefs(self, catalog_data, age_hours, last_host_version):
        timestamp = int((time.time() - age_hours * 3600) * 1000)
        raw = json.dumps({"ts": timestamp, "data": catalog_data},
                         ensure_ascii=False, separators=(",", ":"))
        return [
            'user_pref("extensions.zotero.papilot.modulesCatalogCache", %s);'
            % json.dumps(raw),
            'user_pref("extensions.zotero.papilot.modulesLastHostVersion", %s);'
            % json.dumps(last_host_version),
        ]

    def scenario_upgrade(self):
        work, profile, data = self.workspace("upgrade")
        server = None
        try:
            self.seed_old_ai(profile)
            server, url, index_path = start_catalog_server(work / "serve", self.version)
            current_catalog = read_json(index_path)
            old_catalog = json.loads(json.dumps(current_catalog))
            for module in old_catalog["modules"]:
                module["version"] = "0.78.0"
            old_cache = self.catalog_cache_prefs(old_catalog, 0.66, "0.78.0")
            first = self.run_zotero("upgrade", "old-scope", profile, data, self.full,
                                    url, wait_update=True, extra_prefs=old_cache)
            require(server.requestCounts.get("/index.json", 0) == 1,
                    "主包版本变化未强制刷新目录：index 请求数=%r，旧缓存会阻断升级" %
                    server.requestCounts)
            require("module scope deferred (host newer) papilot-mod-ai@0.74.1" in first,
                    "首轮未 deferred 旧 scope：\n%s" % tail(first))
            require("module loaded papilot-mod-ai@0.74.1" not in first,
                    "旧 AI 代码覆盖了新主包全局")
            require(re.search(r"module auto-update: updated=1 failed=0", first),
                    "首轮未自动升级 AI：\n%s" % tail(first))
            entry = self.registry(profile)["modules"].get("papilot-mod-ai")
            require(entry and entry["version"] == self.version,
                    "自动更新后注册表不是 0.78.0：%r" % entry)
            fresh_cache = self.catalog_cache_prefs(current_catalog, 0.01, self.version)
            before_second = server.requestCounts.get("/index.json", 0)
            second = self.run_zotero("upgrade", "new-scope", profile, data, self.full, url,
                                     extra_prefs=fresh_cache, settle_floor=5)
            require("module loaded papilot-mod-ai@" + self.version in second,
                    "第二轮未加载新 AI：\n%s" % tail(second))
            require("module scope deferred (host newer) papilot-mod-ai" not in second,
                    "第二轮仍 deferred 新 AI")
            require(server.requestCounts.get("/index.json", 0) == before_second,
                    "同版本启动仍强制访问目录：index 请求 %s → %s" %
                    (before_second, server.requestCounts.get("/index.json", 0)))
            print("✓ upgrade：旧缓存下主包升级强制刷新；同版本二次启动读缓存并加载 " + self.version)
        finally:
            stop_server(server)
            self.cleanup(work)

    def assert_install_rejected(self, name, log, profile, needle, module_id):
        require("module selftest: FAILED" in log and needle in log,
                "%s 未按预期拒绝（缺 %s）：\n%s" % (name, needle, tail(log)))
        path = self.registry_path(profile)
        if path.exists():
            registry = read_json(path)
            require(module_id not in (registry.get("modules") or {}),
                    "%s 被拒后仍写注册表" % name)
        print("✓ tamper：%s 拒绝且未写注册表" % name)

    def scenario_tamper(self):
        for kind in ("signature", "zip-hash"):
            work, profile, data = self.workspace("tamper-" + kind)
            server = None
            try:
                server, url, index_path = start_catalog_server(work / "serve", self.version)
                index = read_json(index_path)
                # 使用内置快照中不存在的 id，防止坏目录被拒绝后回落 builtin 并访问公网。
                module_id = "papilot-mod-e2e-tamper"
                entry = json.loads(json.dumps(next(
                    x for x in index["modules"] if x["id"] == "papilot-mod-pdf")))
                entry["id"] = module_id
                entry["name"] = module_id
                entry["manifest"]["github"] = url.rsplit("/", 1)[0] + "/modules/" + module_id + "/module.json"
                manifest = read_json(ROOT / "modules" / "papilot-mod-pdf" / "module.json")
                manifest["id"] = module_id
                write_json(work / "serve" / "modules" / module_id / "module.json", manifest)
                index["modules"] = [entry]
                write_json(index_path, index)
                sign_index(index_path)
                entry["zipSha256"] = "0" * 64
                write_json(index_path, index)
                if kind == "signature":
                    needle = "签名"               # 改签名载荷，不重新签名。
                else:
                    sign_index(index_path)         # 签名有效，但包 hash 不符。
                    needle = "完整性校验失败"
                log = self.run_zotero("tamper-" + kind, "rejected", profile, data,
                                      self.slim, url, module_id, wait_selftest=True)
                self.assert_install_rejected(kind, log, profile, needle, module_id)
            finally:
                stop_server(server)
                self.cleanup(work)

    def assert_matrix_log(self, log, module_id, loaded_ids, round_name):
        require("module selftest: FAILED" not in log,
                "%s/%s 自检失败：\n%s" % (module_id, round_name, tail(log)))
        for marker in ("业务脚本加载失败", "module loadModule FAILED"):
            require(marker not in log,
                    "%s/%s 出现 %s：\n%s" % (module_id, round_name, marker, tail(log)))
        for loaded_id in loaded_ids:
            expected = "module loaded %s@%s" % (loaded_id, self.version)
            require(expected in log,
                    "%s/%s 缺真实加载日志 %s：\n%s" %
                    (module_id, round_name, expected, tail(log)))

    def assert_matrix_registry(self, profile, module_id, registry_ids):
        modules = self.registry(profile).get("modules") or {}
        for registry_id in registry_ids:
            entry = modules.get(registry_id)
            require(entry and entry.get("version") == self.version,
                    "%s 注册表缺 %s@%s：%r" %
                    (module_id, registry_id, self.version, entry))
            require(entry.get("broken") is False,
                    "%s 注册表 %s broken!=false：%r" % (module_id, registry_id, entry))

    def scenario_matrix(self):
        manifests = {read_json(path)["id"]: read_json(path)
                     for path in sorted((ROOT / "modules").glob("*/module.json"))}
        require(len(manifests) == 9, "矩阵应覆盖 9 个组件，实际 %d" % len(manifests))
        bundle_path = ROOT / "bundles" / "papilot-bundle-basic" / "module.json"
        bundle = read_json(bundle_path)
        bundle_id = bundle["id"]
        known = list(manifests) + [bundle_id]
        selected = self.args.matrix_id or known
        unknown = [mid for mid in selected if mid not in known]
        require(not unknown, "未知 matrix-id：%s" % ", ".join(unknown))
        server = None
        try:
            # 所有案例共用一个只读本地签名目录，但每个案例使用全新独立 profile。
            server, url, _ = start_catalog_server(self.output / "matrix-serve", self.version)
            for module_id in selected:
                work, profile, data = self.workspace("matrix-" + module_id)
                is_bundle = module_id == bundle_id
                loaded_ids = list(bundle.get("modules") or []) if is_bundle else [module_id]
                registry_ids = ([module_id] + loaded_ids) if is_bundle else [module_id]
                require(loaded_ids, "合集没有成员：%s" % module_id)
                try:
                    first = self.run_zotero("matrix-" + module_id, "install",
                                            profile, data, self.slim, url, module_id,
                                            wait_selftest=True)
                    require(re.search(r"module selftest: ok " + re.escape(self.version), first),
                            "%s 首装 selftest 未成功：\n%s" % (module_id, tail(first)))
                    self.assert_matrix_log(first, module_id, loaded_ids, "首装")
                    self.assert_matrix_registry(profile, module_id, registry_ids)

                    second = self.run_zotero("matrix-" + module_id, "restart",
                                             profile, data, self.slim, url)
                    self.assert_matrix_log(second, module_id, loaded_ids, "二次启动")
                    self.assert_matrix_registry(profile, module_id, registry_ids)
                    print("✓ matrix：%s 首装与二次启动均 loaded、broken=false" % module_id)
                finally:
                    self.cleanup(work)
        finally:
            stop_server(server)

    def scenario_corrupt(self):
        work, profile, data = self.workspace("corrupt")
        try:
            reg_path = self.registry_path(profile)
            reg_path.parent.mkdir(parents=True, exist_ok=True)
            original = '{"schema":1,"modules":'
            reg_path.write_text(original, encoding="utf-8")
            log = self.run_zotero("corrupt", "preserved", profile, data, self.full)
            backups = list(reg_path.parent.glob("installed.json.corrupt-*"))
            require(backups, "损坏注册表未生成 .corrupt-* 备份")
            require(any(read_text(p) == original for p in backups),
                    "损坏备份内容与原文不一致")
            require(reg_path.read_text(encoding="utf-8") == original,
                    "损坏 installed.json 被空表覆盖")
            require("module registry corrupt" in log and "module runtime init FAILED" in log,
                    "损坏注册表未明确写 boot 诊断：\n%s" % tail(log))
            print("✓ corrupt：保留原文和 .corrupt-*，未静默空表覆盖")
        finally:
            self.cleanup(work)


def tail(log, count=35):
    lines = [line for line in log.splitlines() if line.strip()]
    return "\n".join(lines[-count:])


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--version", default="0.78.2")
    parser.add_argument("--full", default=str(ROOT / "dist" / "papilot-0.78.2.xpi"))
    parser.add_argument("--slim", default=str(ROOT / "dist" / "papilot-0.78.2-slim.xpi"))
    parser.add_argument("--zotero", default=str(DEFAULT_ZOTERO))
    parser.add_argument("--scenario", action="append", choices=SCENARIOS,
                        help="只跑指定场景；可重复。默认全部（tamper 含两种反向目录）")
    parser.add_argument("--matrix-id", action="append", default=[],
                        help="matrix 只跑指定组件/合集 id；可重复，默认 9 个组件+basic 合集")
    parser.add_argument("--timeout", type=int, default=180, help="单轮启动最长秒数")
    parser.add_argument("--settle", type=int, default=75, help="init 后异步安装/更新最长秒数")
    parser.add_argument("--keep", action="store_true", help="保留独立 profile（兼容参数；当前始终保留证据）")
    parser.add_argument("--output", default="", help="日志目录，默认 build/verify/modules-e2e-<时间戳>")
    return parser.parse_args()


def main():
    args = parse_args()
    # 输入未齐时绝不启动 Zotero。
    validate_xpi(args.full, args.version)
    validate_xpi(args.slim, args.version)
    require(Path(args.zotero).is_file(), "找不到 Zotero：%s" % args.zotero)
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    output = Path(args.output) if args.output else ROOT / "build" / "verify" / ("modules-e2e-" + stamp)
    harness = Harness(args, output)
    selected = args.scenario or list(SCENARIOS)
    results = []
    for name in selected:
        try:
            getattr(harness, "scenario_" + name)()
            results.append({"scenario": name, "ok": True})
        except Exception as exc:  # 继续跑独立场景，最终汇总精确失败点。
            detail = traceback.format_exc()
            results.append({"scenario": name, "ok": False, "error": str(exc), "traceback": detail})
            print("✗ %s：%s\n%s" % (name, exc, detail), file=sys.stderr)
    summary = {"version": args.version, "results": results,
               "allPassed": all(x["ok"] for x in results)}
    write_json(output / "summary.json", summary)
    print("日志与判定：%s" % output)
    if not summary["allPassed"]:
        raise SystemExit(1)
    print("✓ 所有选定真实 Zotero 组件链场景通过")


if __name__ == "__main__":
    try:
        main()
    except ScenarioFailure as exc:
        print("✗ " + str(exc), file=sys.stderr)
        raise SystemExit(2)
