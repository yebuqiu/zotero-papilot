// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 对话数据的会话级合并（chat-sync.js，0.87.0 批次 3）
 *
 * 背景：两个 chat 数据集原本是**整文件替换**。两台机器各自离线问过话之后同步，
 * 后写的那份会把对方整段记录冲掉——这是"我明明在这边追问过"的真实来源。
 *
 * 本模块只做**纯函数**：输入两侧 payload + 墓碑状态，输出合并结果与统计。
 * 不读 pref、不碰 Zotero、不写盘、不发网络，便于在 vm 沙箱里穷举边界。
 *
 * 四条合并规则（按优先级，顺序不可调换）：
 *
 * 1. **前缀延展优先于时间**。一场会话只允许追加消息，所以「A 是 B 的前缀」
 *    就意味着 B 是 A 的严格超集。此时取更长的那个，**完全无视 ts**。
 *    这条修的是「A 机点了个置顶（bump ts）、B 机在同一场里追问两条」——
 *    按 ts 取会让 B 机的追问被静默丢掉，用户只会觉得"我明明问过"。
 *
 * 2. **真正分歧才看 ts**（两边各追加了不同内容）。ts 相等时用内容哈希字典序，
 *    **绝不能用"本地优先"**：那会让两台机器各自认为自己是赢家，每轮各传一版，
 *    永远收敛不了。
 *
 * 3. **删除只来自墓碑，绝不来自"云端缺失"**。一次 PUT 失败、用户手工清理云端、
 *    都会被误判成"全库删除"。
 *
 * 4. **先墓碑过滤，再裁剪**。反过来的话，被删掉的会话会先占一个裁剪名额，
 *    把另一场活着的会话挤出去。
 *
 * 未被接线时本模块是惰性的（见 cloud-sync 的 chatMerge 开关）。
 */
/* global Zotero */

var ChatSync = {
  FILE_STATE: "papilot-chat-sync-state.json",
  SCHEMA: 1,
  CAPS: { msgs: 60, sessionsPerDoc: 20, docs: 500, multi: 200 },

  /* ==================== 墓碑状态 ==================== */

  _blankState() {
    return { schema: this.SCHEMA, tomb: { docs: {}, multi: {} } };
  },

  /** 规范化墓碑（坏值一律丢弃，绝不让一条脏墓碑删掉用户的记录） */
  normState(raw) {
    const out = this._blankState();
    if (!raw || typeof raw !== "object" || !raw.tomb || typeof raw.tomb !== "object") return out;
    const docs = (raw.tomb.docs && typeof raw.tomb.docs === "object") ? raw.tomb.docs : {};
    for (const k of Object.keys(docs)) {
      const d = docs[k];
      if (!d || typeof d !== "object") continue;
      const rec = { doc: 0, sids: {} };
      const dt = Number(d.doc);
      if (isFinite(dt) && dt > 0) rec.doc = Math.floor(dt);
      const sids = (d.sids && typeof d.sids === "object") ? d.sids : {};
      for (const sid of Object.keys(sids)) {
        const t = Number(sids[sid]);
        if (sid && isFinite(t) && t > 0) rec.sids[sid] = Math.floor(t);
      }
      if (rec.doc || Object.keys(rec.sids).length) out.tomb.docs[k] = rec;
    }
    const multi = (raw.tomb.multi && typeof raw.tomb.multi === "object") ? raw.tomb.multi : {};
    for (const sid of Object.keys(multi)) {
      const t = Number(multi[sid]);
      if (sid && isFinite(t) && t > 0) out.tomb.multi[sid] = Math.floor(t);
    }
    return out;
  },

  /** 两端的墓碑取并集、同 key 取较晚的（墓碑只会"更确定"，不会互相抵消） */
  mergeStates(a, b) {
    const A = this.normState(a);
    const B = this.normState(b);
    const out = this._blankState();
    for (const src of [A, B]) {
      for (const k of Object.keys(src.tomb.docs)) {
        const d = src.tomb.docs[k];
        const cur = out.tomb.docs[k] || (out.tomb.docs[k] = { doc: 0, sids: {} });
        cur.doc = Math.max(cur.doc || 0, d.doc || 0);
        for (const sid of Object.keys(d.sids)) {
          cur.sids[sid] = Math.max(cur.sids[sid] || 0, d.sids[sid] || 0);
        }
      }
      for (const sid of Object.keys(src.tomb.multi)) {
        out.tomb.multi[sid] = Math.max(out.tomb.multi[sid] || 0, src.tomb.multi[sid] || 0);
      }
    }
    return out;
  },

  /** 记一条墓碑（删除路径调用；时间取被删会话的最后修改时间） */
  tombAddSession(state, docKey, sid, ts) {
    const st = this.normState(state);
    const at = Number(ts) > 0 ? Number(ts) : Date.now();
    const key = String(docKey || "");
    if (key) {
      const d = st.tomb.docs[key] || (st.tomb.docs[key] = { doc: 0, sids: {} });
      d.sids[String(sid)] = Math.max(d.sids[String(sid)] || 0, at);
    } else {
      st.tomb.multi[String(sid)] = Math.max(st.tomb.multi[String(sid)] || 0, at);
    }
    return st;
  },

  tombAddDoc(state, docKey, ts) {
    const st = this.normState(state);
    const key = String(docKey || "");
    if (!key) return st;
    const d = st.tomb.docs[key] || (st.tomb.docs[key] = { doc: 0, sids: {} });
    d.doc = Math.max(d.doc || 0, Number(ts) > 0 ? Number(ts) : Date.now());
    return st;
  },

  /* ==================== 基础工具 ==================== */

  _hash(s) {
    let h = 0x811c9dc5;
    const str = String(s || "");
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h >>> 0;
  },

  /**
   * a 与 b 的前缀关系：1 = a 是 b 的严格前缀（b 更长），2 = b 是 a 的严格前缀，0 = 无关。
   * 逐条比 role + content，不看 seq（seq 在裁剪后会跳号，不能当相等依据）。
   */
  prefixOf(a, b) {
    const A = Array.isArray(a) ? a : [];
    const B = Array.isArray(b) ? b : [];
    if (!A.length || !B.length) return 0;
    if (A.length === B.length) return 0;
    const short = A.length < B.length ? A : B;
    const long = A.length < B.length ? B : A;
    for (let i = 0; i < short.length; i++) {
      const x = short[i] || {};
      const y = long[i] || {};
      if (String(x.role) !== String(y.role)) return 0;
      if (String(x.content) !== String(y.content)) return 0;
    }
    return A.length < B.length ? 1 : 2;
  },

  /** 裁剪消息：保留首条 + 最近 N-1 条（丢首条会让用户不知道当时问了什么） */
  trimHistory(history, max) {
    const h = Array.isArray(history) ? history.slice() : [];
    const cap = Number(max) > 0 ? Math.floor(max) : this.CAPS.msgs;
    if (h.length <= cap) return h;
    return [h[0]].concat(h.slice(h.length - (cap - 1)));
  },

  /* ==================== 会话合并 ==================== */

  /**
   * 合并同一 sid 的两份会话。
   * @returns {{session:object, from:"local"|"remote"}} from 仅用于统计
   */
  mergeSession(a, b) {
    const A = a || {};
    const B = b || {};
    const pref = this.prefixOf(A.history, B.history);
    let win = null;
    let from = "local";
    if (pref === 1) { win = B; from = "remote"; }
    else if (pref === 2) { win = A; from = "local"; }
    else {
      const ta = Number(A.ts) || 0;
      const tb = Number(B.ts) || 0;
      if (ta !== tb) { win = ta > tb ? A : B; from = ta > tb ? "local" : "remote"; }
      else {
        // 完全并列：内容哈希字典序（对称裁决，两端各自算都能得同一个赢家）
        const ha = this._hash(JSON.stringify(A.history || []));
        const hb = this._hash(JSON.stringify(B.history || []));
        win = ha >= hb ? A : B;
        from = ha >= hb ? "local" : "remote";
      }
    }
    const session = Object.assign({}, win);
    // 合并后的 ts 必须取两侧最大值：取"胜出侧的 ts"会让 ts 变小，
    // 之后一个更晚发生的删除判不过期，用户会看到"删了又回来"。
    session.ts = Math.max(Number(A.ts) || 0, Number(B.ts) || 0) || Number(session.ts) || 0;
    // pinned 跟着胜出侧走（取消置顶会 bump ts，所以 ts 大的一侧就是最新意图）
    if (win.pinned === true) session.pinned = true; else delete session.pinned;
    if (win.migrated === true) session.migrated = true; else delete session.migrated;
    return { session, from };
  },

  /** 按 sid 并集会话，再过滤墓碑，最后裁剪 */
  _mergeSessionList(localList, remoteList, tombSids, cap) {
    const byId = new Map();
    const stats = { kept: 0, removedByTomb: 0 };
    const add = (list, src) => {
      for (const s of (Array.isArray(list) ? list : [])) {
        if (!s || typeof s !== "object" || !s.id) continue;
        const cur = byId.get(s.id);
        if (!cur) { byId.set(s.id, { local: src === "local" ? s : null, remote: src === "remote" ? s : null }); }
        else cur[src] = s;
      }
    };
    add(localList, "local");
    add(remoteList, "remote");

    const out = [];
    for (const [sid, pair] of byId) {
      let merged = null;
      if (pair.local && pair.remote) merged = this.mergeSession(pair.local, pair.remote).session;
      else merged = pair.local || pair.remote;
      const tombTs = tombSids && tombSids[sid] ? Number(tombSids[sid]) : 0;
      if (tombTs && tombTs >= (Number(merged.ts) || 0)) { stats.removedByTomb++; continue; }
      merged.history = this.trimHistory(merged.history, this.CAPS.msgs);
      out.push(merged);
    }
    out.sort((x, y) => {
      const px = x.pinned ? 1 : 0;
      const py = y.pinned ? 1 : 0;
      if (px !== py) return py - px;
      const tx = Number(x.ts) || 0;
      const ty = Number(y.ts) || 0;
      if (tx !== ty) return ty - tx;
      return String(x.id) < String(y.id) ? -1 : (String(x.id) > String(y.id) ? 1 : 0);
    });
    const limit = Number(cap) > 0 ? Math.floor(cap) : this.CAPS.sessionsPerDoc;
    stats.kept = Math.min(out.length, limit);
    stats.evicted = Math.max(0, out.length - limit);
    return { list: out.slice(0, limit), stats };
  },

  /**
   * 合并 docs 通道。
   * @param {object} local 本地 payload（map）
   * @param {object} remote 云端 payload（map）
   * @param {object} state 墓碑状态
   */
  mergeDocs(local, remote, state) {
    const st = this.normState(state);
    const L = (local && typeof local === "object" && !Array.isArray(local)) ? local : {};
    const R = (remote && typeof remote === "object" && !Array.isArray(remote)) ? remote : {};
    const out = {};
    const stats = { docs: 0, removedByTomb: 0, evictedSessions: 0, evictedDocs: 0 };

    const keys = Array.from(new Set(Object.keys(L).concat(Object.keys(R))));
    for (const key of keys) {
      const l = L[key] || null;
      const r = R[key] || null;
      const base = l || r;
      if (!base) continue;
      const tomb = st.tomb.docs[key];
      if (tomb && tomb.doc && tomb.doc >= (Number(base.updatedAt) || 0)) {
        stats.removedByTomb++;
        continue;
      }
      const merged = this._mergeSessionList(
        l ? l.sessions : [], r ? r.sessions : [], tomb ? tomb.sids : null
      );
      if (!merged.list.length) continue;

      let title = "";
      const lt = Number(l && l.updatedAt) || 0;
      const rt = Number(r && r.updatedAt) || 0;
      if (l && r) {
        const cand = lt > rt ? l : (rt > lt ? r : (String(l.title || "") >= String(r.title || "") ? l : r));
        title = String(cand.title || "");
      } else {
        title = String(base.title || "");
      }

      out[key] = {
        key,
        // itemID 只保留本机值：它是本机 Zotero 库的自增 id，跨机毫无意义，
        // 采纳远端会把本地映射指到另一篇文章上（静默串档，最难查）。
        libraryID: l ? (Number(l.libraryID) || 0) : 0,
        itemKey: String((l && l.itemKey) || base.itemKey || ""),
        itemID: l ? (Number(l.itemID) || 0) : 0,
        title: title.slice(0, 200),
        updatedAt: Math.max(lt, rt),
        sessions: merged.list,
      };
      stats.evictedSessions += merged.stats.evicted || 0;
      stats.docs++;
    }

    // 文档数裁剪：按最近会话时间保留
    const keys2 = Object.keys(out);
    if (keys2.length > this.CAPS.docs) {
      keys2.sort((a, b) => {
        const ma = out[a].sessions.length ? out[a].sessions[0].ts : 0;
        const mb = out[b].sessions.length ? out[b].sessions[0].ts : 0;
        return (Number(mb) || 0) - (Number(ma) || 0);
      });
      for (const k of keys2.slice(this.CAPS.docs)) { delete out[k]; stats.evictedDocs++; }
    }
    return { payload: out, state: st, stats };
  },

  /** 合并 multi 通道（数组） */
  mergeMulti(local, remote, state) {
    const st = this.normState(state);
    const merged = this._mergeSessionList(
      Array.isArray(local) ? local : [],
      Array.isArray(remote) ? remote : [],
      st.tomb.multi,
      this.CAPS.multi
    );
    return { payload: merged.list, state: st, stats: merged.stats };
  },

  /** 统一入口 */
  merge(kind, local, remote, state) {
    if (kind === "chatMulti") return this.mergeMulti(local, remote, state);
    return this.mergeDocs(local, remote, state);
  },

  /**
   * 确定性序列化：key 排序 + 无缩进。
   * 不定序会让每次合并产出不同的字节，云同步据此判"本地又改了"，形成永远传不完的乒乓。
   */
  serialize(payload) {
    if (Array.isArray(payload)) return JSON.stringify(payload);
    const out = {};
    for (const k of Object.keys(payload || {}).sort()) out[k] = payload[k];
    return JSON.stringify(out);
  },
};
