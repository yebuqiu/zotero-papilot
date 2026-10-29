// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot · 文献检索与综述生成 ④ 综述编排（0.86.0）
 *
 * 把「语料」写成「六段式草稿」，并保证每个引用都能回溯：
 *   大纲（确定性，六段固定）→ 逐节取材料 → AI 分节写（只写 [[W:id]]）→
 *   LitAudit 编号 + 三项校验 → 笔记/文件。
 *
 * 与 ReviewWorkbench 的分工：
 *   · ReviewWorkbench 处理「用户已选中的 ≤30 条」，大纲由 AI 自由生成，引用编号由模型写；
 *   · 本模块处理「检索来的语料」，大纲固定六段（跨篇可比），引用由代码编号。
 *   两者共用 AIClient 与 Notes，不共用提示词——证据密度与约束强度不同。
 *
 * 失败策略：每节独立 try/catch，单节失败不阻塞；AI 不可用时仍能产出
 * 「骨架 + 材料清单」，不给出空壳假稿。
 */
/* global Zotero, Services, Prefs, IOUtils, PathUtils, AIClient, Notes, MdLite, LitQuery, LitCorpus, LitAudit */

var LitReview = {
  WINDOW_URL: "chrome://papilot/content/lit-review.xhtml",
  WINDOW_NAME: "papilot-lit-review",
  WINDOW_TYPE: "papilot:lit-review",
  DEFAULT_TITLE: "文献综述",
  /** 单节喂入的摘要长度（比 ReviewWorkbench 的 200 长：筛选后的材料更少、更相关） */
  MATERIAL_CHARS: 700,
  /** 没有 AI 时的骨架说明 */
  NO_KEY_HINT: "未检测到可用的 AI 通道：可以先完成检索、筛选与语料导出；成稿需要先在设置里配置模型通道。",

  /** 六段骨架（顺序即论证顺序；refs 由代码生成，不喂模型） */
  SIX: [
    { id: "intro", title: "引言", budget: 600, desc: "研究背景、问题的由来、本综述的范围与纳入标准" },
    { id: "state", title: "研究现状", budget: 1200, desc: "按研究路线/方法分组，说明各自的做法与代表性证据" },
    { id: "findings", title: "主要发现", budget: 1500, desc: "一致结论、效应大小、在哪些人群/条件下成立" },
    { id: "debate", title: "争议与不足", budget: 900, desc: "分歧点具体在哪、证据薄弱或方法学受限之处" },
    { id: "conclusion", title: "结论", budget: 500, desc: "回答研究问题、实践含义与未来方向" },
  ],

  str(v) { return String(v == null ? "" : v); },
  clip(s, n) {
    const t = this.str(s).replace(/\s+/g, " ").trim();
    return t.length > n ? t.slice(0, n) + "…" : t;
  },

  /* ==================== ① 大纲与选材（纯函数） ==================== */

  /** 确定性大纲：六段固定，附每节可用材料数（不做 AI 大纲，保证跨篇可比） */
  outline(spec, works) {
    const s = LitQuery.normalize(spec);
    const list = (works || []).filter(Boolean);
    return this.SIX.map((sec, i) => ({
      n: i + 1,
      id: sec.id,
      title: sec.title,
      desc: sec.desc,
      budget: sec.budget,
      required: true,
      pool: this.pick(sec.id, list, s).length,
    })).concat([{
      n: 6, id: "refs", title: "参考文献", desc: "按首次引用顺序编号", budget: 0,
      required: true, generated: true, pool: list.length,
    }]);
  },

  _hasNumbers(text) {
    return /\d+(?:[.,]\d+)?\s*%|\d+\.\d+|\d{2,}/.test(this.str(text));
  },

  /**
   * 每节取哪些材料（确定性，可解释）：
   *   引言      高被引 + 综述（讲背景最省事）
   *   研究现状  按年份倒序，覆盖最新进展
   *   主要发现  摘要含数字的（能写量化结论）
   *   争议与不足 摘要含局限/相反表述的
   *   结论      综述/Meta + 高被引
   */
  pick(kind, works, spec) {
    const cap = Math.max(3, Number(spec && spec.writing && spec.writing.maxWorksPerSection) || 20);
    const list = (works || []).slice();
    const cites = (w) => Number(w.citationCount) || 0;
    const isReview = (w) => /review|meta-analysis/i.test(this.str(w.type) + " " + (w.publicationTypes || []).join(" "));
    let picked;
    if (kind === "intro") {
      picked = list.sort((a, b) => (isReview(b) - isReview(a)) || (cites(b) - cites(a)));
    } else if (kind === "state") {
      picked = list.sort((a, b) => (b.year || 0) - (a.year || 0) || cites(b) - cites(a));
    } else if (kind === "findings") {
      picked = list.filter((w) => this._hasNumbers(w.abstract))
        .sort((a, b) => cites(b) - cites(a));
      // 一条数字都没有时才退回全量（有 1–2 条也比掺入定性文献更贴近"主要发现"）
      if (!picked.length) picked = list.sort((a, b) => cites(b) - cites(a));
    } else if (kind === "debate") {
      picked = list.filter((w) => /limitation|however|contrary|conflict|no significant|did not|heterogene/i.test(this.str(w.abstract)))
        .sort((a, b) => (b.year || 0) - (a.year || 0));
      // 只有一条时补一条作对照：争议节需要"正—反"两侧，单侧不成争议
      if (picked.length && picked.length < 2) {
        for (const w of list) {
          if (picked.indexOf(w) < 0) { picked.push(w); break; }
        }
      }
      if (!picked.length) picked = list.slice().sort((a, b) => (a.year || 0) - (b.year || 0));
    } else {
      picked = list.sort((a, b) => (isReview(b) - isReview(a)) || (cites(b) - cites(a)));
    }
    return picked.slice(0, cap);
  },

  _materials(works) {
    const lines = [];
    for (const w of works || []) {
      const authors = (w.authors || []).slice(0, 3).join(", ") + ((w.authors || []).length > 3 ? ", 等" : "");
      lines.push("[[" + w.id + "]] " + (authors || "佚名") + " (" + (w.year || "年份不详") + "). " +
        this.str(w.title) + (w.journal ? " · " + w.journal : "") +
        (w.abstract ? "\n摘要：" + this.clip(w.abstract, this.MATERIAL_CHARS) : "\n（无摘要，仅有题录）"));
    }
    return lines.join("\n\n");
  },

  /* ==================== ② 提示词（纯函数） ==================== */

  buildSectionPrompt(sec, works, doneTitles, spec) {
    const s = LitQuery.normalize(spec);
    const lang = s.writing.language === "en" ? "English" : "中文";
    const system = "你是一位严谨的学术综述写作者，正在逐节撰写一篇文献综述。必须遵守以下证据纪律：\n" +
      "1) 只使用给定的文献材料，不得引入任何外部文献、常识或「众所周知」的结论；\n" +
      "2) 任何事实性陈述都必须带引用标记 [[W:作品编号]]（作品编号就是材料开头方括号里的 w_xxx），" +
      "可并列多个；**绝对不要写 [1]、(Author, 2020) 这类编号或作者年份**，编号由程序统一分配；\n" +
      "3) 严格区分文献结论与你的推断：推断必须写成「据此推断」，不得伪装成文献原话；\n" +
      "4) 不得写出材料中没有的数字、样本量、统计量、年份或直接引语；材料没给的一律不写；\n" +
      "5) 本节若涉及分歧，必须成对呈现相反证据，并指出分歧点（人群/干预/终点/随访）；\n" +
      "6) 只写本节，不重复其它节；不要输出参考文献列表；输出纯 Markdown 正文，不要代码围栏。";
    const user = "【本节】第 " + sec.n + " 节《" + sec.title + "》，目标：" + this.str(sec.desc) + "\n" +
      "【字数】" + sec.budget + " 字左右（" + lang + "）\n" +
      "【已完成节】" + (doneTitles && doneTitles.length ? doneTitles.join("；") + "（不要重复这些节的内容）" : "（本节为首节）") + "\n" +
      "【文献材料】共 " + (works || []).length + " 篇\n" + this._materials(works) + "\n\n" +
      "请撰写本节正文，引用一律写成 [[W:w_xxx]]。";
    return { system: system, user: user };
  },

  stripFences(text) {
    let s = this.str(text).replace(/^\uFEFF/, "").trim();
    if (!s) return "";
    const whole = s.match(/^```[^\n]*\n([\s\S]*?)\n```$/);
    if (whole) return whole[1].trim();
    return s.replace(/^```[^\n]*\n/, "").replace(/\n```\s*$/, "").trim();
  },

  /* ==================== ③ 编排 ==================== */

  aiReady() {
    try {
      if (typeof AIClient !== "undefined" && AIClient && typeof AIClient.hasKey === "function" && AIClient.hasKey()) {
        return { ok: true };
      }
      let guidance = "";
      try { guidance = (AIClient && typeof AIClient.guidance === "function") ? AIClient.guidance() : ""; } catch (e) { guidance = ""; }
      return { ok: false, reason: "no_key", guidance: guidance || this.NO_KEY_HINT };
    } catch (e) {
      return { ok: false, reason: "no_key", guidance: this.NO_KEY_HINT };
    }
  },

  _chat(messages) {
    if (typeof AIClient === "undefined" || !AIClient || typeof AIClient.chat !== "function") {
      throw new Error("AI 客户端未就绪");
    }
    return AIClient.chat(messages);
  },

  /**
   * 生成草稿（可中断：预算耗尽即停，已写节保留）。
   * @param {{spec:object, works:Array}} project
   * @param {{onProgress?:function, only?:string[]}} [opts]
   * @returns {Promise<{ok:boolean, sections:Array, rendered:object, draft:string, audit:object, reason?:string, calls:number}>}
   */
  async draft(project, opts) {
    const o = opts || {};
    const spec = LitQuery.normalize(project && project.spec);
    const works = (project && project.works) || [];
    if (!works.length) return { ok: false, reason: "no_works", sections: [], rendered: null, draft: "", audit: null, calls: 0 };
    const ready = this.aiReady();
    if (!ready.ok) return { ok: false, reason: "no_key", guidance: ready.guidance, sections: [], rendered: null, draft: "", audit: null, calls: 0 };

    const outline = (project && project.outline && project.outline.length)
      ? project.outline.filter((s) => s.id !== "refs")
      : this.outline(spec, works).filter((s) => s.id !== "refs");
    const maxCalls = Math.max(1, Number(spec.budget.maxAiCalls) || 12);
    const sections = [];
    let calls = 0;
    let stopped = "";
    const doneTitles = [];

    for (const sec of outline) {
      if (o.only && o.only.length && o.only.indexOf(sec.id) < 0) {
        const prev = (project.sections || []).find((x) => x.id === sec.id);
        if (prev) { sections.push(prev); if (prev.md) doneTitles.push("第" + sec.n + "节《" + sec.title + "》已完成"); }
        continue;
      }
      const pool = this.pick(sec.id, works, spec);
      if (!pool.length) {
        sections.push({ n: sec.n, id: sec.id, title: sec.title, md: "", status: "empty" });
        continue;
      }
      if (calls >= maxCalls) { stopped = "budget"; sections.push({ n: sec.n, id: sec.id, title: sec.title, md: "", status: "skipped" }); continue; }
      const p = this.buildSectionPrompt(sec, pool, doneTitles, spec);
      try {
        const raw = await this._chat([
          { role: "system", content: p.system },
          { role: "user", content: p.user },
        ]);
        calls++;
        const md = this.stripFences(raw);
        sections.push({ n: sec.n, id: sec.id, title: sec.title, md: md, status: md ? "ok" : "empty" });
        if (md) doneTitles.push("第" + sec.n + "节《" + sec.title + "》（" + md.length + " 字）");
      } catch (e) {
        calls++;
        sections.push({ n: sec.n, id: sec.id, title: sec.title, md: "", status: "failed", error: this.str((e && e.message) || e) });
      }
      if (o.onProgress) { try { o.onProgress(sections.length, outline.length); } catch (e) { /* ignore */ } }
    }

    const rendered = LitAudit.render(sections, works);
    const audit = LitAudit.check({ sections: rendered.sections, works: works, rendered: rendered, spec: spec });
    const title = spec.name || spec.query.topic || this.DEFAULT_TITLE;
    const notice = "本稿由 Papilot 依据所列语料生成于 " + new Date().toLocaleString() +
      "，引用编号由程序按首次出现顺序分配；文末附引用审计，请逐条复核后再使用。";
    let draft = LitAudit.assemble({ title: title, rendered: rendered, works: works, style: spec.writing.citationStyle, notice: notice });
    if (spec.verification.strictness !== "off") draft += "\n" + LitAudit.appendix(audit);
    return {
      ok: sections.some((s) => s.status === "ok"),
      sections: sections,
      rendered: rendered,
      draft: draft,
      audit: audit,
      calls: calls,
      stopped: stopped,
      reason: sections.some((s) => s.status === "ok") ? "" : "all_sections_failed",
      guidance: ready.guidance || "",
    };
  },

  /* ==================== ④ 产物落盘 ==================== */

  /* -------- 给窗口用的稳定门面（窗口里没有 SubSources/AIClient 等 bootstrap 全局，
     所有跨作用域调用必须回到这里，不能在窗口脚本里直接调 LitCorpus） -------- */

  defaultSpec() { return LitQuery.normalize({}); },
  normalize(spec) { return LitQuery.normalize(spec); },
  validateSpec(spec) { return LitQuery.validate(spec); },
  toJSON(spec) { return LitQuery.toJSON(spec); },
  fromJSON(text) { return LitQuery.fromJSON(text); },
  preview(spec) { return LitQuery.compileAll(spec); },
  summaryOf(spec) { return LitQuery.summary(spec); },
  hash(spec) { return LitQuery.hash(spec); },
  outlineOf(spec, works) { return this.outline(spec, works); },
  toCsv(works, decisions) { return LitCorpus.toCsv(works, decisions); },
  async search(spec, opts) { return LitCorpus.searchAll(spec, opts); },
  async build(spec, opts) { return LitCorpus.build(spec, opts); },
  async importWorks(works, decisions, opts) {
    const r = await LitCorpus.importWorks(works, decisions, opts);
    if (r && r.items && r.items.length) LitCorpus.attachItemKeys(works, r.items);
    return r;
  },

  _dir() {
    const base = Zotero.DataDirectory.dir;
    return PathUtils.join(base, "papilot", "lit-review");
  },

  async _ensureDir() {
    const dir = this._dir();
    try { await IOUtils.makeDirectory(dir, { ignoreExisting: true }); } catch (e) { /* 已存在 */ }
    return dir;
  },

  async saveProject(project) {
    try {
      const dir = await this._ensureDir();
      const p = Object.assign({}, project);
      p.updatedAt = Date.now();
      if (!p.id) p.id = "lr_" + p.updatedAt.toString(36);
      // records 只留统计，避免项目文件膨胀
      if (p.records) { p.recordCount = p.records.length; delete p.records; }
      const path = PathUtils.join(dir, p.id + ".json");
      await IOUtils.writeUTF8(path, JSON.stringify(p, null, 1));
      return { ok: true, id: p.id, path: path };
    } catch (e) {
      return { ok: false, reason: String((e && e.message) || e) };
    }
  },

  async loadProject(id) {
    try {
      const path = PathUtils.join(this._dir(), String(id) + ".json");
      const text = await IOUtils.readUTF8(path);
      const obj = JSON.parse(text);
      return { ok: true, project: obj };
    } catch (e) {
      return { ok: false, reason: String((e && e.message) || e) };
    }
  },

  async listProjects() {
    try {
      const dir = this._dir();
      const names = await IOUtils.getChildren(dir).catch(() => []);
      const out = [];
      for (const p of names) {
        if (!/\.json$/i.test(p)) continue;
        try {
          const j = JSON.parse(await IOUtils.readUTF8(p));
          out.push({ id: j.id, title: j.title || j.id, updatedAt: j.updatedAt || 0, works: (j.works || []).length });
        } catch (e) { /* 坏文件跳过 */ }
      }
      return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    } catch (e) {
      return [];
    }
  },

  async deleteProject(id) {
    try {
      await IOUtils.remove(PathUtils.join(this._dir(), String(id) + ".json"), { ignoreAbsent: true });
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: String((e && e.message) || e) };
    }
  },

  _htmlOf(md, title) {
    let html;
    try {
      html = (typeof MdLite !== "undefined" && MdLite && typeof MdLite.toNoteHtml === "function")
        ? MdLite.toNoteHtml(title, md)
        : "<pre>" + this.str(md).replace(/&/g, "&amp;").replace(/</g, "&lt;") + "</pre>";
    } catch (e) {
      html = "<pre>" + this.str(md).replace(/&/g, "&amp;").replace(/</g, "&lt;") + "</pre>";
    }
    return LitAudit.linkifyHtml(html);
  },

  /**
   * 保存为笔记：优先挂到语料第一条已入库条目（有上下文），否则建独立笔记。
   * @param {{draft:string, title?:string, itemKeys?:string[]}} payload
   */
  async saveNote(payload) {
    const p = payload || {};
    const md = this.str(p.draft);
    if (!md.trim()) return { ok: false, reason: "empty_draft" };
    const title = this.str(p.title) || this.DEFAULT_TITLE;
    try {
      const keys = (p.itemKeys || []).filter((k) => /^[A-Za-z0-9]+$/.test(this.str(k)));
      if (keys.length && typeof Notes !== "undefined" && Notes && typeof Notes.createFromMarkdown === "function") {
        const parent = Zotero.Items.getByLibraryAndKey(Zotero.Libraries.userLibraryID, keys[0]);
        if (parent) {
          const note = await Notes.createFromMarkdown(parent, title, md, {
            transformHtml: (h) => LitAudit.linkifyHtml(h),
          });
          return { ok: true, noteID: note && note.id, parentKey: keys[0] };
        }
      }
      const note = new Zotero.Item("note");
      note.libraryID = Zotero.Libraries.userLibraryID;
      note.setNote(this._htmlOf(md, title));
      await note.saveTx();
      return { ok: true, noteID: note.id, standalone: true };
    } catch (e) {
      return { ok: false, reason: String((e && e.message) || e), error: String((e && e.message) || e) };
    }
  },

  async saveText(text, suggestedName) {
    try {
      const fp = new Zotero.FilePicker();
      fp.init(Zotero.getMainWindow(), "导出综述草稿", fp.modeSave);
      fp.appendFilter("Markdown", "*.md");
      fp.defaultString = suggestedName || "review.md";
      const r = fp.show();
      if (r !== 0 && r !== 1) return { ok: false, reason: "cancelled" };
      await IOUtils.writeUTF8(fp.file.path, this.str(text));
      return { ok: true, path: fp.file.path };
    } catch (e) {
      return { ok: false, reason: String((e && e.message) || e) };
    }
  },

  /** 选一个文本文件读入（配置导入、项目导入共用） */
  async pickText(title, filterName, ext) {
    try {
      const fp = new Zotero.FilePicker();
      fp.init(Zotero.getMainWindow(), title || "选择文件", fp.modeOpen);
      fp.appendFilter(filterName || "JSON", "*." + (ext || "json"));
      const r = fp.show();
      if (r !== 0 && r !== 1) return { ok: false, reason: "cancelled" };
      const text = await IOUtils.readUTF8(fp.file.path);
      return { ok: true, text: text, path: fp.file.path };
    } catch (e) {
      return { ok: false, reason: String((e && e.message) || e) };
    }
  },

  /* ==================== ⑤ 窗口 ==================== */

  openDialog(payload) {
    try {
      const Z = (typeof Zotero !== "undefined") ? Zotero : null;
      if (!Z) return null;
      const Sv = (typeof Services !== "undefined") ? Services : null;
      try {
        if (Sv && Sv.wm) {
          const en = Sv.wm.getEnumerator(this.WINDOW_TYPE);
          if (en.hasMoreElements()) {
            const w = en.getNext();
            try { w.focus(); } catch (e) { /* ignore */ }
            try { if (typeof w.PapilotSetPayload === "function") w.PapilotSetPayload(payload || {}); } catch (e) { /* ignore */ }
            return w;
          }
        }
      } catch (e) { /* 枚举失败照常开新窗 */ }
      const win = Z.getMainWindow();
      if (!win) return null;
      return win.openDialog(this.WINDOW_URL, this.WINDOW_NAME, "chrome,centerscreen,resizable,dialog=no", {
        Zotero: Z,
        Services: Sv,
        api: this,
        payload: payload || {},
      });
    } catch (e) {
      try { Zotero.logError(e); } catch (e2) { /* ignore */ }
      return null;
    }
  },
};

try {
  if (typeof module !== "undefined" && module.exports) module.exports = LitReview;
} catch (e) { /* ignore */ }
