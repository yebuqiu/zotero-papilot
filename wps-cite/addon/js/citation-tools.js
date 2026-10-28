// SPDX-License-Identifier: Apache-2.0
/* 引文重连、定位与分章文献表的纯函数。所有写 WPS 的操作留在 app.js。 */
(function (root) {
  "use strict";
  function zfields() {
    if (root.PPZFields) return root.PPZFields;
    if (typeof require === "function") return require("./zfields.js");
    throw new Error("zfields.js 未加载");
  }
  function rewriteJSON(code, mutate) {
    const src = String(code || ""), start = src.indexOf("{"), end = src.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("引文域缺少完整 JSON，已禁止修改");
    let data;
    try { data = JSON.parse(src.slice(start, end + 1)); }
    catch (e) { throw new Error("引文域 JSON 损坏，已禁止猜测修复"); }
    if (!data || !Array.isArray(data.citationItems)) throw new Error("目标不是可编辑的 Zotero 引文域");
    mutate(data);
    return src.slice(0, start) + JSON.stringify(data) + src.slice(end + 1);
  }
  function identityOfCitationItem(ci) {
    const item = zfields().idToItem(ci && ci.id);
    return item ? zfields().canonicalIdentity(item) : "";
  }
  function findOne(data, identity) {
    const rows = (data.citationItems || []).filter(function (ci) { return identityOfCitationItem(ci) === identity; });
    if (rows.length !== 1) throw new Error(rows.length ? "目标条目在引文中有歧义，已禁止修改" : "目标条目已变化，请重新扫描");
    return rows[0];
  }
  function candidateURI(candidate, oldCI) {
    const c = candidate || {}, key = String(c.key || "").toUpperCase();
    if (!/^[A-Z0-9]{8}$/.test(key)) throw new Error("替代条目的 key 无效");
    if (c.uri) {
      const parsed = zfields().idToItem(c.uri);
      if (!parsed || parsed.key !== key) throw new Error("替代条目的 URI 与 key 不一致");
      return String(c.uri);
    }
    const old = String(oldCI && oldCI.id || "");
    const match = /^(https?:\/\/zotero\.org\/(?:users|groups)\/(?:\d+|local)(?:\/[^/]+)?)\/items\/[A-Z0-9]{8}$/.exec(old);
    if (!match) throw new Error("无法从原引文确定 Zotero 库地址，请提供完整条目 URI");
    const oldItem = zfields().idToItem(old), newType = c.libType || "users", newLib = c.libId == null ? oldItem.libId : c.libId;
    if (oldItem.libType !== newType || String(oldItem.libId) !== String(newLib)) {
      if (newType === "groups") return "https://zotero.org/groups/" + Number(newLib) + "/items/" + key;
      throw new Error("跨个人库重连需要替代条目的完整 URI，已禁止猜测库地址");
    }
    return match[1] + "/items/" + key;
  }
  function cslData(data) {
    const out = Object.assign({}, data || {});
    if (!Array.isArray(out.author) && Array.isArray(out.creators)) {
      out.author = out.creators.map(function (creator) {
        return { family: creator.family || creator.lastName || "", given: creator.given || creator.firstName || "",
          literal: creator.literal || creator.name || undefined };
      });
    }
    if (!out.type && out.itemType) {
      const types = { journalArticle: "article-journal", magazineArticle: "article-magazine", newspaperArticle: "article-newspaper",
        conferencePaper: "paper-conference", bookSection: "chapter", encyclopediaArticle: "entry-encyclopedia",
        book: "book", webpage: "webpage", thesis: "thesis", report: "report", preprint: "posted-content" };
      out.type = types[out.itemType] || out.itemType;
    }
    if (!out.issued && out.date) {
      const match = /(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?/.exec(String(out.date));
      if (match) { const parts = [Number(match[1])]; if (match[2]) parts.push(Number(match[2])); if (match[2] && match[3]) parts.push(Number(match[3])); out.issued = { "date-parts": [parts] }; }
    }
    return out;
  }
  function reconnect(code, identity, candidate) {
    let citationID = "", uri = "";
    const next = rewriteJSON(code, function (data) {
      citationID = String(data.citationID || "");
      const ci = findOne(data, identity);
      uri = candidateURI(candidate, ci);
      ci.id = uri;
      if (candidate && candidate.data && typeof candidate.data === "object") ci.itemData = cslData(candidate.data);
    });
    return { code: next, citationID: citationID, uri: uri };
  }
  function updateLocator(code, identity, location) {
    const value = location || {}, locator = String(value.locator || "").trim().slice(0, 80);
    const next = rewriteJSON(code, function (data) {
      const ci = findOne(data, identity);
      if (locator) ci.locator = locator; else delete ci.locator;
      const label = String(value.label || "").trim();
      if (label) ci.label = label; else if (!locator) delete ci.label;
    });
    return { code: next, locator: locator };
  }
  function isHeading(row) {
    const level = Number(row && row.outlineLevel);
    const style = String(row && row.style || "");
    return level === 1 || /^(?:heading\s*1|标题\s*1|标题 1)$/i.test(style);
  }
  function chapters(paragraphs, fields, stopAt) {
    const headings = (paragraphs || []).filter(isHeading).sort(function (a, b) { return a.start - b.start; });
    if (headings.length < 2) throw new Error("至少需要两个“标题 1”章节才能生成独立分章文献表");
    (fields || []).forEach(function (field) {
      if ((field.container || "body") !== "body") throw new Error("含脚注/尾注引文的文档暂不支持自动分章，未写入任何内容");
    });
    const lastStop = Number(stopAt) >= 0 ? Number(stopAt) : Number.MAX_SAFE_INTEGER;
    return headings.map(function (heading, index) {
      const end = Math.min(index + 1 < headings.length ? headings[index + 1].start : lastStop, lastStop);
      const own = (fields || []).filter(function (field) { return field.start >= heading.start && field.start < end; });
      return { index: index + 1, title: String(heading.text || "第 " + (index + 1) + " 章").trim(), start: heading.start, end: end, fields: own };
    }).filter(function (chapter) { return chapter.fields.length > 0; });
  }
  function bibliographyLines(field) {
    return String(field && field.text || "").split(/\r\n|\r|\n/).map(function (s) { return s.trim(); })
      .filter(function (s) { return !!s && !/^(?:参考文献|references?|bibliography)$/i.test(s); });
  }
  function plan(scan, paragraphs, options) {
    const opts = options || {}, bib = (scan.bibliography || [])[0];
    if (!bib) throw new Error("请先用【插入/更新文献表】生成总文献表并刷新");
    const lines = bibliographyLines(bib);
    if (!lines.length) throw new Error("总文献表没有可读取的条目，未写入分章内容");
    const groups = chapters(paragraphs, scan.fields, bib.start);
    if (groups.length < 2) throw new Error("至少两个章节含有正文引文时才需要分章文献表");
    const mapped = root.PPBibliographyMap.rebuild(scan, lines, {
      previous: opts.previous || {}, citationOrderNumeric: /numeric|ieee|nature|vancouver|gb-t-7714/i.test(String(opts.styleID || "")),
    });
    const byIdentity = new Map(mapped.entries.map(function (entry) { return [entry.identity, entry]; }));
    const missing = new Set();
    groups.forEach(function (group) {
      const entries = [], seen = new Set();
      group.fields.forEach(function (field) { field.items.forEach(function (item) {
        const identity = zfields().canonicalIdentity(item);
        if (seen.has(identity)) return;
        seen.add(identity);
        const entry = byIdentity.get(identity);
        if (!entry) missing.add(identity); else entries.push(entry);
      }); });
      group.entries = entries;
      group.text = "\r参考文献（" + group.title + " · Papilot 静态快照）\r" + entries.map(function (entry) { return entry.text; }).join("\r") + "\r";
    });
    if (missing.size) throw new Error("有 " + missing.size + " 篇引文无法与总文献表唯一对应，已禁止生成不完整分章文献表");
    return groups;
  }
  const api = { rewriteJSON: rewriteJSON, reconnect: reconnect, updateLocator: updateLocator, cslData: cslData,
    chapters: chapters, plan: plan, bibliographyLines: bibliographyLines, candidateURI: candidateURI };
  root.PPCitationTools = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
