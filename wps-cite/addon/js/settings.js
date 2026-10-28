// SPDX-License-Identifier: Apache-2.0
/* 文档私有设置、刷新指纹与能力状态；不包含正文，不上传。 */
(function (root) {
  "use strict";
  const PREFIX = "papilot-cite.settings.v1.";
  const CONFIG_URL = "http://127.0.0.1:21932/config";
  const CONFIG_KEY = "citeDocumentSettings";
  const memory = new Map();
  const pendingPatches = new Map();
  const DEFAULTS = {
    recentStyles: [], favoriteStyles: [], citationLocations: {}, submissionProfiles: [],
    autoCheckOnOpen: false, autoRefreshOnSave: false,
    lastRefresh: null, lastSuccess: null, bibliographyMap: {}, capabilities: null,
    backStack: [], automationEvents: false,
  };
  let hydratePromise = null;
  let hydrated = false;
  let writeQueue = Promise.resolve();
  let pendingWrites = 0;
  let lastPersistenceError = "";

  function storage() {
    try { return root.localStorage || null; } catch (e) { return null; }
  }
  function clone(v) { return JSON.parse(JSON.stringify(v)); }
  function keyOf(documentID) { return PREFIX + String(documentID || "unknown"); }
  function request(path, options) {
    if (typeof root.fetch !== "function") return Promise.reject(new Error("fetch 不可用"));
    return Promise.resolve().then(function () { return root.fetch(CONFIG_URL + (path || ""), options || {}); });
  }
  function remoteRows(config) {
    const rows = config && config[CONFIG_KEY];
    return rows && typeof rows === "object" && !Array.isArray(rows) ? rows : {};
  }
  function normalize(value) {
    const next = Object.assign(clone(DEFAULTS), value && typeof value === "object" ? value : {});
    next.recentStyles = Array.isArray(next.recentStyles) ? next.recentStyles.slice(0, 3) : [];
    next.favoriteStyles = Array.isArray(next.favoriteStyles) ? next.favoriteStyles.slice(0, 3) : [];
    next.citationLocations = next.citationLocations && typeof next.citationLocations === "object" && !Array.isArray(next.citationLocations) ? next.citationLocations : {};
    const locationKeys = Object.keys(next.citationLocations);
    if (locationKeys.length > 500) {
      const bounded = {}; locationKeys.slice(-500).forEach(function (key) { bounded[key] = next.citationLocations[key]; });
      next.citationLocations = bounded;
    }
    next.submissionProfiles = Array.isArray(next.submissionProfiles) ? next.submissionProfiles.slice(0, 8) : [];
    next.backStack = Array.isArray(next.backStack) ? next.backStack.slice(-20) : [];
    next.autoCheckOnOpen = next.autoCheckOnOpen === true;
    next.autoRefreshOnSave = next.autoRefreshOnSave === true;
    return next;
  }
  function mergeRemote(config) {
    const rows = remoteRows(config);
    const ids = new Set(Object.keys(rows).concat(Array.from(pendingPatches.keys())));
    ids.forEach(function (documentID) {
      const key = keyOf(documentID), value = rows[documentID], patches = pendingPatches.get(documentID) || [];
      if (value && typeof value === "object" && !memory.has(key)) memory.set(key, JSON.stringify(value));
      if (!patches.length) return;
      /* 水合前已经发生同步 set：以服务端旧值为底重放补丁，不能用水合前的
       * DEFAULTS+patch 整对象覆盖掉其他持久字段。 */
      let base = value && typeof value === "object" ? clone(value) : read(documentID);
      patches.forEach(function (patch) { base = normalize(Object.assign(base, patch)); });
      memory.set(key, JSON.stringify(normalize(base)));
      pendingPatches.delete(documentID);
    });
  }
  function hydrate() {
    if (hydratePromise) return hydratePromise;
    hydratePromise = request("", { method: "GET" }).then(function (res) {
      if (!res || !res.ok) throw new Error("配置水合 HTTP " + (res && res.status || "未知"));
      return res.json ? res.json() : res.text().then(function (text) { return JSON.parse(text || "{}"); });
    }).then(function (config) {
      mergeRemote(config);
      hydrated = true;
      lastPersistenceError = "";
      return true;
    }).catch(function (e) {
      lastPersistenceError = String((e && e.message) || e);
      hydratePromise = null;       // 下次读/写可重试，不能永久退成内存态
      return false;
    });
    return hydratePromise;
  }
  function snapshot() {
    const out = {};
    memory.forEach(function (raw, key) {
      try { out[key.slice(PREFIX.length)] = JSON.parse(raw); } catch (e) { /* 只持久化合法 JSON */ }
    });
    return out;
  }
  function persist() {
    /* 串行落盘并在发送前取最新快照，避免快速连续写入发生响应倒序覆盖。
     * 第一次写前必须先成功水合，否则不能用不完整缓存覆盖代理里的其他文档。 */
    pendingWrites++;
    writeQueue = writeQueue.then(function () {
      return hydrate().then(function (hydrated) {
        if (!hydrated) return false;
        const body = {};
        body[CONFIG_KEY] = snapshot();
        return request("", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        }).then(function (res) {
          if (!res || !res.ok) throw new Error("配置落盘 HTTP " + (res && res.status || "未知"));
          lastPersistenceError = "";
          return true;
        });
      });
    }).catch(function (e) {
      lastPersistenceError = String((e && e.message) || e);
      return false;
    }).then(function (result) {
      pendingWrites--;
      return result;
    });
    return writeQueue;
  }
  function read(documentID) {
    const key = keyOf(documentID);
    let raw = memory.get(key) || "";
    const s = storage();
    if (s) { try { raw = s.getItem(key) || raw; } catch (e) { /* 代理仍是持久化通道 */ } }
    if (!raw) return clone(DEFAULTS);
    try {
      const value = JSON.parse(raw);
      return normalize(value);
    } catch (e) { return clone(DEFAULTS); }
  }
  function write(documentID, value) {
    const key = keyOf(documentID);
    const raw = JSON.stringify(value);
    memory.set(key, raw);
    const s = storage();
    if (s) { try { s.setItem(key, raw); } catch (e) { /* localStorage 失败不影响代理落盘 */ } }
    persist();
    return clone(value);
  }
  function get(documentID) { hydrate(); return read(documentID); }
  function set(documentID, patch) {
    const documentKey = String(documentID || "unknown");
    if (!pendingPatches.has(documentKey)) pendingPatches.set(documentKey, []);
    pendingPatches.get(documentKey).push(Object.assign({}, patch || {}));
    const next = normalize(Object.assign(read(documentID), patch || {}));
    return write(documentID, next);
  }
  function refreshSucceeded(documentID, status) {
    const old = read(documentID);
    return set(documentID, {
      lastRefresh: Object.assign({}, status || {}, { at: new Date().toISOString(), ok: true }),
      lastSuccess: Object.assign({}, status || {}, { at: new Date().toISOString(), ok: true }),
      recentStyles: old.recentStyles,
    });
  }
  function refreshFinished(documentID, status) {
    return set(documentID, { lastRefresh: Object.assign({}, status || {}, { at: new Date().toISOString() }) });
  }
  function persistenceStatus() { return { hydrated: !!hydratePromise, pending: pendingWrites > 0, error: lastPersistenceError }; }
  const api = { get: get, set: set, refreshSucceeded: refreshSucceeded, refreshFinished: refreshFinished,
    hydrate: hydrate, flush: function () { return writeQueue; }, persistenceStatus: persistenceStatus, DEFAULTS: DEFAULTS };
  root.PPSettings = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  hydrate();
})(typeof globalThis !== "undefined" ? globalThis : this);
