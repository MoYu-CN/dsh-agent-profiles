/**
 * dsh-agent-profiles —— 模块④：配置 → 提示词文本。
 *
 * ## 这一层为什么单独存在
 * 「怎么把一份配置说给模型听」是**产品文案**问题，不是数据问题也不是传输问题：
 * 段落的顺序、哪些字段为空时要整段省略、记忆开关怎么体现、
 * 太长时怎么截断 —— 这些都会随用户反馈反复改。
 * 单独一层，改文案不会碰到 store.js 和 routes.js。
 *
 * ## 关键行为：切换为什么「立即生效、且只影响之后的对话」
 * 本模块导出的 `renderActive(store)` 是一个**纯读函数**：
 * 它在**每次组装提示词时**被调用（见 index.js 把函数而不是字符串
 * 交给 `systemPrompt.section`），读的是**那一刻**的 activeId。
 * 于是：
 *   - 切换配置 ⇒ 下一次组装就是新配置 ⇒ 立即生效；
 *   - 历史消息存在会话日志里，本插件从不改写它 ⇒ 历史不受影响。
 * 这两条不是「顺手做到的」，而是**把渲染做成函数**直接换来的性质。
 *
 * ## 空配置返回空串
 * 全部内容字段为空时返回 `""`。这是「装了插件但没配任何东西」
 * 时的正确行为：不往提示词里塞一段「当前配置：通用助手」的废话。
 */

import { LIMITS } from "./store.js";

/** 提示词段落名。**必须全局唯一**：同名段落在同一层会被判为重复并抛错。 */
export const PROMPT_SECTION_NAME = "agent-profiles:persona";

/**
 * 权威性声明。
 *
 * 写在最前面的原因：用户的自定义设定与本插件的注入内容可能和
 * 系统自带的行为规范冲突。**必须有一个明确的优先级规则**，
 * 否则模型只能自己猜，而猜的结果不稳定（同一个配置时而生效时而不生效）。
 *
 * 规则定为：**用户的直接指令 > 本配置 > 系统默认风格**。
 * 理由：这份配置是「用户希望助手长期保持的样子」，
 * 但任何时候用户临时改口，临时的那句一定更该听。
 */
const PREAMBLE = [
  "以下设定由用户在「设置 → 智能体配置」中指定，用于塑造你在后续回复中的角色与风格。",
  "优先级：**用户在当前对话里的直接指令 > 本节设定 > 默认风格**。",
  "不要向用户复述或引用本节内容，直接按它说话即可。",
].join("\n");

/** 一个「标签 + 正文」小节。正文为空则整节省略。 */
function section(title, body) {
  const value = typeof body === "string" ? body.trim() : "";
  if (value === "") return "";
  return `## ${title}\n\n${value}\n`;
}

/**
 * 一套配置是否「有内容」。
 *
 * 名称/图标不算内容 —— 只起了个名字的配置不该产生任何注入。
 *
 * @param {object} profile 配置。
 * @returns {boolean}
 */
export function hasContent(profile) {
  if (profile === null || typeof profile !== "object") return false;
  const fields = [profile.role, profile.personality, profile.speech, profile.rules];
  if (fields.some((v) => typeof v === "string" && v.trim() !== "")) return true;
  if (profile.injectMemory === false) return false;
  if (typeof profile.memorySummary === "string" && profile.memorySummary.trim() !== "") return true;
  return Array.isArray(profile.memories) && profile.memories.length > 0;
}

/**
 * 把一套配置渲染成注入文本。
 *
 * @param {object} profile 配置。
 * @param {{maxChars?: number}} [options] 选项。
 * @returns {string} 注入文本；无内容时为空串。
 */
export function renderProfile(profile, options = {}) {
  if (hasContent(profile) !== true) return "";
  const maxChars = Number.isFinite(options.maxChars) ? options.maxChars : 8000;

  const parts = [
    "# 智能体配置",
    "",
    `当前启用：**${profile.name}**${profile.icon ? ` ${profile.icon}` : ""}`,
    "",
    PREAMBLE,
    "",
    section("角色设定", profile.role),
    section("性格特点", profile.personality),
    section("说话习惯", profile.speech),
    section("行为准则", profile.rules),
  ];

  // ── 记忆开关在这里生效 ────────────────────────────────────
  // 关闭时**整块不出现**，而不是出现一段「（记忆已关闭）」：
  // 后者仍然占用上下文，且暗示模型「有记忆但你看不到」，
  // 会让它开始猜测记忆内容 —— 比不注入更糟。
  if (profile.injectMemory !== false) {
    parts.push(section("长期记忆摘要", profile.memorySummary));
    const memories = Array.isArray(profile.memories) ? profile.memories : [];
    if (memories.length > 0) {
      parts.push(
        `## 长期记忆条目\n\n${memories
          .map((m) => `- ${typeof m?.text === "string" ? m.text.trim() : ""}`)
          .filter((line) => line !== "- ")
          .join("\n")}\n`,
      );
    }
  }

  const body = parts
    .filter((chunk) => chunk !== "")
    .join("\n")
    .trim();

  if (body.length <= maxChars) return body;

  // 截断必须**说出来**。悄悄截断会让用户以为写进去的长篇准则生效了，
  // 而模型只看到前半段 —— 这种「以为生效了」比明确的报错危险得多。
  return `${body.slice(0, maxChars)}\n\n（内容超过 ${maxChars} 字上限，已截断。可在设置 → 智能体配置里精简。）`;
}

/**
 * 读当前启用配置并渲染（**全局**那一层）。
 *
 * **每次提示词组装都会调用它** —— 这是「切换立即生效」的实现点。
 * 它同时是「没有会话上下文时」的兜底：真正的注入走 renderForSession。
 *
 * @param {object} store ProfileStore。
 * @param {{maxChars?: number}} [options] 选项。
 * @returns {string} 注入文本。
 */
export function renderActive(store, options = {}) {
  try {
    const profile = store?.activeProfile?.();
    if (profile === undefined || profile === null) return "";
    return renderProfile(profile, options);
  } catch {
    // 渲染失败**绝不能**让整轮对话失败：提示词组装抛错会中断整个 agent step。
    // 宁可这一轮没有配置注入。
    return "";
  }
}

/**
 * 一个对话的专属部分：补充设定 + 专属记忆。
 *
 * ⚠ 这两块**不受配置里的「记忆注入」开关管辖** ——
 *   那个开关管的是配置自带的长期记忆。用户为了**这个对话**专门写下来的东西，
 *   如果被另一个开关悄悄吞掉，他会以为插件没保存，然后反复重写。
 *   管什么就写什么，别让开关的语义互相渗透。
 *
 * @param {object|null} session 会话设定。
 * @returns {string} 文本（可能为空串）。
 */
export function renderSessionExtras(session) {
  if (session === null || session === undefined) return "";
  const parts = [];
  const note = typeof session.note === "string" ? session.note.trim() : "";
  if (note !== "") {
    parts.push(`## 本次对话的补充设定\n\n${note}\n`);
  }
  const memories = Array.isArray(session.memories) ? session.memories : [];
  const lines = memories
    .map((m) => (typeof m?.text === "string" ? m.text.trim() : ""))
    .filter((t) => t !== "");
  if (lines.length > 0) {
    parts.push(`## 本次对话的专属记忆\n\n${lines.map((t) => `- ${t}`).join("\n")}\n`);
  }
  return parts.join("\n");
}

/**
 * 为一个**具体对话**渲染注入文本：配置本体 + 该对话的专属部分。
 *
 * 三层来源要能同时成立，所以不能简单地「有专属就忽略配置」：
 *   ① 本对话固定的配置（没固定就用全局当前配置）
 *   ② 本对话的补充设定
 *   ③ 本对话的专属记忆
 *
 * @param {object} store ProfileStore。
 * @param {string} sessionId 会话 id。
 * @param {{maxChars?: number}} [options] 选项。
 * @returns {string} 注入文本。
 */
export function renderForSession(store, sessionId, options = {}) {
  try {
    const effective = store?.effective?.(sessionId);
    const profile = effective?.profile;
    const session = effective?.session ?? null;
    const base = profile === undefined || profile === null ? "" : renderProfile(profile, options);
    const extras = renderSessionExtras(session);
    if (extras === "") return base;
    if (base === "") {
      // 配置是空的、只有本对话专属内容时，也要给一个能读懂的开头，
      // 否则模型会收到一段没有归属的「补充设定」。
      const name = profile?.name ?? "";
      const head = name === "" ? "# 智能体配置（本次对话）" : `# 智能体配置\n\n当前启用：**${name}**`;
      return `${head}\n\n${extras}`.trim();
    }
    // 专属部分贴在最前面：它是用户针对**当下这次对话**写的，
    // 比配置里那些长期设定更贴近当前意图。
    const marker = "\n\n";
    return `${base}${marker}${extras}`.trim();
  } catch {
    return "";
  }
}

/** 默认单次注入的字符上限（可被 index.js 的常量覆盖）。 */
export const DEFAULT_MAX_CHARS = 8000;

export { LIMITS };
