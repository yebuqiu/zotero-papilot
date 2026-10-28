#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""真实 Zotero 引文弹窗联调（手工运行，不进离线门禁）。

只输入检索文本并按 Esc 取消，不插入文献；协议走到 Document.complete。
运行：python wps-cite/test/raise_window_live.py
"""
import ctypes
import json
import sys
import threading
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "proxy"))
import proxy  # noqa: E402
try:
    import uiautomation as auto
except ImportError:
    auto = None

BASE = "http://127.0.0.1:23119"
DOC = "ppc-raise-live-1"
user32 = ctypes.windll.user32
user32.GetWindowLongW.argtypes = [ctypes.c_void_p, ctypes.c_int]
user32.GetWindowLongW.restype = ctypes.c_long
user32.GetForegroundWindow.restype = ctypes.c_void_p
user32.keybd_event.argtypes = [ctypes.c_ubyte, ctypes.c_ubyte, ctypes.c_ulong, ctypes.c_size_t]


def topmost(hwnd):
    return bool(user32.GetWindowLongW(ctypes.c_void_p(int(hwnd)), -16) & 0x8)


def key(vk):
    user32.keybd_event(vk, 0, 0, 0)
    user32.keybd_event(vk, 0, 2, 0)


def post(url, payload, timeout=8):
    req = urllib.request.Request(url, data=json.dumps(payload).encode(), method="POST",
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            raw = response.read().decode("utf-8", "replace")
            return response.status, json.loads(raw) if raw.strip().startswith("{") else raw
    except Exception as exc:
        return -1, str(exc)[:160]


def handle(cmd, args):
    if cmd == "Document.cursorInField":
        return False
    if cmd == "Document.canInsertField":
        return True
    if cmd == "Application.getActiveDocument":
        return {"documentID": DOC, "outputFormat": "html", "processorName": "WPS",
                "supportsCitationMerging": True, "supportsTextInsertion": True,
                "supportsImportExport": True, "supportedNotes": ["footnote"]}
    if cmd == "Document.insertField":
        return {"id": 1}
    if cmd == "Document.getFields":
        return []
    if cmd == "Document.getDocument":
        return {"docId": DOC, "text": "Papilot raise live test"}
    if cmd == "Document.getDocumentData":
        return ""
    if cmd == "Document.setDocumentData":
        return True
    return None


def cancel_dialog(hwnd):
    if auto:
        with auto.UIAutomationInitializerInThread():
            for win in auto.GetRootControl().GetChildren():
                if int(win.NativeWindowHandle) != int(hwnd):
                    continue
                stack = [win]
                while stack:
                    control = stack.pop()
                    if control.ControlTypeName == "ButtonControl" and (control.Name or "").strip() in {"取消", "Cancel"}:
                        control.GetInvokePattern().Invoke()
                        return True
                    stack.extend(control.GetChildren()[:120])
    key(0x1B)
    return False


def main():
    initial = {h: topmost(h) for h, title, w, hh in proxy._zotero_windows()}
    raise_result, ui_result, worker_errors, commands = [], [], [], []
    current_cmd = [None]
    finished = threading.Event()

    def raise_worker():
        try:
            raise_result.append(proxy.raise_zotero_dialog(timeout=45, interval=0.1, stabilize=1.2))
        except Exception as exc:
            worker_errors.append("raise: " + str(exc))

    def ui_worker():
        try:
            deadline = time.time() + 45
            while time.time() < deadline and not finished.is_set():
                wins = proxy._zotero_windows()
                if current_cmd[0] == "Document.getDocumentData":
                    for hwnd, title, w, h in wins:
                        if proxy._window_is_prefs(title):
                            proxy._topmost_window(user32, hwnd)
                            time.sleep(0.2)
                            key(0x0D)
                            time.sleep(0.4)
                for hwnd, title, w, h in wins:
                    if not proxy._window_is_citation(title):
                        continue
                    stable = False
                    for _ in range(25):
                        if int(user32.GetForegroundWindow() or 0) == hwnd:
                            stable = True
                            break
                        time.sleep(0.2)
                    ui_result.append(("detected", title, hwnd, stable))
                    if not stable:
                        finished.set()
                        return
                    user32.SetForegroundWindow(ctypes.c_void_p(hwnd))
                    for ch in "Papilot":
                        key(user32.VkKeyScanW(ord(ch)) & 0xFF)
                    time.sleep(1.5)
                    foreground = int(user32.GetForegroundWindow() or 0) == hwnd
                    ui_result.append(("interaction", True, foreground, topmost(hwnd)))
                    ui_result.append(("cancel", cancel_dialog(hwnd)))
                    finished.set()
                    return
                time.sleep(0.25)
        except Exception as exc:
            worker_errors.append("ui: " + str(exc))

    threads = [threading.Thread(target=raise_worker, daemon=True), threading.Thread(target=ui_worker, daemon=True)]
    for thread in threads:
        thread.start()
    code, resp = post(BASE + "/connector/document/execCommand", {"command": "addCitation", "docId": DOC})
    complete = False
    error = ""
    for _ in range(60):
        if not isinstance(resp, dict):
            error = "非命令响应: " + str(resp)
            break
        cmd, args = resp.get("command"), resp.get("arguments") or []
        current_cmd[0] = cmd
        commands.append(cmd)
        if cmd and "complete" in cmd.lower():
            complete = True
            break
        code, resp = post(BASE + "/connector/document/respond", handle(cmd, args), timeout=70)
        if code == -1:
            error = "协议等待失败: " + str(resp)
            break
    if not complete:
        error = error or "未走到 Document.complete"
    finished.set()
    for thread in threads:
        thread.join(timeout=3)
    remaining = {h: topmost(h) for h in initial if any(x[0] == h for x in proxy._zotero_windows())}
    unchanged = all(remaining.get(h) == flag for h, flag in initial.items() if h in remaining)
    out = {"complete": complete, "error": error, "workerErrors": worker_errors, "commands": commands,
           "raise": raise_result, "ui": ui_result, "initialWindowsUnchanged": unchanged,
           "initialTopmost": initial, "remainingTopmost": remaining}
    print(json.dumps(out, ensure_ascii=False, indent=2))
    ok = (complete and not error and not worker_errors and unchanged and raise_result
          and raise_result[0].get("ok") and any(x[0] == "detected" and x[3] for x in ui_result)
          and any(x[0] == "interaction" and x[1] and x[2] for x in ui_result))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
