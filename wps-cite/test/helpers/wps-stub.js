// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 共享 WPS jsapi 桩（P0–P2 测试专用）
 *
 * 目标：给 addon/js/* 一个**可注入差异**的宿主模型，能复现 PRD §7 要求的四类 jsapi 差异：
 *   1) 属性不存在      —— `faults.footnotes = "missing"`（delete 该属性）
 *   2) 调用抛错        —— `faults.footnoteAdd = "throw"`
 *   3) 返回 null       —— `faults.fieldAdd = "null"`
 *   4) 行为不完整      —— `faults.textWrite = "ignore"` / `faults.noteConvert = "incomplete"`
 *
 * 文档模型是"多故事"的（正文 + 脚注 + 尾注），因为 P0 的核心就是把域从"只有正文"扩到三个容器：
 *   doc.Fields                → 正文故事里的域（Word 语义：Document.Fields 只含正文）
 *   note.Range.Fields         → 该条注正文里的域
 *   note.Index / note.Reference.Start → 真实注序号与正文锚点（跨容器排序用）
 *
 * 加载顺序严格按 index.html，避免"文件顺序依赖"在测试里被掩盖。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ADDON = path.resolve(__dirname, "..", "..", "addon");

// 与 addon/index.html 完全一致
const ORDER = [
  "version.js",
  "js/codes.js",
  "js/styles/util.js",
  "js/styles/gb7714.js",
  "js/styles/apa.js",
  "js/model.js",
  "js/capabilities.js",
  "js/settings.js",
  "js/audit.js",
  "js/links.js",
  "js/zfields.js",
  "js/zotero.js",
  "js/doc.js",
  "js/field-scanner.js",
  "js/bibliography-map.js",
  "js/recovery.js",
  "js/health.js",
  "js/nav.js",
  "js/context.js",
  "js/manager.js",
  "js/citation-tools.js",
  "js/export-tools.js",
  "js/external.js",
  "js/diag.js",
  "js/app.js",
  "js/integration.js",
];

const FONT_FLAGS = ["Superscript", "Subscript", "Italic", "Bold", "SmallCaps", "Underline",
  "StrikeThrough", "DoubleStrikeThrough", "Outline", "Shadow", "Emboss", "Engrave", "AllCaps", "Hidden"];

/* ------------------------------------------------------------------ */
/* 域 / 注 / 文档                                                      */
/* ------------------------------------------------------------------ */

function makeFont(overrides) {
  const font = {};
  for (const flag of FONT_FLAGS) font[flag] = false;
  return Object.assign(font, overrides || {});
}

/**
 * 域桩。Code.Text 与 Result.Text 都是访问器，便于复现「截断 / 静默丢弃 / 读取抛错」。
 * @param {object} host  {faults}
 * @param {object} opts  {start, code, text, container, onDelete, font, rich}
 */
function makeField(host, opts) {
  const o = opts || {};
  const faults = host.faults;
  let raw = String(o.code == null ? "" : o.code);
  let text = String(o.text == null ? "" : o.text);
  const field = { __container: o.container || "body", __deleted: false, __unlinked: false, __pfWrites: [] };

  const result = {
    Start: Number(o.start) || 0,
    End: (Number(o.start) || 0) + text.length,
    Font: makeFont(o.font),
    Select() { host.state.selection = { Start: result.Start, End: result.End }; },
    ParagraphFormat: {
      LeftIndent: 0,
      FirstLineIndent: 0,
      __writes: field.__pfWrites,
    },
  };

  Object.defineProperty(result, "Text", {
    configurable: true,
    get() {
      if (faults.textRead === "throw") throw new Error("桩：Result.Text 读取失败");
      if (faults.textRead === "null") return null;
      return text;
    },
    set(v) {
      if (faults.textWrite === "throw") throw new Error("桩：Result.Text 写入失败");
      if (faults.textWrite === "ignore") return;                       // 行为不完整：写入被静默丢弃
      if (host.textFailNext > 0) { host.textFailNext -= 1; return; }   // 只失败一次（后续恢复写要能成功）
      const s = String(v == null ? "" : v);
      text = faults.textWrite === "partial" ? s.slice(0, Math.max(0, s.length - 1)) : s;
      result.End = result.Start + text.length;
    },
  });

  if (faults.richText !== "missing") {
    Object.defineProperty(result, "FormattedText", {
      configurable: true,
      get() {
        if (faults.richText === "throw") throw new Error("桩：FormattedText 不可用");
        return { __opaque: true, text: text };
      },
      set(value) {
        if (faults.richText === "throw") throw new Error("桩：FormattedText 写入失败");
        // 真实宿主把富文本落成结果文本；桩里用 text 字段承载，便于 convertOne 回读校验
        text = value && value.text != null ? String(value.text) : String(value == null ? "" : value);
        result.End = result.Start + text.length;
      },
    });
  }

  Object.defineProperty(field, "Result", { configurable: true, value: result });
  Object.defineProperty(field, "Code", {
    configurable: true,
    value: {
      get Text() {
        if (faults.codeRead === "throw") throw new Error("桩：Code.Text 读取失败");
        return raw;
      },
      set Text(v) {
        if (faults.codeWrite === "throw") throw new Error("桩：Code.Text 写入失败");
        if (faults.codeWrite === "ignore") return;                     // 行为不完整：域代码没写进去
        const s = String(v == null ? "" : v);
        if (host.truncateCode > 0) raw = s.slice(0, host.truncateCode);
        else if (host.truncateNextCode > 0) {                          // 只截断接下来 N 次写（后续恢复写要能成功）
          host.truncateNextCode -= 1;
          raw = s.slice(0, host.truncateNextLen);
        } else raw = s;
      },
    },
  });
  field.Delete = function () {
    field.__deleted = true;
    if (typeof o.onDelete === "function") o.onDelete(field);
  };
  field.Unlink = function () {
    // Unlink 语义：保留显示文本，去掉域。桩里标记 + 从容器移除（文本由 Content.Text 承载）
    field.__unlinked = true;
    if (typeof o.onDelete === "function") o.onDelete(field);
  };
  return field;
}

function reindex(list) {
  list.forEach(function (note, i) { note.Index = i + 1; });
}

function makeNote(host, kind, opts) {
  const o = opts || {};
  const faults = host.faults;
  const note = { __kind: kind, __fields: [], Index: 0, Reference: { Start: Number(o.refStart) || 0, End: Number(o.refStart) || 0 } };
  Object.defineProperty(note, "Range", {
    configurable: true,
    get() {
      const range = {
        Start: 0,
        End: 0,
        __note: note,
        Select() {},
        Collapse() {},
        Fields: {
          get Count() { return note.__fields.length; },
          Item(i) { return note.__fields[i - 1] || null; },
          Add(r, type, codeText) {
            if (faults.noteFieldAdd === "throw") throw new Error("桩：注内 Fields.Add 抛错");
            return host.addField(note, r, codeText);
          },
        },
      };
      return range;
    },
  });
  note.Delete = function () {
    if (faults.noteDelete === "missing") { throw new TypeError("note.Delete is not a function"); }
    if (faults.noteDelete === "throw") throw new Error("桩：note.Delete 失败");
    const list = host.state.notes[kind];
    const i = list.indexOf(note);
    if (i >= 0) list.splice(i, 1);
    reindex(host.state.notes.footnote);
    reindex(host.state.notes.endnote);
  };
  if (faults.noteDelete === "absent") delete note.Delete;          // 完全不存在（typeof 亦不是 function）
  if (faults.noteConvert !== "missing") {
    note.Convert = function () {
      if (faults.noteConvert === "throw") throw new Error("桩：note.Convert 抛错");
      if (faults.noteConvert === "incomplete") return;                  // 行为不完整：什么都没变
      const other = kind === "footnote" ? "endnote" : "footnote";
      const list = host.state.notes[kind], i = list.indexOf(note);
      if (i >= 0) list.splice(i, 1);
      note.__kind = other;
      host.state.notes[other].push(note);
      reindex(host.state.notes.footnote);
      reindex(host.state.notes.endnote);
    };
  }
  return note;
}

function noteCollection(host, kind) {
  const faults = host.faults;
  const key = kind === "footnote" ? "footnotes" : "endnotes";
  return {
    get Count() { return host.state.notes[kind].length; },
    Item(i) { return host.state.notes[kind][i - 1] || null; },
    Add(range, text) {
      const fault = faults[key + "Add"];
      if (fault === "throw") throw new Error("桩：" + kind + " 集合 Add 抛错");
      if (fault === "null") return null;
      if (fault === "incomplete") return { Index: 1 };                 // 没有 Range
      const note = makeNote(host, kind, { refStart: Number(range && range.Start) || 0 });
      host.state.notes[kind].push(note);
      reindex(host.state.notes[kind]);
      return note;
    },
  };
}

function makeDocument(host, cfg) {
  const faults = host.faults;

  const props = {
    get Count() { return host.state.props.length; },
    Item(i) { return host.state.props[i - 1] || null; },
    Add(name, linkToContent, type, value) {
      if (faults.docProps === "throw") throw new Error("桩：CustomDocumentProperties.Add 抛错");
      const p = { Name: String(name), __v: host.clampProp(value) };
      Object.defineProperty(p, "Value", {
        configurable: true,
        get() { return p.__v; },
        set(v) { p.__v = host.clampProp(v); },
      });
      host.state.props.push(p);
      return p;
    },
  };

  const bookmarks = {
    get Count() { return host.state.bookmarks.length; },
    Item(i) {
      if (typeof i === "string") return host.state.bookmarks.find(function (b) { return b.Name === i; }) || null;
      return host.state.bookmarks[i - 1] || null;
    },
    Exists(name) { return host.state.bookmarks.some(function (b) { return b.Name === name; }); },
    Add(name, range) {
      if (faults.bookmarkAdd === "throw") throw new Error("桩：Bookmarks.Add 抛错");
      const bm = {
        Name: String(name),
        Range: range || { Start: 0, End: 0 },
        Delete() { const i = host.state.bookmarks.indexOf(bm); if (i >= 0) host.state.bookmarks.splice(i, 1); },
      };
      host.state.bookmarks.push(bm);
      return bm;
    },
  };

  const doc = {
    FullName: cfg.path == null ? "C:/tmp/papilot-wps.docx" : String(cfg.path),
    CustomDocumentProperties: props,
    Bookmarks: bookmarks,
    get Content() {
      if (faults.content === "throw") throw new Error("桩：Content 不可用");
      return host.content;
    },
    get Fields() {
      if (faults.bodyFields === "throw") throw new Error("桩：Document.Fields 不可用");
      return bodyFields;
    },
    Range(s, e) {
      if (faults.range === "throw") throw new Error("桩：Document.Range 不可用");
      return host.bodyRange(Number(s) || 0, Number(e) || Number(s) || 0);
    },
    Activate() { host.state.activated += 1; },
    Save() {},
  };
  if (cfg.saved !== false) doc.Saved = true;
  if (cfg.paragraphs) {
    const paragraphs = cfg.paragraphs.map(function (p, i) {
      return { OutlineLevel: Number(p.outlineLevel) || 0, Style: p.style || "",
        Range: { Start: Number(p.start) || 0, End: Number(p.end) || Number(p.start) || 0, Text: String(p.text || "") } };
    });
    doc.Paragraphs = { get Count() { return paragraphs.length; }, Item(i) { return paragraphs[i - 1] || null; } };
  }

  const bodyFields = {
    get Count() { return host.state.bodyFields.length; },
    Item(i) { return host.state.bodyFields[i - 1] || null; },
    Add(range, type, codeText) {
      const fault = faults.fieldAdd;
      if (fault === "throw") throw new Error("桩：Fields.Add 抛错");
      if (fault === "null") return null;
      if (fault === "incomplete") {
        // 行为不完整：返回一个没有 Result.Text 的"域"，写文本会失败
        const half = { Code: { Text: String(codeText || "") }, Delete() {} };
        Object.defineProperty(half, "Result", { configurable: true, value: { Start: 0, End: 0, Font: makeFont() } });
        delete half.Result.Text;
        host.state.bodyFields.push(half);
        return half;
      }
      const inNote = range && range.__note;
      if (inNote) return host.addField(inNote, range, codeText);
      return host.addField(null, range, codeText);
    },
  };

  // 注集合按故障模式装配（"missing" = 属性不存在；"throw"/"null" 在读取时体现）
  for (const [name, kind] of [["Footnotes", "footnote"], ["Endnotes", "endnote"]]) {
    const fault = faults[kind === "footnote" ? "footnotes" : "endnotes"];
    if (fault === "missing") continue;
    const value = noteCollection(host, kind);
    Object.defineProperty(doc, name, {
      configurable: true,
      get() {
        if (fault === "throw") throw new Error("桩：" + name + " 不可用");
        if (fault === "null") return null;
        return value;
      },
    });
  }
  return doc;
}

/* ------------------------------------------------------------------ */
/* 世界                                                                */
/* ------------------------------------------------------------------ */

function ok(text) {
  return { ok: true, status: 200, text: async function () { return text; } };
}

/**
 * 建一个隔离沙箱世界。
 * cfg:
 *   path / contentText / selection {start,end} / docData / saved
 *   fields: [{start, code, text, font, container:"body"}]
 *   notes: {footnote:[{refStart, fields:[{code,text,font}]}], endnote:[...]}
 *   bookmarks: [{Name, Start, End}]
 *   faults: 见文件头注释
 *   truncateCode / truncateProps
 *   localStorage / config（/config 返回体）/ existingPaths（/file-exists 用）
 *   apiEvent: true 时装 wps.ApiEvent；false 时不装（→ 自动化选项应隐藏）
 */
function createWorld(cfg) {
  cfg = cfg || {};
  const state = {
    bodyFields: [],
    notes: { footnote: [], endnote: [] },
    bookmarks: [],
    props: [],
    calls: [],
    activated: 0,
    selection: { Start: cfg.selection && cfg.selection.start != null ? cfg.selection.start : 500, End: cfg.selection && cfg.selection.end != null ? cfg.selection.end : 500 },
  };
  const host = {
    state: state,
    faults: Object.assign({}, cfg.faults || {}),
    truncateCode: Number(cfg.truncateCode) || 0,
    truncateNextCode: Number(cfg.truncateNextCode) || 0,
    truncateNextLen: Number(cfg.truncateNextLen) || 40,
    textFailNext: Number(cfg.textFailNext) || 0,
    truncateProps: Number(cfg.truncateProps) || 0,
    truncateNextProps: Number(cfg.truncateNextProps) || 0,
    clampProp(value) {
      let s = String(value == null ? "" : value);
      if (host.truncateProps > 0 && s.length > host.truncateProps) s = s.slice(0, host.truncateProps);
      else if (host.truncateNextProps > 0) {
        host.truncateNextProps -= 1;
        s = s.slice(0, Math.max(1, s.length - 1));                     // 少存一个字符即可让回读不一致
      }
      return s;
    },
    content: {
      Text: cfg.contentText == null ? "正文" : String(cfg.contentText),
      Start: 0,
      End: cfg.contentEnd != null ? Number(cfg.contentEnd) : 2,
      Collapse(dir) { if (dir === 0) this.Start = this.End; else this.End = this.Start; },
      Select() { state.selection = { Start: this.Start, End: this.End }; },
      Font: makeFont(),
    },
    bodyRange(s, e) {
      const r = {
        Start: s, End: e, Font: makeFont(),
        Collapse(dir) { if (dir === 0) this.Start = this.End; else this.End = this.Start; },
        Select() { state.selection = { Start: this.Start, End: this.End }; },
      };
      Object.defineProperty(r, "Text", {
        configurable: true,
        get() { return host.content.Text.slice(r.Start, r.End); },
        set(v) {
          const s = String(v == null ? "" : v);
          const text = host.content.Text, oldStart = r.Start, oldEnd = r.End;
          const delta = s.length - (oldEnd - oldStart);
          host.content.Text = text.slice(0, oldStart) + s + text.slice(oldEnd);
          /* WPS 会随正文编辑移动后续 Range/书签；桩也必须模拟，否则第二次更新
           * 会错误地读到首次插入前的旧偏移。 */
          state.bookmarks.forEach(function (bm) {
            const range = bm.Range;
            if (range === r) return;
            if (range.Start >= oldEnd) { range.Start += delta; range.End += delta; }
            else if (range.End >= oldStart && range.End <= oldEnd) range.End = oldStart + s.length;
          });
          state.bodyFields.forEach(function (field) {
            const range = field.Result;
            if (range !== r && range.Start >= oldEnd) { range.Start += delta; range.End += delta; }
          });
          r.End = oldStart + s.length;
          host.content.End = host.content.Text.length;
          state.selection = { Start: r.End, End: r.End };
        },
      });
      return r;
    },
    addField(note, range, codeText) {
      const start = note ? note.__fields.length * 20 : Number(range && range.Start) || 0;
      const field = makeField(host, {
        start: start,
        code: codeText,
        text: note ? "" : host.content.Text.slice(start, start),
        onDelete(f) {
          const list = note ? note.__fields : state.bodyFields;
          const i = list.indexOf(f);
          if (i >= 0) list.splice(i, 1);
        },
      });
      if (note) note.__fields.push(field); else state.bodyFields.push(field);
      return field;
    },
  };

  const doc = makeDocument(host, cfg);

  // 预置正文域
  (cfg.fields || []).forEach(function (seed) {
    const field = makeField(host, {
      start: seed.start,
      code: seed.code,
      text: seed.text,
      font: seed.font,
      onDelete(f) { const i = state.bodyFields.indexOf(f); if (i >= 0) state.bodyFields.splice(i, 1); },
    });
    state.bodyFields.push(field);
  });
  // 预置注与注内域
  ["footnote", "endnote"].forEach(function (kind) {
    (cfg.notes && cfg.notes[kind] || []).forEach(function (seed) {
      const note = makeNote(host, kind, { refStart: seed.refStart });
      state.notes[kind].push(note);
      reindex(state.notes[kind]);
      (seed.fields || []).forEach(function (f) {
        const field = makeField(host, {
          start: f.start,
          code: f.code,
          text: f.text,
          font: f.font,
          onDelete(fd) { const i = note.__fields.indexOf(fd); if (i >= 0) note.__fields.splice(i, 1); },
        });
        note.__fields.push(field);
      });
    });
  });
  (cfg.bookmarks || []).forEach(function (b) {
    state.bookmarks.push({ Name: b.Name, Range: { Start: b.Start, End: b.End }, Delete() { const i = state.bookmarks.indexOf(this); if (i >= 0) state.bookmarks.splice(i, 1); } });
  });
  if (cfg.docData != null) {
    // 走真实属性集合，让后续改写也受 truncateProps / truncateNextProps 约束
    doc.CustomDocumentProperties.Add("ZoteroDocData", false, 4, cfg.docData);
  }

  const selectionRange = {
    Text: "",
    get Start() { return state.selection.Start; },
    set Start(v) { state.selection.Start = Number(v) || 0; },
    get End() { return state.selection.End; },
    set End(v) { state.selection.End = Number(v) || 0; },
    Collapse() {},
    Select() {},
  };
  const app = {
    ActiveDocument: doc,
    Documents: { get Count() { return 1; }, Item() { return doc; } },
    Selection: { Range: selectionRange },
  };

  const localStorage = cfg.localStorage || {
    __data: new Map(),
    getItem(k) { return this.__data.has(k) ? this.__data.get(k) : null; },
    setItem(k, v) { this.__data.set(k, String(v)); },
    removeItem(k) { this.__data.delete(k); },
  };

  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    AbortController,
    URLSearchParams,
    alert: function () {},
    localStorage,
    wps: { WpsApplication: function () { return app; } },
  };
  sandbox.wps.ribbonUI = { Invalidate() {} };
  if (cfg.apiEvent) {
    const listeners = {};
    sandbox.wps.ApiEvent = {
      AddApiEventListener(name, fn) { (listeners[name] = listeners[name] || []).push(fn); },
      __fire(name, arg) { (listeners[name] || []).forEach(function (fn) { fn(arg); }); },
      __count(name) { return (listeners[name] || []).length; },
    };
  }
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  /* 网络：/log、/config、/file-exists 直接应答；Zotero 事务由 setZotero() 装 */
  const zotero = { script: null, opts: null, i: 0, steps: [], exec: 0, lastFieldId: null, fieldIds: [] };
  const http = {
    config: cfg.config || {},
    existingPaths: (cfg.existingPaths || []).map(String),
    handler: cfg.httpHandler || null,
  };

  sandbox.fetch = async function (url, options) {
    const p = String(url).replace(/^http:\/\/127\.0\.0\.1:21932/, "");
    state.calls.push(p);
    if (p.indexOf("/log") === 0) return ok("{}");
    if (p.indexOf("/config") === 0) {
      if ((options && options.method || "GET").toUpperCase() === "POST") {
        try { Object.assign(http.config, JSON.parse(options.body || "{}")); } catch (e) { /* 忽略坏体 */ }
        return ok("{}");
      }
      return ok(JSON.stringify(http.config));
    }
    if (p.indexOf("/file-exists") === 0) {
      let target = "";
      try { target = String(JSON.parse(options.body || "{}").path || ""); } catch (e) { target = ""; }
      const exists = http.existingPaths.some(function (x) { return normalizePath(x) === normalizePath(target); });
      return ok(JSON.stringify({ exists: exists }));
    }
    if (http.handler) {
      const custom = await http.handler(p, options, { ok: ok, state: state });
      if (custom !== undefined) return custom;
    }
    if (zotero.script) return zoteroRespond(zotero, p, options);
    if (p.indexOf("/connector/document/execCommand") >= 0) return ok(JSON.stringify({ command: "Document.complete", arguments: [] }));
    return ok("{}");
  };

  for (const rel of ORDER) {
    vm.runInContext(fs.readFileSync(path.join(ADDON, rel), "utf8"), sandbox, { filename: rel });
  }

  const world = {
    sandbox, doc, app, host, state, http, zotero,
    I: sandbox.PPIntegration,
    get R() { return sandbox.PPRecovery; },
    get S() { return sandbox.PPFieldScanner; },
    get H() { return sandbox.PPHealth; },
    get N() { return sandbox.PPNav; },
    get M() { return sandbox.PPManager; },
    get T() { return sandbox.PPExportTools; },
    get E() { return sandbox.PPExternal; },
    get A() { return sandbox.PPAudit; },
    get Settings() { return sandbox.PPSettings; },
    get App() { return sandbox.PPApp; },
    get ZF() { return sandbox.PPZFields; },
    get BM() { return sandbox.PPBibliographyMap; },
    get Caps() { return sandbox.PPCapabilities; },
    get Ctx() { return sandbox.PPContext; },
    get L() { return sandbox.PPLinks; },
    /** 装一份 Zotero 侧的脚本化会话（模仿反向 RPC 乒乓） */
    setZotero(script, opts) {
      zotero.script = script; zotero.opts = opts || {}; zotero.i = 0; zotero.steps = []; zotero.exec = 0;
      zotero.lastFieldId = null; zotero.fieldIds = [];
      return zotero;
    },
    normalizePath,
    fieldByCode(needle) {
      return state.bodyFields.find(function (f) { return String(f.Code.Text || "").indexOf(needle) >= 0; }) || null;
    },
    noteField(container, noteIndex) {
      const kind = container === "footnote" ? "footnote" : "endnote";
      const note = state.notes[kind][noteIndex - 1];
      return note && note.__fields[0] || null;
    },
    snapshot() {
      return {
        body: state.bodyFields.map(function (f) { return String(f.Code.Text || ""); }),
        notes: {
          footnote: state.notes.footnote.map(function (n) { return n.__fields.map(function (f) { return String(f.Code.Text || ""); }); }),
          endnote: state.notes.endnote.map(function (n) { return n.__fields.map(function (f) { return String(f.Code.Text || ""); }); }),
        },
        selection: { Start: state.selection.Start, End: state.selection.End },
        contentText: host.content.Text,
        props: state.props.map(function (p) { return String(p.Value); }),
        bookmarks: state.bookmarks.map(function (b) { return b.Name; }),
      };
    },
  };
  return world;
}

function normalizePath(value) {
  return String(value == null ? "" : value).trim().replace(/^["']|["']$/g, "").replace(/\//g, "\\").toLocaleLowerCase();
}

/* ------------------------------------------------------------------ */
/* Zotero 侧脚本回放                                                    */
/* ------------------------------------------------------------------ */

function resolveArgs(st, args) {
  return (args || []).map(function (a) {
    if (a === "@field") return st.lastFieldId;
    const m = typeof a === "string" && /^@f(\d+)$/.exec(a);
    if (m) return st.fieldIds[Number(m[1])];
    if (a && a.__array === "fieldIds") return st.fieldIds.slice();
    return a;
  });
}

function nextCommand(st) {
  const step = st.script[st.i];
  if (!step) return null;
  st.i += 1;
  return { command: step.cmd, arguments: resolveArgs(st, step.args) };
}

async function zoteroRespond(st, p, options) {
  const body = options && options.body != null ? JSON.parse(options.body) : null;
  if (p.indexOf("/connector/document/execCommand") >= 0) {
    st.exec += 1;
    if (st.opts.failExec) return { ok: false, status: 503, text: async function () { return "busy"; } };
    if (st.opts.hangExec) return new Promise(function () { /* 永不返回：模拟超时 */ });
    const cmd = nextCommand(st);
    return ok(JSON.stringify(cmd || {}));
  }
  // respond：body 是上一条命令的返回值
  const answering = st.script[st.i - 1];
  st.steps.push({ cmd: answering ? answering.cmd : "(unknown)", payload: body });
  if (answering) {
    if (answering.cmd === "Document.insertField") st.lastFieldId = body && body.id;
    if (answering.cmd === "Document.getFields") st.fieldIds = (Array.isArray(body) ? body : []).map(function (f) { return f && f.id; });
  }
  if (answering && /complete/.test(String(answering.cmd)) && st.opts.failComplete) {
    return { ok: false, status: 500, text: async function () { return "complete-failed"; } };
  }
  const next = nextCommand(st);
  if (!next) return ok(" ");
  return ok(JSON.stringify(next));
}

/* ------------------------------------------------------------------ */
/* 便捷常量                                                            */
/* ------------------------------------------------------------------ */

const LIB = "http://zotero.org/users/local/1234";
const DOCID = "papilot-wps-doc";

function itemCode(citationID, keys, extra) {
  const data = extra && extra.itemData || {};
  const items = (keys || ["KEY1"]).map(function (k) {
    const key = typeof k === "string" ? k : k.key;
    const ci = { id: /^https?:/.test(key) ? key : LIB + "/items/" + key };
    const payload = (typeof k === "object" && k.itemData) || data[key];
    if (payload) ci.itemData = payload;
    return ci;
  });
  const json = Object.assign({
    citationID: citationID,
    properties: { formattedCitation: extra && extra.formattedCitation || "" },
    citationItems: items,
  }, extra && extra.json || {});
  return "ITEM CSL_CITATION " + JSON.stringify(json);
}
function wordItemCode(citationID, keys, extra) {
  return "ADDIN ZOTERO_ITEM CSL_CITATION " + itemCode(citationID, keys, extra).slice("ITEM CSL_CITATION ".length);
}
function biblCode(extra) {
  return "BIBL " + JSON.stringify(Object.assign({ uncited: [], omitted: [], custom: [] }, extra || {})) + " CSL_BIBLIOGRAPHY";
}
function wordBiblCode(extra) {
  return "ADDIN ZOTERO_BIBL " + JSON.stringify(Object.assign({ uncited: [], omitted: [], custom: [] }, extra || {})) + " CSL_BIBLIOGRAPHY";
}

module.exports = {
  ADDON, ORDER, DOCID, LIB, FONT_FLAGS,
  createWorld, makeFont, normalizePath,
  itemCode, wordItemCode, biblCode, wordBiblCode,
};
