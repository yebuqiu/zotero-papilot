#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 Cassiuschen. All rights reserved.
"""Papilot 组件目录发布工具（默认 dry-run，不建仓库、不上传）。

目录在主仓根，zip 按各自 version 放入 v<version> Release。独立版本不再借用
第一个组件的 version/minHost；合集要求成员同版本。stage 前硬校验签名与不可变性。
"""

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path

import importlib.util as _importlib_util
_spec = _importlib_util.spec_from_file_location(
    "module_governance", Path(__file__).resolve().with_name("module-governance.py"))
governance = _importlib_util.module_from_spec(_spec)
_spec.loader.exec_module(governance)

ROOT = Path(__file__).resolve().parent.parent
MODULES_DIR = ROOT / "modules"
ZIP_DIR = ROOT / "dist" / "modules"
INDEX_FILE = ROOT / "papilot-modules-index.json"
STAGE_DIR = ROOT / "build" / "modules-publish" / "dist"
GH = "https://github.com/yebuqiu/zotero-papilot"
GE = "https://gitee.com/cassiuschen9261/zotero-papilot"


def die(msg):
    print("✗ " + msg, file=sys.stderr)
    raise SystemExit(1)


def load_bundles():
    out = []
    bdir = ROOT / "bundles"
    if bdir.is_dir():
        for d in sorted(bdir.iterdir()):
            mf = d / "module.json"
            if mf.is_file():
                out.append(json.loads(mf.read_text(encoding="utf-8")))
    return out


def load_modules():
    if not MODULES_DIR.is_dir():
        die("modules/ 不存在，先跑 python scripts/build-module.py --all")
    out = []
    for d in sorted(MODULES_DIR.iterdir()):
        if d.is_dir():
            mf = d / "module.json"
            if not mf.is_file():
                die("缺少清单：%s" % mf)
            out.append(json.loads(mf.read_text(encoding="utf-8")))
    if not out:
        die("modules/ 下没有模块")
    return out


def zip_path_of(mod):
    return ZIP_DIR / ("%s-%s.zip" % (mod["id"], mod["version"]))


def verify(mod):
    zp = zip_path_of(mod)
    if not zp.is_file():
        return [governance.problem("GOV-ZIP-MISSING", mod["id"], "缺少 zip：%s" % zp)]
    if mod.get("zipSha256") and hashlib.sha256(zp.read_bytes()).hexdigest() != mod["zipSha256"]:
        return [governance.problem("GOV-HASH", mod["id"], "清单 zipSha256 与 zip 不符")]
    return governance.validate_zip(zp, mod)


def governance_fields(manifest):
    fields = ("minHost", "apiVersion", "mode", "requires", "permissions", "depends",
              "author", "license", "origin", "sourceRevision", "repo")
    return {key: manifest[key] for key in fields if key in manifest}


def release_tag(manifest):
    return str(manifest.get("releaseTag") or ("v" + manifest["version"]))


def index_entry(manifest, bundle=False):
    zp = zip_path_of(manifest)
    tag = release_tag(manifest)
    entry = {
        "id": manifest["id"], "name": manifest["name"], "version": manifest["version"],
        "description": manifest.get("description", ""),
        "mode": manifest.get("mode", "scope"),
        "requires": list(manifest.get("requires") or []),
        "permissions": list(manifest.get("permissions") or []),
        "depends": list(manifest.get("depends") or []),
        "sizeBytes": zp.stat().st_size,
        "zipSha256": hashlib.sha256(zp.read_bytes()).hexdigest(),
        "fileCount": 0 if bundle else len(manifest.get("files") or []),
        "tags": list(manifest.get("tags") or (["合集", "推荐"] if bundle else [])),
        "recommended": bool(manifest.get("recommended", bundle)),
        "pro": bool(manifest.get("pro")), "hot": bool(manifest.get("hot")),
        "whatsNew": manifest.get("whatsNew", ""),
        "globals": list(manifest.get("globals") or []),
        "download": {
            "github": "%s/releases/download/%s/%s" % (GH, tag, zp.name),
            "gitee": "%s/releases/download/%s/%s" % (GE, tag, zp.name),
        },
        "manifest": {
            "github": "%s/raw/main/%s/%s/module.json" % (GH, "bundles" if bundle else "modules", manifest["id"]),
            "gitee": "%s/raw/main/%s/%s/module.json" % (GE, "bundles" if bundle else "modules", manifest["id"]),
        },
        **governance_fields(manifest),
    }
    if bundle:
        entry.update({"bundle": True, "contains": list(manifest.get("modules") or [])})
    return entry


def build_index(mods, bundles=None):
    entries = [index_entry(m) for m in mods]
    for bundle in bundles or []:
        entries.insert(0, index_entry(bundle, True))
    host_min = min((m["minHost"] for m in entries if m.get("minHost")),
                   key=lambda v: [int(x) for x in v.split(".")])
    return {"schema": 1, "updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "hostMin": host_min, "modules": entries}


def verify_bundle(bundle, mods_by_id):
    problems = governance.validate_manifest(bundle)
    zp = zip_path_of(bundle)
    if not zp.is_file():
        return problems + [governance.problem("GOV-ZIP-MISSING", bundle["id"], "缺少合集 zip")]
    try:
        with zipfile.ZipFile(zp) as z:
            names = z.namelist()
            if len(set(names)) != len(names):
                problems.append(governance.problem("GOV-ZIP-DUPLICATE", bundle["id"], "合集 ZIP 有重复条目"))
            if any(not governance.valid_zip_path(name) for name in names):
                problems.append(governance.problem("GOV-ZIP-PATH", bundle["id"], "合集 ZIP 有非法路径"))
            expected = {"bundle.json"}
            for mid in bundle.get("modules") or []:
                if mid not in mods_by_id:
                    problems.append(governance.problem("GOV-DEPEND-MISSING", bundle["id"], "未知成员 " + mid))
                    continue
                member_manifest_path = mid + "/module.json"
                expected.add(member_manifest_path)
                if member_manifest_path in names:
                    inner = json.loads(z.read(member_manifest_path).decode("utf-8"))
                    problems.extend(governance.validate_manifest(
                        inner, bundle["id"] + "." + member_manifest_path))
                    if inner.get("id") != mid:
                        problems.append(governance.problem(
                            "GOV-ZIP-MANIFEST", bundle["id"] + "." + member_manifest_path,
                            "合集内层成员 id 与目录前缀不一致"))
                    if inner != mods_by_id[mid]:
                        problems.append(governance.problem(
                            "GOV-ZIP-MANIFEST", bundle["id"] + "." + member_manifest_path,
                            "合集内层成员清单与已审批外部清单不完整一致"))
                expected.update("%s/%s" % (mid, f["path"]) for f in mods_by_id[mid].get("files") or [])
            if set(names) != expected:
                problems.append(governance.problem("GOV-ZIP-SET", bundle["id"], "合集 ZIP 集合不精确一致"))
            if "bundle.json" in names and json.loads(z.read("bundle.json").decode("utf-8")) != bundle:
                problems.append(governance.problem("GOV-ZIP-MANIFEST", bundle["id"], "包内 bundle.json 不一致"))
            for name in expected - {"bundle.json"}:
                if name not in names or name.endswith("/module.json"):
                    continue
                mid, rel = name.split("/", 1)
                item = next(f for f in mods_by_id[mid]["files"] if f["path"] == rel)
                data = z.read(name)
                if len(data) != item["size"] or hashlib.sha256(data).hexdigest() != item["sha256"]:
                    problems.append(governance.problem("GOV-HASH", bundle["id"] + "." + name, "合集成员 hash/size 不符"))
    except (OSError, ValueError, zipfile.BadZipFile) as exc:
        problems.append(governance.problem("GOV-ZIP", bundle["id"], str(exc)))
    return problems


def main():
    ap = argparse.ArgumentParser(description="Papilot 组件目录发布（默认 dry-run）")
    ap.add_argument("--stage", action="store_true", help="写目录并汇总 zip")
    ap.add_argument("--verify", action="store_true", help="只校验清单与 zip，不写文件")
    args = ap.parse_args()
    mods, bundles = load_modules(), load_bundles()
    problems = governance.validate_dependencies(mods + bundles)
    for m in mods:
        problems += verify(m)
    for b in bundles:
        problems += verify_bundle(b, {m["id"]: m for m in mods})
    if problems:
        for line in governance.format_errors(problems):
            print("✗ " + line, file=sys.stderr)
        die("校验失败 %d 处" % len(problems))
    print("✓ %d 个模块清单与 zip 校验通过" % len(mods))
    index = build_index(mods, bundles)
    problems = governance.validate_catalog(index)
    if INDEX_FILE.is_file():
        previous = json.loads(INDEX_FILE.read_text(encoding="utf-8"))
        problems += governance.check_immutable(previous, index)
    if problems:
        die("目录治理失败：\n" + "\n".join(governance.format_errors(problems)))
    total = sum(e["sizeBytes"] for e in index["modules"])
    print("  目录条目 %d 个，组件包合计 %.1f KB（目录基线 hostMin %s）" %
          (len(index["modules"]), total / 1024.0, index["hostMin"]))
    for e in index["modules"]:
        print("  · %-26s %7.1f KB  %2d 文件  %s" %
              (e["id"], e["sizeBytes"] / 1024.0, e["fileCount"], release_tag(e)))
    if args.verify:
        return
    if not args.stage:
        print("\n[dry-run] 未写文件；加 --stage 生成目录并汇总 release 附件")
        return
    temporary_index = INDEX_FILE.with_name(INDEX_FILE.name + ".tmp")
    temporary_index.write_text(json.dumps(index, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    try:
        r = subprocess.run([os.environ.get("PP_NODE") or "node",
                            str(ROOT / "scripts" / "sign-modules-index.js"), str(temporary_index)],
                           capture_output=True, text=True, timeout=60)
        print("签名:", ((r.stdout or "") + (r.stderr or "")).strip())
        if r.returncode != 0:
            die("目录签名失败（exit=%s），stage 中止且公开目录未改" % r.returncode)
        os.replace(temporary_index, INDEX_FILE)
    except (OSError, subprocess.SubprocessError) as exc:
        die("目录签名命令失败：%s" % exc)
    finally:
        if temporary_index.exists():
            temporary_index.unlink()
    if STAGE_DIR.exists():
        shutil.rmtree(STAGE_DIR)
    STAGE_DIR.mkdir(parents=True)
    for manifest in mods + bundles:
        shutil.copy2(zip_path_of(manifest), STAGE_DIR / zip_path_of(manifest).name)
    groups = {}
    for manifest in mods + bundles:
        groups.setdefault(release_tag(manifest), []).append(zip_path_of(manifest).name)
    print("\n✓ 目录：%s；附件：%s（%d 个 zip）" %
          (INDEX_FILE.relative_to(ROOT).as_posix(), STAGE_DIR.relative_to(ROOT).as_posix(),
           sum(len(x) for x in groups.values())))
    for tag, names in sorted(groups.items()):
        print("  %s Release：%s" % (tag, "、".join(sorted(names))))
    print("上传后必须运行 patrol；自动校验通过不代表人工安全审批通过。")


if __name__ == "__main__":
    main()
