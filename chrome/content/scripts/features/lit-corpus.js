// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot · 文献检索与综述生成 ② 语料编排（0.86.0）
 *
 * 职责：把一份 LitQuery 配置跑成「可筛选、可入库、可导出」的语料。
 *   searchAll → records → dedupe → works → score/screen → import/CSV
 *
 * 分层原则（与 ReviewWorkbench 一致）：
 *   ① 纯函数：归一、指纹、相似度、打分、筛选、CSV —— 不碰 Zotero，可 Node 单测；
 *   ② 编排：searchAll / importWorks —— 所有 async 不抛，失败一律 {ok:false, reason}；
 *   ③ 写入：只经 RefImport.importRecords（它已处理字段映射与事务），本模块不直接建条目。
 *
 * 与订阅（SearchSubs）的分工：订阅是「持续增量发现」，只取时间窗内新条目；
 * 本模块是「一次性建库」，按概念组取最大召回并逐条留痕（分数 + 理由），不做 seen 记账。
 *
 * 引用编号不在这里生成——见 LitAudit（先绑定证据，再按首次出现编号）。
 */
/* global Zotero, SubSources, RefImport, LitQuery, IOUtils, PathUtils */

var LitCorpus = {
  /** 去重时标题相似度用 bigram Dice（与 RefFormat.titleMatch 同思路，避免引一个只做 DOI 比对的实现） */
  TITLE_THRESHOLD_DEFAULT: 0.92,

  /* ==================== ① 纯函数 ==================== */

  str(v) { return String(v == null ? "" : v); },

  normTitle(t) {
    return this.str(t).toLowerCase()
      .replace(/[\s\p{P}\p{S}]/gu, "")
      .replace(/^(a|an|the)/, "")
      .slice(0, 180);
  },

  yearOf(v) {
    const m = /(\d{4})/.exec(this.str(v));
    if (!m) return 0;
    const y = Number(m[1]);
    return y >= 1800 && y <= 2200 ? y : 0;
  },

  /** 标题 bigram Dice 系数（0–1）；短标题退化为字符集 Jaccard */
  titleSim(a, b) {
    const x = this.normTitle(a);
    const y = this.normTitle(b);
    if (!x || !y) return 0;
    if (x === y) return 1;
    if (x.length < 4 || y.length < 4) {
      const sa = new Set(x.split(""));
      const sb = new Set(y.split(""));
      let hit = 0;
      for (const c of sa) if (sb.has(c)) hit++;
      return hit / Math.max(sa.size, sb.size);
    }
    const grams = (s) => {
      const m = new Map();
      for (let i = 0; i < s.length - 1; i++) {
        const g = s.slice(i, i + 2);
        m.set(g, (m.get(g) || 0) + 1);
      }
      return m;
    };
    const ga = grams(x);
    const gb = grams(y);
    let inter = 0;
    let total = 0;
    for (const [g, n] of ga) {
      total += n;
      if (gb.has(g)) inter += Math.min(n, gb.get(g));
    }
    for (const n of gb.values()) total += n;
    return total ? (2 * inter) / total : 0;
  },

  /** 源条目 → 统一 Record（字段名与 SubSources 的归一结果对齐，缺的留空） */
  recordOf(source, raw) {
    const r = raw || {};
    const year = this.yearOf(r.published || r.year);
    const doi = this.str(r.doi).toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, "");
    const pmid = this.str(r.pmid || (source === "pubmed" ? r.id : ""));
    return {
      source: source,
      sourceId: this.str(r.id || r.pmid || doi || r.arxivId),
      doi: doi,
      pmid: pmid,
      arxivId: this.str(r.arxivId || ""),
      title: this.str(r.title).replace(/\s+/g, " ").trim(),
      abstract: this.str(r.summary || r.abstract).replace(/\s+/g, " ").trim(),
      authors: (Array.isArray(r.authors) ? r.authors : []).map((a) => this.str(a).trim()).filter(Boolean).slice(0, 60),
      date: this.str(r.published || ""),
      year: year,
      journal: this.str(r.venue || r.journal || ""),
      volume: this.str(r.volume || ""),
      issue: this.str(r.issue || ""),
      pages: this.str(r.pages || ""),
      type: this.str(r.type || ""),
      publicationTypes: Array.isArray(r.publicationTypes) ? r.publicationTypes.slice(0, 8) : [],
      language: this.str(r.language || "").toLowerCase(),
      citationCount: Number(r.citationCount) || 0,
      isRetracted: !!r.isRetracted,
      oaUrl: this.str(r.pdfUrl || ""),
      url: this.str(r.url || ""),
      issn: this.str(r.issn || ""),
    };
  },

  /** 强标识键（用于跨源合并；一个记录可能同时有 DOI 与 PMID，从而把两条链并起来） */
  strongKeys(r) {
    const out = [];
    if (r.doi) out.push("doi:" + r.doi);
    if (r.pmid) out.push("pmid:" + r.pmid);
    if (r.arxivId) out.push("arxiv:" + r.arxivId.toLowerCase());
    return out;
  },

  /**
   * 跨源去重：强标识并查集 + 标题相似度块内合并。
   * 与 SubSources.dedupe（单轮精确键）的差别：
   *   · 同一篇的 PubMed/EPMC/OpenAlex 记录靠 DOI 或 PMID 串起来（并查集，不要求同键）；
   *   · 预印本与正式版（不同 DOI、标题几乎相同、年份差 ≤1）合并为一条 Work，但保留 versions；
   *   · 标题相同但年份差 >1 的（社论/更正/同名综述）**不合并**。
   * @returns {{works:Array, groups:Array, merged:number}}
   */
  dedupe(records, opts) {
    const o = opts || {};
    const thr = Number(o.titleThreshold) || this.TITLE_THRESHOLD_DEFAULT;
    const list = (records || []).filter((r) => r && (r.title || r.doi));
    const parent = list.map((_, i) => i);
    const find = (i) => {
      let x = i;
      while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
      return x;
    };
    const union = (a, b) => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent[rb] = ra;
    };

    // 1) 强标识并查集
    const byKey = new Map();
    list.forEach((r, i) => {
      for (const k of this.strongKeys(r)) {
        if (byKey.has(k)) union(byKey.get(k), i);
        else byKey.set(k, i);
      }
    });

    // 2) 标题块内相似度（只在跨簇之间做，块键取归一标题前 48 字符）
    const blocks = new Map();
    list.forEach((r, i) => {
      const key = this.normTitle(r.title).slice(0, 48);
      if (key) {
        if (!blocks.has(key)) blocks.set(key, []);
        blocks.get(key).push(i);
      }
    });
    for (const idxs of blocks.values()) {
      if (idxs.length < 2) continue;
      for (let a = 0; a < idxs.length; a++) {
        for (let b = a + 1; b < idxs.length; b++) {
          const ra = list[idxs[a]];
          const rb = list[idxs[b]];
          if (find(idxs[a]) === find(idxs[b])) continue;
          if (Math.abs((ra.year || 0) - (rb.year || 0)) > 1) continue;
          if (this.titleSim(ra.title, rb.title) >= thr) union(idxs[a], idxs[b]);
        }
      }
    }

    // 3) 组内合并字段
    const groupsMap = new Map();
    list.forEach((r, i) => {
      const root = find(i);
      if (!groupsMap.has(root)) groupsMap.set(root, []);
      groupsMap.get(root).push(r);
    });
    const works = [];
    const groups = [];
    let n = 0;
    for (const recs of groupsMap.values()) {
      n++;
      const w = this._mergeGroup(recs, n, o);
      works.push(w);
      groups.push({ workId: w.id, recordCount: recs.length, sources: w.sources });
    }
    return { works: works, groups: groups, merged: list.length - works.length };
  },

  _mergeGroup(recs, n, o) {
    const preferPublished = o.preferPublished !== false;
    // 题录优先取「有 DOI 的正式版」；摘要取最长（摘要常被不同源截断）
    const scoreOf = (r) => {
      let s = 0;
      if (r.doi) s += 4;
      if (/preprint/i.test(r.type) === false) s += 2;
      if (r.abstract) s += 1 + Math.min(3, Math.round(r.abstract.length / 600));
      if (preferPublished && /preprint/i.test(r.type)) s -= 2;
      return s;
    };
    const sorted = recs.slice().sort((a, b) => scoreOf(b) - scoreOf(a));
    const base = sorted[0];
    const longestAbstract = recs.map((r) => r.abstract).sort((a, b) => (b || "").length - (a || "").length)[0] || "";
    const sources = [];
    for (const r of recs) if (r.source && sources.indexOf(r.source) < 0) sources.push(r.source);
    const citationCount = recs.reduce((m, r) => Math.max(m, Number(r.citationCount) || 0), 0);
    const pubTypes = [];
    for (const r of recs) for (const t of (r.publicationTypes || [])) if (pubTypes.indexOf(t) < 0) pubTypes.push(t);
    const versions = [];
    for (const r of recs) {
      if (!r.doi) continue;
      versions.push({ kind: /preprint/i.test(r.type) ? "preprint" : "published", doi: r.doi, source: r.source });
    }
    return {
      id: "w_" + String(n).padStart(3, "0"),
      title: base.title || sorted.map((r) => r.title).filter(Boolean)[0] || "(无标题)",
      authors: (base.authors && base.authors.length ? base.authors : (sorted.find((r) => r.authors && r.authors.length) || {}).authors) || [],
      year: base.year || Math.max.apply(null, recs.map((r) => r.year || 0)) || 0,
      date: base.date || "",
      journal: base.journal || (sorted.find((r) => r.journal) || {}).journal || "",
      abstract: longestAbstract,
      doi: base.doi || (sorted.find((r) => r.doi) || {}).doi || "",
      pmid: (recs.find((r) => r.pmid) || {}).pmid || "",
      arxivId: (recs.find((r) => r.arxivId) || {}).arxivId || "",
      type: base.type || "",
      publicationTypes: pubTypes,
      language: base.language || "",
      citationCount: citationCount,
      isRetracted: recs.some((r) => r.isRetracted),
      oaUrl: (recs.find((r) => r.oaUrl) || {}).oaUrl || "",
      url: base.url || "",
      volume: base.volume || "",
      issue: base.issue || "",
      pages: base.pages || "",
      sources: sources,
      versions: versions,
      recordCount: recs.length,
      fingerprint: base.doi ? "doi:" + base.doi : (base.pmid ? "pmid:" + base.pmid : "title:" + this.normTitle(base.title)),
    };
  },

  /** 概念命中：任一词整体出现，或该词的所有 token 都出现（容忍词序/连接符差异） */
  conceptHit(concept, text) {
    const hay = this.str(text).toLowerCase();
    if (!hay) return false;
    const terms = (concept.terms || []).concat(concept.mesh || []);
    for (const t of terms) {
      const term = this.str(t).toLowerCase().trim();
      if (!term) continue;
      if (hay.indexOf(term) >= 0) return true;
      const tokens = term.split(/[\s\-_/]+/).filter((x) => x.length >= 2);
      if (tokens.length > 1 && tokens.every((x) => hay.indexOf(x) >= 0)) return true;
    }
    return false;
  },

  evidenceTypeScore(w) {
    const t = this.str(w.type).toLowerCase() + " " + (w.publicationTypes || []).join(" ").toLowerCase();
    if (/meta-analysis/.test(t)) return 1;
    if (/systematic review/.test(t)) return 0.95;
    if (/randomized|randomised|controlled trial/.test(t)) return 0.9;
    if (/cohort|observational|case-control/.test(t)) return 0.75;
    if (/review/.test(t)) return 0.45;
    if (/preprint/.test(t)) return 0.6;
    if (/editorial|comment|letter/.test(t)) return 0.2;
    return 0.5;
  },

  /**
   * 相关性打分 0–100（确定性，可解释）。
   * T 标题概念覆盖 / A 摘要概念覆盖 / K 关键词命中 / R 时效 / Q 证据类型，权重来自配置。
   */
  score(w, spec, now) {
    const s = LitQuery.normalize(spec);
    const concepts = LitQuery.conceptsOf(s);
    const weights = s.screening.weights;
    const n = concepts.length || 1;
    let tHit = 0;
    let aHit = 0;
    for (const c of concepts) {
      if (this.conceptHit(c, w.title)) tHit++;
      if (this.conceptHit(c, w.abstract)) aHit++;
    }
    const T = concepts.length ? tHit / n : 0;
    const A = concepts.length ? aHit / n : 0;
    const K = Math.min(1, (tHit + aHit) / (2 * n));
    const at = now instanceof Date ? now : new Date(now == null ? Date.now() : now);
    const age = w.year ? Math.max(0, at.getFullYear() - w.year) : 10;
    const R = Math.max(0, Math.min(1, Math.exp(-age / 5)));
    const Q = this.evidenceTypeScore(w);

    let total = 100 * (weights.title * T + weights.abstract * A + weights.keyword * K + weights.recency * R + weights.evidenceType * Q);
    if (w.isRetracted) total -= 100;
    if (!w.abstract) total -= 8;
    if (s.query.filters.languages.length && w.language && s.query.filters.languages.indexOf(w.language) < 0) total -= 15;
    total = Math.max(0, Math.min(100, Math.round(total)));
    return { score: total, T: T, A: A, K: K, R: R, Q: Q, concepts: concepts.length, titleHits: tHit, abstractHits: aHit };
  },

  /**
   * 筛选：硬规则先砍，再打分，再按阈值分档。
   * 返回逐条 decision（include / maybe / exclude）+ 人类可读理由，供面板与 CSV 使用。
   */
  screen(works, spec, now) {
    const s = LitQuery.normalize(spec);
    const hf = s.screening.hardFilters;
    const th = s.screening.thresholds;
    const out = [];
    for (const w of works || []) {
      const reasons = [];
      const scored = this.score(w, s, now);
      if (hf.minYear && w.year && w.year < hf.minYear) reasons.push("早于 " + hf.minYear + " 年");
      if (hf.requireAbstract && !w.abstract) reasons.push("无摘要");
      if (hf.excludeRetracted && w.isRetracted) reasons.push("已撤稿");
      if (hf.minCitations && (w.citationCount || 0) < hf.minCitations) reasons.push("被引低于 " + hf.minCitations);
      if (s.query.filters.openAccessOnly && !w.oaUrl) reasons.push("无开放获取全文");
      if (s.query.filters.languages.length && w.language && s.query.filters.languages.indexOf(w.language) < 0) {
        reasons.push("语言不符（" + w.language + "）");
      }
      if (scored.concepts && scored.T < s.screening.minConceptCoverage) {
        reasons.push("概念覆盖不足（标题命中 " + scored.titleHits + "/" + scored.concepts + "）");
      }
      let decision = "maybe";
      if (reasons.length) decision = "exclude";
      else if (scored.score >= th.include) decision = "include";
      else if (scored.score < th.exclude) decision = "exclude";
      out.push({
        workId: w.id,
        score: scored.score,
        decision: decision,
        reasons: reasons,
        titleHits: scored.titleHits,
        abstractHits: scored.abstractHits,
        concepts: scored.concepts,
      });
    }
    return out;
  },

  /** 统计（面板与 PRISMA 计数表共用） */
  stats(works, decisions) {
    const st = { total: works.length, include: 0, maybe: 0, exclude: 0, retracted: 0, noAbstract: 0, sources: {} };
    const byId = new Map((decisions || []).map((d) => [d.workId, d]));
    for (const w of works) {
      const d = byId.get(w.id);
      if (d && st[d.decision] != null) st[d.decision]++;
      if (w.isRetracted) st.retracted++;
      if (!w.abstract) st.noAbstract++;
      for (const src of (w.sources || [])) st.sources[src] = (st.sources[src] || 0) + 1;
    }
    return st;
  },

  /** Work → RefImport 记录（字段映射只做一次，避免各处各写一套） */
  toImportRecord(w) {
    const authors = (w.authors || []).map((name) => {
      const s = this.str(name).trim();
      if (!s) return null;
      if (/\s/.test(s) === false) return { family: s };
      if (s.indexOf(",") >= 0) {
        const [family, given] = s.split(",");
        return { family: family.trim(), given: this.str(given).trim() };
      }
      const parts = s.split(/\s+/);
      const last = parts[parts.length - 1];
      if (/^[A-Z]{1,4}$/.test(last)) return { family: parts.slice(0, -1).join(" "), given: last };
      return { family: s };
    }).filter(Boolean);
    return {
      itemType: /preprint/i.test(w.type || "") ? "preprint" : "journalArticle",
      title: w.title,
      authors: authors,
      year: w.year ? String(w.year) : "",
      date: w.date || (w.year ? String(w.year) : ""),
      container: w.journal,
      journal: w.journal,
      volume: w.volume,
      issue: w.issue,
      pages: w.pages,
      doi: w.doi,
      pmid: w.pmid,
      abstract: w.abstract,
      url: w.url || (w.doi ? "https://doi.org/" + w.doi : ""),
      language: w.language,
    };
  },

  csvCell(v) {
    const s = this.str(v).replace(/\r?\n/g, " ");
    return /[",;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  },

  /** 语料 CSV（含判定与理由，可直接做方法学附表） */
  toCsv(works, decisions) {
    const byId = new Map((decisions || []).map((d) => [d.workId, d]));
    const rows = [["workId", "decision", "score", "year", "journal", "title", "authors", "doi", "pmid", "sources", "reasons"]];
    for (const w of works || []) {
      const d = byId.get(w.id) || {};
      rows.push([
        w.id, d.decision || "", d.score == null ? "" : String(d.score), w.year ? String(w.year) : "",
        w.journal, w.title, (w.authors || []).slice(0, 6).join("; "), w.doi, w.pmid,
        (w.sources || []).join("|"), (d.reasons || []).join("; "),
      ]);
    }
    return rows.map((r) => r.map((c) => this.csvCell(c)).join(",")).join("\r\n") + "\r\n";
  },

  /* ==================== ② 检索编排 ==================== */

  /** 构造交给 SubSources 的单源条件：预编译查询 + 日期窗（不走订阅的关键词编译） */
  _subFor(id, spec, now) {
    const s = LitQuery.normalize(spec);
    const sub = {
      keywords: "",
      mode: "all",
      maxAgeDays: 0,
      _q: LitQuery.compileFor(id, s),
    };
    if (id === "arxiv") sub._arxivSpec = LitQuery.arxivSpec(s, now);
    const from = s.query.filters.dateFrom;
    if (from && id !== "arxiv") {
      const at = now instanceof Date ? now : new Date();
      const days = Math.round((at.getTime() - new Date(from + "T00:00:00").getTime()) / 86400000);
      if (isFinite(days) && days > 0) sub.maxAgeDays = Math.min(3650, days);
    }
    return sub;
  },

  /**
   * 多源抓取（逐源分页，单源失败不影响其它源）。
   * @returns {Promise<{ok:boolean, records:Array, bySource:object, partial:boolean, reason:string}>}
   */
  async searchAll(spec, opts) {
    const s = LitQuery.normalize(spec);
    const o = opts || {};
    const v = LitQuery.validate(s);
    if (!v.ok) return { ok: false, records: [], bySource: {}, partial: false, reason: v.errors.map((e) => e.msg).join("；") };
    const now = o.now instanceof Date ? o.now : new Date();
    const records = [];
    const bySource = {};
    let anyOk = false;
    let firstReason = "";
    const queryHash = LitQuery.hash(s);

    for (const id of s.sources.enabled) {
      const per = s.sources.perSource[id];
      const cap = Math.min(LitQuery.HARD_CAP[id], per.maxRecords);
      const pageSize = Math.max(1, Math.min(per.pageSize, cap));
      if (typeof SubSources !== "undefined" && SubSources._isDead && SubSources._isDead(id)) {
        bySource[id] = { ok: false, count: 0, cooled: true, reason: "此前连接失败，已暂停重试（5 分钟后自动恢复）" };
        if (!firstReason) firstReason = LitQuery.LABEL[id] + "：连接失败（冷却中）";
        continue;
      }
      let got = 0;
      let offset = 0;
      try {
        while (got < cap) {
          const want = Math.min(pageSize, cap - got);
          const rows = await SubSources.searchOne(id, this._subFor(id, s, now), {
            limit: want, offset: offset, cap: cap, now: now,
          });
          if (!rows || !rows.length) break;
          for (const raw of rows) {
            const rec = this.recordOf(id, raw);
            rec.retrievedAt = now.getTime();
            rec.queryHash = queryHash;
            records.push(rec);
          }
          got += rows.length;
          if (rows.length < want) break;
          if (!LitQuery.OFFSET[id]) break;
          offset += rows.length;
          if (o.onProgress) { try { o.onProgress(id, got, cap); } catch (e) { /* ignore */ } }
        }
        bySource[id] = { ok: true, count: got };
        anyOk = true;
      } catch (e) {
        const msg = (typeof SubSources !== "undefined" && SubSources._scrub)
          ? SubSources._scrub(String((e && (e.message || e)) || "失败"))
          : String((e && (e.message || e)) || "失败");
        if (/超时|timeout|无响应|NS_ERROR|unreachable|network|连接|拒绝/i.test(msg)
          && typeof SubSources !== "undefined" && SubSources._markDead) {
          SubSources._markDead(id);
        }
        bySource[id] = { ok: false, count: got, reason: msg };
        if (!firstReason) firstReason = LitQuery.LABEL[id] + "：" + msg;
        if (got > 0) anyOk = true; // 部分页已拿到，算部分成功
      }
    }
    if (!anyOk && !records.length) {
      return { ok: false, records: [], bySource: bySource, partial: false, reason: firstReason || "所有数据源均失败" };
    }
    return {
      ok: true,
      records: records,
      bySource: bySource,
      partial: Object.keys(bySource).some((k) => !bySource[k].ok),
      reason: firstReason,
      queryHash: queryHash,
    };
  },

  /** 一步到位：检索 + 去重 + 筛选（面板「检索并建库」与单测共用） */
  async build(spec, opts) {
    const res = await this.searchAll(spec, opts);
    if (!res.ok) return { ok: false, reason: res.reason, bySource: res.bySource, works: [], decisions: [], stats: null };
    const d = this.dedupe(res.records, LitQuery.normalize(spec).dedupe);
    const decisions = this.screen(d.works, spec, opts && opts.now);
    return {
      ok: true,
      records: res.records,
      works: d.works,
      groups: d.groups,
      merged: d.merged,
      decisions: decisions,
      bySource: res.bySource,
      partial: res.partial,
      reason: res.reason,
      queryHash: res.queryHash,
      stats: this.stats(d.works, decisions),
      csv: this.toCsv(d.works, decisions),
    };
  },

  /* ==================== ③ 入库 ==================== */

  _colName(spec) {
    const s = LitQuery.normalize(spec);
    const base = s.name || s.query.topic || "文献综述";
    return base.slice(0, 40) + " · 综述语料";
  },

  async _ensureCollection(name, libraryID) {
    try {
      const lib = libraryID || Zotero.Libraries.userLibraryID;
      const cols = Zotero.Collections.getByLibrary(lib, true) || [];
      for (const c of cols) if (c && c.name === name) return c;
      const col = new Zotero.Collection();
      col.libraryID = lib;
      col.name = name;
      await col.saveTx();
      return col;
    } catch (e) {
      return null;
    }
  },

  /**
   * 只导入「纳入 + 待定」，已排除的不入库（避免污染文库）。
   * @param {Array} works
   * @param {Array} decisions
   * @param {{spec?:object, projectId?:string, includeMaybe?:boolean, collection?:object}} [opts]
   */
  async importWorks(works, decisions, opts) {
    const o = opts || {};
    if (typeof RefImport === "undefined" || !RefImport || typeof RefImport.importRecords !== "function") {
      return { ok: false, reason: "ref_import_unavailable", imported: 0, items: [] };
    }
    const byId = new Map((decisions || []).map((d) => [d.workId, d]));
    const picked = (works || []).filter((w) => {
      const d = byId.get(w.id);
      if (!d) return true;
      return d.decision === "include" || (o.includeMaybe !== false && d.decision === "maybe");
    });
    if (!picked.length) return { ok: false, reason: "nothing_to_import", imported: 0, items: [] };
    try {
      const label = this._colName(o.spec || {});
      const col = o.collection || await this._ensureCollection(label);
      const recs = picked.map((w) => this.toImportRecord(w));
      const res = await RefImport.importRecords(recs, { collection: col || null });
      // 溯源标记：写进 extra，便于日后按项目清理（不改标准字段）
      if (o.projectId) {
        for (const item of (res.items || [])) {
          try {
            const extra = String(item.getField("extra") || "");
            if (extra.indexOf("Papilot-LitReview:") < 0) {
              item.setField("extra", (extra ? extra + "\n" : "") + "Papilot-LitReview: " + o.projectId);
              await item.saveTx();
            }
          } catch (e) { /* 单条失败不影响导入结果 */ }
        }
      }
      return {
        ok: res.ok > 0,
        imported: res.ok,
        failed: res.fail,
        items: res.items || [],
        collection: col || null,
        reason: res.ok > 0 ? "" : "import_failed",
        errors: res.errors || [],
      };
    } catch (e) {
      return { ok: false, reason: String((e && e.message) || e), imported: 0, items: [] };
    }
  },

  /** 把导入后的条目回填 itemKey（写作阶段要用 key 生成 zotero:// 链接） */
  attachItemKeys(works, items) {
    const byDoi = new Map();
    const byTitle = new Map();
    for (const it of (items || [])) {
      try {
        const d = String(it.getField("DOI") || "").toLowerCase().trim();
        if (d) byDoi.set(d, it);
        const t = this.normTitle(it.getField("title"));
        if (t) byTitle.set(t, it);
      } catch (e) { /* 单条读字段失败跳过 */ }
    }
    for (const w of works || []) {
      if (!w) continue;
      const hit = (w.doi && byDoi.get(String(w.doi).toLowerCase())) || byTitle.get(this.normTitle(w.title));
      if (hit && hit.key) w.itemKey = String(hit.key);
    }
    return works;
  },
};

try {
  if (typeof module !== "undefined" && module.exports) module.exports = LitCorpus;
} catch (e) { /* ignore */ }
