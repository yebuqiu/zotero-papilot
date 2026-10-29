// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot AI 角色与参数解析（roles.js，0.87.0）
 *
 * 目的：把「AI 扮演谁」（角色设定）与「AI 怎么说话」（采样参数）从散落的
 * 全局 pref 收敛成一份可切换、可覆盖、可预览的配置——单篇问答 / 多篇综合 /
 * 智能体 / 任务型（总结·翻译·打标签）四个场景各自可以有不同的取值。
 *
 * 数据面（全部 pref，JSON 字符串 / 标量）：
 *   aiRoles          用户自定义角色数组，元素 {id,name,desc,prompt,params}；空 = 只用内置
 *   aiActiveRole     当前默认角色 id（空 = "scholar"，即只吃 aiSystemPrompt 的旧行为）
 *   aiSceneParams    场景覆盖 {single:{},multi:{},agent:{},task:{}}，值留空 = 不覆盖
 *   aiRolePromptMode "append"（默认，角色提示词追加在 aiSystemPrompt 之后）| "replace"
 *
 * 三条硬约束（踩过的坑，改这里之前先读）：
 *   1. **模板必须内联**：Chromium/Zotero 的 mozIJSSubScriptLoader 下 `require`/动态 import
 *      都不可用，角色提示词一律写成字符串常量，不做外部文件加载。
 *   2. **pref 可能被手改坏**：任何读都走 _safeJSON + normalizeRole，坏值一律回退默认，
 *      绝不让一条脏角色把整个问答链路带崩（问答侧不允许抛错）。
 *   3. **参数优先级固定**：默认值 < 角色 params < 场景覆盖 < 本轮显式传参。
 *      顺序写死在 paramsFor()，设置面板的「来源」提示也读同一份结果，避免两处口径打架。
 *
 * 消费方：ai/chat.js（system prompt）、panels/chat-float.js（采样参数 + /role）、
 * prefs-roles.js（编辑与预览）、ai/agent-tools.js（agent 场景参数）。
 */
/* global Prefs */

var AIRoles = {
  PREF_CUSTOM: "aiRoles",
  PREF_ACTIVE: "aiActiveRole",
  PREF_SCENE: "aiSceneParams",
  PREF_MODE: "aiRolePromptMode",
  DEFAULT_ROLE: "scholar",
  MAX_CUSTOM: 40,
  NAME_MAX: 40,
  PROMPT_MAX: 4000,

  /** 四个场景（顺序即设置面板展示顺序） */
  SCENES: [
    { id: "single", label: "单篇问答", desc: "就一篇文献追问（含划词解释）" },
    { id: "multi", label: "多篇综合", desc: "拖入多篇文献做对比 / 综述" },
    { id: "agent", label: "智能体", desc: "Agent 模式的工具决策与最终回答" },
    { id: "task", label: "任务型", desc: "总结 / 翻译 / 打标签等一次性任务" },
  ],

  /** 参数缺省值：与 prefs.js 的默认值保持一致（两处都要改时同步） */
  DEFAULTS: { temperature: 0.3, topP: "", maxTokens: 4096, historyRounds: 6 },

  /**
   * 内置角色。prompt 为空 = 完全沿用用户自己的 aiSystemPrompt（旧行为，零回归）。
   * 内置角色**只读**：想改就「复制为新角色」，避免升级时覆盖用户编辑。
   */
  builtin: [
    {
      id: "scholar",
      name: "严谨学术助手",
      short: "严谨",
      badge: "谨",
      accent: "#2d6cdf",
      desc: "默认角色：只依据材料回答，标注出处，区分原文与推断",
      prompt: "",
      params: {},
    },
    {
      id: "reviewer",
      name: "严苛审稿人",
      short: "审稿",
      badge: "审",
      accent: "#c0392b",
      desc: "按审稿意见体例输出，问题分级、落到具体段落，给可执行的修改建议",
      prompt:
        "你现在扮演该领域一位苛刻但公正的审稿人。审读材料时：\n" +
        "1. 先一句话概括作者的主张与证据链，指出证据与主张之间是否有跳跃；\n" +
        "2. 列出主要问题，每条标注「致命 / 重大 / 次要」，并按严重程度排序，必须落到具体章节、图表或论证步骤；\n" +
        "3. 给出可直接执行的修改建议（改哪里、怎么改、改成什么样算合格）；\n" +
        "4. 最后给录用倾向（接收 / 小修 / 大修 / 拒稿）及一句话理由。\n" +
        "不要为了显得严格而编造缺陷；作者已承认的局限与未被讨论的风险要分开说。",
      params: { temperature: 0.2 },
    },
    {
      id: "methodologist",
      name: "方法学顾问",
      short: "方法",
      badge: "法",
      accent: "#0d9488",
      desc: "拆解研究设计、样本、变量与因果识别，关注可复现性与偏差来源",
      prompt:
        "你是一位方法学顾问。回答时优先围绕：研究设计类型与因果识别策略是否成立、样本来源与代表性、" +
        "关键变量的定义与测量误差、分析步骤中最可能引入偏差的环节、以及换一个团队能否按文中描述复现。\n" +
        "每个判断都要指到论文的具体位置（章节 / 图表 / 公式编号）；论文没有交代的地方明确写「未报告」，" +
        "不要把领域惯例当成这篇论文的做法。",
      params: { temperature: 0.25 },
    },
    {
      id: "librarian",
      name: "文献综述助手",
      short: "综述",
      badge: "综",
      accent: "#7c3aed",
      desc: "跨文献比较口径、聚类观点、指出分歧与空白，适合多篇综合场景",
      prompt:
        "你是一位文献综述助手。面对多篇材料时：\n" +
        "1. 先建立一张对照表，维度包括研究问题、数据/样本、方法、主要结论、局限；\n" +
        "2. 指出哪些结论互相支持、哪些互相冲突，冲突要说明可能原因（样本、测量、模型设定）；\n" +
        "3. 标出所有文献都没覆盖的空白，并说明这个空白是否值得做；\n" +
        "4. 引用务必注明出自哪一篇（用给定的「文献 n」编号），不要合并成模糊的「研究表明」。",
      params: { temperature: 0.3 },
    },
    {
      id: "polisher",
      name: "语言润色与翻译",
      short: "润色",
      badge: "润",
      accent: "#b45309",
      desc: "低温度直译 + 学术语气润色，术语保留英文原词",
      prompt:
        "你负责学术文本的翻译与润色。要求：忠实原文，不增删内容，不替作者补充论证；" +
        "学术语气，句式简洁；专业术语首次出现保留英文原词并用括号标注；数字、单位、统计量原样保留。" +
        "只输出结果，不要解释你做了什么修改。",
      params: { temperature: 0.1 },
    },
  ],

  /* ==================== 读 ==================== */

  _safeJSON(key, fallback) {
    let raw = "";
    try { raw = Prefs.get(key, ""); } catch (e) { return fallback; }
    if (!raw) return fallback;
    if (typeof raw === "object") return raw;
    try {
      const v = JSON.parse(String(raw));
      return v == null ? fallback : v;
    } catch (e) {
      return fallback;
    }
  },

  _num(v, lo, hi) {
    if (v === "" || v == null) return null;
    const n = Number(v);
    if (!isFinite(n)) return null;
    return Math.max(lo, Math.min(hi, n));
  },

  /** 只接受 >0 的数值（maxTokens / historyRounds 用：0 是「未设置」而不是「零」） */
  _pos(v, lo, hi) {
    const raw = Number(v);
    if (!isFinite(raw) || raw <= 0) return null;
    return this._num(raw, lo, hi);
  },

  _str(v, max) {
    return String(v == null ? "" : v).trim().slice(0, max);
  },

  /**
   * 规范化一条角色。坏 id / 空 prompt / 非法参数一律清洗；
   * 返回 null 表示这条记录不可用（调用方应丢弃）。
   */
  normalizeRole(raw, opts) {
    if (!raw || typeof raw !== "object") return null;
    let id = this._str(raw.id, 32).toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(id)) id = "";
    const name = this._str(raw.name, this.NAME_MAX);
    const prompt = String(raw.prompt == null ? "" : raw.prompt).slice(0, this.PROMPT_MAX);
    if (!name && !prompt) return null;
    if (!id) id = "role-" + Math.abs(this._hash(name + prompt)).toString(36).slice(0, 8);

    const p = (raw.params && typeof raw.params === "object") ? raw.params : {};
    const params = {};
    const t = this._num(p.temperature, 0, 2);
    if (t !== null) params.temperature = t;
    const mt = this._pos(p.maxTokens, 64, 32768);
    if (mt !== null) params.maxTokens = Math.floor(mt);
    const hr = this._pos(p.historyRounds, 1, 30);
    if (hr !== null) params.historyRounds = Math.floor(hr);
    if (p.topP !== "" && p.topP != null) {
      const tp = this._num(p.topP, 0, 1);
      if (tp !== null) params.topP = tp;
    }

    const out = { id, name: name || id, prompt, params };
    const desc = this._str(raw.desc, 120);
    if (desc) out.desc = desc;
    // 展示字段（浮窗 Pill）：显式定义而不是截断全名——「语言润…」这种截断毫无信息量
    const short = this._str(raw.short, 4);
    if (short) out.short = short;
    const badge = String(raw.badge == null ? "" : raw.badge).trim().slice(0, 1);
    if (badge) out.badge = badge;
    const accent = String(raw.accent == null ? "" : raw.accent).trim();
    if (/^#[0-9a-fA-F]{6}$/.test(accent)) out.accent = accent.toLowerCase();
    if (!opts || opts.keepBuiltin !== true) out.builtin = false;
    return out;
  },

  /** FNV-1a 32 位（稳定、无依赖，用于给未命名角色生成 id） */
  _hash(s) {
    let h = 0x811c9dc5;
    const str = String(s || "");
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h | 0;
  },

  /** 自定义角色（已规范化，坏条目丢弃） */
  custom() {
    const arr = this._safeJSON(this.PREF_CUSTOM, []);
    if (!Array.isArray(arr)) return [];
    const out = [];
    const seen = new Set();
    for (const raw of arr) {
      const r = this.normalizeRole(raw);
      if (!r || seen.has(r.id)) continue;
      seen.add(r.id);
      out.push(r);
    }
    return out.slice(0, this.MAX_CUSTOM);
  },

  /** 全部角色：内置在前（同 id 的自定义覆盖内置定义，但不置顶） */
  all() {
    const custom = this.custom();
    const byId = new Map();
    for (const c of custom) byId.set(c.id, c);
    const out = [];
    for (const b of this.builtin) {
      const override = byId.get(b.id);
      if (override) {
        byId.delete(b.id);
        out.push(Object.assign({}, b, override, { builtin: true, overridden: true }));
      } else {
        out.push(Object.assign({}, b, { builtin: true, params: Object.assign({}, b.params) }));
      }
    }
    for (const c of byId.values()) out.push(c);
    return out;
  },

  get(id) {
    const key = String(id || "").trim() || this.DEFAULT_ROLE;
    for (const r of this.all()) if (r.id === key) return r;
    return null;
  },

  activeId() {
    let v = "";
    try { v = String(Prefs.get(this.PREF_ACTIVE, "") || "").trim(); } catch (e) { v = ""; }
    if (v && this.get(v)) return v;
    return this.DEFAULT_ROLE;
  },

  active() {
    return this.get(this.activeId()) || this.get(this.DEFAULT_ROLE);
  },

  setActive(id) {
    const role = this.get(id);
    const key = role ? role.id : this.DEFAULT_ROLE;
    try { Prefs.set(this.PREF_ACTIVE, key); } catch (e) { /* 写失败不影响当前会话 */ }
    return key;
  },

  /* ==================== 参数解析 ==================== */

  /** 场景覆盖（已清洗；只保留合法场景与合法值） */
  sceneOverrides(scene) {
    if (!scene) return {};
    const all = this._safeJSON(this.PREF_SCENE, {});
    if (!all || typeof all !== "object" || Array.isArray(all)) return {};
    const raw = all[scene];
    if (!raw || typeof raw !== "object") return {};
    const out = {};
    const t = this._num(raw.temperature, 0, 2);
    if (t !== null) out.temperature = t;
    const mt = this._pos(raw.maxTokens, 64, 32768);
    if (mt !== null) out.maxTokens = Math.floor(mt);
    const hr = this._pos(raw.historyRounds, 1, 30);
    if (hr !== null) out.historyRounds = Math.floor(hr);
    if (raw.topP !== "" && raw.topP != null) {
      const tp = this._num(raw.topP, 0, 1);
      if (tp !== null) out.topP = tp;
    }
    return out;
  },

  /** 全局 pref（用户手填的原值，保持旧的读取语义） */
  _globalParams() {
    const g = (key, dflt) => {
      try {
        const v = Prefs.get(key, dflt);
        return (v === undefined || v === null) ? dflt : v;
      } catch (e) { return dflt; }
    };
    const t = this._num(g("aiTemperature", this.DEFAULTS.temperature), 0, 2);
    const mt = this._num(g("aiMaxTokens", this.DEFAULTS.maxTokens), 64, 32768);
    const hr = this._num(g("aiHistoryRounds", this.DEFAULTS.historyRounds), 1, 30);
    let topP = "";
    const rawTop = g("aiTopP", "");
    if (rawTop !== "" && rawTop != null) {
      const tp = this._num(rawTop, 0, 1);
      if (tp !== null) topP = tp;
    }
    return {
      temperature: t === null ? this.DEFAULTS.temperature : t,
      maxTokens: mt === null ? this.DEFAULTS.maxTokens : Math.floor(mt),
      historyRounds: hr === null ? this.DEFAULTS.historyRounds : Math.floor(hr),
      topP,
    };
  },

  /**
   * 某场景某角色的**最终生效参数**（单一真源）。
   * @param {"single"|"multi"|"agent"|"task"} scene
   * @param {string=} roleId 缺省 = 当前默认角色
   * @param {object=} explicit 本轮显式覆盖（最高优先级，目前仅内部/测试用）
   * @returns {{temperature:number, topP:(number|""), maxTokens:number, historyRounds:number, source:object}}
   */
  paramsFor(scene, roleId, explicit) {
    const role = this.get(roleId || this.activeId());
    const global = this._globalParams();
    const roleP = (role && role.params) ? role.params : {};
    const sceneP = this.sceneOverrides(scene);
    const expl = (explicit && typeof explicit === "object") ? explicit : {};

    const pick = (key) => {
      if (expl[key] !== undefined && expl[key] !== "") return { v: expl[key], from: "本轮" };
      if (sceneP[key] !== undefined) return { v: sceneP[key], from: "场景" };
      if (roleP[key] !== undefined) return { v: roleP[key], from: "角色" };
      return { v: global[key], from: "全局" };
    };

    const t = pick("temperature");
    const mt = pick("maxTokens");
    const hr = pick("historyRounds");
    const tp = pick("topP");

    const mtv = this._pos(mt.v, 64, 32768);
    const hrv = this._pos(hr.v, 1, 30);
    return {
      temperature: this._num(t.v, 0, 2) === null ? this.DEFAULTS.temperature : this._num(t.v, 0, 2),
      maxTokens: mtv === null ? this.DEFAULTS.maxTokens : Math.floor(mtv),
      historyRounds: hrv === null ? this.DEFAULTS.historyRounds : Math.floor(hrv),
      topP: (tp.v === "" || tp.v == null) ? "" : this._num(tp.v, 0, 1),
      source: {
        temperature: t.from, maxTokens: mt.from,
        historyRounds: hr.from, topP: tp.from,
      },
    };
  },

  /**
   * 供 AIClient 直接使用的采样参数。
   * `top_p` 恒带键：解析结果为「不启用」时传 null，AIClient 会据此**删掉**全局 top_p
   * （键缺失的语义是「沿用全局」，两者必须能区分，否则角色级「不传 top_p」失效）。
   */
  sampleFor(scene, roleId, explicit) {
    const p = this.paramsFor(scene, roleId, explicit);
    const out = { temperature: p.temperature, max_tokens: p.maxTokens };
    out.top_p = (p.topP === "" || p.topP == null) ? null : p.topP;
    return out;
  },

  /* ==================== system prompt ==================== */

  promptMode() {
    let m = "";
    try { m = String(Prefs.get(this.PREF_MODE, "append") || "append").trim(); } catch (e) { m = "append"; }
    return m === "replace" ? "replace" : "append";
  },

  /** 角色提示词块（无角色 / 角色无提示词 → ""） */
  roleBlock(roleId) {
    const role = this.get(roleId || this.activeId());
    if (!role) return "";
    const prompt = String(role.prompt || "").trim();
    if (!prompt) return "";
    return "【当前角色：" + role.name + "】\n" + prompt;
  },

  /**
   * 拼 system prompt 的「基础段」：全局 aiSystemPrompt 与角色块按模式合并。
   * append：全局 + 角色块（默认，全局纪律不丢）
   * replace：角色块优先，全局只在角色块为空时兜底
   */
  basePrompt(scene, roleId) {
    let base = "";
    try { base = String(Prefs.get("aiSystemPrompt", "") || "").trim(); } catch (e) { base = ""; }
    const block = this.roleBlock(roleId);
    if (!block) return base;
    if (this.promptMode() === "replace" && block) return block;
    return base ? (base + "\n\n" + block) : block;
  },

  /**
   * 浮窗 Pill 的展示三元组：{ name, short, badge, accent }。
   * 回退链写死在这里（short 缺失取全名前 3 字、badge 取首字、accent 取主题蓝），
   * 调用方不要再各写一套，否则自定义角色的 Pill 会出现「有字无底色」这类半残状态。
   */
  displayOf(roleId) {
    const role = this.get(roleId || this.activeId());
    if (!role) {
      return { name: "—", short: "—", badge: "?", accent: "#2d6cdf" };
    }
    const name = String(role.name || role.id);
    const short = String(role.short || "").trim() || Array.from(name).slice(0, 3).join("");
    const badge = String(role.badge || "").trim().slice(0, 1) || Array.from(name)[0] || "?";
    const accent = /^#[0-9a-fA-F]{6}$/.test(String(role.accent || "")) ? role.accent : "#2d6cdf";
    return { name, short, badge, accent };
  },

  /** 场景 → 默认角色（未单独配置时全部跟随默认角色） */
  roleForScene(scene, roleId) {
    const explicit = String(roleId || "").trim();
    if (explicit && this.get(explicit)) return explicit;
    return this.activeId();
  },

  /* ==================== 写（设置面板用） ==================== */

  saveCustom(role) {
    const norm = this.normalizeRole(role);
    if (!norm) return null;
    // 内置 id 不允许被自定义顶掉（否则升级/删角色后行为漂移），复制时自动改名
    if (this.builtin.some((b) => b.id === norm.id)) {
      let n = 2;
      while (this.get(norm.id + "-" + n)) n++;
      norm.id = norm.id + "-" + n;
    }
    const arr = this.custom().filter((r) => r.id !== norm.id);
    arr.unshift(norm);
    try {
      Prefs.set(this.PREF_CUSTOM, JSON.stringify(arr.slice(0, this.MAX_CUSTOM)));
    } catch (e) { return null; }
    return norm;
  },

  removeCustom(id) {
    const key = String(id || "").trim();
    if (!key) return false;
    const arr = this.custom();
    const out = arr.filter((r) => r.id !== key);
    if (out.length === arr.length) return false;
    try { Prefs.set(this.PREF_CUSTOM, JSON.stringify(out)); } catch (e) { return false; }
    if (this.activeId() === key) this.setActive(this.DEFAULT_ROLE);
    return true;
  },

  setSceneOverride(scene, params) {
    if (!this.SCENES.some((s) => s.id === scene)) return false;
    const all = this._safeJSON(this.PREF_SCENE, {});
    const next = (all && typeof all === "object" && !Array.isArray(all)) ? Object.assign({}, all) : {};
    const clean = {};
    const p = params || {};
    const t = this._num(p.temperature, 0, 2);
    if (t !== null) clean.temperature = t;
    const mt = this._pos(p.maxTokens, 64, 32768);
    if (mt !== null) clean.maxTokens = Math.floor(mt);
    const hr = this._pos(p.historyRounds, 1, 30);
    if (hr !== null) clean.historyRounds = Math.floor(hr);
    if (p.topP !== "" && p.topP != null) {
      const tp = this._num(p.topP, 0, 1);
      if (tp !== null) clean.topP = tp;
    }
    if (Object.keys(clean).length) next[scene] = clean;
    else delete next[scene];
    try { Prefs.set(this.PREF_SCENE, JSON.stringify(next)); } catch (e) { return false; }
    return true;
  },
};
