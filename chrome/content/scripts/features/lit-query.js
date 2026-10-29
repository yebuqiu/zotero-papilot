// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot · 文献检索与综述生成 ① 查询与配置（0.86.0）
 *
 * 定位：把「一份可配置的检索意图」编译成**各源自己的语法**，并负责配置的归一、校验、
 * 指纹与导入导出。全部是纯函数，不碰 Zotero / 网络，可在 Node 里直接单测。
 *
 * 为什么单独一层：
 *   SubSources 的 pubmedTerm()/europePmcQuery() 是**订阅**语义（关键词 OR/AND + 时间窗），
 *   综述场景需要的是**概念组**（组间 AND、组内 OR、可混 MeSH），且同一条 QuerySpec 要能
 *   同时下发给五个源并留痕。把编译逻辑独立出来，才能给每个源钉黄金串测试。
 *
 * 三种模式：
 *   topic    主题 → 概念组（可 AI 拆，也可本地按标点/连词粗拆）→ 编译
 *   keywords 关键词 → 单概念组，布尔模式 all/any/phrase
 *   custom   原生检索式 → 只做体检，仅下发给声明支持该语法的源（PubMed）
 *
 * 语法边界（不假装通用）：
 *   · PubMed 支持 [tiab]/[mh]/[la]/[pt]/[dp]，布尔完整；
 *   · Europe PMC 支持 TITLE_ABS:/MESH:/LANG:/PUB_TYPE:/PUB_YEAR:[a TO b]；
 *   · OpenAlex / Crossref 只有自由文本检索，**没有布尔语法**，概念组在这里退化为
 *     「按概念拼接的短语串」，AND 语义交给本地硬筛选兜底（见 LitCorpus.screen）；
 *   · arXiv 走 Atom 的 all:/ti:/abs:，只做关键词与时间窗。
 */
/* global module */

var LitQuery = {
  VERSION: 1,
  /** 支持的数据源（顺序即 UI 顺序，与 SubSources.LIST 一致） */
  SOURCES: ["pubmed", "europepmc", "openalex", "crossref", "arxiv"],
  LABEL: { pubmed: "PubMed", europepmc: "Europe PMC", openalex: "OpenAlex", crossref: "Crossref", arxiv: "arXiv" },
  /** 各源单次请求的硬上限（不是建议值，是接口能力） */
  HARD_CAP: { pubmed: 300, europepmc: 300, openalex: 200, crossref: 300, arxiv: 300 },
  /** 该源是否支持 offset 翻页（Europe PMC 用大 pageSize、arXiv 自带内部分页） */
  OFFSET: { pubmed: true, europepmc: false, openalex: true, crossref: true, arxiv: false },
  /** 声明支持 custom 原生语法的源 */
  CUSTOM_SYNTAX: { pubmed: "pubmed", europepmc: "", openalex: "", crossref: "", arxiv: "" },

  DEFAULTS() {
    return {
      version: 1,
      name: "",
      sources: {
        enabled: ["pubmed", "europepmc"],
        perSource: {
          pubmed: { pageSize: 100, maxRecords: 300, timeoutMs: 25000 },
          europepmc: { pageSize: 100, maxRecords: 300, timeoutMs: 25000 },
          openalex: { pageSize: 50, maxRecords: 200, timeoutMs: 20000 },
          crossref: { pageSize: 100, maxRecords: 200, timeoutMs: 20000 },
          arxiv: { pageSize: 50, maxRecords: 100, timeoutMs: 20000 },
        },
        mailto: "",
      },
      query: {
        mode: "topic",
        topic: "",
        concepts: [],
        conceptLogic: "AND",
        booleanMode: "auto",
        customQuery: { syntax: "pubmed", expression: "" },
        filters: {
          dateFrom: "",
          dateTo: "",
          languages: ["eng", "chi"],
          publicationTypes: [],
          excludePublicationTypes: ["Editorial", "Comment"],
          hasAbstract: true,
          openAccessOnly: false,
          species: "human",
        },
      },
      dedupe: { titleThreshold: 0.92, keepVersions: true, preferPublished: true },
      screening: {
        hardFilters: { minYear: 0, requireAbstract: true, excludeRetracted: true, minCitations: 0 },
        minConceptCoverage: 0.5,
        weights: { title: 0.4, abstract: 0.25, keyword: 0.15, recency: 0.1, evidenceType: 0.1 },
        thresholds: { include: 65, exclude: 30 },
      },
      writing: {
        language: "zh",
        citationStyle: "numeric",
        outline: { template: "six-section", sections: [] },
        outlinePool: 120,
        maxEvidencePerSection: 25,
        maxWorksPerSection: 20,
      },
      budget: { maxAiCalls: 12, maxInputChars: 240000 },
      verification: { strictness: "warn", coverageMin: 0.6 },
      delivery: { formats: ["note", "markdown", "csv"], collection: "auto", tags: ["Papilot综述"], prismaReport: true },
    };
  },

  isObj(v) { return !!v && typeof v === "object" && !Array.isArray(v); },

  /** 深合并：用户配置覆盖默认值；数组整体替换（不合并，避免下标残留） */
  merge(base, over) {
    if (!this.isObj(base)) return this.isObj(over) ? this.clone(over) : over;
    const out = this.clone(base);
    if (!this.isObj(over)) return out;
    for (const k of Object.keys(over)) {
      const v = over[k];
      if (v === undefined) continue;
      if (this.isObj(v) && this.isObj(out[k])) out[k] = this.merge(out[k], v);
      else out[k] = this.clone(v);
    }
    return out;
  },

  clone(v) {
    if (v == null) return v;
    try { return JSON.parse(JSON.stringify(v)); } catch (e) { return v; }
  },

  str(v) { return String(v == null ? "" : v); },

  num(v, def, lo, hi) {
    const n = Number(v);
    if (!isFinite(n)) return def;
    let x = n;
    if (typeof lo === "number") x = Math.max(lo, x);
    if (typeof hi === "number") x = Math.min(hi, x);
    return x;
  },

  /** 把任意输入洗成合法配置（宽进严出：脏字段一律回默认，不抛） */
  normalize(raw) {
    const d = this.DEFAULTS();
    const spec = this.merge(d, this.isObj(raw) ? raw : {});
    const out = this.clone(spec);

    // sources
    const en = Array.isArray(out.sources.enabled) ? out.sources.enabled : [];
    const enabled = [];
    for (const x of en) {
      const id = this.str(x).trim().toLowerCase();
      if (this.SOURCES.indexOf(id) >= 0 && enabled.indexOf(id) < 0) enabled.push(id);
    }
    out.sources.enabled = enabled.length ? enabled : ["pubmed"];
    for (const id of this.SOURCES) {
      const p = this.isObj(out.sources.perSource[id]) ? out.sources.perSource[id] : {};
      const cap = this.HARD_CAP[id];
      out.sources.perSource[id] = {
        pageSize: Math.round(this.num(p.pageSize, d.sources.perSource[id].pageSize, 10, cap)),
        maxRecords: Math.round(this.num(p.maxRecords, d.sources.perSource[id].maxRecords, 1, cap)),
        timeoutMs: Math.round(this.num(p.timeoutMs, d.sources.perSource[id].timeoutMs, 5000, 60000)),
      };
    }
    out.sources.mailto = this.str(out.sources.mailto).trim();

    // query
    const q = out.query;
    q.mode = ["topic", "keywords", "custom"].indexOf(this.str(q.mode)) >= 0 ? q.mode : "topic";
    q.topic = this.str(q.topic).trim();
    q.conceptLogic = this.str(q.conceptLogic).toUpperCase() === "OR" ? "OR" : "AND";
    q.booleanMode = ["all", "any", "phrase", "auto"].indexOf(this.str(q.booleanMode)) >= 0
      ? this.str(q.booleanMode) : "auto";
    const cs = [];
    for (const c of (Array.isArray(q.concepts) ? q.concepts : [])) {
      if (!this.isObj(c)) continue;
      const terms = (Array.isArray(c.terms) ? c.terms : []).map((t) => this.str(t).trim()).filter(Boolean).slice(0, 12);
      const mesh = (Array.isArray(c.mesh) ? c.mesh : []).map((t) => this.str(t).trim()).filter(Boolean).slice(0, 6);
      if (!terms.length && !mesh.length) continue;
      cs.push({ id: this.str(c.id) || ("c" + (cs.length + 1)), label: this.str(c.label).trim(), terms, mesh });
      if (cs.length >= 8) break;
    }
    q.concepts = cs;
    q.customQuery = {
      syntax: this.str(q.customQuery && q.customQuery.syntax) || "pubmed",
      expression: this.str(q.customQuery && q.customQuery.expression).trim(),
    };
    const f = q.filters;
    f.dateFrom = this._date(f.dateFrom);
    f.dateTo = this._date(f.dateTo);
    f.languages = (Array.isArray(f.languages) ? f.languages : []).map((x) => this.str(x).trim().toLowerCase()).filter(Boolean).slice(0, 8);
    f.publicationTypes = (Array.isArray(f.publicationTypes) ? f.publicationTypes : []).map((x) => this.str(x).trim()).filter(Boolean).slice(0, 12);
    f.excludePublicationTypes = (Array.isArray(f.excludePublicationTypes) ? f.excludePublicationTypes : []).map((x) => this.str(x).trim()).filter(Boolean).slice(0, 12);
    f.hasAbstract = !!f.hasAbstract;
    f.openAccessOnly = !!f.openAccessOnly;
    f.species = ["human", "animal", "any"].indexOf(this.str(f.species)) >= 0 ? this.str(f.species) : "any";

    // dedupe / screening
    out.dedupe.titleThreshold = this.num(out.dedupe.titleThreshold, 0.92, 0.8, 0.99);
    out.screening.minConceptCoverage = this.num(out.screening.minConceptCoverage, 0.5, 0, 1);
    const w = out.screening.weights;
    const sum = ["title", "abstract", "keyword", "recency", "evidenceType"]
      .reduce((a, k) => a + this.num(w[k], d.screening.weights[k], 0, 1), 0);
    if (sum > 0) {
      for (const k of Object.keys(d.screening.weights)) w[k] = this.num(w[k], d.screening.weights[k], 0, 1) / sum;
    } else {
      out.screening.weights = this.clone(d.screening.weights);
    }
    out.screening.thresholds.include = Math.round(this.num(out.screening.thresholds.include, 65, 1, 100));
    out.screening.thresholds.exclude = Math.round(this.num(out.screening.thresholds.exclude, 30, 0, 99));
    if (out.screening.thresholds.exclude >= out.screening.thresholds.include) {
      out.screening.thresholds.exclude = Math.max(0, out.screening.thresholds.include - 5);
    }
    out.screening.hardFilters.minYear = Math.round(this.num(out.screening.hardFilters.minYear, 0, 1900, 3000));
    out.screening.hardFilters.minCitations = Math.round(this.num(out.screening.hardFilters.minCitations, 0, 0, 100000));
    out.screening.hardFilters.requireAbstract = !!out.screening.hardFilters.requireAbstract;
    out.screening.hardFilters.excludeRetracted = !!out.screening.hardFilters.excludeRetracted;

    // writing / budget
    out.writing.outlinePool = Math.round(this.num(out.writing.outlinePool, 120, 10, 400));
    out.writing.maxEvidencePerSection = Math.round(this.num(out.writing.maxEvidencePerSection, 25, 3, 60));
    out.writing.maxWorksPerSection = Math.round(this.num(out.writing.maxWorksPerSection, 20, 3, 60));
    out.writing.citationStyle = this.str(out.writing.citationStyle) === "author-year" ? "author-year" : "numeric";
    out.writing.language = ["zh", "en"].indexOf(this.str(out.writing.language)) >= 0 ? this.str(out.writing.language) : "zh";
    out.budget.maxAiCalls = Math.round(this.num(out.budget.maxAiCalls, 12, 1, 60));
    out.budget.maxInputChars = Math.round(this.num(out.budget.maxInputChars, 240000, 20000, 2000000));
    out.verification.strictness = ["off", "warn", "block"].indexOf(this.str(out.verification.strictness)) >= 0
      ? this.str(out.verification.strictness) : "warn";
    out.verification.coverageMin = this.num(out.verification.coverageMin, 0.6, 0, 1);
    out.delivery.tags = (Array.isArray(out.delivery.tags) ? out.delivery.tags : []).map((x) => this.str(x).trim()).filter(Boolean).slice(0, 8);
    return out;
  },

  _date(v) {
    const s = this.str(v).trim();
    if (!/^\d{4}(-\d{2}(-\d{2})?)?$/.test(s)) return "";
    return s;
  },

  /** 配置校验（阻断级错误才返回 ok:false；可自动修复的已在 normalize 处理） */
  validate(spec) {
    const s = this.isObj(spec) ? spec : this.normalize(spec);
    const errors = [];
    if (!s.sources.enabled.length) errors.push({ field: "sources.enabled", msg: "至少选择一个数据源" });
    for (const id of s.sources.enabled) {
      if (this.SOURCES.indexOf(id) < 0) errors.push({ field: "sources.enabled", msg: "未知数据源：" + id });
    }
    if (s.query.mode === "topic" && !s.query.topic && !s.query.concepts.length) {
      errors.push({ field: "query.topic", msg: "主题模式需要主题描述或至少一个概念组" });
    }
    if (s.query.mode === "keywords" && !s.query.topic && !s.query.concepts.length) {
      errors.push({ field: "query.topic", msg: "关键词模式需要至少一个关键词" });
    }
    if (s.query.mode === "custom") {
      if (!s.query.customQuery.expression) {
        errors.push({ field: "query.customQuery", msg: "自定义模式需要检索式" });
      } else {
        const syntax = s.query.customQuery.syntax;
        const capable = s.sources.enabled.filter((id) => this.CUSTOM_SYNTAX[id] === syntax);
        if (!capable.length) {
          errors.push({ field: "query.customQuery", msg: "当前选中的数据源不支持该检索式语法（需要 PubMed）" });
        }
      }
    }
    const unsupported = s.sources.enabled.filter((id) => !this.compileFor(id, s));
    if (unsupported.length && s.query.mode !== "custom") {
      errors.push({ field: "query", msg: "以下源无法由当前条件构造检索式：" + unsupported.join(", ") });
    }
    return { ok: errors.length === 0, errors };
  },

  /**
   * 把一段文字切成概念组：
   *   · 纯拉丁文本按空格切；≤2 字符的短词（如 "2"）并入前一项，避免 2[tiab] 命中海量噪声；
   *   · 含中文的片段整体保留（中文没有空格分词，硬切会切碎词）；
   *   · 返回 Array<string[]>，每组内的词是 OR，组间由调用方 AND。
   */
  _chunkConcept(part) {
    const s = this.str(part).trim();
    if (!s) return [];
    if (/[\u4e00-\u9fa5]/.test(s)) return [[s]];
    const words = s.split(/\s+/).filter(Boolean);
    if (words.length <= 1) return [[s]];
    const groups = [];
    for (const w of words) {
      const short = w.replace(/[^A-Za-z0-9]/g, "").length <= 2;
      if (short && groups.length) groups[groups.length - 1] = [groups[groups.length - 1].join(" ") + " " + w];
      else groups.push([w]);
    }
    return groups;
  },

  /** 有效概念组：显式 concepts 优先；否则由 topic / keywords 退化生成 */
  conceptsOf(spec) {
    const s = spec || {};
    const q = s.query || {};
    if (Array.isArray(q.concepts) && q.concepts.length) return q.concepts;
    const text = this.str(q.topic).trim();
    if (!text) return [];
    if (q.mode === "keywords") {
      // 逗号分隔的每个关键词是一组；组内**空格分词**（"semaglutide cardiovascular"
      // 是两个 AND 条件，不是短语）。要短语请自己加引号（compile 会保留引号内空格）。
      const parts = text.split(/[,;，；]+/).map((x) => x.trim()).filter(Boolean);
      const out = [];
      for (const p of parts) {
        for (const c of this._chunkConcept(p)) out.push(c);
        if (out.length >= 8) break;
      }
      if (!out.length) return [{ id: "c1", label: "", terms: [text], mesh: [] }];
      return out.slice(0, 8).map((c, i) => ({ id: "c" + (i + 1), label: "", terms: c, mesh: [] }));
    }
    return this.draftConcepts(text);
  },

  /**
   * 本地粗拆概念（无 AI 时的兜底）：按中文/英文连接词与标点切成短语，
   * 每个短语一组。宁可多一组（AND 更严），也好过把整句当一个短语（召回为 0）。
   */
  draftConcepts(text) {
    const raw = this.str(text).trim();
    if (!raw) return [];
    const parts = raw
      .split(/[，,；;。\n]|(?:\s+and\s+)|(?<=[\u4e00-\u9fa5])(?:与|和|及)(?=[\u4e00-\u9fa5])/i)
      .map((s) => s.trim())
      .filter((s) => s.length >= 2);
    const list = (parts.length ? parts : [raw]).slice(0, 6);
    const expanded = [];
    for (const p of list) {
      for (const chunk of this._chunkConcept(p)) expanded.push(chunk);
      if (expanded.length >= 6) break;
    }
    return expanded.slice(0, 6).map((terms, i) => ({ id: "c" + (i + 1), label: "", terms: terms, mesh: [] }));
  },

  _q(term) {
    return '"' + this.str(term).replace(/["\\]/g, " ").replace(/\s+/g, " ").trim() + '"';
  },

  /** PubMed 词项：纯字母数字且无空格的短词不加引号（PubMed 更认裸词） */
  _pmTerm(t) {
    const s = this.str(t).trim();
    return /^[A-Za-z0-9]+$/.test(s) ? s : this._q(s);
  },

  _yearOf(dateStr) {
    const m = /^(\d{4})/.exec(this.str(dateStr));
    return m ? m[1] : "";
  },

  /** 主入口：编译某源的检索式；无法构造返回 "" */
  compileFor(source, spec) {
    const s = this.isObj(spec) && spec.query ? spec : this.normalize(spec);
    try {
      if (source === "pubmed") return this._pubmed(s);
      if (source === "europepmc") return this._europepmc(s);
      if (source === "openalex") return this._freeText(s);
      if (source === "crossref") return this._freeText(s);
      if (source === "arxiv") return this._freeText(s);
      return "";
    } catch (e) {
      return "";
    }
  },

  _pubmed(s) {
    const q = s.query;
    if (q.mode === "custom") return q.customQuery.expression || "";
    const groups = this.conceptsOf(s);
    if (!groups.length) return "";
    const kwMode = q.mode === "keywords";
    const inner = kwMode ? (q.booleanMode === "any" ? " OR " : " AND ") : " OR ";
    const parts = [];
    for (const g of groups) {
      const terms = [];
      const gTerms = g.terms || [];
      if (kwMode && q.booleanMode === "phrase" && gTerms.length) {
        parts.push(this._q(gTerms.join(" ")) + "[tiab]");
        for (const m of (g.mesh || [])) parts.push(this._q(m) + "[mh]");
        continue;
      }
      for (const t of gTerms) terms.push(this._pmTerm(t) + "[tiab]");
      for (const m of (g.mesh || [])) terms.push(this._q(m) + "[mh]");
      if (terms.length) parts.push(terms.length > 1 ? "(" + terms.join(inner) + ")" : terms[0]);
    }
    if (!parts.length) return "";
    let expr = parts.length > 1 ? "(" + parts.join(" " + q.conceptLogic + " ") + ")" : parts[0];

    const f = q.filters;
    const from = f.dateFrom ? f.dateFrom.replace(/-/g, "/") : "";
    const to = f.dateTo ? f.dateTo.replace(/-/g, "/") : "3000";
    if (from || f.dateTo) expr += " AND (" + (from || "1800/01/01") + "[dp] : " + to + "[dp])";
    if (f.languages && f.languages.length) {
      expr += " AND (" + f.languages.map((l) => l + "[la]").join(" OR ") + ")";
    }
    if (f.species === "human") expr += " AND humans[mh]";
    if (f.publicationTypes && f.publicationTypes.length) {
      expr += " AND (" + f.publicationTypes.map((t) => this._q(t) + "[pt]").join(" OR ") + ")";
    }
    const ex = (f.excludePublicationTypes || []).map((t) => this._q(t) + "[pt]");
    if (ex.length) expr += " NOT (" + ex.join(" OR ") + ")";
    return expr;
  },

  _europepmc(s) {
    const q = s.query;
    if (q.mode === "custom") return ""; // 不假装兼容 PubMed 语法
    const groups = this.conceptsOf(s);
    if (!groups.length) return "";
    const kwMode = q.mode === "keywords";
    const inner = kwMode ? (q.booleanMode === "any" ? " OR " : " AND ") : " OR ";
    const parts = [];
    for (const g of groups) {
      const terms = [];
      const gTerms = g.terms || [];
      if (kwMode && q.booleanMode === "phrase" && gTerms.length) {
        parts.push("TITLE_ABS:" + this._q(gTerms.join(" ")));
        for (const m of (g.mesh || [])) parts.push("MESH:" + this._q(m));
        continue;
      }
      for (const t of gTerms) terms.push("TITLE_ABS:" + this._q(t));
      for (const m of (g.mesh || [])) terms.push("MESH:" + this._q(m));
      if (terms.length) parts.push(terms.length > 1 ? "(" + terms.join(inner) + ")" : terms[0]);
    }
    if (!parts.length) return "";
    let expr = parts.length > 1 ? "(" + parts.join(" " + q.conceptLogic + " ") + ")" : parts[0];

    const f = q.filters;
    const y1 = this._yearOf(f.dateFrom);
    const y2 = this._yearOf(f.dateTo);
    if (y1 || y2) expr += " AND PUB_YEAR:[" + (y1 || "1800") + " TO " + (y2 || "3000") + "]";
    if (f.languages && f.languages.length) {
      const map = { eng: "eng", chi: "chi", zho: "chi" };
      expr += " AND (" + f.languages.map((l) => "LANG:" + this._q(map[l] || l)).join(" OR ") + ")";
    }
    const ex = (f.excludePublicationTypes || []).map((t) => "PUB_TYPE:" + this._q(t));
    if (ex.length) expr += " NOT (" + ex.join(" OR ") + ")";
    return expr;
  },

  /** OpenAlex / Crossref / arXiv 的自由文本：概念组之间用空格（AND 语义靠本地复核） */
  _freeText(s) {
    const q = s.query;
    if (q.mode === "custom") return "";
    const groups = this.conceptsOf(s);
    if (!groups.length) return "";
    const chunks = [];
    for (const g of groups) {
      const terms = (g.terms || []).concat(g.mesh || []).filter(Boolean).slice(0, 4);
      if (!terms.length) continue;
      chunks.push(terms[0]); // 自由文本源只取每个概念的首选词，扩词交给本地 matches()
    }
    return chunks.join(" ").trim();
  },

  /** arXiv 需要的 spec（ArxivFetch.search 的形状） */
  arxivSpec(s, now) {
    const text = this._freeText(s);
    if (!text) return null;
    const f = s.query.filters;
    const spec = { keywords: text, mode: "all", categories: "", exclude: "", maxAgeDays: 0 };
    if (f.dateFrom) {
      const at = now instanceof Date ? now : new Date(now == null ? Date.now() : now);
      const days = Math.round((at.getTime() - new Date(f.dateFrom + "T00:00:00").getTime()) / 86400000);
      spec.maxAgeDays = Math.max(1, Math.min(3650, days));
    }
    return spec;
  },

  /** 检索式指纹（FNV-1a 32 位）：同配置同指纹，用于判断"是否同一检索" */
  hash(spec) {
    const s = this.isObj(spec) && spec.query ? spec : this.normalize(spec);
    const material = {
      mode: s.query.mode,
      topic: s.query.topic,
      concepts: s.query.concepts,
      logic: s.query.conceptLogic,
      custom: s.query.customQuery,
      filters: s.query.filters,
      sources: s.sources.enabled.slice().sort(),
    };
    const text = JSON.stringify(material, Object.keys(material).sort());
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return ("00000000" + h.toString(16)).slice(-8);
  },

  /** 供 UI 显示：逐源编译结果（空串 = 该源不可用） */
  compileAll(spec) {
    const s = this.isObj(spec) && spec.query ? spec : this.normalize(spec);
    const out = {};
    for (const id of s.sources.enabled) out[id] = this.compileFor(id, s);
    return out;
  },

  /** 导出：剔除凭据引用（配置里本就不该有密钥，双保险） */
  toJSON(spec) {
    const s = this.isObj(spec) && spec.query ? spec : this.normalize(spec);
    const copy = this.clone(s);
    if (copy.sources && copy.sources.credentials) delete copy.sources.credentials;
    return JSON.stringify(copy, null, 2);
  },

  /** 导入：解析 + 归一；语法错误返回 {ok:false} */
  fromJSON(text) {
    try {
      const raw = JSON.parse(this.str(text));
      if (!this.isObj(raw)) return { ok: false, error: "配置必须是 JSON 对象" };
      return { ok: true, spec: this.normalize(raw) };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  },

  /** 一句话摘要（标题栏/日志用） */
  summary(spec) {
    const s = this.isObj(spec) && spec.query ? spec : this.normalize(spec);
    const g = this.conceptsOf(s).length;
    const src = s.sources.enabled.map((id) => this.LABEL[id] || id).join("/");
    return src + " · " + (s.query.mode === "custom" ? "自定义检索式" : g + " 个概念组") + " · 指纹 " + this.hash(s);
  },
};

try {
  if (typeof module !== "undefined" && module.exports) module.exports = LitQuery;
} catch (e) { /* ignore */ }
