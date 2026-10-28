// SPDX-License-Identifier: Apache-2.0
/* 批量打开 Zotero / 最佳 PDF / DOI / 附件（P2-5）
 *
 * 契约：
 *   - 按 canonical identity 去重；同一篇文献只打开一次。
 *   - 默认最多 10 项；超出必须由调用方提供 confirm 并返回 true，否则不执行任何打开。
 *   - 串行逐项执行，逐项返回 opened / skipped / failed；成功项不受失败项影响。
 *   - 只有 failed 可重试（retry），skipped 不重试。
 *   - 个人库 users 与群组库 groups 的 URI 由 PPLinks.selectUri 统一生成。
 */
(function (root) {
  "use strict";
  const MAX_ITEMS = 10;
  const KINDS = {
    zotero: "在 Zotero 中显示",
    pdf: "打开最佳 PDF",
    doi: "打开 DOI",
    attachment: "打开附件",
  };

  function links() {
    if (root.PPLinks) return root.PPLinks;
    try { if (typeof require === "function") return require("./links.js"); } catch (e) { return null; }
  }
  function zfields() {
    if (root.PPZFields) return root.PPZFields;
    try { if (typeof require === "function") return require("./zfields.js"); } catch (e) { return null; }
  }
  function zotero() {
    if (root.PPZotero) return root.PPZotero;
    return null;
  }
  function identityOf(item) {
    const z = zfields();
    if (z && typeof z.canonicalIdentity === "function") return z.canonicalIdentity(item);
    const libType = item && (item.libraryType || item.libType) || "users";
    const libId = item && (item.libraryID != null ? item.libraryID : item.libId) || 1;
    return libType + ":" + String(libId) + ":" + String(item && (item.itemKey || item.key) || "").toUpperCase();
  }
  function keyOf(item) {
    return String(item && (item.itemKey || item.key) || "").toUpperCase();
  }
  function libTypeOf(item) {
    return String(item && (item.libraryType || item.libType) || "users");
  }
  function libIdOf(item) {
    const value = item && (item.libraryID != null ? item.libraryID : item.libId);
    return value == null || value === "" ? 1 : Number(value) || 1;
  }
  function dataOf(item) {
    return item && item.itemData && typeof item.itemData === "object" ? item.itemData : null;
  }
  function titleOf(item) {
    const data = dataOf(item) || {};
    const creators = data.creators || data.author || [];
    const first = creators && creators[0] || {};
    return {
      title: String(data.title || data.name || "").replace(/\s+/g, " ").trim(),
      author: String(first.family || first.lastName || first.literal || first.name || "").replace(/\s+/g, " ").trim(),
      year: String((data.issued && data.issued["date-parts"] && data.issued["date-parts"][0] && data.issued["date-parts"][0][0]) || (/^\d{4}/.test(String(data.date || "")) ? String(data.date).slice(0, 4) : "")),
    };
  }
  function describe(item) {
    const meta = titleOf(item);
    return [meta.title || keyOf(item) || "(无标题)", meta.author, meta.year].filter(Boolean).join(" · ");
  }
  function doiOf(item) {
    const data = dataOf(item) || {};
    return String(data.DOI || data.doi || item && (item.DOI || item.doi) || "").trim()
      .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "").replace(/^doi:\s*/i, "");
  }
  function dedupe(items) {
    const seen = new Set(), out = [];
    (items || []).forEach(function (item) {
      if (!item) return;
      const identity = identityOf(item);
      if (seen.has(identity)) return;
      seen.add(identity);
      out.push({ item: item, identity: identity });
    });
    return out;
  }
  function baseResult(entry, status, reason, uri) {
    const meta = titleOf(entry.item);
    return {
      identity: entry.identity, key: keyOf(entry.item), title: meta.title, author: meta.author, year: meta.year,
      status: status, uri: uri || "", reason: reason || "", item: entry.item,
    };
  }

  /** 计算单个目标的 URI；不产生任何打开动作。 */
  async function targetFor(item, kind, options) {
    const o = options || {};
    const L = links();
    const key = keyOf(item), libType = libTypeOf(item), libId = libIdOf(item);
    if (!key) return { status: "skipped", reason: "缺少条目身份（itemKey 为空）" };
    if (!L) return { status: "failed", reason: "链接模块未加载（links.js 缺失）" };
    if (kind === "zotero") {
      return { status: "opened", uri: L.selectUri(key, libId, libType) };
    }
    if (kind === "doi") {
      const doi = doiOf(item);
      if (!doi) return { status: "skipped", reason: "该条目没有 DOI" };
      return { status: "opened", uri: "https://doi.org/" + doi };
    }
    if (kind === "pdf") {
      const Z = zotero();
      if (!Z || typeof Z.bestPdf !== "function") return { status: "failed", reason: "Zotero 访问模块未加载" };
      let pdf = null;
      try { pdf = await Z.bestPdf(key); } catch (e) { return { status: "skipped", reason: "读取附件失败：" + String((e && e.message) || e) }; }
      if (!pdf || !pdf.key) return { status: "skipped", reason: "该条目没有可用 PDF" };
      return { status: "opened", uri: L.pdfUri(pdf.key, Number(item.page) || 0, item.annotation || item.anno || "") };
    }
    if (kind === "attachment") {
      const Z = zotero();
      if (!Z || typeof Z.children !== "function") return { status: "failed", reason: "Zotero 访问模块未加载" };
      let children = [];
      try { children = await Z.children(key); } catch (e) { return { status: "skipped", reason: "读取附件失败：" + String((e && e.message) || e) }; }
      const attachments = (children || []).filter(function (row) { return row && row.data && row.data.itemType === "attachment"; });
      if (!attachments.length) return { status: "skipped", reason: "该条目没有附件" };
      const pdf = attachments.find(function (row) { return /pdf/i.test(String(row.data.contentType || "")); });
      const target = pdf || attachments[0];
      const uri = pdf ? L.pdfUri(target.key, 0, "") : L.selectUri(target.key, libId, libType);
      return { status: "opened", uri: uri };
    }
    return { status: "failed", reason: "未知的打开类型：" + String(kind || "") };
  }

  function openUriDefault(uri) {
    const Z = zotero();
    if (!Z || typeof Z.call !== "function") return Promise.reject(new Error("Zotero 访问模块未加载"));
    return Z.call("/open", { method: "POST", body: { uri: uri } });
  }
  async function openOne(entry, kind, options) {
    const target = await targetFor(entry.item, kind, options);
    if (target.status !== "opened") return baseResult(entry, target.status, target.reason, "");
    try {
      const openUri = typeof options.openUri === "function" ? options.openUri : openUriDefault;
      await openUri(target.uri);
      return baseResult(entry, "opened", "", target.uri);
    } catch (e) {
      return baseResult(entry, "failed", "打开失败：" + String((e && e.message) || e), target.uri);
    }
  }

  /**
   * 批量打开。
   * @param {Array} items 条目数组（可含重复；按 canonical identity 去重）
   * @param {string} kind zotero|pdf|doi|attachment
   * @param {object} [options] { max, confirm, openUri, documentID }
   * @returns {Promise<object>} { ok, code, results, opened, skipped, failed, count }
   */
  async function openTargets(items, kind, options) {
    const o = options || {};
    const list = Array.isArray(items) ? items : (items ? [items] : []);
    const type = String(kind || "").trim().toLocaleLowerCase();
    if (!KINDS[type]) return { ok: false, code: "UNKNOWN_KIND", error: "未知的打开类型：" + kind, results: [], opened: [], skipped: [], failed: [], count: 0 };
    const entries = dedupe(list);
    const max = Number(o.max) > 0 ? Number(o.max) : MAX_ITEMS;
    if (entries.length > max) {
      if (typeof o.confirm !== "function") {
        return { ok: false, code: "CONFIRM_REQUIRED", error: "共 " + entries.length + " 项，超过单次上限 " + max + " 项，需要先确认", count: entries.length, max: max, results: [], opened: [], skipped: [], failed: [] };
      }
      let yes = false;
      try { yes = await o.confirm({ count: entries.length, max: max, kind: type }); }
      catch (e) { yes = false; }
      if (!yes) return { ok: false, cancelled: true, code: "CANCELLED", error: "已取消，未打开任何条目", count: entries.length, results: [], opened: [], skipped: [], failed: [] };
    }
    const results = [];
    for (let i = 0; i < entries.length; i++) {
      results.push(await openOne(entries[i], type, o));
    }
    const opened = results.filter(function (x) { return x.status === "opened"; });
    const skipped = results.filter(function (x) { return x.status === "skipped"; });
    const failed = results.filter(function (x) { return x.status === "failed"; });
    return {
      ok: failed.length === 0, code: failed.length ? "PARTIAL_FAILED" : "OK",
      kind: type, documentID: String(o.documentID || ""), count: results.length,
      results: results, opened: opened, skipped: skipped, failed: failed, max: max,
    };
  }

  /** 只重试 failed 项；成功与跳过项保持原结果，不重复打开。 */
  async function retry(previous, options) {
    const prev = previous || {};
    const failed = Array.isArray(prev)
      ? prev.filter(function (x) { return x && x.status === "failed"; })
      : Array.isArray(prev.failed) ? prev.failed : (prev.results || []).filter(function (x) { return x.status === "failed"; });
    if (!failed.length) return { ok: true, code: "NOTHING_TO_RETRY", kind: prev.kind || "", results: [], opened: [], skipped: [], failed: [], count: 0 };
    const retryResult = await openTargets(failed.map(function (x) { return x.item; }), prev.kind || (options && options.kind), options);
    if (retryResult.code === "CONFIRM_REQUIRED" || retryResult.cancelled) {
      /* 没有确认 / 用户取消：失败项原样保留，不能把“没重试”算成成功。 */
      return Object.assign({}, prev, {
        ok: false, code: retryResult.code, cancelled: !!retryResult.cancelled,
        error: retryResult.error, retried: 0,
      });
    }
    const kept = (prev.results || []).filter(function (x) { return x.status !== "failed"; });
    const results = kept.concat(retryResult.results || []);
    const opened = results.filter(function (x) { return x.status === "opened"; });
    const skipped = results.filter(function (x) { return x.status === "skipped"; });
    const stillFailed = results.filter(function (x) { return x.status === "failed"; });
    return Object.assign({}, retryResult, {
      ok: stillFailed.length === 0, code: stillFailed.length ? "PARTIAL_FAILED" : "OK",
      results: results, opened: opened, skipped: skipped, failed: stillFailed, count: results.length,
      retried: (retryResult.results || []).length,
    });
  }

  const api = {
    openTargets: openTargets, retry: retry, targetFor: targetFor, describe: describe,
    identityOf: identityOf, dedupe: dedupe, KINDS: KINDS, MAX_ITEMS: MAX_ITEMS,
  };
  root.PPExternal = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
