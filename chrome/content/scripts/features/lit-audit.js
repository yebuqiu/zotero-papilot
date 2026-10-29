// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot · 文献检索与综述生成 ③ 引用绑定与审计（0.86.0）
 *
 * 这层存在的唯一理由：**让"引用对得上原文"变成可验证的**。
 *
 * 做法（与通用做法相反）：不让模型写编号。
 *   模型只写 `[[W:w_003]]`（作品 id），编号由本模块按**首次出现顺序**分配；
 *   这样"模型数错数""编号错位""删了一段导致后面全错"三类问题在结构上消失。
 *
 * 校验（P0 三项，全部确定性、零成本、可回归）：
 *   V1 可解析：`[[W:...]]` 必须指向已知作品；编号连续无空洞
 *   V2 覆盖率：被引作品数 / 纳入作品数 ≥ coverageMin（默认 0.6），并列出未被引文献
 *   V3 数字有出处：句中出现的小数/百分数/多位数，必须能在该句所引作品的题名或摘要里找到
 *      （单位数整数不查："2 型糖尿病"这类叙述里的 2 不是数据）
 *
 * 不做（P1）：V4 冲突陈述、V5 元数据一致、V6 重复度；也不做模型自检——
 * 模型对自己刚写的句子有确认偏差，且成本翻倍。
 */
/* global module */

var LitAudit = {
  MARK: /\[\[(W|E):([A-Za-z0-9_-]+)\]\]/g,
  ZLINK: /\[\[Z:([A-Za-z0-9]+)\]\]/g,

  str(v) { return String(v == null ? "" : v); },

  /* ==================== 编号与渲染 ==================== */

  /**
   * 逐节渲染：把 `[[W:id]]` 换成 `[n]`，n 按全文首次出现顺序分配。
   * @param {Array<{n?:number,id?:string,title:string,md:string}>} sections
   * @param {Array<{id:string,itemKey?:string,title?:string}>} works
   * @param {{evidence?:Array<{id:string,workId:string}>}} [opts] P1 证据 id 预留
   * @returns {{sections:Array, order:Array, numbers:object, unknown:Array, bindings:Array}}
   */
  render(sections, works, opts) {
    const o = opts || {};
    const byId = new Map();
    for (const w of works || []) if (w && w.id) byId.set(w.id, w);
    const evMap = new Map();
    for (const ev of (o.evidence || [])) if (ev && ev.id) evMap.set(ev.id, ev.workId);

    const order = [];
    const numbers = {};
    const unknown = [];
    const bindings = [];
    const out = [];

    const assign = (kind, rawId) => {
      let workId = rawId;
      if (kind === "E") workId = evMap.get(rawId) || "";
      if (!workId || !byId.has(workId)) {
        if (unknown.indexOf(kind + ":" + rawId) < 0) unknown.push(kind + ":" + rawId);
        return "";
      }
      if (!numbers[workId]) {
        order.push(workId);
        numbers[workId] = order.length;
      }
      return numbers[workId];
    };

    for (let i = 0; i < (sections || []).length; i++) {
      const sec = sections[i] || {};
      const md = this.str(sec.md);
      const text = md.replace(this.MARK, (full, kind, id) => {
        const n = assign(kind, id);
        if (!n) return full; // 未知 id 原样留下 → V1 报错，不静默删
        const workId = kind === "E" ? (evMap.get(id) || "") : id;
        bindings.push({ number: n, workId: workId, section: i, raw: kind + ":" + id });
        return "[" + n + "]";
      });
      // 相邻引用合并：[1][2][3] → [1,2,3]
      const merged = text.replace(/(\[\d+\])+/g, (m) => "[" + (m.match(/\d+/g) || []).join(",") + "]");
      out.push({ n: sec.n != null ? sec.n : i + 1, id: sec.id || "", title: sec.title || "", md: merged, status: sec.status || "ok" });
    }

    return { sections: out, order: order, numbers: numbers, unknown: unknown, bindings: bindings };
  },

  /** 参考文献单行（numeric = GB/T 7714 简化；author-year = 作者 (年)） */
  refLine(work, n, style) {
    const w = work || {};
    const authors = (w.authors || []).slice(0, 3).map((a) => this.str(a).trim()).filter(Boolean);
    const more = (w.authors || []).length > 3;
    const authorText = authors.length ? authors.join(", ") + (more ? ", 等" : "") : "佚名";
    const title = this.str(w.title).replace(/[.。]+$/, "") || "（无标题）";
    const journal = this.str(w.journal).replace(/[.。]+$/, "");
    const year = this.str(w.year) || "年份不详";
    const tail = [journal, year].filter(Boolean).join(", ");
    const loc = [w.volume ? w.volume + (w.issue ? "(" + w.issue + ")" : "") : "", w.pages || ""].filter(Boolean).join(": ");
    const doi = w.doi ? " doi:" + w.doi : "";
    const zlink = w.itemKey && /^[A-Za-z0-9]+$/.test(w.itemKey) ? " [[Z:" + w.itemKey + "]]" : "";
    if (style === "author-year") {
      return authorText + " (" + year + "). " + title + ". " + tail + (loc ? ", " + loc : "") + "." + doi + zlink;
    }
    return "[" + n + "] " + authorText + ". " + title + ". " + tail + (loc ? ", " + loc : "") + "." + doi + zlink;
  },

  /**
   * 拼完整稿：标题 + 各节（空节跳过）+ 参考文献。
   * 参考文献按**被引顺序**列，只列真正被引过的作品（未被引的在审计里提示）。
   */
  assemble(params) {
    const p = params || {};
    const rendered = p.rendered || { sections: [], order: [], numbers: {} };
    const works = p.works || [];
    const byId = new Map(works.map((w) => [w.id, w]));
    const style = p.style === "author-year" ? "author-year" : "numeric";
    let md = "# " + (this.str(p.title) || "文献综述") + "\n\n";
    if (p.notice) md += "> " + this.str(p.notice).replace(/\n/g, " ") + "\n\n";
    for (const sec of rendered.sections) {
      const body = this.str(sec.md).trim();
      if (!body) continue;
      md += "## " + sec.n + ". " + sec.title + "\n\n" + body + "\n\n";
    }
    const cited = (rendered.order || []).map((id) => byId.get(id)).filter(Boolean);
    if (cited.length) {
      md += "## 参考文献\n\n";
      cited.forEach((w, i) => { md += this.refLine(w, i + 1, style) + "\n"; });
    }
    return md.trim() + "\n";
  },

  /* ==================== 校验 ==================== */

  /** 拆句：中文/英文句末标点切分；保留引用标记原位 */
  sentences(text) {
    return this.str(text)
      .split(/(?<=[。！？!?；;])\s*|\n+/)
      .map((s) => s.trim())
      .filter(Boolean);
  },

  /**
   * 抽取"需要核对出处"的数字：
   *   百分数 14%、小数 0.86、多位数 3204/3,204、p 值 0.03（已被小数覆盖）
   * 单位数整数（1–9）不取，避免"2 型糖尿病""3 项研究"这类叙述噪声。
   */
  numericTokens(text) {
    const out = [];
    const re = /\d+(?:[.,]\d+)?\s*%|\d+[.,]\d+|\d{2,}/g;
    let m;
    const s = this.str(text);
    while ((m = re.exec(s))) {
      const token = m[0].replace(/\s+/g, "");
      // 4 位年份是书目信息，不是"数据"：不查出处，否则"2021 年的一项研究"会一直误报
      if (/^\d{4}$/.test(token)) {
        const n = Number(token);
        if (n >= 1900 && n <= 2100) continue;
      }
      if (out.indexOf(token) < 0) out.push(token);
    }
    return out;
  },

  _hay(text) {
    return this.str(text).toLowerCase().replace(/[,\s，]/g, "");
  },

  /**
   * 三项校验。
   * @param {{sections:Array, works:Array, rendered:object, spec:object, now?:Date}} params
   *   sections：**已渲染**的节（含 [n]），works：纳入作品（含未写入的）
   */
  check(params) {
    const p = params || {};
    const works = p.works || [];
    const rendered = p.rendered || { sections: [], order: [], unknown: [], numbers: {} };
    const spec = p.spec || {};

    /* V1 */
    const emptyNumbers = [];
    for (const sec of (rendered.sections || [])) {
      const nums = (this.str(sec.md).match(/\[\d+\]/g) || [])
        .map((x) => Number(String(x).replace(/\D/g, "")))
        .filter((x) => x > 0);
      for (const n of nums) if (!n || n > (rendered.order || []).length) emptyNumbers.push({ section: sec.n, n: n });
    }
    const v1 = {
      ok: !(rendered.unknown || []).length && !emptyNumbers.length,
      unknown: rendered.unknown || [],
      outOfRange: emptyNumbers,
    };

    /* V2 */
    const citedIds = rendered.order || [];
    const cited = citedIds.length;
    const total = works.length;
    const citedSet = new Set(citedIds);
    const uncited = works.filter((w) => !citedSet.has(w.id)).map((w) => ({ id: w.id, title: w.title, year: w.year }));
    const min = Number(spec && spec.verification && spec.verification.coverageMin);
    const coverageMin = isFinite(min) ? Math.max(0, Math.min(1, min)) : 0.6;
    const coverage = total ? cited / total : 0;
    const v2 = {
      ok: total === 0 ? true : coverage >= coverageMin,
      cited: cited,
      total: total,
      coverage: Math.round(coverage * 1000) / 1000,
      coverageMin: coverageMin,
      uncited: uncited.slice(0, 50),
      uncitedCount: uncited.length,
    };

    /* V3 */
    const byId = new Map(works.map((w) => [w.id, w]));
    const issues = [];
    for (const sec of (rendered.sections || [])) {
      for (const sentence of this.sentences(sec.md)) {
        const nums = (sentence.match(/\[(\d+(?:,\d+)*)\]/g) || [])
          .reduce((acc, m) => acc.concat((m.match(/\d+/g) || []).map(Number)), []);
        if (!nums.length) continue;
        const citedWorks = nums.map((n) => byId.get((rendered.order || [])[n - 1])).filter(Boolean);
        if (!citedWorks.length) continue;
        const hay = citedWorks.map((w) => this._hay((w.title || "") + " " + (w.abstract || ""))).join(" ");
        for (const token of this.numericTokens(sentence)) {
          const t = token.replace(/[,\s]/g, "");
          const bare = t.replace(/%$/, "");
          if (hay.indexOf(t) >= 0 || hay.indexOf(bare) >= 0) continue;
          issues.push({ section: sec.n, sentence: sentence.slice(0, 120), token: token, workIds: citedWorks.map((w) => w.id) });
        }
      }
    }
    const v3 = { ok: issues.length === 0, issues: issues.slice(0, 50), issueCount: issues.length };

    const warnings = [];
    if ((rendered.sections || []).some((s) => !this.str(s.md).trim())) warnings.push("存在空节");
    if (v2.uncitedCount) warnings.push("有 " + v2.uncitedCount + " 篇纳入文献未被引用");

    return {
      v1: v1, v2: v2, v3: v3,
      ok: v1.ok && v2.ok && v3.ok,
      warnings: warnings,
      generatedAt: (p.now instanceof Date ? p.now : new Date()).getTime(),
    };
  },

  /** 审计摘要（写进笔记首页的一句话 + 明细行） */
  summary(audit) {
    const a = audit || {};
    const v1 = a.v1 || {};
    const v2 = a.v2 || {};
    const v3 = a.v3 || {};
    const lines = [];
    lines.push("覆盖率 " + Math.round((v2.coverage || 0) * 100) + "%（被引 " + (v2.cited || 0) + " / 纳入 " + (v2.total || 0) + "）");
    let refLine = v1.ok ? "引用编号全部可解析" : "引用编号有问题";
    if ((v1.unknown || []).length) refLine += "（未知标记 " + v1.unknown.length + " 处）";
    if ((v1.outOfRange || []).length) refLine += "（越界 " + v1.outOfRange.length + " 处）";
    lines.push(refLine);
    lines.push(v3.ok ? "数字均可在原文找到" : "有 " + (v3.issueCount || 0) + " 处数字未在所引文献中找到");
    return lines.filter(Boolean).join("；");
  },

  /** 审计明细（Markdown 附录；warn 模式随稿输出，block 模式不产出） */
  appendix(audit) {
    const a = audit || {};
    const v1 = a.v1 || {};
    const v2 = a.v2 || {};
    const v3 = a.v3 || {};
    let md = "## 附：引用审计\n\n";
    md += "- 引用解析：" + (v1.ok ? "通过" : "**未通过**") + "\n";
    if ((v1.unknown || []).length) md += "  - 未知标记：" + v1.unknown.join("、") + "\n";
    if ((v1.outOfRange || []).length) md += "  - 越界编号：" + v1.outOfRange.map((x) => "第" + x.section + "节 [" + x.n + "]").join("、") + "\n";
    md += "- 覆盖率：" + Math.round((v2.coverage || 0) * 100) + "%（" + (v2.cited || 0) + "/" + (v2.total || 0) + "，阈值 " + Math.round((v2.coverageMin || 0) * 100) + "%）" + (v2.ok ? "" : " **低于阈值**") + "\n";
    if (v2.uncitedCount) {
      md += "  - 未被引用：" + (v2.uncited || []).slice(0, 10).map((x) => "《" + this.str(x.title).slice(0, 40) + "》").join("；") + (v2.uncitedCount > 10 ? " 等 " + v2.uncitedCount + " 篇" : "") + "\n";
    }
    md += "- 数字出处：" + (v3.ok ? "全部命中" : "**" + (v3.issueCount || 0) + " 处待核**") + "\n";
    for (const it of (v3.issues || []).slice(0, 10)) {
      md += "  - 第" + it.section + "节「" + it.token + "」：" + it.sentence + "\n";
    }
    if ((a.warnings || []).length) md += "- 其他：" + a.warnings.join("；") + "\n";
    return md;
  },

  /** 笔记渲染前把 `[[Z:KEY]]` 换成可点的 zotero:// 链接（MdLite 不支持链接，故用 HTML 后处理） */
  linkifyHtml(html) {
    return this.str(html)
      .replace(this.ZLINK, (m, key) =>
        /^[A-Za-z0-9]+$/.test(key)
          ? '<a href="zotero://select/library/items/' + key + '">在库中打开</a>'
          : "")
      // 未转成链接的残留标记（key 含非法字符等）不泄漏到成品笔记里
      .replace(/\[\[Z:[^\]]*\]\]/g, "");
  },
};

try {
  if (typeof module !== "undefined" && module.exports) module.exports = LitAudit;
} catch (e) { /* ignore */ }
