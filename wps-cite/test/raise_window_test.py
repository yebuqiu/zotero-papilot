#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Zotero 引文窗口置顶：标题、进程、句柄与连续置顶序列回归。"""
import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("ppc_proxy_raise", ROOT / "proxy" / "proxy.py")
proxy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proxy)


class FakeUser32:
    def __init__(self, foreground=True, topmost=True):
        self.foreground = foreground
        self.topmost = topmost
        self.calls = []

    def ShowWindow(self, hwnd, flag):
        self.calls.append(("show", hwnd))
        return 0

    def SetWindowPos(self, hwnd, after, x, y, cx, cy, flags):
        self.calls.append(("topmost", hwnd))
        return 1 if self.topmost else 0

    def SetForegroundWindow(self, hwnd):
        self.calls.append(("foreground", hwnd))
        return 1 if self.foreground else 0

    def BringWindowToTop(self, hwnd):
        self.calls.append(("bring", hwnd))
        return 1


def run_sequence(windows, stabilize=0, verify=None, timeout=0.2):
    calls = list(windows)
    titles = {row[0]: row[1] for snapshot in calls for row in snapshot}

    def enum():
        return calls.pop(0) if len(calls) > 1 else calls[0]

    def default_verify(hwnd, kind):
        title = titles.get(hwnd, "")
        return proxy._window_is_citation(title) if kind == "citation" else proxy._window_is_prefs(title)

    u = FakeUser32()
    result = proxy.raise_zotero_dialog(timeout=timeout, interval=0.001, user32=u, enum=enum,
                                      stabilize=stabilize, verify=verify or default_verify)
    return result, u.calls


def main():
    checks = []

    def check(name, condition):
        if not condition:
            raise AssertionError(name)
        checks.append(name)
        print("  PASS " + name)

    main_window = (10, "Zotero", 1200, 800)
    prefs = (20, "Document Preferences", 600, 400)
    citation = (30, "Add/Edit Citation", 700, 120)
    result, calls = run_sequence([[main_window], [main_window, prefs], [main_window, prefs, citation]])
    check("首选项之后继续等待并置顶真正的引文选择框", result.get("ok") and result.get("title") == "Add/Edit Citation")
    check("首选项与引文框按顺序都执行置顶", [x[1] for x in calls if x[0] == "topmost"] == [20, 30])

    result, calls = run_sequence([[main_window], [main_window, (40, "添加/编辑引文", 700, 120)]])
    check("中文引文框可直接识别", result.get("ok") and result.get("title") == "添加/编辑引文")

    result, calls = run_sequence([[main_window, citation]])
    check("已存在的引文框也能重新置顶", result.get("ok") and result.get("kind") == "keyword")

    result, calls = run_sequence([[], [main_window], [main_window, citation]])
    check("插入期间新出现的 Zotero 主窗口不被选中", result.get("ok") and [x[1] for x in calls if x[0] == "topmost"] == [30])

    result, calls = run_sequence([[main_window], [main_window]])
    check("只有主窗口时超时且不执行任何窗口操作", result.get("ok") is False and calls == [])

    unknown = (40, "Notes - Zotero", 900, 650)
    result, calls = run_sequence([[main_window], [main_window, unknown]])
    check("未知新窗口不再走兜底置顶", result.get("ok") is False and calls == [])

    foreign = (99, "Add/Edit Citation", 700, 120)
    result, calls = run_sequence([[foreign]], verify=lambda hwnd, kind: False)
    check("同名其他进程窗口也不允许操作", result.get("ok") is False and calls == [])

    check("标题只接受精确弹窗名，拒绝 citation 子串误匹配",
          proxy._window_is_citation("Add/Edit Citation - Zotero")
          and proxy._window_is_citation(" 插入引用 ")
          and proxy._window_is_citation("引注对话框")
          and proxy._window_is_citation("Citation Dialog")
          and not proxy._window_is_citation("Citation management - Zotero")
          and not proxy._window_is_citation("Zotero citation")
          and not proxy._window_is_citation("Citations"))

    u = FakeUser32(foreground=False)
    result = proxy.raise_zotero_dialog(timeout=0.2, interval=0.001, user32=u,
                                      enum=lambda: [main_window, citation], stabilize=0,
                                      verify=lambda hwnd, kind: True)
    check("前台权限被拒时仍报告置顶成功并记录 foreground=false", result.get("ok") and result.get("foreground") is False)

    u = FakeUser32(topmost=False)
    result = proxy.raise_zotero_dialog(timeout=0.2, interval=0.001, user32=u,
                                      enum=lambda: [main_window, citation], stabilize=0,
                                      verify=lambda hwnd, kind: True)
    check("SetWindowPos 失败不得假报成功", result.get("ok") is False)

    old_matches = proxy._window_matches_kind
    try:
        proxy._window_matches_kind = lambda u, hwnd, kind: True
        u = FakeUser32()
        result = proxy.raise_zotero_dialog(timeout=0.2, interval=0.001, user32=u,
                                          enum=lambda: [main_window, citation], stabilize=0)
        check("生产默认验证器正确绑定 user32", result.get("ok") and any(x[0] == "topmost" and x[1] == 30 for x in u.calls))
    finally:
        proxy._window_matches_kind = old_matches

    result, calls = run_sequence([[main_window, citation]], stabilize=0.025)
    check("目标弹窗连续重设 TOPMOST 但不重复抢焦点",
          result.get("ok") and result.get("reasserted", 0) > 0
          and len([x for x in calls if x[0] == "foreground"]) == 1
          and all(x[1] == 30 for x in calls))

    verify_count = [0]
    def closed_verify(hwnd, kind):
        verify_count[0] += 1
        return verify_count[0] == 1
    result, calls = run_sequence([[main_window, citation]], stabilize=0.025, verify=closed_verify)
    check("弹窗关闭或句柄变化后停止，不重选其他窗口",
          result.get("ok") and result.get("closed") is True
          and [x[1] for x in calls if x[0] == "topmost"] == [30])

    class FakeWinApi:
        def __init__(self, title, visible=True):
            self.title = title
            self.visible = visible
        def IsWindowVisible(self, hwnd):
            return self.visible
        def GetWindowTextLengthW(self, hwnd):
            return len(self.title)
        def GetWindowTextW(self, hwnd, buf, size):
            buf.value = self.title
            return len(self.title)
        def GetWindowThreadProcessId(self, hwnd, pid):
            pid._obj.value = 123

    old_process = proxy._proc_image_name
    try:
        proxy._proc_image_name = lambda pid: "zotero.exe"
        check("操作前复核通过：同进程、可见、精确引文标题",
              proxy._window_matches_kind(FakeWinApi("Add/Edit Citation"), 30, "citation"))
        proxy._proc_image_name = lambda pid: "chrome.exe"
        check("操作前复核拒绝其他进程", not proxy._window_matches_kind(FakeWinApi("Add/Edit Citation"), 30, "citation"))
        proxy._proc_image_name = lambda pid: "zotero.exe"
        check("操作前复核拒绝主窗口标题和不可见句柄",
              not proxy._window_matches_kind(FakeWinApi("Zotero"), 10, "citation")
              and not proxy._window_matches_kind(FakeWinApi("Add/Edit Citation", visible=False), 30, "citation"))
    finally:
        proxy._proc_image_name = old_process

    print("\n通过 %d 项，全部通过" % len(checks))


if __name__ == "__main__":
    main()
