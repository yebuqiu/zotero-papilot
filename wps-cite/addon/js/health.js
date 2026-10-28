// SPDX-License-Identifier: Apache-2.0
/* 只读文档体检、投稿前检查与迁移兼容报告。
 *
 * 三块能力共用同一份 FieldScanner 快照，绝不各自重扫：
 *   inspect(scan, context)                 P0 六类体检
 *   preflight(scan, context)               P2-1 投稿前数量/未引/重复/字段建议
 *   compatibility(scan, caps, target)      P2-3 Word/WPS/LibreOffice 迁移判断
 *
 * 纪律：
 *   - 全部只读：不写域、不写文档属性、不动选区。
 *   - 页码/DOI 只给“建议”，书籍/网页等类型不误报。
 *   - 重复判定顺序固定：canonical identity → DOI → 规范化标题+作者+年份（标疑似）。
 *   - 未知能力一律“未验证”，不自动转换、不宣称兼容。
 */
(function (root) {
  "use strict";

  const PREFLIGHT_KINDS = {
    UNCITED_ITEM: 1, DUPLICATE_IDENTITY: 1, DUPLICATE_DOI: 1,
    DUPLICATE_METADATA: 1, DUPLICATE_BIBLIOGRAPHY: 1, MISSING_PAGE: 1, MISSING_DOI: 1,
  };
  /* 只有这些类型“通常需要页码”。书籍（book）、网页（webpage）、学位论文（thesis）
   * 不要求页码，避免把正常条目误报成问题。 */
  const PAGE_TYPES = {
    journalArticle: 1, magazineArticle: 1, newspaperArticle: 1,
    conferencePaper: 1, bookSection: 1, report: 1, encyclopediaArticle: 1,
  };
  /* 只有这些类型“通常有 DOI”。书籍/网页/学位论文不提示缺 DOI。 */
  const DOI_TYPES = {
    journalArticle: 1, magazineArticle: 1, newspaperArticle: 1,
    conferencePaper: 1, bookSection: 1, report: 1, preprint: 1, encyclopediaArticle: 1,
  };
  const BIB_HEADINGS = /^(?:参考文献|參考文獻|引用文献|参考书目|參考書目|references?|bibliography|works\s+cited)\s*[:：]?$/i;
  const TARGET_LABEL = { word: "Word", wps: "WPS", libreoffice: "LibreOffice" };
  const VERDICT_LABEL = {
    direct: "可直接迁移", reconnect: "迁移后需重连",
    plainText: "建议纯文本副本", unverified: "未验证",
  };

  function normalized(text) {
    return String(text == null ? "" : text).normalize("NFKC").replace(/<[^>]+>/g, "").replace(/&(#x?[0-9a-fA-F]+|nbsp|amp|lt|gt|quot);/g, function (m, entity) {
      if (entity === "nbsp") return " ";
      const named = { amp: "&", lt: "<", gt: ">", quot: "\"" };
      if (named[entity]) return named[entity];
      const hex = entity.charAt(1) === "x" || entity.charAt(1) === "X";
      const value = parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return isFinite(value) ? String.fromCodePoint(value) : m;
    }).replace(/[\s\u00a0\u200b]+/g, "").replace(/[‐‑‒–—]/g, "-").trim();
  }
  function styleLabelOf(styleID) {
    const s = String(styleID || "").trim();
    if (!s) return "";
    if (/china-national-standard-gb-t-7714|gb-t-7714|gb\/t\s*7714/i.test(s)) return "GB/T 7714";
    if (/\/apa$|apa-|american-psychological/i.test(s)) return "APA";
    if (/nature/i.test(s)) return "Nature";
    if (/ieee/i.test(s)) return "IEEE";
    if (/chicago/i.test(s)) return "Chicago";
    return s.replace(/^https?:\/\/www\.zotero\.org\/styles\//i, "");
  }
  function normalizedKey(text) {
    return normalized(String(text == null ? "" : text).toLocaleLowerCase());
  }
  function issue(kind, severity, field, summary, reason, action, target) {
    return { kind: kind, severity: severity, fieldID: field && field.fieldID, noteIndex: field ? field.noteIndex : 0, summary: summary, reason: reason, action: action, target: target || (field ? { fieldID: field.fieldID, container: field.container, noteID: field.noteID } : null) };
  }

  /* ---------------- 依赖：可选加载，缺模块时退化为本地实现 ---------------- */
  function zfields() {
    if (root.PPZFields) return root.PPZFields;
    try { if (typeof require === "function") return require("./zfields.js"); } catch (e) { /* 浏览器里走全局 */ }
    return null;
  }
  function bibMapper() {
    if (root.PPBibliographyMap) return root.PPBibliographyMap;
    try { if (typeof require === "function") return require("./bibliography-map.js"); } catch (e) { return null; }
  }
  function canonicalIdentity(item) {
    const z = zfields();
    if (z && typeof z.canonicalIdentity === "function") return z.canonicalIdentity(item);
    const libType = item && (item.libraryType || item.libType) || "users";
    const libId = item && (item.libraryID != null ? item.libraryID : item.libId) || 1;
    return libType + ":" + String(libId) + ":" + String(item && (item.itemKey || item.key) || "").toUpperCase();
  }

  /* ---------------- 元数据访问（绝不猜：拿不到就跳过） ---------------- */
  function libraryLookup(library, key) {
    if (!library || !key) return null;
    try {
      if (typeof library.get === "function") {
        const value = library.get(key);
        if (value) return value;
      }
    } catch (e) { /* Map 兼容失败时继续按对象读 */ }
    if (typeof library === "object" && Object.prototype.hasOwnProperty.call(library, key)) return library[key];
    return null;
  }
  function creatorsOf(data) {
    if (!data) return [];
    const rows = data.creators || data.author || data.editor || data.contributor || [];
    return Array.isArray(rows) ? rows : [];
  }
  function authorOf(data) {
    const first = creatorsOf(data)[0] || {};
    return String(first.family || first.lastName || first.literal || first.name || first.firstName || "");
  }
  function yearOf(data) {
    const parts = data && data.issued && data.issued["date-parts"];
    const value = parts && parts[0] && parts[0][0];
    if (value != null && String(value)) return String(value).slice(0, 4);
    const match = /(1[5-9]\d\d|20\d\d|21\d\d)/.exec(String(data && (data.date || data.issued && data.issued.raw) || ""));
    return match ? match[1] : "";
  }
  function titleOf(data) {
    return String(data && (data.title || data.name || data.Case || "") || "").trim();
  }
  /* Zotero 原始条目用 itemType=journalArticle；citeproc 的 itemData 常用 CSL 类型
   * （article-journal / paper-conference / chapter）。两种都归一，避免页码/DOI
   * 建议因为类型对不上而漏报或误报。 */
  const CSL_TYPE = {
    "article-journal": "journalArticle", "article-magazine": "magazineArticle",
    "article-newspaper": "newspaperArticle", "paper-conference": "conferencePaper",
    chapter: "bookSection", "entry-encyclopedia": "encyclopediaArticle",
    book: "book", webpage: "webpage", thesis: "thesis", report: "report", preprint: "preprint",
    manuscript: "manuscript", "posted-content": "preprint",
  };
  function itemTypeOf(data) {
    const raw = String(data && (data.itemType || data.type) || "").trim();
    return CSL_TYPE[raw] || raw;
  }
  function doiOf(data) {
    return String(data && (data.DOI || data.doi) || "").trim();
  }
  function normalizeDoi(value) {
    return String(value || "").trim().toLocaleLowerCase()
      .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "").replace(/^doi:\s*/i, "");
  }
  function pagesOf(data) {
    return String(data && (data.pages || data.page || data.numberOfPages || "") || "").trim();
  }
  function itemMeta(item, library, fallbackTitle) {
    const key = String(item && (item.itemKey || item.key) || "").toUpperCase();
    const data = item && item.itemData && typeof item.itemData === "object"
      ? item.itemData : libraryLookup(library, key);
    const identity = canonicalIdentity(item || {});
    return {
      identity: identity, key: key,
      libraryType: item && (item.libraryType || item.libType) || "users",
      libraryID: item && (item.libraryID != null ? item.libraryID : item.libId) || 1,
      title: titleOf(data) || String(fallbackTitle || ""),
      author: authorOf(data), year: yearOf(data),
      itemType: itemTypeOf(data),
      doi: doiOf(data), pages: pagesOf(data),
      locator: String(item && item.locator || ""),
      hasData: !!data && typeof data === "object",
      data: data || null,
    };
  }

  /* ---------------- P0：六类体检（保持原有行为） ---------------- */
  function inspect(scan, context) {
    const c = context || {}, out = (scan.issues || []).slice(), library = c.library || c.items || null;
    const seen = new Map();
    scan.fields.forEach(function (f) {
      if (f.citationID) {
        if (seen.has(f.citationID)) out.push(issue("DUPLICATE_FIELD_ID", "error", f, "发现重复引文域身份", "citationID 与另一物理域重复", "保留一个域或重新插入重复引文"));
        else seen.set(f.citationID, f);
      }
      if (library) f.items.forEach(function (item) {
        if (c.libraryScope === "users" && item.libType === "groups") return;
        const key = item.key, exists = library instanceof Map ? library.has(key) : Object.prototype.hasOwnProperty.call(library, key);
        if (!exists) out.push(issue("MISSING_ITEM", "error", f, "Zotero 条目缺失", key + " 未在当前文献库中找到", "恢复条目或替换此引文", { item: item, fieldID: f.fieldID }));
      });
      if (f.formattedCitation && normalized(f.text) !== normalized(f.formattedCitation)) {
        out.push(issue("MANUAL_CITATION_EDIT", "warning", f, "引文显示疑似被手工修改", "域结果与 Zotero formattedCitation 规范化后不同", "确认保留手改或刷新恢复 Zotero 文本"));
      }
      if (typeof c.canLocate === "function") {
        let located = false;
        try { located = !!c.canLocate(f); } catch (e) { located = false; }
        if (!located) out.push(issue("UNREACHABLE_FIELD", "warning", f, "引文位置无法定位", "域范围失效或容器不可访问", "重新扫描；必要时在新位置重建引文"));
      }
    });
    if (!scan.bibliography.length) {
      out.push(issue("BIBLIOGRAPHY_MISSING", "info", null, "尚未插入文献表", "文档中没有 Zotero 文献表域", "需要时点击插入/更新文献表"));
    } else if (c.lastSuccess && c.fingerprint && c.lastSuccess.fingerprint !== c.fingerprint) {
      out.push(issue("BIBLIOGRAPHY_STALE", "warning", scan.bibliography[0], "文献表或引文尚未刷新", "当前域指纹与最近成功刷新不同", "执行一次 Zotero 刷新"));
    }
    if (c.zoteroConnected === false) out.push(issue("ZOTERO_OFFLINE", "info", null, "无法连接 Zotero，条目缺失检查未完成", "本地服务未连接", "启动 Zotero 后重新扫描"));
    return out;
  }

  /* ---------------- 上下文归一：兼容 preflight(scan, library) 与 preflight(scan, options) ---------------- */
  function contextOf(value) {
    if (!value || typeof value !== "object") return { library: null };
    const keys = ["library", "items", "bibliographyEntries", "styleID", "zoteroConnected", "docData", "target", "versions", "measured"];
    const looksLikeOptions = keys.some(function (k) { return Object.prototype.hasOwnProperty.call(value, k); });
    return looksLikeOptions ? Object.assign({}, value) : { library: value };
  }

  /* ---------------- 文献表：条目文本与 uncited 身份 ---------------- */
  function bibLineList(field) {
    const raw = String(field && field.text != null ? field.text : "");
    const hasText = !!field && Object.prototype.hasOwnProperty.call(field, "text") && field.text != null;
    const lines = raw.split(/\r\n|\r|\n/).map(function (s) { return s.trim(); })
      .filter(function (s) { return !!s && !BIB_HEADINGS.test(s); });
    return { readable: !!field && (hasText || !!field.range || !!field.field), raw: raw, lines: lines };
  }
  function uncitedIdentities(scan) {
    const z = zfields(), out = [], seen = new Set();
    (scan.bibliography || []).forEach(function (field) {
      const json = z && typeof z.extractJSON === "function" ? z.extractJSON(field.code) : null;
      const groups = json && Array.isArray(json.uncited) ? json.uncited : [];
      groups.forEach(function (group) {
        const list = Array.isArray(group) ? group : [group];
        list.forEach(function (id) {
          const parsed = z && typeof z.idToItem === "function" ? z.idToItem(id) : null;
          if (!parsed) return;
          const key = canonicalIdentity(parsed);
          if (seen.has(key)) return;
          seen.add(key);
          out.push(parsed);
        });
      });
    });
    return out;
  }
  function bibFieldOf(scan) {
    const rows = scan.bibliography || [];
    return rows.length ? rows[0] : null;
  }
  /** 面板批量取元数据用：正文/注文引用的条目 + 文献表 uncited 条目。 */
  function requiredItemKeys(scan) {
    const out = [], seen = new Set();
    function add(item) {
      const key = String(item && (item.itemKey || item.key) || "").toUpperCase();
      if (!key || seen.has(key)) return;
      seen.add(key);
      out.push(key);
    }
    ((scan && scan.fields) || []).forEach(function (field) {
      (field.items || []).forEach(add);
    });
    uncitedIdentities(scan || {}).forEach(add);
    return out;
  }

  /* ---------------- P2-1：投稿前检查 ---------------- */
  function preflight(scan, context) {
    const snapshot = scan || { documentID: "", fields: [], bibliography: [], issues: [] };
    const c = contextOf(context);
    const library = c.library || c.items || null;
    const styleID = String(c.styleID == null ? "" : c.styleID).trim();
    const styleLabel = styleLabelOf(styleID);
    const findings = [];
    const fields = (snapshot.fields || []).slice();
    const bibFields = (snapshot.bibliography || []).slice();
    const byContainer = { body: 0, footnote: 0, endnote: 0 };
    const unique = new Map();
    fields.forEach(function (field) {
      const container = field.container || "body";
      byContainer[container] = (byContainer[container] || 0) + 1;
      (field.items || []).forEach(function (item) {
        const key = canonicalIdentity(item);
        if (!unique.has(key)) unique.set(key, { item: item, field: field });
      });
    });

    (snapshot.issues || []).forEach(function (row) {
      findings.push({
        kind: row.kind || "ISSUE", severity: row.severity || "warning",
        summary: String(row.summary || ""), reason: String(row.reason || ""),
        action: String(row.action || ""), target: row.target || null,
      });
    });

    const badCitationFields = fields.filter(function (f) { return !!f.parseError; }).length;
    const badBibFields = bibFields.filter(function (f) { return !!f.parseError; }).length;
    if (badCitationFields) {
      findings.push({
        kind: "TRUNCATED_FIELD", severity: "error",
        summary: "有 " + badCitationFields + " 个引文域代码损坏或截断",
        reason: "域代码无法解析为完整 JSON，数量与重复检查可能不完整",
        action: "定位这些域并恢复（刷新或重新插入），不要依据本报告做删除",
        target: targetOf(fields.find(function (f) { return !!f.parseError; })),
      });
    }

    const bibInfo = bibFields.map(bibLineList);
    const bibReadable = bibInfo.some(function (x) { return x.readable; });
    const bibLines = [];
    bibInfo.forEach(function (x) { bibLines.push.apply(bibLines, x.lines); });
    const bibCount = bibReadable ? bibLines.length : null;
    const bibField = bibFieldOf(snapshot);

    if (!bibFields.length) {
      findings.push({
        kind: "BIBLIOGRAPHY_MISSING", severity: "info", summary: "尚未插入文献表",
        reason: "文档中没有 Zotero 文献表域，无法核对条目数", action: "投稿前用【插入/更新文献表】生成文献表",
        target: null,
      });
    } else if (!bibReadable) {
      findings.push({
        kind: "BIBLIOGRAPHY_TEXT_UNAVAILABLE", severity: "warning",
        summary: "文献表条目数无法读取", reason: "文献表域存在，但当前 WPS 没有返回可读的结果文本",
        action: "在 WPS 界面确认文献表可见后重新扫描；本条不是文档内容错误",
        target: targetOf(bibField),
      });
    } else if (!bibLines.length) {
      findings.push({
        kind: "BIBLIOGRAPHY_EMPTY", severity: "warning", summary: "文献表是空的",
        reason: "文献表域存在但没有任何条目文本", action: "刷新文献表；若本文档还没有引文，这是正常状态",
        target: targetOf(bibField),
      });
    }
    if (badBibFields) {
      findings.push({
        kind: "BIBLIOGRAPHY_TRUNCATED", severity: "error", summary: "文献表域代码损坏或截断",
        reason: "无法解析 uncited/omitted 数据，未引用条目统计不可信",
        action: "刷新文献表恢复域代码后再检查", target: targetOf(bibField),
      });
    }

    /* 未引用条目：以 Zotero BIBL 域代码的 uncited 数组为准，不靠文本猜。 */
    const citedKeys = new Set(Array.from(unique.keys()));
    const uncited = uncitedIdentities(snapshot).filter(function (item) {
      return !citedKeys.has(canonicalIdentity(item));
    }).map(function (item) {
      const meta = itemMeta(item, library, "");
      meta.uncited = true;
      return meta;
    });

    const expected = unique.size + uncited.length;
    const difference = bibCount == null ? null : bibCount - unique.size;
    if (bibCount != null && bibCount !== expected) {
      findings.push({
        kind: "COUNT_MISMATCH", severity: "warning",
        summary: "文献表条目数与正文引用不一致",
        reason: "文献表 " + bibCount + " 条；正文唯一 " + unique.size + " 条 + 未引用 "
          + uncited.length + " 条 = " + expected + " 条；差异 " + (bibCount - expected) + " 条",
        action: "先刷新文献表；仍不一致时逐条核对文献表与未引用条目，不要直接删除",
        target: targetOf(bibField),
      });
    }

    uncited.forEach(function (meta) {
      findings.push({
        kind: "UNCITED_ITEM", severity: "info",
        summary: "未引用条目：" + (meta.title || meta.key || "(无标题)"),
        reason: "该条目在文献表中，但正文没有任何引文" + (meta.author || meta.year ? "（" + meta.author + " " + meta.year + "）" : ""),
        action: "确认是否保留；学位论文的阅读书目可保留，否则在 Zotero 中移除或正文引用",
        target: bibField ? targetOf(bibField) : null, item: meta,
      });
    });

    /* 重复：identity → DOI → 规范化标题+作者+年份（疑似）。 */
    const duplicates = [];
    const exactGroups = [], lineIdentity = new Map();
    const exactBib = new Map();
    bibLines.forEach(function (line) {
      const key = normalizedKey(line);
      if (!key) return;
      exactBib.set(key, (exactBib.get(key) || 0) + 1);
    });
    exactBib.forEach(function (count, key) {
      if (count >= 2) exactGroups.push({ key: key, count: count });
    });
    /* 优先按 canonical identity：把每条书目文本与已引用条目做“标题+作者+年份齐全”的强匹配，
     * 只有唯一命中才算；歧义/缺元数据不猜。 */
    const strongCounts = new Map();
    bibLines.forEach(function (line) {
      const key = normalizedKey(line);
      if (!key) return;
      let hits = 0, matched = null;
      unique.forEach(function (row) {
        const meta = itemMeta(row.item, library, "");
        if (!meta.hasData) return;
        const title = normalizedKey(meta.title);
        if (!title || key.indexOf(title) < 0) return;
        if (meta.author && key.indexOf(normalizedKey(meta.author)) < 0) return;
        if (meta.year && key.indexOf(meta.year) < 0) return;
        hits++; matched = meta;
      });
      if (hits !== 1) return;
      strongCounts.set(matched.identity, (strongCounts.get(matched.identity) || 0) + 1);
      lineIdentity.set(key, matched.identity);
    });
    let mapped = null;
    try {
      const BM = bibMapper();
      if (BM && typeof BM.rebuild === "function" && bibLines.length) {
        mapped = BM.rebuild(snapshot, bibLines.map(function (text) { return { text: text }; }), { allowPersistent: false });
      }
    } catch (e) { mapped = null; }     // 单条书目无法映射时，不让整个投稿检查失败
    const bibIdentityCount = new Map(strongCounts);
    ((mapped && mapped.entries) || []).forEach(function (entry) {
      bibIdentityCount.set(entry.identity, Math.max(bibIdentityCount.get(entry.identity) || 0, 1));
    });
    bibIdentityCount.forEach(function (count, identity) {
      if (count < 2) return;
      const meta = itemMeta((unique.get(identity) || {}).item || { itemKey: String(identity).split(":").pop() }, library, "");
      duplicates.push({
        kind: "DUPLICATE_IDENTITY", suspected: false, count: count, items: [meta],
        summary: "文献表中有 " + count + " 条指向同一文献身份",
        reason: "canonical identity 相同：" + identity,
        action: "刷新文献表；仍重复时检查 Zotero 文献表域是否被复制",
      });
    });
    exactGroups.forEach(function (group) {
      const identity = lineIdentity.get(group.key);
      if (identity && (bibIdentityCount.get(identity) || 0) > 1) return;   // 已按身份报出
      duplicates.push({
        kind: "DUPLICATE_BIBLIOGRAPHY", suspected: false, count: group.count, items: [],
        summary: "文献表中有 " + group.count + " 条文本完全相同的条目",
        reason: "规范化后条目文本一致（" + group.key.slice(0, 60) + "）",
        action: "刷新文献表；仍重复时检查是否有两条相同文献被加入文献表",
      });
    });

    const doiGroups = new Map();
    unique.forEach(function (row) {
      const meta = itemMeta(row.item, library, "");
      if (!meta.hasData || !meta.doi) return;
      const key = normalizeDoi(meta.doi);
      if (!key) return;
      if (!doiGroups.has(key)) doiGroups.set(key, []);
      doiGroups.get(key).push(meta);
    });
    const doiCovered = new Set();
    doiGroups.forEach(function (group, doi) {
      if (group.length < 2) return;
      group.forEach(function (meta) { doiCovered.add(meta.identity); });
      duplicates.push({
        kind: "DUPLICATE_DOI", suspected: false, count: group.length, items: group,
        summary: "正文有 " + group.length + " 条不同条目使用同一个 DOI",
        reason: "DOI 相同：" + doi,
        action: "确认是否为同一条文献的重复记录；合并后刷新",
      });
    });

    const metaGroups = new Map();
    unique.forEach(function (row) {
      const meta = itemMeta(row.item, library, "");
      if (!meta.hasData) return;
      const title = normalizedKey(meta.title);
      if (!title || (!meta.author && !meta.year)) return;   // 标题单独不足以判重
      const key = [title, normalizedKey(meta.author), meta.year].join("|");
      if (!metaGroups.has(key)) metaGroups.set(key, []);
      metaGroups.get(key).push(meta);
    });
    metaGroups.forEach(function (group) {
      if (group.length < 2) return;
      const identities = new Set(group.map(function (x) { return x.identity; }));
      if (identities.size < 2) return;
      const sameDoi = group.every(function (x) { return x.doi && normalizeDoi(x.doi) === normalizeDoi(group[0].doi); });
      if (sameDoi) return;      // 已由 DOI 组报出，避免重复告警
      if (group.every(function (x) { return doiCovered.has(x.identity); })) return;
      duplicates.push({
        kind: "DUPLICATE_METADATA", suspected: true, count: group.length, items: group,
        summary: "疑似重复文献：" + (group[0].title || "（无标题）") + "（" + group.length + " 条）",
        reason: "规范化标题+第一作者+年份相同，但身份/DOI 不同；仅标疑似，不自动合并",
        action: "人工核对后再决定合并或保留",
      });
    });
    duplicates.forEach(function (row) {
      findings.push({
        kind: row.kind, severity: row.kind === "DUPLICATE_METADATA" ? "info" : "warning",
        summary: row.summary, reason: row.reason, action: row.action,
        target: targetOf(unique.get(row.items[0] && row.items[0].identity) ? unique.get(row.items[0].identity).field : null),
        items: row.items, suspected: !!row.suspected,
      });
    });

    /* 页码/DOI：按文献类型给“建议”，书籍/网页不误报；拿不到元数据就跳过。 */
    const suggestions = [];
    unique.forEach(function (row) {
      const meta = itemMeta(row.item, library, "");
      if (!meta.hasData || !meta.itemType) return;
      const target = targetOf(row.field, meta);
      const styleHint = styleLabel ? "；当前样式 " + styleLabel + " 的建议为提示级，不按错误处理" : "";
      if (PAGE_TYPES[meta.itemType] && !meta.pages) {
        suggestions.push(suggestion("MISSING_PAGE", "建议补充页码", meta,
          "文献类型 " + meta.itemType + " 通常需要页码（pages）" + styleHint, "在 Zotero 条目中补充页码后刷新；若该文献确实没有页码可忽略", target));
      }
      if (DOI_TYPES[meta.itemType] && !meta.doi) {
        suggestions.push(suggestion("MISSING_DOI", "建议补充 DOI", meta,
          "文献类型 " + meta.itemType + " 通常可提供 DOI" + styleHint, "在 Zotero 条目中补充 DOI 后刷新；若确实没有 DOI 可忽略", target));
      }
    });
    suggestions.forEach(function (row) { findings.push(row); });

    let unresolvedBibEntries = 0;
    if (mapped) {
      /* 文献表映射歧义属于 P0-3 的跳转身份问题，不在这里升级成投稿错误；
       * 只在 integrity 里保留计数，供需要时排查。 */
      unresolvedBibEntries = Number(mapped.unresolved) || 0;
    }

    if (c.zoteroConnected === false) {
      findings.push({
        kind: "ZOTERO_OFFLINE", severity: "info", summary: "未连接 Zotero，元数据建议可能不完整",
        reason: "本地服务未连接，页码/DOI 只能基于域内已有 itemData 判断",
        action: "启动 Zotero 后重新检查；本报告未修改文档", target: null,
      });
    }

    findings.sort(function (a, b) { return severityRank(a.severity) - severityRank(b.severity); });
    const counts = {
      citationFields: fields.length,
      bodyCitations: byContainer.body || 0,
      footnoteCitations: byContainer.footnote || 0,
      endnoteCitations: byContainer.endnote || 0,
      uniqueItems: unique.size,
      bibliographyFields: bibFields.length,
      bibliographyEntries: bibCount,
      uncitedItems: uncited.length,
      expectedEntries: expected,
      difference: difference,
      badFields: badCitationFields + badBibFields,
      unresolvedBibliographyEntries: unresolvedBibEntries,
    };
    return {
      ok: true, readOnly: true, kind: "preflight", documentID: String(snapshot.documentID || ""),
      generatedAt: new Date().toISOString(),
      styleID: styleID, styleLabel: styleLabel,
      counts: counts, summary: summarize(findings),
      /* 常用计数的顶层别名：面板/导出/测试不必记嵌套结构。 */
      citationCount: counts.citationFields, bodyCitationCount: counts.bodyCitations,
      footnoteCitationCount: counts.footnoteCitations, endnoteCitationCount: counts.endnoteCitations,
      uniqueItemCount: counts.uniqueItems, bibliographyEntryCount: counts.bibliographyEntries,
      difference: counts.difference, uncitedCount: counts.uncitedItems,
      uncited: uncited, duplicates: duplicates, suggestions: suggestions,
      findings: findings, issues: findings, integrity: integrityOf(snapshot, c, bibReadable),
    };
  }

  function suggestion(kind, summary, meta, reason, action, target) {
    return {
      kind: kind, severity: "info", summary: summary + "：" + (meta.title || meta.key || "(无标题)"),
      reason: reason + (meta.author || meta.year ? "（" + meta.author + " " + meta.year + "）" : ""),
      action: action, target: target || null, item: meta,
    };
  }
  function targetOf(field, meta) {
    if (!field) return meta ? { identity: meta.identity, itemKey: meta.key } : null;
    const target = { fieldID: field.fieldID, container: field.container || "body", noteID: field.noteID || null, noteIndex: Number(field.noteIndex) || 0 };
    if (field.kind === "bibl") target.bibliography = true;
    if (meta) { target.identity = meta.identity; target.itemKey = meta.key; }
    return target;
  }
  function severityRank(severity) { return severity === "error" ? 0 : severity === "warning" ? 1 : 2; }
  function summarize(findings) {
    return {
      errors: findings.filter(function (x) { return x.severity === "error"; }).length,
      warnings: findings.filter(function (x) { return x.severity === "warning"; }).length,
      info: findings.filter(function (x) { return x.severity === "info"; }).length,
    };
  }
  function integrityOf(snapshot, context, bibReadable) {
    return {
      fieldsParsed: (snapshot.fields || []).filter(function (f) { return !f.parseError; }).length,
      bibliography: !(snapshot.bibliography || []).length ? "missing" : bibReadable ? "readable" : "unreadable",
      zoteroConnected: context.zoteroConnected !== false,
      styleID: context.styleID == null ? "" : String(context.styleID),
      readOnly: true,
    };
  }

  /* ---------------- P2-3：迁移兼容检查 ---------------- */
  function normalizeTarget(value) {
    const s = String(value == null ? "" : value).trim().toLocaleLowerCase();
    if (/^(word|docx|msword|microsoft\s*word)$/.test(s)) return "word";
    if (/^(wps|kingsoft|wps\s*office)$/.test(s)) return "wps";
    if (/^(libreoffice|libre\s*office|lo|odt|openoffice)$/.test(s)) return "libreoffice";
    return "";
  }
  function dialectOf(code) {
    const s = String(code || "");
    if (!s) return "none";
    if (/ADDIN\s+ZOTERO_(?:ITEM|BIBL)\b/i.test(s)) return "word";
    if (/(?:^|\s)(?:ITEM|BIBL)\s+CSL_(?:CITATION|BIBLIOGRAPHY)\b/i.test(s)
      || /(?:^|\s)(?:ITEM|BIBL)\s+\{/i.test(s)
      || /^(?:ITEM|BIBL)\b/i.test(s)) return "internal";
    if (/(?:ZOTERO_ITEM|ZOTERO_BIBL|CSL_CITATION|CSL_BIBLIOGRAPHY)/i.test(s)) return "unknown";
    return "other";
  }
  function docDataStateOf(raw) {
    if (raw === undefined || raw === null) return "unknown";   // 没提供 ≠ 文档里没有
    const s = String(raw).trim();
    if (!s) return "missing";
    let data = null;
    try { data = JSON.parse(s); } catch (e) { return "invalid"; }
    if (!data || typeof data !== "object" || Array.isArray(data)) return "invalid";
    if (!data.style || typeof data.style !== "object" || !String(data.style.styleID || "").trim()) return "legacy";
    return "valid";
  }
  function compatibility(scan, capabilities, target, context) {
    const snapshot = scan || { documentID: "", fields: [], bibliography: [], issues: [] };
    let opts = context || {};
    let targetValue = target;
    if (target && typeof target === "object") { opts = Object.assign({}, context || {}, target); targetValue = target.target; }
    const c = Object.assign({}, opts);
    const destination = normalizeTarget(targetValue == null ? c.target : targetValue);
    const caps = capabilities && typeof capabilities === "object" ? capabilities : null;
    const fields = (snapshot.fields || []).slice();
    const bibFields = (snapshot.bibliography || []).slice();
    const notes = fields.filter(function (f) { return f.container === "footnote" || f.container === "endnote"; });
    const footnotes = notes.filter(function (f) { return f.container === "footnote"; }).length;
    const endnotes = notes.filter(function (f) { return f.container === "endnote"; }).length;
    const badFields = fields.concat(bibFields).filter(function (f) { return !!f.parseError; }).length;
    const docDataRaw = c.docData !== undefined ? c.docData : snapshot.docData;
    const docDataState = docDataStateOf(docDataRaw);
    const dialects = { word: 0, internal: 0, generic: 0, unknown: 0, other: 0, none: 0 };
    fields.concat(bibFields).forEach(function (f) { dialects[dialectOf(f.code)] = (dialects[dialectOf(f.code)] || 0) + 1; });
    let dialect = "none";
    if (dialects.word) dialect = "word";
    else if (dialects.internal) dialect = "internal";
    else if (dialects.generic) dialect = "generic";
    else if (dialects.unknown) dialect = "unknown";
    else if (dialects.other) dialect = "other";
    const bibReadable = bibFields.some(function (f) { return !!String(f.text || "").trim(); });
    const measured = c.measured === true;
    const evidence = [];

    evidence.push({
      kind: "fields", status: fields.length || bibFields.length ? "ok" : "info",
      summary: "引文域 " + fields.length + " 个，文献表域 " + bibFields.length + " 个",
      detail: { citationFields: fields.length, bibliographyFields: bibFields.length },
    });
    evidence.push({
      kind: "dialect", status: dialect === "word" ? "ok" : dialect === "none" ? "info" : dialect === "internal" ? "warning" : dialect === "generic" ? "warning" : "risk",
      summary: dialect === "word" ? "域方言：Word 标准 ADDIN 域"
        : dialect === "internal" ? "域方言：Zotero 内部 ITEM/BIBL 方言（需重连为 Word 域）"
          : dialect === "generic" ? "域方言：通用 CSL 域（缺少 ADDIN ZOTERO_ 前缀）"
            : dialect === "unknown" ? "域方言：含 Zotero/CSL 关键字但前缀不完整"
              : dialect === "none" ? "文档中没有 Zotero 引文域" : "域方言：非 Zotero 域",
      detail: dialects,
    });
    evidence.push({
      kind: "docData", status: docDataState === "valid" ? "ok" : docDataState === "legacy" ? "warning" : docDataState === "unknown" ? "unknown" : "risk",
      summary: docDataState === "valid" ? "Zotero 文档数据完整"
        : docDataState === "legacy" ? "Zotero 文档数据为旧格式（缺少样式信息）"
          : docDataState === "unknown" ? "未读取 Zotero 文档数据，文档数据完整性未验证"
            : docDataState === "missing" ? "缺少 Zotero 文档数据，迁移后无法重连"
              : "Zotero 文档数据损坏，无法重连",
      detail: { state: docDataState, length: docDataRaw == null ? null : String(docDataRaw).length },
    });
    evidence.push({
      kind: "notes", status: notes.length ? ((footnotes && caps && !caps.footnotes) || (endnotes && caps && !caps.endnotes) ? "risk" : dialect === "word" ? "ok" : "warning") : "ok",
      summary: notes.length ? "注文引文 " + notes.length + " 条（脚注 " + footnotes + "、尾注 " + endnotes + "）" : "没有注文引文",
      detail: { footnotes: footnotes, endnotes: endnotes },
    });
    evidence.push({
      kind: "bibliography", status: !bibFields.length ? "warning" : bibReadable ? "ok" : "warning",
      summary: !bibFields.length ? "没有文献表域，迁移后需重建文献表"
        : bibReadable ? "文献表域有可读条目文本" : "文献表域存在但没有可读文本，书目锚点无法验证",
      detail: { fields: bibFields.length, readable: bibReadable },
    });
    evidence.push({
      kind: "truncation", status: badFields ? "risk" : "ok",
      summary: badFields ? "有 " + badFields + " 个域代码损坏/截断，无法可靠重连" : "未发现截断或坏域",
      detail: { badFields: badFields },
    });
    if (caps) {
      evidence.push({
        kind: "capabilities", status: caps.bodyFields === false ? "risk" : "ok",
        summary: "能力探测：正文域=" + (caps.bodyFields ? "可用" : "不可用")
          + "，脚注=" + (caps.footnotes ? "可用" : "不可用") + "，尾注=" + (caps.endnotes ? "可用" : "不可用")
          + "，书签=" + (caps.bookmarks ? "可用" : "不可用"),
        detail: {
          bodyFields: !!caps.bodyFields, footnotes: !!caps.footnotes, endnotes: !!caps.endnotes,
          footnoteAdd: !!caps.footnoteAdd, endnoteAdd: !!caps.endnoteAdd,
          bookmarks: !!caps.bookmarks, noteConvert: !!caps.noteConvert,
        },
      });
    } else {
      evidence.push({
        kind: "capabilities", status: "unknown",
        summary: destination === "wps" ? "未获得当前 WPS 能力矩阵，按未验证处理" : "未提供能力矩阵",
        detail: null,
      });
    }

    let verdict = "direct";
    let reason = "";
    if (!fields.length && !bibFields.length) {
      verdict = "direct"; reason = "文档中没有 Zotero 引文/文献表域，无需迁移域";
    } else if (badFields > 0) {
      verdict = "plainText"; reason = "域代码已截断/损坏，任何编辑器都无法可靠重连";
    } else if (docDataState === "invalid" || docDataState === "missing") {
      verdict = "plainText"; reason = "缺少可用的 Zotero 文档数据，迁移后无法重连";
    } else if (docDataState === "unknown") {
      verdict = "unverified"; reason = "未提供 Zotero 文档数据，无法判断能否重连";
    } else if (!destination) {
      verdict = "unverified"; reason = "未指定或无法识别的目标编辑器";
    } else if (destination === "wps") {
      if (!caps) { verdict = "unverified"; reason = "未探测目标 WPS 的域/注文能力"; }
      else if (caps.bodyFields !== true) { verdict = "unverified"; reason = "当前宿主无法枚举正文域，无法证明迁移后可刷新"; }
      else if (dialect === "internal" || dialect === "generic" || dialect === "unknown" || dialect === "other") {
        verdict = "reconnect"; reason = "域方言不是标准 Word ADDIN 域，迁移后需要 Zotero 重连";
      }       else if (docDataState === "legacy") { verdict = "reconnect"; reason = "文档数据为旧格式，需要 Zotero 重新建立文档会话"; }
      else if ((footnotes > 0 && !caps.footnotes) || (endnotes > 0 && !caps.endnotes)) {
        verdict = "reconnect"; reason = "当前 WPS 缺少本次用到的注文集合（脚注/尾注），迁移后需重连验证";
      } else { verdict = "direct"; reason = "标准 Word ADDIN 域 + 完整文档数据 + 当前 WPS 域能力可用"; }
    } else if (destination === "word") {
      if (dialect === "word") { verdict = docDataState === "legacy" ? "reconnect" : "direct"; reason = dialect === "word" && docDataState === "valid" ? "Word 原生 ADDIN 域与完整文档数据" : "文档数据为旧格式，需重连"; }
      else { verdict = "reconnect"; reason = "域方言非标准 Word ADDIN 域，需 Zotero 重连规范化"; }
    } else if (destination === "libreoffice") {
      verdict = "reconnect"; reason = "LibreOffice 需要 Zotero 自身重连（本机未实测，结论仅为建议）";
    }

    return {
      ok: true, readOnly: true, kind: "compatibility", documentID: String(snapshot.documentID || ""),
      generatedAt: new Date().toISOString(), target: destination,
      targetLabel: TARGET_LABEL[destination] || String(targetValue || "未知"),
      verdict: verdict, verdictLabel: VERDICT_LABEL[verdict] || verdict,
      reason: reason, measured: measured, evidence: evidence,
      capabilities: caps ? {
        bodyFields: !!caps.bodyFields, footnotes: !!caps.footnotes, endnotes: !!caps.endnotes,
        footnoteAdd: !!caps.footnoteAdd, endnoteAdd: !!caps.endnoteAdd,
        bookmarks: !!caps.bookmarks, noteConvert: !!caps.noteConvert,
      } : null,
      versions: c.versions || {}, counts: {
        citationFields: fields.length, bibliographyFields: bibFields.length,
        footnoteCitations: footnotes, endnoteCitations: endnotes, badFields: badFields,
      },
      note: "只读检查，未自动转换、未保存文档。" + (measured ? "" : " 目标编辑器未实测，结论为规则建议而非兼容认证。"),
    };
  }

  /* 投稿方案只过滤建议级规则；坏域、数量不一致等完整性问题永远保留。 */
  function applyProfile(report, profile) {
    if (!profile) return report;
    const p = profile || {}, out = Object.assign({}, report);
    const allowed = function (row) {
      const kind = String(row && row.kind || "");
      if (kind === "MISSING_DOI") return p.requireDOI !== false;
      if (kind === "MISSING_PAGE") return p.requirePages !== false;
      if (kind === "UNCITED_ITEM") return p.checkUncited !== false;
      return true;
    };
    out.findings = (report.findings || []).filter(allowed);
    out.issues = out.findings;
    out.suggestions = (report.suggestions || []).filter(allowed);
    out.duplicates = (report.duplicates || []).filter(allowed);
    out.uncited = p.checkUncited === false ? [] : (report.uncited || []);
    out.uncitedCount = out.uncited.length;
    out.profile = { id: String(p.id || ""), name: String(p.name || "自定义方案"), styleID: String(p.styleID || ""),
      requireDOI: p.requireDOI !== false, requirePages: p.requirePages !== false, checkUncited: p.checkUncited !== false };
    if (p.styleID && String(report.styleID || "") !== String(p.styleID)) {
      out.findings.unshift({ kind: "STYLE_MISMATCH", severity: "warning", summary: "当前样式与投稿方案不一致",
        reason: "方案要求 " + p.styleID + "，当前为 " + (report.styleID || "未读取"),
        action: "应用方案时切换样式，或在文档首选项中手动调整", target: null });
      out.issues = out.findings;
    }
    out.summary = summarize(out.findings);
    return out;
  }

  /* ---------------- 纯文本导出：报告可导出、可复现 ---------------- */
  function preflightText(report) {
    const r = report || {}, n = r.counts || {};
    const lines = [
      "Papilot Cite 投稿前检查（只读）",
      "文档：" + (r.documentID || "(未知)"),
      "时间：" + (r.generatedAt || ""),
      r.styleLabel ? "当前样式：" + r.styleLabel : "当前样式：未读取",
      r.profile && r.profile.name ? "投稿方案：" + r.profile.name : "投稿方案：通用检查",
      "",
      "一、计数",
      "- 引文域合计：" + valueOrUnknown(n.citationFields),
      "- 正文引文域：" + valueOrUnknown(n.bodyCitations) + "；脚注：" + valueOrUnknown(n.footnoteCitations) + "；尾注：" + valueOrUnknown(n.endnoteCitations),
      "- 唯一文献：" + valueOrUnknown(n.uniqueItems),
      "- 文献表域：" + valueOrUnknown(n.bibliographyFields) + "；文献表条目：" + valueOrUnknown(n.bibliographyEntries),
      "- 差异（文献表条目 - 唯一文献）：" + valueOrUnknown(n.difference),
      "- 未引用条目：" + valueOrUnknown(n.uncitedItems) + "；坏域：" + valueOrUnknown(n.badFields),
      "",
      "二、未引用条目（uncited）",
    ];
    if ((r.uncited || []).length) {
      (r.uncited || []).forEach(function (item, i) {
        lines.push((i + 1) + ". " + (item.title || "(无标题)") + " · " + (item.author || "未知作者") + " · " + (item.year || "年份未知") + " · " + item.identity);
      });
    } else lines.push("（无）");
    lines.push("", "三、重复文献");
    if ((r.duplicates || []).length) {
      (r.duplicates || []).forEach(function (row, i) {
        lines.push((i + 1) + ". [" + (row.suspected ? "疑似" : "确认") + "] " + row.summary);
        lines.push("   " + row.reason);
        lines.push("   建议：" + row.action);
      });
    } else lines.push("（未发现）");
    lines.push("", "四、页码 / DOI 建议（按文献类型，书籍与网页不提示）");
    if ((r.suggestions || []).length) {
      (r.suggestions || []).forEach(function (row, i) {
        lines.push((i + 1) + ". [建议] " + row.summary + " — " + row.reason);
      });
    } else lines.push("（无）");
    lines.push("", "五、其他检查项");
    const others = (r.findings || []).filter(function (x) { return !PREFLIGHT_KINDS[x.kind]; });
    if (others.length) {
      others.forEach(function (row, i) {
        lines.push((i + 1) + ". [" + String(row.severity || "info") + "] " + row.summary + "\n   " + row.reason + "\n   " + row.action);
      });
    } else lines.push("（无）");
    lines.push("", "说明：本报告只读，不修改文档、域或文献表。页码/DOI 为建议级，不应当作错误批量删除。");
    return lines.join("\n");
  }
  function compatibilityText(report) {
    const r = report || {};
    const lines = [
      "Papilot Cite 迁移兼容检查（只读）",
      "文档：" + (r.documentID || "(未知)"),
      "目标编辑器：" + (r.targetLabel || r.target || "未知"),
      "结论：" + (r.verdictLabel || r.verdict || "未验证"),
      "依据：" + (r.reason || ""),
      "实测：" + (r.measured ? "是" : "否（未知能力保持未验证）"),
      "",
      "证据：",
    ];
    (r.evidence || []).forEach(function (row, i) {
      lines.push((i + 1) + ". [" + row.status + "] " + row.summary);
    });
    if (r.capabilities) {
      const c = r.capabilities;
      lines.push("", "能力探测：正文域=" + c.bodyFields + "，脚注=" + c.footnotes + "，尾注=" + c.endnotes
        + "，脚注新增=" + c.footnoteAdd + "，尾注新增=" + c.endnoteAdd + "，书签=" + c.bookmarks + "，注文转换=" + c.noteConvert);
    }
    if (r.versions && Object.keys(r.versions).length) {
      lines.push("", "版本：" + Object.keys(r.versions).map(function (k) { return k + "=" + (r.versions[k] || "未知"); }).join("；"));
    }
    lines.push("", r.note || "只读检查，未自动转换、未保存。");
    return lines.join("\n");
  }
  function valueOrUnknown(value) { return value == null ? "无法读取" : String(value); }

  const api = {
    inspect: inspect, normalize: normalized,
    preflight: preflight, compatibility: compatibility, applyProfile: applyProfile,
    preflightText: preflightText, compatibilityText: compatibilityText,
    requiredItemKeys: requiredItemKeys,
    reportText: function (report) {
      if (!report || report.kind === "compatibility") return compatibilityText(report);
      return preflightText(report);
    },
    VERDICT_LABEL: VERDICT_LABEL, TARGET_LABEL: TARGET_LABEL,
    PAGE_TYPES: PAGE_TYPES, DOI_TYPES: DOI_TYPES,
  };
  root.PPHealth = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
