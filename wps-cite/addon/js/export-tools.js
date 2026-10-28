// SPDX-License-Identifier: Apache-2.0
/* 无 Zotero 域副本（P2-2）
 *
 * 安全流程（顺序不可交换）：
 *   1. 记录原稿路径 / 域代码清单 / Zotero 文档数据 / dirty 状态；
 *   2. 生成本副本路径 `<原名>_无引文域.docx`，先经本地代理检查“文件不存在”，
 *      已存在则递增唯一名 —— WPS 的 SaveAs2 会**静默覆盖**同名文件，不能省这一步；
 *   3. SaveAs2 到副本，确认 ActiveDocument 确实是副本；
 *   4. 只对副本里的 ZOTERO_ITEM / ZOTERO_BIBL 域执行 Unlink（保留显示文本）；
 *   5. 回读副本（域数=0、非 Zotero 域不变、可见文本保留）与原稿（代码/docData/dirty 逐字不变）。
 *
 * 任一步失败：不触碰原稿、不宣称成功；已生成的半成品副本路径会如实返回。
 */
(function (root) {
  "use strict";
  const PROXY = "http://127.0.0.1:21932";
  /* 只认 Zotero 的引文/文献表域：Word 方言（ADDIN ZOTERO_ITEM / ZOTERO_BIBL）
   * 与 Zotero 内部方言（ITEM CSL_CITATION / BIBL CSL_BIBLIOGRAPHY）。
   * 其它软件也可能用 CSL_CITATION 字样，不能仅凭它删域。 */
  const ZOTERO_CODE = /(?:ZOTERO_ITEM|ZOTERO_BIBL|(?:^|\s)(?:ITEM|BIBL)\s+CSL_(?:CITATION|BIBLIOGRAPHY))\b/i;
  const inFlight = new Set();

  function deps() {
    if (!root.PPDoc) throw new Error("文档适配层未加载（doc.js 缺失）");
    return root.PPDoc;
  }
  function normalizePath(value) {
    return String(value == null ? "" : value).trim()
      .replace(/^["']|["']$/g, "").replace(/\//g, "\\").toLocaleLowerCase();
  }
  function isDocxPath(value) {
    return /\.docx$/i.test(String(value == null ? "" : value).trim());
  }
  function baseName(path) {
    const m = /^(.*)[\\/]([^\\/]+)$/.exec(String(path || ""));
    return m ? { dir: m[1], name: m[2] } : { dir: "", name: String(path || "") };
  }
  function splitExt(name) {
    const m = /^(.*?)(\.[^.]*)$/.exec(String(name || ""));
    return m ? { stem: m[1], ext: m[2] } : { stem: String(name || ""), ext: "" };
  }
  function defaultTargetPath(sourcePath) {
    const parts = baseName(sourcePath), file = splitExt(parts.name);
    const sep = String(sourcePath || "").indexOf("\\") >= 0 ? "\\" : "/";
    return (parts.dir ? parts.dir + sep : "") + file.stem + "_无引文域" + (file.ext || ".docx");
  }
  function candidatePath(sourcePath, index) {
    const parts = baseName(sourcePath), file = splitExt(parts.name);
    const sep = String(sourcePath || "").indexOf("\\") >= 0 ? "\\" : "/";
    const suffix = index > 1 ? " (" + index + ")" : "";
    return (parts.dir ? parts.dir + sep : "") + file.stem + "_无引文域" + suffix + (file.ext || ".docx");
  }
  function documentIDOf(doc) {
    try { return deps().documentID(doc); } catch (e) { return String(doc && doc.FullName || "unknown"); }
  }
  function appOf(options) {
    if (options.app) return options.app;
    return deps().app();
  }
  function activeDoc(app) {
    try { return app.ActiveDocument || null; } catch (e) { return null; }
  }
  function scanRefs(doc) {
    try { return deps().scanFieldRefs(doc) || []; } catch (e) { return []; }
  }
  function metaOf(doc, key) {
    try {
      const props = doc.CustomDocumentProperties;
      for (let i = 1; i <= Number(props.Count); i++) {
        if (String(props.Item(i).Name) === key) return String(props.Item(i).Value == null ? "" : props.Item(i).Value);
      }
    } catch (e) { /* 属性不可读时返回空 */ }
    return "";
  }
  function readDocData(doc) {
    try {
      const base = metaOf(doc, "ZoteroDocData");
      const parts = Number(metaOf(doc, "ZoteroDocDataParts"));
      if (!(parts > 1) || Math.floor(parts) !== parts) return base;
      const chunks = [base];
      for (let i = 1; i < parts; i++) chunks.push(metaOf(doc, "ZoteroDocData_" + i));
      return chunks.join("");
    } catch (e) { return ""; }
  }
  function savedOf(doc) {
    try { return typeof doc.Saved === "boolean" ? doc.Saved : null; } catch (e) { return null; }
  }
  function contentText(doc) {
    try {
      const value = doc.Content && doc.Content.Text;
      return value == null ? null : String(value);
    } catch (e) { return null; }
  }
  function noteCounts(doc) {
    const counts = { footnotes: null, endnotes: null };
    try { counts.footnotes = doc.Footnotes ? Number(doc.Footnotes.Count) : null; } catch (e) { counts.footnotes = null; }
    try { counts.endnotes = doc.Endnotes ? Number(doc.Endnotes.Count) : null; } catch (e) { counts.endnotes = null; }
    return counts;
  }
  function sameNoteCounts(a, b) {
    if (!a || !b) return null;
    if (a.footnotes == null || b.footnotes == null || a.endnotes == null || b.endnotes == null) return null;
    return a.footnotes === b.footnotes && a.endnotes === b.endnotes;
  }
  function isZoteroRef(ref) {
    return ZOTERO_CODE.test(String(ref && ref.code || ""));
  }
  function snapshotDoc(doc) {
    const refs = scanRefs(doc);
    const saved = savedOf(doc);
    return {
      path: String(doc.FullName || ""),
      normalizedPath: normalizePath(doc.FullName),
      codes: refs.map(function (r) { return String(r.code || ""); }),
      zoteroCodes: refs.filter(isZoteroRef).map(function (r) { return String(r.code || ""); }),
      nonZoteroCodes: refs.filter(function (r) { return !isZoteroRef(r); }).map(function (r) { return String(r.code || ""); }),
      docData: readDocData(doc),
      saved: saved,
      dirty: saved == null ? null : saved === false,
      contentText: contentText(doc),
      notes: noteCounts(doc),
    };
  }
  function fail(code, error, extra) {
    return Object.assign({
      ok: false, code: code, error: String(error == null ? code : error).slice(0, 400),
      originalUntouched: true, cancelled: false,
    }, extra || {});
  }

  /** 经本地代理做存在检查；代理不可用就失败，绝不允许“可能覆盖”的 SaveAs2。 */
  function pathExistsViaProxy(path, options) {
    if (typeof options.pathExists === "function") return Promise.resolve(options.pathExists(path));
    if (typeof root.fetch !== "function") return Promise.reject(new Error("fetch 不可用，无法检查目标文件是否已存在"));
    return Promise.resolve().then(function () {
      return root.fetch(PROXY + "/file-exists", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: String(path) }), cache: "no-store",
      });
    }).then(function (res) {
      if (!res || !res.ok) throw new Error("本地代理拒绝路径检查（HTTP " + (res && res.status || "未知") + "）");
      return res.json ? res.json() : res.text().then(function (text) { return JSON.parse(text || "{}"); });
    }).then(function (data) {
      if (!data || typeof data.exists !== "boolean") throw new Error("路径检查响应缺少 exists 字段");
      return !!data.exists;
    });
  }

  async function chooseTarget(sourcePath, options) {
    const explicit = options.targetPath || options.newPath;
    if (explicit) {
      const target = String(explicit).trim();
      if (!isDocxPath(target)) return { ok: false, code: "UNSUPPORTED_FORMAT", error: "目标路径必须是 .docx：" + target };
      if (normalizePath(target) === normalizePath(sourcePath)) return { ok: false, code: "TARGET_IS_SOURCE", error: "目标路径不能与原稿相同" };
      let exists = false;
      try { exists = await pathExistsViaProxy(target, options); }
      catch (e) { return { ok: false, code: "PATH_CHECK_FAILED", error: String((e && e.message) || e) }; }
      /* 显式目标已存在：要求调用方换路径，绝不静默覆盖，也不擅自改名。 */
      if (exists) return { ok: false, code: "TARGET_EXISTS", error: "目标文件已存在，请换一个路径：" + target };
      return { ok: true, path: target, index: 1, explicit: true };
    }
    const max = Number(options.maxCandidates) > 0 ? Number(options.maxCandidates) : 100;
    for (let i = 1; i <= max; i++) {
      const candidate = i === 1 ? defaultTargetPath(sourcePath) : candidatePath(sourcePath, i);
      let exists = false;
      try { exists = await pathExistsViaProxy(candidate, options); }
      catch (e) { return { ok: false, code: "PATH_CHECK_FAILED", error: String((e && e.message) || e) }; }
      if (!exists) return { ok: true, path: candidate, index: i };
    }
    return { ok: false, code: "NO_UNIQUE_NAME", error: "无法生成不重名的副本文件名（已尝试 " + max + " 个）" };
  }

  function saveAs(doc, path, options) {
    if (typeof options.saveAs === "function") { options.saveAs(doc, path); return "custom"; }
    /* 优先 SaveCopyAs / SaveAsCopy：它们只写新文件，原稿文档对象保持不变。
     * WPS 若两者都没有，再退回 SaveAs2（下面会严格核对原稿路径是否被改写）。 */
    if (typeof doc.SaveCopyAs === "function") { doc.SaveCopyAs(path); return "copy"; }
    if (typeof doc.SaveAsCopy === "function") { doc.SaveAsCopy(path); return "copy"; }
    if (typeof doc.SaveAs2 === "function") { doc.SaveAs2(path, 12); return "saveas"; }
    if (typeof doc.SaveAs === "function") { doc.SaveAs(path, 12); return "saveas"; }
    throw new Error("当前 WPS 不提供 SaveCopyAs / SaveAsCopy / SaveAs2 / SaveAs，无法另存副本");
  }
  function findOpenDocument(app, path) {
    const want = normalizePath(path);
    try {
      const docs = app.Documents;
      for (let i = 1; i <= Number(docs.Count); i++) {
        const candidate = docs.Item(i);
        if (candidate && normalizePath(candidate.FullName) === want) return candidate;
      }
    } catch (e) { /* 没有 Documents 集合时退回 ActiveDocument */ }
    return null;
  }
  function openDocument(app, path) {
    try {
      if (!app.Documents || typeof app.Documents.Open !== "function") return null;
      return app.Documents.Open(path) || null;
    } catch (e) { return null; }
  }
  function activate(doc) {
    try { if (doc && typeof doc.Activate === "function") doc.Activate(); return true; }
    catch (e) { return false; }
  }

  /**
   * 导出无 Zotero 域副本。
   * @param {object} [options]
   * @param {string} [options.sourcePath] 原稿路径（默认取当前文档 FullName）
   * @param {boolean|function} [options.confirm] 返回 false / Promise<false> 即取消
   * @param {function} [options.pathExists] 测试注入：路径存在检查
   * @param {function} [options.saveAs] 测试注入：另存实现
   * @param {function} [options.unlink] 测试注入：解除域实现
   * @returns {Promise<object>} CommandResult 形态
   */
  async function exportUnlinkedCopy(options) {
    const o = typeof options === "string" ? { targetPath: options } : (options || {});
    let doc = null, app = null;
    try {
      app = appOf(o);
      doc = o.doc || activeDoc(app) || deps().doc();
    } catch (e) {
      return fail("NO_DOCUMENT", String((e && e.message) || e));
    }
    const documentID = documentIDOf(doc);
    if (!documentID || inFlight.has(documentID)) {
      return fail("BUSY", "本文档已有一次另存操作在进行，请等它结束");
    }
    inFlight.add(documentID);
    try {
      const originalPath = String(o.sourcePath || doc.FullName || "");
      if (!String(originalPath).trim()) return fail("UNSAVED_DOCUMENT", "当前文档还没有保存到磁盘，请先保存为 .docx 再做无域副本");
      if (!isDocxPath(originalPath)) return fail("UNSUPPORTED_FORMAT", "无域副本只支持 .docx 原稿（当前：" + originalPath + "）");

      const before = snapshotDoc(doc);
      if (!before.normalizedPath) return fail("UNSAVED_DOCUMENT", "无法读取原稿路径，已停止");

      const targetPlan = await chooseTarget(originalPath, o);
      if (!targetPlan.ok) return fail(targetPlan.code, targetPlan.error, { originalUntouched: true });

      if (typeof o.confirm === "function") {
        let yes = false;
        try { yes = await o.confirm({ sourcePath: originalPath, targetPath: targetPlan.path, zoteroFields: before.zoteroCodes.length, dirty: before.dirty }); }
        catch (e) { return fail("CANCELLED", "确认对话框不可用，未执行另存", { cancelled: true }); }
        if (!yes) return { ok: false, cancelled: true, code: "CANCELLED", error: "已取消，未创建副本", originalUntouched: true, targetPath: targetPlan.path };
      }

      let saveMode = "saveas";
      try { saveMode = saveAs(doc, targetPlan.path, o); }
      catch (e) { return fail("SAVE_FAILED", "另存为副本失败：" + String((e && e.message) || e) + "；原稿未被修改", { targetPath: targetPlan.path }); }

      let copy = o.copyDoc || null;
      if (!copy && saveMode === "copy") {
        copy = findOpenDocument(app, targetPlan.path) || openDocument(app, targetPlan.path);
        if (!copy) return fail("ACTIVE_DOCUMENT_MISMATCH", "副本已写出，但无法打开副本文档进行后续处理；原稿未移除任何域", { copyPath: targetPlan.path });
        activate(copy);
      }
      if (!copy) copy = activeDoc(app);
      if (!copy) return fail("ACTIVE_DOCUMENT_MISMATCH", "另存后拿不到 ActiveDocument，已停止且未移除任何域");
      /* 必须确认“当前活动文档”就是副本，后续只操作它。 */
      let activeCopy = activeDoc(app);
      if (!activeCopy || normalizePath(activeCopy.FullName) !== normalizePath(targetPlan.path)) {
        activate(copy);
        activeCopy = activeDoc(app);
      }
      if (!activeCopy || normalizePath(activeCopy.FullName) !== normalizePath(targetPlan.path)) {
        return fail("ACTIVE_DOCUMENT_MISMATCH", "另存后当前活动文档不是副本（期望 " + targetPlan.path + "），已停止且未移除任何域");
      }
      copy = activeCopy;
      const copyPath = String(copy.FullName || "");
      if (normalizePath(copyPath) === before.normalizedPath) {
        return fail("ACTIVE_DOCUMENT_MISMATCH", "另存后活动文档仍是原稿，WPS 未创建副本；未移除任何域");
      }
      /* ★ 某些宿主把 SaveAs2 实现成“改名原稿”而不是“另存副本”。
       *   必须在移除任何域之前确认原稿路径没变、原文件仍在，否则下一步 Unlink
       *   就会毁掉原稿。宁可失败，也绝不写原稿。 */
      if (normalizePath(doc.FullName) !== before.normalizedPath) {
        return fail("ORIGINAL_PATH_CHANGED", "另存后原稿路径发生变化（WPS 的 SaveAs2 可能把原文档改名而不是复制），已停止且未移除任何域。原文件未被写入，请关闭当前副本窗口并重新打开原稿后重试");
      }
      const originalPresentBeforeUnlink = await pathExistsViaProxy(before.path, o).catch(function () { return null; });
      if (originalPresentBeforeUnlink === false) {
        return fail("ORIGINAL_MISSING", "另存后原稿文件不存在，已停止且未移除任何域；请立即检查原稿是否被 WPS 改名或移动");
      }

      const copyBefore = snapshotDoc(copy);
      if (copyBefore.zoteroCodes.length !== before.zoteroCodes.length) {
        return fail("COPY_MISMATCH", "副本中的 Zotero 域数与另存前不一致（原稿 " + before.zoteroCodes.length + "，副本 " + copyBefore.zoteroCodes.length + "），已停止移除域", { copyPath: copyPath, copyIncomplete: false });
      }
      const copyRefs = scanRefs(copy).filter(isZoteroRef);
      const fieldTexts = copyRefs.map(function (ref) { return String(ref.text == null ? "" : ref.text); });

      /* 只移除副本中的 Zotero 域；任何非 Zotero 域、注文与非域文本都不碰。 */
      const unlinkErrors = [];
      for (let i = 0; i < copyRefs.length; i++) {
        const field = copyRefs[i].field;
        try {
          if (typeof o.unlink === "function") o.unlink(field, copyRefs[i]);
          else if (field && typeof field.Unlink === "function") field.Unlink();
          else if (field && field.Code && field.Result) {
            // 没有 Unlink 的宿主：明确失败，不用 Delete（会连显示文本一起删掉）。
            throw new Error("该 WPS 版本的 Field 不支持 Unlink");
          } else throw new Error("域对象不可用");
        } catch (e) {
          unlinkErrors.push("第 " + (i + 1) + " 个 Zotero 域移除失败：" + String((e && e.message) || e));
          break;
        }
      }
      if (unlinkErrors.length) {
        return fail("UNLINK_FAILED", unlinkErrors.join("；") + "；原稿未被修改，副本可能只处理了一部分", { copyPath: copyPath, copyIncomplete: true });
      }

      const afterRefs = scanRefs(copy);
      const zoteroAfter = afterRefs.filter(isZoteroRef);
      const nonZoteroAfter = afterRefs.filter(function (r) { return !isZoteroRef(r); }).map(function (r) { return String(r.code || ""); });
      const notesAfter = sameNoteCounts(copyBefore.notes, noteCounts(copy));
      if (notesAfter === false) {
        return fail("VERIFY_FAILED", "副本的脚注/尾注数量在移除域后发生变化，已停止并如实返回路径", { copyPath: copyPath, copyIncomplete: true });
      }
      if (zoteroAfter.length !== 0) {
        return fail("VERIFY_FAILED", "副本中仍有 " + zoteroAfter.length + " 个 Zotero 域，未完成", { copyPath: copyPath, copyIncomplete: true });
      }
      if (nonZoteroAfter.join("\u0000") !== copyBefore.nonZoteroCodes.join("\u0000")) {
        return fail("VERIFY_FAILED", "副本中的非 Zotero 域发生变化，已停止并如实返回路径", { copyPath: copyPath, copyIncomplete: true });
      }

      const afterText = contentText(copy);
      let textPreserved = false, textExact = false;
      if (copyBefore.contentText != null && afterText != null) {
        textExact = copyBefore.contentText === afterText;
        textPreserved = textExact;
        if (!textExact) {
          /* 某些 WPS 的 Content.Text 会把域代码也算进去；此时退化为
           * “每个被移除域的显示文本仍能在副本中读到”，避免把正常副本判失败。 */
          textPreserved = fieldTexts.every(function (text) { return !text || afterText.indexOf(text) >= 0; });
        }
      }
      if (!textPreserved) {
        return fail("VERIFY_FAILED", "无法确认副本显示文本被完整保留（当前 WPS 未返回可核对的全文文本）", { copyPath: copyPath, copyIncomplete: true, textVerified: false });
      }

      /* 原稿回读：代码、docData、dirty 逐字不变；原文件仍在。 */
      const originalStillThere = await pathExistsViaProxy(before.path, o).catch(function () { return null; });
      const original = snapshotDoc(doc);
      const originalChecks = {
        pathUnchanged: normalizePath(doc.FullName) === before.normalizedPath,
        codesUnchanged: original.codes.join("\u0000") === before.codes.join("\u0000"),
        docDataUnchanged: original.docData === before.docData,
        dirtyUnchanged: original.saved === before.saved,
        notesUnchanged: sameNoteCounts(before.notes, original.notes),
        fileStillExists: originalStillThere,
        saved: original.saved,
        dirty: original.dirty,
      };
      const originalOk = originalChecks.pathUnchanged && originalChecks.codesUnchanged
        && originalChecks.docDataUnchanged && originalChecks.dirtyUnchanged
        && originalChecks.notesUnchanged !== false
        && originalChecks.fileStillExists !== false;
      if (!originalOk) {
        return fail("ORIGINAL_VERIFY_FAILED",
          "副本已生成，但原稿回读不一致（路径/域代码/文档数据/修改状态/文件存在性），请立即检查；未再写入任何内容",
          { copyPath: copyPath, copyIncomplete: false, originalChecks: originalChecks });
      }

      return {
        ok: true, code: "OK", copyPath: copyPath, targetPath: targetPlan.path,
        sourcePath: before.path,
        count: copyRefs.length,
        counts: {
          zoteroFieldsBefore: before.zoteroCodes.length,
          zoteroFieldsAfter: zoteroAfter.length,
          nonZoteroFields: nonZoteroAfter.length,
          removedFields: copyRefs.length,
        },
        original: originalChecks,
        textVerified: true, textExact: textExact,
        operationID: "unlinked-" + Date.now().toString(36),
        message: "已生成无引文域副本：" + copyPath,
      };
    } catch (e) {
      return fail("EXPORT_FAILED", String((e && e.message) || e));
    } finally {
      inFlight.delete(documentID);
    }
  }

  const api = {
    exportUnlinkedCopy: exportUnlinkedCopy,
    defaultTargetPath: defaultTargetPath,
    candidatePath: candidatePath,
    normalizePath: normalizePath,
    readDocData: readDocData,
    isBusy: function (documentID) { return inFlight.has(String(documentID)); },
    /* 类图里的 DocumentTools 同时拥有 openTargets；实现放在 external.js，
     * 这里做惰性转发，测试既可用 PPDocumentTools 也可用 PPExternal。 */
    openTargets: function (items, kind, options) {
      if (!root.PPExternal || typeof root.PPExternal.openTargets !== "function") {
        return Promise.resolve({ ok: false, code: "MODULE_MISSING", error: "external.js 未加载", results: [], opened: [], skipped: [], failed: [], count: 0 });
      }
      return root.PPExternal.openTargets(items, kind, options);
    },
    __reset: function () { inFlight.clear(); },
  };
  root.PPExportTools = api;
  root.PPDocumentTools = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
