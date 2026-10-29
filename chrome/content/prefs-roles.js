// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 设置面板 · AI 角色与参数（prefs-roles.js，0.87.0）
 *
 * 三块能力，全部围绕「角色 = 人设 + 参数」这一条：
 *   A. 默认角色与提示词合并模式（全局，一处改全场生效）
 *   B. 角色编辑器（内置只读；改内置 = 自动另存为新角色，避免升级覆盖用户编辑）
 *   C. 场景覆盖（单篇 / 多篇 / 智能体 / 任务 各自的温度、max_tokens、历史轮数）
 *      留空 = 跟随角色；只有显式填了才覆盖——这样角色参数永远是"基线"，不是"锁死"。
 *
 * ⚠ 与 prefs-agent.js 同纪律：Zotero 先加载脚本、后插入 fragment DOM，
 *   init 必须探测节点 + 延迟重试；动态节点一律用变量持有，不用 $() 取动态节点。
 * ⚠ 所有写 pref 的地方都要能失败（只读 profile / 坏 pref），失败只提示不抛错。
 */
/* global Zotero, window, document, Components */

(function () {
  const PREFIX = "extensions.zotero.papilot.";
  const zh = (Zotero.locale || "").toLowerCase().startsWith("zh");
  const $ = (id) => document.getElementById(id);
  const HTML_NS = "http://www.w3.org/1999/xhtml";
  const R = () => (Zotero.Papilot && Zotero.Papilot.aiRoles) || null;
  const CHAT = () => (Zotero.Papilot && Zotero.Papilot.aiChat) || null;

  const el = (tag, attrs, text) => {
    const node = document.createElementNS(HTML_NS, tag);
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        if (attrs[k] === undefined || attrs[k] === null) continue;
        if (k === "class") node.className = attrs[k];
        else node.setAttribute(k, attrs[k]);
      }
    }
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const setMsg = (node, text, color) => {
    if (!node) return;
    node.textContent = text || "";
    node.style.color = color || "var(--pp-muted)";
  };

  const T = {
    pickRole: zh ? "默认角色" : "Default role",
    pickMode: zh ? "提示词合并方式" : "Prompt merge mode",
    modeAppend: zh ? "追加（全局提示词 + 角色提示词）" : "Append (global + role)",
    modeReplace: zh ? "替换（只用角色提示词）" : "Replace (role only)",
    save: zh ? "保存" : "Save",
    saveAs: zh ? "另存为新角色" : "Save as new role",
    del: zh ? "删除" : "Delete",
    preview: zh ? "预览最终提示词" : "Preview final prompt",
    sceneTitle: zh ? "场景参数覆盖" : "Per-scene overrides",
    sceneHint: zh
      ? "留空 = 跟随角色 / 全局设置；只有填了值才覆盖。温度越低越稳定，摘要/工具决策建议 0.1–0.3。"
      : "Leave blank to inherit from the role/global settings.",
    builtinLocked: zh
      ? "内置角色只读：修改后点「另存为新角色」即可保留你自己的版本。"
      : "Built-in roles are read-only — use \"Save as new role\".",
  };

  let _selId = "";

  /* ==================== A. 顶部：默认角色 + 合并模式 ==================== */

  function renderHeader(host) {
    const r = R();
    if (!r || !host) return;
    while (host.firstChild) host.removeChild(host.firstChild);

    const row = el("div", { class: "pp-row", style: "gap:12px;flex-wrap:wrap;align-items:flex-end;" });

    const f1 = el("label", { class: "pp-field", style: "min-width:200px;" });
    f1.appendChild(el("span", { class: "pp-label" }, T.pickRole));
    const sel = el("select", { class: "pp-input" });
    for (const role of r.all()) {
      const opt = el("option", { value: role.id }, role.name + (role.builtin ? "" : " ·"));
      if (role.id === r.activeId()) opt.setAttribute("selected", "selected");
      sel.appendChild(opt);
    }
    sel.addEventListener("change", () => {
      r.setActive(sel.value);
      _selId = sel.value;
      renderEditor();
      setMsg($("pp-role-msg"), (zh ? "默认角色已切换为 " : "Default role: ") + sel.value, "var(--pp-success)");
    });
    f1.appendChild(sel);
    row.appendChild(f1);

    const f2 = el("label", { class: "pp-field", style: "min-width:280px;" });
    f2.appendChild(el("span", { class: "pp-label" }, T.pickMode));
    const selMode = el("select", { class: "pp-input" });
    const m1 = el("option", { value: "append" }, T.modeAppend);
    const m2 = el("option", { value: "replace" }, T.modeReplace);
    let cur = "append";
    try { cur = String(Zotero.Prefs.get(PREFIX + "aiRolePromptMode", true) || "append"); } catch (e) { cur = "append"; }
    if (cur === "replace") m2.setAttribute("selected", "selected");
    else m1.setAttribute("selected", "selected");
    selMode.appendChild(m1);
    selMode.appendChild(m2);
    selMode.addEventListener("change", () => {
      try { Zotero.Prefs.set(PREFIX + "aiRolePromptMode", selMode.value, true); } catch (e) { /* ignore */ }
      setMsg($("pp-role-msg"), zh ? "合并方式已更新" : "Merge mode updated", "var(--pp-success)");
    });
    f2.appendChild(selMode);
    row.appendChild(f2);

    host.appendChild(row);
  }

  /* ==================== B. 角色编辑器 ==================== */

  function roleChips() {
    const host = $("pp-role-chips");
    const r = R();
    if (!host || !r) return;
    while (host.firstChild) host.removeChild(host.firstChild);
    if (!_selId) _selId = r.activeId();
    for (const role of r.all()) {
      const btn = el("button", {
        class: "pp-btn pp-btn-sm",
        style: role.id === _selId ? "outline:2px solid var(--pp-accent,#2d6cdf);" : "",
        title: role.desc || "",
      }, role.name);
      btn.addEventListener("click", () => {
        _selId = role.id;
        roleChips();
        renderEditor();
      });
      host.appendChild(btn);
    }
  }

  function renderEditor() {
    const host = $("pp-role-editor");
    const r = R();
    if (!host || !r) return;
    while (host.firstChild) host.removeChild(host.firstChild);

    const role = r.get(_selId) || r.active();
    if (!role) {
      host.appendChild(el("div", { class: "pp-hint" }, zh ? "没有可用角色" : "No role available"));
      return;
    }
    const isBuiltin = !!role.builtin;

    if (isBuiltin) {
      host.appendChild(el("div", { class: "pp-hint", style: "margin-bottom:6px;" }, T.builtinLocked));
    }

    const grid = el("div", { class: "pp-grid2" });
    const fName = el("label", { class: "pp-field" });
    fName.appendChild(el("span", { class: "pp-label" }, zh ? "名称" : "Name"));
    const inName = el("input", { class: "pp-input", type: "text", value: role.name, maxlength: "40" });
    if (isBuiltin) inName.setAttribute("readonly", "readonly");
    fName.appendChild(inName);
    grid.appendChild(fName);

    const fDesc = el("label", { class: "pp-field" });
    fDesc.appendChild(el("span", { class: "pp-label" }, zh ? "一句话说明" : "Description"));
    const inDesc = el("input", { class: "pp-input", type: "text", value: role.desc || "", maxlength: "120" });
    if (isBuiltin) inDesc.setAttribute("readonly", "readonly");
    fDesc.appendChild(inDesc);
    grid.appendChild(fDesc);
    host.appendChild(grid);

    const fPrompt = el("label", { class: "pp-field", style: "margin-top:6px;" });
    fPrompt.appendChild(el("span", { class: "pp-label" }, zh ? "角色提示词（会与全局 System Prompt 合并）" : "Role prompt"));
    const taPrompt = el("textarea", { class: "pp-textarea", rows: "5", style: "min-height:96px;" });
    taPrompt.value = role.prompt || "";
    if (isBuiltin) taPrompt.setAttribute("readonly", "readonly");
    fPrompt.appendChild(taPrompt);
    host.appendChild(fPrompt);

    // 参数
    const p = (() => { try { return r.paramsFor("single", role.id); } catch (e) { return null; } })();
    const pGrid = el("div", { class: "pp-grid3", style: "margin-top:6px;" });
    const mkNum = (label, key, attrs, val) => {
      const f = el("label", { class: "pp-field" });
      f.appendChild(el("span", { class: "pp-label" }, label));
      const inp = el("input", Object.assign({ class: "pp-input", type: "number" }, attrs));
      inp.value = (val === "" || val == null) ? "" : String(val);
      f.appendChild(inp);
      pGrid.appendChild(f);
      return inp;
    };
    const inT = mkNum(zh ? "温度（0-2）" : "Temperature", "temperature",
      { min: "0", max: "2", step: "0.05", placeholder: zh ? "跟随全局" : "inherit" }, role.params.temperature);
    const inM = mkNum(zh ? "最大输出 tokens" : "Max tokens", "maxTokens",
      { min: "64", max: "32768", step: "64", placeholder: zh ? "跟随全局" : "inherit" }, role.params.maxTokens);
    const inH = mkNum(zh ? "历史轮数（1-30）" : "History rounds", "historyRounds",
      { min: "1", max: "30", step: "1", placeholder: zh ? "跟随全局" : "inherit" }, role.params.historyRounds);
    host.appendChild(pGrid);
    host.appendChild(el("div", { class: "pp-hint" },
      (zh ? "当前生效：" : "Effective: ") + (p
        ? ("temp " + p.temperature + " · max_tokens " + p.maxTokens +
          " · " + p.historyRounds + (zh ? " 轮" : " rounds") +
          (p.topP === "" ? "" : (" · top_p " + p.topP)))
        : "—") +
      (p ? ("（温度来自" + p.source.temperature + "）") : "")));

    // 操作行
    const row = el("div", { class: "pp-row", style: "margin-top:8px;gap:8px;flex-wrap:wrap;" });
    const btnSave = el("button", { class: "pp-btn pp-btn-sm" }, isBuiltin ? T.saveAs : T.save);
    btnSave.addEventListener("click", () => {
      const params = {};
      const numOr = (v) => (String(v || "").trim() === "" ? undefined : Number(v));
      const t = numOr(inT.value);
      const m = numOr(inM.value);
      const h = numOr(inH.value);
      if (t !== undefined) params.temperature = t;
      if (m !== undefined) params.maxTokens = m;
      if (h !== undefined) params.historyRounds = h;
      const payload = {
        // 内置角色保存时去掉 id → saveCustom 会生成新 id（不覆盖内置）
        id: isBuiltin ? "" : role.id,
        name: inName.value || role.name,
        desc: inDesc.value || "",
        prompt: taPrompt.value || "",
        params,
      };
      const saved = r.saveCustom(payload);
      if (!saved) {
        setMsg($("pp-role-msg"), zh ? "保存失败（提示词与名称不能同时为空）" : "Save failed", "var(--pp-danger)");
        return;
      }
      _selId = saved.id;
      roleChips();
      renderHeader($("pp-role-head"));
      renderEditor();
      setMsg($("pp-role-msg"), (zh ? "已保存角色 " : "Saved role ") + saved.name, "var(--pp-success)");
    });
    row.appendChild(btnSave);

    if (!isBuiltin) {
      const btnDel = el("button", { class: "pp-btn pp-btn-sm" }, T.del);
      btnDel.addEventListener("click", () => {
        const ok = (() => {
          try {
            return Components.classes["@mozilla.org/embedcomp/prompt-service;1"]
              .getService(Components.interfaces.nsIPromptService)
              .confirm(window, zh ? "删除角色" : "Delete role",
                (zh ? "确定删除角色「" : "Delete role \"") + role.name + "」？");
          } catch (e) { return false; }
        })();
        if (!ok) return;
        r.removeCustom(role.id);
        _selId = r.activeId();
        roleChips();
        renderHeader($("pp-role-head"));
        renderEditor();
        setMsg($("pp-role-msg"), zh ? "已删除" : "Deleted", "var(--pp-success)");
      });
      row.appendChild(btnDel);
    }

    const btnPrev = el("button", { class: "pp-btn pp-btn-sm" }, T.preview);
    btnPrev.addEventListener("click", () => {
      const out = $("pp-role-preview-out");
      if (!out) return;
      const chat = CHAT();
      let text = "";
      try {
        text = (chat && chat.previewSystem)
          ? chat.previewSystem("single", role.id)
          : (zh ? "预览不可用（AIChat 未就绪）" : "Preview unavailable");
      } catch (e) {
        text = (zh ? "预览失败：" : "Preview failed: ") + (e && e.message || e);
      }
      out.value = text;
      out.style.display = "block";
    });
    row.appendChild(btnPrev);
    host.appendChild(row);
  }

  /* ==================== C. 场景覆盖 ==================== */

  const SCENE_KEYS = ["single", "multi", "agent", "task"];

  function readSceneAll() {
    const r = R();
    try {
      let raw = Zotero.Prefs.get(PREFIX + "aiSceneParams", true);
      if (!raw) return {};
      const v = typeof raw === "string" ? JSON.parse(raw) : raw;
      return (v && typeof v === "object" && !Array.isArray(v)) ? v : {};
    } catch (e) { return {}; }
  }

  function renderScenes() {
    const host = $("pp-scene-host");
    const r = R();
    if (!host || !r) return;
    while (host.firstChild) host.removeChild(host.firstChild);
    const all = readSceneAll();

    for (const s of r.SCENES) {
      const cur = all[s.id] || {};
      const row = el("div", { class: "pp-grid3", style: "margin-top:6px;align-items:end;" });

      const head = el("label", { class: "pp-field" });
      head.appendChild(el("span", { class: "pp-label" }, s.label));
      head.appendChild(el("span", { class: "pp-hint", style: "font-size:11px;" }, s.desc));
      row.appendChild(head);

      const mk = (label, key, attrs, val) => {
        const f = el("label", { class: "pp-field" });
        f.appendChild(el("span", { class: "pp-label" }, label));
        const inp = el("input", Object.assign({ class: "pp-input", type: "number" }, attrs));
        inp.value = (val === undefined || val === null) ? "" : String(val);
        inp.dataset.scene = s.id;
        inp.dataset.key = key;
        inp.addEventListener("change", saveScene);
        f.appendChild(inp);
        row.appendChild(f);
        return inp;
      };
      mk(zh ? "温度" : "Temp", "temperature",
        { min: "0", max: "2", step: "0.05", placeholder: zh ? "跟随" : "inherit" }, cur.temperature);
      mk(zh ? "max_tokens" : "max_tokens", "maxTokens",
        { min: "64", max: "32768", step: "64", placeholder: zh ? "跟随" : "inherit" }, cur.maxTokens);
      mk(zh ? "历史轮数" : "Rounds", "historyRounds",
        { min: "1", max: "30", step: "1", placeholder: zh ? "跟随" : "inherit" }, cur.historyRounds);

      host.appendChild(row);
    }
  }

  function saveScene(ev) {
    const target = ev && ev.target;
    if (!target) return;
    const scene = target.dataset.scene;
    const host = $("pp-scene-host");
    if (!scene || !host) return;
    const params = {};
    const inputs = host.querySelectorAll ? host.querySelectorAll("input") : [];
    for (const inp of inputs) {
      if (!inp || !inp.dataset || inp.dataset.scene !== scene) continue;
      const v = String(inp.value || "").trim();
      if (v === "") continue;
      const n = Number(v);
      if (!isFinite(n)) continue;
      params[inp.dataset.key] = n;
    }
    const r = R();
    if (!r) return;
    const ok = r.setSceneOverride(scene, params);
    setMsg($("pp-role-msg"),
      ok ? (zh ? "场景参数已更新（留空的字段跟随角色）" : "Scene params updated")
        : (zh ? "场景参数保存失败" : "Failed to save scene params"),
      ok ? "var(--pp-success)" : "var(--pp-danger)");
  }

  /* ==================== D. 旧版迁移报告与回滚 ==================== */

  const MEM = () => (Zotero.Papilot && Zotero.Papilot.chatMemory) || null;

  function renderMigrate() {
    const box = $("pp-migrate-box");
    const btn = $("pp-migrate-rollback");
    if (!box) return;
    const mem = MEM();
    const rep = (mem && mem.migrateReport) ? mem.migrateReport() : null;
    if (!rep) {
      box.textContent = zh ? "尚无迁移记录（只有从 0.86 及以前版本升级、且本机有旧对话时才会产生）。"
        : "No migration recorded yet.";
      if (btn) btn.style.display = "none";
      return;
    }
    let when = "";
    try { when = new Date(rep.at).toLocaleString(); } catch (e) { when = String(rep.at); }
    box.textContent = zh
      ? ("上次迁移：" + when + " · 单篇 " + rep.doc + " 场 · 综合 " + rep.multi +
        " 场 · 跳过 " + rep.skipped + (rep.backup ? " · 备份 " + rep.backup : ""))
      : ("Last migration: " + when + " · " + rep.doc + " paper chats · " +
        rep.multi + " multi chats · " + rep.skipped + " skipped");
    if (btn) btn.style.display = "";
  }

  function wireMigrate() {
    const btn = $("pp-migrate-rollback");
    if (!btn) return;
    btn.addEventListener("click", () => {
      const mem = MEM();
      if (!mem || !mem.rollbackMigration) {
        setMsg($("pp-role-msg"), zh ? "记忆模块未就绪" : "Memory module not ready", "var(--pp-danger)");
        return;
      }
      const ok = (() => {
        try {
          return Components.classes["@mozilla.org/embedcomp/prompt-service;1"]
            .getService(Components.interfaces.nsIPromptService)
            .confirm(window, zh ? "回滚迁移" : "Roll back migration",
              zh ? "只删除「迁移进来的」旧对话，你迁移之后新问的对话不受影响。继续？"
                : "Only records imported by the migration will be removed. Continue?");
        } catch (e) { return false; }
      })();
      if (!ok) return;
      const n = mem.rollbackMigration();
      renderMigrate();
      setMsg($("pp-role-msg"),
        (zh ? "已回滚，删除 " + n + " 场迁移记录（下次启动会重新迁移；想彻底不迁可清空旧会话 pref）"
          : "Rolled back, removed " + n + " migrated chats"),
        "var(--pp-success)");
    });
  }

  /* ==================== D1b. 隐私：不出本机的对话 ==================== */

  const PRIV = () => (Zotero.Papilot && Zotero.Papilot.chatPrivacy) || null;

  function currentDocKey() {
    try {
      const pane = Zotero.getActiveZoteroPane();
      const sel = (pane && pane.getSelectedItems) ? pane.getSelectedItems() : [];
      const item = sel && sel[0];
      const mem = MEM();
      if (!item || !mem || !mem.docKeyOf) return "";
      return mem.docKeyOf(item) || "";
    } catch (e) { return ""; }
  }

  /** 隐私 UI 是否启用（云同步投影接线前默认关：不暴露 = 不误导） */
  function privacyUiOn() {
    try { return Zotero.Prefs.get(PREFIX + "chatPrivacyUiEnabled", true) === true; }
    catch (e) { return false; }
  }

  function renderPrivacy() {
    const group = $("pp-privacy-group");
    if (group) group.style.display = privacyUiOn() ? "" : "none";
    if (!privacyUiOn()) return;   // 关着就完全不碰内部节点（也不初始化模块状态）
    const box = $("pp-privacy-box");
    const btn = $("pp-privacy-toggle-item");
    const cb = $("pp-privacy-redact");
    const pv = PRIV();
    if (!box) return;
    if (!pv) {
      box.textContent = zh ? "隐私模块未就绪" : "Privacy module not ready";
      if (btn) btn.style.display = "none";
      return;
    }
    let s = null;
    try { s = pv.summary(); } catch (e) { s = null; }
    box.textContent = s
      ? (zh
        ? ("已排除 " + s.items.length + " 篇文献 · " + s.libs.length + " 个库 · " + s.sids + " 场单场对话")
        : (s.items.length + " papers · " + s.libs.length + " libraries · " + s.sids + " single chats excluded"))
      : "—";
    if (cb) cb.checked = !!(s && s.redact);

    // 按钮文案随当前选中文章的状态变化（用户必须能看出"再点一下是恢复"）
    if (btn) {
      const key = currentDocKey();
      if (!key) {
        btn.style.display = "none";
      } else {
        btn.style.display = "";
        let on = false;
        try { on = pv.isExcluded(pv.subjectForDocKey(key, null)); } catch (e) { on = false; }
        btn.textContent = on
          ? (zh ? "当前选中文章：恢复同步" : "Selected paper: resume sync")
          : (zh ? "当前选中文章：设为不同步" : "Selected paper: do not sync");
      }
    }
  }

  function wirePrivacy() {
    const btn = $("pp-privacy-toggle-item");
    const cb = $("pp-privacy-redact");
    if (btn && !btn._ppBound) {
      btn._ppBound = true;
      btn.addEventListener("click", () => {
        const pv = PRIV();
        const key = currentDocKey();
        if (!pv || !key) {
          setMsg($("pp-role-msg"), zh ? "请先在文库中选中一篇文献" : "Select an item first", "var(--pp-danger)");
          return;
        }
        let on = false;
        try { on = pv.isExcluded(pv.subjectForDocKey(key, null)); } catch (e) { on = false; }
        pv.setItemExcluded(key, !on);
        renderPrivacy();
        setMsg($("pp-role-msg"), !on
          ? (zh ? "已标记为不同步（本地照常记录）" : "Marked as do-not-sync")
          : (zh ? "已恢复同步" : "Sync resumed"), "var(--pp-success)");
      });
    }
    if (cb && !cb._ppBound) {
      cb._ppBound = true;
      cb.addEventListener("change", () => {
        const pv = PRIV();
        if (pv) pv.setRedact(!!cb.checked);
        setMsg($("pp-role-msg"), cb.checked
          ? (zh ? "已开启上传脱敏（本地原文不受影响）" : "Redaction enabled")
          : (zh ? "已关闭上传脱敏" : "Redaction disabled"), "var(--pp-success)");
      });
    }
  }

  /* ==================== D2. 记忆与栏目开关 ==================== */

  function wireToggles() {
    const archive = $("pp-chat-archive-note");
    if (archive) {
      try { archive.checked = Zotero.Prefs.get(PREFIX + "chatArchiveNote", true) === true; } catch (e) { /* ignore */ }
      archive.addEventListener("change", () => {
        try { Zotero.Prefs.set(PREFIX + "chatArchiveNote", !!archive.checked, true); } catch (e) { /* ignore */ }
        setMsg($("pp-role-msg"), archive.checked
          ? (zh ? "已开启：单篇问答会同步为该文献下的一条「Papilot 对话记录」子笔记" : "Enabled")
          : (zh ? "已关闭：只写本地记录，不动文库" : "Disabled"), "var(--pp-success)");
      });
    }
    const pane = $("pp-ai-log-pane");
    if (pane) {
      try { pane.checked = Zotero.Prefs.get(PREFIX + "aiLogPaneEnabled", true) !== false; } catch (e) { /* ignore */ }
      pane.addEventListener("change", () => {
        try { Zotero.Prefs.set(PREFIX + "aiLogPaneEnabled", !!pane.checked, true); } catch (e) { /* ignore */ }
        try {
          const lp = Zotero.Papilot && Zotero.Papilot.aiLogPane;
          if (lp) { lp.unregister && lp.unregister(); if (pane.checked) lp.register("papilot@dev.local"); }
        } catch (e) { /* ignore */ }
        setMsg($("pp-role-msg"), pane.checked
          ? (zh ? "左侧栏栏目已开启（重开主窗口后位置可能变化）" : "Log pane enabled")
          : (zh ? "左侧栏栏目已关闭" : "Log pane disabled"), "var(--pp-success)");
      });
    }
  }

  /* ==================== init ==================== */

  function init() {
    if (typeof Zotero === "undefined" || !Zotero.Prefs) {
      window.setTimeout(init, 400);
      return;
    }
    if (!$("pp-role-head") || !$("pp-role-editor") || !$("pp-scene-host")
      || !$("pp-migrate-box") || !$("pp-privacy-box")) {
      window.setTimeout(init, 400);
      window.setTimeout(init, 1200);
      return;
    }
    if (init._done) return;
    init._done = true;
    const r = R();
    if (!r) {
      setMsg($("pp-role-msg"), zh ? "角色模块未就绪" : "Roles module not ready", "var(--pp-danger)");
      return;
    }
    try { renderHeader($("pp-role-head")); } catch (e) { /* ignore */ }
    try { roleChips(); } catch (e) { /* ignore */ }
    try { renderEditor(); } catch (e) { /* ignore */ }
    try { renderScenes(); } catch (e) { /* ignore */ }
    try { renderMigrate(); } catch (e) { /* ignore */ }
    try { wireMigrate(); } catch (e) { /* ignore */ }
    try { renderPrivacy(); } catch (e) { /* ignore */ }
    try { wirePrivacy(); } catch (e) { /* ignore */ }
  }

  init();
  if (typeof window !== "undefined" && window.setTimeout) {
    window.setTimeout(init, 400);
    window.setTimeout(init, 1200);
  }
})();
