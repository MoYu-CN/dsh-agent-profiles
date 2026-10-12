/**
 * dsh-agent-profiles —— 模块⑥：Host 入口（装配层）。
 *
 * 「智能体配置」：让用户建多套 AI 智能体配置（角色 / 性格 / 说话习惯 /
 * 行为准则 / 长期记忆），手动指定当前启用哪一套，并在设置界面里管理。
 *
 * ## 装配图
 *
 * ```
 *   store.js    ── 数据与磁盘（profiles.json）
 *      │
 *      ├─ prompt.js  ── 配置 → 注入文本
 *      │      │
 *      │      └─→ ctx.systemPrompt.section({text: () => renderActive(store)})
 *      │                 每次组装提示词时现算 ⇒ 切换立即生效
 *      │
 *      └─ routes.js  ── /__ap/* HTTP API ＋ index.html 脚本注入
 *                         ↕ 浏览器里的 client.js（设置页 + 快速切换器）
 * ```
 *
 * ## 两个刻意的设计选择
 *
 * **① 提示词段落交的是「函数」而不是「字符串」。**
 *   字符串在注册那一刻就定死了，之后切换配置不会生效 ——
 *   除非我们反过来去改已注册的段落（重复注册同名段落会抛错）。
 *   交函数则每次组装现算，切换天然「下一次回复生效」，
 *   而且**历史消息一个字都不用动**（我们从不写会话日志）。
 *
 * **② `systemPrompt` 不进 inject，走 ctx.get() 软探测。**
 *   声明进 inject 的话，缺这个服务会让**整个插件停在 pending** ——
 *   连设置界面都不出现，用户连「为什么没有界面」都无从判断。
 *   实际上：注入是增强，界面是本体，本体不该被增强拖死。
 *   （`webServer` 是硬依赖：没有它连界面都发不出去。）
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { ProfileStore, exportEnvelope } from "./store.js";
import { PROMPT_SECTION_NAME, hasContent, renderActive, renderForSession, renderProfile } from "./prompt.js";
import { installRoutes } from "./routes.js";
import { installAutoMemory, installMemoryTool } from "./memory.js";

/** 行名 / 段落名的前缀。与 cordis.patch.yml 的行 id 一致。 */
export const name = "agent-profiles";

/** 硬依赖：浏览器载体。没有它界面无法送达。 */
export const inject = ["webServer"];

/** 本文件所在目录（用于定位同目录的 client.js）。 */
const here = path.dirname(fileURLToPath(import.meta.url));

/** 数据目录名。放安装根下，卸载重装插件不丢配置。 */
const DATA_DIR_NAME = ".dsh-agent-profiles-data";

/** 单次注入的字符上限。 */
const MAX_PROMPT_CHARS = 8000;

/**
 * 提示词段落的位置。
 *
 * 取 860：在宿主核心身份段之后、工具说明与知识库总纲（本机另一个插件用 900）
 * 之前。放在这个档位的理由是**人设要先于工具说明被读到**，
 * 但它也不该去覆盖宿主自己的身份与安全约束，所以不进最前面的低号段。
 * 顺序只影响可读性，不影响是否生效 —— 真不顺眼改这一个数字即可。
 */
const PROMPT_ORDER = 860;

/** 技能 provider 的名字（一个层里唯一）。 */
const SKILL_PROVIDER_NAME = "agent-profiles";

/** 技能来源标记：运行期注册的插件技能。 */
const SKILL_SOURCE = "runtime";

/**
 * 技能名必须是 **kebab-case**（宿主按这个名字查）。
 *
 * 配置名往往是中文（「编程助手」），去掉非 ASCII 字符后会是空串 ——
 * 那时退回用配置 id 拼一个稳定的名字。**稳定性比好看重要**：
 * 技能名会在会话里被引用，不能这次叫 A、下次叫 B。
 *
 * @param {object} profile 配置。
 * @returns {string} kebab-case 技能名。
 */
function skillNameFor(profile) {
  const slug = String(profile?.name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const suffix = slug === "" ? String(profile?.id ?? "x").toLowerCase() : slug;
  return `agent-profile-${suffix}`.slice(0, 64);
}

/**
 * 当前该出现在技能目录里的候选。
 *
 * 只收**有内容**的配置：空配置加载出来是一段废话，列进目录只是噪音
 * （目录会进每次会话的系统提示词，这条路径上「少即是多」）。
 *
 * @param {object} store ProfileStore。
 * @returns {object[]} 候选数组。
 */
function skillCandidates(store) {
  const out = [];
  const profiles = store?.state?.profiles ?? [];
  for (let index = 0; index < profiles.length; index += 1) {
    const profile = profiles[index];
    if (hasContent(profile) !== true) continue;
    const summary = describeProfileForSkill(profile);
    out.push({
      name: skillNameFor(profile),
      description: summary,
      whenToUse: `当这次对话要以「${profile.name}」的身份与风格回复时。`,
      source: SKILL_SOURCE,
      invocation: { modelInvocable: true, userInvocable: true },
      provider: SKILL_PROVIDER_NAME,
      // rank：同一层里多个候选的排序权重（越小越靠前）。
      rank: index,
      // locator：宿主原样回传给 get()，我这里放配置 id。
      locator: { profileId: profile.id },
    });
  }
  return out;
}

/**
 * 技能目录里那行描述。
 *
 * 目录会进每次会话的系统提示词，所以**必须短**：角色设定取第一句/前 N 字，
 * 不要把整套人设塞进去 —— 那正是用户不想要的「占满整个上下文」。
 *
 * @param {object} profile 配置。
 * @returns {string} 一行描述。
 */
function describeProfileForSkill(profile) {
  const role = typeof profile?.role === "string" ? profile.role.trim() : "";
  const oneLine = role.replace(/\s+/g, " ");
  if (oneLine === "") return `用户配置的智能体「${profile.name}」（含性格、说话习惯与行为准则）。`;
  return oneLine.length > 80 ? `${oneLine.slice(0, 80)}…` : oneLine;
}

/**
 * 解析数据目录。
 *
 * 与同机其他插件同策略：**从可执行文件位置反推安装根，绝不硬编码盘符**
 * （写死盘符的版本换台机器就写不进数据，且失败是静默的）。
 *
 * @returns {string} 数据目录绝对路径。
 */
function resolveDataDir() {
  const explicit = process.env.DSH_AGENT_PROFILES_DATA;
  if (typeof explicit === "string" && explicit.trim() !== "") {
    return path.resolve(explicit.trim());
  }
  for (const candidate of [process.argv[1], process.execPath]) {
    if (typeof candidate !== "string" || candidate === "") continue;
    const dir = path.dirname(path.resolve(candidate));
    const marker = `${path.sep}resources${path.sep}`;
    const at = dir.indexOf(marker);
    if (at > 0) return path.join(dir.slice(0, at), DATA_DIR_NAME);
    if (path.basename(candidate).toLowerCase().startsWith("dsh")) {
      return path.join(dir, DATA_DIR_NAME);
    }
  }
  const installDir = process.env.DSH_INSTALL_DIR;
  if (typeof installDir === "string" && installDir.trim() !== "") {
    return path.join(path.resolve(installDir.trim()), DATA_DIR_NAME);
  }
  return path.resolve(here, "..", "..", DATA_DIR_NAME);
}

/**
 * 插件入口。
 *
 * @param {object} ctx Cordis 上下文。
 */
export function apply(ctx) {
  const dataDir = resolveDataDir();
  const store = new ProfileStore(dataDir);
  store.load();
  if (store.lastError !== null) {
    ctx.logger?.warn?.(`[dsh-agent-profiles] 配置读取失败，已用默认值：${store.lastError}`);
  }

  /**
   * 诊断计数：提示词提供函数被调用了几次。
   *
   * 为什么需要它：注入是本插件唯一「看不见」的能力 ——
   * 界面能截图，磁盘文件能打开，而「模型到底收没收到」只能靠证据。
   * 这个计数器由**宿主自己的组装流程**驱动：只要它不为零，
   * 就证明段落确实被组装进过提示词。它是给排查用的，不参与业务逻辑。
   */
  const diagnostics = {
    /** 全局兜底段落被组装的次数（没有会话上下文时走它）。 */
    rendersGlobal: 0,
    /** 会话作用域段落被组装的次数 —— 这个不为零 = 每对话注入真的在跑。 */
    rendersSession: 0,
    emptyRenders: 0,
    lastRenderAt: null,
    lastChars: 0,
    lastSessionId: null,
    scopedSessions: 0,
  };

  /**
   * 渲染草稿配置（供预览接口用）。
   * @param {unknown} profile 前端传来的草稿。
   * @returns {string}
   */
  function prepare(profile) {
    try {
      return renderProfile(profile, { maxChars: MAX_PROMPT_CHARS });
    } catch {
      return "";
    }
  }

  /** 每个对话的段落注销器。agent 重建（resume）时要先注销旧的。 */
  const scopedSections = new Map();
  /** 已经打过「会话段落已生效」日志的会话（日志只打一次，避免刷屏）。 */
  const loggedScoped = new Set();
  let warnedNoAgentCtx = false;

  // ── 提示词注入 ────────────────────────────────────────────
  //
  // 软探测：拿不到 systemPrompt 时**只丢注释入能力**，日志说清楚，
  // 界面照常可用（用户至少能看到配置、知道问题在哪）。
  const systemPrompt = ctx.get?.("systemPrompt") ?? null;
  if (systemPrompt === null) {
    ctx.logger?.warn?.("[dsh-agent-profiles] 未取到 systemPrompt 服务：配置界面可用，但不会注入到会话。");
  } else {
    // ① 全局兜底段：没有任何会话上下文时用它（配置本体照常生效，
    //    只是拿不到「本对话」的绑定，因为这里根本不知道是哪个对话）。
    //
    // ⚠⚠ **清理必须返回 thenable**（见下面 agent 段落的同一段注释）。
    ctx.effect(() => {
      const disposeSection = systemPrompt.section({
        name: PROMPT_SECTION_NAME,
        order: PROMPT_ORDER,
        text: () => {
          const text = renderActive(store, { maxChars: MAX_PROMPT_CHARS });
          diagnostics.rendersGlobal += 1;
          diagnostics.lastRenderAt = Date.now();
          diagnostics.lastChars = text.length;
          if (text === "") diagnostics.emptyRenders += 1;
          return text;
        },
      });
      return () => Promise.resolve().then(() => disposeSection?.());
    });

    // ② 每个对话一个**作用域段落**。
    //
    //    为什么必须挂在 agent 自己的 ctx 上而不是全局：
    //    同名段落里「作用域段落压过全局段段」，于是每个对话都能各自渲染
    //    —— 这是「每个对话一套智能体」唯一能落地的地方。
    //    `agent/created` 在工厂初始化后被 await，早于第一步组装，
    //    所以注册一定能赶在第一次注入之前完成。
    ctx.on("agent/created", ({ agent }) => {
      // 逃生开关：万一这段又出问题，设为 1 重启即可只保留全局注入，不必卸载插件。
      if (process.env.DSH_AGENT_PROFILES_NO_SESSION_SCOPE === "1") return;
      const sessionId = typeof agent?.id === "string" ? agent.id : "";
      const agentCtx = agent?.ctx;
      // agent.ctx 拿不到时**降级而不是抛错**：抛错会让 agent 创建失败
      // （事件是 await 的，抛了就中断创建），那比「本对话设定没生效」严重得多。
      if (sessionId === "" || agentCtx === null || agentCtx === undefined ||
          typeof agentCtx.effect !== "function") {
        if (warnedNoAgentCtx === false) {
          warnedNoAgentCtx = true;
          ctx.logger?.warn?.(
            "[dsh-agent-profiles] 拿不到 agent.ctx：每个对话的专属设定本次不生效，改为只注入全局配置。",
          );
        }
        return;
      }
      const previous = scopedSections.get(sessionId);
      if (typeof previous === "function") {
        try {
          previous();
        } catch {
          /* 旧的注销失败不该阻断新的注册 */
        }
      }
      try {
        // ⚠⚠⚠ **必须从 agent 自己的 ctx 上取 systemPrompt**，别用插件那个。
        //
        //   cordis 的服务代理按「取它的那个 ctx」绑定作用域：
        //   用插件的 ctx 取到的 systemPrompt 调 `.section()`，注册会落进**插件层**，
        //   于是与全局段落同名冲突 —— 宿主明确拒绝：
        //     prompt section "agent-profiles:persona" is already registered
        //     (for a per-agent override, register through that agent's `agent.ctx` instead)
        //   表现是「每个对话的专属设定静默失效、一律回落全局」：
        //   配置照存、预览照显示，**界面上完全看不出来**。
        //
        //   第一版就是那么写的，靠日志里那条 warning 才逮到。
        //   所以 test/host-wiring 现在断言「注册落在 agent 作用域，而不是插件作用域」。
        const scopedSystemPrompt =
          typeof agentCtx.get === "function" ? agentCtx.get("systemPrompt") ?? null : null;
        if (scopedSystemPrompt === null || typeof scopedSystemPrompt.section !== "function") {
          if (warnedNoAgentCtx === false) {
            warnedNoAgentCtx = true;
            ctx.logger?.warn?.(
              "[dsh-agent-profiles] 该 agent 作用域里取不到 systemPrompt：本次只有全局注入。",
            );
          }
          return;
        }
        const dispose = agentCtx.effect(() => {
          const disposeSection = scopedSystemPrompt.section({
            name: PROMPT_SECTION_NAME,
            order: PROMPT_ORDER,
            text: () => {
              const text = renderForSession(store, sessionId, { maxChars: MAX_PROMPT_CHARS });
              diagnostics.rendersSession += 1;
              diagnostics.lastRenderAt = Date.now();
              diagnostics.lastChars = text.length;
              diagnostics.lastSessionId = sessionId;
              if (text === "") diagnostics.emptyRenders += 1;
              if (loggedScoped.has(sessionId) === false) {
                loggedScoped.add(sessionId);
                ctx.logger?.info?.(
                  `[dsh-agent-profiles] 会话段落已生效：${sessionId}（注入 ${text.length} 字）`,
                );
              }
              return text;
            },
          });
          // ⚠⚠⚠ **这一行是 0.2.0 事故的修复点，别改回同步返回。**
          //
          //   宿主在 agent 销毁时会拿 effect 注销器的返回值去 `.catch()`。
          //   cordis 的 effect 只有在「清理链里有 thenable」时才让注销器返回 Promise；
          //   清理函数同步返回 undefined ⇒ 注销器返回 undefined ⇒ 宿主那边
          //   `undefined.catch(...)` ⇒
          //   TypeError: Cannot read properties of undefined (reading 'catch')
          //   ⇒ 记成「agent/disposed listener threw」，agent 销毁被弄脏，
          //     表现为**会话不可用、会话从左侧列表消失**。
          //
          //   实测（test/cordis-effect-probe.mjs）：
          //     同步清理 () => () => {}          → 注销器返回 undefined
          //     清理返回 Promise                  → 注销器返回 thenable ✓
          //   所以这里必须 `Promise.resolve().then(...)`，把清理变成异步。
          return () => Promise.resolve().then(() => disposeSection?.());
        });
        scopedSections.set(sessionId, typeof dispose === "function" ? dispose : () => {});
        diagnostics.scopedSessions = scopedSections.size;
      } catch (error) {
        // 注册失败也只是降级：**绝不让它冒泡**，否则 agent 创建失败。
        ctx.logger?.warn?.(
          `[dsh-agent-profiles] 本对话的段落注册失败，本次降级为全局注入：${error?.message ?? String(error)}`,
        );
      }
    });
  }

  // ── 技能目录（「配置也以技能的形式存在」）────────────────────
  //
  // 双通道：
  //   ① 系统提示词注入（上面那段）—— 保证人设**一定**生效，模型什么都不用做；
  //   ② 技能目录（这里）—— 同一份配置同时是可加载的技能，模型能按需 `skill` 取原文，
  //      技能列表里也能看到「这台机器上有哪些智能体」。
  //
  // 为什么用 `registerProvider` 而不是 `register`：
  //   `register({ content })` 的正文是**注册那一刻**的字符串快照 ——
  //   用户改完配置，技能里还是旧内容，只能靠盯着每次改动重新注册。
  //   而 provider 的 `get()` 是**真正被加载时**才调用，正文按当下配置现算，
  //   再配 `control.invalidate()` 让目录在配置变更后重算。
  //
  // ⚠ 两条硬约束（都写进测试了）：
  //   1. `list()` / `get()` **绝对不能抛错**。技能目录是会话系统提示词的一部分，
  //      它抛错会连累整个目录 —— 那是「一个插件弄坏所有会话」的量级。
  //      所以两个方法内部全部 try/catch，失败就退化成「没有这个技能」。
  //   2. `skills` 走 `ctx.get()` 软探测：缺这个服务只是没有技能通道，
  //      注入与界面照常。
  const skills = ctx.get?.("skills") ?? null;
  if (skills === null) {
    ctx.logger?.warn?.(
      "[dsh-agent-profiles] 未取到 skills 服务：配置不会出现在技能目录里（系统提示词注入照常）。",
    );
  } else {
    ctx.effect(() => {
      let invalidate = () => {};
      try {
        const disposeProvider = skills.registerProvider((control) => {
          invalidate = () => {
            try {
              control.invalidate();
            } catch {
              /* 失效通知失败无所谓，下次读取自然重算 */
            }
          };
          return {
            name: SKILL_PROVIDER_NAME,
            async list() {
              try {
                return { candidates: skillCandidates(store), complete: true };
              } catch {
                return { candidates: [], complete: true };
              }
            },
            async get(candidate) {
              try {
                const profile = store.profileById(candidate?.locator?.profileId);
                // 加载前配置被删了 ⇒ 当作没有这个技能（契约允许返回 undefined）。
                if (profile === undefined || hasContent(profile) !== true) return undefined;
                const content = renderProfile(profile, { maxChars: MAX_PROMPT_CHARS });
                if (content === "") return undefined;
                return {
                  name: candidate.name,
                  description: candidate.description,
                  whenToUse: candidate.whenToUse,
                  source: SKILL_SOURCE,
                  invocation: { modelInvocable: true, userInvocable: true },
                  provider: SKILL_PROVIDER_NAME,
                  content,
                };
              } catch {
                return undefined;
              }
            },
          };
        });
        // 配置一改就让目录失效，否则技能列表里还是旧名字 / 旧描述。
        const disposeWatch = store.onChange(() => invalidate());
        ctx.logger?.info?.(
          `[dsh-agent-profiles] 技能目录已挂上：provider=${SKILL_PROVIDER_NAME}`,
        );
        return () => {
          try {
            disposeWatch?.();
          } catch {
            /* 退订失败不影响卸载 */
          }
          try {
            disposeProvider?.();
          } catch {
            /* 同上 */
          }
        };
      } catch (error) {
        // 注册失败只降级：注入与界面照常，只是没有技能通道。
        ctx.logger?.warn?.(
          `[dsh-agent-profiles] 技能目录注册失败（注入照常）：${error?.message ?? String(error)}`,
        );
        return () => {};
      }
    });
  }

  // ── 长期记忆的自动化（工具 + 后台提炼 + 超限压缩）──────────
  //
  // 两条通道都要（用户明确选的）：
  //   ① 模型主动存：一个 `memory_save` 工具，零额外开销，但看模型自觉；
  //   ② 后台提炼：每 5 个回合读一次对话、调一次模型、把要点存进去，
  //      全自动，代价是每 5 回合一次额外模型调用。
  //
  // 详细设计与硬约束见 lib/memory.js 的文件头注释。
  ctx.effect(() => {
    const disposeTool = installMemoryTool(ctx, { store, logger: ctx.logger });
    const disposeAuto = installAutoMemory(ctx, {
      store,
      logger: ctx.logger,
      diagnostics,
    });
    return () => {
      try {
        disposeAuto?.();
      } catch {
        /* 卸载顺序出问题也不该阻断插件卸载 */
      }
      try {
        disposeTool?.();
      } catch {
        /* 同上 */
      }
    };
  });

  // ── 路由 + 脚本注入 ───────────────────────────────────────
  // 全部登记在一个 effect 里：插件卸载（或换层）时统一注销，
  // 不留半死的路由在 Web 服务上。
  ctx.effect(() => {
    const disposers = installRoutes(ctx, {
      store,
      here,
      prepare,
      renderPreview: prepare,
      diagnostics,
      exportEnvelope: () => exportEnvelope(store.snapshot()),
    });
    return () => {
      for (const dispose of disposers) {
        try {
          dispose?.();
        } catch {
          /* 单个注销失败不该阻断其余清理 */
        }
      }
      // ⚠ 挂在 **agent.ctx** 上的注册不会随插件卸载自动消失
      //   （官方 practices.md 明说：那个注册有两个属主，自己的 effect 里也要留一份注销器）。
      for (const dispose of scopedSections.values()) {
        try {
          dispose?.();
        } catch {
          /* 同上 */
        }
      }
      scopedSections.clear();
      diagnostics.scopedSessions = 0;
    };
  });

  ctx.logger?.info?.(
    `[dsh-agent-profiles] 就绪：${store.state.profiles.length} 套配置，当前「${store.activeProfile()?.name ?? "-"}」，` +
      `${Object.keys(store.state.sessions).length} 个对话有专属设定，数据 ${store.file}`,
  );
}

export { ProfileStore, renderProfile, renderActive, renderForSession, PROMPT_SECTION_NAME };
