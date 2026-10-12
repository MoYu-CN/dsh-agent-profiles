/**
 * dsh-agent-profiles —— 模块③：数据模型 + 持久化 + 导入导出。
 *
 * ## 为什么单独成文件
 * 「一份配置长什么样、存到哪、坏了怎么办」与「怎么把它渲染成提示词」
 * （prompt.js）、「怎么通过 HTTP 暴露给界面」（routes.js）是三件独立的事：
 * 前者的生命周期是**磁盘**，后两者是**每次会话 / 每次请求**。
 * 混在一起会让「换个存法」牵动 UI 代码。
 *
 * ## 三个硬约束
 * 1. **读不出来也必须能起来**：文件损坏 / 字段类型错 / 手改坏了 JSON，
 *    一律回退默认值并记下 lastError —— 配置插件不该让整个会话起不来。
 * 2. **写必须原子**：`tmp` + `rename`，避免断电/崩溃留下半截 JSON，
 *    而半截 JSON 下次读会走「回退默认值」⇒ 用户所有配置凭空消失。
 * 3. **入口必须串行**：HTTP 请求可能并发到达（设置页 + 输入框快速切换器
 *    可能同时写），并发读改写会丢更新。所有变更走一条 promise 链。
 *
 * ## 字段上限为什么是「截断」而不是「报错」
 * 这些上限是防呆（防止一个手滑把 10MB 粘进角色设定），不是业务规则。
 * 报错会让用户丢掉刚写的内容；截断只丢超出部分，且界面能看到。
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** 数据结构版本。加字段/改语义时 +1（导入时按它判断兼容性）。 */
export const SCHEMA_VERSION = 1;

/** 状态文件名。 */
const STATE_FILE = "profiles.json";

/** 导出信封的 kind 标记，导入时用它识别「这是本插件的导出文件」。 */
export const EXPORT_KIND = "dsh-agent-profiles";

/** 各项上限。 */
export const LIMITS = Object.freeze({
  profiles: 100,
  name: 60,
  icon: 8,
  role: 2000,
  personality: 2000,
  speech: 2000,
  rules: 6000,
  memorySummary: 4000,
  memoryText: 500,
  memories: 200,
  /** 会话专属设定最多保留多少条（按最近更新淘汰）。 */
  sessions: 200,
  /** 会话 id 长度上限（正常是 UUID，给足余量）。 */
  sessionId: 128,
  /** 单条会话补充设定的长度上限。 */
  sessionNote: 4000,
  /**
   * 头像 data URL 的字符上限（约 300KB 二进制）。
   *
   * 为什么存 data URL 而不是落成图片文件：配置是**自包含**的 ——
   * 导出即带走、导入即完整，不留孤儿文件，也不用为删除配置再写一套清理。
   * 代价是体积，所以客户端上传时会先用 canvas 缩到最长边 512px 再存，
   * 这里再兜一道上限，防止有人手改 JSON 塞进几 MB。
   *
   * 160000 → 400000：头像显示尺寸翻倍（22px → 44px）后 192px 的源太糊，
   * 上传侧改成 512px + webp 0.92，上限跟着抬高。
   */
  avatar: 400000,
  /**
   * **长期记忆的总预算**（摘要 + 所有条目，按字符算）。
   *
   * 超过这个数就触发一次**提炼压缩**（把旧条目合并进摘要），而不是无限增长 ——
   * 这正是「到达文字上限以后会提炼压缩，长此以往」那条需求。
   *
   * 为什么是 5000 而不是更大：提示词总量上限是 8000（`MAX_PROMPT_CHARS`），
   * 而记忆只是其中一块 —— 还要给角色/性格/说话习惯/行为准则留位置。
   * 记忆把预算吃光，人设就会被截断，那是本末倒置。
   */
  memoryTotal: 5000,
});

/** 允许的头像 MIME。**不接受 SVG** —— SVG 里能带脚本，等于给配置开了个 XSS 口子。 */
const AVATAR_PREFIXES = Object.freeze([
  "data:image/png;base64,",
  "data:image/jpeg;base64,",
  "data:image/webp;base64,",
  "data:image/gif;base64,",
]);

/**
 * 规整头像：只接受白名单前缀的 data URL，超长/非法一律当没设。
 *
 * **绝不抛错**：头像坏了不该让整套配置读不出来 —— 退化成「没头像」即可，
 * 界面上会回落到 emoji 图标。
 *
 * @param {unknown} value 原始值。
 * @returns {string} 合法的 data URL，或空串。
 */
export function normalizeAvatar(value) {
  if (typeof value !== "string") return "";
  const text = value.trim();
  if (text === "" || text.length > LIMITS.avatar) return "";
  for (const prefix of AVATAR_PREFIXES) {
    if (text.startsWith(prefix) === true) {
      // 前缀对了但后面必须是 base64 字符，防止塞进别的东西。
      const body = text.slice(prefix.length);
      return /^[A-Za-z0-9+/=\s]+$/.test(body) ? text : "";
    }
  }
  return "";
}

/**
 * 出厂自带的三套配置。
 *
 * ⚠ 「通用助手」是**默认启用**的那一套，它的内容是**有意填好**的：用户明确要求
 *   给默认助手一套准则（实事求是、简洁直白、不臆想、遵守规则、做没做好都如实说）。
 *   早期版本它是空的，理由是「装一个插件不该悄悄改变用户助手的行为」——
 *   这条原则被用户显式推翻了，所以别再照旧注释理解。
 *   想回到「零注入」：把这套的四个内容字段清空即可，
 *   `hasContent()` 会自动让它不进提示词（注入与技能目录都会跳过它）。
 */
const DEFAULT_PROFILES = Object.freeze([
  Object.freeze({
    name: "通用助手",
    icon: "🤖",
    role: "你是一个通用型助手，帮用户把事情想清楚、办妥当。你的价值在于可靠：说得准、做得实、不清楚就承认不清楚。",
    personality:
      "实事求是，不夸大、不含糊，也不奉承。对没验证过的事保持坦白：「不知道」「不确定」「做不到」都是可以直说的答案。",
    speech:
      "简洁直白。先给结论再给理由，能一句说完就不写三句；不复述用户刚说过的话，不写「作为一个 AI」「希望对你有帮助」这类套话。",
    rules: [
      "1. 实事求是：只讲有依据的内容。推测、印象、听说的，要么不说，要么明确标出「这是推测」。",
      "2. 不猜想臆想：不替用户补他没说过的前提；信息不够就先问，不要自己编一个前提往下写。",
      "3. 不编造：来源、数据、引用、执行结果都不能编。报错与原文照贴，不转述、不美化。",
      "4. 遵守规则：服从现行的 AI 内容规范与平台审核要求；违规的事不做，也不帮人绕开。",
      "5. 做没做好都如实说：没做到、做错了、或者不确定有没有做到，直接讲出来，不隐瞒、不粉饰、不假装完成。宁可承认失败，也不给一个「看起来完成了」的假象。",
      "6. 拿不准就问：问一次比返工一次便宜。",
    ].join("\n"),
    memorySummary: "",
    memories: [],
  }),
  Object.freeze({
    name: "编程助手",
    icon: "🧑‍💻",
    role: "你是一名资深软件工程师，擅长把模糊需求拆成可执行的小步，并给出能直接跑的实现。",
    personality: "严谨、直接、不绕弯子。宁可说「不确定」也不编。",
    speech: "先给结论，再给理由；代码块优先，解释从简；不写「作为一个 AI」这类套话。",
    rules: [
      "1. 动手前先确认目标和约束；需求有歧义就先问，别猜着写一大堆。",
      "2. 改代码前先读相关文件，不凭记忆假设现有实现。",
      "3. 报错信息原样贴出，不转述、不美化。",
      "4. 破坏性操作（删文件、改配置、推远端）先说清后果再执行。",
    ].join("\n"),
    memorySummary: "",
    memories: [],
  }),
  Object.freeze({
    name: "写作教练",
    icon: "✍️",
    role: "你是一名中文写作教练，帮用户把想法变成结构清晰、读得下去的文字。",
    personality: "耐心、具体、对空话零容忍。",
    speech: "先指出最值得改的一处，再给改法；引用原句时用引号标出；不用「很棒」「加油」这类空鼓励。",
    rules: [
      "1. 只改用户让你改的部分，不顺手重写整篇。",
      "2. 每次最多给三条建议，按重要性排序。",
      "3. 指出问题时必须给出可替换的写法，而不是「这里可以更好」。",
    ].join("\n"),
    memorySummary: "",
    memories: [],
  }),
]);

/** 按上限截断文本。非字符串一律当空串（手改 JSON 塞进数字也不该炸）。 */
function text(value, max) {
  if (typeof value !== "string") return "";
  const normalized = value.replace(/\r\n/g, "\n").trim();
  return normalized.length > max ? normalized.slice(0, max) : normalized;
}

/** 生成一个短 id。不用自增：导入合并时自增会撞。 */
function newId(prefix) {
  return `${prefix}-${randomUUID().replace(/-/g, "").slice(0, 10)}`;
}

/** 深拷贝（状态是纯 JSON，这是最省事且不会漏字段的复制方式）。 */
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/** 规整一条记忆条目。空文本返回 null（由调用方丢弃）。 */
function normalizeMemory(raw) {
  const source = raw !== null && typeof raw === "object" ? raw : {};
  const body = text(source.text, LIMITS.memoryText);
  if (body === "") return null;
  return {
    id:
      typeof source.id === "string" && source.id.trim() !== ""
        ? source.id.trim().slice(0, 64)
        : newId("m"),
    text: body,
    createdAt:
      typeof source.createdAt === "number" && Number.isFinite(source.createdAt)
        ? source.createdAt
        : Date.now(),
  };
}

/** 规整记忆列表：去掉空条目、去重 id、截断条数。 */
function normalizeMemories(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const memory = normalizeMemory(item);
    if (memory === null) continue;
    if (seen.has(memory.id)) memory.id = newId("m");
    seen.add(memory.id);
    out.push(memory);
    if (out.length >= LIMITS.memories) break;
  }
  return out;
}

/**
 * 规整一套配置。
 *
 * ⚠ **id 缺失时补一个新的，而不是拒绝** —— 导入别人手写的 JSON
 *   时很常见没有 id，直接拒绝会让「导入」变成一件需要懂格式才能用的事。
 *
 * @param {unknown} raw 原始对象。
 * @param {number} index 在列表中的位置（仅用于生成兜底名称）。
 * @returns {object} 合法配置。
 */
export function normalizeProfile(raw, index = 0) {
  const source = raw !== null && typeof raw === "object" ? raw : {};
  const now = Date.now();
  return {
    id:
      typeof source.id === "string" && source.id.trim() !== ""
        ? source.id.trim().slice(0, 64)
        : newId("p"),
    name: text(source.name, LIMITS.name) || `未命名配置 ${index + 1}`,
    icon: text(source.icon, LIMITS.icon) || "🤖",
    /**
     * 头像：data URL 或空串（空 = 没设，界面回落到 icon）。
     * 「没设」必须是一个**明确的可判定状态**（空串），而不是 undefined ——
     * 渲染层要靠它决定显示图片还是图标，undefined 会让判断多一层猜测。
     */
    avatar: normalizeAvatar(source.avatar),
    role: text(source.role, LIMITS.role),
    personality: text(source.personality, LIMITS.personality),
    speech: text(source.speech, LIMITS.speech),
    rules: text(source.rules, LIMITS.rules),
    memorySummary: text(source.memorySummary, LIMITS.memorySummary),
    // 记忆注入开关：**默认开**。只有显式 false 才算关，
    // 这样「导入一份没写这个字段的配置」不会意外关掉记忆。
    injectMemory: source.injectMemory !== false,
    memories: normalizeMemories(source.memories),
    createdAt:
      typeof source.createdAt === "number" && Number.isFinite(source.createdAt)
        ? source.createdAt
        : now,
    updatedAt:
      typeof source.updatedAt === "number" && Number.isFinite(source.updatedAt)
        ? source.updatedAt
        : now,
  };
}

/**
 * 规整整份状态。
 *
 * 保证三件不变量：**至少有一套配置**、**id 互不重复**、**activeId 一定指向存在的配置**。
 * 缺了任何一条，界面都会出现「当前配置是空的」这种无法自愈的状态。
 *
 * @param {unknown} raw 原始状态。
 * @returns {{version: number, activeId: string, profiles: object[]}}
 */
/**
 * 规整一条**会话专属设定**。
 *
 * 会话 id 由宿主给（`agent.id`），不是用户输入的，所以这里只做长度与类型防护。
 * 返回值可能是 null —— 表示「这条没有实际内容，不必保留」。
 *
 * @param {string} sessionId 会话 id。
 * @param {unknown} raw 原始对象。
 * @returns {object|null}
 */
export function normalizeSession(sessionId, raw) {
  const id =
    typeof sessionId === "string" && sessionId.trim() !== ""
      ? sessionId.trim().slice(0, LIMITS.sessionId)
      : "";
  if (id === "") return null;
  const source = raw !== null && typeof raw === "object" ? raw : {};
  const session = {
    profileId:
      typeof source.profileId === "string" && source.profileId.trim() !== ""
        ? source.profileId.trim().slice(0, 64)
        : null,
    note: text(source.note, LIMITS.sessionNote),
    memories: normalizeMemories(source.memories),
    updatedAt:
      typeof source.updatedAt === "number" && Number.isFinite(source.updatedAt)
        ? source.updatedAt
        : Date.now(),
  };
  // 三项都空 ⇒ 等于「没有专属设定」。留着它只会让「哪些对话有专属设定」数不准。
  if (session.profileId === null && session.note === "" && session.memories.length === 0) {
    return null;
  }
  return session;
}

/**
 * 规整会话表：去空、按最近更新截断。
 * @param {unknown} raw 原始对象。
 * @returns {Record<string, object>}
 */
export function normalizeSessions(raw) {
  const source = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const entries = [];
  for (const [sessionId, value] of Object.entries(source)) {
    const session = normalizeSession(sessionId, value);
    if (session !== null) entries.push([sessionId.trim().slice(0, LIMITS.sessionId), session]);
  }
  // 按最近更新保留前 N 条：会话会被不断新建，不设上限这份文件会一直长。
  entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt);
  const out = {};
  for (const [sessionId, session] of entries.slice(0, LIMITS.sessions)) {
    out[sessionId] = session;
  }
  return out;
}

export function normalizeState(raw) {
  const source = raw !== null && typeof raw === "object" ? raw : {};
  const list = Array.isArray(source.profiles)
    ? source.profiles.slice(0, LIMITS.profiles)
    : [];

  const profiles = [];
  const seen = new Set();
  for (const item of list) {
    const profile = normalizeProfile(item, profiles.length);
    // id 撞了就改一个：合并导入时两份配置可能同 id，
    // 留着会让「按 id 操作」永远只命中第一条。
    while (seen.has(profile.id)) profile.id = newId("p");
    seen.add(profile.id);
    profiles.push(profile);
  }

  if (profiles.length === 0) {
    profiles.push(normalizeProfile({ name: "通用助手", icon: "🤖" }, 0));
  }

  const activeId =
    typeof source.activeId === "string" && seen.has(source.activeId)
      ? source.activeId
      : profiles[0].id;

  // 指向已不存在配置的绑定要清掉：留着的话这个对话会「绑了个空」，
  // 界面上显示成「没绑」，但注入会静默回落 —— 两边对不上。
  const sessions = normalizeSessions(source.sessions);
  for (const session of Object.values(sessions)) {
    if (session.profileId !== null && !seen.has(session.profileId)) session.profileId = null;
  }

  return { version: SCHEMA_VERSION, activeId, profiles, sessions };
}

/**
 * 出厂状态。
 *
 * 每次调用都生成**新的 id**，所以「恢复默认」之后再导入旧导出文件，
 * 不会因为 id 相同而互相覆盖 —— 两份都留着，用户自己删。
 *
 * @returns {{version: number, activeId: string, profiles: object[]}}
 */
/**
 * 算子结果里除内部标志之外的**附加字段**。
 *
 * `applyOp` 的返回值既是「算子对状态做了什么」也是「给调用方的回执」：
 * `ok` / `changed` / `notice` / `error` 是内部协议，其余（例如 `added`）是给调用方的数据。
 * 把后者丢掉，调用方就只能靠猜 —— 后台提炼曾经因此「存了记忆却不知道存了几条」。
 *
 * @param {object} result 算子结果。
 * @returns {object} 附加字段。
 */
function extraFieldsOf(result) {
  const out = {};
  for (const [key, value] of Object.entries(result)) {
    if (key === "ok" || key === "changed" || key === "notice" || key === "error") continue;
    out[key] = value;
  }
  return out;
}

export function defaultState() {
  return normalizeState({ profiles: clone(DEFAULT_PROFILES) });
}

/**
 * 一套配置的**长期记忆占用**（摘要 + 所有条目，按字符算）。
 *
 * 只此一份：后台压缩的触发判断、界面上的用量显示、测试断言都必须用同一个口径 ——
 * 各算各的迟早会出现「界面说没满、后台却在压缩」这种自相矛盾。
 *
 * @param {object|null} profile 配置。
 * @returns {number} 占用字符数。
 */
export function memoryChars(profile) {
  if (profile === null || profile === undefined) return 0;
  const summary = typeof profile.memorySummary === "string" ? profile.memorySummary.length : 0;
  const memories = Array.isArray(profile.memories) ? profile.memories : [];
  let total = summary;
  for (const memory of memories) {
    if (memory !== null && typeof memory === "object" && typeof memory.text === "string") {
      total += memory.text.length;
    }
  }
  return total;
}

/**
 * 导出信封：带来源标记与版本，导入端据此判断「这是什么文件」。
 *
 * ⚠ **刻意不导出 `sessions`**：会话 id 是**本机**的（`agent.id`），
 *   换台机器或换个工作区都对不上任何东西。导出一堆孤儿绑定只会让
 *   「哪些对话有专属设定」这个数字变得不可信。
 */
export function exportEnvelope(state) {
  return {
    kind: EXPORT_KIND,
    version: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    profileCount: state.profiles.length,
    activeId: state.activeId,
    state: {
      version: state.version,
      activeId: state.activeId,
      profiles: clone(state.profiles),
    },
  };
}

/**
 * 把导入载荷并入状态。
 *
 * 接受两种形态：本插件的**导出信封**（`{kind, state}`）与**裸状态**
 * （`{profiles:[...]}`）—— 用户手写一份配置来导入是合理需求，
 * 强制他先包一层信封只会让人放弃用这个功能。
 *
 * @param {object} state 当前状态（就地修改）。
 * @param {unknown} payload 导入载荷。
 * @param {"replace"|"merge"} mode 覆盖 / 合并。
 * @returns {{ok: boolean, imported?: number, error?: string}}
 */
export function importInto(state, payload, mode) {
  const source = payload !== null && typeof payload === "object" ? payload : {};
  const body = source.state !== undefined && source.state !== null ? source.state : source;
  const incoming = normalizeState(body);

  // 「导入了一份空文件」不该被当成成功 —— 那会让用户以为配置没了是自己操作失误。
  if (!Array.isArray(body?.profiles) || body.profiles.length === 0) {
    return { ok: false, error: "导入内容里没有 profiles 数组（或为空）。" };
  }

  if (mode === "merge") {
    const existing = new Set(state.profiles.map((p) => p.id));
    let imported = 0;
    for (const profile of incoming.profiles) {
      if (state.profiles.length >= LIMITS.profiles) break;
      if (existing.has(profile.id)) profile.id = newId("p");
      profile.name = profile.name.includes("（导入）")
        ? profile.name
        : `${profile.name}（导入）`;
      existing.add(profile.id);
      state.profiles.push(profile);
      imported += 1;
    }
    return { ok: true, imported };
  }

  const active = incoming.activeId;
  state.profiles = incoming.profiles;
  state.activeId = active;
  return { ok: true, imported: incoming.profiles.length };
}

/**
 * 执行一个变更操作。
 *
 * 纯函数式：只改传进来的 state（调用方传的是副本），
 * 返回 `{ok, changed, notice}` 或 `{ok:false, error}`。
 * **不抛异常** —— 让路由层只处理「成功/失败」两种结果。
 *
 * @param {object} state 状态副本（就地修改）。
 * @param {object} op 操作。
 * @returns {{ok: boolean, changed?: boolean, notice?: string, error?: string}}
 */
export function applyOp(state, op) {
  const kind = typeof op?.op === "string" ? op.op : "";
  const find = (id) => state.profiles.find((p) => p.id === id);
  if (state.sessions === undefined || state.sessions === null) state.sessions = {};
  const sessionIdOf = (value) =>
    typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, LIMITS.sessionId) : "";
  /**
   * 写入一条会话设定。
   *
   * ⚠ **空设定要删掉而不是留一条空记录**：否则「有专属设定的对话数」
   *   会把所有被点开过的对话都算进去，这个数字立刻就没意义了。
   */
  const putSession = (sessionId, patch) => {
    const existing = state.sessions[sessionId];
    const next = normalizeSession(sessionId, {
      profileId: patch.profileId !== undefined ? patch.profileId : existing?.profileId ?? null,
      note: patch.note !== undefined ? patch.note : existing?.note ?? "",
      memories: patch.memories !== undefined ? patch.memories : existing?.memories ?? [],
      updatedAt: Date.now(),
    });
    if (next === null) delete state.sessions[sessionId];
    else state.sessions[sessionId] = next;
    return next;
  };

  switch (kind) {
    case "profile.create": {
      if (state.profiles.length >= LIMITS.profiles) {
        return { ok: false, error: `最多 ${LIMITS.profiles} 套配置。` };
      }
      const source = op.profile !== null && typeof op.profile === "object" ? op.profile : {};
      const profile = normalizeProfile(
        {
          name: source.name ?? `新配置 ${state.profiles.length + 1}`,
          icon: source.icon ?? "🧩",
          role: source.role ?? "",
          personality: source.personality ?? "",
          speech: source.speech ?? "",
          rules: source.rules ?? "",
          memorySummary: source.memorySummary ?? "",
        },
        state.profiles.length,
      );
      state.profiles.push(profile);
      // 新建后**立刻切到它**：用户的下一步动作必然是编辑它，
      // 停在旧配置上会让人疑惑「我刚建的去哪了」。
      state.activeId = profile.id;
      return { ok: true, changed: true, notice: `已新建「${profile.name}」并设为当前配置。`, id: profile.id };
    }

    case "profile.update": {
      const target = find(op.id);
      if (target === undefined) return { ok: false, error: "没有这套配置（可能已被删除）。" };
      const patch = op.patch !== null && typeof op.patch === "object" ? op.patch : {};
      const merged = normalizeProfile({ ...target, ...patch }, 0);
      if (merged.id !== target.id) merged.id = target.id;
      merged.createdAt = target.createdAt;
      merged.updatedAt = Date.now();
      Object.assign(target, merged);
      return { ok: true, changed: true, notice: `已保存「${target.name}」。` };
    }

    case "profile.duplicate": {
      const source = find(op.id);
      if (source === undefined) return { ok: false, error: "没有这套配置（可能已被删除）。" };
      if (state.profiles.length >= LIMITS.profiles) {
        return { ok: false, error: `最多 ${LIMITS.profiles} 套配置。` };
      }
      const copy = clone(source);
      copy.id = newId("p");
      copy.name = `${source.name} 副本`.slice(0, LIMITS.name);
      copy.createdAt = Date.now();
      copy.updatedAt = Date.now();
      copy.memories = copy.memories.map((m) => ({ ...m, id: newId("m") }));
      state.profiles.push(copy);
      state.activeId = copy.id;
      return { ok: true, changed: true, notice: `已复制为「${copy.name}」。`, id: copy.id };
    }

    case "profile.delete": {
      const target = find(op.id);
      if (target === undefined) return { ok: false, error: "没有这套配置（可能已被删除）。" };
      // 至少留一套：删光了 activeId 就无处可指，界面会变成空的。
      if (state.profiles.length <= 1) {
        return { ok: false, error: "至少要保留一套配置。" };
      }
      state.profiles = state.profiles.filter((p) => p.id !== target.id);
      if (state.activeId === target.id) state.activeId = state.profiles[0].id;
      // 指向它的会话绑定必须一起解开：留着的话那些对话会绑到一个不存在的配置，
      // 注入静默回落到全局，而界面上还显示着「已固定」——两边对不上最难查。
      let rebound = 0;
      for (const session of Object.values(state.sessions)) {
        if (session.profileId === target.id) {
          session.profileId = null;
          rebound += 1;
        }
      }
      return {
        ok: true,
        changed: true,
        notice:
          rebound === 0
            ? `已删除「${target.name}」。`
            : `已删除「${target.name}」，${rebound} 个对话改回跟随全局。`,
      };
    }

    case "profile.activate": {
      const target = find(op.id);
      if (target === undefined) return { ok: false, error: "没有这套配置（可能已被删除）。" };
      if (state.activeId === target.id) {
        return { ok: true, changed: false, notice: `「${target.name}」已经是当前配置。` };
      }
      state.activeId = target.id;
      return { ok: true, changed: true, notice: `已切换到「${target.name}」，从下一次回复起生效。` };
    }

    case "memory.add": {
      const target = find(op.profileId);
      if (target === undefined) return { ok: false, error: "没有这套配置。" };
      const body = text(op.text, LIMITS.memoryText);
      if (body === "") return { ok: false, error: "记忆内容不能为空。" };
      if (target.memories.length >= LIMITS.memories) {
        return { ok: false, error: `每套配置最多 ${LIMITS.memories} 条记忆。` };
      }
      target.memories.push({ id: newId("m"), text: body, createdAt: Date.now() });
      target.updatedAt = Date.now();
      return { ok: true, changed: true, notice: "已添加记忆。" };
    }

    case "memory.update": {
      const target = find(op.profileId);
      if (target === undefined) return { ok: false, error: "没有这套配置。" };
      const memory = target.memories.find((m) => m.id === op.memoryId);
      if (memory === undefined) return { ok: false, error: "没有这条记忆。" };
      const body = text(op.text, LIMITS.memoryText);
      if (body === "") return { ok: false, error: "记忆内容不能为空（要删就用删除）。" };
      memory.text = body;
      target.updatedAt = Date.now();
      return { ok: true, changed: true, notice: "已更新记忆。" };
    }

    case "memory.remove": {
      const target = find(op.profileId);
      if (target === undefined) return { ok: false, error: "没有这套配置。" };
      const before = target.memories.length;
      target.memories = target.memories.filter((m) => m.id !== op.memoryId);
      if (target.memories.length === before) return { ok: false, error: "没有这条记忆。" };
      target.updatedAt = Date.now();
      return { ok: true, changed: true, notice: "已删除记忆。" };
    }

    case "memory.clear": {
      const target = find(op.profileId);
      if (target === undefined) return { ok: false, error: "没有这套配置。" };
      if (target.memories.length === 0) return { ok: true, changed: false, notice: "记忆本来就是空的。" };
      const count = target.memories.length;
      target.memories = [];
      target.updatedAt = Date.now();
      return { ok: true, changed: true, notice: `已清空 ${count} 条记忆。` };
    }

    /**
     * 批量追加长期记忆（自动提炼与工具走这条）。
     *
     * 和 `memory.add` 的区别：这里是**批量 + 去重 + 不因为单条失败就整批失败**。
     * 自动路径是后台跑的，最怕「模型返回了 5 条，其中 1 条超长，结果 5 条全没存」。
     *
     * 去重按**去空白后的全文**比对（大小写敏感）：模型很容易把同一件事说两遍，
     * 而重复记忆既费预算又会让压缩更早触发。
     */
    case "memory.autoAdd": {
      const target = find(op.profileId);
      if (target === undefined) return { ok: false, error: "没有这套配置。" };
      const texts = Array.isArray(op.texts) ? op.texts : [];
      const seen = new Set(target.memories.map((m) => String(m.text).replace(/\s+/g, " ").trim()));
      let added = 0;
      let skipped = 0;
      for (const raw of texts) {
        if (typeof raw !== "string") continue;
        const body = text(raw, LIMITS.memoryText);
        if (body === "") continue;
        const key = body.replace(/\s+/g, " ").trim();
        if (seen.has(key)) {
          skipped += 1;
          continue;
        }
        if (target.memories.length >= LIMITS.memories) {
          skipped += 1;
          continue;
        }
        seen.add(key);
        target.memories.push({ id: newId("m"), text: body, createdAt: Date.now() });
        added += 1;
      }
      if (added === 0) {
        return {
          ok: true,
          changed: false,
          added: 0,
          notice: skipped > 0 ? "没有新记忆（都重复了）。" : "没有新记忆。",
        };
      }
      target.updatedAt = Date.now();
      return { ok: true, changed: true, added, notice: `新增 ${added} 条记忆。` };
    }

    /**
     * 用压缩结果**替换**长期记忆（摘要 + 条目）。
     *
     * 这是「提炼压缩」的落地点：输入是模型给的合并结果，这里是唯一的写入口 ——
     * 压缩只经过这一个算子，就不会出现「摘要改了但条目没改」这种半截状态。
     */
    case "memory.compact": {
      const target = find(op.profileId);
      if (target === undefined) return { ok: false, error: "没有这套配置。" };
      const summary = text(op.summary ?? "", LIMITS.memorySummary);
      const texts = (Array.isArray(op.texts) ? op.texts : [])
        .map((raw) => (typeof raw === "string" ? text(raw, LIMITS.memoryText) : ""))
        .filter((body) => body !== "")
        .slice(0, LIMITS.memories);
      const before = target.memories.length;
      target.memorySummary = summary;
      target.memories = texts.map((body) => ({ id: newId("m"), text: body, createdAt: Date.now() }));
      target.updatedAt = Date.now();
      return {
        ok: true,
        changed: true,
        notice: `已压缩长期记忆：${before} 条 → ${texts.length} 条，摘要 ${summary.length} 字。`,
      };
    }

    // ── 会话专属设定（每个对话一套）────────────────────────────
    //
    // 语义：**这一条对话**用哪套配置、外加什么补充设定与专属记忆。
    // 与「当前启用配置」（全局）是两层：会话没绑定时跟随全局。
    case "session.set": {
      const sessionId = sessionIdOf(op.sessionId);
      if (sessionId === "") return { ok: false, error: "缺少会话 id。" };
      const patch = op.patch !== null && typeof op.patch === "object" ? op.patch : {};
      if (patch.profileId !== undefined && patch.profileId !== null && find(patch.profileId) === undefined) {
        return { ok: false, error: "要绑定的配置不存在（可能已被删除）。" };
      }
      const next = putSession(sessionId, patch);
      return {
        ok: true,
        changed: true,
        notice:
          next === null
            ? "本对话已改回跟随全局。"
            : `已保存本对话设定${next.profileId === null ? "（跟随全局）" : ""}。`,
      };
    }

    case "session.clear": {
      const sessionId = sessionIdOf(op.sessionId);
      if (sessionId === "") return { ok: false, error: "缺少会话 id。" };
      if (state.sessions[sessionId] === undefined) {
        return { ok: true, changed: false, notice: "本对话本来就没有专属设定。" };
      }
      delete state.sessions[sessionId];
      return { ok: true, changed: true, notice: "已清除本对话的专属设定，改回跟随全局。" };
    }

    case "sessions.clearAll": {
      const count = Object.keys(state.sessions).length;
      if (count === 0) return { ok: true, changed: false, notice: "没有对话设过专属设定。" };
      state.sessions = {};
      return { ok: true, changed: true, notice: `已清除 ${count} 个对话的专属设定。` };
    }

    case "state.import": {
      const mode = op.mode === "merge" ? "merge" : "replace";
      const result = importInto(state, op.payload, mode);
      if (result.ok !== true) return { ok: false, error: result.error };
      return {
        ok: true,
        changed: true,
        notice:
          mode === "merge"
            ? `已合并导入 ${result.imported} 套配置。`
            : `已用导入内容覆盖：${result.imported} 套配置。`,
      };
    }

    case "state.restoreDefaults": {
      const fresh = defaultState();
      state.profiles = fresh.profiles;
      state.activeId = fresh.activeId;
      // 出厂化连会话绑定一起清：配置都换成新 id 了，
      // 留着旧绑定只会得到一堆指向不存在配置的悬空记录。
      state.sessions = {};
      return { ok: true, changed: true, notice: "已恢复出厂设置（原有配置与各对话的专属设定已全部清除）。" };
    }

    default:
      return { ok: false, error: `未知操作：${kind === "" ? "(空)" : kind}` };
  }
}

/**
 * 配置仓库：内存一份 + 磁盘一份，写走原子替换，变更走串行链。
 */
export class ProfileStore {
  /**
   * @param {string} dataDir 数据目录。
   */
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, STATE_FILE);
    /** @type {{version:number, activeId:string, profiles:object[]}} */
    this.state = defaultState();
    /** 最近一次读写失败原因（供界面显示，不抛给调用方）。 */
    this.lastError = null;
    /** 真实来源：true = 磁盘上确实有文件（区别于「刚回退到默认值」）。 */
    this.loadedFromDisk = false;
    /** @type {Promise<unknown>} 串行链，保证并发变更不丢更新。 */
    this._chain = Promise.resolve();
    /** @type {Set<Function>} 变更监听者（技能目录靠它失效重算）。 */
    this._listeners = new Set();
  }

  /**
   * 从磁盘加载。**不抛错**：失败就用默认值并记下原因。
   * @returns {boolean} 是否读到了合法文件。
   */
  load() {
    try {
      if (!fs.existsSync(this.file)) {
        this.state = defaultState();
        this.lastError = null;
        this.loadedFromDisk = false;
        return false;
      }
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
      this.state = normalizeState(parsed);
      this.lastError = null;
      this.loadedFromDisk = true;
      return true;
    } catch (error) {
      this.state = defaultState();
      this.lastError = `${error?.code ?? "ERR"}: ${error?.message ?? String(error)}`;
      this.loadedFromDisk = false;
      return false;
    }
  }

  /** 状态深拷贝（给提示词渲染与 HTTP 响应用，调用方改不到内部状态）。 */
  snapshot() {
    return clone(this.state);
  }

  /**
   * 当前启用的配置（**全局**那一层）。
   * @returns {object|undefined}
   */
  activeProfile() {
    return this.state.profiles.find((p) => p.id === this.state.activeId);
  }

  /**
   * 按 id 取配置。
   * @param {string} id 配置 id。
   * @returns {object|undefined}
   */
  profileById(id) {
    return this.state.profiles.find((p) => p.id === id);
  }

  /**
   * 订阅「配置变了」。注册技能目录那边要靠它让缓存失效重算，
   * 否则用户改了配置名/描述，技能目录里还是旧的。
   *
   * @param {Function} listener 回调。
   * @returns {Function} 退订。
   */
  onChange(listener) {
    if (typeof listener !== "function") return () => {};
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  }

  /**
   * 变更广播。
   *
   * ⚠ 每个监听者单独 try/catch：一个订阅者抛错不该让整条写入链失败 ——
   *   那等于「配置存不进去」，而原因只是技能目录刷新失败。
   */
  _emitChange() {
    for (const listener of this._listeners) {
      try {
        listener();
      } catch {
        /* 单个订阅者出错不影响别人 */
      }
    }
  }

  /**
   * 某个会话的专属设定（没有就返回 null）。
   * @param {string} sessionId 会话 id。
   * @returns {object|null}
   */
  sessionOf(sessionId) {
    if (typeof sessionId !== "string" || sessionId === "") return null;
    return this.state.sessions[sessionId] ?? null;
  }

  /**
   * 某个会话**实际生效**的配置：绑定了就用绑定的，否则回落到全局当前配置。
   *
   * 注入路径与界面都走这一个函数 —— 两边各算一次迟早会算出不一样的结果。
   *
   * @param {string} sessionId 会话 id。
   * @returns {{profile: object|undefined, session: object|null, bound: boolean}}
   */
  effective(sessionId) {
    const session = this.sessionOf(sessionId);
    const bound = session !== null && session.profileId !== null;
    const profile = bound ? this.profileById(session.profileId) : this.activeProfile();
    // 绑定的配置被删了（外部手改 JSON 等）时不能返回 undefined —— 那等于这个对话没有注入。
    return { profile: profile ?? this.activeProfile(), session, bound };
  }

  /**
   * 原子落盘。
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  async persist() {
    try {
      await fs.promises.mkdir(this.dataDir, { recursive: true });
      const body = `${JSON.stringify(this.state, null, 2)}\n`;
      // 先写 tmp 再 rename：rename 在同一分区上是原子的，
      // 所以磁盘上永远是「旧的完整文件」或「新的完整文件」，不会是半截。
      const tmp = `${this.file}.tmp`;
      await fs.promises.writeFile(tmp, body, "utf8");
      await fs.promises.rename(tmp, this.file);
      this.lastError = null;
      this.loadedFromDisk = true;
      return { ok: true };
    } catch (error) {
      this.lastError = `${error?.code ?? "ERR"}: ${error?.message ?? String(error)}`;
      return { ok: false, error: this.lastError };
    }
  }

  /**
   * 执行一个变更：副本上试算 → 落盘 → 成功才换内存。
   *
   * ⚠ 顺序很重要：**先落盘再换内存**。反过来的话，落盘失败时内存已经变了，
   *   界面显示「已保存」而重启后配置回退 —— 用户会认为插件在骗他。
   *
   * @param {object} op 操作。
   * @returns {Promise<{ok: boolean, state?: object, notice?: string, error?: string}>}
   */
  async command(op) {
    const run = async () => {
      const draft = this.snapshot();
      const result = applyOp(draft, op);
      if (result.ok !== true) return { ok: false, error: result.error };
      if (result.changed !== true) {
        return { ok: true, state: this.snapshot(), notice: result.notice, ...extraFieldsOf(result) };
      }
      const previous = this.state;
      this.state = draft;
      const written = await this.persist();
      if (written.ok !== true) {
        this.state = previous;
        return { ok: false, error: `保存失败：${written.error}` };
      }
      // 落盘成功之后才广播 —— 失败已回滚，那时候广播会让技能目录算出不存在的内容。
      this._emitChange();
      return {
        ok: true,
        state: this.snapshot(),
        notice: result.notice,
        activeId: this.state.activeId,
        // ⚠ 算子的**附加字段**必须带出去（例如 `memory.autoAdd` 的 `added`）。
        //   只回传 notice 的话，后台提炼会以为「一条都没加」⇒ 不记日志、不计数，
        //   现象是「记忆明明存进去了，日志和诊断里却什么都没有」——极难查。
        ...extraFieldsOf(result),
      };
    };
    // 链上挂一次，失败也继续 —— 否则一次校验失败会让后续所有写操作卡死。
    const next = this._chain.then(run, run);
    this._chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /** 状态摘要（界面顶部状态行用）。 */
  describe() {
    return {
      version: SCHEMA_VERSION,
      dataDir: this.dataDir,
      file: this.file,
      profileCount: this.state.profiles.length,
      activeId: this.state.activeId,
      activeName: this.activeProfile()?.name ?? "",
      memoryCount: this.state.profiles.reduce((sum, p) => sum + p.memories.length, 0),
      sessionCount: Object.keys(this.state.sessions).length,
      sessionMemoryCount: Object.values(this.state.sessions).reduce(
        (sum, s) => sum + s.memories.length,
        0,
      ),
      lastError: this.lastError,
      loadedFromDisk: this.loadedFromDisk,
    };
  }
}

export { STATE_FILE, DEFAULT_PROFILES };
