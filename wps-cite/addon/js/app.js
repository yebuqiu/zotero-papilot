// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 加载项主控：功能区回调 + 五个命令
 *
 * 命令：
 *   插入引文   打开任务窗格检索 Zotero，选中后写到光标处（可多选，同处一篇/多篇）
 *   刷新       扫书签 → 取条目 → 重排编号与正文 → 重建文献表 → 同步台账
 *   文献表     同刷新（文献表锚点不存在时新建）
 *   回到原文   取光标所在引文的 page/anno → zotero://open-pdf 精确跳到 PDF 该页/该高亮
 *   查看引用   取光标所在引文 → 查本地台账 → 列出"哪个文档哪一处在引它"并可打开
 */
(function (root) {
  "use strict";
  const Doc = root.PPDoc;
  const M = root.PPModel;
  const L = root.PPLinks;
  const Z = root.PPZotero;

  const STYLES = { gb7714: root.PPStyleGB, apa: root.PPStyleAPA };
  const ANCHOR = "PPANCHOR";                 // 插入锚：点任务窗格会丢选区，先记下来

  function style() {
    const id = Doc.meta("PPCStyle") || "gb7714";
    return STYLES[id] || STYLES.gb7714;
  }

  function setStyle(id) {
    if (!STYLES[id]) throw new Error("未知样式：" + id);
    Doc.meta("PPCStyle", id);
    return STYLES[id];
  }

  function msg(t) {
    try { alert("Papilot Cite：" + t); } catch (e) { console.log(t); }
  }

  /** 代理的启动脚本路径（连接失败时告诉用户点哪里，而不是只喊"连不上"） */
  function proxyBat() {
    try {
      const base = String(wps.Env.GetAppDataPath() || "").replace(/\//g, "\\");
      return base + "\\PapilotCite\\start-proxy.bat";
    } catch (e) {
      return "%APPDATA%\\PapilotCite\\start-proxy.bat";
    }
  }

  /** 图片探针：不受 CORS 约束，代理日志里能看到它，用来区分"网不通"和"逻辑错" */
  function beacon() {
    try {
      const img = new Image();
      img.src = Z.PROXY + "/__beacon?t=" + Date.now();
    } catch (e) { /* 探针失败不影响任何流程 */ }
  }

  function connError(e) {
    if (e && e.status === 403) {
      // 403 有两个来源，文案必须分开：
      // ① 代理 Origin 白名单拦截（body 带 "origin not allowed"）——是代理说的，开 Zotero 没用；
      // ② Zotero 本地 API 未开启——Zotero 说的，去设置里勾选项。
      if (e.body && /origin not allowed/i.test(String(e.body))) {
        let o = "";
        try { o = JSON.parse(e.body).origin || ""; } catch (_) { /* 老代理没有这个字段 */ }
        return "本地代理拒绝了页面来源" + (o ? "（Origin: " + o + "）" : "") +
          "。请把 %APPDATA%\\PapilotCite\\proxy.log 里 reject origin 一行发给开发者。";
      }
      return "Zotero 拒绝访问：请到 Zotero 设置 → 高级，勾选「允许此计算机上的其他应用程序与 Zotero 通信」。";
    }
    return "连接不上本地服务。请先双击运行：\n" + proxyBat() +
      "\n（或在 Papilot 仓库运行 python wps-cite/tools/install.py --repair）";
  }

  /** 远程日志：WPS 界面不能自动化点，把现场写进代理日志（proxy.log）才有得查 */
  function log(msg, extra) {
    try {
      fetch(Z.PROXY + "/log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ msg: msg, extra: extra || null }),
      });
    } catch (e) { /* 日志失败不影响功能 */ }
  }

  /** 探测这台 WPS 到底给了哪些界面 API（决定用任务窗格还是对话框还是兜底） */
  function apiProbe() {
    const t = (n) => { try { return typeof n; } catch (e) { return "throw"; } };
    return {
      CreateTaskPane: t(wps.CreateTaskPane),
      ShowDialog: t(wps.ShowDialog),
      CreateDialog: t(wps.CreateDialog),
      OAAssist: t(wps.OAAssist),
      Env: t(wps.Env),
      Alert: t(wps.OAAssist && wps.OAAssist.Alert),
    };
  }


  // ---------- 台账同步（反向链接的数据基础） ----------

  async function pushLinks(plan, byKey, docPath, extraCites) {
    const cites = [];
    for (const c of plan.clusters) {
      const first = c.alive && c.alive[0];
      if (!first) continue;
      const item = byKey[first.itemKey] || {};
      cites.push(L.record(docPath, {
        token: c.token,
        itemKey: first.itemKey,
        libId: first.libId,
        page: first.page,
        anno: first.anno,
        locator: first.locator,
        seq: first.seq,
        text: (item.title || "").slice(0, 80),
        snippet: c.items.map((x) => (byKey[x.itemKey] || {}).title || "").join(" / "),
      }));
    }
    for (const c of (extraCites || [])) cites.push(c);
    try {
      await Z.call("/links/upsert", { method: "POST", body: { doc: docPath, cites: cites } });
    } catch (e) {
      // ★ console.warn 在 WPS 加载项里用户看不到（没有 devtools 可开），
      //   "双向链接不工作"会变成无法排查的哑巴问题。走代理日志留痕。
      log("台账写入失败（不影响文档）", { err: String((e && e.message) || e) });
    }
  }

  // ---------- 刷新 ----------

  async function refreshAll(opts) {
    const o = opts || {};
    const st = style();
    const scan = Doc.scan();
    // dotm（Zotero 官方插件）插入的是 Word 域，不是我们的书签；两类都要认
    const domainFields = (Doc.scanFields() || [])
      .map((f) => ({ field: f, parsed: (root.PPZFields ? root.PPZFields.parseField(f.code) : null) }))
      .filter((x) => x.parsed && x.parsed.items.length);

    if (!scan.length && !domainFields.length && !o.forceBib) {
      msg("本文档还没有引文。先用「插入引文」加一条（或用 Zotero 官方选项卡插入）。");
      return { ok: true, empty: true };
    }

    const keys = scan.map((s) => (root.PPCodes.parse(s.name) || {}).itemKey).filter(Boolean)
      .concat(domainFields.reduce((a, x) => a.concat(x.parsed.items.map((i) => i.key)), []));
    let byKey = {};
    try {
      byKey = await Z.items(keys);
    } catch (e) {
      msg(connError(e));
      return { ok: false };
    }

    const plan = M.plan(scan, byKey, st);

    if (!o.syncOnly) {
      // 先写文本再清理同簇的其余书签，避免书签在枚举中消失导致漏改
      for (const e of plan.edits) {
        if (e.remove) continue;
        if (!Doc.exists(e.name)) continue;
        Doc.setText(e.name, e.text);
      }
      for (const e of plan.edits) {
        if (!e.remove) continue;
        Doc.setText(e.name, "");
        Doc.remove(e.name);
      }
      const entries = plan.bib.map((b) => ({ item: byKey[b.itemKey], seq: b.seq, locator: "" }));
      const lines = st.bib(entries);
      if (lines.length || o.forceBib) Doc.setBib(lines);
    }

    const domainCites = [];
    for (const x of domainFields) {
      const f = x.parsed;
      for (const it of f.items) {
        domainCites.push(L.record(Doc.docPath(), {
          token: f.citationID || it.key,
          itemKey: it.key, libId: it.libId || 1,
          page: 0, anno: "", locator: it.locator || "",
          seq: 0, text: (byKey[it.key] || {}).title || "",
        }));
      }
    }
    await pushLinks(plan, byKey, Doc.docPath(), domainCites);

    if (plan.missing.length) {
      msg(`有 ${plan.missing.length} 条引文在 Zotero 里找不到对应条目（可能是别处复制过来的），已标为 [?]。`);
    }
    return { ok: true, count: plan.clusters.length, missing: plan.missing.length };
  }

  // ---------- 插入 ----------

  /** 记住当前插入点，供任务窗格回调时使用 */
  function markAnchor() {
    try {
      const d = Doc.doc();
      if (d.Bookmarks.Exists(ANCHOR)) d.Bookmarks.Item(ANCHOR).Delete();
      d.Bookmarks.Add(ANCHOR, Doc.app().Selection.Range);
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * 在锚点处插入一处引文。
   * @param items [{key, libId, page, anno, locator}]
   */
  async function insertCitation(items) {
    if (!items || !items.length) return { ok: false, error: "没有选中文献" };
    const d = Doc.doc();
    if (d.Bookmarks.Exists(ANCHOR)) {
      Doc.gotoBookmark(ANCHOR);
    }
    const byKey = await Z.items(items.map((x) => x.key));

    // 同一处多篇共用一个 token，逐条建书签
    let tok = null;
    const names = [];
    let idx = 0;
    for (const it of items) {
      const p = {
        itemKey: String(it.key).toUpperCase(),
        page: it.page || 0,
        anno: it.anno || "",
        locator: it.locator || "",
        libId: it.libId || 1,
        idx: idx,
      };
      const name = tok
        ? root.PPCodes.makeInCluster(Doc.exists, tok, p, idx)
        : root.PPCodes.make(Doc.exists, p);
      if (!tok) tok = root.PPCodes.parse(name).token;
      names.push(name);
      idx++;
    }

    // 渲染这一处引文的文本（用插入后的整体顺序重算一次最稳）
    const probe = Doc.scan().concat(names.map((n) => ({ name: n, start: 1e9 })));
    const plan0 = M.plan(probe, byKey, style());
    const text = (plan0.edits.find((e) => e.name === names[0]) || {}).text || "[]";

    // ★ 失败必须抛：insertAtCursor 返回 {ok:false, error} 说明书签没挂上，
    //   正文里却已有文本（既不报错也不带书签的文本等于"幽灵引文"——之后刷新不到它）。
    //   原来丢弃返回值、继续走 refreshAll，等于把失败假报成成功。
    const ins = Doc.insertAtCursor(text, names[0]);
    if (!ins || !ins.ok) {
      throw new Error("引文插入失败（书签没能写入文档）：" + ((ins && ins.error) || "未知原因"));
    }
    for (let i = 1; i < names.length; i++) {
      // 后续成员紧跟在第一个书签之后，占位长度为 0，仅用于记住条目身份
      const bm = d.Bookmarks.Item(names[0]);
      const r = bm.Range;
      r.Collapse(0);
      d.Bookmarks.Add(names[i], r);
    }
    if (d.Bookmarks.Exists(ANCHOR)) d.Bookmarks.Item(ANCHOR).Delete();

    await refreshAll({});
    return { ok: true, names: names, text: text };
  }

  // ---------- 双向跳转 ----------

  /** 取光标处的引文身份：优先我们自己的书签，其次 dotm 的域 */
  function citationHere() {
    const at = Doc.citationAtCursor();
    if (at) {
      return { key: at.parsed.itemKey, itemKey: at.parsed.itemKey, libId: at.parsed.libId, libType: "users", page: at.parsed.page, anno: at.parsed.anno, src: "bookmark" };
    }
    const f = Doc.fieldAtCursor();
    if (f && root.PPZFields) {
      const parsed = root.PPZFields.parseField(f.code);
      if (parsed && parsed.items.length) {
        const it = parsed.items[0];
        return { key: it.key, itemKey: it.key, libId: it.libId, libType: it.libType, page: 0, anno: "", src: "field", locator: it.locator || "" };
      }
    }
    return null;
  }

  async function gotoSource() {
    const p = citationHere();
    if (!p) {
      msg("光标不在引文上。把光标放到引文（如 [1] 或 Zotero 域）里，再点「回到原文」。");
      return { ok: false };
    }
    let uri = "";
    if (p.anno || p.page) {
      const pdf = await Z.bestPdf(p.itemKey);
      if (pdf) uri = L.pdfUri(pdf.key, p.page, p.anno);
    }
    if (!uri) uri = L.selectUri(p.itemKey, p.libId, p.libType);
    try {
      await Z.call("/open", { method: "POST", body: { uri: uri } });
    } catch (e) {
      msg("打不开 Zotero：" + (e.message || e) + "。请确认 Zotero 已安装并能响应 zotero:// 链接。");
      return { ok: false, error: String(e) };
    }
    return { ok: true, uri: uri };
  }

  async function findCitations() {
    const p = citationHere();
    if (!p) {
      msg("光标不在引文上。");
      return { ok: false };
    }
    let rows = [];
    try {
      const q = new URLSearchParams({ itemKey: p.itemKey });
      if (p.page) q.set("page", String(p.page));
      rows = (await Z.call("/links?" + q.toString())) || [];
    } catch (e) {
      msg("查台账失败：" + (e.message || e));
      return { ok: false };
    }
    const cur = Doc.docPath().toLowerCase();
    const others = (rows || []).filter((r) => String(r.doc).toLowerCase() !== cur);
    if (!others.length) {
      msg("除了当前文档，还没有别的文档引用这条文献。");
      return { ok: true, rows: [] };
    }
    const text = others.slice(0, 12)
      .map((r, i) => `${i + 1}. ${r.doc}${r.page ? "（第 " + r.page + " 页）" : ""}${r.text ? " · " + r.text : ""}`)
      .join("\n");
    if (confirm(`共 ${others.length} 处其它引用：\n\n${text}\n\n点「确定」打开第一个文档。`)) {
      await Z.call("/open", { method: "POST", body: { path: others[0].doc } }).catch(() => {});
    }
    return { ok: true, rows: others };
  }

  // ---------- 任务窗格 ----------

  let pane = null;

  /** 兜底：没有任务窗格/对话框时，用两个 prompt 完成"搜一条、插一条" */
  async function quickPick() {
    let q = "";
    try {
      q = prompt("检索 Zotero（输入关键词，回车后按序号选一条）") || "";
    } catch (e) {
      log("prompt unavailable", { err: String((e && e.message) || e) });
      msg("本机 WPS 没有可用的选择界面，且 prompt 也不可用。请改用 WPS 自带的「Zotero」选项卡插入引文。");
      return;
    }
    if (!q.trim()) return;
    const rows = await Z.search(q.trim(), 5);
    if (!rows.length) {
      msg("没找到条目：" + q);
      return;
    }
    const head = rows.slice(0, 5).map((r, i) => `${i + 1}. ${(r.data.title || "").slice(0, 50)}`).join("\n");
    const pick = prompt(`找到 ${rows.length} 条：\n${head}\n\n输入序号（默认 1）`, "1") || "1";
    const idx = Math.min(Math.max(parseInt(pick, 10) || 1, 1), rows.length) - 1;
    const r = rows[idx];
    await insertCitation([{ key: r.key, libId: r.libId || 1 }]);
    msg("已插入：" + (r.data.title || r.key));
  }

  /** WPS 各版本对 CreateTaskPane 的签名不完全一致，按可能性逐个试 */
  /** 弹窗页的绝对地址：ShowDialog 传相对路径会被 CEF 当成网址去解析（ERR_NAME_NOT_RESOLVED） */
  function pickerUrl() {
    try {
      const raw = String(wps.Env.GetAppDataPath() || "");
      const base = raw.split("\\").join("/").replace(/\/+$/, "");
      const ver = root.PPC_VERSION || "0.1.0";
      return "file:///" + base + "/kingsoft/wps/jsaddons/papilot-cite_" + ver + "/picker.html";
    } catch (e) {
      return "";
    }
  }

  function tryTaskPane() {
    const url = "picker.html";
    const tries = [
      ["4-arg", () => wps.CreateTaskPane(url, "插入引文", 380, 520)],
      ["2-arg", () => wps.CreateTaskPane(url, "插入引文")],
      ["1-arg", () => wps.CreateTaskPane(url)],
    ];
    let last = null;
    for (const [tag, fn] of tries) {
      try {
        const p = fn();
        if (p) {
          log("taskpane created", { sig: tag });
          return p;
        }
        log("taskpane returned null", { sig: tag });
      } catch (e) {
        last = e;
        log("taskpane attempt failed", { sig: tag, err: String((e && e.message) || e) });
      }
    }
    throw last || new Error("CreateTaskPane 全部签名失败");
  }

  /** 首次加载自动探一次"窗格能不能建"，把结果写进日志（只探一次，用代理配置做标记） */
  async function probePaneOnce() {
    try {
      const cfg = await Z.call("/config");
      if (cfg && cfg.pickerProbed) return;
    } catch (e) { return; }
    let result = "skipped";
    try {
      const p = tryTaskPane();
      try { p.Visible = false; } catch (e) { /* 关不掉也没关系 */ }
      result = "ok";
    } catch (e) {
      result = "failed: " + String((e && e.message) || e);
    }
    log("taskpane self-test", { result: result });
    try {
      await Z.call("/config", { method: "POST", body: { pickerProbed: true } });
    } catch (e) { /* 标记失败就下次再探 */ }
  }

  /** 主页面定时取窗格放进队列的选择（窗格若没有 wps 对象就靠这条路） */
  let pollTimer = null, queuePolling = false;
  function startQueuePoll() {
    if (pollTimer) return;
    pollTimer = setInterval(async () => {
      if (queuePolling) return;
      queuePolling = true;
      try {
        const currentID = Doc.documentID(Doc.doc());
        const commands = await Z.call("/commands?documentID=" + encodeURIComponent(currentID));
        for (const command of (commands && commands.items) || []) {
          const result = await runManagerCommand(command);
          if (result && result.code === "WRONG_DOCUMENT") {
            // 拉取后用户切换了文档：命令放回原文档队列，绝不执行，也不丢弃。
            await Z.call("/commands", { method: "POST", body: command });
            continue;
          }
          if (result && result.error) log("manager command failed", { action: command.action, err: result.error });
          if (command.action !== "manager-refresh" && command.action !== "select") {
            try { await publishManager(); } catch (ignored) { /* 面板可稍后重新扫描 */ }
          }
        }
        const r = await Z.call("/queue");
        const items = (r && r.items) || [];
        if (!items.length) return;
        log("queue got", { n: items.length });
        const res = await insertCitation(items);
        msg(res && res.ok ? "已插入 " + items.length + " 条引文" : "插入失败：" + ((res && res.error) || ""));
        try { await publishManager(); } catch (ignored) { /* 面板未打开时无需保留快照 */ }
      } catch (e) {
        // 这里不能静默：队列插入失败时用户看不到任何提示，只能靠日志
        log("queue insert failed", {
          err: String((e && e.message) || e),
          stack: String((e && e.stack) || "").slice(0, 500),
        });
        msg("插入失败：" + ((e && e.status) ? connError(e) : String((e && e.message) || e)));
      } finally { queuePolling = false; }
    }, 1200);
  }

  function openPicker() {
    markAnchor();
    const probe = apiProbe();
    log("openPicker", probe);
    // ① 首选**弹出对话框**（最接近 Word 插件"点一下弹搜索框"的手感）
    if (probe.ShowDialog === "function") {
      const abs = pickerUrl();
      const cands = [];
      if (abs) cands.push(["abs-4", () => wps.ShowDialog(abs, "插入引文", 420, 560)]);
      cands.push(["rel-4", () => wps.ShowDialog("picker.html", "插入引文", 420, 560)]);
      cands.push(["abs-1", () => abs && wps.ShowDialog(abs)]);
      for (const [tag, fn] of cands) {
        try {
          fn();
          log("showdialog ok", { sig: tag });
          return;
        } catch (e) {
          log("showdialog attempt failed", { sig: tag, err: String((e && e.message) || e) });
        }
      }
    }
    // ② 退到任务窗格（可停靠、可边看边点）
    try {
      if (probe.CreateTaskPane === "function") {
        if (!pane) pane = tryTaskPane();
        pane.Visible = true;
        log("taskpane ok");
        return;
      }
    } catch (e) {
      log("taskpane failed", { err: String((e && e.message) || e) });
    }
    // ③ 再退到 prompt 兜底（丑但能用）
    log("fallback quickPick");
    Promise.resolve(quickPick()).catch((e) => msg(String((e && e.message) || e)));
  }

  // ---------- 功能区 ----------

  /** 走 Zotero 原生集成命令；结束后同步一次台账（域解析见 zfields.js） */
  async function nativeRun(command, options) {
    try {
      const r = await root.PPIntegration.run(command, options);
      if (r && r.ok) {
        await refreshAll({ syncOnly: true });   // 只同步台账与文献状态，不重排文本（文本由 Zotero 写）
        if (command === "refresh") {
          const health = await inspectHealth({ silent: true });
          const d = Doc.doc(), id = Doc.documentID(d), state = root.PPSettings.get(id);
          if (state.lastRefresh && health.scan) root.PPSettings.set(id, { lastRefresh: Object.assign({}, state.lastRefresh, {
            issueCount: health.count || 0, citationCount: health.scan.fields.length, count: health.scan.fields.length,
            bibliographyCount: health.scan.bibliography.length }) });
        }
      }
      return r;
    } catch (e) {
      try {
        const d = Doc.doc(), documentID = Doc.documentID(d), scan = root.PPFieldScanner.scan(d);
        root.PPSettings.refreshFinished(documentID, { ok: false, error: String((e && e.message) || e).slice(0, 240),
          count: scan.fields.length, bibliographyCount: scan.bibliography.length, issueCount: scan.issues.length });
      } catch (ignored) { /* 状态记录不能覆盖事务原错误 */ }
      msg(String((e && e.message) || e));
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  function OnAddinLoad(ribbonUI) {
    if (typeof wps.ribbonUI !== "object") wps.ribbonUI = ribbonUI;
    // 把"这台 WPS 提供了哪些界面 API"写进代理日志：后续点按钮走哪条路，靠它决定
    log("addin loaded", Object.assign({ version: root.PPC_VERSION || "" }, apiProbe()));
    // 启动时打一发探针（日志可见）+ 探一次链路，只记录不弹窗
    beacon();
    Z.health().then((h) => {
      if (!h.ok) console.warn("Papilot Cite 代理未运行");
      else if (!h.localApi) console.warn("Zotero 本地 API 未开启");
    });
    Promise.resolve(probePaneOnce()).catch(() => {});
    try { root.PPContext.registerNative(function (id, ref) { return root.PPContext.execute(id, ref); }); } catch (e) { log("native context unavailable"); }
    bindAutomationEvents();
    startQueuePoll();
    return true;
  }

  /* ---------- 样式切换 / 未引文献补入 / 导航 / 诊断包（工具箱） ---------- */

  /* 常用样式。styleID 必须与 Zotero 样式库里的 ID 完全一致；
   * 选了没装过的样式，Zotero 会自己去取，取不到会在 refresh 阶段报错（我们照实转述）。 */
  const ZOTERO_STYLES = {
    gb7714: { id: "http://www.zotero.org/styles/china-national-standard-gb-t-7714-2015-numeric", label: "GB/T 7714-2015" },
    apa: { id: "http://www.zotero.org/styles/apa", label: "APA" },
    nature: { id: "http://www.zotero.org/styles/nature", label: "Nature" },
    ieee: { id: "http://www.zotero.org/styles/ieee", label: "IEEE" },
  };

  /**
   * 换样式：改文档数据里的 styleID，再让 Zotero 重排一遍。
   * 为什么不调 setDocPrefs：那会弹 Zotero 自己的对话框，用户还得在里面找样式 ——
   * 我们要的是"点一下就好"。真正的重排仍然由 Zotero 做（refresh），所以编号、文献表、
   * 上标格式全都跟官方一致，不是我们自己拼的字符串。
   */
  function styleDescriptor(value) {
    if (value && typeof value === "object") {
      const id = String(value.styleID || value.id || "").trim();
      return id ? { id: id, key: String(value.key || id), label: String(value.label || id) } : null;
    }
    const key = String(value || "");
    if (ZOTERO_STYLES[key]) return Object.assign({ key: key }, ZOTERO_STYLES[key]);
    if (/^https?:\/\/www\.zotero\.org\/styles\/[A-Za-z0-9._~-]+$/.test(key)) {
      return { id: key, key: key, label: key.split("/").pop() };
    }
    return null;
  }
  function recentStyles() {
    try {
      const rows = root.PPSettings.get(Doc.documentID(Doc.doc())).recentStyles || [];
      return rows.map(styleDescriptor).filter(Boolean).slice(0, 3);
    } catch (e) { return []; }
  }
  function rememberStyle(st) {
    const documentID = Doc.documentID(Doc.doc());
    const old = root.PPSettings.get(documentID).recentStyles || [];
    const rows = [{ key: st.key, styleID: st.id, label: st.label, usedAt: new Date().toISOString() }]
      .concat(old.filter(function (x) { return String(x.styleID || x.id || "") !== st.id; })).slice(0, 3);
    root.PPSettings.set(documentID, { recentStyles: rows });
    try { if (wps.ribbonUI && typeof wps.ribbonUI.Invalidate === "function") wps.ribbonUI.Invalidate(); } catch (e) { /* 静态按钮仍可用 */ }
  }
  async function switchZoteroStyle(value) {
    const st = styleDescriptor(value);
    if (!st) return { ok: false, error: "未知样式：" + String(value || "") };
    const I = root.PPIntegration;
    if (!I || typeof I.changeStyle !== "function") {
      msg("换样式功能没就绪（integration.changeStyle 缺失），请把这条提示反馈给我们。");
      return { ok: false };
    }
    try {
      const r = await I.changeStyle(st.id);
      if (r && r.ok && r.changed) {
        rememberStyle(st);
        msg("已切换为 " + st.label + "，全文已按新样式重排。");
      } else if (r && r.ok) msg("当前已经是 " + st.label + "，不必切换。");
      return r;
    } catch (e) {
      msg("样式切换失败，未记入最近使用：" + String((e && e.message) || e));
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  function itemTitle(d) {
    const t = String((d && (d.title || (d.Case || d.name))) || "").trim();
    return t.length > 46 ? t.slice(0, 46) + "…" : (t || "(无标题)");
  }
  function itemYear(d) {
    const m = /(1[6-9]\d\d|20\d\d)/.exec(String((d && d.date) || ""));
    return m ? m[1] : "";
  }

  /**
   * 补入未引用文献：Zotero 的文献表域代码里有一个 uncited 数组，放进去的条目会出现在
   * 文末列表里但**不占正文编号**（学位论文的"阅读书目"就是这么来的）。
   * 这里只做"检索 → 选序号 → 写进 uncited → 刷新"，不重造轮子。
   */
  async function addUncitedFlow() {
    const I = root.PPIntegration;
    if (!I || typeof I.addUncited !== "function") {
      msg("补入功能没就绪（integration.addUncited 缺失）。请先插入至少一条引文和文献表。");
      return { ok: false };
    }
    let q = "";
    try {
      q = prompt("补入未引用文献\n\n输入关键词（标题/作者）检索 Zotero 库：") || "";
    } catch (e) {
      msg("这个 WPS 版本没有可用的输入框，无法检索。");
      return { ok: false };
    }
    if (!q.trim()) return { ok: true, cancelled: true };

    const rows = await Z.search(q.trim(), 8);
    if (!rows.length) { msg("没搜到条目。换个关键词试试。"); return { ok: true, empty: true }; }
    const lines = rows.map((r, i) => {
      const y = itemYear(r.data);
      return (i + 1) + ". " + itemTitle(r.data) + (y ? "（" + y + "）" : "");
    }).join("\n");

    let ans = "";
    try {
      ans = prompt("检索到 " + rows.length + " 条，输入要补入的序号（可多个，用逗号分隔）：\n\n" + lines) || "";
    } catch (e) { return { ok: false }; }
    if (!ans.trim()) return { ok: true, cancelled: true };

    const idx = ans.split(/[,，\s]+/).map((x) => parseInt(x, 10)).filter((n) => n >= 1 && n <= rows.length);
    if (!idx.length) { msg("没有有效的序号。"); return { ok: false }; }
    const keys = [...new Set(idx.map((n) => rows[n - 1].key))];

    const r = await I.addUncited(keys);
    msg("已补入 " + (r && r.added != null ? r.added : keys.length) + " 条，文献表共 "
      + (r && r.uncited != null ? r.uncited : "?") + " 条。");
    return r;
  }

  /** 引文导航：没有弹窗打扰，跳转本身有光标与滚动反馈 */
  function navCall(kind) {
    const N = root.PPNav;
    if (!N || typeof N[kind] !== "function") {
      msg("引文导航模块没加载（nav.js 缺失），请把这条提示反馈给我们。");
      return { ok: false };
    }
    const r = N[kind]();
    if (r && r.ok === false && r.error) msg(r.error);
    return r || { ok: false };
  }

  /** 一键诊断包：报障时不用再远程连用户的机器 */
  async function exportDiag() {
    const D = root.PPDiag;
    if (!D || typeof D.export !== "function") {
      msg("诊断模块没加载（diag.js 缺失）。");
      return { ok: false };
    }
    const r = await D.export();
    if (!r || !r.ok) {
      msg("导出诊断包失败：" + ((r && r.error) || "未知原因"));
      return r || { ok: false };
    }
    msg("诊断包已导出：\n" + r.path + "\n\n把它发给维护者即可。");
    return r;
  }

  /** P0 只读体检：与刷新共用统一扫描，坏域保留并可定位。 */
  async function inspectHealth(options) {
    try {
      const d = Doc.doc(), documentID = Doc.documentID(d);
      const scan = root.PPFieldScanner.scan(d);
      const keys = [];
      scan.fields.forEach(function (f) { f.items.forEach(function (item) { if (keys.indexOf(item.key) < 0) keys.push(item.key); }); });
      let library = null, connected = false;
      try { library = await Z.items(keys); connected = true; } catch (e) { connected = false; }
      const state = root.PPSettings.get(documentID);
      const fingerprint = root.PPFieldScanner.fingerprint(scan);
      const issues = root.PPHealth.inspect(scan, {
        library: library, libraryScope: "users", zoteroConnected: connected, lastSuccess: state.lastSuccess, fingerprint: fingerprint,
        canLocate: function (field) {
          try { return !!root.PPFieldScanner.locate(field, scan); } catch (e) { return false; }
        },
      });
      const errors = issues.filter(function (x) { return x.severity === "error"; }).length;
      const warnings = issues.filter(function (x) { return x.severity === "warning"; }).length;
      root.PPSettings.set(documentID, { lastHealth: { at: new Date().toISOString(), errors: errors, warnings: warnings, count: issues.length } });
      const lines = issues.slice(0, 30).map(function (x, i) {
        const where = x.noteIndex ? "注 " + x.noteIndex : "正文";
        return (i + 1) + ". [" + x.severity + "] " + where + " · " + x.summary + "\n   " + x.action;
      });
      if (!options || !options.silent) msg("体检完成：引文 " + scan.fields.length + " 条，文献表 " + scan.bibliography.length + " 个；错误 " + errors + "，警告 " + warnings + "。\n\n" + (lines.join("\n") || "未发现异常。"));
      return { ok: errors === 0, code: errors ? "HEALTH_ISSUES" : "OK", count: issues.length, issues: issues, scan: scan };
    } catch (e) {
      if (!options || !options.silent) msg("文档体检失败：" + String((e && e.message) || e));
      return { ok: false, code: "HEALTH_SCAN_FAILED", issues: [] };
    }
  }

  // ---------- P1：引文上下文、管理面板、状态与自动化 ----------
  function chooseCitationItem(ref) {
    if (!ref || !ref.items || !ref.items.length) return Promise.resolve(null);
    if (ref.items.length === 1) return Promise.resolve(ref.items[0]);
    const lines = ["此引文包含多篇文献，请选择："].concat(ref.items.map(function (item, i) {
      return (i + 1) + ". " + root.PPContext.describe(item);
    }));
    let answer = null;
    try { answer = root.prompt(lines.join("\n")); } catch (e) { return Promise.resolve(null); }
    if (answer == null || !String(answer).trim()) return Promise.resolve(null);
    const n = Number(answer);
    return Promise.resolve(Number.isInteger(n) && n >= 1 && n <= ref.items.length ? ref.items[n - 1] : null);
  }

  async function openCitationTarget(ref, kind) {
    const item = await chooseCitationItem(ref);
    if (!item) return { ok: false, cancelled: true, error: "未选择文献条目" };
    let uri = "";
    if (kind === "pdf" || kind === "source") {
      const saved = savedLocation(ref, item) || {};
      const pdf = saved.attachmentKey ? { key: saved.attachmentKey } : await Z.bestPdf(item.key);
      if (pdf) uri = L.pdfUri(pdf.key, Number(saved.page || item.page) || 0, saved.annotation || item.annotation || item.anno || "");
      if (!uri && kind === "pdf") return { ok: false, error: "该条目没有可用 PDF，已保留其他引文操作" };
    }
    if (!uri) uri = L.selectUri(item.key, item.libId || 1, item.libType || "users");
    try {
      await Z.call("/open", { method: "POST", body: { uri: uri } });
      return { ok: true, uri: uri, item: item };
    } catch (e) { return { ok: false, error: "打开失败：" + String((e && e.message) || e) }; }
  }

  function editFieldCitation(ref) {
    if (!ref) return Promise.resolve({ ok: false, error: "引文目标不存在" });
    try {
      const range = ref.field && ref.field.Result;
      if (!range) throw new Error("域范围不可用");
      range.Select();
      return nativeRun("editCitation");
    } catch (e) { return Promise.resolve({ ok: false, error: String((e && e.message) || e) }); }
  }

  function citationInfo(ref) {
    const lines = (ref && ref.items || []).map(function (item, i) {
      const saved = savedLocation(ref, item) || {};
      return (i + 1) + ". " + root.PPContext.describe(item) + "\n   " +
        root.PPZFields.canonicalIdentity(item) + (item.locator ? " · 页码/locator " + item.locator : "") +
        (saved.page ? " · PDF 第 " + saved.page + " 页" : "") + (saved.annotation ? " · 标注 " + saved.annotation : "");
    });
    const text = "citationID：" + (ref && ref.citationID || "损坏/未知") + "\n" + (lines.join("\n") || "没有可解析条目");
    msg(text);
    return { ok: true, text: text };
  }

  async function quickContext() {
    const ref = root.PPContext.current();
    if (!ref) { msg("光标不在引文上，未显示引文动作。"); return { ok: false, error: "光标不在引文上" }; }
    let pdfAvailable = false;
    try {
      const pdfs = await Promise.all(ref.items.map(function (item) { return Z.bestPdf(item.key); }));
      pdfAvailable = pdfs.some(Boolean);
    } catch (e) { pdfAvailable = false; }
    const actions = root.PPContext.actions(ref, pdfAvailable);
    let raw = null;
    try { raw = root.prompt(actions.map(function (x, i) { return (i + 1) + ". " + x.label + (x.enabled ? "" : "（不可用：" + x.reason + "）"); }).join("\n") + "\n\n输入序号："); }
    catch (e) { return { ok: false, error: "当前 WPS 无可用快捷面板或输入框" }; }
    const n = Number(raw);
    if (raw == null || !String(raw).trim()) return { ok: false, cancelled: true };
    if (!Number.isInteger(n) || n < 1 || n > actions.length) return { ok: false, cancelled: true };
    if (!actions[n - 1].enabled) { msg(actions[n - 1].reason); return { ok: false, error: actions[n - 1].reason }; }
    const result = await root.PPContext.execute(actions[n - 1].id, ref);
    if (result && result.error) msg(result.error);
    return result;
  }

  // ---------- P0–P2：检查中心、定位编辑、安全重连与文档方案 ----------
  const centerStates = new Map(), locatorStates = new Map();
  function centerState(documentID) {
    const id = String(documentID || "unknown");
    if (!centerStates.has(id)) centerStates.set(id, { kind: "health", report: null, repair: null, crossdoc: null, selectedProfile: "", message: "" });
    return centerStates.get(id);
  }
  function locationKey(citationID, item) {
    return String(citationID || "") + "|" + root.PPZFields.canonicalIdentity(item);
  }
  function savedLocation(ref, item) {
    try {
      const rows = root.PPSettings.get(Doc.documentID(Doc.doc())).citationLocations || {};
      return rows[locationKey(ref && ref.citationID, item)] || null;
    } catch (e) { return null; }
  }
  function publicCandidate(row) {
    return { key: row.key, libId: row.libId || 1, libType: row.libType || "users", uri: row.uri || "",
      title: itemTitle(row.data), author: String(row.data && row.data.creators && row.data.creators[0] && (row.data.creators[0].lastName || row.data.creators[0].name) || ""),
      year: itemYear(row.data), data: row.data || {} };
  }
  async function writeCitationChange(ref, nextCode, audit) {
    const d = Doc.doc(), scan = root.PPFieldScanner.scan(d), fresh = scan.fields.find(function (x) { return x.fieldID === ref.fieldID; });
    if (!fresh || fresh.code !== ref.code) throw new Error("引文已在操作期间变化，未写入；请重新扫描");
    const R = root.PPRecovery, raw = root.PPIntegration.__readDocDataForRecovery();
    const backup = R.begin(scan.documentID, scan, raw);
    R.snapshotTouched(backup, fresh);
    try {
      fresh.field.Code.Text = nextCode;
      if (String(fresh.field.Code.Text || "") !== nextCode) throw new Error("WPS 域代码写入回读不一致");
      const result = await nativeRun("refresh", audit || {});
      if (!result || !result.ok) throw new Error("Zotero 刷新未完成");
      R.commit(backup);
      return result;
    } catch (e) {
      const restored = R.restore(backup);
      throw new Error(String((e && e.message) || e) + (restored.ok ? "；已恢复修改前引文" : "；恢复未完全成功，请立即撤销并另存备份"));
    }
  }
  async function buildLocatorState(ref) {
    const items = [];
    for (const item of ref.items || []) {
      const saved = savedLocation(ref, item) || {};
      let pdf = null, annotations = [];
      try {
        pdf = saved.attachmentKey ? { key: saved.attachmentKey } : await Z.bestPdf(item.key);
        if (pdf) annotations = await Z.annotations(pdf.key);
      } catch (e) { annotations = []; }
      items.push({ identity: root.PPZFields.canonicalIdentity(item), key: item.key, libId: item.libId || 1, libType: item.libType || "users",
        title: root.PPContext.describe(item), locator: item.locator || "", label: item.label || "", page: Number(saved.page || item.page) || 0,
        annotation: String(saved.annotation || item.annotation || item.anno || ""), attachmentKey: pdf && pdf.key || "",
        annotations: annotations.map(function (a) { return { key: a.key, page: a.page, text: String(a.text || a.comment || "").slice(0, 240) }; }) });
    }
    return { fieldID: ref.fieldID, citationID: ref.citationID, items: items };
  }
  async function openLocatorEditor(ref) {
    const target = ref || root.PPContext.current();
    if (!target) { msg("请先把光标放进一条引文。"); return { ok: false, code: "NO_CITATION" }; }
    if (!target.citationID) { msg("该引文缺少 citationID，不能安全保存定位；请先修复或重新插入。"); return { ok: false }; }
    const state = await buildLocatorState(target);
    locatorStates.set(Doc.documentID(Doc.doc()), state);
    const opened = await openManager("locator");
    if (opened.mode !== "unavailable") return opened;
    const item = await chooseCitationItem(target);
    if (!item) return { ok: false, cancelled: true };
    let raw = null;
    try { raw = prompt("定位编辑（所选文献）\n输入：页码,正文 locator,标注key（后两项可空）"); } catch (e) { return { ok: false }; }
    if (!raw) return { ok: false, cancelled: true };
    const parts = String(raw).split(",");
    return updateCitationLocation(target, { identity: root.PPZFields.canonicalIdentity(item), page: Number(parts[0]) || 0,
      locator: parts[1] || "", annotation: parts[2] || "", attachmentKey: "" });
  }
  async function updateCitationLocation(ref, data) {
    const identity = String(data.identity || ""), item = ref.items.find(function (x) { return root.PPZFields.canonicalIdentity(x) === identity; });
    if (!item) throw new Error("定位目标条目不属于当前引文");
    const page = Math.max(0, Math.min(99999, Number(data.page) || 0));
    const annotation = String(data.annotation || "").toUpperCase();
    if (annotation && !/^[A-Z0-9]{8}$/.test(annotation)) throw new Error("标注 key 必须为 8 位字母数字");
    const attachmentKey = String(data.attachmentKey || "").toUpperCase();
    if (attachmentKey && !/^[A-Z0-9]{8}$/.test(attachmentKey)) throw new Error("PDF 附件 key 无效");
    const changed = root.PPCitationTools.updateLocator(ref.code, identity, data);
    await writeCitationChange(ref, changed.code, { auditOperation: "citationLocation", auditSummary: "更新引文页码与 PDF 定位" });
    const id = Doc.documentID(Doc.doc()), state = root.PPSettings.get(id), rows = Object.assign({}, state.citationLocations || {});
    rows[locationKey(ref.citationID, item)] = { page: page, annotation: annotation, attachmentKey: attachmentKey, locator: changed.locator, updatedAt: new Date().toISOString() };
    root.PPSettings.set(id, { citationLocations: rows });
    const nextLocator = await buildLocatorState(ref);
    nextLocator.items.forEach(function (x) { if (x.identity === identity) { x.locator = changed.locator; x.label = String(data.label || ""); x.page = page; x.annotation = annotation; } });
    locatorStates.set(id, nextLocator);
    await publishManager();
    msg("已保存正文 locator，并让 Zotero 完成刷新；PDF 页码/标注定位已按文档保存。");
    return { ok: true, locator: changed.locator, page: page, annotation: annotation };
  }
  function plainCenterItem(item) {
    if (!item) return null;
    return { key: item.key || item.itemKey || "", libId: item.libId == null ? 1 : item.libId, libType: item.libType || "users",
      itemData: item.itemData || item.data || null };
  }
  function plainCenterTarget(target) {
    if (!target) return null;
    return { fieldID: target.fieldID || "", citationID: target.citationID || "", container: target.container || "body",
      noteID: target.noteID || null, noteIndex: Number(target.noteIndex) || 0, identity: target.identity || "", itemKey: target.itemKey || "",
      item: plainCenterItem(target.item) };
  }
  function plainCenterFinding(row) {
    return { kind: row.kind || "ISSUE", severity: row.severity || "warning", fieldID: row.fieldID || "",
      noteIndex: Number(row.noteIndex) || 0, summary: String(row.summary || ""), reason: String(row.reason || ""),
      action: String(row.action || ""), target: plainCenterTarget(row.target), item: plainCenterItem(row.item) };
  }
  function normalizeHealthReport(result) {
    return { ok: true, kind: "health", generatedAt: new Date().toISOString(), findings: (result.issues || []).map(plainCenterFinding),
      counts: { citationFields: result.scan.fields.length, bibliographyFields: result.scan.bibliography.length,
        errors: (result.issues || []).filter(function (x) { return x.severity === "error"; }).length,
        warnings: (result.issues || []).filter(function (x) { return x.severity === "warning"; }).length },
      readOnly: true };
  }
  async function runCenterCheck(kind, data) {
    const d = Doc.doc(), id = Doc.documentID(d), state = centerState(id), opts = data || {};
    state.kind = kind || state.kind || "health";
    let report;
    if (state.kind === "preflight") {
      let profile = null;
      if (opts.profileID !== undefined) state.selectedProfile = String(opts.profileID || "");
      profile = (root.PPSettings.get(id).submissionProfiles || []).find(function (x) { return x.id === state.selectedProfile; }) || null;
      if (profile && opts.applyStyle && profile.styleID && profile.styleID !== currentZoteroStyleID()) {
        const switched = await switchZoteroStyle({ styleID: profile.styleID, label: profile.styleLabel || profile.name });
        if (!switched || !switched.ok) throw new Error("方案样式未能应用，已停止检查");
      }
      report = await preflightCheck({ silent: true, profile: profile });
    } else if (state.kind === "compatibility") report = await compatibilityCheck(opts.target || "word", { silent: true });
    else report = normalizeHealthReport(await inspectHealth({ silent: true }));
    if (Array.isArray(report.findings)) {
      report.findings = report.findings.map(plainCenterFinding);
      report.issues = report.findings;
    }
    state.report = report; state.repair = null; state.message = "检查已更新";
    await publishManager();
    return report;
  }
  async function openCheckCenter(kind) {
    const id = Doc.documentID(Doc.doc()); centerState(id).kind = kind || "health";
    const report = await runCenterCheck(kind);
    const opened = await openManager("checks");
    if (opened.mode === "unavailable") {
      if (kind === "preflight") showPreflight(report);
      else if (kind === "compatibility") showCompatibility(report);
      else msg((report.findings || []).map(function (x, i) { return (i + 1) + ". " + x.summary + "\n" + x.action; }).join("\n") || "未发现异常。");
    }
    return opened;
  }
  function centerReportText(report) {
    if (!report) return "";
    if (report.kind !== "health") return root.PPHealth.reportText(report);
    return ["Papilot Cite 文档体检（只读）", "时间：" + report.generatedAt, ""].concat((report.findings || []).map(function (x, i) {
      return (i + 1) + ". [" + x.severity + "] " + x.summary + "\n" + x.reason + "\n建议：" + x.action;
    })).join("\n");
  }
  async function repairPreview(data) {
    const ref = findFreshField(data.fieldID);
    if (!ref) throw new Error("引文已变化，请重新扫描");
    const identity = String(data.identity || (ref.items[0] && root.PPZFields.canonicalIdentity(ref.items[0])) || "");
    const item = ref.items.find(function (x) { return root.PPZFields.canonicalIdentity(x) === identity; });
    if (!item) throw new Error("未找到要重连的条目身份");
    const query = String(data.query || item.itemData && item.itemData.title || item.key).trim();
    if (!query) throw new Error("请输入用于查找替代条目的关键词");
    const found = await Z.search(query, 10), state = centerState(Doc.documentID(Doc.doc()));
    state.repair = { fieldID: ref.fieldID, identity: identity, query: query, old: root.PPContext.describe(item),
      candidates: found.map(publicCandidate), at: new Date().toISOString() };
    state.message = found.length ? "找到 " + found.length + " 个候选；选择后须再次确认才写入" : "没有找到候选条目";
    await publishManager();
    return state.repair;
  }
  async function repairApply(data) {
    if (data.confirmed !== true) throw new Error("重连必须先预览并明确确认");
    const id = Doc.documentID(Doc.doc()), state = centerState(id), preview = state.repair;
    if (!preview || preview.fieldID !== data.fieldID || preview.identity !== data.identity) throw new Error("重连预览已过期，请重新查找候选");
    const candidate = preview.candidates.find(function (x) { return x.key === data.key && (!x.uri || x.uri === data.uri); });
    if (!candidate) throw new Error("所选候选不在本次预览中，已禁止写入");
    const ref = findFreshField(preview.fieldID);
    if (!ref) throw new Error("引文已变化，请重新扫描");
    const changed = root.PPCitationTools.reconnect(ref.code, preview.identity, candidate);
    await writeCitationChange(ref, changed.code, { auditOperation: "citationReconnect", auditSummary: preview.old + " → " + candidate.title });
    state.repair = null; state.message = "已重连到 " + candidate.title + "，Zotero 刷新完成";
    await runCenterCheck("health");
    return { ok: true, key: candidate.key };
  }
  function favoriteStyles() {
    try { return (root.PPSettings.get(Doc.documentID(Doc.doc())).favoriteStyles || []).map(styleDescriptor).filter(Boolean).slice(0, 3); }
    catch (e) { return []; }
  }
  async function favoriteSave(data) {
    const slot = Number(data.slot), id = Doc.documentID(Doc.doc()), old = root.PPSettings.get(id).favoriteStyles || [];
    if (!(slot >= 0 && slot < 3)) throw new Error("收藏位置无效");
    const st = styleDescriptor({ styleID: data.styleID || currentZoteroStyleID(), label: data.label || "收藏样式" });
    if (!st) throw new Error("样式 ID 无效，应为 Zotero 样式地址");
    st.label = String(data.label || st.label).trim().slice(0, 60) || st.label;
    const rows = old.slice(0, 3); while (rows.length < 3) rows.push(null);
    rows[slot] = { styleID: st.id, label: st.label, updatedAt: new Date().toISOString() };
    root.PPSettings.set(id, { favoriteStyles: rows.filter(Boolean) });
    try { if (wps.ribbonUI && wps.ribbonUI.Invalidate) wps.ribbonUI.Invalidate(); } catch (e) { /* 动态标签下次刷新生效 */ }
    await publishManager();
    return { ok: true, slot: slot, style: st };
  }
  async function favoriteRemove(data) {
    const slot = Number(data.slot), id = Doc.documentID(Doc.doc()), old = root.PPSettings.get(id).favoriteStyles || [];
    if (!(slot >= 0 && slot < 3)) throw new Error("收藏位置无效");
    const rows = old.filter(function (_, i) { return i !== slot; });
    root.PPSettings.set(id, { favoriteStyles: rows });
    try { if (wps.ribbonUI && wps.ribbonUI.Invalidate) wps.ribbonUI.Invalidate(); } catch (e) { /* 下次刷新生效 */ }
    await publishManager(); return { ok: true };
  }
  async function profileSave(data) {
    const id = Doc.documentID(Doc.doc()), old = root.PPSettings.get(id).submissionProfiles || [];
    const name = String(data.name || "").trim().slice(0, 60);
    if (!name) throw new Error("方案名称不能为空");
    const row = { id: String(data.id || "profile-" + Date.now().toString(36)), name: name,
      styleID: data.includeStyle ? currentZoteroStyleID() : "", styleLabel: data.includeStyle ? String(data.styleLabel || "") : "",
      requireDOI: data.requireDOI === true, requirePages: data.requirePages === true, checkUncited: data.checkUncited !== false,
      updatedAt: new Date().toISOString() };
    const rows = old.filter(function (x) { return x.id !== row.id; }); rows.push(row);
    if (rows.length > 8) throw new Error("每份文档最多保存 8 个投稿方案");
    root.PPSettings.set(id, { submissionProfiles: rows });
    centerState(id).selectedProfile = row.id;
    await publishManager(); return row;
  }
  async function profileDelete(data) {
    const id = Doc.documentID(Doc.doc()), old = root.PPSettings.get(id).submissionProfiles || [];
    root.PPSettings.set(id, { submissionProfiles: old.filter(function (x) { return x.id !== data.id; }) });
    if (centerState(id).selectedProfile === data.id) centerState(id).selectedProfile = "";
    await publishManager(); return { ok: true };
  }
  async function crossDocumentHealth() {
    const rows = [];
    for (const d of Doc.listDocuments()) {
      try {
        const scan = root.PPFieldScanner.scan(d), issues = await healthForScan(scan);
        rows.push({ documentID: scan.documentID, name: String(d.Name || scan.documentID), ok: true, citations: scan.fields.length,
          bibliographies: scan.bibliography.length, errors: issues.filter(function (x) { return x.severity === "error"; }).length,
          warnings: issues.filter(function (x) { return x.severity === "warning"; }).length });
      } catch (e) { rows.push({ documentID: Doc.documentID(d), name: String(d.Name || "未知文档"), ok: false, error: String((e && e.message) || e) }); }
    }
    const state = centerState(Doc.documentID(Doc.doc())); state.crossdoc = { at: new Date().toISOString(), rows: rows };
    await publishManager(); return state.crossdoc;
  }
  function chapterBookmark(group) {
    const text = group.index + "|" + group.title; let hash = 2166136261;
    for (let i = 0; i < text.length; i++) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 16777619); }
    return "PPCHAPBIB_" + (hash >>> 0).toString(36) + "_" + group.index;
  }
  async function chapterBibliographyFlow() {
    const d = Doc.doc(), id = Doc.documentID(d), scan = root.PPFieldScanner.scan(d), state = root.PPSettings.get(id);
    const groups = root.PPCitationTools.plan(scan, Doc.paragraphSnapshot(d), { previous: state.bibliographyMap, styleID: currentZoteroStyleID() });
    const preview = groups.map(function (g) { return g.title + "：" + g.entries.length + " 条"; }).join("\n");
    if (!confirmAction("将生成/更新 " + groups.length + " 个分章文献表：\n" + preview + "\n\n这些是由当前总文献表生成的纯文本静态快照，保留当前编号；不会随 Zotero 自动刷新。后续可再次点击本入口更新。继续？")) return { ok: false, cancelled: true };
    const blocks = groups.map(function (g) { return { bookmark: chapterBookmark(g), position: g.end, text: g.text }; })
      .sort(function (a, b) { return b.position - a.position; });
    const result = Doc.writeStaticBlocks(blocks);
    if (root.PPAudit) root.PPAudit.record(id, { operation: "chapterBibliography", ok: true, count: groups.length, summary: "生成/更新分章静态文献表" });
    await publishManager();
    msg("已生成/更新 " + result.count + " 个分章文献表（静态快照）。总文献表和 Zotero 域未改动。");
    return result;
  }

  async function healthForScan(scan) {
    const keys = [];
    scan.fields.forEach(function (f) { f.items.forEach(function (item) { if (keys.indexOf(item.key) < 0) keys.push(item.key); }); });
    let library = null, connected = false;
    try { library = await Z.items(keys); connected = true; } catch (e) { connected = false; }
    const settings = root.PPSettings.get(scan.documentID);
    return root.PPHealth.inspect(scan, { library: library, libraryScope: "users", zoteroConnected: connected,
      lastSuccess: settings.lastSuccess, fingerprint: root.PPFieldScanner.fingerprint(scan),
      canLocate: function (field) { try { return !!root.PPFieldScanner.locate(field, scan); } catch (e) { return false; } } });
  }

  function managerRow(row) {
    return { n: row.n, fieldID: row.fieldID, citationID: row.citationID, text: row.text,
      items: row.items.map(function (x) { return { identity: x.identity, title: x.title, author: x.author, year: x.year, locator: x.locator }; }),
      title: row.title, author: row.author, year: row.year, locator: row.locator, chapter: row.chapter,
      container: row.container, noteIndex: row.noteIndex, broken: row.broken, issueText: row.issueText };
  }

  async function publishManager() {
    const d = Doc.doc(), scan = root.PPFieldScanner.scan(d), issues = await healthForScan(scan);
    const rows = root.PPManager.load(scan, issues), state = root.PPSettings.get(scan.documentID);
    const status = { lastRefresh: state.lastRefresh, citationCount: scan.fields.length,
      bibliographyCount: scan.bibliography.length, issueCount: issues.length };
    const center = centerState(scan.documentID);
    const payload = { documentID: scan.documentID, rows: rows.map(managerRow), status: status,
      center: { kind: center.kind, report: center.report, repair: center.repair, crossdoc: center.crossdoc,
        selectedProfile: center.selectedProfile, message: center.message, lastCommand: center.lastCommand || null,
        profiles: state.submissionProfiles || [], favorites: state.favoriteStyles || [], currentStyleID: currentZoteroStyleID() },
      locator: locatorStates.get(scan.documentID) || {} };
    await Z.call("/manager", { method: "POST", body: payload });
    return { ok: true, scan: scan, issues: issues, rows: rows, status: status };
  }

  let managerPane = null, managerPaneDocumentID = "", managerPaneView = "";
  function managerUrl(documentID, view, itemKey) {
    const base = pickerUrl().replace(/picker\.html$/, "manager.html") || "manager.html";
    return base + "?documentID=" + encodeURIComponent(documentID) + "&view=" + encodeURIComponent(view || "citations") +
      (itemKey ? "&itemKey=" + encodeURIComponent(itemKey) : "");
  }
  function basicManager(snapshot) {
    let query = "";
    try { query = root.prompt("引文管理：输入搜索词（空字符串列出全部，最多显示 60 条）") || ""; } catch (e) { query = ""; }
    const rows = root.PPManager.search(query, false).slice(0, 60);
    if (!rows.length) { msg("没有匹配的引文。"); return { ok: true, empty: true }; }
    const lines = rows.map(function (r, i) { return (i + 1) + ". " + [r.text, r.title, r.author, r.year, r.broken ? "异常:" + r.issueText : ""].filter(Boolean).join(" · "); });
    let raw = null;
    try { raw = root.prompt(lines.join("\n") + "\n\n输入“序号 动作”，动作：定位/编辑/原文（默认定位）"); } catch (e) { return { ok: false }; }
    if (raw == null || !String(raw).trim()) return { ok: false, cancelled: true };
    const match = /^\s*(\d+)(?:\s*(编辑|原文|定位))?\s*$/.exec(raw);
    if (!match || Number(match[1]) > rows.length) return { ok: false, cancelled: true };
    const row = rows[Number(match[1]) - 1], action = match[2] === "编辑" ? "edit" : match[2] === "原文" ? "source" : "locate";
    return runManagerCommand({ action: action, fieldID: row.fieldID, documentID: snapshot.scan.documentID });
  }

  async function openManager(view, options) {
    const currentView = view || "citations", opts = options || {};
    const snapshot = await publishManager(), probe = apiProbe(), documentID = snapshot.scan.documentID;
    const url = managerUrl(documentID, currentView, opts.itemKey);
    if (probe.CreateTaskPane === "function") {
      try {
        if (managerPane && managerPaneDocumentID === documentID && managerPaneView !== currentView) {
          let navigated = false;
          try { if (typeof managerPane.Navigate === "function") { managerPane.Navigate(url); navigated = true; } } catch (e) { navigated = false; }
          if (!navigated) { try { managerPane.Visible = false; } catch (e) { /* 对话框继续接管 */ } managerPane = null; }
        }
        if (!managerPane || managerPaneDocumentID !== documentID) {
          managerPane = wps.CreateTaskPane(url, "Papilot 引文中心", 960, 620);
          managerPaneDocumentID = managerPane ? documentID : "";
        }
        if (managerPane) { managerPaneView = currentView; managerPane.Visible = true; return { ok: true, mode: "taskpane" }; }
      } catch (e) { log("manager taskpane failed", { err: String((e && e.message) || e) }); }
    }
    if (probe.ShowDialog === "function") {
      try { wps.ShowDialog(url, currentView === "citations" ? "引文管理" : "Papilot 引文中心", 1040, 700); return { ok: true, mode: "dialog" }; }
      catch (e) { log("manager dialog failed", { err: String((e && e.message) || e) }); }
    }
    if (currentView === "citations") return basicManager(snapshot);
    return { ok: false, mode: "unavailable" };
  }

  function findFreshField(fieldID) {
    const scan = root.PPFieldScanner.scan(Doc.doc());
    return scan.fields.find(function (f) { return f.fieldID === fieldID; }) || null;
  }
  let managerCommandQueue = Promise.resolve();
  const RESULT_ACTIONS = { "locator-save": 1, "run-check": 1, "locate-report": 1, "export-report": 1,
    "repair-preview": 1, "repair-apply": 1, "crossdoc-health": 1, "profile-save": 1, "profile-delete": 1,
    "favorite-save": 1, "favorite-remove": 1 };
  function runManagerCommand(command) {
    const task = managerCommandQueue.then(async function () {
      const d = Doc.doc(), currentID = Doc.documentID(d);
      if (!command.documentID || command.documentID !== currentID) {
        const error = "命令属于另一文档或缺少文档身份，已阻止执行";
        msg(error);
        return { ok: false, code: "WRONG_DOCUMENT", error: error };
      }
      const data = command.data && typeof command.data === "object" ? command.data : {};
      if (command.action === "manager-refresh") return publishManager();
      if (command.action === "run-check") return runCenterCheck(String(command.kind || data.kind || "health"), data);
      if (command.action === "locate-report") return locateReportTarget(data.target || data);
      if (command.action === "export-report") {
        const report = centerState(currentID).report;
        if (!report) return { ok: false, error: "还没有可导出的检查报告" };
        const text = centerReportText(report), saved = downloadText("引文检查-" + stamp() + ".md", text, "text/markdown;charset=utf-8");
        return { ok: saved.ok, method: saved.method, text: text };
      }
      if (command.action === "repair-preview") return repairPreview(data);
      if (command.action === "repair-apply") return repairApply(data);
      if (command.action === "crossdoc-health") return crossDocumentHealth();
      if (command.action === "profile-save") return profileSave(data);
      if (command.action === "profile-delete") {
        if (data.confirmed !== true) throw new Error("删除方案需要确认");
        return profileDelete(data);
      }
      if (command.action === "favorite-save") return favoriteSave(data);
      if (command.action === "favorite-remove") return favoriteRemove(data);
      if (command.action === "batch-open") return batchOpenFromManager(Array.isArray(command.fieldIDs) ? command.fieldIDs : [], String(command.kind || ""));
      if (command.action === "select") {
        const ok = root.PPManager.setSelected(command.fieldID, !!command.checked);
        return { ok: ok, code: ok ? "OK" : "ROW_NOT_FOUND", selected: root.PPManager.selectedIdentities().length };
      }
      const ref = findFreshField(command.fieldID);
      if (!ref) { msg("该引文已删除或身份已变化，请重新扫描。"); await publishManager(); return { ok: false, error: "引文不存在" }; }
      if (command.action === "locate") return root.PPNav.locate(ref);
      if (command.action === "locator-save") return updateCitationLocation(ref, data);
      if (command.action === "edit") return editFieldCitation(ref);
      if (command.action === "bibliography") return root.PPNav.toBibliography(ref);
      if (command.action === "source" || command.action === "pdf") return openCitationTarget(ref, command.action);
      if (command.action === "zotero") return openCitationTarget(ref, "zotero");
      if (command.action === "info") return citationInfo(ref);
      return { ok: false, error: "未知管理命令" };
    }).catch(function (e) { return { ok: false, error: String((e && e.message) || e) }; });
    const reported = task.then(async function (result) {
      if (!RESULT_ACTIONS[command.action]) return result;
      try {
        const id = Doc.documentID(Doc.doc());
        if (id !== command.documentID) return result;
        const state = centerState(id), data = command.data && typeof command.data === "object" ? command.data : {};
        const summary = { clientID: String(data.clientID || ""), action: command.action,
          ok: !!result && result.ok !== false, code: String(result && result.code || ""),
          error: String(result && result.error || ""), method: String(result && result.method || ""), at: new Date().toISOString() };
        state.lastCommand = summary;
        if (summary.error) state.message = summary.error;
        await publishManager();
      } catch (e) { log("command result publish failed", { action: command.action, err: String((e && e.message) || e) }); }
      return result;
    });
    managerCommandQueue = reported.then(function () { return null; }, function () { return null; });
    return reported;
  }

  function refreshStatus() {
    const d = Doc.doc(), state = root.PPSettings.get(Doc.documentID(d)), last = state.lastRefresh;
    const text = last ? ["时间：" + last.at, "结果：" + (last.cancelled ? "已取消" : last.ok === false ? "失败" : last.changed === false ? "成功（无变化）" : "成功"),
      "引文域：" + Number(last.count || last.citationCount || 0), "文献表域：" + Number(last.bibliographyCount || 0),
      "异常：" + Number(last.issueCount || 0), last.error ? "原因：" + last.error : ""].filter(Boolean).join("\n") : "本文档尚未刷新。";
    msg(text);
    return { ok: true, lastRefresh: last };
  }

  let automationBound = false, autoRefreshPending = false;
  function automationAvailable() { return typeof root.wps !== "undefined" && !!(wps.ApiEvent && typeof wps.ApiEvent.AddApiEventListener === "function"); }
  function onDocumentOpen() {
    try {
      const d = Doc.doc(), id = Doc.documentID(d);
      if (root.PPSettings.get(id).autoCheckOnOpen) inspectHealth({ silent: true });
    } catch (e) { log("auto open check skipped", { err: String((e && e.message) || e) }); }
  }
  function onDocumentSave() {
    try {
      const d = Doc.doc(), id = Doc.documentID(d), state = root.PPSettings.get(id);
      if (!state.autoRefreshOnSave || autoRefreshPending || !Doc.docPath()) return;
      if (root.PPIntegration.__getBusy && root.PPIntegration.__getBusy()) return;
      autoRefreshPending = true;
      Promise.resolve(nativeRun("refresh", { mode: "auto" })).finally(function () { autoRefreshPending = false; });
    } catch (e) { autoRefreshPending = false; log("auto save refresh skipped", { err: String((e && e.message) || e) }); }
  }
  function bindAutomationEvents() {
    if (automationBound || !automationAvailable()) return false;
    try {
      wps.ApiEvent.AddApiEventListener("DocumentOpen", onDocumentOpen);
      wps.ApiEvent.AddApiEventListener("DocumentAfterSave", onDocumentSave);
      automationBound = true;
      return true;
    } catch (e) { log("automation events unavailable", { err: String((e && e.message) || e) }); return false; }
  }
  function automationSettings() {
    if (!automationAvailable()) { msg("当前 WPS 未提供文档事件 API，自动化选项已隐藏；手动检查和刷新仍可使用。"); return { ok: false, hidden: true }; }
    const d = Doc.doc(), id = Doc.documentID(d), old = root.PPSettings.get(id);
    let raw = null;
    try { raw = root.prompt("自动化设置（默认关闭）\n当前：打开检查=" + !!old.autoCheckOnOpen + "，保存后刷新=" + !!old.autoRefreshOnSave + "\n输入 1 切换打开检查，2 切换保存后刷新，0 全部关闭："); }
    catch (e) { return { ok: false }; }
    if (raw == null || !String(raw).trim()) return { ok: false, cancelled: true };
    const patch = String(raw).trim() === "0" ? { autoCheckOnOpen: false, autoRefreshOnSave: false } :
      String(raw).trim() === "1" ? { autoCheckOnOpen: !old.autoCheckOnOpen } :
      String(raw).trim() === "2" ? { autoRefreshOnSave: !old.autoRefreshOnSave } : null;
    if (!patch) return { ok: false, cancelled: true };
    root.PPSettings.set(id, patch);
    return { ok: true, settings: root.PPSettings.get(id) };
  }

  /* ---------- P2：投稿前检查 / 迁移报告 / 修改记录 / 无域副本 / 批量打开 ---------- */

  /** 统一的“确认”入口：没有原生 confirm 时退化为输入 1，读不到回答一律视为取消。 */
  function confirmAction(message) {
    try { if (typeof root.confirm === "function") return !!root.confirm(message); } catch (e) { /* 继续降级 */ }
    try {
      const answer = root.prompt(message + "\n\n输入 1 确认，其他任意输入取消：");
      return String(answer == null ? "" : answer).trim() === "1";
    } catch (e) { return false; }
  }
  function stamp() { return new Date().toISOString().slice(0, 10); }
  function findingWhere(row) {
    const target = row && row.target || {};
    if (target.bibliography) return "文献表";
    if (target.noteIndex) return "注 " + target.noteIndex;
    if (target.container === "footnote") return "脚注";
    if (target.container === "endnote") return "尾注";
    return "正文";
  }
  function findingLine(row, index) {
    return (index + 1) + ". [" + String(row.severity || "info") + "][" + findingWhere(row) + "] "
      + String(row.summary || "") + "\n   " + String(row.reason || "") + "\n   " + String(row.action || "");
  }

  /** 下载文本；Blob 不可用时退化为剪贴板，再退化为显示片段。绝不静默失败。 */
  function downloadText(filename, text, mime) {
    const body = String(text == null ? "" : text);
    try {
      const BlobCtor = typeof Blob !== "undefined" ? Blob : root.Blob;
      const doc = root.document;
      const urlApi = root.URL || (typeof URL !== "undefined" ? URL : null);
      if (BlobCtor && doc && urlApi && typeof urlApi.createObjectURL === "function") {
        const blob = new BlobCtor([body], { type: mime || "text/plain;charset=utf-8" });
        const anchor = doc.createElement("a");
        anchor.href = urlApi.createObjectURL(blob);
        anchor.download = filename;
        anchor.style.display = "none";
        (doc.body || doc.documentElement).appendChild(anchor);
        anchor.click();
        setTimeout(function () {
          try { anchor.remove(); urlApi.revokeObjectURL(anchor.href); } catch (e) { /* 已清理 */ }
        }, 1500);
        return { ok: true, method: "download", filename: filename };
      }
    } catch (e) { /* 尝试剪贴板 */ }
    try {
      if (root.navigator && root.navigator.clipboard && typeof root.navigator.clipboard.writeText === "function") {
        root.navigator.clipboard.writeText(body);
        return { ok: true, method: "clipboard", filename: filename };
      }
    } catch (e) { /* 显示片段 */ }
    msg("当前 WPS 不能直接保存文件，已显示报告前 1200 字，请手动复制：\n\n" + body.slice(0, 1200));
    return { ok: false, method: "none", filename: filename };
  }
  function exportReport(kind, report) {
    const text = root.PPHealth && root.PPHealth.reportText ? root.PPHealth.reportText(report)
      : JSON.stringify(report, null, 2);
    const filename = (kind === "compatibility" ? "迁移兼容检查-" : "投稿前检查-") + stamp() + ".md";
    const saved = downloadText(filename, text, "text/markdown;charset=utf-8");
    if (saved.method === "download") msg("已导出报告：" + filename);
    else if (saved.method === "clipboard") msg("报告已复制到剪贴板：" + filename);
    return { ok: saved.ok, method: saved.method, filename: filename, text: text };
  }

  /** 报告里的目标 → 文档位置（只读定位，不写任何内容）。 */
  function locateReportTarget(target) {
    if (!target || (!target.fieldID && !target.citationID)) {
      msg("这个问题没有可定位的引文域（例如未引用条目只出现在文献表中）。");
      return { ok: false, code: "NO_TARGET" };
    }
    try {
      const scan = root.PPFieldScanner.scan(Doc.doc());
      const ref = (scan.all || []).find(function (x) { return x.fieldID === target.fieldID; })
        || (scan.fields || []).find(function (x) { return target.citationID && x.citationID === target.citationID; });
      if (!ref) { msg("目标域已变化或已删除，请重新扫描后再定位。"); return { ok: false, code: "TARGET_GONE" }; }
      if (ref.kind === "item") return root.PPNav.locate(ref);
      const range = ref.range || ref.field && ref.field.Result;
      if (!range || typeof range.Select !== "function") { msg("该域的范围不可用，无法定位。"); return { ok: false }; }
      range.Select();
      try { Doc.app().ActiveWindow.ScrollIntoView(range, true); } catch (e) { /* 定位仍有效 */ }
      return { ok: true, code: "LOCATED" };
    } catch (e) {
      msg("定位失败：" + String((e && e.message) || e));
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  async function libraryForScan(scan) {
    const keys = [];
    if (root.PPHealth && typeof root.PPHealth.requiredItemKeys === "function") {
      const listed = root.PPHealth.requiredItemKeys(scan) || [];
      listed.forEach(function (key) { if (key) keys.push(key); });
    } else {
      (scan && scan.fields || []).forEach(function (field) {
        (field.items || []).forEach(function (item) { if (keys.indexOf(item.key) < 0) keys.push(item.key); });
      });
    }
    if (!keys.length) return { library: null, connected: false };
    try { return { library: await Z.items(keys), connected: true }; }
    catch (e) { return { library: null, connected: false }; }
  }

  async function preflightCheck(options) {
    if (!root.PPHealth || typeof root.PPHealth.preflight !== "function") {
      msg("投稿前检查模块未加载（health.js 缺失）。");
      return { ok: false, code: "MODULE_MISSING" };
    }
    try {
      const d = Doc.doc(), documentID = Doc.documentID(d);
      const scan = root.PPFieldScanner.scan(d);
      const lib = await libraryForScan(scan);
      let report = root.PPHealth.preflight(scan, {
        library: lib.library, zoteroConnected: lib.connected,
        styleID: currentZoteroStyleID(), documentID: documentID,
      });
      if (options && options.profile) report = root.PPHealth.applyProfile(report, options.profile);
      report.documentID = documentID;
      if (!options || !options.silent) showPreflight(report);
      return report;
    } catch (e) {
      msg("投稿前检查失败：" + String((e && e.message) || e));
      return { ok: false, code: "PREFLIGHT_FAILED", error: String((e && e.message) || e) };
    }
  }
  function showPreflight(report) {
    const counts = report.counts || {};
    const head = [
      "投稿前检查（只读，未修改文档）",
      "引文域 " + counts.citationFields + "（正文 " + counts.bodyCitations + " / 脚注 " + counts.footnoteCitations + " / 尾注 " + counts.endnoteCitations + "）",
      "唯一文献 " + counts.uniqueItems + "；文献表条目 " + (counts.bibliographyEntries == null ? "无法读取" : counts.bibliographyEntries)
        + "；差异 " + (counts.difference == null ? "无法计算" : counts.difference),
      "未引用 " + counts.uncitedItems + "；重复 " + (report.duplicates || []).length + "；建议 " + (report.suggestions || []).length,
      "",
    ];
    const rows = (report.findings || []).slice(0, 15).map(findingLine);
    let answer = null;
    try {
      answer = root.prompt(head.concat(rows.length ? rows : ["未发现需要提示的问题。"]).join("\n")
        + "\n\n输入问题序号定位；输入 e 导出报告；直接回车关闭：");
    } catch (e) { msg(head.join("\n") + "\n\n" + rows.join("\n")); return; }
    const raw = String(answer == null ? "" : answer).trim();
    if (!raw) return;
    if (/^e$/i.test(raw)) { exportReport("preflight", report); return; }
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= Math.min(15, (report.findings || []).length)) {
      locateReportTarget((report.findings || [])[n - 1].target);
    } else if (Number.isInteger(n) && n > 15) {
      msg("报告共 " + (report.findings || []).length + " 条，这里只显示前 15 条；输入 e 导出完整报告。");
    }
  }

  async function compatibilityCheck(target, options) {
    if (!root.PPHealth || typeof root.PPHealth.compatibility !== "function") {
      msg("迁移兼容检查模块未加载（health.js 缺失）。");
      return { ok: false, code: "MODULE_MISSING" };
    }
    try {
      const d = Doc.doc(), documentID = Doc.documentID(d), scan = root.PPFieldScanner.scan(d);
      const caps = root.PPCapabilities ? root.PPCapabilities.get(documentID, d) : null;
      let docData = "";
      try { docData = root.PPIntegration && root.PPIntegration.__readDocDataForRecovery ? root.PPIntegration.__readDocDataForRecovery() : ""; }
      catch (e) { docData = ""; }
      let proxyVersion = "", zoteroState = "未知", wpsVersion = "";
      try { wpsVersion = String(Doc.app().Version || ""); } catch (e) { wpsVersion = ""; }
      try {
        const health = await Z.health();
        proxyVersion = String(health && health.proxyVersion || "");
        zoteroState = health && health.localApi ? "本地 API 可用" : health && health.ok ? "Zotero 未开启本地 API" : "Zotero 未运行";
      } catch (e) { zoteroState = "未连接"; }
      const report = root.PPHealth.compatibility(scan, caps, {
        target: target, docData: docData,
        versions: { "加载项": root.PPC_VERSION || "", "WPS": wpsVersion || "未知", "本地代理": proxyVersion || "未知", "Zotero": zoteroState },
      });
      report.documentID = documentID;
      if (!options || !options.silent) showCompatibility(report);
      return report;
    } catch (e) {
      msg("迁移兼容检查失败：" + String((e && e.message) || e));
      return { ok: false, code: "COMPAT_FAILED", error: String((e && e.message) || e) };
    }
  }
  function showCompatibility(report) {
    const lines = [
      "迁移兼容检查（只读，不自动转换、不保存）",
      "目标：" + (report.targetLabel || report.target || "未知"),
      "结论：" + (report.verdictLabel || report.verdict),
      "依据：" + (report.reason || ""),
      "实测：" + (report.measured ? "是" : "否（未实测能力保持未验证）"),
      "",
      "证据：",
    ].concat((report.evidence || []).map(function (row, i) {
      return (i + 1) + ". [" + row.status + "] " + row.summary;
    }));
    let answer = null;
    try { answer = root.prompt(lines.join("\n") + "\n\n输入 e 导出报告；直接回车关闭："); }
    catch (e) { msg(lines.join("\n")); return; }
    if (/^e$/i.test(String(answer == null ? "" : answer).trim())) exportReport("compatibility", report);
  }
  async function compatibilityFlow() {
    let raw = null;
    try {
      raw = root.prompt("迁移兼容检查（只读）\n\n1. Word\n2. WPS\n3. LibreOffice\n\n输入目标编辑器序号：");
    } catch (e) { msg("当前 WPS 没有可用输入框，无法选择目标编辑器。"); return { ok: false }; }
    const key = String(raw == null ? "" : raw).trim();
    if (!key) return { ok: false, cancelled: true };
    const target = key === "1" ? "word" : key === "2" ? "wps" : key === "3" ? "libreoffice" : "";
    if (!target) { msg("没有识别到目标编辑器（请输入 1、2 或 3）。"); return { ok: false }; }
    return compatibilityCheck(target);
  }

  function auditFlow() {
    const A = root.PPAudit;
    if (!A) { msg("修改记录模块未加载（audit.js 缺失）。"); return { ok: false }; }
    let documentID = "";
    try { documentID = Doc.documentID(Doc.doc()); } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
    const rows = A.list(documentID);
    if (!rows.length) { msg("本文档还没有修改记录。"); return { ok: true, empty: true }; }
    const recent = rows.slice(-20).map(function (row, i) {
      return (i + 1) + ". " + String(row.at || "").replace("T", " ").slice(0, 19) + " · "
        + (row.label || row.operation || "未知操作") + " · " + (row.result || "") + (row.mode === "auto" ? "（自动）" : "")
        + " · 数量 " + Number(row.count || 0)
        + (row.from || row.to ? "\n   前：" + (row.from || "—") + " → 后：" + (row.to || "—") : "")
        + (row.summary ? "\n   " + row.summary : "");
    });
    let answer = null;
    try {
      answer = root.prompt("引文修改记录（最近 " + recent.length + " / 共 " + rows.length + " 条）\n\n"
        + recent.join("\n") + "\n\n输入 e 导出（需确认）、c 清空（需确认）；直接回车关闭：");
    } catch (e) { msg(recent.join("\n")); return { ok: true }; }
    const raw = String(answer == null ? "" : answer).trim();
    if (!raw) return { ok: true };
    if (/^e$/i.test(raw)) {
      if (!confirmAction("导出本文档的 " + rows.length + " 条修改记录？")) return { ok: false, cancelled: true };
      const exported = A.exportRows(documentID, true);
      if (!exported.ok) { msg("导出失败：" + (exported.error || exported.code || "未知原因")); return exported; }
      const saved = downloadText("引文修改记录-" + stamp() + ".txt", exported.text, "text/plain;charset=utf-8");
      if (saved.method === "download") msg("已导出修改记录：" + saved.filename);
      else if (saved.method === "clipboard") msg("修改记录已复制到剪贴板。");
      return { ok: saved.ok, method: saved.method, rows: exported.rows };
    }
    if (/^c$/i.test(raw)) {
      if (!confirmAction("清空本文档的全部修改记录？此操作不可撤销（不影响文档内容）。")) return { ok: false, cancelled: true };
      const cleared = A.clear(documentID, true);
      msg(cleared.ok ? "已清空本文档的修改记录。" : "清空失败：" + (cleared.error || cleared.code || "未知原因"));
      return cleared;
    }
    return { ok: true };
  }

  async function unlinkedCopyFlow() {
    const T = root.PPExportTools || root.PPDocumentTools;
    if (!T || typeof T.exportUnlinkedCopy !== "function") {
      msg("无域副本模块未加载（export-tools.js 缺失）。");
      return { ok: false, code: "MODULE_MISSING" };
    }
    const result = await T.exportUnlinkedCopy({
      sourcePath: Doc.docPath(),
      confirm: function (plan) {
        return confirmAction("将另存为无引文域副本：\n" + plan.targetPath
          + "\n\nZotero 域 " + plan.zoteroFields + " 个将被移除（保留显示文本）。"
          + (plan.dirty ? "\n注意：原稿有未保存修改，副本只包含磁盘/当前会话内容，原稿不会被保存。" : "")
          + "\n\n继续？");
      },
    });
    if (result && result.cancelled) { msg("已取消无域副本，原稿与副本都没有被修改。"); return result; }
    if (!result || !result.ok) {
      const originalHint = /^ORIGINAL_/.test(String(result && result.code || ""))
        ? "\n请按上面的提示立即检查原稿；本次操作没有在原稿上执行移除域。"
        : "\n原稿未被修改。";
      msg("无域副本失败：" + ((result && result.error) || "未知原因")
        + (result && result.copyPath ? "\n\n已生成的副本（未完成）：" + result.copyPath
          : result && result.targetPath ? "\n\n目标路径：" + result.targetPath : "")
        + originalHint);
      return result || { ok: false };
    }
    msg("已生成无引文域副本：\n" + result.copyPath
      + "\n\nZotero 域：" + (result.counts ? result.counts.zoteroFieldsBefore : result.count) + " → 0"
      + "\n原稿回读：域代码、文档数据、修改状态均未改变。");
    return result;
  }

  function itemsOfFields(scan, fieldIDs) {
    const wanted = new Set(fieldIDs || []), out = [];
    (scan.fields || []).forEach(function (field) {
      if (!wanted.has(field.fieldID)) return;
      (field.items || []).forEach(function (item) { out.push(item); });
    });
    return out;
  }
  function openResultLines(result) {
    const rows = (result.results || []).map(function (row, i) {
      const title = row.title || (row.item && root.PPContext ? root.PPContext.describe(row.item) : "") || row.key || row.identity;
      const mark = row.status === "opened" ? "已打开" : row.status === "skipped" ? "已跳过" : "失败";
      return (i + 1) + ". " + mark + " · " + title + (row.reason ? "\n   " + row.reason : "");
    });
    return rows;
  }
  async function showOpenResult(result) {
    if (!result) return result;
    if (result.cancelled) { msg("已取消批量打开，未打开任何条目。"); return result; }
    if (result.code === "CONFIRM_REQUIRED") { msg(result.error); return result; }
    const head = "批量打开结果：成功 " + (result.opened || []).length + "，跳过 " + (result.skipped || []).length
      + "，失败 " + (result.failed || []).length + "（共 " + result.count + " 项）";
    let answer = null;
    try {
      answer = root.prompt(head + "\n\n" + openResultLines(result).join("\n")
        + ((result.failed || []).length ? "\n\n输入 r 只重试失败项；直接回车关闭：" : ""));
    } catch (e) { msg(head + "\n\n" + openResultLines(result).join("\n")); return result; }
    if ((result.failed || []).length && /^r$/i.test(String(answer == null ? "" : answer).trim())) {
      const retried = await root.PPExternal.retry(result, { confirm: function (info) { return confirmAction("将重试 " + info.count + " 个失败项？"); } });
      return showOpenResult(retried);
    }
    return result;
  }
  async function batchOpenFlow(items, title, presetKind) {
    const E = root.PPExternal;
    if (!E || typeof E.openTargets !== "function") { msg("批量打开模块未加载（external.js 缺失）。"); return { ok: false }; }
    if (!items || !items.length) { msg("当前没有可打开的文献条目。"); return { ok: false, empty: true }; }
    let kind = presetKind || "";
    if (!kind) {
      const preview = items.slice(0, 10).map(function (item, i) {
        return (i + 1) + ". " + (root.PPContext ? root.PPContext.describe(item) : (item.key || ""));
      });
      let raw = null;
      try {
        raw = root.prompt((title || "批量打开") + "\n\n" + preview.join("\n")
          + (items.length > 10 ? "\n…共 " + items.length + " 项（按条目不重复计数）" : "")
          + "\n\n打开方式：1 Zotero　2 最佳 PDF　3 DOI　4 附件");
      } catch (e) { msg("当前 WPS 没有可用输入框，无法选择打开方式。"); return { ok: false }; }
      const answer = String(raw == null ? "" : raw).trim();
      if (!answer) return { ok: false, cancelled: true };
      kind = answer === "1" ? "zotero" : answer === "2" ? "pdf" : answer === "3" ? "doi" : answer === "4" ? "attachment" : "";
      if (!kind) { msg("没有识别到打开方式（请输入 1、2、3 或 4）。"); return { ok: false }; }
    }
    let documentID = "";
    try { documentID = Doc.documentID(Doc.doc()); } catch (e) { documentID = ""; }
    const result = await E.openTargets(items, kind, {
      documentID: documentID,
      confirm: function (info) { return confirmAction("本次共 " + info.count + " 项，超过单次上限 " + info.max + " 项。\n确定要全部打开吗？"); },
    });
    return showOpenResult(result);
  }
  async function batchOpenCurrent() {
    const ref = root.PPContext && root.PPContext.current();
    if (!ref) { msg("光标不在引文上，未执行批量打开。"); return { ok: false, error: "光标不在引文上" }; }
    return batchOpenFlow(ref.items, "批量打开当前引文（" + ref.items.length + " 篇）");
  }
  async function batchOpenFromManager(fieldIDs, kind) {
    const scan = root.PPFieldScanner.scan(Doc.doc());
    const items = itemsOfFields(scan, fieldIDs);
    if (!items.length) { msg("勾选的引文已变化或已删除，请重新扫描。"); return { ok: false }; }
    return batchOpenFlow(items, "批量打开管理面板勾选项（" + fieldIDs.length + " 个引文域）", kind);
  }

  async function openCrossdocCenter() {
    const ref = root.PPContext && root.PPContext.current();
    const itemKey = ref && ref.items && ref.items.length === 1 ? ref.items[0].key : "";
    const opened = await openManager("crossdoc", { itemKey: itemKey });
    return opened.mode === "unavailable" ? findCitations() : opened;
  }
  async function openConnectionCenter() {
    const health = await Z.health();
    if (!health.ok) {
      msg("本地代理未运行，无法打开连接中心。请运行：" + proxyBat() + "\n然后重新点击本入口。Zotero 与文档内容均未被修改。");
      return { ok: false, code: "PROXY_OFFLINE" };
    }
    const opened = await openManager("settings");
    if (opened.mode === "unavailable") msg("代理正常；Zotero：" + (health.zotero ? "已运行" : "未运行") + "；本地 API：" + (health.localApi ? "可用" : "未开启") + "\n本地 API 设置：Zotero → 设置 → 高级 → 允许其他应用程序与 Zotero 通信。");
    return opened;
  }
  async function openStyleFavorites() {
    const opened = await openManager("settings");
    if (opened.mode !== "unavailable") return opened;
    let raw = null;
    try { raw = prompt("收藏样式：输入 位置(1-3),完整样式ID,显示名称"); } catch (e) { return { ok: false }; }
    if (!raw) return { ok: false, cancelled: true };
    const parts = String(raw).split(",");
    return favoriteSave({ slot: Number(parts[0]) - 1, styleID: parts[1] || "", label: parts.slice(2).join(",") || "收藏样式" });
  }

  function OnAction(control) {
    const id = control && control.Id;
    log("action", { id: id });
    const run = {
      /* 三个主命令走 Zotero 原生对话框（integration 协议）：页面与功能与官方 Word 插件一致。
       *
       * ★ 命令名必须和 Zotero.Integration.Interface.prototype 上的方法名**逐字一致**
       *   （integration.js:708-1013 的方法表）：
       *     addCitation / editCitation / addEditCitation / addNote / addAnnotation /
       *     addBibliography / editBibliography / addEditBibliography /
       *     citationExplorer / refresh / removeCodes / setDocPrefs / exportDocument
       *   Zotero 侧就是 `new Interface(...)[command]()` —— 名字写错不是"没效果"，
       *   而是抛 TypeError 后**连 complete 都走不到**，Zotero 永久 inProgress，
       *   我们这边等 30 分钟超时。踩过：把 refresh 写成 refreshDocument，
       *   结果【刷新】点了完全没反应（日志里连一条 cmd 都没有）。
       *
       * 为什么用 AddEdit* 而不是 Add*：
       *   addEditCitation 会先 `_doc.cursorInField()`，光标在某条引注里就**编辑它**，
       *   否则新建 —— 这正是官方功能区那个按钮的行为（integration.js:740）。
       *   addCitation 只会无脑新建，于是在已有引注里点插入会嵌域。
       *   addEditBibliography 同理：已有文献表就编辑、没有才新建（:860），
       *   而 addBibliography 每次都新建一条，会把文档里堆出好几张文献表。 */
      btnCite: () => {
        /* 先把 Zotero 的引注浮窗"预约"到最前（代理会轮询最多 15 秒等它出现），再发起事务。
         * 反过来（事务开始后再叫）不行：协议循环里多发一个请求会被当成一次 respond。 */
        try { root.PPIntegration.raiseWindow(); } catch (e) { /* 置顶失败不影响插入 */ }
        return nativeRun("addEditCitation");
      },
      btnBib: () => nativeRun("addEditBibliography"),
      btnRefresh: () => nativeRun("refresh"),
      btnRefreshStatus: () => refreshStatus(),
      btnContext: () => quickContext(),
      btnLocator: () => openLocatorEditor(),
      btnStyleGB: () => switchZoteroStyle("gb7714"),
      btnStyleAPA: () => switchZoteroStyle("apa"),
      btnStyleNature: () => switchZoteroStyle("nature"),
      btnStyleIEEE: () => switchZoteroStyle("ieee"),
      btnRecent1: () => switchZoteroStyle(recentStyles()[0]),
      btnRecent2: () => switchZoteroStyle(recentStyles()[1]),
      btnRecent3: () => switchZoteroStyle(recentStyles()[2]),
      btnFavorite1: () => switchZoteroStyle(favoriteStyles()[0]),
      btnFavorite2: () => switchZoteroStyle(favoriteStyles()[1]),
      btnFavorite3: () => switchZoteroStyle(favoriteStyles()[2]),
      btnStyleFavorites: () => openStyleFavorites(),

      /* 样式统一进入 Zotero 文档首选项（GB/T、APA、Nature、IEEE 均在其中）。 */
      btnPrefs: () => {
        if (root.PPCapabilities) {
          const caps = root.PPCapabilities.get(Doc.documentID(Doc.doc()), Doc.doc());
          if (!caps.footnoteAdd || !caps.endnoteAdd) msg("当前 WPS 的注文能力不完整：脚注/尾注选项只显示已验证支持的类型；正文引文、文献表和诊断仍可使用。");
        }
        try { root.PPIntegration.raiseWindow(); } catch (e) { /* 置顶失败不影响打开 */ }
        return nativeRun("setDocPrefs");
      },

      /* 引文导航 */
      btnNavPrev: () => navCall("prev"),
      btnNavNext: () => navCall("next"),
      btnNavList: () => openManager(),
      btnNavBack: () => navCall("back"),
      btnSamePrev: () => navCall("samePrev"),
      btnSameNext: () => navCall("sameNext"),
      btnToBib: () => navCall("toBibliography"),
      btnToCitation: () => navCall("toCitation"),

      /* 工具箱 */
      btnUncited: () => addUncitedFlow(),
      btnChapterBib: () => chapterBibliographyFlow(),
      btnDiag: () => exportDiag(),
      btnConnection: () => openConnectionCenter(),
      btnHealth: () => openCheckCenter("health"),
      btnAutomation: () => automationSettings(),

      /* P2 投稿与迁移工具（全部只读或只写副本；不提供静默改原稿入口） */
      btnPreflight: () => openCheckCenter("preflight"),
      btnCompat: () => openCheckCenter("compatibility"),
      btnAudit: () => auditFlow(),
      btnUnlinked: () => unlinkedCopyFlow(),
      btnBatch: () => batchOpenCurrent(),

      btnGoto: () => gotoSource(),
      btnFind: () => openCrossdocCenter(),
      btnAbout: () => msg(`Papilot Cite ${root.PPC_VERSION || ""}\n\n` +
        `引用插入 + 引文与原文双向链接 + 样式切换 + 引文导航。\n` +
        `许可：Apache-2.0（本加载项）；样式算法自实现。`),
    }[id];
    if (!run) {
      log("action unknown", { id: id, keys: Object.keys(control || {}) });
      msg("这个按钮没有绑定命令（id=" + id + "），请反馈这条提示。");
      return true;
    }
    try {
      Promise.resolve(run()).catch((e) => {
        log("action failed", { id: id, err: String((e && e.message) || e), stack: String(e && e.stack || "").slice(0, 400) });
        msg(String((e && e.message) || e));
      });
    } catch (e) {
      log("action threw", { id: id, err: String((e && e.message) || e) });
      msg(String((e && e.message) || e));
    }
    return true;
  }

  function GetImage(control) {
    const map = {
      btnCite: "img/cite.svg", btnRefresh: "img/refresh.svg", btnBib: "img/bib.svg",
      menuCurrentCitation: "img/cite.svg", menuStyles: "img/style.svg",
      menuNavigation: "img/nav.svg", menuChecks: "img/tools.svg", menuDocumentTools: "img/bib.svg", menuSupport: "img/about.svg",
      btnRefreshStatus: "img/refresh.svg", btnContext: "img/cite.svg",
      btnGoto: "img/goto.svg", btnFind: "img/find.svg", btnAbout: "img/about.svg",
      btnPrefs: "img/style.svg", btnStyleGB: "img/style.svg", btnStyleAPA: "img/style.svg",
      btnStyleNature: "img/style.svg", btnStyleIEEE: "img/style.svg", btnRecent1: "img/style.svg",
      btnRecent2: "img/style.svg", btnRecent3: "img/style.svg", btnFavorite1: "img/style.svg",
      btnFavorite2: "img/style.svg", btnFavorite3: "img/style.svg", btnStyleFavorites: "img/style.svg",
      btnLocator: "img/goto.svg", btnChapterBib: "img/bib.svg", btnConnection: "img/tools.svg",
      btnNavPrev: "img/nav.svg", btnNavNext: "img/nav.svg", btnNavList: "img/nav.svg",
      btnNavBack: "img/nav.svg", btnSamePrev: "img/nav.svg", btnSameNext: "img/nav.svg",
      btnToBib: "img/bib.svg", btnToCitation: "img/cite.svg",
      btnUncited: "img/bib.svg", btnDiag: "img/tools.svg", btnHealth: "img/tools.svg", btnAutomation: "img/tools.svg",
      btnPreflight: "img/tools.svg", btnCompat: "img/tools.svg", btnAudit: "img/tools.svg",
      btnUnlinked: "img/bib.svg", btnBatch: "img/cite.svg",
    };
    try {
      return map[control.Id] || "";
    } catch (e) {
      return "";
    }
  }

  function currentZoteroStyleID() {
    try {
      const raw = root.PPIntegration && root.PPIntegration.__readDocDataForRecovery
        ? root.PPIntegration.__readDocDataForRecovery() : Doc.meta("ZoteroDocData");
      return String(JSON.parse(raw || "{}").style.styleID || "");
    } catch (e) { return ""; }
  }
  function GetLabel(control) {
    const id = control && control.Id, current = currentZoteroStyleID();
    if (/^btnRecent[123]$/.test(id || "")) {
      const st = recentStyles()[Number(id.slice(-1)) - 1];
      return st ? (current === st.id ? "✓ 当前：" : "最近：") + st.label : "最近样式（暂无）";
    }
    if (/^btnFavorite[123]$/.test(id || "")) {
      const st = favoriteStyles()[Number(id.slice(-1)) - 1];
      return st ? (current === st.id ? "✓ 收藏：" : "收藏：") + st.label : "收藏样式（未设置）";
    }
    const common = { btnStyleGB: "gb7714", btnStyleAPA: "apa", btnStyleNature: "nature", btnStyleIEEE: "ieee" };
    if (common[id]) {
      const st = ZOTERO_STYLES[common[id]];
      return (current === st.id ? "✓ " : "") + st.label;
    }
    return "";
  }
  function GetEnabled(control) {
    const id = control && control.Id;
    if (/^btnRecent[123]$/.test(id || "")) return !!recentStyles()[Number(id.slice(-1)) - 1];
    if (/^btnFavorite[123]$/.test(id || "")) return !!favoriteStyles()[Number(id.slice(-1)) - 1];
    return true;
  }
  function GetVisible(control) { return !control || control.Id !== "btnAutomation" || automationAvailable(); }

  root.PPApp = {
    OnAddinLoad, OnAction, GetImage, GetLabel, GetEnabled, GetVisible, proxyBat, beacon, connError, log, pickerUrl,
    refreshAll, insertCitation, gotoSource, findCitations,
    switchZoteroStyle, recentStyles, addUncitedFlow, navCall, exportDiag, inspectHealth, ZOTERO_STYLES,
    editFieldCitation, openCitationTarget, citationInfo, quickContext, openManager, publishManager,
    runManagerCommand, refreshStatus, automationSettings, bindAutomationEvents,
    style, setStyle, STYLES, ANCHOR, citationHere,
    /* P2：测试与面板共用同一批纯入口 */
    preflightCheck, compatibilityCheck, auditFlow, unlinkedCopyFlow, batchOpenFlow,
    batchOpenCurrent, batchOpenFromManager, exportReport, downloadText, confirmAction,
    openCheckCenter, runCenterCheck, openLocatorEditor, updateCitationLocation, repairPreview, repairApply,
    chapterBibliographyFlow, crossDocumentHealth, favoriteStyles, favoriteSave, favoriteRemove,
    profileSave, profileDelete, openCrossdocCenter, openConnectionCenter, centerReportText,
  };
}(typeof globalThis !== "undefined" ? globalThis : this));
