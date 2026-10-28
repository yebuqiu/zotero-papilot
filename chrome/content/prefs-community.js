// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 设置窗格 · 联系与社群（0.82.0）
 * 配置、排序、启停与链接校验均在 core/community.js；本文件只做安全 DOM 渲染。
 * 二维码在用户展开对应 details 时才创建 img，避免打开设置页就请求外部图片。
 */
/* global Zotero, window, document, Components */

(function () {
  const HTML_NS = "http://www.w3.org/1999/xhtml";
  const $ = (id) => document.getElementById(id);
  const domain = () => Zotero.Papilot && Zotero.Papilot.community;
  let loading = null;
  let loaded = false;
  let observer = null;

  const el = (tag, attrs, text) => {
    const node = document.createElementNS(HTML_NS, tag);
    if (attrs) for (const key of Object.keys(attrs)) {
      if (attrs[key] === undefined || attrs[key] === null) continue;
      node.setAttribute(key, attrs[key]);
    }
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const clear = (node) => { while (node && node.firstChild) node.removeChild(node.firstChild); };
  const setMsg = (text) => { const node = $("pp-community-msg"); if (node) node.textContent = text || ""; };

  function copyText(text) {
    try {
      const clip = Components.classes["@mozilla.org/widget/clipboardhelper;1"]
        .getService(Components.interfaces.nsIClipboardHelper);
      clip.copyString(String(text || ""));
      setMsg("已复制：" + text);
    } catch (e) { setMsg("复制失败，请手动选择文本复制"); }
  }

  function openItem(item) {
    const target = item.type === "email" ? "mailto:" + item.value : item.url;
    if (!target) return;
    try { Zotero.launchURL(target); }
    catch (e) { setMsg("无法打开外部应用，请使用复制操作"); }
  }

  function qrDisclosure(item) {
    const details = el("details", { class: "pp-disclose pp-community-qr" });
    details.appendChild(el("summary", null, "查看二维码"));
    const body = el("div", { class: "pp-community-qr-body" });
    details.appendChild(body);
    details.addEventListener("toggle", () => {
      if (!details.open || body.firstChild) return;
      const image = el("img", { src: item.qrUrl, alt: item.title + "二维码", loading: "lazy" });
      image.setAttribute("referrerpolicy", "no-referrer");
      image.addEventListener("error", () => {
        clear(body);
        body.appendChild(el("div", { class: "pp-hint" }, "二维码加载失败，请稍后重试或使用其他联系方式"));
      }, { once: true });
      body.appendChild(image);
    });
    return details;
  }

  function render(config) {
    const list = $("pp-community-list");
    if (!list) return;
    clear(list);
    const data = config || { items: [] };
    const items = Array.isArray(data.items) ? data.items : [];
    if (!items.length) {
      list.appendChild(el("div", { class: "pp-empty" },
        "社群与联系方式暂未发布；配置启用后会自动显示，无需升级插件。"));
      return;
    }
    const labels = { wechat: "微", qq: "Q", "official-account": "订", email: "@", link: "链" };
    for (const group of [["community", "用户社群"], ["support", "关注与支持"]]) {
      const rows = items.filter((item) => item.group === group[0]);
      if (!rows.length) continue;
      const section = el("div", { class: "pp-sub pp-community-section" });
      section.appendChild(el("div", { class: "pp-sub-title" }, group[1]));
      for (const item of rows) {
        const row = el("div", { class: "pp-community-row" });
        row.appendChild(el("span", { class: "pp-community-kind", "aria-hidden": "true" }, labels[item.type] || "链"));
        const main = el("div", { class: "pp-community-main" });
        main.appendChild(el("div", { class: "pp-community-title" }, item.title));
        if (item.value) main.appendChild(el("div", { class: "pp-community-value" }, item.value));
        if (item.description) main.appendChild(el("div", { class: "pp-hint" }, item.description));
        if (item.expired) main.appendChild(el("div", { class: "pp-hint" },
          "二维码已过期，请通过公众号或售后邮箱联系我们"));
        row.appendChild(main);
        const actions = el("div", { class: "pp-community-actions" });
        if (item.qrUrl) actions.appendChild(qrDisclosure(item));
        if (item.value) {
          const copy = el("button", { type: "button", class: "pp-btn pp-btn-sm" }, "复制");
          copy.addEventListener("click", () => copyText(item.value));
          actions.appendChild(copy);
        }
        if (item.url || (item.type === "email" && item.value)) {
          const open = el("button", { type: "button", class: "pp-btn pp-btn-sm" },
            item.type === "email" ? "发送邮件" : "打开");
          open.addEventListener("click", () => openItem(item));
          actions.appendChild(open);
        }
        row.appendChild(actions);
        section.appendChild(row);
      }
      list.appendChild(section);
    }
    if (data.updatedAt) list.appendChild(el("div", { class: "pp-hint pp-community-updated" },
      "信息更新于 " + data.updatedAt));
  }

  async function load(force) {
    if (loading) return loading;
    const C = domain();
    if (!C) { setMsg("联系信息组件未就绪"); return null; }
    loading = (async () => {
      try {
        if (!loaded || force) render(await C.loadBuiltin(false));
        // 每次打开设置/点刷新都绕过 TTL 缓存：后台保存后应立即可见；失败仍由核心回退缓存与包内配置。
        const result = await C.getConfig(true);
        render(result.config);
        loaded = true;
        setMsg(force ? "联系信息已刷新" : "");
        return result;
      } catch (e) {
        setMsg("在线信息暂不可用，已保留包内内容");
        return null;
      } finally { loading = null; }
    })();
    return loading;
  }

  function init() {
    const card = document.querySelector('.pp-card[data-fold="community"]');
    if (!card || !$("pp-community-list") || !domain()) {
      if (typeof window !== "undefined" && window.setTimeout) {
        window.setTimeout(init, 400);
        window.setTimeout(init, 1200);
      }
      return;
    }
    if (init._done) return;
    init._done = true;
    const refresh = $("pp-community-refresh");
    if (refresh) refresh.addEventListener("click", () => { load(true); });
    const maybeLoad = () => {
      if (!card.classList.contains("pp-fold-closed")) load(false);
    };
    if (typeof MutationObserver !== "undefined") {
      observer = new MutationObserver(maybeLoad);
      observer.observe(card, { attributes: true, attributeFilter: ["class"] });
    }
    const head = card.querySelector(".pp-fold-head");
    if (head) head.addEventListener("click", () => window.setTimeout(maybeLoad, 0));
    maybeLoad();
    try { window.PapilotPrefsCommunity = { load, render }; } catch (e) { /* ignore */ }
  }

  init();
  if (typeof window !== "undefined" && window.setTimeout) {
    window.setTimeout(init, 400);
    window.setTimeout(init, 1200);
  }
})();
