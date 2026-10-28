// 功能区的按钮必须"三处对齐"，漏一处就是点了没反应的哑按钮：
//   ribbon.xml 里的 <button id>  ←→  app.js 的 OnAction 分发表  ←→  GetImage 图标
// 这三样都是手写的、分属不同段落，最容易在加按钮时漏掉一个。
// 本测试纯静态（读源码做比对），不需要 WPS，也不会发网络请求。
const fs = require("fs");
const path = require("path");

const ADDON = path.resolve(__dirname, "..", "addon");
const ribbon = fs.readFileSync(path.join(ADDON, "ribbon.xml"), "utf8");
const appJs = fs.readFileSync(path.join(ADDON, "js", "app.js"), "utf8");

let failed = 0;
let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log("  PASS " + name);
  } catch (e) {
    failed += 1;
    console.log("  FAIL " + name + " -> " + ((e && e.message) || e));
  }
}

const ribbonIds = [...ribbon.matchAll(/<button\s+id="([^"]+)"/g)].map((m) => m[1]);
const menuIds = [...ribbon.matchAll(/<menu\s+id="([^"]+)"/g)].map((m) => m[1]);
const expectedRibbonIds = [
  "btnCite", "btnBib", "btnRefresh", "btnRefreshStatus", "btnContext",
  "btnStyleGB", "btnStyleAPA", "btnStyleNature", "btnStyleIEEE", "btnRecent1", "btnRecent2", "btnRecent3", "btnPrefs",
  "btnNavPrev", "btnNavNext", "btnNavList", "btnNavBack", "btnSamePrev", "btnSameNext", "btnToBib", "btnToCitation",
  "btnGoto", "btnFind", "btnPreflight", "btnCompat", "btnAudit", "btnUnlinked", "btnBatch", "btnHealth",
  "btnUncited", "btnAutomation", "btnDiag", "btnAbout",
  "btnLocator", "btnChapterBib", "btnFavorite1", "btnFavorite2", "btnFavorite3", "btnStyleFavorites", "btnConnection",
];

// 分发表：OnAction 里那一串 `btnXxx: () => ...`（缩进 6 个空格，避免误抓别处的对象字面量）
const dispatchIds = [...appJs.matchAll(/^ {6}(btn[A-Za-z0-9]+):\s*\(\)/gm)].map((m) => m[1]);

// 图标表：GetImage 里的 `btnXxx: "img/xxx.svg"`
// 注意别加行首锚点 —— 那张表里一行写了多个条目（btnCite / btnRefresh / btnBib 在同一行）
const iconPairs = [...appJs.matchAll(/((?:btn|menu)[A-Za-z0-9]+):\s*"(img\/[^"]+)"/g)];
const iconIds = iconPairs.map((m) => m[1]);
const iconFiles = iconPairs.map((m) => m[2]);

check("ribbon.xml 能被解析出按钮", () => {
  if (!ribbonIds.length) throw new Error("没解析到任何 <button id>");
});

check("33 个既有命令与 7 个新增命令全部保留且没有重复入口", () => {
  const missing = expectedRibbonIds.filter((id) => ribbonIds.indexOf(id) < 0);
  const extra = ribbonIds.filter((id) => expectedRibbonIds.indexOf(id) < 0);
  const duplicate = ribbonIds.filter((id, i) => ribbonIds.indexOf(id) !== i);
  if (missing.length || extra.length || duplicate.length || ribbonIds.length !== expectedRibbonIds.length) {
    throw new Error("缺失=" + missing.join(",") + "；新增=" + extra.join(",") + "；重复=" + duplicate.join(","));
  }
});

check("功能区收敛为 3 个任务组、12 个顶层控件", () => {
  const groups = (ribbon.match(/<group\s/g) || []).length;
  let menuDepth = 0, topLevel = 0;
  ribbon.split(/\r?\n/).forEach((line) => {
    const text = line.trim();
    if (menuDepth === 0 && /^<(button|menu)\s/.test(text)) topLevel += 1;
    if (/^<menu\s/.test(text)) menuDepth += 1;
    if (/^<\/menu>/.test(text)) menuDepth -= 1;
  });
  if (groups !== 3 || topLevel !== 12 || menuDepth !== 0) {
    throw new Error("组=" + groups + "；顶层=" + topLevel + "；菜单闭合深度=" + menuDepth);
  }
});

check("仅 6 个高频主命令使用大按钮，归并菜单保持普通尺寸", () => {
  const largeIds = [...ribbon.matchAll(/<button\b[\s\S]*?\/>/g)].filter((m) => m[0].indexOf('size="large"') >= 0)
    .map((m) => (/id="([^"]+)"/.exec(m[0]) || [])[1]);
  const expected = ["btnCite", "btnBib", "btnRefresh", "btnPrefs", "btnNavList", "btnPreflight"];
  if (largeIds.join(",") !== expected.join(",")) throw new Error("大按钮实际为：" + largeIds.join(", "));
  if (/<menu\b[^>]*size="large"/.test(ribbon)) throw new Error("归并菜单仍使用大尺寸");
});

check("归并菜单都有图标，动态样式与自动化回调仍保留", () => {
  const missingIcons = menuIds.filter((id) => iconIds.indexOf(id) < 0);
  if (missingIcons.length) throw new Error("菜单缺图标：" + missingIcons.join(", "));
  for (const token of ["getLabel=\"PPApp.GetLabel\"", "getEnabled=\"PPApp.GetEnabled\"", "getVisible=\"PPApp.GetVisible\""]) {
    if (ribbon.indexOf(token) < 0) throw new Error("丢失动态回调 " + token);
  }
});

check("每个功能区按钮都在 OnAction 分发表里（否则点了没反应）", () => {
  const miss = ribbonIds.filter((id) => dispatchIds.indexOf(id) < 0);
  if (miss.length) throw new Error("缺分发：" + miss.join(", "));
});

check("每个功能区按钮都有图标映射", () => {
  const miss = ribbonIds.filter((id) => iconIds.indexOf(id) < 0);
  if (miss.length) throw new Error("缺图标：" + miss.join(", "));
});

check("图标文件真实存在（路径写错功能区就是空白）", () => {
  const uniq = [...new Set(iconFiles)];
  const miss = uniq.filter((p) => !fs.existsSync(path.join(ADDON, p)));
  if (miss.length) throw new Error("文件不存在：" + miss.join(", "));
});

check("分发表里没有多余按钮（改名后留下的死条目）", () => {
  const extra = dispatchIds.filter((id) => ribbonIds.indexOf(id) < 0);
  if (extra.length) throw new Error("多余分发：" + extra.join(", "));
});

check("index.html 加载了工具箱模块（nav / diag）", () => {
  const html = fs.readFileSync(path.join(ADDON, "index.html"), "utf8");
  for (const f of ["js/nav.js", "js/diag.js"]) {
    if (html.indexOf(f) < 0) throw new Error("index.html 没加载 " + f);
  }
  // 顺序：这两个模块只依赖 PPDoc，必须排在 doc.js 之后、integration.js 之前或同时，
  // 但不能排在 doc.js 之前（app.js 里是懒调用，但加载顺序错会在启动时炸）
  const iDoc = html.indexOf("js/doc.js");
  const iNav = html.indexOf("js/nav.js");
  const iDiag = html.indexOf("js/diag.js");
  if (!(iDoc >= 0 && iDoc < iNav && iDoc < iDiag)) {
    throw new Error("nav.js / diag.js 必须排在 doc.js 之后");
  }
});

check("工具箱模块文件存在", () => {
  for (const f of ["js/nav.js", "js/diag.js"]) {
    const p = path.join(ADDON, f);
    if (!fs.existsSync(p)) throw new Error("缺文件 " + f);
    if (!fs.readFileSync(p, "utf8").trim()) throw new Error(f + " 是空文件");
  }
});

check("管理窗格暴露全部 7 种单条命令与 4 种批量打开方式", () => {
  const page = fs.readFileSync(path.join(ADDON, "js", "manager-page.js"), "utf8");
  const html = fs.readFileSync(path.join(ADDON, "manager.html"), "utf8");
  for (const action of ["locate", "edit", "bibliography", "source", "pdf", "zotero", "info"]) {
    if (page.indexOf('data-action="' + action + '"') < 0) throw new Error("管理行缺少命令 " + action);
    if (appJs.indexOf('command.action === "' + action + '"') < 0) throw new Error("主页面不再处理 " + action);
  }
  for (const kind of ["zotero", "pdf", "doi", "attachment"]) {
    if (html.indexOf('data-kind="' + kind + '"') < 0) throw new Error("批量入口缺少 " + kind);
  }
});

check("新增功能复用现有菜单和引文中心，不新增顶层按钮", () => {
  for (const id of ["btnLocator", "btnChapterBib", "btnFavorite1", "btnFavorite2", "btnFavorite3", "btnStyleFavorites", "btnConnection"]) {
    if (ribbonIds.indexOf(id) < 0) throw new Error("缺少新入口 " + id);
  }
  const html = fs.readFileSync(path.join(ADDON, "manager.html"), "utf8");
  for (const id of ["view-checks", "view-crossdoc", "view-settings", "view-locator", "js/center-page.js"]) {
    if (html.indexOf(id) < 0) throw new Error("引文中心缺少 " + id);
  }
  const index = fs.readFileSync(path.join(ADDON, "index.html"), "utf8");
  if (!(index.indexOf("js/citation-tools.js") >= 0 && index.indexOf("js/citation-tools.js") < index.indexOf("js/app.js"))) {
    throw new Error("citation-tools.js 必须在 app.js 前加载");
  }
});

check("管理与选择页面包含窄窗口、矮窗口和键盘焦点适配", () => {
  const css = fs.readFileSync(path.join(ADDON, "manager.css"), "utf8");
  const picker = fs.readFileSync(path.join(ADDON, "picker.html"), "utf8");
  for (const token of ["@media (max-width: 760px)", "@media (max-width: 420px)", "td::before", "focus-visible"]) {
    if (css.indexOf(token) < 0) throw new Error("管理页缺少适配 " + token);
  }
  for (const token of ["@media(max-width:340px)", "@media(max-height:420px)", "min-height:0", "focus-visible"]) {
    if (picker.indexOf(token) < 0) throw new Error("选择页缺少适配 " + token);
  }
});

console.log("");
console.log("通过 " + passed + " 项，失败 " + failed + " 项" + (failed ? "" : "，全部通过"));
process.exit(failed ? 1 : 0);
