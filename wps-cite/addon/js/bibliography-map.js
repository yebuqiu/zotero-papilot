// SPDX-License-Identifier: Apache-2.0
/* 文献表身份映射：只接受可验证 ID 或唯一完整元数据；歧义绝不建链接。 */
(function (root) {
  "use strict";
  function zf() { return root.PPZFields || require("./zfields.js"); }
  function norm(s) { return String(s || "").normalize("NFKC").toLowerCase().replace(/[\s\u00a0"'‘’“”.,;:!?()\[\]{}<>《》〈〉，。；：！？、·\-–—_/\\]+/g, ""); }
  function metadata(item) {
    const data = item.itemData || item.data || item;
    const creators = data && (data.author || data.creators) || [];
    const author = creators[0] && (creators[0].family || creators[0].lastName || creators[0].literal || creators[0].name);
    const issued = data && data.issued;
    const year = issued && issued["date-parts"] && issued["date-parts"][0] && issued["date-parts"][0][0] || data && data.date;
    return norm([data && data.title, author, year, data && data.DOI].filter(Boolean).join(" "));
  }
  function completeMetadataMatch(item, hay) {
    const data = item.itemData || item.data || item;
    const title = norm(data && data.title);
    if (!title || hay.indexOf(title) < 0) return false;
    const creators = data && (data.author || data.creators) || [];
    const author = norm(creators[0] && (creators[0].family || creators[0].lastName || creators[0].literal || creators[0].name));
    const issued = data && data.issued;
    const year = norm(issued && issued["date-parts"] && issued["date-parts"][0] && issued["date-parts"][0][0] || data && data.date);
    // 至少一个消歧元数据，并且所有已知核心字段都能在完整条目里验证。
    if (!author && !year && !norm(data && data.DOI)) return false;
    return (!author || hay.indexOf(author) >= 0) && (!year || hay.indexOf(year) >= 0) && (!norm(data && data.DOI) || hay.indexOf(norm(data.DOI)) >= 0);
  }
  function identityFromEntry(entry) {
    if (!entry) return null;
    return zf().idToItem(entry.id || entry.itemID || entry.uri || entry.itemUri || "") || zf().normalizeIdentity(entry.item || entry.identity || entry);
  }
  function rebuild(scan, citeprocEntries, options) {
    const opts = options || {};
    const items = [];
    const seen = new Set();
    scan.fields.forEach(function (f) { f.items.forEach(function (item) {
      const normalized = zf().normalizeIdentity(item), key = zf().canonicalIdentity(normalized);
      if (!seen.has(key)) { seen.add(key); items.push(Object.assign({}, normalized, { itemData: item.itemData || {} })); }
    }); });
    const previous = opts.previous || {};
    const used = new Set(), mappings = {}, persistent = {}, issues = [], entries = [];
    (citeprocEntries || []).forEach(function (entry, index) {
      const text = String(entry && entry.text != null ? entry.text : entry || "");
      let candidates = [];
      const direct = identityFromEntry(entry);
      if (direct) {
        const canonical = zf().canonicalIdentity(direct);
        candidates = items.filter(function (item) { return zf().canonicalIdentity(item) === canonical; });
      }
      if (!candidates.length) {
        const hay = norm(text);
        candidates = items.filter(function (item) {
          const full = metadata(item), title = norm(item.itemData && item.itemData.title);
          return full && hay.indexOf(full) >= 0 || title && hay.indexOf(title) >= 0;
        });
      }
      if (candidates.length > 1) {
        const complete = candidates.filter(function (item) { return completeMetadataMatch(item, hay); });
        if (complete.length === 1) candidates = complete;
      }
      if (!candidates.length && previous && previous[index] && opts.allowPersistent !== false) {
        const saved = previous[index];
        /* 旧序号只用于找到一条候选记录，不能单独作为继承依据。
         * identity、完整显示文本与元数据指纹必须同时匹配；旧版没有 metadata
         * 指纹的记录不参与复用，避免重排/增删后把链接继承到错误条目。 */
        if (saved && saved.identity && Object.prototype.hasOwnProperty.call(saved, "metadata")
            && norm(saved.text) === norm(text)) {
          const savedItems = items.filter(function (item) {
            return zf().canonicalIdentity(item) === String(saved.identity) && metadata(item) === String(saved.metadata || "");
          });
          if (savedItems.length === 1) candidates = savedItems;
        }
      }
      if (!candidates.length && opts.citationOrderNumeric) {
        const match = /^\s*\[(\d+)\]/.exec(text);
        if (match) {
          const item = items[Number(match[1]) - 1];
          if (item) candidates = [item];
        }
      }
      candidates = candidates.filter(function (item) { return !used.has(zf().canonicalIdentity(item)); });
      if (candidates.length !== 1) {
        issues.push({ kind: "IDENTITY_AMBIGUOUS", severity: "warning", summary: "文献表第 " + (index + 1) + " 条身份未确定", reason: candidates.length ? "存在多个同元数据候选" : "没有可验证的唯一条目身份", action: "刷新文献表或补充条目级标识，不自动建立链接" });
        return;
      }
      const item = candidates[0], canonical = zf().canonicalIdentity(item);
      used.add(canonical); mappings[index] = canonical;
      persistent[index] = { identity: canonical, text: text, metadata: metadata(item) };
      entries.push({ item: item, identity: canonical, start: Number(entry.start), end: Number(entry.end), text: text, index: index });
    });
    return { entries: entries, mappings: mappings, persistent: persistent, issues: issues, unresolved: (citeprocEntries || []).length - entries.length };
  }
  function resolve(identity, result) {
    const key = zf().canonicalIdentity(identity);
    const found = (result && result.entries || []).filter(function (entry) { return entry.identity === key; });
    if (found.length === 1) return found[0];
    if (found.length > 1) { const e = new Error("条目身份歧义"); e.code = "IDENTITY_AMBIGUOUS"; throw e; }
    return null;
  }
  function prune(validIDs, mappings) {
    const valid = new Set(validIDs || []), out = {};
    Object.keys(mappings || {}).forEach(function (k) { if (valid.has(mappings[k])) out[k] = mappings[k]; });
    return out;
  }
  const api = { rebuild: rebuild, resolve: resolve, prune: prune, normalizeMetadata: metadata };
  root.PPBibliographyMap = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
