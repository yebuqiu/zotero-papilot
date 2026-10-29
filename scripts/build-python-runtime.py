#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 Cassiuschen. All rights reserved.
"""Papilot Cite · 便携 Python 运行时构建（0.87.0）

问题：WPS 集成靠 %APPDATA%\\PapilotCite\\proxy.py 起 21932 代理，而这个脚本要解释器。
     开发机装了 Python 3，别人的电脑没有 —— 报「找不到 pythonw.exe」。
     代理只用标准库（无 pywin32/无第三方包），所以官方便携版裁剪后即可离线跑。

做法：
  1. 下载 python-3.12.x-embed-amd64.zip（华为云镜像优先，python.org 兜底）；
  2. 裁掉代理用不到的东西（ssl/sqlite/bz2/lzma/多进程… + stdlib 里的 test/tkinter/email 之外的大块）；
  3. 重新打包成约 6MB 的 zip，写进 server/public/dl/（部署时随服务端走，不入 git）；
  4. 产出 chrome/content/tools/py-runtime.json —— 插件端据此知道下哪个文件、校验什么 sha256。

为什么不直接下官方 zip 让插件解压：11MB → 6MB，用户只为一个本地代理多下 5MB 没道理；
   裁剪项都是**代理从不 import**的模块（见 _PROXY_IMPORTS 的自检兜底）。

用法：
    python scripts/build-python-runtime.py            # 幂等：zip 与清单都在且校验通过就跳过
    python scripts/build-python-runtime.py --force    # 强制重下重打
    python scripts/build-python-runtime.py --check    # 只校验现有产物与清单是否一致（CI/发版用）

退役提醒：改裁剪名单前先跑一次 `--force`，并用 dist/runtime/probe 里的解释器执行
    `<probe>/python.exe wps-cite/proxy/proxy.py status`（端口在跑时返回 running 即通过）。
"""

import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

PY_VER = "3.12.10"
SRC_NAME = "python-%s-embed-amd64.zip" % PY_VER
SRC_URLS = [
    "https://mirrors.huaweicloud.com/python/%s/%s" % (PY_VER, SRC_NAME),
    "https://registry.npmmirror.com/-/binary/python/%s/%s" % (PY_VER, SRC_NAME),
    "https://www.python.org/ftp/python/%s/%s" % (PY_VER, SRC_NAME),
]

# 产物
OUT_ZIP = os.path.join(ROOT, "server", "public", "dl", "papilot-python-embed-win64.zip")
MANIFEST = os.path.join(ROOT, "chrome", "content", "tools", "py-runtime.json")
CACHE_DIR = os.path.join(ROOT, "dist", "runtime")
CACHE_ZIP = os.path.join(CACHE_DIR, SRC_NAME)
PROBE_DIR = os.path.join(CACHE_DIR, "probe")

RUNTIME_ID = "py312-win64-embed"
DOWNLOAD_NAME = "papilot-python-embed-win64.zip"
PUBLIC_URLS = [
    "https://pp.xinglintools.top/dl/" + DOWNLOAD_NAME,
]

# ① 顶层删：这些 .pyd/.dll 对应代理从不 import 的模块。
#    libcrypto/libssl 是体积大头（压缩后约 2.8MB），代理只连 127.0.0.1 明文 HTTP。
DROP_TOP = {
    "libcrypto-3.dll", "libssl-3.dll", "_ssl.pyd",
    "sqlite3.dll", "_sqlite3.pyd",
    "python.cat",              # 目录签名，运行不需要
    "_bz2.pyd", "_lzma.pyd", "_decimal.pyd", "_msi.pyd", "_wmi.pyd",
    "_multiprocessing.pyd", "_asyncio.pyd", "_overlapped.pyd",
    "winsound.pyd", "_zoneinfo.pyd", "_uuid.pyd", "_hashlib.pyd",
}

# ② python312.zip（stdlib）内删的目录前缀。
#    ★ email/ 不能删：urllib.request 会 import email（试过，删了就 ModuleNotFoundError）。
#    ★ encodings/ 不能删：删了连解释器都起不来（init_fs_encoding 失败）。
DROP_STDLIB = (
    "test/", "unittest/", "idlelib/", "tkinter/", "pydoc_data/", "lib2to3/",
    "ensurepip/", "venv/", "distutils/", "multiprocessing/", "asyncio/",
    "sqlite3/", "ssl.py", "curses/", "dbm/", "turtledemo/", "wsgiref/",
    "concurrent/", "lib2to3/",
)

# ③ 冒烟断言：代理真正 import 的模块（改 proxy.py 的 import 时同步这里）
_PROXY_IMPORTS = [
    "base64", "json", "logging", "os", "platform", "re", "socket", "sys",
    "threading", "time", "urllib.error", "urllib.request", "unicodedata",
    "zipfile", "ctypes",
]


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def read_manifest():
    try:
        with io.open(MANIFEST, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def download(force=False):
    os.makedirs(CACHE_DIR, exist_ok=True)
    if os.path.exists(CACHE_ZIP) and not force:
        print("源包已缓存：%s" % os.path.relpath(CACHE_ZIP, ROOT))
        return
    last = None
    for url in SRC_URLS:
        try:
            print("下载 %s" % url)
            req = urllib.request.Request(url, headers={"User-Agent": "papilot-build/1.0"})
            with urllib.request.urlopen(req, timeout=180) as r, open(CACHE_ZIP, "wb") as f:
                shutil.copyfileobj(r, f)
            print("  → %.1f MB" % (os.path.getsize(CACHE_ZIP) / 1048576))
            return
        except Exception as e:                     # 逐个镜像试，全失败才报错
            last = e
            print("  失败：%s" % e)
    raise SystemExit("源包下载失败（全部镜像）：%s" % last)


def build_slim(src_zip, dst_zip):
    """解官方便携包 → 按名单裁剪 → 重新打包"""
    tmp = tempfile.mkdtemp(prefix="pp-py-")
    try:
        with zipfile.ZipFile(src_zip) as z:
            z.extractall(tmp)

        for name in sorted(DROP_TOP):
            p = os.path.join(tmp, name)
            if os.path.exists(p):
                os.remove(p)

        stdlib = os.path.join(tmp, "python312.zip")
        with zipfile.ZipFile(stdlib) as z:
            keep = [(n, z.read(n)) for n in z.namelist() if not n.startswith(DROP_STDLIB)]
        os.remove(stdlib)
        with zipfile.ZipFile(stdlib, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
            for n, data in keep:
                z.writestr(n, data)

        # 包内自带的 _pth 决定 sys.path（embeddable 的 isolated 模式）；
        # 保留原样即可 —— 它已经把 python312.zip 与当前目录都加进去了。
        os.makedirs(os.path.dirname(dst_zip), exist_ok=True)
        with zipfile.ZipFile(dst_zip, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as out:
            for dp, _dn, fn in os.walk(tmp):
                for f in sorted(fn):
                    p = os.path.join(dp, f)
                    rel = os.path.relpath(p, tmp).replace(os.sep, "/")
                    info = zipfile.ZipInfo(rel, date_time=(2026, 1, 1, 0, 0, 0))
                    info.compress_type = zipfile.ZIP_DEFLATED
                    info.external_attr = 0o644 << 16
                    with open(p, "rb") as fh:
                        out.writestr(info, fh.read())
        print("裁剪打包：%s（%.2f MB，%d 个条目）"
              % (os.path.relpath(dst_zip, ROOT), os.path.getsize(dst_zip) / 1048576,
                 len(zipfile.ZipFile(dst_zip).namelist())))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def probe(dst_zip):
    """解压到 dist/runtime/probe 真跑一次：解释器能起、代理依赖能 import"""
    shutil.rmtree(PROBE_DIR, ignore_errors=True)
    os.makedirs(PROBE_DIR, exist_ok=True)
    with zipfile.ZipFile(dst_zip) as z:
        z.extractall(PROBE_DIR)
    exe = os.path.join(PROBE_DIR, "python.exe")
    pyw = os.path.join(PROBE_DIR, "pythonw.exe")
    if not os.path.exists(exe) or not os.path.exists(pyw):
        raise SystemExit("裁剪结果缺少 python.exe / pythonw.exe")
    code = "import %s; print('imports ok')" % ", ".join(_PROXY_IMPORTS)
    r = subprocess.run([exe, "-c", code], capture_output=True, text=True)
    if r.returncode != 0:
        raise SystemExit("冒烟失败（代理依赖 import 不通）：\n%s\n%s" % (r.stdout, r.stderr))
    print("冒烟通过：%s（%s）" % (r.stdout.strip(), os.path.basename(exe)))


def write_manifest(dst_zip):
    with zipfile.ZipFile(dst_zip) as z:
        entries = [i.filename for i in z.infolist() if not i.filename.endswith("/")]
    man = {
        "schema": 1,
        "id": RUNTIME_ID,
        "pythonVersion": PY_VER,
        "label": "Python %s（Windows x64 便携运行环境，已裁剪）" % PY_VER,
        "downloadName": DOWNLOAD_NAME,
        "urls": PUBLIC_URLS,
        "bytes": os.path.getsize(dst_zip),
        "sha256": sha256_of(dst_zip),
        "unpackDir": "python",
        # ★ 显式条目清单：插件端只按这份名单解压，不依赖 nsIZipReader 的目录枚举
        #   （枚举 API 在不同 Zotero/Gecko 版本行为不一致，清单是可测的单一真源）
        "entries": entries,
        "builtAt": __import__("datetime").datetime.now(
            __import__("datetime").timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": "https://www.python.org/ftp/python/%s/%s" % (PY_VER, SRC_NAME),
    }
    os.makedirs(os.path.dirname(MANIFEST), exist_ok=True)
    with io.open(MANIFEST, "w", encoding="utf-8", newline="\n") as f:
        f.write(json.dumps(man, ensure_ascii=False, indent=2) + "\n")
    print("清单：%s（sha256 %s…）"
          % (os.path.relpath(MANIFEST, ROOT), man["sha256"][:16]))
    return man


def main():
    force = "--force" in sys.argv
    check_only = "--check" in sys.argv

    if check_only:
        man = read_manifest()
        if not man:
            raise SystemExit("缺少清单 %s —— 先跑 python scripts/build-python-runtime.py"
                             % os.path.relpath(MANIFEST, ROOT))
        if not os.path.exists(OUT_ZIP):
            raise SystemExit("缺少运行时产物 %s（部署服务端前必须先生成）"
                             % os.path.relpath(OUT_ZIP, ROOT))
        got = sha256_of(OUT_ZIP)
        if got != man.get("sha256"):
            raise SystemExit("产物与清单不一致：清单 %s / 实际 %s" % (man.get("sha256"), got))
        print("✓ 运行时产物与清单一致（%s，%.2f MB）"
              % (man.get("pythonVersion"), os.path.getsize(OUT_ZIP) / 1048576))
        return

    man = read_manifest()
    if (man and os.path.exists(OUT_ZIP) and not force
            and man.get("sha256") == sha256_of(OUT_ZIP)
            and man.get("pythonVersion") == PY_VER):
        print("已是最新（%s，%.2f MB）；要重做加 --force"
              % (man.get("pythonVersion"), os.path.getsize(OUT_ZIP) / 1048576))
        return

    download(force)
    build_slim(CACHE_ZIP, OUT_ZIP)
    probe(OUT_ZIP)
    write_manifest(OUT_ZIP)
    print("完成：把 %s 部署到服务端 public/dl/ 后，插件端的「安装运行环境」即可下载。"
          % os.path.relpath(OUT_ZIP, ROOT))


if __name__ == "__main__":
    main()
