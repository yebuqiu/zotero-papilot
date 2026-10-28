// SPDX-License-Identifier: Apache-2.0
/* WPS 引文中心真实 DOM 回归：首个快照初始化、命令结果反馈、定位与窄屏。 */
"use strict";
const fs = require("fs"), path = require("path"), assert = require("assert");
const { pathToFileURL } = require("url");
let chromium;
try { ({ chromium } = require("playwright-core")); }
catch (e) { console.log("跳过：未安装 playwright-core"); process.exit(0); }
const candidates = [process.env.PP_CHROME, "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].filter(Boolean);
const executablePath = candidates.find((p) => fs.existsSync(p));
if (!executablePath) { console.log("跳过：未找到 Chrome/Edge"); process.exit(0); }

(async function main() {
  const browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  const errors = [], commands = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const state = { kind: "preflight", report: { kind: "preflight", findings: [] }, repair: null, profiles: [], favorites: [],
    currentStyleID: "https://www.zotero.org/styles/apa", selectedProfile: "", message: "", lastCommand: null, crossdoc: null };
  const locator = { fieldID: "f1", citationID: "c1", items: [{ identity: "users:1:AAAA0001", key: "AAAA0001", libId: 1,
    libType: "users", title: "测试文献", locator: "", label: "", page: 0, annotation: "", attachmentKey: "PDFK1234",
    annotations: [{ key: "ANNO1234", page: 7, text: "高亮内容" }] }] };
  await page.route("http://127.0.0.1:21932/**", async (route) => {
    const req = route.request(), url = new URL(req.url()), headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
    let data = { ok: true };
    if (url.pathname === "/commands") {
      const c = JSON.parse(req.postData() || "{}"); commands.push(c);
      let ok = true, error = "";
      if (c.action === "profile-save" && !c.data.name) { ok = false; error = "方案名称不能为空"; }
      if (c.action === "profile-save" && c.data.name) { state.profiles = [Object.assign({}, c.data, { id: "p1" })]; state.selectedProfile = "p1"; }
      state.lastCommand = { clientID: c.data.clientID, action: c.action, ok, error, method: "" };
    }
    if (url.pathname === "/manager") data = { documentID: "doc-ui", rows: [], status: {}, center: state, locator };
    return route.fulfill({ status: 200, headers, body: JSON.stringify(data) });
  });
  const base = pathToFileURL(path.resolve(__dirname, "..", "addon", "manager.html")).href + "?documentID=doc-ui&view=";
  await page.goto(base + "checks");
  await page.locator("#profile-editor summary").waitFor({ state: "visible" });
  assert.strictEqual(await page.locator("#check-kind").inputValue(), "preflight", "首个快照未初始化入口类型");
  await page.locator("#profile-editor summary").click();
  await page.locator("#save-profile").click();
  await page.waitForFunction(() => document.querySelector("#center-message").textContent.includes("方案名称不能为空"));
  assert(!(await page.locator("#center-message").textContent()).includes("方案已保存"), "失败被提示成成功");
  await page.locator("#profile-name").fill("方案 A");
  await page.locator("#save-profile").click();
  await page.waitForFunction(() => document.querySelector("#center-message").textContent.includes("方案已保存"));
  const saved = commands.find((c) => c.action === "profile-save" && c.data.name === "方案 A");
  assert(saved && saved.data.clientID, "命令缺少 clientID");

  await page.goto(base + "locator");
  await page.waitForFunction(() => document.querySelector("#locator-items").options.length === 1);
  await page.locator("#locator-annotation").selectOption("ANNO1234");
  assert.strictEqual(await page.locator("#locator-page").inputValue(), "7");
  await page.locator("#locator-text").fill("42-45");
  await page.locator("#save-locator").click();
  await page.waitForFunction(() => document.querySelector("#locator-info").textContent.includes("定位已保存"));
  const located = commands.find((c) => c.action === "locator-save");
  assert(located && located.data.page === 7 && located.data.annotation === "ANNO1234" && located.data.locator === "42-45");

  await page.setViewportSize({ width: 360, height: 700 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert(overflow <= 1, "360px 窗口横向溢出=" + overflow);
  assert.deepStrictEqual(errors, [], "页面脚本错误：" + errors.join("；"));
  console.log("WPS 引文中心 E2E：入口初始化 / 成功与失败反馈 / PDF 定位 / 360px 全部通过");
  await browser.close();
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
