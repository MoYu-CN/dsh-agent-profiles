/**
 * 长期记忆的**自动化**部分。
 *
 * 两条通道（用户明确选了「两者都要」）：
 *
 *   ① **工具**（`memory_save`）—— 模型觉得某件事值得长期记住时主动存。
 *      零额外开销，但取决于模型自觉。
 *   ② **后台提炼**（每 N 个回合）—— 插件读对话、调一次模型、把要点存进去。
 *      全自动，不依赖模型自觉；代价是每 N 回合一次额外模型调用（花用户的 token）。
 *
 * 外加**超限压缩**：长期记忆总字数超过 `LIMITS.memoryTotal` 时，
 * 后台把它合并成「摘要 + 精简条目」，长此以往不会无限膨胀。
 *
 * ## 这个文件的硬约束（每一条都对应一种「把会话弄坏」的形态）
 *
 * 1. **绝不抛错到调用方**。这里是**后台**跑的：任何异常都不该影响用户正在进行的对话。
 *    所有对外调用都包 try/catch，失败只记日志。
 * 2. **绝不并发**。同一个会话同一时刻只跑一次提炼；否则两次跑起来会重复写同一批记忆。
 * 3. **输入必须有上限**。送给模型的对话摘录截断到 `EXTRACT_MAX_CHARS`，
 *    否则一个长会话能烧掉几万 token —— 那是用户的钱。
 * 4. **输出必须能解析**。要求模型「一行一条」，不用 JSON：
 *    JSON 一旦格式跑偏就整批丢失，而行文本最坏情况只是存进一条废话。
 */

import { LIMITS, memoryChars } from "./store.js";

/** 工具名。模型看到的就是这个名字。 */
export const MEMORY_TOOL_NAME = "memory_save";

/** 每多少个回合跑一次后台提炼。 */
export const EXTRACT_EVERY_TURNS = 5;

/** 送给模型的对话摘录上限（字符）。 */
export const EXTRACT_MAX_CHARS = 6000;

/** 一次提炼最多新增几条（多了就是没提炼，只是搬运）。 */
export const EXTRACT_MAX_NEW = 5;

/** 单次模型调用的输出上限（token）。 */
const EXTRACT_MAX_TOKENS = 700;
const COMPACT_MAX_TOKENS = 1400;

/** 单次模型调用的墙钟上限：卡住的调用不能一直挂着。 */
const CALL_TIMEOUT_MS = 90_000;

/** 提炼用的系统提示词。 */
const EXTRACT_SYSTEM = [
  "你在为一个 AI 助手维护长期记忆。",
  "读下面这段对话，挑出**以后还用得上**的信息：用户的偏好、习惯、身份、约定、长期目标、明确要求。",
  "不要记：一次性的任务细节、临时报错、助手自己说过的话、可以从对话本身推出来的常识。",
  "要求：每条一句话，独立完整，脱离这段对话也能读懂；不要编号、不要项目符号、不要解释。",
  `最多 ${EXTRACT_MAX_NEW} 条。如果一条都不值得记，只输出「无」。`,
].join("\n");

/** 压缩用的系统提示词。 */
const COMPACT_SYSTEM = [
  "你在为一个 AI 助手整理长期记忆。下面的记忆已经超出字数预算，需要无损地压缩。",
  "规则：",
  "1. 保留事实，**不要编造**，不要补充原文没有的信息。",
  "2. 合并重复项；把多条相关的合并成一条；丢掉已经过时或被后续覆盖的。",
  `3. 输出两段：第一行以「摘要：」开头，写一段不超过 800 字的总体摘要；`,
  "   之后每行一条精简后的记忆（每条不超过 120 字，最多 20 条），不要编号。",
].join("\n");

/**
 * 取出本对话生效的配置（会话绑定优先，否则全局当前）。
 *
 * 自己算，不依赖 store 的方法 —— 后台任务是**延迟**跑的，
 * 跑的时候用户可能已经切了配置，这里要保证「按当下这一刻的状态算」。
 *
 * @param {object} store ProfileStore。
 * @param {string} sessionId 会话 id。
 * @returns {object|null} 配置。
 */
export function effectiveProfileFor(store, sessionId) {
  try {
    const state = store?.state;
    if (state === null || state === undefined) return null;
    const profiles = Array.isArray(state.profiles) ? state.profiles : [];
    if (typeof sessionId === "string" && sessionId !== "") {
      const session = (state.sessions ?? {})[sessionId] ?? null;
      const boundId = session !== null && typeof session.profileId === "string" ? session.profileId : "";
      if (boundId !== "") {
        const bound = profiles.find((p) => p.id === boundId);
        if (bound !== undefined) return bound;
      }
    }
    return profiles.find((p) => p.id === state.activeId) ?? null;
  } catch {
    return null;
  }
}

/**
 * 把模型输出切成记忆条目。
 *
 * 只用行文本、不用 JSON：模型偶尔会带编号/项目符号/前后废话，这里全部剥掉。
 * 「无」「没有」这类明确的空答复识别为空数组，免得存进一条「无」。
 *
 * @param {string} text 模型输出。
 * @returns {string[]} 记忆条目。
 */
export function parseMemoryLines(text) {
  if (typeof text !== "string" || text.trim() === "") return [];
  const out = [];
  const seen = new Set();
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (line === "") continue;
    // 剥掉常见的编号与项目符号：1. / 1、/ - / * / • / 一、
    line = line.replace(/^\s*(?:[-*•·]|\d{1,3}\s*[.、)）]|[一二三四五六七八九十]{1,3}\s*[.、)）])\s*/, "").trim();
    if (line === "") continue;
    if (/^(无|没有|暂无|none|n\/a)[。.！!]?$/i.test(line)) continue;
    if (line.startsWith("摘要：")) continue;
    const clipped = line.length > LIMITS.memoryText ? line.slice(0, LIMITS.memoryText) : line;
    const key = clipped.replace(/\s+/g, " ");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clipped);
  }
  return out;
}

/**
 * 解析压缩结果：第一段是摘要，其余每行一条。
 *
 * @param {string} text 模型输出。
 * @returns {{summary: string, texts: string[]}} 压缩结果。
 */
export function parseCompactResult(text) {
  const result = { summary: "", texts: [] };
  if (typeof text !== "string" || text.trim() === "") return result;
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");
  const rest = [];
  for (const line of lines) {
    if (line.startsWith("摘要：") || line.startsWith("摘要:")) {
      result.summary = line.replace(/^摘要[:：]\s*/, "").trim();
      continue;
    }
    rest.push(line);
  }
  result.texts = parseMemoryLines(rest.join("\n"));
  // 摘要过长时截断到存储上限（宁可截断也不要整次压缩失败）。
  if (result.summary.length > LIMITS.memorySummary) {
    result.summary = result.summary.slice(0, LIMITS.memorySummary);
  }
  return result;
}

/**
 * 装「记忆工具」：给模型一个主动写入长期记忆的入口。
 *
 * 注册在**插件的 ctx** 上（全局可见）：任何对话里都能用。
 * 写入目标按 `exec.agent.id` 当场解析 —— 绝不缓存「当前配置 id」，
 * 否则用户在对话中途切换配置会写错地方。
 *
 * @param {object} ctx 宿主插件上下文。
 * @param {object} deps 依赖（store / logger）。
 * @returns {Function} 注销函数。
 */
export function installMemoryTool(ctx, deps) {
  const { store, logger } = deps;
  const tools = ctx.get?.("tools") ?? null;
  if (tools === null || typeof tools.register !== "function") {
    logger?.warn?.("[dsh-agent-profiles] 未取到 tools 服务：模型不能主动存记忆（后台提炼照常）。");
    return () => {};
  }
  try {
    return tools.register({
      name: MEMORY_TOOL_NAME,
      description:
        "把值得长期记住的信息写进当前智能体的长期记忆（跨对话保留，下次开新对话仍生效）。" +
        "只在信息确实长期有用时调用：用户的偏好、习惯、身份、长期目标、明确要求。" +
        "不要存一次性的任务细节、临时报错，也不要复述助手自己刚说过的话。",
      parameters: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description: "一条独立、完整、脱离当前对话也能读懂的记忆，一句话说完。",
          },
        },
        required: ["content"],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: "object",
          properties: {
            ok: { type: "boolean" },
            saved: { type: "string" },
            count: { type: "number" },
            error: { type: "string" },
          },
          required: ["ok"],
          additionalProperties: false,
        },
        render: (_args, value) => {
          const ok = value !== null && typeof value === "object" && value.ok === true;
          if (ok) {
            return [{ type: "text", text: `已记住（当前共 ${Number(value.count) || 0} 条长期记忆）。` }];
          }
          const reason = value !== null && typeof value === "object" && typeof value.error === "string" ? value.error : "未知原因";
          return [{ type: "text", text: `没能记住：${reason}` }];
        },
      },
      async execute(args, exec) {
        const content = args !== null && typeof args === "object" && typeof args.content === "string" ? args.content.trim() : "";
        if (content === "") return { ok: false, error: "内容为空。" };
        const sessionId = typeof exec?.agent?.id === "string" ? exec.agent.id : "";
        const profile = effectiveProfileFor(store, sessionId);
        if (profile === null) return { ok: false, error: "当前没有生效的智能体配置。" };
        const result = await store.command({
          op: "memory.autoAdd",
          profileId: profile.id,
          texts: [content],
        });
        if (result?.ok !== true) return { ok: false, error: String(result?.error ?? "写入失败") };
        const after = store.profileById(profile.id);
        return {
          ok: true,
          saved: content,
          count: Array.isArray(after?.memories) ? after.memories.length : 0,
        };
      },
      isConcurrencySafe: () => false,
    });
  } catch (error) {
    // 注册失败只降级：记忆工具没有，别的功能照常。
    logger?.warn?.(`[dsh-agent-profiles] 记忆工具注册失败：${error?.message ?? String(error)}`);
    return () => {};
  }
}

/**
 * 装「后台提炼 + 超限压缩」。
 *
 * 触发点：`agent/status` 变成 `idle`（一个回合跑完）。
 * ⚠ 不能挂 `running`：那是回合**开始**，那时对话内容还没产生。
 *
 * @param {object} ctx 宿主插件上下文。
 * @param {object} deps 依赖（store / logger / diagnostics）。
 * @returns {Function} 注销函数。
 */
export function installAutoMemory(ctx, deps) {
  const { store, logger, diagnostics } = deps;
  /** 每个会话的回合计数（内存态：重启后从头数，最坏只是晚一点提炼一次）。 */
  const turns = new Map();
  /** 正在跑的会话：防止同一会话并发提炼、重复写记忆。 */
  const running = new Set();
  const state = { extracts: 0, compactions: 0, lastAt: null, lastError: null };

  // ⚠ 缺服务要**在装载时就说清楚**，而不是每次静默跳过。
  //   静默跳过的现象是「功能好像没生效」，用户无从判断是没触发还是没能力 ——
  //   这正是「失败必须可查」这条规矩针对的情形。
  if ((ctx.get?.("sessionQuery") ?? null) === null) {
    logger?.warn?.(
      "[dsh-agent-profiles] 未取到 sessionQuery 服务：后台提炼读不到对话（超限压缩照常，模型主动存记忆照常）。",
    );
  }

  const record = (patch) => {
    Object.assign(state, patch);
    if (diagnostics !== undefined && diagnostics !== null) diagnostics.memory = { ...state };
  };

  /** 读对话摘录（有上限）。拿不到就返回空串，绝不抛错。 */
  const readTranscript = async (sessionId) => {
    try {
      const query = ctx.get?.("sessionQuery") ?? null;
      if (query === null) return "";
      const filters = [{ kind: "type", values: ["user/message", "assistant/message"] }];
      let docs = null;
      if (typeof query.filterEvents === "function") {
        docs = await query.filterEvents(sessionId, filters);
      }
      if (!Array.isArray(docs)) {
        // 退路：直接读整份日志，自己挑消息事件。
        const snapshot = await query.readSession(sessionId);
        const events = Array.isArray(snapshot?.events) ? snapshot.events : [];
        docs = events
          .filter((e) => e?.type === "user/message" || e?.type === "assistant/message")
          .map((e) => ({ type: e.type, text: textOfMessage(e?.data?.message) }));
      }
      const parts = [];
      let total = 0;
      // 从**后往前**取：越近的对话越可能包含值得记的东西。
      for (let i = docs.length - 1; i >= 0; i -= 1) {
        const doc = docs[i];
        const body = typeof doc?.text === "string" && doc.text !== "" ? doc.text : textOfMessage(doc?.data?.message);
        if (typeof body !== "string" || body.trim() === "") continue;
        const who = doc?.type === "user/message" ? "用户" : "助手";
        const line = `${who}：${body.trim()}`;
        if (total + line.length > EXTRACT_MAX_CHARS) break;
        parts.unshift(line);
        total += line.length;
      }
      return parts.join("\n");
    } catch (error) {
      logger?.warn?.(`[dsh-agent-profiles] 读对话失败（本次跳过提炼）：${error?.message ?? String(error)}`);
      return "";
    }
  };

  /** 调一次模型，拿纯文本输出。失败返回 null（调用方跳过本次）。 */
  const askModel = async (system, userText, maxTokens) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
    try {
      const llm = ctx.get?.("llm") ?? null;
      if (llm === null || typeof llm.stream !== "function") {
        logger?.warn?.("[dsh-agent-profiles] 未取到 llm 服务：后台提炼与压缩不可用。");
        return null;
      }
      const selection = ctx.get?.("agentDefaultModel")?.currentSelection?.() ?? null;
      const provider = typeof selection?.provider === "string" ? selection.provider : "";
      const model = typeof selection?.model === "string" ? selection.model : "";
      if (provider === "" || model === "") {
        logger?.warn?.("[dsh-agent-profiles] 拿不到默认模型：后台提炼与压缩不可用。");
        return null;
      }
      let out = "";
      let failed = null;
      const stream = llm.stream({
        provider,
        model,
        system,
        messages: [{ role: "user", content: [{ type: "text", text: userText }] }],
        maxTokens,
        // 刻意不传 temperature：某些模型不接受显式采样参数，
        // 为了「更确定」而让整次调用被拒是不划算的。
        signal: controller.signal,
      });
      for await (const chunk of stream) {
        if (chunk?.type === "text-delta" && typeof chunk.text === "string") out += chunk.text;
        else if (chunk?.type === "finish" && chunk.reason?.kind !== "stop") {
          failed = chunk.reason?.failure?.message ?? chunk.reason?.kind ?? "未知";
        }
      }
      if (failed !== null) {
        logger?.warn?.(`[dsh-agent-profiles] 后台模型调用未正常结束：${failed}`);
        // 部分输出仍然可用时就用（提炼场景下总比什么都没有强）。
        return out.trim() === "" ? null : out;
      }
      return out;
    } catch (error) {
      logger?.warn?.(`[dsh-agent-profiles] 后台模型调用失败：${error?.message ?? String(error)}`);
      record({ lastError: String(error?.message ?? error) });
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  /** 超预算就压缩一次。 */
  const compactIfNeeded = async (profileId) => {
    const profile = store.profileById(profileId);
    if (profile === null || profile === undefined) return;
    const used = memoryChars(profile);
    if (used <= LIMITS.memoryTotal) return;
    const lines = [];
    if (typeof profile.memorySummary === "string" && profile.memorySummary !== "") {
      lines.push(`【已有摘要】\n${profile.memorySummary}`);
    }
    const memories = Array.isArray(profile.memories) ? profile.memories : [];
    if (memories.length > 0) {
      lines.push(`【逐条记忆】\n${memories.map((m, i) => `${i + 1}. ${m.text}`).join("\n")}`);
    }
    const reply = await askModel(COMPACT_SYSTEM, lines.join("\n\n"), COMPACT_MAX_TOKENS);
    if (reply === null) return;
    const parsed = parseCompactResult(reply);
    if (parsed.summary === "" && parsed.texts.length === 0) {
      logger?.warn?.("[dsh-agent-profiles] 压缩结果为空，保持原样（不冒险覆盖记忆）。");
      return;
    }
    const result = await store.command({
      op: "memory.compact",
      profileId,
      summary: parsed.summary,
      texts: parsed.texts,
    });
    if (result?.ok === true) {
      record({ compactions: state.compactions + 1, lastAt: Date.now() });
      logger?.info?.(
        `[dsh-agent-profiles] 长期记忆已压缩：${used} 字 → ${memoryChars(store.profileById(profileId))} 字。`,
      );
    } else {
      logger?.warn?.(`[dsh-agent-profiles] 压缩写入失败：${result?.error ?? "未知"}`);
    }
  };

  /** 一个会话跑一次「提炼 + 必要时压缩」。 */
  const runOnce = async (sessionId) => {
    if (running.has(sessionId)) return;
    running.add(sessionId);
    try {
      const profile = effectiveProfileFor(store, sessionId);
      if (profile === null) return;
      const transcript = await readTranscript(sessionId);
      if (transcript.trim() === "") {
        // 没有可读内容是正常情况（空对话 / 没有 sessionQuery），不是错误。
        await compactIfNeeded(profile.id);
        return;
      }
      const reply = await askModel(EXTRACT_SYSTEM, transcript, EXTRACT_MAX_TOKENS);
      if (reply !== null) {
        const lines = parseMemoryLines(reply).slice(0, EXTRACT_MAX_NEW);
        if (lines.length > 0) {
          const result = await store.command({
            op: "memory.autoAdd",
            profileId: profile.id,
            texts: lines,
          });
          if (result?.ok === true && result.added > 0) {
            record({ extracts: state.extracts + 1, lastAt: Date.now(), lastError: null });
            logger?.info?.(
              `[dsh-agent-profiles] 已从对话提炼 ${result.added} 条长期记忆（配置「${profile.name}」）。`,
            );
          }
        }
      }
      await compactIfNeeded(profile.id);
    } catch (error) {
      // 后台任务**绝不允许**把异常带出去。
      record({ lastError: String(error?.message ?? error) });
      logger?.warn?.(`[dsh-agent-profiles] 后台提炼异常（已忽略）：${error?.message ?? String(error)}`);
    } finally {
      running.delete(sessionId);
    }
  };

  let dispose = () => {};
  try {
    dispose = ctx.on("agent/status", (payload) => {
      try {
        if (payload?.status !== "idle") return;
        const sessionId = typeof payload?.agent?.id === "string" ? payload.agent.id : "";
        if (sessionId === "") return;
        const next = (turns.get(sessionId) ?? 0) + 1;
        turns.set(sessionId, next);
        if (next % EXTRACT_EVERY_TURNS !== 0) return;
        // fire-and-forget：后台跑，不阻塞对话。
        void runOnce(sessionId);
      } catch (error) {
        logger?.warn?.(`[dsh-agent-profiles] 回合计数异常（已忽略）：${error?.message ?? String(error)}`);
      }
    });
  } catch (error) {
    logger?.warn?.(`[dsh-agent-profiles] 监听 agent/status 失败：${error?.message ?? String(error)}`);
  }

  record({});
  return () => {
    try {
      dispose?.();
    } catch {
      /* 取消失败不影响卸载 */
    }
    turns.clear();
  };
}

/**
 * 从一条消息里抽纯文本（用于退路路径）。
 *
 * @param {object} message 消息对象。
 * @returns {string} 文本。
 */
function textOfMessage(message) {
  const content = message?.content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n");
}
