// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 联系与社群（0.82.0）
 * 单一配置真源：chrome/content/community.json。在线更新走仓库 raw 地址，
 * 包内同一路径作为离线备用；日常换群号、邮箱、二维码不需要改代码或重发插件。
 * 网络只在本域被设置面板调用时发生，不在启动阶段拉取。
 */
/* global Zotero, Prefs, CatalogClient */

var Community = {
  CACHE_PREF: "extensions.zotero.papilot.communityCache",
  CACHE_TTL_MS: 5 * 60 * 1000,
  URLS: [
    "https://pp.xinglintools.top/api/public/community",
    "https://gitee.com/cassiuschen9261/zotero-papilot/raw/main/chrome/content/community.json",
    "https://raw.githubusercontent.com/yebuqiu/zotero-papilot/main/chrome/content/community.json",
  ],
  TYPES: ["wechat", "qq", "official-account", "email", "link"],
  _rootURI: "",
  _client: null,
  _builtin: null,

  init(opts) {
    const o = opts || {};
    this._rootURI = String(o.rootURI || this._rootURI || "");
  },

  /** 仅允许显式 HTTPS；邮件链接单独由面板从已校验邮箱构造。 */
  safeUrl(value) {
    const u = String(value || "").trim();
    if (!u || u.length > 2048) return "";
    try {
      const parsed = new URL(u);
      return parsed.protocol === "https:" ? u : "";
    } catch (e) { return ""; }
  },

  validEmail(value) {
    const v = String(value || "").trim();
    return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(v) && v.length <= 320 ? v : "";
  },

  validate(data) {
    const errors = [];
    if (!data || typeof data !== "object" || Array.isArray(data)) errors.push("配置必须是对象");
    if (!data || data.version !== 1) errors.push("version 必须为 1");
    if (!data || !Array.isArray(data.items)) errors.push("items 必须为数组");
    if (data && Array.isArray(data.items) && data.items.length > 50) errors.push("items 最多 50 条");
    return { ok: errors.length === 0, errors };
  },

  /** 清洗并规范化远程输入。所有字符串都按纯文本消费，不解释 HTML。 */
  normalize(data, now) {
    if (!this.validate(data).ok) return { version: 1, updatedAt: "", items: [] };
    const nowMs = Number(now) || Date.now();
    const seen = new Set();
    const items = [];
    for (const raw of data.items) {
      if (!raw || typeof raw !== "object" || raw.enabled === false) continue;
      const id = String(raw.id || "").trim();
      const type = String(raw.type || "").trim();
      if (!id || seen.has(id) || this.TYPES.indexOf(type) < 0) continue;
      seen.add(id);
      const title = String(raw.title || "").trim().slice(0, 80);
      if (!title) continue;
      const expiresAt = String(raw.expiresAt || "").trim();
      const expiryMs = expiresAt ? Date.parse(expiresAt + (expiresAt.length === 10 ? "T23:59:59+08:00" : "")) : 0;
      const expired = !!(expiresAt && (!isFinite(expiryMs) || nowMs > expiryMs));
      let value = String(raw.value || "").trim().slice(0, 320);
      if (type === "email") value = this.validEmail(value);
      items.push({
        id, type, title, value,
        group: raw.group === "support" ? "support" : "community",
        order: Number.isFinite(Number(raw.order)) ? Number(raw.order) : 100,
        description: String(raw.description || "").trim().slice(0, 240),
        qrUrl: expired ? "" : this.safeUrl(raw.qrUrl),
        url: this.safeUrl(raw.url),
        expired,
      });
    }
    items.sort((a, b) => (a.order - b.order) || a.id.localeCompare(b.id));
    return { version: 1, updatedAt: String(data.updatedAt || "").slice(0, 40), items };
  },

  _getClient() {
    if (this._client) return this._client;
    this._client = CatalogClient.create({
      urls: this.URLS,
      cachePref: this.CACHE_PREF,
      cacheTtlMs: this.CACHE_TTL_MS,
      validate: (data) => this.validate(data),
      sourceLabel: (url) => url.indexOf("/api/public/community") >= 0 ? "server"
        : (url.indexOf("gitee.com") >= 0 ? "gitee" : "github"),
      prefGet: (key, fallback) => {
        try { const v = Prefs.get(key, true); return v == null ? fallback : v; }
        catch (e) { return fallback; }
      },
      prefSet: (key, value) => { try { Prefs.set(key, value, true); } catch (e) { /* ignore */ } },
      diag: (msg) => { try { Zotero.debug("Papilot Community: " + msg); } catch (e) { /* ignore */ } },
    });
    return this._client;
  },

  async loadBuiltin(force) {
    if (this._builtin && !force) return this._builtin;
    if (!this._rootURI) return { version: 1, updatedAt: "", items: [] };
    try {
      const response = await fetch(this._rootURI + "chrome/content/community.json", { cache: "no-store" });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const data = await response.json();
      if (!this.validate(data).ok) throw new Error("包内配置结构非法");
      this._builtin = this.normalize(data);
      return this._builtin;
    } catch (e) {
      try { Zotero.debug("Papilot Community: 包内配置不可用 " + (e && e.message || e)); } catch (_) { /* ignore */ }
      return { version: 1, updatedAt: "", items: [] };
    }
  },

  /** 在线配置优先；缓存/离线失败时回退包内快照。 */
  async getConfig(force) {
    const client = this._getClient();
    if (force) client.clearFailures();
    const result = await client.fetch(!!force);
    if (result.ok && result.source !== "stale-cache") {
      return { config: this.normalize(result.data), source: result.source, error: "" };
    }
    const builtin = await this.loadBuiltin(false);
    return {
      config: result.ok ? this.normalize(result.data) : builtin,
      source: result.ok ? "stale-cache" : "builtin",
      error: result.error || "",
    };
  },
};
