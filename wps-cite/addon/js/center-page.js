// SPDX-License-Identifier: Apache-2.0
/* 检查中心、跨文档、连接/方案与定位页。只经代理与主页面通信，不直接访问 wps。 */
(function () {
  "use strict";
  const PROXY = "http://127.0.0.1:21932";
  const $ = function (id) { return document.getElementById(id); };
  let params;
  try { params = new URLSearchParams(window.location.search || ""); }
  catch (e) { params = { get: function (name) { const m = new RegExp("(?:^|[?&])" + name + "=([^&]*)").exec(String(window.location.search || "")); try { return m ? decodeURIComponent(m[1]) : ""; } catch (ignored) { return ""; } } }; }
  const documentID = params.get("documentID") || "";
  let view = params.get("view") || "citations";
  const initialItemKey = params.get("itemKey") || "";
  let snapshot = { center: {}, locator: {} }, overview = { records: [], documents: [] };
  let centerSignature = "", locatorSignature = "", locatorDirty = false, profileDirty = false, snapshotLoading = false, selectedCheckKind = "", checkKindInitialized = false;
  function esc(value) { return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]; }); }
  async function request(path, options) {
    const response = await fetch(PROXY + path, options);
    const text = await response.text(); let data = null;
    try { data = text ? JSON.parse(text) : {}; } catch (e) { throw new Error("本地服务返回了非 JSON 响应"); }
    if (!response.ok) throw new Error(data && data.error || "本地服务 HTTP " + response.status);
    return data;
  }
  let commandSequence = 0;
  function send(action, fieldID, data, kind) {
    if (!documentID) return Promise.reject(new Error("缺少文档身份，请从当前 WPS 文档重新打开"));
    const clientID = "c" + Date.now().toString(36) + "-" + (++commandSequence);
    const payload = Object.assign({ clientID: clientID }, data || {});
    return request("/commands", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: action, fieldID: fieldID || "", documentID: documentID, data: payload, kind: kind || "" }) })
      .then(function () {
        const started = Date.now();
        return new Promise(function (resolve, reject) {
          async function poll() {
            try {
              const result = await request("/manager?documentID=" + encodeURIComponent(documentID));
              acceptSnapshot(result);
              const done = result.center && result.center.lastCommand;
              if (done && done.clientID === clientID) {
                if (done.ok || !done.error) resolve({ ok: done.ok, code: done.code, error: done.error, method: done.method });
                else reject(new Error(done.error));
                return;
              }
              if (Date.now() - started > 180000) { reject(new Error("主页面处理超时，请在文档窗口检查状态后重试")); return; }
              setTimeout(poll, 300);
            } catch (e) { reject(e); }
          }
          poll();
        });
      });
  }
  function busy(button, task, message) {
    if (!button) return task;
    button.disabled = true;
    return Promise.resolve(task).catch(function (e) { setMessage(e.message); }).finally(function () { button.disabled = false; });
  }
  function setMessage(text) {
    const target = view === "crossdoc" ? $("crossdoc-status") : view === "settings" ? $("settings-message") : view === "locator" ? $("locator-info") : $("center-message");
    if (target) target.textContent = String(text || "");
  }
  function switchView(next) {
    view = next;
    document.querySelectorAll(".view").forEach(function (el) { el.hidden = el.id !== "view-" + next; });
    document.querySelectorAll(".view-tabs button").forEach(function (el) { el.classList.toggle("active", el.dataset.view === next); });
    if (next === "crossdoc") loadOverview();
    if (next === "settings") loadConnection();
    if (next === "checks") renderCenter();
    if (next === "locator") renderLocator(true);
  }
  document.querySelectorAll(".view-tabs button").forEach(function (button) { button.addEventListener("click", function () { switchView(button.dataset.view); }); });

  function acceptSnapshot(result) {
    if (result.documentID !== documentID) throw new Error("快照属于另一文档，已拒绝显示");
    snapshot = result;
    const center = result.center || {};
    const signature = JSON.stringify([center.report, center.repair, center.crossdoc, center.profiles, center.favorites, center.currentStyleID, center.selectedProfile]);
    if (signature !== centerSignature) { centerSignature = signature; renderCenter(); renderFavorites(); renderCrossdocHealth(); }
    if (center.message && view === "checks") $("center-message").textContent = center.message;
    const nextLocator = JSON.stringify(result.locator || {});
    if (nextLocator !== locatorSignature) { locatorSignature = nextLocator; if (!locatorDirty) renderLocator(true); }
  }
  async function loadSnapshot() {
    if (!documentID || snapshotLoading) return;
    snapshotLoading = true;
    try { acceptSnapshot(await request("/manager?documentID=" + encodeURIComponent(documentID))); }
    catch (e) { if (view === "checks") setMessage("读取检查状态失败：" + e.message); }
    finally { snapshotLoading = false; }
  }

  function profileRows() { return (snapshot.center && snapshot.center.profiles || []); }
  function renderProfileOptions() {
    const select = $("profile-select"), current = (snapshot.center && snapshot.center.selectedProfile) || select.value || "";
    select.innerHTML = '<option value="">通用检查（不套用方案）</option>' + profileRows().map(function (p) {
      return '<option value="' + esc(p.id) + '">' + esc(p.name) + "</option>";
    }).join("");
    select.value = current;
    if (!select.value && current) select.value = "";
    $("apply-profile").hidden = !select.value || $("check-kind").value !== "preflight";
  }
  function reportFindings(report) {
    if (!report) return [];
    if (report.kind === "compatibility") return (report.evidence || []).map(function (row, index) {
      return { kind: row.kind || "evidence", severity: row.status === "risk" ? "error" : row.status === "warning" ? "warning" : "info",
        summary: row.summary, reason: row.status, action: "迁移前核对本项证据", target: null, index: index };
    });
    return report.findings || [];
  }
  function renderCenter() {
    const center = snapshot.center || {}, report = center.report || null;
    if (!checkKindInitialized && center.kind) { selectedCheckKind = center.kind; checkKindInitialized = true; }
    if (!selectedCheckKind) selectedCheckKind = "health";
    if ($("check-kind").value !== selectedCheckKind) $("check-kind").value = selectedCheckKind;
    updateCheckControls(); renderProfileOptions();
    const findings = reportFindings(report), filter = $("finding-filter").value.trim().toLocaleLowerCase();
    const visible = findings.map(function (row, index) { return { row: row, index: index }; }).filter(function (entry) {
      return !filter || JSON.stringify(entry.row).toLocaleLowerCase().indexOf(filter) >= 0;
    });
    $("report-summary").textContent = report ? (report.kind === "health" ? "文档体检" : report.kind === "preflight" ? "投稿前检查" : "迁移兼容检查") + " · " + findings.length + " 项" : "尚未生成报告";
    $("findings").innerHTML = visible.length ? visible.map(function (entry) {
      const row = entry.row, target = row.target || {}, fieldID = target.fieldID || row.fieldID || "";
      const canRepair = fieldID && report.kind !== "compatibility";
      return '<article class="finding-card ' + esc(row.severity || "info") + '"><div class="finding-head"><span class="severity">' + esc(row.severity || "info") + '</span><strong>' + esc(row.summary || "未命名问题") + '</strong><span>' + esc(row.kind || "") + '</span></div>' +
        '<p>' + esc(row.reason || "") + '</p><p>建议：' + esc(row.action || "人工核对") + '</p><div class="finding-actions">' +
        (fieldID || target.citationID ? '<button type="button" data-report-action="locate" data-index="' + entry.index + '">定位</button>' : "") +
        (canRepair ? '<button type="button" data-report-action="repair" data-index="' + entry.index + '">查找替代条目</button>' : "") + '</div></article>';
    }).join("") : '<div class="settings-card">没有符合当前筛选的检查项。</div>';
    renderRepair(center.repair || null);
  }
  function updateCheckControls() {
    const kind = $("check-kind").value;
    $("compat-target").hidden = kind !== "compatibility";
    $("profile-select").hidden = kind !== "preflight";
    $("profile-editor").hidden = kind !== "preflight";
    $("apply-profile").hidden = kind !== "preflight" || !$("profile-select").value;
  }
  function currentFinding(index) { return reportFindings(snapshot.center && snapshot.center.report)[Number(index)] || null; }
  $("check-kind").addEventListener("change", function () { selectedCheckKind = this.value; checkKindInitialized = true; updateCheckControls(); });
  $("finding-filter").addEventListener("input", renderCenter);
  $("findings").addEventListener("click", function (event) {
    const button = event.target.closest("button[data-report-action]"); if (!button) return;
    const finding = currentFinding(button.dataset.index); if (!finding) return;
    const target = finding.target || {}, fieldID = target.fieldID || finding.fieldID || "";
    if (button.dataset.reportAction === "locate") busy(button, send("locate-report", fieldID, { target: target }).then(function () { setMessage("已提交定位，请在文档中查看"); }), "");
    else {
      const item = target.item || finding.item || {}, data = item.itemData || item.data || {};
      const identity = target.identity || (item.libType || "users") + ":" + String(item.libId == null ? 1 : item.libId) + ":" + (item.key || item.itemKey || "");
      const query = data.title || item.title || finding.summary || "";
      busy(button, send("repair-preview", fieldID, { identity: identity, query: query }).then(function () { setMessage("候选已更新，请核对后确认重连"); loadSnapshot(); }), "");
    }
  });
  $("run-check").addEventListener("click", function () {
    const kind = $("check-kind").value;
    busy(this, send("run-check", "", { kind: kind, target: $("compat-target").value, profileID: $("profile-select").value }, kind)
      .then(function () { setMessage("检查完成"); loadSnapshot(); }), "");
  });
  $("apply-profile").addEventListener("click", function () {
    busy(this, send("run-check", "", { kind: "preflight", profileID: $("profile-select").value, applyStyle: true }, "preflight")
      .then(function () { setMessage("方案已应用并完成检查"); loadSnapshot(); }), "");
  });
  $("export-center-report").addEventListener("click", function () {
    busy(this, send("export-report").then(function (result) { setMessage(result.ok ? "报告已导出或复制" : "当前环境不能直接保存，报告已在文档窗口显示"); }), "");
  });

  function fillProfile(row) {
    const p = row || {};
    $("profile-id").value = p.id || ""; $("profile-name").value = p.name || "";
    $("profile-style").checked = !!p.styleID; $("profile-doi").checked = p.requireDOI !== false;
    $("profile-pages").checked = p.requirePages !== false; $("profile-uncited").checked = p.checkUncited !== false;
    profileDirty = false;
  }
  $("profile-select").addEventListener("change", function () {
    const row = profileRows().find(function (p) { return p.id === $("profile-select").value; });
    fillProfile(row); updateCheckControls();
  });
  ["profile-name", "profile-style", "profile-doi", "profile-pages", "profile-uncited"].forEach(function (id) { $(id).addEventListener("input", function () { profileDirty = true; }); });
  $("save-profile").addEventListener("click", function () {
    const data = { id: $("profile-id").value, name: $("profile-name").value, includeStyle: $("profile-style").checked,
      requireDOI: $("profile-doi").checked, requirePages: $("profile-pages").checked, checkUncited: $("profile-uncited").checked };
    busy(this, send("profile-save", "", data).then(function () { profileDirty = false; setMessage("方案已保存"); loadSnapshot(); }), "");
  });
  $("delete-profile").addEventListener("click", function () {
    const id = $("profile-select").value; if (!id) { setMessage("请先选择要删除的方案"); return; }
    if (!window.confirm("删除当前投稿方案？只删除设置，不影响文档与样式。")) return;
    busy(this, send("profile-delete", "", { id: id, confirmed: true }).then(function () { fillProfile(null); setMessage("方案已删除"); loadSnapshot(); }), "");
  });

  function renderRepair(repair) {
    $("repair-panel").hidden = !repair;
    if (!repair) { $("repair-preview").innerHTML = ""; return; }
    $("repair-preview").innerHTML = '<p>原条目：' + esc(repair.old) + '</p><div class="inline-actions"><input id="repair-query" value="' + esc(repair.query) + '" aria-label="重连检索词"><button type="button" id="repair-search">重新检索</button></div>' +
      (repair.candidates.length ? repair.candidates.map(function (c, i) {
        return '<label class="repair-candidate"><input type="radio" name="repair-candidate" value="' + i + '"><span>' + esc(c.title) + ' · ' + esc(c.author) + ' · ' + esc(c.year) + '<br><small>' + esc(c.key) + '</small></span><span>选择</span></label>';
      }).join("") : '<p>没有候选。可修改关键词重新检索。</p>') +
      '<label class="check-row"><input id="repair-confirm" type="checkbox"> 我已核对原条目与所选替代条目，确认写回并让 Zotero 刷新</label><div class="inline-actions"><button type="button" id="repair-apply" class="primary">确认重连</button></div>';
    $("repair-search").addEventListener("click", function () {
      busy(this, send("repair-preview", repair.fieldID, { identity: repair.identity, query: $("repair-query").value }).then(loadSnapshot), "");
    });
    $("repair-apply").addEventListener("click", function () {
      const selected = document.querySelector('input[name="repair-candidate"]:checked');
      if (!selected) { setMessage("请先选择一个替代条目"); return; }
      if (!$("repair-confirm").checked) { setMessage("请先勾选确认，尚未修改文档"); return; }
      const candidate = repair.candidates[Number(selected.value)];
      busy(this, send("repair-apply", repair.fieldID, { fieldID: repair.fieldID, identity: repair.identity,
        key: candidate.key, uri: candidate.uri, confirmed: true }).then(function () { setMessage("重连与刷新已完成"); loadSnapshot(); }), "");
    });
  }

  async function loadOverview() {
    try { overview = await request("/links/overview"); renderOverview(); }
    catch (e) { $("crossdoc-status").textContent = "读取跨文档台账失败：" + e.message; }
  }
  function renderOverview() {
    const query = $("crossdoc-query").value.trim().toLocaleLowerCase();
    const records = overview.records.filter(function (r) { return !query || [r.doc, r.itemKey, r.text, r.snippet].join(" ").toLocaleLowerCase().indexOf(query) >= 0; });
    const docs = overview.documents.filter(function (d) { return !query || d.doc.toLocaleLowerCase().indexOf(query) >= 0 || records.some(function (r) { return r.doc === d.doc; }); });
    $("crossdoc-status").textContent = "台账共 " + overview.documents.length + " 份文档、" + overview.records.length + " 条引用；当前显示 " + records.length + " 条。未打开文档只显示台账，不做域体检。";
    $("crossdoc-documents").innerHTML = docs.length ? docs.slice(0, 200).map(function (d) {
      return '<details class="doc-card"><summary>' + esc(d.doc) + '</summary><div class="doc-meta">引用 ' + d.citationCount + ' 条 · 文献 ' + d.uniqueItems + ' 篇 · ' + esc(d.updatedAt || "无时间") + ' · ' + (d.exists ? "文件存在" : "文件不存在") + '</div>' +
        (d.exists ? '<div class="inline-actions"><button type="button" data-open-doc="' + esc(d.doc) + '">打开文档</button></div>' : "") + '</details>';
    }).join("") : '<div class="settings-card">没有匹配的文档台账。</div>';
    $("crossdoc-records").innerHTML = records.length ? '<div class="record-list">' + records.slice(0, 300).map(function (r) {
      return '<div class="record-row"><strong>' + esc(r.itemKey) + '</strong> · ' + esc(r.text || "引文") + (r.page ? ' · PDF 第 ' + Number(r.page) + ' 页' : "") + '<br><span class="doc-meta">' + esc(r.doc) + (r.snippet ? ' · ' + esc(r.snippet) : "") + '</span></div>';
    }).join("") + (records.length > 300 ? '<p class="help-text">仅显示前 300 条，请继续筛选。</p>' : "") + '</div>' : "";
  }
  function renderCrossdocHealth() {
    const data = snapshot.center && snapshot.center.crossdoc;
    $("crossdoc-health-rows").innerHTML = data && data.rows ? '<h3>已打开文档体检 · ' + esc(data.at) + '</h3>' + data.rows.map(function (r) {
      return '<div class="health-row">' + esc(r.name) + (r.ok ? ' · 引文 ' + r.citations + ' · 错误 ' + r.errors + ' · 警告 ' + r.warnings : ' · 失败：' + esc(r.error)) + '</div>';
    }).join("") : "";
  }
  $("crossdoc-query").addEventListener("input", renderOverview);
  $("reload-crossdoc").addEventListener("click", loadOverview);
  $("crossdoc-documents").addEventListener("click", function (event) {
    const button = event.target.closest("button[data-open-doc]"); if (!button) return;
    busy(button, request("/open", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: button.dataset.openDoc }) })
      .then(function () { setMessage("已请求打开文档；打开后可再次执行批量体检"); }), "");
  });
  $("crossdoc-health").addEventListener("click", function () { busy(this, send("crossdoc-health").then(loadSnapshot), ""); });

  async function loadConnection() {
    try {
      const h = await request("/connection");
      $("connection-status").textContent = "代理：正常（" + h.proxyVersion + "） · Zotero：" + (h.zotero ? "已运行" : "未运行") + " · 本地 API：" + (h.localApi ? "可用" : "不可用");
      $("start-zotero").disabled = !!h.zotero || !h.zoteroStartAvailable;
    } catch (e) { $("connection-status").textContent = "连接检查失败：" + e.message; }
  }
  $("connection-recheck").addEventListener("click", loadConnection);
  $("start-zotero").addEventListener("click", function () {
    busy(this, request("/connection", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "start-zotero" }) })
      .then(function (r) { setMessage(r.started ? "已发起 Zotero 启动，请稍候再检查" : r.error || "Zotero 已在运行"); setTimeout(loadConnection, 1500); }), "");
  });

  function renderFavorites() {
    const center = snapshot.center || {}, rows = center.favorites || [];
    $("favorite-rows").innerHTML = [0, 1, 2].map(function (slot) {
      const row = rows[slot] || {};
      return '<div class="favorite-row" data-slot="' + slot + '"><input data-fav="label" value="' + esc(row.label || "收藏 " + (slot + 1)) + '" aria-label="收藏名称"><input data-fav="styleID" value="' + esc(row.styleID || "") + '" placeholder="https://www.zotero.org/styles/..." aria-label="样式 ID">' +
        '<button type="button" data-fav-action="current">用当前</button><button type="button" data-fav-action="save">保存</button><button type="button" data-fav-action="remove">清除</button></div>';
    }).join("");
  }
  $("favorite-rows").addEventListener("click", function (event) {
    const button = event.target.closest("button[data-fav-action]"); if (!button) return;
    const row = button.closest(".favorite-row"), slot = Number(row.dataset.slot);
    if (button.dataset.favAction === "current") { row.querySelector('[data-fav="styleID"]').value = snapshot.center.currentStyleID || ""; return; }
    const data = { slot: slot, label: row.querySelector('[data-fav="label"]').value, styleID: row.querySelector('[data-fav="styleID"]').value };
    const action = button.dataset.favAction === "save" ? "favorite-save" : "favorite-remove";
    busy(button, send(action, "", data).then(function () { setMessage(action === "favorite-save" ? "样式收藏已保存" : "样式收藏已清除"); loadSnapshot(); }), "");
  });

  function locatorItem() {
    const items = snapshot.locator && snapshot.locator.items || [];
    return items[$("locator-items").selectedIndex] || items[0] || null;
  }
  function renderLocator(force) {
    const data = snapshot.locator || {}, items = data.items || [];
    if (!items.length) { $("locator-info").textContent = "没有可编辑的引文，请从当前引文菜单重新打开。"; return; }
    if (force) {
      $("locator-items").innerHTML = items.map(function (item, i) { return '<option value="' + i + '">' + esc(item.title) + '</option>'; }).join("");
      $("locator-items").selectedIndex = 0; locatorDirty = false;
    }
    const item = locatorItem(); if (!item) return;
    $("locator-text").value = item.locator || ""; $("locator-label").value = item.label || ""; $("locator-page").value = Number(item.page) || 0;
    $("locator-annotation").innerHTML = '<option value="">不指定标注</option>' + (item.annotations || []).map(function (a) {
      return '<option value="' + esc(a.key) + '" data-page="' + Number(a.page || 0) + '">' + esc("第 " + (a.page || "?") + " 页 · " + (a.text || a.key)) + '</option>';
    }).join("");
    $("locator-annotation").value = item.annotation || "";
    $("locator-info").textContent = item.attachmentKey ? "PDF 附件：" + item.attachmentKey + "；保存后会先写入并刷新，再保存 PDF 定位。" : "未找到可用 PDF；仍可编辑正文 locator，PDF 精确跳转不可用。";
  }
  $("locator-items").addEventListener("change", function () { renderLocator(false); });
  ["locator-text", "locator-label", "locator-page", "locator-annotation"].forEach(function (id) { $(id).addEventListener("input", function () { locatorDirty = true; }); });
  $("locator-annotation").addEventListener("change", function () {
    const option = this.options[this.selectedIndex]; if (option && Number(option.dataset.page)) $("locator-page").value = option.dataset.page;
  });
  $("save-locator").addEventListener("click", function () {
    const item = locatorItem(); if (!item) return;
    const data = { identity: item.identity, locator: $("locator-text").value, label: $("locator-label").value,
      page: Number($("locator-page").value) || 0, annotation: $("locator-annotation").value, attachmentKey: item.attachmentKey || "" };
    busy(this, send("locator-save", snapshot.locator.fieldID, data).then(function () { locatorDirty = false; setMessage("定位已保存并完成刷新"); loadSnapshot(); }), "");
  });

  if (initialItemKey) $("crossdoc-query").value = initialItemKey;
  switchView(view);
  loadSnapshot();
  setInterval(loadSnapshot, 2500);
})();
