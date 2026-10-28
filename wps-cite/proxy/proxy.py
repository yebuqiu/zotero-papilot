#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 Cassiuschen. All rights reserved.
"""Papilot Cite · 本地代理（21932）

四件事，每一件都是"浏览器沙箱做不到、但集成必须做"的：
  1. 转发 Zotero 本地 API（127.0.0.1:23119/api/…），补 CORS 头 —— 加载项在浏览器环境里跨源会被拦；
     转发时改写 Host（Zotero 10 会校验，非 127.0.0.1:23119 直接 400）。
  2. 维护**反向链接台账**（%APPDATA%\\PapilotCite\\links.json）——"这篇 PDF 被哪些文档引用"，
     Zotero 原生没有这个能力，由文档侧每次刷新时 upsert。
  3. 打开 zotero:// 链接与本地文档 —— WPS 12 里加载项的 ShellExecute 已失效，只能由外部进程代劳。
  4. 存一点无关键配置（当前样式），避免依赖 WPS 的 localStorage 行为。

用法：
    pythonw proxy.py            # 后台常驻（开机自启用 Run 项）
    python proxy.py status
    python proxy.py stop
"""
import base64
import json
import logging
import os
import platform
import re
import socket
import sys
import threading
import time
import urllib.error
import urllib.request
import unicodedata
import zipfile

PROXY_VERSION = "0.2.1"   # 部署在多机上，排障先对版本：__health 与启动日志都带它
ZOTERO = "127.0.0.1"
ZOTERO_PORT = 23119
LISTEN_PORT = 21932
HOME = os.path.join(os.environ.get("APPDATA") or os.path.expanduser("~"), "PapilotCite")
LINKS = os.path.join(HOME, "links.json")
CONFIG = os.path.join(HOME, "config.json")
DIAG_DIR = os.path.join(HOME, "diag")

CORS = (
    "Access-Control-Allow-Origin: *\r\n"
    "Access-Control-Allow-Methods: GET,POST,OPTIONS,PUT,DELETE\r\n"
    "Access-Control-Allow-Headers: *\r\n"
    "Access-Control-Max-Age: 86400\r\n"
)

# ---------- 跨源/命令白名单 ----------
# 代理监听 127.0.0.1，但浏览器有一个坑：任意外站网页里 fetch("http://127.0.0.1:21932/...")
# 也会把请求发到这里（Private Network Access 之前，这就是 CSRF 的温床）。所以：
#   - 带 Origin 头的（一律是浏览器发的）只允许 127.0.0.1 / localhost / null / file://
#     （CEF file:// 加载项多数发 null；部分 WPS 内嵌的旧 Chromium 把 file 源序列化成
#     "file://"——2026-10-21 外机实测，两者同为本地文件页，信任等级一致）；
#   - 不带 Origin 的（curl / python / 本机工具）不是浏览器场景，放行。
# 这样即使别人诱导用户访问一个恶意站点，它也无法驱使代理去翻 Zotero 库或开文件。
_ALLOW_ORIGIN = re.compile(
    r"^(?:https?://(?:127\.0\.0\.1|localhost)(?::\d+)?|null|file://)$", re.IGNORECASE)


def origin_ok(headers):
    """带 Origin 才校验；不带就是本机命令行工具，放行。"""
    for k, v in (headers or {}).items():
        if k.lower() == "origin":
            return bool(_ALLOW_ORIGIN.match(str(v).strip()))
    return True


# /open 只放三类东西：zotero:// 协议链接（Zotero 自己接管）；
# DOI 解析链接（严格限定 doi.org/10.xxxx/...，给“批量打开 DOI”用）；
# 或本机已存在的**文档**路径（用来"打开引用它的那份文件"）。
# .exe/.bat/... 一开放就是远程任意命令执行（配合上面的 Origin 白名单也不该开）。
_DOC_EXT = (".docx", ".doc", ".pdf", ".xlsx", ".pptx", ".txt", ".md")
_DOI_URL = re.compile(r"^https?://(?:dx\.)?doi\.org/10\.\d{4,9}/\S+$", re.IGNORECASE)
_WIN_ABS = re.compile(r"^[A-Za-z]:[\\/]")


def doi_uri_ok(uri):
    """只放行 doi.org 的解析链接；其它 http(s) 一律拒绝。"""
    return bool(_DOI_URL.match(str(uri or "").strip()))


def docx_path_ok(path):
    """无域副本的路径检查：只接受明确的绝对 .docx 路径，禁止任意读写。"""
    s = str(path or "").strip()
    if not s or len(s) > 1024 or "\x00" in s:
        return False
    if not (s.startswith("/") or _WIN_ABS.match(s)):
        return False
    if any(part == ".." for part in re.split(r"[\\/]+", s)):
        return False
    return s.lower().endswith(".docx")

_LOCK = threading.RLock()
STOP = threading.Event()


def _is_utf8(path):
    try:
        with open(path, "rb") as f:
            f.read().decode("utf-8")
        return True
    except (OSError, UnicodeDecodeError):
        return False


def setup_log():
    os.makedirs(HOME, exist_ok=True)
    path = os.path.join(HOME, "proxy.log")
    try:
        # ★ 超限不能直接删：proxy.log 是排障唯一凭据，删掉等于把上一次出问题的现场抹掉。
        #   与下面 .prev 一个思路：改名成 .1 留着（已有 .1 就先覆盖掉）。
        if os.path.exists(path) and os.path.getsize(path) > 512 * 1024:
            rotated = path + ".1"
            try:
                if os.path.exists(rotated):
                    os.remove(rotated)
                os.replace(path, rotated)
            except OSError:
                pass
        # 旧版本用系统编码（GBK）写过日志；混进一个非 UTF-8 字节，整个文件就会
        # 被 grep / 编辑器判定为 binary，排查时读不出来。启动时挪走。
        if os.path.exists(path) and not _is_utf8(path):
            prev = path + ".prev"
            try:
                if os.path.exists(prev):
                    os.remove(prev)
                os.replace(path, prev)
            except OSError:
                pass
    except OSError:
        pass
    logging.basicConfig(filename=path, filemode="a",
                        format="%(asctime)s %(levelname)s %(message)s",
                        level=logging.INFO,
                        # 必须显式 utf-8：默认走系统编码（GBK）时，日志里出现
                        # 特殊字符后整个文件会被 grep/编辑器当成二进制，排查时读不出来。
                        encoding="utf-8")


def read_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def write_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


# ---------- 把 Zotero 的「添加引注」浮窗拉到最前 ----------
# 为什么要在外部进程做：引注框是 Zotero 自己的窗口，WPS 里的加载项（一个隐藏的浏览器页）
# 完全没有能力控制操作系统的窗口层级。用户点完按钮、Zotero 弹框后，只要点一下 WPS 正文，
# 浮窗就沉到后面去，看起来像"按钮没反应"。
#
# 策略（保守）：只允许 Zotero 进程内的精确引文弹窗标题；主窗口、未知新窗口、
# 其他进程一律不操作。标题归一仅处理语言差异、空白和 Zotero 前后缀，不做子串猜测。
_CITATION_TITLES = {
    "add/edit citation", "add citation", "edit citation", "citation dialog", "citation window",
    "添加/编辑引文", "添加引文", "编辑引文", "添加/编辑引注", "添加引注", "编辑引注",
    "引注对话框", "引文对话框", "引用对话框",
    "插入引用", "编辑引用", "添加/编辑引用", "插入引文", "插入引注",
}
_PREFS_TITLES = {"文档首选项", "文档偏好设置", "document preferences", "document prefs"}


def _normalize_window_title(title):
    text = unicodedata.normalize("NFKC", str(title or "")).strip().lower().replace("／", "/")
    text = re.sub(r"\s+", " ", text)
    text = re.sub(r"^zotero[\s\-–—|]*", "", text)
    text = re.sub(r"[\s\-–—|]+zotero$", "", text)
    return text.strip()


def _proc_image_name(pid):
    """返回进程可执行文件名（小写），取不到返回空串。"""
    import ctypes
    from ctypes import wintypes
    k = ctypes.windll.kernel32
    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    h = k.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, int(pid))
    if not h:
        return ""
    try:
        buf = ctypes.create_unicode_buffer(1024)
        size = wintypes.DWORD(1024)
        if k.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
            return os.path.basename(buf.value).lower()
        return ""
    except OSError:
        return ""
    finally:
        try:
            k.CloseHandle(h)
        except OSError:
            pass


def _zotero_windows():
    """枚举 zotero 进程的所有可见顶层窗口 → [(hwnd, title, w, h)]"""
    import ctypes
    from ctypes import wintypes
    u = ctypes.windll.user32
    out = []
    WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

    def cb(hwnd, _lparam):
        try:
            if not u.IsWindowVisible(hwnd):
                return True
            pid = wintypes.DWORD()
            u.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            if _proc_image_name(pid.value) != "zotero.exe":
                return True
            n = u.GetWindowTextLengthW(hwnd)
            if n <= 0:
                return True
            buf = ctypes.create_unicode_buffer(n + 1)
            u.GetWindowTextW(hwnd, buf, n + 1)
            rect = wintypes.RECT()
            u.GetWindowRect(hwnd, ctypes.byref(rect))
            out.append((hwnd, buf.value, rect.right - rect.left, rect.bottom - rect.top))
            return True
        except Exception:
            return True

    u.EnumWindows(WNDENUMPROC(cb), 0)
    return out


def _window_is_prefs(title):
    return _normalize_window_title(title) in _PREFS_TITLES


def _window_is_citation(title):
    return _normalize_window_title(title) in _CITATION_TITLES


def _window_text(u, hwnd):
    import ctypes
    try:
        n = u.GetWindowTextLengthW(hwnd)
        if n <= 0:
            return ""
        buf = ctypes.create_unicode_buffer(n + 1)
        u.GetWindowTextW(hwnd, buf, n + 1)
        return str(buf.value or "")
    except Exception:
        return ""


def _window_matches_kind(u, hwnd, kind):
    """操作前再次核对：句柄仍可见、仍属 Zotero、标题仍是本次目标类型。"""
    import ctypes
    from ctypes import wintypes
    try:
        if not u.IsWindowVisible(hwnd):
            return False
        pid = wintypes.DWORD()
        u.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if _proc_image_name(pid.value) != "zotero.exe":
            return False
        title = _window_text(u, hwnd)
        return _window_is_citation(title) if kind == "citation" else _window_is_prefs(title)
    except Exception:
        return False


def _topmost_window(u, hwnd, activate=True):
    """把指定 Zotero 窗口置顶。SetWindowPos 是主判据，前台权限失败不瞒报。"""
    import ctypes
    from ctypes import wintypes

    HWND_TOPMOST = -1
    SWP_NOSIZE, SWP_NOMOVE, SWP_SHOWWINDOW = 0x0001, 0x0002, 0x0040
    SW_RESTORE = 9
    # 显式声明 64 位 HWND，避免 ctypes 默认 c_int 截断句柄。
    try:
        u.SetWindowPos.argtypes = [wintypes.HWND, wintypes.HWND] + [ctypes.c_int] * 4 + [wintypes.UINT]
        u.SetWindowPos.restype = wintypes.BOOL
        u.SetForegroundWindow.argtypes = [wintypes.HWND]
        u.SetForegroundWindow.restype = wintypes.BOOL
        u.BringWindowToTop.argtypes = [wintypes.HWND]
        u.BringWindowToTop.restype = wintypes.BOOL
    except (AttributeError, TypeError):
        pass
    if activate:
        u.ShowWindow(hwnd, SW_RESTORE)  # 返回“之前是否可见”，0 也是正常结果
    if not u.SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0,
                          SWP_NOSIZE | SWP_NOMOVE | SWP_SHOWWINDOW):
        return {"ok": False, "why": "SetWindowPos 被系统拒绝"}
    foreground = False
    if activate:
        foreground = bool(u.SetForegroundWindow(hwnd))
        u.BringWindowToTop(hwnd)
    return {"ok": True, "foreground": foreground}


def raise_zotero_dialog(timeout=180.0, interval=0.3, user32=None, enum=None, stabilize=30.0, verify=None):
    """只置顶精确的插入/编辑引文弹窗；首选项可前置，但继续等待真正目标。

    不再对“任何新窗口”做兜底。每次操作前复核句柄的可见性、Zotero 进程和标题；
    找到目标后在交互期内重设 TOPMOST（不重复抢焦点），避免创建动画/父窗口抢层级。
    Zotero 某些版本不保留 WS_EX_TOPMOST 样式位，因此以 API 返回值和持续交互为准。
    """
    if user32 is None:
        try:
            import ctypes
            user32 = ctypes.windll.user32
        except Exception as e:
            return {"ok": False, "why": "ctypes unavailable: %s" % e}
    u = user32
    enumerate_windows = enum or _zotero_windows
    verifier = verify or (lambda hwnd, kind: _window_matches_kind(u, hwnd, kind))

    def operate(hwnd, kind):
        if not verifier(hwnd, kind):
            return None                       # 句柄已复用/标题已变化：不动它，继续等
        return _topmost_window(u, hwnd)

    first = enumerate_windows()
    before = set(h[0] for h in first)
    handled = set()
    deadline = time.time() + max(0.05, timeout)
    seen = [t for (_h, t, _w, _hh) in first]
    while time.time() < deadline:
        wins = enumerate_windows()
        seen = [t for (_h, t, _w, _hh) in wins]
        # 新目标优先，避免旧引文弹窗抢过本轮；只有精确白名单标题可进入这里。
        for allow_existing in (False, True):
            for hwnd, title, _w, _h in wins:
                if (not allow_existing and hwnd in before) or not _window_is_citation(title):
                    continue
                result = operate(hwnd, "citation")
                if result is None:
                    continue
                result.update({"title": title, "kind": "keyword" if allow_existing else "citation", "reasserted": 0})
                if not result.get("ok"):
                    return result
                stable_until = time.time() + max(0.0, stabilize)
                verification_misses = 0
                while time.time() < stable_until:
                    time.sleep(min(max(0.001, interval), max(0.001, stable_until - time.time())))
                    if not verifier(hwnd, "citation"):
                        try:
                            if not u.IsWindowVisible(hwnd):
                                result["closed"] = True
                                return result       # 用户已关闭：不重选其他窗口
                        except Exception:
                            result["closed"] = True
                            return result
                        verification_misses += 1
                        if verification_misses >= 3:
                            result["verificationLost"] = True
                            return result       # 可见但进程/标题复核连续失败：停止但不误报关闭
                        continue
                    verification_misses = 0
                    follow = _topmost_window(u, hwnd, activate=False)
                    if not follow.get("ok"):
                        follow.update({"title": title, "kind": result["kind"]})
                        return follow
                    result["reasserted"] += 1
                return result
        # 首选项只是中间步骤；其他新窗口（包括 Zotero 主窗口）绝不置顶。
        for hwnd, title, _w, _h in wins:
            if hwnd in before or hwnd in handled or not _window_is_prefs(title):
                continue
            handled.add(hwnd)
            result = operate(hwnd, "preferences")
            if result is None:
                continue
            result.update({"title": title, "kind": "preferences"})
            if not result.get("ok"):
                return result
            break
        time.sleep(interval)
    return {"ok": False, "why": "没等到插入/编辑引文弹窗", "seen": seen[:6]}


def zotero_alive():
    s = socket.socket()
    s.settimeout(0.4)
    try:
        s.connect((ZOTERO, ZOTERO_PORT))
        return True
    except OSError:
        return False
    finally:
        s.close()


def local_api_ok():
    """本地 API 未开启时 Zotero 返回 403，这里用一次轻量请求判定。"""
    try:
        req = urllib.request.Request(
            "http://%s:%d/api/users/0/items?limit=1" % (ZOTERO, ZOTERO_PORT),
            headers={"Host": "%s:%d" % (ZOTERO, ZOTERO_PORT), "Zotero-API-Version": "3"})
        with urllib.request.urlopen(req, timeout=3) as r:
            return r.status == 200
    except urllib.error.HTTPError as e:
        return e.code != 403
    except (urllib.error.URLError, OSError):
        return False


def _zotero_executable():
    roots = [os.environ.get("ProgramFiles"), os.environ.get("ProgramFiles(x86)"), os.environ.get("LOCALAPPDATA")]
    for base in roots:
        if not base:
            continue
        path = os.path.join(base, "Zotero", "zotero.exe")
        if os.path.isfile(path):
            return path
    return ""


def connection_status():
    alive = zotero_alive()
    return {"ok": True, "proxy": True, "proxyVersion": PROXY_VERSION, "zotero": alive,
            "localApi": local_api_ok() if alive else False, "zoteroStartAvailable": bool(_zotero_executable())}


def connection_repair(payload):
    action = str((payload or {}).get("action") or "")
    if action == "recheck":
        return connection_status()
    if action != "start-zotero":
        raise ValueError("unsupported connection repair action")
    if zotero_alive():
        return dict(connection_status(), already=True)
    exe = _zotero_executable()
    if not exe:
        return dict(connection_status(), ok=False, code="ZOTERO_NOT_FOUND",
                    error="未在标准安装目录找到 Zotero，请从开始菜单启动")
    import subprocess
    subprocess.Popen([exe], cwd=os.path.dirname(exe), close_fds=True)
    return dict(connection_status(), ok=True, started=True)


# ---------------- 窗格 → 主页面 的插入队列 ----------------
# 为什么需要：WPS 的任务窗格是独立页面，未必注入 wps 对象。窗格只负责"选文献"，
# 把结果放进这个队列；主页面（index.html，一定有 wps）定时取走并真正写入文档。
_QUEUE = []
_QUEUE_LOCK = threading.Lock()


def queue_push(items):
    with _QUEUE_LOCK:
        _QUEUE.extend(items or [])
        n = len(_QUEUE)
    logging.info("queue push %d (pending %d)", len(items or []), n)
    return n


def queue_pop():
    with _QUEUE_LOCK:
        items = list(_QUEUE)
        _QUEUE.clear()
    if items:
        logging.info("queue pop %d", len(items))
    return items


# 管理窗格与主页面是不同浏览器上下文；代理只转发短命令和脱敏快照，不接触 WPS。
_COMMANDS = []
_MANAGER = {}
_MANAGER_LOCK = threading.Lock()
_MANAGER_ACTIONS = {"locate", "edit", "source", "manager-refresh", "bibliography", "zotero", "pdf", "info",
                    "select", "batch-open", "locator-save", "run-check", "locate-report", "export-report",
                    "repair-preview", "repair-apply", "crossdoc-health", "profile-save", "profile-delete",
                    "favorite-save", "favorite-remove"}


def manager_set(payload):
    document_id = str(payload.get("documentID") or "")
    if not document_id or len(document_id) > 1024:
        raise ValueError("documentID required")
    rows = payload.get("rows")
    if not isinstance(rows, list) or len(rows) > 10000:
        raise ValueError("rows must be a bounded array")
    center = payload.get("center") or {}
    locator = payload.get("locator") or {}
    if not isinstance(center, dict) or not isinstance(locator, dict):
        raise ValueError("center/locator must be objects")
    if len(json.dumps(center, ensure_ascii=False)) > 2000000 or len(json.dumps(locator, ensure_ascii=False)) > 500000:
        raise ValueError("center/locator snapshot too large")
    value = {"documentID": document_id, "rows": rows,
             "status": payload.get("status") or {}, "center": center, "locator": locator, "updatedAt": time.time()}
    with _MANAGER_LOCK:
        _MANAGER[document_id] = value
    return {"ok": True, "count": len(rows)}


def manager_get(document_id):
    """只返回指定文档的快照；缺少身份时绝不借用最近文档。"""
    document_id = str(document_id or "")
    if not document_id:
        return {"documentID": "", "rows": [], "status": {}}
    with _MANAGER_LOCK:
        return _MANAGER.get(document_id) or {"documentID": document_id, "rows": [], "status": {}}


def command_push(payload):
    action = str(payload.get("action") or "")
    if action not in _MANAGER_ACTIONS:
        raise ValueError("command action not allowed")
    document_id = str(payload.get("documentID") or "")
    if not document_id or len(document_id) > 1024:
        raise ValueError("documentID required")
    raw_ids = payload.get("fieldIDs")
    if not isinstance(raw_ids, list):
        raw_ids = []
    data = payload.get("data")
    if data is None:
        data = {}
    if not isinstance(data, dict) or len(json.dumps(data, ensure_ascii=False)) > 65536:
        raise ValueError("command data must be a bounded object")
    command = {"action": action, "fieldID": str(payload.get("fieldID") or "")[:512],
               "documentID": document_id,
               "checked": payload.get("checked") is True,
               "kind": str(payload.get("kind") or "")[:64], "data": data,
               # 批量打开只接受有界的 fieldID 列表；实际条目身份仍由主页面从当前扫描重建。
               "fieldIDs": [str(x)[:512] for x in raw_ids][:200]}
    with _MANAGER_LOCK:
        if len(_COMMANDS) >= 500:
            raise ValueError("command queue full")
        _COMMANDS.append(command)
        return len(_COMMANDS)


def command_pop(document_id):
    """只取走指定文档的命令，其他文档的待办必须原样保留。"""
    document_id = str(document_id or "")
    if not document_id:
        return []
    with _MANAGER_LOCK:
        rows = [row for row in _COMMANDS if row.get("documentID") == document_id]
        _COMMANDS[:] = [row for row in _COMMANDS if row.get("documentID") != document_id]
        return rows


# ---------------- 台账 ----------------

def links_upsert(doc, cites):
    with _LOCK:
        data = read_json(LINKS, {"v": 1, "items": {}})
        items = data.setdefault("items", {})
        # 先删该文档的旧记录，再整体写入（文档是台账的"权威来源"）
        for key in list(items.keys()):
            items[key] = [r for r in items[key] if os.path.normcase(r.get("doc", "")) != os.path.normcase(doc)]
            if not items[key]:
                del items[key]
        now = time.strftime("%Y-%m-%dT%H:%M:%S")
        for c in cites or []:
            key = str(c.get("itemKey") or "")
            if not key:
                continue
            rec = dict(c)
            rec["doc"] = doc
            rec["updatedAt"] = now
            items.setdefault(key, []).append(rec)
        write_json(LINKS, data)
        logging.info("links upsert doc=%s cites=%d", doc, len(cites or []))
        return len(cites or [])


def links_overview():
    """跨文档只读总览；路径只用于本机打开，不上传。限制记录数避免异常台账拖垮窗格。"""
    data = read_json(LINKS, {"v": 1, "items": {}})
    records, documents = [], {}
    for item_key, rows in list((data.get("items") or {}).items())[:10000]:
        for row in rows:
            if len(records) >= 20000 or not isinstance(row, dict):
                continue
            doc = str(row.get("doc") or "")
            rec = {"itemKey": str(item_key), "doc": doc, "page": row.get("page") or 0,
                   "anno": str(row.get("anno") or ""), "locator": str(row.get("locator") or ""),
                   "seq": row.get("seq") or 0, "text": str(row.get("text") or "")[:500],
                   "snippet": str(row.get("snippet") or "")[:500], "updatedAt": str(row.get("updatedAt") or "")}
            records.append(rec)
            info = documents.setdefault(doc, {"doc": doc, "citationCount": 0, "itemKeys": set(),
                                              "updatedAt": "", "exists": os.path.isfile(doc)})
            info["citationCount"] += 1
            info["itemKeys"].add(str(item_key))
            info["updatedAt"] = max(info["updatedAt"], rec["updatedAt"])
    docs = []
    for info in documents.values():
        info["uniqueItems"] = len(info.pop("itemKeys"))
        docs.append(info)
    docs.sort(key=lambda x: x["updatedAt"], reverse=True)
    return {"records": records, "documents": docs}


def links_query(item_key, page=None, doc=None):
    data = read_json(LINKS, {"v": 1, "items": {}})
    rows = list((data.get("items") or {}).get(item_key, []))
    if page not in (None, "", 0, "0"):
        # ★ page 是从 query string 来的（"abc"、"1.5"、"None" 都可能传进来），
        #   直接 int() 会 ValueError → 整个 /links 请求 500，前端只看到"查台账失败"。
        try:
            want = int(page)
        except (TypeError, ValueError):
            want = None
        if want is not None:
            rows = [r for r in rows if int(r.get("page") or 0) == want]
    if doc:
        rows = [r for r in rows if os.path.normcase(r.get("doc", "")) != os.path.normcase(doc)]
    return rows


# ---------------- 一键诊断包 ----------------
# 为什么要有：用户说"某个按钮不好使"时，我们没法远程连他的机器，也不该让他手动翻目录找日志。
# 让他点一下"导出诊断包"，把生成的 zip 发过来，现场就在里面了：
# 日志尾巴、脱敏后的配置、文档里有哪些域、Zotero/API 通不通。
DIAG_TAIL_LINES = 400      # 只留日志尾巴：proxy.log 可能几十 MB，整个塞进 zip 没人看得下去
DIAG_LINKS_KEEP = 20       # 台账可能很大，只留条数 + 前 20 条摘要

# 诊断包是要发出去的，config.json 里可能有 Zotero API key / token，
# 键名命中这些词的，值一律打码，绝不带明文凭据出门。
_SECRET_HINTS = ("key", "token", "secret", "password", "passwd", "pwd", "密码", "令牌", "密钥", "凭证")


def _looks_secret(name):
    low = str(name or "").lower()
    return any(h in low for h in _SECRET_HINTS)


def redact(obj):
    """递归把像密钥的字段值换成 ***；其余原样。"""
    if isinstance(obj, dict):
        return {k: ("***" if _looks_secret(k) else redact(v)) for k, v in obj.items()}
    if isinstance(obj, list):
        return [redact(v) for v in obj]
    return obj


def tail_lines(path, n=DIAG_TAIL_LINES):
    """只保留最后 n 行，用 deque 滚动，避免把大文件整个读进内存。"""
    from collections import deque
    buf = deque(maxlen=max(1, int(n)))
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            for line in f:
                buf.append(line.rstrip("\r\n"))
    except OSError:
        return "（读不到 %s）\n" % path
    return "\n".join(buf) + "\n"


def _doc_line(doc_path):
    if not doc_path:
        return "（未提供，可能没打开文档）"
    # 诊断包是从 HTTP 入口进来的，docPath 可能被传成 list/dict/数字，
    # 直接走 os.path.exists 会 TypeError 把整份 summary 搞挂。
    if not isinstance(doc_path, str):
        return "（docPath 类型异常：%r）" % (type(doc_path).__name__,)
    try:
        if os.path.exists(doc_path):
            return "%s（存在，%d 字节）" % (doc_path, os.path.getsize(doc_path))
        return "%s（不存在）" % doc_path
    except OSError as e:
        return "%s（读不到：%s）" % (doc_path, e)


def build_summary(payload):
    """summary.txt：人先看的那一页，不用解开 zip 里的别的文件就能判断个大概。"""
    alive = zotero_alive()
    lines = [
        "Papilot Cite 诊断包",
        "生成时间: %s" % time.strftime("%Y-%m-%d %H:%M:%S"),
        "插件版本: %s" % (payload.get("version") or "（未知）"),
        "文档: %s" % _doc_line(payload.get("docPath")),
        "Zotero 进程: %s" % ("在跑" if alive else "没在跑"),
        "Zotero 本地 API: %s" % ("可用" if (alive and local_api_ok()) else "不可用"),
        "代理监听: 127.0.0.1:%d" % LISTEN_PORT,
        "Python: %s (%s)" % (platform.python_version(), sys.platform),
        "系统: %s" % platform.platform(),
    ]
    fields = payload.get("fields") or []
    lines.append("字段清单 (%d):" % len(fields))
    for f in fields:
        if not isinstance(f, dict):
            continue
        lines.append("  #%s %s %sB %s" % (
            f.get("index"), f.get("kind") or "other", f.get("codeLen") or 0, f.get("label") or ""))
    if not fields:
        lines.append("  （文档里没扫到域）")
    lines.append("备注: %s" % (payload.get("note") or "（无）"))
    return "\n".join(lines) + "\n"


def build_links_digest():
    """links.json 只留条数与前若干条摘要：整份台账可能很大，而且对排障没那么关键。"""
    data = read_json(LINKS, {})
    items = (data.get("items") if isinstance(data, dict) else None) or {}
    keys = list(items.keys())
    out = ["台账条数: %d" % len(keys),
           "（每篇文献一条，值是引用它的文档列表）", ""]
    for key in keys[:DIAG_LINKS_KEEP]:
        rows = items.get(key) or []
        docs = []
        for r in rows[:3]:
            if not isinstance(r, dict):
                continue
            name = os.path.basename(str(r.get("doc") or "")) or "?"
            page = r.get("page")
            docs.append(name + (" p%s" % page if page not in (None, "", 0, "0") else ""))
        out.append("%s: %d 条引用 ← %s" % (key, len(rows), ", ".join(docs) or "（无文档）"))
    if len(keys) > DIAG_LINKS_KEEP:
        out.append("…（仅列前 %d 条）" % DIAG_LINKS_KEEP)
    return "\n".join(out) + "\n"


def diag_build(payload):
    """打一个 zip，返回 {"ok":True,"path","size"}。失败时异常交给 diag_handle 兜。"""
    os.makedirs(DIAG_DIR, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    path = os.path.join(DIAG_DIR, "papilot-diag-%s.zip" % stamp)
    n = 2
    while os.path.exists(path):                    # 同一秒内连点两次也不能互相覆盖
        path = os.path.join(DIAG_DIR, "papilot-diag-%s-%d.zip" % (stamp, n))
        n += 1
    cfg = redact(read_json(CONFIG, {}))
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("summary.txt", build_summary(payload))
        z.writestr("proxy.tail.log", tail_lines(os.path.join(HOME, "proxy.log")))
        z.writestr("config.json", json.dumps(cfg, ensure_ascii=False, indent=1))
        z.writestr("links.json", build_links_digest())
    size = os.path.getsize(path)
    logging.info("diag %s (%d bytes, fields=%d)", path, size, len(payload.get("fields") or []))
    return {"ok": True, "path": path, "size": size}


def diag_handle(payload):
    """POST /diag 的实现入口。**绝不抛**：打包失败也只是回一个 ok:false。"""
    try:
        if not isinstance(payload, dict):
            return {"ok": False, "error": "请求体必须是 JSON 对象"}
        return diag_build(payload)
    except Exception as e:                          # noqa: BLE001 —— 这里的意图就是"什么错都不许炸"
        logging.warning("diag failed: %r", e)
        return {"ok": False, "error": str(e)}


# ---------------- HTTP ----------------

def read_msg(sock):
    data = b""
    while b"\r\n\r\n" not in data:
        chunk = sock.recv(65536)
        if not chunk:
            return b"", b""
        data += chunk
        if len(data) > 8 * 1024 * 1024:
            break
    head, _, body = data.partition(b"\r\n\r\n")
    length = 0
    for line in head.split(b"\r\n")[1:]:
        if line.lower().startswith(b"content-length:"):
            try:
                length = int(line.split(b":", 1)[1].strip())
            except ValueError:
                length = 0
    while len(body) < length:
        chunk = sock.recv(65536)
        if not chunk:
            break
        body += chunk
    return head, body[:length] if length else body


def send(sock, code, body=b"", ctype="application/json; charset=utf-8", extra=""):
    if isinstance(body, (dict, list)):
        body = json.dumps(body, ensure_ascii=False).encode("utf-8")
    elif isinstance(body, str):
        body = body.encode("utf-8")
    head = ("HTTP/1.1 %d %s\r\n%sContent-Type: %s\r\nContent-Length: %d\r\n"
            "Connection: close\r\n%s\r\n") % (
        code, {200: "OK", 400: "Bad Request", 403: "Forbidden", 404: "Not Found",
               500: "Server Error", 502: "Bad Gateway"}.get(code, "OK"),
        CORS, ctype, len(body), extra)
    sock.sendall(head.encode("latin1") + body)


def forward(method, path, headers, body, timeout=20):
    """把 /zotero/xxx 转发到 Zotero 本地 API，并改写 Host。"""
    url = "http://%s:%d%s" % (ZOTERO, ZOTERO_PORT, path)
    h = {k: v for k, v in headers.items()
         if k.lower() in ("accept", "zotero-api-version", "content-type")}
    h["Host"] = "%s:%d" % (ZOTERO, ZOTERO_PORT)
    req = urllib.request.Request(url, data=body if method in ("POST", "PUT", "PATCH") else None,
                                 headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read(), r.headers.get("Content-Type", "application/json")
    except urllib.error.HTTPError as e:
        return e.code, e.read(), e.headers.get("Content-Type", "application/json")
    except (urllib.error.URLError, OSError) as e:
        return 502, json.dumps({"error": str(e)}).encode(), "application/json"


def handle(client):
    try:
        head, body = read_msg(client)
        if not head:
            return
        line = head.split(b"\r\n")[0].decode("latin1")
        parts = line.split(" ")
        method, target = parts[0].upper(), (parts[1] if len(parts) > 1 else "/")
        headers = {}
        for raw in head.split(b"\r\n")[1:]:
            if b":" in raw:
                k, v = raw.split(b":", 1)
                headers[k.decode("latin1").strip()] = v.decode("latin1").strip()

        from urllib.parse import urlparse, parse_qs, unquote
        u = urlparse(target)
        path, qs = u.path, parse_qs(u.query)

        if method == "OPTIONS":
            return send(client, 200, b"", extra="")

        # ★ Origin 白名单：外站网页能 fetch 到 127.0.0.1 上的代理（浏览器不拦），
        #   不挡就是 CSRF。带 Origin 必须是本机/localhost/null（CEF file:// 页发 null），
        #   否则 403；不带 Origin 的是 curl/python/同机工具，不是浏览器场景，放行。
        if not origin_ok(headers):
            rejected = headers.get("Origin") or headers.get("origin") or ""
            logging.warning("reject origin: %r", rejected)
            # 把被拒的 Origin 放进响应体：加载项的报错文案能直接显示它，
            # 用户不用翻 proxy.log 也能把关键信息报回来。
            return send(client, 403, {"error": "origin not allowed", "origin": rejected})

        if path == "/__beacon":
            # 1x1 透明 GIF：图片请求不受 CORS 约束，用来确认"加载项页面能不能碰到代理"。
            # 用户报"连不上"时，先看日志里有没有这行 —— 有=网通、问题在别处；没有=请求就被拦了。
            logging.info("beacon from addon t=%s", (qs.get("t") or [""])[0])
            gif = base64.b64decode("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7")
            return send(client, 200, gif, "image/gif")

        if path == "/__shutdown":
            # 供 `proxy.py stop` 用（也是插件更新后重启代理的兜底通道）。
            # 端口只绑 127.0.0.1、且上面的 Origin 白名单已挡外站，风险面仅本机。
            logging.info("shutdown requested")
            send(client, 200, {"ok": True})
            STOP.set()
            return

        if path == "/__health":
            # 记一行：加载项启动时会自动探一次，这行就是"JS 跑了且网通了"的硬证据
            logging.info("health probe ok-zotero=%s", zotero_alive())
            return send(client, 200, {"ok": True, "zotero": zotero_alive(),
                                      "localApi": local_api_ok() if zotero_alive() else False,
                                      "proxyVersion": PROXY_VERSION})

        if path == "/log" and method == "POST":
            # 加载项把"点了什么、WPS 有哪些 API、报什么错"写到这里。
            # 目的：WPS 的界面不能自动化点，只能靠这条通道把现场搬出来。
            try:
                payload = json.loads(body.decode("utf-8") or "{}")
            except ValueError:
                payload = {"msg": body.decode("utf-8", "replace")[:300]}
            extra = payload.get("extra")
            logging.info("ADDON %s%s", payload.get("msg", ""),
                         (" | " + json.dumps(extra, ensure_ascii=False))[:600] if extra else "")
            return send(client, 200, {"ok": True})

        if path == "/raise":
            r = raise_zotero_dialog()
            logging.info("raise %s", json.dumps(r, ensure_ascii=False))
            return send(client, 200, r)

        if path == "/diag" and method == "POST":
            # 一键诊断包：用户报"按钮不好使"时，把现场打成 zip 让他回传。
            try:
                payload = json.loads(body.decode("utf-8") or "{}")
            except ValueError:
                return send(client, 400, {"ok": False, "error": "bad json"})
            res = diag_handle(payload)              # 自己兜异常，不会把代理带崩
            return send(client, 200 if res.get("ok") else 500, res)

        if path.startswith("/zit/"):
            # Zotero 集成协议（execCommand/respond）：**长轮询**——Zotero 会把"下一条命令"
            # 当响应下发，可能等用户在对话框里操作很久。超时必须远大于普通转发。
            # ★ 这个值 = 用户在弹出的「添加引文」框里最多能挑多久。给 240s 时，
            #   挑文献超过 4 分钟就断链，Zotero 侧事务卡在 inProgress（之后全 503）。
            #   现在给 30 分钟，正常操作不可能超过。
            sub = path[len("/zit"):] + (("?" + u.query) if u.query else "")
            code, data, ctype = forward(method, sub, headers, body, timeout=1800)
            if code >= 400:
                logging.warning("fwd %s %s -> %d", method, sub.split("?")[0], code)
            return send(client, code, data, ctype)

        if path.startswith("/zotero/"):
            sub = path[len("/zotero"):] + (("?" + u.query) if u.query else "")
            code, data, ctype = forward(method, sub, headers, body)
            if code >= 400:
                # 403 几乎总是「Zotero 本地 API 未开启」——落日志后 proxy.log 就是第一现场，
                # 不用再看加载项里的裸 "HTTP 403" 猜来源。
                logging.warning("fwd %s %s -> %d (403 = zotero local api off?)", method, sub.split("?")[0], code)
            return send(client, code, data, ctype)

        if path == "/jsonp":
            # file:// 页面里的 fetch 可能被 CEF 拦；script 标签不受 CORS 约束，
            # 所以给弹窗页留一条 JSONP 通道：/jsonp?fn=cb&p=<path?query>
            from urllib.parse import unquote
            fn = (qs.get("fn") or ["cb"])[0]
            target = unquote((qs.get("p") or [""])[0])
            if not target.startswith("/"):
                return send(client, 400, "cb({error:'bad p'})", "application/javascript; charset=utf-8")
            if target.startswith("/queue-push?"):
                try:
                    items = json.loads(unquote(target.split("?", 1)[1]))
                    queue_push(items.get("items") or [])
                    payload = json.dumps({"ok": True})
                except ValueError:
                    payload = json.dumps({"ok": False})
            elif target.startswith("/config"):
                payload = json.dumps(read_json(CONFIG, {}), ensure_ascii=False)
            else:
                if target.startswith("/zotero"):
                    target = target[len("/zotero"):]
                code, data, _ = forward("GET", target, {"Zotero-API-Version": "3"}, b"")
                payload = data.decode("utf-8", "replace")
            body = "%s(%s);" % (fn, payload)
            return send(client, 200, body, "application/javascript; charset=utf-8")

        if path == "/queue":
            if method == "POST":
                try:
                    payload = json.loads(body.decode("utf-8") or "{}")
                except ValueError:
                    return send(client, 400, {"error": "bad json"})
                return send(client, 200, {"pending": queue_push(payload.get("items") or [])})
            return send(client, 200, {"items": queue_pop()})

        if path == "/manager":
            if method == "GET":
                return send(client, 200, manager_get((qs.get("documentID") or [""])[0]))
            if method == "POST":
                try:
                    payload = json.loads(body.decode("utf-8") or "{}")
                    if not isinstance(payload, dict):
                        raise ValueError("payload must be object")
                    return send(client, 200, manager_set(payload))
                except (ValueError, TypeError) as e:
                    return send(client, 400, {"ok": False, "error": str(e)})
            return send(client, 400, {"error": "method not allowed"})

        if path == "/commands":
            if method == "POST":
                try:
                    payload = json.loads(body.decode("utf-8") or "{}")
                    if not isinstance(payload, dict):
                        raise ValueError("payload must be object")
                    return send(client, 200, {"ok": True, "pending": command_push(payload)})
                except (ValueError, TypeError) as e:
                    return send(client, 400, {"ok": False, "error": str(e)})
            if method == "GET":
                return send(client, 200, {"items": command_pop((qs.get("documentID") or [""])[0])})
            return send(client, 400, {"error": "method not allowed"})

        if path == "/links/overview" and method == "GET":
            return send(client, 200, links_overview())

        if path == "/connection":
            if method == "GET":
                return send(client, 200, connection_status())
            if method == "POST":
                try:
                    payload = json.loads(body.decode("utf-8") or "{}")
                    if not isinstance(payload, dict):
                        raise ValueError("payload must be object")
                    return send(client, 200, connection_repair(payload))
                except (ValueError, TypeError, OSError) as e:
                    return send(client, 400, {"ok": False, "error": str(e)})
            return send(client, 400, {"error": "method not allowed"})

        if path == "/links" and method == "GET":
            rows = links_query((qs.get("itemKey") or [""])[0],
                               (qs.get("page") or [None])[0],
                               (qs.get("excludeDoc") or [None])[0])
            return send(client, 200, rows)

        if path == "/links/upsert" and method == "POST":
            try:
                payload = json.loads(body.decode("utf-8") or "{}")
            except ValueError:
                return send(client, 400, {"error": "bad json"})
            n = links_upsert(payload.get("doc") or "", payload.get("cites") or [])
            return send(client, 200, {"ok": True, "count": n})

        if path == "/file-exists" and method == "POST":
            # 无域副本前的防覆盖检查：只回答“这个绝对 .docx 路径是否存在”。
            # 不读内容、不写文件、不接受目录或相对路径 —— 不能变成任意文件探测接口。
            try:
                payload = json.loads(body.decode("utf-8") or "{}")
            except ValueError:
                return send(client, 400, {"error": "bad json"})
            target = payload.get("path") if isinstance(payload, dict) else None
            if not docx_path_ok(target):
                logging.warning("file-exists 拒绝非绝对 docx 路径: %r", target)
                return send(client, 403, {"error": "only absolute .docx path allowed"})
            exists = os.path.isfile(str(target))
            logging.info("file-exists %s -> %s", target, exists)
            return send(client, 200, {"ok": True, "path": str(target), "exists": exists})

        if path == "/open" and method == "POST":
            try:
                payload = json.loads(body.decode("utf-8") or "{}")
            except ValueError:
                return send(client, 400, {"error": "bad json"})
            target_uri = payload.get("uri") or ""
            target_path = payload.get("path") or ""
            # ★ 白名单：os.startfile 等价于双击，uri/path 不做限制就是"远程双击任意文件"，
            #   一个钓鱼网页就能借它启动 .exe。只允许：
            #     - zotero:// 协议（交给 Zotero 的协议处理器）
            #     - 本机已存在的文档类文件（.docx/.pdf/...，见 _DOC_EXT）
            if target_uri:
                if str(target_uri).lower().startswith("zotero://") or doi_uri_ok(target_uri):
                    pass
                else:
                    logging.warning("open 拒绝非 zotero:// / doi.org 的 uri: %r", target_uri)
                    return send(client, 403, {"error": "uri scheme not allowed"})
            elif target_path:
                ext = os.path.splitext(str(target_path))[1].lower()
                if ext not in _DOC_EXT:
                    logging.warning("open 拒绝非文档扩展名: %r", target_path)
                    return send(client, 403, {"error": "path extension not allowed"})
            try:
                if target_uri:
                    os.startfile(target_uri)          # zotero:// 由系统协议处理器接管
                elif target_path and os.path.exists(target_path):
                    os.startfile(target_path)
                else:
                    return send(client, 404, {"error": "nothing to open"})
            except OSError as e:
                return send(client, 500, {"error": str(e)})
            logging.info("open %s", target_uri or target_path)
            return send(client, 200, {"ok": True})

        if path == "/config":
            if method == "GET":
                return send(client, 200, read_json(CONFIG, {}))
            # ★ 与 /links/upsert、/queue 的写法对齐：坏 JSON 要回 400，
            #   不能让它冒到外层 Exception → 500（那是"服务器内部错"，不是"请求错"）。
            try:
                payload = json.loads(body.decode("utf-8") or "{}")
            except ValueError:
                return send(client, 400, {"error": "bad json"})
            # 设置与审计分别异步落盘；读-改-写必须串行，避免两个线程互相覆盖顶层键。
            with _LOCK:
                cfg = read_json(CONFIG, {})
                cfg.update(payload)
                write_json(CONFIG, cfg)
            return send(client, 200, cfg)

        return send(client, 404, {"error": "not found", "path": path})
    except Exception as e:                        # 单请求失败不能拖垮代理
        logging.warning("request failed: %r", e)
        try:
            send(client, 500, {"error": str(e)})
        except OSError:
            pass
    finally:
        try:
            client.close()
        except OSError:
            pass


def serve(port=LISTEN_PORT):
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
        srv.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
    try:
        srv.bind(("127.0.0.1", port))
    except OSError as e:
        logging.info("bind failed (%s)，可能已有实例", e)
        return 0
    srv.listen(64)
    srv.settimeout(1.0)
    logging.info("proxy v%s on %d → zotero %d", PROXY_VERSION, port, ZOTERO_PORT)
    while not STOP.is_set():
        try:
            c, _ = srv.accept()
        except socket.timeout:
            continue
        except OSError:
            break
        threading.Thread(target=handle, args=(c,), daemon=True).start()
    srv.close()
    logging.info("proxy stopped")
    return 0


if __name__ == "__main__":
    setup_log()
    arg = sys.argv[1] if len(sys.argv) > 1 else ""
    if arg == "status":
        s = socket.socket()
        s.settimeout(0.4)
        try:
            s.connect(("127.0.0.1", LISTEN_PORT))
            print("running")
        except OSError:
            print("stopped")
        finally:
            s.close()
    elif arg == "stop":
        # 真正停掉运行中的实例：POST /__shutdown → STOP → serve 循环 1s 内退出。
        # 老版本代理没有这个接口（返回 404），此时只能按端口 kill（install.py --repair 走那条路）。
        try:
            req = urllib.request.Request(
                "http://127.0.0.1:%d/__shutdown" % LISTEN_PORT, method="POST")
            with urllib.request.urlopen(req, timeout=2) as r:
                print("stopping" if r.status == 200 else "failed")
        except urllib.error.HTTPError as e:
            print("failed: HTTP %d（运行中的代理是旧版本，没有 __shutdown）" % e.code)
        except (urllib.error.URLError, OSError):
            print("stopped")
    else:
        try:
            sys.exit(serve())
        except Exception:
            import traceback
            logging.error("fatal: %s", traceback.format_exc())
            raise
