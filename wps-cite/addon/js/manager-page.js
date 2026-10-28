// SPDX-License-Identifier: Apache-2.0
/* 管理窗格独立页：不访问 wps；只通过本地命令队列与主页面通信。
 * P2 增加勾选与批量打开：勾选状态只在本页维护，批量命令把 fieldID 列表交给主页面，
 * 由主页面按 canonical identity 去重、限 10 项确认、串行打开并逐项回报。 */
(function () {
  "use strict";
  const PROXY = "http://127.0.0.1:21932";
  const MAX_BATCH = 10;
  const $ = function (id) { return document.getElementById(id); };
  let rows = [];
  const selected = new Set();
  function initialDocumentID() {
    try {
      if (typeof URLSearchParams === "function") return new URLSearchParams(window.location.search).get("documentID") || "";
    } catch (e) { /* 旧 CEF 使用下面的只读解析 */ }
    const match = /(?:^|[?&])documentID=([^&]*)/.exec(String(window.location.search || ""));
    try { return match ? decodeURIComponent(match[1]) : ""; } catch (e) { return ""; }
  }
  const documentID = initialDocumentID();
  let loading = false;
  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c];
    });
  }
  function render() {
    const query = $("query").value.toLocaleLowerCase();
    const abnormal = $("abnormal").checked;
    const filtered = rows.filter(function (r) {
      if (abnormal && !r.broken) return false;
      return !query || [r.text, r.title, r.author, r.year, r.locator, r.chapter, r.container, r.noteIndex, r.issueText].join(" ").toLocaleLowerCase().indexOf(query) >= 0;
    });
    $("status").textContent = "显示 " + filtered.length + " / " + rows.length + " 个物理引文域" + (rows.length >= 200 ? "（完整快照）" : "");
    $("rows").innerHTML = filtered.map(function (r) {
      const items = r.items.map(function (x) { return "<li>" + esc(x.title) + " · " + esc(x.author) + " · " + esc(x.year) + "</li>"; }).join("");
      const picked = selected.has(r.fieldID) ? " checked" : "";
      return '<tr data-id="' + esc(r.fieldID) + '"' + (r.broken ? ' class="bad"' : "") + ">" +
        '<td data-label="选择"><input class="pick" type="checkbox" aria-label="选择第 ' + r.n + ' 条引文"' + picked + "></td>" +
        '<td data-label="序号">' + r.n + '</td><td data-label="正文显示">' + esc(r.text || "(坏域)") + "</td>" +
        '<td data-label="标题 / 作者 / 年份"><details><summary>' + esc(r.title || "无法解析条目") + "</summary><ul>" + items + "</ul></details>" + esc(r.author + " " + r.year) + "</td>" +
        '<td data-label="页码">' + esc(r.locator) + '</td><td data-label="章节">' + esc(r.chapter) + '</td>' +
        '<td data-label="容器">' + esc(r.container) + (r.noteIndex ? " " + r.noteIndex : "") + '</td>' +
        '<td data-label="异常">' + esc(r.issueText || "正常") + '</td>' +
        '<td data-label="操作" class="actions"><button type="button" data-action="locate">定位</button><button type="button" data-action="edit">编辑</button><button type="button" data-action="source">打开原文</button>' +
        '<details class="row-more"><summary>更多</summary><div class="more-actions">' +
        '<button type="button" data-action="bibliography">转至参考文献</button><button type="button" data-action="pdf">打开 PDF</button>' +
        '<button type="button" data-action="zotero">在 Zotero 中显示</button><button type="button" data-action="info">引用信息</button>' +
        '</div></details></td></tr>';
    }).join("");
    updateBatchBar();
  }
  function updateBatchBar() {
    const n = selected.size;
    $("sel-count").textContent = "已选 " + n + " 项" + (n > MAX_BATCH ? "（超过上限 " + MAX_BATCH + "，提交前会确认）" : "");
    const buttons = $("batch-bar").querySelectorAll("button[data-kind]");
    for (let i = 0; i < buttons.length; i++) buttons[i].disabled = n === 0;
  }
  async function request(path, options) {
    const response = await fetch(PROXY + path, options);
    if (!response.ok) throw new Error("本地服务 HTTP " + response.status);
    return response.json();
  }
  async function send(action, fieldID, extra) {
    if (!documentID) throw new Error("缺少文档身份，命令未提交");
    const payload = Object.assign({ action: action, fieldID: fieldID || "", documentID: documentID }, extra || {});
    await request("/commands", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload) });
  }
  async function load() {
    if (!documentID) {
      rows = [];
      $("status").textContent = "缺少文档身份，请从当前 WPS 文档重新打开引文管理";
      return;
    }
    if (loading) return;
    loading = true;
    try {
      const result = await request("/manager?documentID=" + encodeURIComponent(documentID));
      if (result.documentID !== documentID) throw new Error("管理快照属于另一文档，已拒绝显示");
      rows = Array.isArray(result.rows) ? result.rows : [];
      /* 删除/刷新后清理已不存在的勾选，避免把命令发给过期身份。 */
      const alive = new Set(rows.map(function (r) { return r.fieldID; }));
      Array.from(selected).forEach(function (id) { if (!alive.has(id)) selected.delete(id); });
      const state = result.status || {}, last = state.lastRefresh || {};
      $("refresh-status").textContent = "上次刷新：" + (last.at || "尚未刷新") + " · " +
        (last.cancelled ? "已取消" : last.ok === false ? "失败" : last.changed === false ? "成功（无变化）" : last.ok ? "成功" : "无记录") +
        " · 引文 " + Number(state.citationCount || 0) + " · 文献表 " + Number(state.bibliographyCount || 0) +
        " · 异常 " + Number(state.issueCount || 0);
      render();
    } catch (e) { $("status").textContent = "读取失败：" + e.message; }
    finally { loading = false; }
  }
  $("query").addEventListener("input", render);
  $("abnormal").addEventListener("change", render);
  $("rescan").addEventListener("click", function () { send("manager-refresh").then(load).catch(function (e) { $("status").textContent = e.message; }); });
  $("rows").addEventListener("click", function (event) {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const id = button.closest("tr").dataset.id;
    const more = button.closest("details.row-more");
    if (more) more.open = false;
    button.disabled = true;
    send(button.dataset.action, id).then(function () { $("status").textContent = "命令已提交，请在文档中查看结果"; })
      .catch(function (e) { $("status").textContent = e.message; })
      .finally(function () { button.disabled = false; });
  });
  $("rows").addEventListener("change", function (event) {
    const box = event.target.closest("input.pick");
    if (!box) return;
    const tr = box.closest("tr");
    if (!tr) return;
    const id = tr.dataset.id;
    if (box.checked) selected.add(id); else selected.delete(id);
    updateBatchBar();
    if (box.checked && selected.size === 1) $("batch-bar").open = true;
    /* 同步主页面的选择模型；失败不回滚本页勾选（批量命令会带完整 fieldID 列表）。 */
    send("select", id, { checked: box.checked }).catch(function () { /* 勾选仍以本页为准 */ });
  });
  $("batch-bar").addEventListener("click", function (event) {
    const button = event.target.closest("button[data-kind]");
    if (!button || button.disabled) return;
    if (!selected.size) { $("status").textContent = "请先勾选要批量打开的引文行"; return; }
    const kind = button.dataset.kind, count = selected.size;
    send("batch-open", "", { kind: kind, fieldIDs: Array.from(selected) })
      .then(function () { $("status").textContent = "批量打开命令已提交（" + count + " 个引文域），结果会显示在 WPS 文档窗口"; })
      .catch(function (e) { $("status").textContent = e.message; });
  });
  load();
  setInterval(load, 3000);
})();
