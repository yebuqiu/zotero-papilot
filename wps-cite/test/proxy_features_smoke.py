#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""新增代理能力：快照、命令数据、跨文档台账与连接修复。"""
import json
import logging
import os
import shutil
import subprocess
import sys
import tempfile

logging.disable(logging.WARNING)
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "proxy"))
import proxy  # noqa: E402

TMP = tempfile.mkdtemp(prefix="papilot-feature-smoke-")
passed = 0
failed = []


def check(condition, label):
    global passed
    if condition:
        passed += 1
        print("  PASS " + label)
    else:
        failed.append(label)
        print("  FAIL " + label)


try:
    proxy.HOME = TMP
    proxy.CONFIG = os.path.join(TMP, "config.json")
    proxy.LINKS = os.path.join(TMP, "links.json")
    proxy._COMMANDS[:] = []
    proxy._MANAGER.clear()

    payload = {"documentID": "C:/tmp/a.docx", "rows": [{"fieldID": "f1"}],
               "status": {"citationCount": 1}, "center": {"report": {"kind": "health"}},
               "locator": {"fieldID": "f1", "items": []}}
    proxy.manager_set(payload)
    got = proxy.manager_get("C:/tmp/a.docx")
    check(got["center"]["report"]["kind"] == "health" and got["locator"]["fieldID"] == "f1",
          "管理与检查/定位快照按文档往返")
    check(proxy.manager_get("C:/tmp/b.docx")["rows"] == [], "另一文档不会借用快照")

    proxy.command_push({"action": "repair-apply", "documentID": "C:/tmp/a.docx", "fieldID": "f1",
                        "data": {"confirmed": True, "key": "BBBB0002"}})
    command = proxy.command_pop("C:/tmp/a.docx")[0]
    check(command["data"]["confirmed"] is True and command["data"]["key"] == "BBBB0002", "重连确认与候选数据完整入队")
    check(proxy.command_pop("C:/tmp/a.docx") == [], "命令只弹出一次")
    try:
        proxy.command_push({"action": "arbitrary-code", "documentID": "C:/tmp/a.docx"})
        check(False, "未知命令必须拒绝")
    except ValueError:
        check(True, "未知命令必须拒绝")
    try:
        proxy.command_push({"action": "run-check", "documentID": "C:/tmp/a.docx", "data": {"x": "y" * 70000}})
        check(False, "超大命令数据必须拒绝")
    except ValueError:
        check(True, "超大命令数据必须拒绝")

    proxy.links_upsert("C:/tmp/a.docx", [{"itemKey": "AAAA0001", "page": 7, "text": "[1]"},
                                        {"itemKey": "AAAA0001", "page": 8, "text": "[2]"},
                                        {"itemKey": "BBBB0002", "page": 0, "text": "[3]"}])
    proxy.links_upsert("C:/tmp/b.docx", [{"itemKey": "AAAA0001", "page": 9, "text": "[1]"}])
    overview = proxy.links_overview()
    check(len(overview["records"]) == 4 and len(overview["documents"]) == 2, "跨文档总览保留全部台账记录")
    a = next(x for x in overview["documents"] if x["doc"] == "C:/tmp/a.docx")
    check(a["citationCount"] == 3 and a["uniqueItems"] == 2, "文档计数与唯一条目统计正确")
    check(all("token" not in row for row in overview["records"]), "总览不暴露内部书签 token")

    old_alive, old_api, old_exe = proxy.zotero_alive, proxy.local_api_ok, proxy._zotero_executable
    old_popen = subprocess.Popen
    calls = []
    try:
        proxy.zotero_alive = lambda: False
        proxy.local_api_ok = lambda: False
        proxy._zotero_executable = lambda: "C:/fake/Zotero/zotero.exe"
        subprocess.Popen = lambda args, cwd, close_fds: calls.append((args, cwd, close_fds))
        result = proxy.connection_repair({"action": "start-zotero"})
        check(result["started"] is True and calls[0][0] == ["C:/fake/Zotero/zotero.exe"], "只从固定解析出的路径启动 Zotero")
        check(calls[0][2] is True, "启动子进程不继承无关句柄")
        try:
            proxy.connection_repair({"action": "run-anything"})
            check(False, "连接修复拒绝任意动作")
        except ValueError:
            check(True, "连接修复拒绝任意动作")
    finally:
        proxy.zotero_alive, proxy.local_api_ok, proxy._zotero_executable = old_alive, old_api, old_exe
        subprocess.Popen = old_popen
finally:
    shutil.rmtree(TMP, ignore_errors=True)

print("\n通过 %d 项，失败 %d 项" % (passed, len(failed)))
sys.exit(1 if failed else 0)
