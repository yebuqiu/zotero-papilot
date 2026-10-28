// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 引文导航：在文档里按位置跳「上一条 / 下一条」引文，或列出全部引文按序号跳
 *
 * 为什么单独一个文件：WPS 里域（field）只能靠 Fields 集合从头遍历，用户想核对第 37 条引文
 * 就得在几十页里手工找。这里把「域」变成可排序、可定位的列表，全部基于 Result.Start
 * 与光标 Selection.Range.Start —— 两者是同一个坐标系（文档字符偏移），可以直接比较大小。
 *
 * 依赖只有 root.PPDoc（doc.js）。不碰 wps.*，所以能在 Node 里用桩单测。
 */
(function (root) {
  "use strict";

  /**
   * 从域代码里抠出 CSL 的 JSON。
   * 域代码是「关键字 + JSON 混排」的 Word 方言（`ADDIN ZOTERO_ITEM CSL_CITATION {...}`），
   * 直接 JSON.parse 整串必失败，所以按花括号配对只取对象那一段。
   * 解析失败返回 null（不抛）——一条坏域不该让整个引文列表消失。
   */
  function cslJSON(code) {
    const s = String(code || "");
    const i = s.indexOf("{");
    if (i < 0) return null;
    let depth = 0;
    for (let j = i; j < s.length; j++) {
      if (s[j] === "{") depth++;
      else if (s[j] === "}") {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(s.slice(i, j + 1));
          } catch (e) {
            return null;
          }
        }
      }
    }
    return null;
  }

  /**
   * 从 citationItems[0].itemData 里挑出「给人看」的作者与年份。
   * 这几行只影响列表里的提示文字，任何一环缺失都退回空串：
   * **绝不允许因为元数据不规范而抛错**，否则一条域就能让导航整体不可用。
   */
  function peek(json) {
    const out = { authors: "", year: "" };
    try {
      const ci = json && json.citationItems && json.citationItems[0];
      const d = ci && ci.itemData;
      if (!d) return out;

      const creators = d.author || d.editor || d.contributor || [];
      const first = creators && creators[0];
      if (first) out.authors = String(first.family || first.literal || first.name || "");
      if (!out.authors && d.title) out.authors = String(d.title).slice(0, 20);

      const dp = d.issued && d.issued["date-parts"];
      if (dp && dp[0] && dp[0][0] != null) out.year = String(dp[0][0]);
      if (!out.year) {
        const raw = (d.issued && d.issued.raw) || d.date || "";
        const m = /(\d{4})/.exec(String(raw));
        if (m) out.year = m[1];
      }
    } catch (e) {
      /* 元数据不可信：取到多少算多少 */
    }
    return out;
  }

  /**
   * 纯函数：把 scanFields() 的结果整理成「可导航的引文列表」（按文档顺序）。
   * @param {Array<{index:number, code:string, start:number}>} fields
   * @param {(index:number)=>string} [getText] 取域结果区显示文本的回调；不传则 text 为空串
   * @returns {Array<{index:number,start:number,citationID:string,text:string,label:string,authors:string,year:string,n:number}>}
   */
  function parseCitations(fields, getText) {
    const out = [];
    const list = fields || [];
    for (let i = 0; i < list.length; i++) {
      const f = list[i] || {};
      const code = String(f.code || "");
      // 只留引文域。文献表域（CSL_BIBLIOGRAPHY）和 PAGE / REF 之类的普通域一律跳过，
      // 否则「下一条」会把用户带到参考文献列表里。
      if (code.indexOf("CSL_CITATION") < 0) continue;

      const index = Number(f.index);
      let text = "";
      if (typeof getText === "function") {
        try {
          text = String(getText(index) || "");
        } catch (e) {
          text = "";                 // 域的 Result 可能已被别的流程改掉，取不到就当空
        }
      }

      const json = cslJSON(code);    // 坏 JSON → null，本条目仍然保留
      const meta = peek(json);
      const label = text.replace(/\s+/g, " ").trim().slice(0, 12);

      out.push({
        index: index,
        field: f.field || null,
        container: f.container || "body",
        noteIndex: Number(f.noteIndex) || 0,
        noteID: f.noteID || null,
        start: Number(f.start) || 0,
        citationID: json && json.citationID ? String(json.citationID) : "",
        text: text,
        label: label,
        authors: meta.authors,
        year: meta.year,
        n: out.length + 1,
      });
    }
    return out;
  }

  function log(t, extra) {
    try {
      console.log("[PPNav] " + t + (extra ? " " + JSON.stringify(extra) : ""));
    } catch (e) { /* 没有 console 就算了 */ }
  }

  /**
   * 当前光标位置（文档字符偏移）。
   * 取不到时按 0（= 从文档开头算）处理**并记一条日志**：
   * 静默当成 0 会让「点下一条没反应」变成没法排查的玄学。
   */
  function cursor() {
    try {
      const pos = Number(root.PPDoc.app().Selection.Range.Start);
      if (!isNaN(pos)) return pos;
    } catch (e) { /* 落到下面记日志 */ }
    log("拿不到光标位置，按文档开头处理");
    return 0;
  }

  /** 域的显示文本；只用于 label 与列表，失败返回空串（导航本身不依赖它） */
  function fieldText(index) {
    try {
      const f = root.PPDoc.doc().Fields.Item(index);
      return String((f && f.Result && f.Result.Text) || "");
    } catch (e) {
      return "";
    }
  }

  function collect() {
    return parseCitations(root.PPDoc.scanFields(), fieldText);
  }

  // 每个文档独立保存最多 20 个来源位置。Range 失效后仍可按域身份重定位。
  const backStacks = new Map();
  const MAX_BACK = 20;
  function currentPosition() {
    const d = root.PPDoc.doc();
    let field = null;
    try { field = citationAtCursor(); } catch (e) { field = null; }
    let range = null;
    try { range = root.PPDoc.app().Selection.Range; } catch (e) { range = null; }
    return {
      documentID: root.PPDoc.documentID(d), container: field ? field.container : "body",
      noteID: field ? field.noteID : null, noteIndex: field ? field.noteIndex : 0,
      fieldID: field && field.citationID ? "cid:" + field.citationID : "", citationID: field ? field.citationID : "",
      index: field ? field.index : 0, start: Number(range && range.Start) || 0,
      end: Number(range && range.End) || 0,
    };
  }
  function stackFor(key) {
    if (!backStacks.has(key)) {
      let saved = [];
      try { saved = root.PPSettings ? root.PPSettings.get(key).backStack || [] : []; } catch (e) { saved = []; }
      backStacks.set(key, Array.isArray(saved) ? saved.slice(-MAX_BACK) : []);
    }
    return backStacks.get(key);
  }
  function saveStack(key) {
    if (!root.PPSettings) return;
    try { root.PPSettings.set(key, { backStack: stackFor(key).slice(-MAX_BACK) }); } catch (e) { /* 内存栈仍可用 */ }
  }
  function push(position) {
    const p = position || currentPosition();
    const key = String(p.documentID || "unknown");
    const stack = stackFor(key);
    stack.push(p);
    if (stack.length > MAX_BACK) stack.splice(0, stack.length - MAX_BACK);
    saveStack(key);
    return stack.length;
  }
  function freshField(ref) {
    if (!ref) return null;
    if (root.PPFieldScanner) {
      try {
        const scan = root.PPFieldScanner.scan(root.PPDoc.doc());
        if (ref.fieldID) {
          const exact = scan.fields.filter(function (x) { return x.fieldID === ref.fieldID; });
          if (exact.length === 1) return exact[0];
        }
        if (ref.citationID) {
          const identified = scan.fields.filter(function (x) { return x.citationID === ref.citationID; });
          if (identified.length === 1) return identified[0];
          /* ★ citationID 非空但扫描结果中未唯一命中：绝不能按 index 回退。
           *   域被删除后 index 会前移，回退会落到另一条引文上，back() 还会
           *   静默声称成功。交给调用方按 skipped 处理。 */
          return null;
        }
      } catch (e) { /* 旧导航桩/扫描异常时走兼容路径 */ }
    }
    const all = citationFields();
    /* citationID 非空时只认身份；找不到就返回 null。 */
    if (ref.citationID) {
      const matches = all.filter(function (x) { return x.citationID === ref.citationID; });
      return matches.length === 1 ? matches[0] : null;
    }
    /* 无 citationID 的旧位置（书签式记录）才允许按容器位置回退。 */
    return all.find(function (x) { return x.index === ref.index && x.container === ref.container && x.noteID === ref.noteID; }) || null;
  }
  /** 把光标落到某条引文上：先选中域结果区，再尽量滚进可视区。 */
  function jump(c, remember) {
    if (remember !== false) push();
    const target = freshField(c) || c;
    const r = target.range || (target.field || root.PPDoc.doc().Fields.Item(target.index)).Result;
    r.Select();
    try { root.PPDoc.app().ActiveWindow.ScrollIntoView(r, true); } catch (e) { /* 忽略 */ }
    return target;
  }

  function hit(c, total, wrapped) {
    const o = { ok: true, n: c.n, label: c.label, total: total };
    if (wrapped) o.wrapped = true;
    return o;
  }

  /** 跳到当前光标之后的第 1 条引文；已经在最后一条就回到第一条（循环） */
  function next() {
    try {
      const all = collect();
      if (!all.length) return { ok: false, error: "本文档还没有引文" };
      const pos = cursor();
      // 严格 >：光标经常正落在当前引文的 Result 区间里（其 start 等于或小于光标），
      // 用 >= 会把这一条再选一次，用户看到的就是「点下一条没反应」。
      let target = null;
      for (let i = 0; i < all.length; i++) {
        if (all[i].start > pos) { target = all[i]; break; }
      }
      let wrapped = false;
      if (!target) { target = all[0]; wrapped = true; }
      jump(target);
      return hit(target, all.length, wrapped);
    } catch (e) {
      return { ok: false, error: "导航失败：" + ((e && e.message) || e) };
    }
  }

  /** 跳到当前光标之前的最后 1 条引文；已经在第一条就跳到最后一条（循环） */
  function prev() {
    try {
      const all = collect();
      if (!all.length) return { ok: false, error: "本文档还没有引文" };
      const pos = cursor();
      // 严格 <：理由同 next 的注释。反过来的话，光标停在某条引文内部时
      // 会一直选中这一条，永远退不回去。
      let target = null;
      for (let i = 0; i < all.length; i++) {
        if (all[i].start < pos) target = all[i];
      }
      let wrapped = false;
      if (!target) { target = all[all.length - 1]; wrapped = true; }
      jump(target);
      return hit(target, all.length, wrapped);
    } catch (e) {
      return { ok: false, error: "导航失败：" + ((e && e.message) || e) };
    }
  }

  /**
   * 列出全部引文，输入序号跳转。
   *
   * 为什么用 prompt 而不是新开任务窗格：
   *   ① 任务窗格（CreateTaskPane / ShowDialog）会抢焦点，抢完文档的 Selection 可能变 null 或跑位，
   *      而导航恰恰靠光标算位置，「打开列表 → 光标丢了 → 选错条目」是必然的；
   *   ② prompt 是同步模态框，关掉后光标还在原处，也不需要额外页面与授权；
   *   ③ 导航是「低头看一眼编号」的操作，朴素对话框够用。
   * 代价是样式没法美化——等 WPS 提供了不抢焦点的浮层再换。
   */
  function list() {
    try {
      const all = collect();
      if (!all.length) return { ok: false, error: "本文档还没有引文" };
      if (typeof prompt !== "function") {
        return { ok: false, error: "这个 WPS 版本没有可用的输入框，请用【上一条/下一条】" };
      }

      const lines = ["共 " + all.length + " 条引文："];
      for (let i = 0; i < all.length; i++) {
        const c = all[i];
        // 序号固定显示 c.n，后面能显示什么就显示什么（label 可能为空）
        const tail = [c.label, c.authors, c.year].filter(Boolean).join(" ");
        lines.push(c.n + ". " + (tail || "(无显示文本)"));
      }
      lines.push("");
      lines.push("输入序号跳转，直接确定取消");

      let raw;
      try {
        raw = prompt(lines.join("\n"));
      } catch (e) {
        // 有的 WPS 版本 prompt 存在但一调就抛，等价于「没有输入框」
        return { ok: false, error: "这个 WPS 版本没有可用的输入框，请用【上一条/下一条】" };
      }
      if (raw == null) return { ok: false, cancelled: true };

      const s = String(raw).trim();
      if (!s) return { ok: false, cancelled: true };
      const k = Number(s);
      // 非法或越界一律当「取消」：用户已经看到提示了，再弹一个错误框只是打扰
      if (!isFinite(k) || Math.floor(k) !== k || k < 1 || k > all.length) {
        return { ok: false, cancelled: true };
      }

      const target = all[k - 1];
      jump(target);
      return hit(target, all.length, false);
    } catch (e) {
      return { ok: false, error: "导航失败：" + ((e && e.message) || e) };
    }
  }

  // 本次会话中，每个文献条目最后一次成功正向跳转的来源引文域。
  const origins = Object.create(null);

  function itemID(item) {
    return String(item && item.libType || "") + ":" + String(item && item.libId || "")
      + ":" + String(item && item.key || "");
  }

  /** 解析所有引文域，保留双向导航需要的条目与来源信息。 */
  function citationFields() {
    const out = [];
    const fields = root.PPDoc.scanFields() || [];
    for (let i = 0; i < fields.length; i++) {
      const f = fields[i] || {};
      const code = String(f.code || "");
      if (code.indexOf("CSL_CITATION") < 0) continue;
      try {
        const parsed = root.PPZFields.parseField(code);
        if (!parsed || parsed.kind !== "item") continue;
        out.push({
          field: f.field || null,
          container: f.container || "body",
          noteIndex: Number(f.noteIndex) || 0,
          noteID: f.noteID || null,
          index: Number(f.index),
          start: Number(f.start) || 0,
          citationID: String(parsed.citationID || ""),
          items: Array.isArray(parsed.items) ? parsed.items : [],
        });
      } catch (e) { /* 一条坏域不影响其他引文 */ }
    }
    return out;
  }

  /**
   * 精确查找光标所在的引文域。不能用 fieldAtCursor() 的边界容差，
   * 否则光标位于两个域之间时会把紧邻的下一域当成当前域。
   */
  function citationAtCursor() {
    const all = citationFields();
    const pos = cursor();
    for (let i = 0; i < all.length; i++) {
      try {
        const r = (all[i].field || root.PPDoc.doc().Fields.Item(all[i].index)).Result;
        if (pos >= Number(r.Start) && pos < Number(r.End)) return all[i];
      } catch (e) { /* 取不到 Result 的域不能视为命中 */ }
    }
    return null;
  }

  function noPrompt() {
    return { ok: false, error: "这个 WPS 版本没有可用的输入框，无法选择跳转目标" };
  }

  /** 多条共用一个序号选择流程；取消和非法输入均不产生跳转。 */
  function choose(lines, count) {
    if (typeof root.prompt !== "function") return { error: noPrompt().error };
    lines.push("");
    lines.push("输入序号跳转，直接确定取消");
    let raw;
    try {
      raw = root.prompt(lines.join("\n"));
    } catch (e) {
      return { error: noPrompt().error };
    }
    if (raw == null || !String(raw).trim()) return { cancelled: true };
    const k = Number(String(raw).trim());
    if (!isFinite(k) || Math.floor(k) !== k || k < 1 || k > count) {
      return { cancelled: true };
    }
    return { n: k - 1 };
  }

  /** 从正文引文跳到参考文献条目。 */
  function toBibliography(sourceOverride) {
    try {
      const source = sourceOverride || citationAtCursor();
      if (!source) return { ok: false, error: "光标不在引文上" };
      if (!source.items.length) return { ok: false, error: "当前引文没有可跳转的文献条目" };

      let n = 0;
      if (source.items.length > 1) {
        const lines = ["此引文包含 " + source.items.length + " 条文献："];
        for (let i = 0; i < source.items.length; i++) {
          const item = source.items[i];
          const data = item.itemData || {}, creators = data.author || data.editor || [];
          const first = creators[0] || {}, dates = data.issued && data.issued["date-parts"];
          const year = dates && dates[0] && dates[0][0] || (String(data.date || "").match(/\d{4}/) || [""])[0];
          lines.push((i + 1) + ". " + [data.title || item.key || "(未知条目)", first.family || first.literal || "未知作者", year || "年份未知"].join(" · "));
        }
        const picked = choose(lines, source.items.length);
        if (picked.error) return { ok: false, error: picked.error };
        if (picked.cancelled) return { ok: false, cancelled: true };
        n = picked.n;
      }

      const item = source.items[n];
      push();
      if (!root.PPDoc.gotoBibItem(item)) {
        const stack = backStacks.get(String(root.PPDoc.documentID(root.PPDoc.doc()))) || [];
        stack.pop(); // 失败导航不留在返回栈里。
        return { ok: false, error: "找不到该文献的书签，请先插入/更新文献表" };
      }
      origins[itemID(item)] = { index: source.index, citationID: source.citationID };
      return { ok: true, item: item, index: source.index, citationID: source.citationID };
    } catch (e) {
      return { ok: false, error: "跳转到参考文献失败：" + ((e && e.message) || e) };
    }
  }

  /** 从参考文献条目跳回正文引文。 */
  function toCitation() {
    try {
      const item = root.PPDoc.bibEntryAtCursor();
      if (!item) return { ok: false, error: "光标不在参考文献条目上" };

      const matches = [];
      const all = citationFields();
      for (let i = 0; i < all.length; i++) {
        const items = all[i].items;
        for (let j = 0; j < items.length; j++) {
          if (itemID(items[j]) === itemID(item)) {
            matches.push(all[i]);
            break;
          }
        }
      }
      if (!matches.length) return { ok: false, error: "没有找到引用该文献的正文引文" };

      // 优先回到本次会话正向跳转时的精确来源域；域序号变化时 citationID 仍可定位。
      const origin = origins[itemID(item)];
      let target = null;
      if (origin) {
        for (let i = 0; i < matches.length; i++) {
          if (matches[i].index === origin.index && matches[i].citationID === origin.citationID) {
            target = matches[i];
            break;
          }
        }
        if (!target && origin.citationID) {
          for (let i = 0; i < matches.length; i++) {
            if (matches[i].citationID === origin.citationID) { target = matches[i]; break; }
          }
        }
      }

      if (!target && matches.length === 1) target = matches[0];
      if (!target) {
        const lines = ["该文献有 " + matches.length + " 处正文引文："];
        for (let i = 0; i < matches.length; i++) {
          const c = matches[i];
          lines.push((i + 1) + ". " + (fieldText(c.index).replace(/\s+/g, " ").trim()
            || c.citationID || "(无显示文本)"));
        }
        const picked = choose(lines, matches.length);
        if (picked.error) return { ok: false, error: picked.error };
        if (picked.cancelled) return { ok: false, cancelled: true };
        target = matches[picked.n];
      }

      jump(target);
      return { ok: true, item: item, index: target.index, citationID: target.citationID };
    } catch (e) {
      return { ok: false, error: "跳转到正文引文失败：" + ((e && e.message) || e) };
    }
  }

  /** 返回最近一次成功跳转前的位置；域被刷新后优先按 citationID 重定位。 */
  function back() {
    try {
      const d = root.PPDoc.doc(), key = String(root.PPDoc.documentID(d)), stack = stackFor(key);
      if (!stack.length) return { ok: false, error: "没有可返回的跳转前位置" };
      let skipped = 0;
      while (stack.length) {
        const position = stack.pop();
        if (String(position.documentID || "") !== key) continue;
        if (position.citationID) {
          const target = freshField(position);
          if (target) {
            saveStack(key); jump(target, false);
            return { ok: true, relocated: true, remaining: stack.length, skipped: skipped || undefined };
          }
          skipped++; continue;             // 已删除域绝不按旧字符偏移误选其他正文。
        }
        const range = root.PPDoc.doc().Range(Number(position.start) || 0, Number(position.end) || Number(position.start) || 0);
        range.Select();
        saveStack(key);
        try { root.PPDoc.app().ActiveWindow.ScrollIntoView(range, true); } catch (e) { /* 选区已恢复 */ }
        return { ok: true, remaining: stack.length, skipped: skipped || undefined };
      }
      saveStack(key);
      return { ok: false, error: skipped ? "原引文位置已删除，已跳过失效位置" : "没有可返回的跳转前位置" };
    } catch (e) { return { ok: false, error: "返回失败：" + String((e && e.message) || e) }; }
  }

  function sameItem(direction) {
    try {
      const source = citationAtCursor();
      if (!source) return { ok: false, error: "光标不在引文上" };
      if (!source.items.length) return { ok: false, error: "当前引文没有可遍历的文献条目" };
      let item = source.items[0];
      if (source.items.length > 1) {
        const lines = ["选择要遍历的文献："].concat(source.items.map(function (x, i) {
          const data = x.itemData || {}, author = (data.author || [])[0] || {};
          return (i + 1) + ". " + [data.title || x.key, author.family || author.literal || "未知作者"].join(" · ");
        }));
        const picked = choose(lines, source.items.length);
        if (picked.error) return { ok: false, error: picked.error };
        if (picked.cancelled) return { ok: false, cancelled: true };
        item = source.items[picked.n];
      }
      const wanted = itemID(item), all = citationFields(), matches = [];
      all.forEach(function (field) {
        if (field.items.some(function (x) { return itemID(x) === wanted; })) matches.push(field);
      });
      if (!matches.length) return { ok: false, error: "该文献的引用位置已删除" };
      let current = -1;
      matches.forEach(function (field, i) { if (field.citationID === source.citationID) current = i; });
      if (current < 0) {
        const pos = cursor();
        if (direction > 0) {
          const nextIndex = matches.findIndex(function (x) { return x.start > pos; });
          current = nextIndex < 0 ? 0 : nextIndex - 1;
        } else current = 0;
      }
      let target = null;
      for (let step = 1; step <= matches.length; step++) {
        const candidate = matches[((current + direction * step) % matches.length + matches.length) % matches.length];
        if (candidate && (freshField(candidate) || candidate.field)) { target = candidate; break; }
      }
      if (!target) return { ok: false, error: "未找到仍有效的同文献引用位置" };
      jump(target);
      return { ok: true, citationID: target.citationID, total: matches.length, item: item };
    } catch (e) { return { ok: false, error: "同文献遍历失败：" + String((e && e.message) || e) }; }
  }

  const api = {
    next: next, prev: prev, list: list, back: back,
    samePrev: function () { return sameItem(-1); }, sameNext: function () { return sameItem(1); },
    toBibliography: toBibliography, toCitation: toCitation,
    locate: function (ref) { const target = freshField(ref); if (!target) return { ok: false, error: "目标引文已删除" }; jump(target); return { ok: true, citationID: target.citationID }; },
    __parse: parseCitations, __currentPosition: currentPosition, __stackFor: stackFor,
  };
  root.PPNav = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
