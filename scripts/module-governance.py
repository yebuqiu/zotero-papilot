#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 Cassiuschen. All rights reserved.
"""组件投稿、包与目录的确定性治理校验（仅标准库）。

纯函数返回 ``[{"code": ..., "path": ..., "message": ...}]``，CLI 将其格式化。
本工具不做安全审批，也不读取私钥或访问网络。
"""

import argparse
import hashlib
import io
import json
import re
import sys
import zipfile
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parent.parent
ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,63}$")
VERSION_RE = re.compile(r"^[0-9]+(?:\.[0-9]+){0,3}$")
SHA256_RE = re.compile(r"^[0-9a-fA-F]{64}$")
LEGACY_SCOPE_IDS = frozenset([
    "papilot-mod-pdf", "papilot-mod-ai", "papilot-mod-cnki",
    "papilot-mod-discovery", "papilot-mod-notes", "papilot-mod-meta",
    "papilot-mod-cite", "papilot-mod-sync", "papilot-mod-ui",
    "papilot-bundle-basic",
])
KNOWN_CAPABILITIES = frozenset(["storage", "events", "ui", "prefs", "ai"])
HOST_CAPABILITIES_V1 = frozenset(["storage", "events", "ui", "prefs"])
KNOWN_PERMISSIONS = frozenset(["storage", "network", "ai", "prefs", "filesystem", "ui"])
CATALOG_GOVERNANCE_FIELDS = (
    "version", "minHost", "apiVersion", "mode", "requires", "permissions", "depends",
    "author", "license", "origin", "sourceRevision", "repo", "bundle", "contains",
)


def problem(code, path, message):
    return {"code": code, "path": str(path), "message": message}


def is_valid_version(value):
    return isinstance(value, str) and bool(VERSION_RE.fullmatch(value))


def compare_version(left, right):
    """与宿主一致：数字点分、短版本补零；prerelease 明确不支持。"""
    if not is_valid_version(left) or not is_valid_version(right):
        raise ValueError("版本须为 1–4 段数字点分，不支持 prerelease")
    a = [int(x) for x in left.split(".")]
    b = [int(x) for x in right.split(".")]
    length = max(len(a), len(b))
    a += [0] * (length - len(a))
    b += [0] * (length - len(b))
    return (a > b) - (a < b)


def valid_zip_path(value):
    if not isinstance(value, str) or not value or "\\" in value:
        return False
    if value.startswith("/") or re.match(r"^[A-Za-z]:", value) or value.endswith("/"):
        return False
    parts = value.split("/")
    return all(part and part not in (".", "..") for part in parts)


def _string_list(value, path, allowed, errors):
    if value is None:
        return
    if not isinstance(value, list) or any(not isinstance(x, str) or not x for x in value):
        errors.append(problem("GOV-LIST", path, "必须是非空字符串数组"))
        return
    if len(set(value)) != len(value):
        errors.append(problem("GOV-DUPLICATE", path, "不允许重复项"))
    for item in value:
        if item not in allowed:
            errors.append(problem("GOV-VOCAB", path, "未知值 %r" % item))


def validate_manifest(manifest, path="manifest", legacy_scope_ids=LEGACY_SCOPE_IDS,
                      new_component=False):
    """校验组件或合集清单；不对合法非 JS 资源作扩展名限制。"""
    errors = []
    if not isinstance(manifest, dict):
        return [problem("GOV-SCHEMA", path, "清单必须是对象")]
    mid = manifest.get("id")
    if not isinstance(mid, str) or not ID_RE.fullmatch(mid):
        errors.append(problem("GOV-ID", path + ".id", "须为 2–64 位小写字母/数字/连字符"))
        mid = str(mid)
    if not is_valid_version(manifest.get("version")):
        errors.append(problem("GOV-VERSION", path + ".version", "仅支持 1–4 段数字点分"))
    if not is_valid_version(manifest.get("minHost")):
        errors.append(problem("GOV-HOST", path + ".minHost", "仅支持 1–4 段数字点分"))
    api = manifest.get("apiVersion")
    if isinstance(api, bool) or not isinstance(api, int) or api < 1 or api > 1:
        errors.append(problem("GOV-API", path + ".apiVersion", "当前仅支持宿主 API 1"))
    if manifest.get("origin") is not None and manifest.get("origin") not in ("official", "community"):
        errors.append(problem("GOV-ORIGIN", path + ".origin", "只接受 official/community"))
    if manifest.get("bundle"):
        if new_component:
            for field in ("author", "license", "origin", "sourceRevision"):
                if not isinstance(manifest.get(field), str) or not manifest.get(field).strip():
                    errors.append(problem("GOV-IDENTITY", path + "." + field, "新合集必须显式提供"))
        members = manifest.get("modules")
        if not isinstance(members, list) or not members:
            errors.append(problem("GOV-BUNDLE", path + ".modules", "合集成员必须是非空数组"))
        elif len(set(members)) != len(members):
            errors.append(problem("GOV-DUPLICATE", path + ".modules", "合集成员重复"))
        return errors
    mode = manifest.get("mode", "scope")
    if mode not in ("scope", "sandbox"):
        errors.append(problem("GOV-MODE", path + ".mode", "只接受 scope/sandbox"))
    if (new_component or mid not in legacy_scope_ids) and mode != "sandbox":
        errors.append(problem("GOV-SANDBOX", path + ".mode", "非冻结白名单的新组件必须 sandbox"))
    entry = manifest.get("entry", "")
    if mode == "sandbox" and not entry:
        errors.append(problem("GOV-ENTRY", path + ".entry", "sandbox 必须声明 entry"))
    _string_list(manifest.get("requires"), path + ".requires", KNOWN_CAPABILITIES, errors)
    for cap in manifest.get("requires") or []:
        if cap not in HOST_CAPABILITIES_V1:
            errors.append(problem("GOV-CAPABILITY", path + ".requires", "宿主 API v1 不提供 %r" % cap))
    _string_list(manifest.get("permissions"), path + ".permissions", KNOWN_PERMISSIONS, errors)
    depends = manifest.get("depends", [])
    if not isinstance(depends, list) or any(not isinstance(x, str) or not ID_RE.fullmatch(x) for x in depends):
        errors.append(problem("GOV-DEPEND", path + ".depends", "依赖必须是合法组件 id 数组"))
    elif mid in depends:
        errors.append(problem("GOV-DEPEND-SELF", path + ".depends", "组件不能依赖自身"))
    files = manifest.get("files")
    if not isinstance(files, list) or not files:
        errors.append(problem("GOV-FILES", path + ".files", "组件文件清单必须非空"))
        files = []
    seen = set()
    for index, item in enumerate(files):
        ipath = "%s.files[%d]" % (path, index)
        if not isinstance(item, dict):
            errors.append(problem("GOV-SCHEMA", ipath, "文件项必须是对象"))
            continue
        rel = item.get("path")
        if not valid_zip_path(rel):
            errors.append(problem("GOV-PATH", ipath + ".path", "须为安全的 POSIX 相对路径"))
            continue
        if rel in seen:
            errors.append(problem("GOV-DUPLICATE", ipath + ".path", "文件路径重复"))
        seen.add(rel)
        digest = item.get("sha256")
        if not isinstance(digest, str) or not SHA256_RE.fullmatch(digest):
            errors.append(problem("GOV-HASH", ipath + ".sha256", "必须是 64 位十六进制 sha256"))
        size = item.get("size")
        if isinstance(size, bool) or not isinstance(size, int) or size < 0:
            errors.append(problem("GOV-SIZE", ipath + ".size", "必须是非负整数"))
    if entry and entry not in seen:
        errors.append(problem("GOV-ENTRY", path + ".entry", "entry 必须包含在 files 中"))
    if new_component:
        for field in ("author", "license", "origin", "sourceRevision"):
            if not isinstance(manifest.get(field), str) or not manifest.get(field).strip():
                errors.append(problem("GOV-IDENTITY", path + "." + field, "新投稿必须显式提供"))
        if manifest.get("origin") == "official" and manifest.get("author") != "Papilot":
            errors.append(problem("GOV-IDENTITY", path + ".author", "官方组件作者须为 Papilot"))
        if manifest.get("origin") == "community" and manifest.get("author") == "Papilot":
            errors.append(problem("GOV-IDENTITY", path + ".author", "社区组件不得继承官方身份"))
    return errors


def validate_dependencies(manifests):
    errors = []
    by_id = {}
    for i, manifest in enumerate(manifests):
        mid = manifest.get("id")
        if mid in by_id:
            errors.append(problem("GOV-DUPLICATE-ID", "modules[%d].id" % i, "组件 id 重复：%s" % mid))
        by_id[mid] = manifest
    for mid, manifest in by_id.items():
        if manifest.get("bundle"):
            for dep in manifest.get("modules") or []:
                if dep not in by_id:
                    errors.append(problem("GOV-DEPEND-MISSING", mid + ".modules", "未知合集成员 %s" % dep))
                elif by_id[dep].get("bundle"):
                    errors.append(problem("GOV-BUNDLE-NEST", mid + ".modules", "不允许嵌套合集"))
                elif by_id[dep].get("version") != manifest.get("version"):
                    errors.append(problem("GOV-BUNDLE-VERSION", mid + ".modules", "合集与成员版本必须一致"))
        for dep in manifest.get("depends") or []:
            if dep not in by_id:
                errors.append(problem("GOV-DEPEND-MISSING", mid + ".depends", "未知依赖 %s" % dep))
    visiting, done = set(), set()

    def visit(mid, chain):
        if mid in visiting:
            errors.append(problem("GOV-DEPEND-CYCLE", mid, "依赖环：%s" % " -> ".join(chain + [mid])))
            return
        if mid in done or mid not in by_id:
            return
        visiting.add(mid)
        for dep in by_id[mid].get("depends") or []:
            visit(dep, chain + [mid])
        visiting.remove(mid)
        done.add(mid)

    for mid in by_id:
        visit(mid, [])
    return errors


def validate_map(document):
    errors = []
    if not isinstance(document, dict) or document.get("schema") != 1:
        return [problem("GOV-SCHEMA", "schema", "module-map schema 必须为 1")]
    mods = document.get("modules")
    if not isinstance(mods, list) or not mods:
        return [problem("GOV-SCHEMA", "modules", "modules 必须非空")]
    manifests = []
    owners = {}
    providers = {}
    for i, mod in enumerate(mods):
        mid = mod.get("id", "")
        normalized = {**mod, "version": mod.get("version", document.get("version")) if mod.get("version", document.get("version")) != "auto" else "0",
            "minHost": (mod.get("hostMin", mod.get("minHost", document.get("hostMin"))) if mod.get("hostMin", mod.get("minHost", document.get("hostMin"))) != "auto" else "0"),
            "apiVersion": mod.get("apiVersion", 1),
            "files": [{"path": p, "sha256": "0" * 64, "size": 0} for p in mod.get("files") or []]}
        errors.extend(validate_manifest(normalized, "modules[%d]" % i, new_component=mid not in LEGACY_SCOPE_IDS))
        for capability in mod.get("provides") or []:
            if capability in providers:
                errors.append(problem("GOV-DUPLICATE-PROVIDES", mid + ".provides",
                                      "与 %s 重复提供 %s" % (providers[capability], capability)))
            providers[capability] = mid
        for rel in mod.get("files") or []:
            if rel in owners:
                errors.append(problem("GOV-FILE-OWNER", mid + ".files", "与 %s 重复声明 %s" % (owners[rel], rel)))
            owners[rel] = mid
        manifests.append(normalized)
    bundles = document.get("bundles") or []
    for bundle in bundles:
        normalized = {**bundle, "version": bundle.get("version", document.get("version")) if bundle.get("version", document.get("version")) != "auto" else "0",
                      "minHost": bundle.get("hostMin", document.get("hostMin")) if bundle.get("hostMin", document.get("hostMin")) != "auto" else "0",
                      "apiVersion": 1, "bundle": True}
        errors.extend(validate_manifest(normalized, "bundles." + str(bundle.get("id")),
                                        new_component=bundle.get("id") not in LEGACY_SCOPE_IDS))
        manifests.append(normalized)
    errors.extend(validate_dependencies(manifests))
    return errors


def validate_zip(source, manifest):
    """精确核对 ZIP 集合、重复项、包内清单、逐文件 hash/size；支持路径或 bytes。"""
    errors = validate_manifest(manifest)
    try:
        zf = zipfile.ZipFile(source if isinstance(source, (str, Path)) else io.BytesIO(source))
    except (OSError, zipfile.BadZipFile, TypeError) as exc:
        return errors + [problem("GOV-ZIP", "zip", "无法读取 ZIP：%s" % exc)]
    with zf:
        infos = zf.infolist()
        names = [x.filename for x in infos]
        if len(set(names)) != len(names):
            errors.append(problem("GOV-ZIP-DUPLICATE", "zip", "ZIP 含重复条目"))
        for name in names:
            if not valid_zip_path(name):
                errors.append(problem("GOV-ZIP-PATH", "zip." + name, "非法 ZIP 路径"))
        expected = {"module.json"} | {f.get("path") for f in manifest.get("files") or []}
        if set(names) != expected:
            errors.append(problem("GOV-ZIP-SET", "zip", "ZIP 条目与 manifest 不精确一致；缺少=%s 额外=%s" %
                (sorted(expected - set(names)), sorted(set(names) - expected))))
        try:
            inner = json.loads(zf.read("module.json").decode("utf-8"))
            if inner != manifest:
                errors.append(problem("GOV-ZIP-MANIFEST", "zip.module.json", "包内清单与外部清单不一致"))
        except (KeyError, ValueError, UnicodeDecodeError) as exc:
            errors.append(problem("GOV-ZIP-MANIFEST", "zip.module.json", "包内清单不可读：%s" % exc))
        for item in manifest.get("files") or []:
            rel = item.get("path")
            try:
                data = zf.read(rel)
            except (KeyError, RuntimeError, zipfile.BadZipFile):
                continue
            if len(data) != item.get("size"):
                errors.append(problem("GOV-SIZE", "zip." + rel, "实际大小与清单不符"))
            if hashlib.sha256(data).hexdigest().lower() != str(item.get("sha256", "")).lower():
                errors.append(problem("GOV-HASH", "zip." + rel, "实际 sha256 与清单不符"))
    return errors


def validate_catalog(index):
    errors = []
    if not isinstance(index, dict) or index.get("schema") != 1 or not isinstance(index.get("modules"), list):
        return [problem("GOV-CATALOG", "catalog", "目录 schema/modules 非法")]
    if not is_valid_version(index.get("hostMin")):
        errors.append(problem("GOV-HOST", "catalog.hostMin", "目录 hostMin 非法"))
    seen = set()
    for i, entry in enumerate(index["modules"]):
        path = "catalog.modules[%d]" % i
        mid = entry.get("id")
        if mid in seen:
            errors.append(problem("GOV-DUPLICATE-ID", path + ".id", "目录 id 重复"))
        seen.add(mid)
        if not is_valid_version(entry.get("version")):
            errors.append(problem("GOV-VERSION", path + ".version", "目录版本非法"))
        if not isinstance(entry.get("zipSha256"), str) or not SHA256_RE.fullmatch(entry.get("zipSha256", "")):
            errors.append(problem("GOV-HASH", path + ".zipSha256", "目录必须有整包 sha256"))
        for field in ("mode", "requires", "permissions", "depends", "minHost"):
            if field not in entry:
                errors.append(problem("GOV-CATALOG-FIELD", path + "." + field, "公开目录缺治理字段"))
    return errors


def check_immutable(previous, current):
    """已发布目录是基线：相同 id+version 的 zipSha256 不得变化。"""
    errors = []
    old = {}
    for item in (previous or {}).get("modules", []):
        old.setdefault(item.get("id"), []).append(item)
    for entry in (current or {}).get("modules", []):
        for prior in old.get(entry.get("id"), []):
            try:
                same_version = compare_version(prior.get("version"), entry.get("version")) == 0
            except ValueError:
                same_version = prior.get("version") == entry.get("version")
            if same_version and prior.get("zipSha256") != entry.get("zipSha256"):
                errors.append(problem("GOV-IMMUTABLE", "%s@%s" % (entry.get("id"), entry.get("version")),
                    "同版内容不可变：旧 hash=%s 新 hash=%s" %
                    (prior.get("zipSha256"), entry.get("zipSha256"))))
    return errors


def format_errors(errors):
    return ["[%s] %s: %s" % (e["code"], e["path"], e["message"]) for e in errors]


def _load(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def main(argv=None):
    ap = argparse.ArgumentParser(description="组件治理离线校验（不替代人工安全审批）")
    ap.add_argument("--map", help="校验 module-map.json")
    ap.add_argument("--manifest", help="校验单个 module.json")
    ap.add_argument("--zip", dest="zip_path", help="配合 --manifest 校验 ZIP")
    ap.add_argument("--catalog", help="校验公开/内置目录")
    ap.add_argument("--against", help="已发布目录基线，配合 --catalog 检查不可变性")
    args = ap.parse_args(argv)
    if not any((args.map, args.manifest, args.catalog)):
        ap.error("至少指定 --map、--manifest 或 --catalog")
    if args.zip_path and not args.manifest:
        ap.error("--zip 必须配合 --manifest")
    if args.against and not args.catalog:
        ap.error("--against 必须配合 --catalog")
    errors = []
    try:
        if args.map:
            errors.extend(validate_map(_load(args.map)))
        if args.manifest:
            manifest = _load(args.manifest)
            errors.extend(validate_manifest(manifest) if not args.zip_path else
                          validate_zip(args.zip_path, manifest))
        if args.catalog:
            current = _load(args.catalog)
            errors.extend(validate_catalog(current))
            if args.against:
                errors.extend(check_immutable(_load(args.against), current))
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        errors.append(problem("GOV-INPUT", "input", str(exc)))
    for line in format_errors(errors):
        print(line, file=sys.stderr)
    if errors:
        print("治理校验失败：%d 项（自动检查不等于安全审批）" % len(errors), file=sys.stderr)
        return 1
    print("治理校验通过（仅结构/完整性，不代表安全审批通过）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
