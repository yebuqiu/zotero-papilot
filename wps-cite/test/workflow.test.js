// SPDX-License-Identifier: Apache-2.0
"use strict";
const S = require("./helpers/wps-stub.js");
let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log("  PASS " + name); }
  catch (e) { failed++; console.log("  FAIL " + name + " -> " + ((e && e.stack) || e)); }
}
function assert(value, message) { if (!value) throw new Error(message); }
function identity(world, item) { return world.ZF.canonicalIdentity(item); }
function oneWorld(options) {
  const cfg = Object.assign({ path: "C:/tmp/workflow.docx", docData: '{"style":{"styleID":"http://www.zotero.org/styles/apa"}}',
    fields: [{ start: 10, code: S.wordItemCode("citeFlow01", ["AAAA0001"]), text: "[1]" }] }, options || {});
  return S.createWorld(cfg);
}

(async function main() {
  await check("locator 写域并刷新，PDF 页码/标注按文档保存且用于打开", async function () {
    const w = oneWorld(); const opened = [];
    w.http.handler = async function (p, options) {
      if (p.indexOf("/open") === 0) { opened.push(JSON.parse(options.body).uri); return { ok: true, status: 200, text: async () => "{}" }; }
    };
    const ref = w.S.scan(w.doc).fields[0], id = identity(w, ref.items[0]);
    const result = await w.App.updateCitationLocation(ref, { identity: id, locator: "42-45", label: "page", page: 7, annotation: "ANNO1234", attachmentKey: "PDFK1234" });
    assert(result.ok, "保存失败 " + JSON.stringify(result));
    const ci = w.ZF.extractJSON(w.state.bodyFields[0].Code.Text).citationItems[0];
    assert(ci.locator === "42-45" && ci.label === "page", "CSL locator 未写入");
    const saved = w.Settings.get(w.doc.FullName).citationLocations[id.split("|").pop() ? Object.keys(w.Settings.get(w.doc.FullName).citationLocations)[0] : ""];
    assert(saved && saved.page === 7 && saved.annotation === "ANNO1234", "PDF 定位未持久化");
    await w.App.openCitationTarget(ref, "pdf");
    assert(opened.length === 1 && opened[0].includes("PDFK1234") && opened[0].includes("page=7") && opened[0].includes("annotation=ANNO1234"), "打开 URI 未用保存定位：" + opened.join(","));
  });

  await check("定位写入期间域已变化则拒绝，不覆盖新内容", async function () {
    const w = oneWorld(), ref = w.S.scan(w.doc).fields[0], id = identity(w, ref.items[0]);
    const stale = Object.assign({}, ref, { code: ref.code + " " });
    let rejected = false;
    try { await w.App.updateCitationLocation(stale, { identity: id, locator: "8" }); } catch (e) { rejected = /变化/.test(e.message); }
    assert(rejected, "过期快照未被拒绝");
    assert(ref.code === w.state.bodyFields[0].Code.Text, "过期定位仍覆盖域代码");
  });

  await check("重连必须预览+确认，候选不在预览或跨文档都不能写入", async function () {
    const w = oneWorld(); w.http.handler = async function (p) {
      if (p.indexOf("/zotero/api/users/0/items") === 0) {
        return { ok: true, status: 200, text: async () => JSON.stringify([{ key: "BBBB0002", library: { type: "user", id: 1 }, links: { self: { href: "https://zotero.org/users/local/local/items/BBBB0002" } }, data: { key: "BBBB0002", itemType: "journalArticle", title: "Replacement", creators: [{ lastName: "New" }], date: "2026" } }]) };
      }
    };
    const ref = w.S.scan(w.doc).fields[0], id = identity(w, ref.items[0]);
    const preview = await w.App.repairPreview({ fieldID: ref.fieldID, identity: id, query: "Replacement" });
    assert(preview.candidates.length === 1, "没有候选");
    let rejected = false;
    try { await w.App.repairApply({ fieldID: ref.fieldID, identity: id, key: "BBBB0002", uri: preview.candidates[0].uri }); } catch (e) { rejected = /确认/.test(e.message); }
    assert(rejected, "未确认也能重连");
    const result = await w.App.repairApply({ fieldID: ref.fieldID, identity: id, key: "BBBB0002", uri: preview.candidates[0].uri, confirmed: true });
    assert(result.ok, "重连失败");
    assert(w.state.bodyFields[0].Code.Text.includes("BBBB0002"), "域身份未替换");
    const wrong = await w.App.runManagerCommand({ action: "locator-save", fieldID: ref.fieldID, documentID: "C:/tmp/other.docx", data: { identity: id, locator: "9" } });
    assert(wrong.code === "WRONG_DOCUMENT", "跨文档命令未拦截");
  });

  await check("样式收藏三个动态入口可保存、读取和清除", async function () {
    const w = oneWorld();
    await w.App.favoriteSave({ slot: 0, styleID: "https://www.zotero.org/styles/nature", label: "目标刊" });
    assert(w.App.favoriteStyles()[0].label === "目标刊", "收藏未保存");
    assert(w.App.GetLabel({ Id: "btnFavorite1" }).includes("目标刊"), "动态标签未显示收藏");
    assert(w.App.GetEnabled({ Id: "btnFavorite1" }) === true, "收藏入口未启用");
    await w.App.favoriteRemove({ slot: 0 });
    assert(w.App.favoriteStyles().length === 0 && w.App.GetEnabled({ Id: "btnFavorite1" }) === false, "清除后仍可点击");
  });

  await check("投稿方案保存当前样式并按方案过滤检查项", async function () {
    const w = oneWorld();
    const profile = await w.App.profileSave({ name: "无 DOI 强制方案", includeStyle: true, requireDOI: false, requirePages: false, checkUncited: false });
    assert(profile.styleID.includes("/apa"), "未保存当前样式");
    const report = await w.App.runCenterCheck("preflight", { profileID: profile.id });
    assert(report.profile && report.profile.name === "无 DOI 强制方案", "方案未应用于报告");
    assert(!report.findings.some(x => x.kind === "MISSING_DOI" || x.kind === "MISSING_PAGE"), "方案过滤未生效");
    await w.App.profileDelete({ id: profile.id });
    assert(w.Settings.get(w.doc.FullName).submissionProfiles.length === 0, "方案删除失败");
  });

  await check("检查中心三类报告均为可序列化快照", async function () {
    const w = oneWorld();
    for (const kind of ["health", "preflight", "compatibility"]) {
      const report = await w.App.runCenterCheck(kind, { target: "word" });
      assert(report.kind === kind, kind + " 类型错误");
      const text = JSON.stringify(report);
      assert(text.length > 20 && !text.includes('"field":'), kind + " 混入 WPS 域对象");
    }
  });

  await check("坏域报告发布前移除 WPS 域对象，仍可定位与序列化", async function () {
    const w = oneWorld({ fields: [{ start: 10, code: 'ADDIN ZOTERO_ITEM CSL_CITATION {"citationID":"bad1",', text: "[?]" }] });
    let published = null;
    w.http.handler = async function (p, options) {
      if (p === "/manager" && options && options.method === "POST") { published = JSON.parse(options.body); return { ok: true, status: 200, text: async () => "{}" }; }
    };
    const report = await w.App.runCenterCheck("health");
    const finding = report.findings.find(x => x.kind === "BAD_FIELD");
    assert(finding && finding.target.fieldID, "坏域缺少纯数据定位目标");
    assert(!("field" in finding.target) && !("range" in finding.target), "坏域目标仍携带 WPS 对象");
    assert(published && published.center.report.kind === "health", "坏域快照未发布");
    assert(JSON.stringify(published).length > 30, "坏域快照无法序列化");
  });

  await check("窗格命令按 clientID 回传真实结果，失败不生成成功状态", async function () {
    const w = oneWorld(), published = [];
    w.http.handler = async function (p, options) {
      if (p === "/manager" && options && options.method === "POST") { published.push(JSON.parse(options.body)); return { ok: true, status: 200, text: async () => "{}" }; }
    };
    await w.App.runManagerCommand({ action: "favorite-save", documentID: w.doc.FullName,
      data: { clientID: "client-success", slot: 0, styleID: "https://www.zotero.org/styles/nature", label: "N" } });
    const success = published[published.length - 1].center.lastCommand;
    assert(success.clientID === "client-success" && success.ok === true, "成功结果未按 clientID 回传");
    const failed = await w.App.runManagerCommand({ action: "profile-save", documentID: w.doc.FullName,
      data: { clientID: "client-failure", name: "" } });
    const failure = published[published.length - 1].center.lastCommand;
    assert(failed.ok === false && failure.clientID === "client-failure" && /名称/.test(failure.error), "失败结果未回传");
    assert(failed.ok !== true && /名称/.test(failed.error), "失败被当成成功");
  });

  await check("跨文档批量体检枚举当前打开文档并返回错误/警告计数", async function () {
    const w = oneWorld(); const result = await w.App.crossDocumentHealth();
    assert(result.rows.length === 1 && result.rows[0].ok, "未扫描当前文档");
    assert(typeof result.rows[0].errors === "number" && typeof result.rows[0].warnings === "number", "缺少异常计数");
  });

  await check("分章静态文献表可生成和原位更新，总 Zotero 域不变", async function () {
    const itemData = {
      AAAA0001: { itemType: "journalArticle", title: "Alpha", author: [{ family: "Author" }], issued: { "date-parts": [[2025]] } },
      BBBB0002: { itemType: "journalArticle", title: "Beta", author: [{ family: "Author" }], issued: { "date-parts": [[2025]] } },
    };
    const w = S.createWorld({ path: "C:/tmp/chapter.docx", docData: '{"style":{"styleID":"http://www.zotero.org/styles/ieee"}}',
      contentText: "x".repeat(1000), contentEnd: 1000,
      paragraphs: [{ start: 0, end: 3, text: "第一章", outlineLevel: 1 }, { start: 100, end: 103, text: "第二章", outlineLevel: 1 }],
      fields: [
        { start: 20, code: S.wordItemCode("citeChap01", ["AAAA0001"], { itemData: itemData }), text: "[1]" },
        { start: 120, code: S.wordItemCode("citeChap02", ["BBBB0002"], { itemData: itemData }), text: "[2]" },
        { start: 900, code: S.wordBiblCode(), text: "[1] Alpha. Author. 2025.\n[2] Beta. Author. 2025." },
      ] });
    w.sandbox.confirm = function () { return true; };
    const before = w.state.bodyFields.map(f => f.Code.Text);
    const result = await w.App.chapterBibliographyFlow();
    assert(result.count === 2, "未生成两个分章文献表");
    assert(w.state.bookmarks.filter(b => b.Name.startsWith("PPCHAPBIB_")).length === 2, "分章书签数量错误");
    assert(w.host.content.Text.includes("[1] Alpha") && w.host.content.Text.includes("[2] Beta"), "条目文本缺失");
    assert(JSON.stringify(w.state.bodyFields.map(f => f.Code.Text)) === JSON.stringify(before), "Zotero 域被分章操作修改");
    await w.App.chapterBibliographyFlow();
    assert(w.state.bookmarks.filter(b => b.Name.startsWith("PPCHAPBIB_")).length === 2, "重复更新创建了重复分章块");
    assert((w.host.content.Text.match(/Papilot 静态快照/g) || []).length === 2, "重复更新插入重复文本");
  });

  await check("分章操作取消时不写任何内容", async function () {
    const w = S.createWorld({ path: "C:/tmp/chapter-cancel.docx", docData: '{"style":{"styleID":"http://www.zotero.org/styles/ieee"}}',
      paragraphs: [{ start: 0, text: "第一章", outlineLevel: 1 }, { start: 100, text: "第二章", outlineLevel: 1 }],
      fields: [{ start: 20, code: S.wordItemCode("citeChap01", ["AAAA0001"]), text: "[1]" }, { start: 120, code: S.wordItemCode("citeChap02", ["BBBB0002"]), text: "[2]" }, { start: 900, code: S.wordBiblCode(), text: "x" }] });
    w.sandbox.confirm = function () { return false; };
    const before = w.host.content.Text;
    try { await w.App.chapterBibliographyFlow(); } catch (e) { /* 映射不完整也必须在写入前失败 */ }
    assert(w.host.content.Text === before, "取消或预检失败仍写入内容");
  });

  console.log("\n通过 " + passed + " 项，失败 " + failed + " 项");
  process.exit(failed ? 1 : 0);
})();
