// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot · 文献检索与综述生成 窗口脚本（0.86.0）
 *
 * 纪律：
 *   ① 脚本在 DOM 之前执行 → boot() + DOMContentLoaded/readyState 双保险，顶层不碰 DOM；
 *   ② 一切跨作用域能力（SubSources / AIClient / Notes / RefImport）都经
 *      window.arguments[0].api 调用——窗口里没有那些 bootstrap 全局；
 *   ③ 所有事件处理自带 try/catch，失败写状态行，绝不静默；
 *   ④ 判定只由人点击切换，AI 不参与筛选决定（本版无 AI 复核）。
 */
/* global window, document, Services, LitReviewUI */

var LitReviewUI = {
  api: null,
  inited: false,
  state: {
    spec: null,
    sources: ["pubmed", "europepmc"],
    mode: "topic",
    topicDirty: false,
    works: [],
    decisions: [],
    outline: [],
    draft: "",
    audit: null,
    projectId: "",
    busy: false,
  },

  $(id) { return document.getElementById(id); },

  _val(id) {
    const el = this.$(id);
    return el ? String(el.value == null ? "" : el.value) : "";
  },

  _set(id, text) {
    const el = this.$(id);
    if (el) el.textContent = String(text == null ? "" : text);
  },

  _status(id, text, kind) {
    const el = this.$(id);
    if (!el) return;
    el.textContent = String(text == null ? "" : text);
    el.className = "lr-status" + (kind ? " " + kind : "");
  },

  boot() {
    if (this.inited) return;
    try {
      this.init();
      this.inited = true;
    } catch (e) {
      try { Zotero.logError(e); } catch (e2) { /* ignore */ }
      this._status("lr-sub", "窗口初始化失败：" + ((e && e.message) || e), "err");
    }
  },

  init() {
    const args = (window.arguments && window.arguments[0]) || {};
    this.api = args.api || (typeof LitReview !== "undefined" ? LitReview : null);
    if (!this.api) throw new Error("综述模块未加载");

    this.state.spec = this.api.defaultSpec();
    const payload = args.payload || {};
    if (payload.spec) this._applySpec(payload.spec);

    // 数据源/模式：按钮切换（皮肤对 select/checkbox 的强制样式太多）
    const srcBtns = document.querySelectorAll("#pp-lr-root [data-src]");
    for (let i = 0; i < srcBtns.length; i++) {
      srcBtns[i].addEventListener("click", () => {
        const id = srcBtns[i].getAttribute("data-src");
        const at = this.state.sources.indexOf(id);
        if (at >= 0) {
          if (this.state.sources.length === 1) { this._status("lr-cfg-status", "至少保留一个数据源", "warn"); return; }
          this.state.sources.splice(at, 1);
        } else {
          this.state.sources.push(id);
        }
        this._syncToggles();
        this._updatePreview();
      });
    }
    const modeBtns = document.querySelectorAll("#pp-lr-root [data-mode]");
    for (let i = 0; i < modeBtns.length; i++) {
      modeBtns[i].addEventListener("click", () => {
        this.state.mode = modeBtns[i].getAttribute("data-mode");
        this._syncToggles();
        this._syncModeHint();
        this._updatePreview();
      });
    }

    const q = this.$("lr-q");
    if (q) q.addEventListener("input", () => { this.state.topicDirty = true; this._updatePreview(); });
    for (const id of ["lr-max", "lr-year", "lr-lang"]) {
      const el = this.$(id);
      if (el) el.addEventListener("change", () => this._updatePreview());
    }

    this._on("lr-try", () => this.run(true));
    this._on("lr-build", () => this.run(false));
    this._on("lr-cfg-export", () => this.exportConfig());
    this._on("lr-cfg-import", () => this.importConfig());
    this._on("lr-all-in", () => this.bulkDecision("include"));
    this._on("lr-all-out", () => this.bulkDecision("exclude"));
    this._on("lr-import", () => this.importToZotero());
    this._on("lr-csv", () => this.exportCsv());
    this._on("lr-gen", () => this.generate());
    this._on("lr-save-note", () => this.saveNote());
    this._on("lr-save-md", () => this.saveMarkdown());
    this._on("lr-load", () => this.openProject());

    this._syncToggles();
    this._syncModeHint();
    this._updatePreview();
    this._renderOutline([]);

    // 单例复用：已开窗时由 openDialog 调 PapilotSetPayload 换入新配置
    window.PapilotSetPayload = (p) => {
      try {
        if (p && p.spec) { this._applySpec(p.spec); this._updatePreview(); }
      } catch (e) { /* ignore */ }
    };
  },

  _on(id, fn) {
    const el = this.$(id);
    if (el) el.addEventListener("click", () => { try { fn(); } catch (e) { this._status("lr-run-status", String((e && e.message) || e), "err"); } });
  },

  _applySpec(raw) {
    const s = this.api.normalize(raw);
    this.state.spec = s;
    this.state.sources = s.sources.enabled.slice();
    this.state.mode = s.query.mode;
    const q = this.$("lr-q");
    if (q) q.value = s.query.mode === "custom" ? s.query.customQuery.expression : s.query.topic;
    const max = this.$("lr-max");
    if (max) max.value = String((s.sources.perSource[this.state.sources[0]] || {}).maxRecords || 100);
    const year = this.$("lr-year");
    if (year) year.value = (s.query.filters.dateFrom || "").slice(0, 4);
    const lang = this.$("lr-lang");
    if (lang) lang.value = (s.query.filters.languages || []).join(",");
    this.state.topicDirty = false;
  },

  _syncToggles() {
    const srcBtns = document.querySelectorAll("#pp-lr-root [data-src]");
    for (let i = 0; i < srcBtns.length; i++) {
      const on = this.state.sources.indexOf(srcBtns[i].getAttribute("data-src")) >= 0;
      srcBtns[i].setAttribute("data-on", on ? "1" : "0");
    }
    const modeBtns = document.querySelectorAll("#pp-lr-root [data-mode]");
    for (let i = 0; i < modeBtns.length; i++) {
      modeBtns[i].setAttribute("data-on", modeBtns[i].getAttribute("data-mode") === this.state.mode ? "1" : "0");
    }
  },

  _syncModeHint() {
    const label = this.$("lr-q-label");
    const q = this.$("lr-q");
    if (label) label.textContent = this.state.mode === "custom" ? "检索式" : (this.state.mode === "keywords" ? "关键词" : "主题");
    if (q) {
      q.setAttribute("placeholder", this.state.mode === "custom"
        ? "例：(semaglutide[tiab] OR liraglutide[tiab]) AND cardiovascular[tiab] AND 2015:2026[dp]（仅 PubMed 支持该语法）"
        : (this.state.mode === "keywords"
          ? "例：semaglutide, cardiovascular outcome, type 2 diabetes（逗号分隔，组间 AND）"
          : "例：GLP-1 受体激动剂对 2 型糖尿病患者心血管结局的影响（主题模式会自动拆概念组）"));
    }
  },

  /** 表单 → 配置（唯一入口，避免多处各拼一份） */
  _spec() {
    const s = JSON.parse(JSON.stringify(this.state.spec));
    s.sources.enabled = this.state.sources.slice();
    s.sources.mailto = s.sources.mailto || "";
    const max = Math.max(1, Math.min(300, parseInt(this._val("lr-max"), 10) || 100));
    for (const id of s.sources.enabled) {
      const cap = Math.min(300, max);
      if (!s.sources.perSource[id]) s.sources.perSource[id] = { pageSize: 100, maxRecords: 100, timeoutMs: 25000 };
      s.sources.perSource[id].maxRecords = cap;
      s.sources.perSource[id].pageSize = Math.min(100, cap);
    }
    s.query.mode = this.state.mode;
    const text = this._val("lr-q").trim();
    s.query.topic = this.state.mode === "custom" ? "" : text;
    if (this.state.mode === "custom") {
      s.query.customQuery = { syntax: "pubmed", expression: text };
      s.query.concepts = [];
    } else if (this.state.mode === "keywords" || this.state.topicDirty) {
      // 关键词模式与用户改过主题时，丢掉旧概念组，交给 LitQuery 重新拆
      s.query.concepts = [];
    }
    const year = parseInt(this._val("lr-year"), 10);
    s.query.filters.dateFrom = year && year > 1800 ? year + "-01-01" : "";
    s.screening.hardFilters.minYear = year && year > 1800 ? year : 0;
    s.query.filters.languages = this._val("lr-lang").split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
    return this.api.normalize(s);
  },

  _updatePreview() {
    try {
      const spec = this._spec();
      const all = this.api.preview(spec);
      const lines = [];
      for (const id of Object.keys(all)) lines.push((this._label(id)) + "：" + (all[id] || "（无法构造检索式）"));
      this._set("lr-q-preview", lines.join("\n\n") || "（尚未填写检索条件）");
      const v = this.api.validateSpec(spec);
      if (!v.ok) this._status("lr-cfg-status", v.errors[0].msg, "warn");
      else this._status("lr-cfg-status", this.api.summaryOf(spec), "");
    } catch (e) {
      this._status("lr-cfg-status", String((e && e.message) || e), "err");
    }
  },

  _label(id) {
    return ({ pubmed: "PubMed", europepmc: "Europe PMC", openalex: "OpenAlex", crossref: "Crossref", arxiv: "arXiv" })[id] || id;
  },

  _setBusy(on) {
    this.state.busy = !!on;
    for (const id of ["lr-try", "lr-build", "lr-import", "lr-gen", "lr-csv"]) {
      const el = this.$(id);
      if (el) el.disabled = !!on;
    }
  },

  /* ==================== ① 检索 ==================== */

  async run(trial) {
    if (this.state.busy) return;
    const spec0 = this._spec();
    let spec = spec0;
    if (trial) {
      spec = JSON.parse(JSON.stringify(spec0));
      for (const id of spec.sources.enabled) {
        spec.sources.perSource[id].maxRecords = Math.min(20, spec.sources.perSource[id].maxRecords);
        spec.sources.perSource[id].pageSize = 20;
      }
    }
    const v = this.api.validateSpec(spec);
    if (!v.ok) { this._status("lr-run-status", v.errors.map((e) => e.msg).join("；"), "err"); return; }
    this._setBusy(true);
    this._status("lr-run-status", trial ? "试跑中（每源 20 条）…" : "检索中…", "warn");
    try {
      const r = await this.api.build(spec, {
        onProgress: (id, got, cap) => this._status("lr-run-status", "检索中：" + this._label(id) + " " + got + "/" + cap, "warn"),
      });
      if (!r.ok) {
        this._status("lr-run-status", "检索失败：" + (r.reason || "未知原因"), "err");
        return;
      }
      this.state.spec = spec;
      this.state.works = r.works;
      this.state.decisions = r.decisions;
      // 逐源结果留一份：面板只显示汇总，排障时要能看到"某源 0 条"是失败还是无命中
      this.state.bySource = r.bySource || null;
      this.state.outline = this.api.outlineOf(spec, this._includedWorks());
      this.state.draft = "";
      this.state.audit = null;
      const st = r.stats || {};
      this._set("lr-corpus-status", "命中 " + (r.records || []).length + " 条 → 去重 " + r.works.length +
        " 篇（合并 " + (r.merged || 0) + "）· 纳入 " + (st.include || 0) + " / 待定 " + (st.maybe || 0) + " / 排除 " + (st.exclude || 0));
      const bad = Object.keys(r.bySource || {}).filter((k) => !r.bySource[k].ok);
      const bs = Object.keys(r.bySource || {}).map((k) => this._label(k) + " " + r.bySource[k].count).join(" · ");
      this._status("lr-run-status", (r.partial ? "部分成功（" + bad.map((k) => this._label(k)).join("、") + " 失败）：" : "完成：") + bs, r.partial ? "warn" : "ok");
      this._renderTable();
      this._renderOutline(this.state.outline);
      this._set("lr-audit", "生成草稿后，这里列出覆盖率、无法解析的引用、以及「数字找不到出处」的句子。");
      this._status("lr-audit-status", "尚未生成", "");
      const ta = this.$("lr-draft");
      if (ta) ta.value = "";
      this._autosave();
    } catch (e) {
      this._status("lr-run-status", "检索异常：" + String((e && e.message) || e), "err");
    } finally {
      this._setBusy(false);
    }
  },

  _includedWorks() {
    const keep = new Set(this.state.decisions.filter((d) => d.decision !== "exclude").map((d) => d.workId));
    return this.state.works.filter((w) => keep.has(w.id));
  },

  /* ==================== ② 语料表 ==================== */

  _renderTable() {
    const tbody = this.$("lr-rows");
    if (!tbody) return;
    while (tbody.firstChild) tbody.removeChild(tbody.firstChild);
    const byId = new Map(this.state.decisions.map((d) => [d.workId, d]));
    if (!this.state.works.length) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.setAttribute("colspan", "6");
      td.textContent = "没有符合条件的记录。可放宽年份/语言，或换用 Europe PMC 重试。";
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }
    const rows = this.state.works.slice(0, 300);
    rows.forEach((w, idx) => {
      const d = byId.get(w.id) || { decision: "maybe", score: 0, reasons: [] };
      const tr = document.createElement("tr");
      if (d.decision === "include") tr.className = "inc";
      if (d.decision === "exclude") tr.className = "exc";

      const tdN = document.createElement("td");
      tdN.textContent = String(idx + 1);
      tr.appendChild(tdN);

      const tdT = document.createElement("td");
      const title = document.createElement("div");
      title.textContent = w.title || "（无标题）";
      title.title = (d.reasons || []).join("；") || "";
      tdT.appendChild(title);
      if (d.reasons && d.reasons.length) {
        const why = document.createElement("div");
        why.style.color = "var(--lr-muted)";
        why.style.fontSize = "11px";
        why.textContent = d.reasons.join("；");
        tdT.appendChild(why);
      }
      tr.appendChild(tdT);

      const tdY = document.createElement("td");
      tdY.textContent = w.year ? String(w.year) : "";
      tr.appendChild(tdY);

      const tdS = document.createElement("td");
      tdS.textContent = (w.sources || []).map((x) => this._label(x)).join(", ");
      tr.appendChild(tdS);

      const tdSc = document.createElement("td");
      tdSc.textContent = String(d.score == null ? "" : d.score);
      tr.appendChild(tdSc);

      const tdD = document.createElement("td");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "lr-dec";
      btn.setAttribute("data-d", d.decision);
      btn.textContent = ({ include: "纳入", maybe: "待定", exclude: "排除" })[d.decision] || "待定";
      btn.title = "点击切换：纳入 → 待定 → 排除";
      btn.addEventListener("click", () => this.cycleDecision(w.id));
      tdD.appendChild(btn);
      tr.appendChild(tdD);

      tbody.appendChild(tr);
    });
  },

  cycleDecision(workId) {
    const d = this.state.decisions.find((x) => x.workId === workId);
    if (!d) return;
    const next = { include: "maybe", maybe: "exclude", exclude: "include" }[d.decision] || "include";
    d.decision = next;
    d.by = "human";
    this._renderTable();
    const st = { include: 0, maybe: 0, exclude: 0 };
    for (const x of this.state.decisions) st[x.decision] = (st[x.decision] || 0) + 1;
    this._set("lr-corpus-status", "共 " + this.state.works.length + " 篇 · 纳入 " + st.include + " / 待定 " + st.maybe + " / 排除 " + st.exclude);
    this.state.outline = this.api.outlineOf(this._spec(), this._includedWorks());
    this._renderOutline(this.state.outline);
  },

  bulkDecision(kind) {
    for (const d of this.state.decisions) { d.decision = kind; d.by = "human"; }
    this._renderTable();
    this.cycleDecisionRefreshOnly();
  },

  cycleDecisionRefreshOnly() {
    const st = { include: 0, maybe: 0, exclude: 0 };
    for (const x of this.state.decisions) st[x.decision] = (st[x.decision] || 0) + 1;
    this._set("lr-corpus-status", "共 " + this.state.works.length + " 篇 · 纳入 " + st.include + " / 待定 " + st.maybe + " / 排除 " + st.exclude);
    this.state.outline = this.api.outlineOf(this._spec(), this._includedWorks());
    this._renderOutline(this.state.outline);
  },

  async importToZotero() {
    if (!this.state.works.length) { this._status("lr-run-status", "请先检索建库", "warn"); return; }
    this._setBusy(true);
    this._status("lr-run-status", "导入 Zotero…", "warn");
    try {
      const r = await this.api.importWorks(this.state.works, this.state.decisions, {
        spec: this._spec(),
        projectId: this.state.projectId || "",
      });
      if (!r.ok) this._status("lr-run-status", "导入未完成：" + (r.reason || ""), "err");
      else this._status("lr-run-status", "已导入 " + r.imported + " 条" + (r.failed ? "（失败 " + r.failed + "）" : ""), "ok");
    } catch (e) {
      this._status("lr-run-status", "导入异常：" + String((e && e.message) || e), "err");
    } finally {
      this._setBusy(false);
    }
  },

  async exportCsv() {
    if (!this.state.works.length) { this._status("lr-run-status", "没有可导出的语料", "warn"); return; }
    const csv = this.api.toCsv(this.state.works, this.state.decisions);
    const r = await this.api.saveText(csv, "lit-review-corpus.csv");
    if (r && r.ok) this._status("lr-run-status", "已导出：" + r.path, "ok");
  },

  /* ==================== ③ 成稿 ==================== */

  _renderOutline(outline) {
    const box = this.$("lr-outline");
    if (!box) return;
    while (box.firstChild) box.removeChild(box.firstChild);
    if (!outline || !outline.length) {
      const span = document.createElement("span");
      span.className = "lr-status";
      span.textContent = "检索后显示六段大纲与每节可用材料数";
      box.appendChild(span);
      return;
    }
    for (const sec of outline) {
      const chip = document.createElement("span");
      chip.className = "lr-chip";
      const b = document.createElement("b");
      b.textContent = sec.n + ". " + sec.title;
      chip.appendChild(b);
      const n = document.createTextNode(" " + (sec.pool || 0) + " 篇");
      chip.appendChild(n);
      box.appendChild(chip);
    }
  },

  async generate() {
    if (this.state.busy) return;
    const works = this._includedWorks();
    if (!works.length) { this._status("lr-gen-status", "请先检索，并至少纳入一篇文献", "warn"); return; }
    this._setBusy(true);
    this._status("lr-gen-status", "生成中…", "warn");
    try {
      const r = await this.api.draft({ spec: this._spec(), works: works, outline: this.state.outline }, {
        onProgress: (done, total) => this._status("lr-gen-status", "已完成 " + done + "/" + total + " 节", "warn"),
      });
      if (!r.ok) {
        const msg = r.reason === "no_key" ? (r.guidance || "未配置 AI 通道") : ("生成失败：" + (r.reason || ""));
        this._status("lr-gen-status", msg, "err");
        return;
      }
      const ta = this.$("lr-draft");
      if (ta) ta.value = r.draft;
      this.state.draft = r.draft;
      this.state.audit = r.audit;
      this._renderAudit(r.audit);
      const okSections = r.sections.filter((s) => s.status === "ok").length;
      this._status("lr-gen-status", "完成 " + okSections + "/" + r.sections.length + " 节 · " + r.calls + " 次 AI 调用" +
        (r.stopped === "budget" ? "（预算耗尽，可重跑剩余节）" : ""), r.stopped ? "warn" : "ok");
      this._autosave(r);
    } catch (e) {
      this._status("lr-gen-status", "生成异常：" + String((e && e.message) || e), "err");
    } finally {
      this._setBusy(false);
    }
  },

  _renderAudit(audit) {
    if (!audit) return;
    const v1 = audit.v1 || {};
    const v2 = audit.v2 || {};
    const v3 = audit.v3 || {};
    const lines = [];
    lines.push("引用解析：" + (v1.ok ? "通过" : "未通过"));
    for (const u of (v1.unknown || [])) lines.push("  · 未知标记 " + u);
    for (const o of (v1.outOfRange || [])) lines.push("  · 越界编号：第 " + o.section + " 节 [" + o.n + "]");
    lines.push("覆盖率：" + Math.round((v2.coverage || 0) * 100) + "%（" + (v2.cited || 0) + "/" + (v2.total || 0) + "，阈值 " + Math.round((v2.coverageMin || 0) * 100) + "%）");
    if (v2.uncitedCount) lines.push("  未引用 " + v2.uncitedCount + " 篇，例如：" + (v2.uncited || []).slice(0, 3).map((x) => x.title).join("；"));
    lines.push("数字出处：" + (v3.ok ? "全部命中" : (v3.issueCount || 0) + " 处待核"));
    for (const it of (v3.issues || []).slice(0, 10)) {
      lines.push("  · 第 " + it.section + " 节「" + it.token + "」" + it.sentence);
    }
    if ((audit.warnings || []).length) lines.push("其他：" + audit.warnings.join("；"));
    this._set("lr-audit", lines.join("\n"));
    this._status("lr-audit-status", "V1 " + (v1.ok ? "通过" : "问题") + " · V2 " + Math.round((v2.coverage || 0) * 100) + "% · V3 " + (v3.ok ? "通过" : (v3.issueCount || 0) + " 处"),
      (v1.ok && v2.ok && v3.ok) ? "ok" : "warn");
  },

  async saveNote() {
    const ta = this.$("lr-draft");
    const draft = ta ? ta.value : this.state.draft;
    if (!draft || !draft.trim()) { this._status("lr-gen-status", "没有可保存的草稿", "warn"); return; }
    const itemKeys = this._includedWorks().map((w) => w.itemKey).filter(Boolean);
    const r = await this.api.saveNote({ draft: draft, title: this._spec().name || "文献综述", itemKeys: itemKeys });
    if (r.ok) this._status("lr-gen-status", "已保存为笔记（" + (r.standalone ? "独立笔记" : "挂在 " + r.parentKey) + "）", "ok");
    else this._status("lr-gen-status", "保存失败：" + (r.reason || ""), "err");
  },

  async saveMarkdown() {
    const ta = this.$("lr-draft");
    const draft = ta ? ta.value : this.state.draft;
    if (!draft || !draft.trim()) { this._status("lr-gen-status", "没有可导出的草稿", "warn"); return; }
    const r = await this.api.saveText(draft, "literature-review.md");
    if (r && r.ok) this._status("lr-gen-status", "已导出：" + r.path, "ok");
  },

  /* ==================== ④ 配置与项目 ==================== */

  async exportConfig() {
    const r = await this.api.saveText(this.api.toJSON(this._spec()), "lit-review-config.json");
    if (r && r.ok) this._status("lr-run-status", "配置已导出：" + r.path, "ok");
  },

  async importConfig() {
    const f = await this.api.pickText("导入检索配置", "JSON", "json");
    if (!f || !f.ok) return;
    const p = this.api.fromJSON(f.text);
    if (!p.ok) { this._status("lr-run-status", "配置无效：" + p.error, "err"); return; }
    this._applySpec(p.spec);
    this._syncToggles();
    this._syncModeHint();
    this._updatePreview();
    this._status("lr-run-status", "配置已载入，点「检索并建语料」开始", "ok");
  },

  async openProject() {
    const list = await this.api.listProjects();
    if (!list.length) { this._status("lr-run-status", "还没有已保存的项目（检索后会自动保存）", "warn"); return; }
    const labels = list.slice(0, 20).map((p) => (p.title || p.id) + " · " + p.works + " 篇");
    const out = { value: 0 };
    const accepted = Services.prompt.select(window, "打开综述项目", "选择项目：", labels.length, labels, out);
    if (!accepted) return;
    const one = list[Number(out.value) || 0];
    if (!one) return;
    const r = await this.api.loadProject(one.id);
    if (!r.ok) { this._status("lr-run-status", "打开失败：" + r.reason, "err"); return; }
    const p = r.project;
    this.state.projectId = p.id;
    this.state.spec = this.api.normalize(p.spec || {});
    this._applySpec(this.state.spec);
    this.state.works = p.works || [];
    this.state.decisions = p.decisions || [];
    this.state.outline = p.outline || this.api.outlineOf(this.state.spec, this._includedWorks());
    this.state.draft = p.draft || "";
    const ta = this.$("lr-draft");
    if (ta) ta.value = this.state.draft;
    this._renderTable();
    this._renderOutline(this.state.outline);
    this._syncToggles();
    this._syncModeHint();
    this._updatePreview();
    const st = { include: 0, maybe: 0, exclude: 0 };
    for (const d of this.state.decisions) st[d.decision] = (st[d.decision] || 0) + 1;
    this._set("lr-corpus-status", "项目 " + (p.title || p.id) + " · " + this.state.works.length + " 篇 · 纳入 " + st.include);
    this._status("lr-run-status", "已打开项目：" + (p.title || p.id), "ok");
  },

  async _autosave(draftResult) {
    try {
      if (!this.state.works.length) return;
      const spec = this._spec();
      const title = spec.name || spec.query.topic || "文献综述";
      const r = await this.api.saveProject({
        id: this.state.projectId,
        title: title,
        spec: spec,
        works: this.state.works,
        decisions: this.state.decisions,
        outline: this.state.outline,
        sections: (draftResult && draftResult.sections) || [],
        draft: this.$("lr-draft") ? this.$("lr-draft").value : this.state.draft,
        audit: (draftResult && draftResult.audit) || this.state.audit,
      });
      if (r && r.ok) this.state.projectId = r.id;
    } catch (e) { /* 自动保存失败不打断主流程 */ }
  },
};

/* 脚本先于 DOM 执行：两种时机都接住，init 自带幂等 */
(function () {
  try {
    if (document.readyState === "loading" || document.readyState === "uninitialized") {
      document.addEventListener("DOMContentLoaded", function () { LitReviewUI.boot(); });
      window.addEventListener("load", function () { LitReviewUI.boot(); });
    } else {
      LitReviewUI.boot();
    }
  } catch (e) { /* 顶层不抛 */ }
})();
