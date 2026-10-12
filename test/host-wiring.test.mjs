/**
 * Host 接线自测：拿假的 ctx 把 lib/index.js 跑起来，检查它**到底注册了什么**。
 *
 * ## 为什么必须有这个文件
 * 0.2.0 出过一次严重事故：per-agent 段落用 `agentCtx.effect(() => section(...))`
 * 注册，清理函数同步返回 undefined；宿主在 agent 销毁时拿注销器的返回值
 * `.catch()`，于是抛
 *   TypeError: Cannot read properties of undefined (reading 'catch')
 * 记成「agent/disposed listener threw」，表现为**会话不可用、会话从左侧列表消失**。
 *
 * 这类 bug 有三个要命的特点：
 *   1. 只在**销毁**时炸，注册那一刻一切正常；
 *   2. 错误信息里没有一个字提到插件；
 *   3. store/prompt/routes 的单测全都覆盖不到它。
 * 所以必须专门测「注册出来的东西长什么样」——尤其是**清理函数的返回值**。
 *
 * 用法：node test/host-wiring.test.mjs
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let passed = 0;
const failures = [];
function check(name, condition, detail) {
  if (condition === true) {
    passed += 1;
    return;
  }
  failures.push(`${name}${detail === undefined ? "" : ` — ${detail}`}`);
}
function eq(name, actual, expected) {
  check(name, actual === expected, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

/** 每个用例一份隔离的数据目录，免得互相看到对方写的 profiles.json。 */
function tempDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-wiring-"));
  process.env.DSH_AGENT_PROFILES_DATA = dir;
  return dir;
}

/**
 * 造一个假 ctx 并 apply 一次插件。
 * 记录：注册的路由、tapIndex 变换、所有 effect、所有事件监听、所有 section。
 */
async function boot() {
  const sections = [];
  const listeners = new Map();
  const effects = [];
  const routes = [];
  const taps = [];
  const logs = [];

  /**
   * 假的 systemPrompt。
   *
   * ⚠ **必须模拟「同一层里同名段落会抛错」这条真实行为** ——
   *   否则「注册落错了作用域」这个 bug 在测试里永远显不出来。
   *   它就是这么漏过去的：每对话注入一直静默回落全局，
   *   宿主日志在喊 `already registered`，而测试全绿。
   */
  const makeSystemPrompt = (into, label) => ({
    label,
    section(section) {
      if (into.some((s) => s.name === section.name)) {
        throw new Error(
          `prompt section "${section.name}" is already registered ` +
            `(for a per-agent override, register through that agent's \`agent.ctx\` instead)`,
        );
      }
      into.push(section);
      // 真实实现返回 cordis 的 effect 注销器，同步调用返回 undefined。
      return () => undefined;
    },
  });

  const systemPrompt = makeSystemPrompt(sections, "plugin");

  /**
   * 假的 skills 服务：抓住 provider，并记录 `control.invalidate()` 被调了几次。
   */
  const providers = [];
  const invalidations = { count: 0 };
  const skillsService = {
    registerProvider(create) {
      const control = {
        signal: undefined,
        invalidate: () => {
          invalidations.count += 1;
        },
      };
      providers.push({ provider: create(control), control });
      return () => {};
    },
  };

  const ctx = {
    logger: {
      info: (m) => logs.push(["info", String(m)]),
      warn: (m) => logs.push(["warn", String(m)]),
      error: (m) => logs.push(["error", String(m)]),
    },
    get: (name) => {
      if (name === "systemPrompt") return systemPrompt;
      if (name === "skills") return skillsService;
      return undefined;
    },
    effect(fn) {
      // 记下「回调」和「回调产出的清理函数」两样：
      // 后者必须直接拿来用 —— 再调一次回调等于又注册一遍，
      // 真实宿主会以同名冲突拒绝（测试里也照此模拟）。
      const cleanup = fn();
      effects.push({ fn, cleanup });
      return typeof cleanup === "function" ? cleanup : () => {};
    },
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(listener);
      return () => {};
    },
    webServer: {
      register(route) {
        routes.push(route);
        return () => {};
      },
      tapIndex(transform) {
        taps.push(transform);
        return () => {};
      },
    },
  };

  // 用带 query 的 import 拿全新模块实例（模块级状态才不会串味）
  // ⚠ 用 import.meta.url 定位，不用 path.resolve("lib/index.js") —— 后者看的是
  //    **当前工作目录**，从别处跑（CI、任务调度器）就会解析到不存在的位置。
  const url = new URL("../lib/index.js", import.meta.url).href;
  const mod = await import(`${url}?case=${Math.random().toString(36).slice(2)}`);
  mod.apply(ctx);

  return { mod, ctx, systemPrompt, sections, listeners, effects, routes, taps, logs, providers, invalidations };
}

/**
 * 假的 agent ctx：effect 立即执行回调并交出清理函数，
 * 并且**带一个属于该作用域的 systemPrompt** ——
 * 模拟「cordis 的服务代理按取它的那个 ctx 绑定作用域」。
 */
function fakeAgentCtx() {
  const cleanups = [];
  const scopedSections = [];
  const systemPrompt = {
    section(section) {
      if (scopedSections.some((s) => s.name === section.name)) {
        throw new Error(`prompt section "${section.name}" is already registered (per-agent layer)`);
      }
      scopedSections.push(section);
      return () => undefined;
    },
  };
  return {
    cleanups,
    scopedSections,
    systemPrompt,
    get: (name) => (name === "systemPrompt" ? systemPrompt : undefined),
    effect(fn) {
      const cleanup = fn();
      cleanups.push(cleanup);
      // 真实 cordis 的注销器是幂等的；这里模拟成「调用后返回清理函数的返回值」。
      return () => (typeof cleanup === "function" ? cleanup() : undefined);
    },
  };
}

// ── ① apply 的基本接线 ──────────────────────────────────────
const dir = tempDataDir();
{
  const w = await boot();
  check("注册了全局段落", w.sections.length === 1, `实际 ${w.sections.length}`);
  eq("段落名唯一", w.sections[0].name, "agent-profiles:persona");
  check("order 是有限数", Number.isFinite(w.sections[0].order), String(w.sections[0].order));
  check("text 是函数（每次组装现算）", typeof w.sections[0].text === "function");
  check("监听了 agent/created", (w.listeners.get("agent/created") ?? []).length === 1);
  eq("注册了 6 条路由", w.routes.length, 6);
  eq("注入了 index tap", w.taps.length, 1);
  check("打了就绪日志", w.logs.some(([level, m]) => level === "info" && m.includes("就绪")), JSON.stringify(w.logs));
  eq("启动时没有会话设定", Object.keys(w.mod.ProfileStore ? {} : {}).length, 0);
}

// ── ② 注册出来的清理函数**必须返回 thenable**（0.2.0 事故点）──
{
  const w = await boot();
  const listener = w.listeners.get("agent/created")[0];
  const agentCtx = fakeAgentCtx();
  listener({ agent: { id: "session-wiring-1", ctx: agentCtx } });

  check("每个对话注册了一个作用域段落", agentCtx.scopedSections.length === 1, `实际 ${agentCtx.scopedSections.length}`);
  eq("作用域段落与全局段落**同名**（靠同名遮蔽）", agentCtx.scopedSections[0]?.name, "agent-profiles:persona");
  eq("在 agent.ctx 上注册了 1 个 effect", agentCtx.cleanups.length, 1);
  // ⚠ 关键断言：注册**不能**落回插件层。
  //   落回去就会同名冲突被宿主拒绝，而表现是「每对话设定静默失效」。
  eq("全局层只注册了全局那一段（没被顶替者污染）", w.sections.length, 1);
  check(
    "没有出现作用域注册失败的告警",
    w.logs.some(([level, m]) => level === "warn" && m.includes("注册失败")) === false,
    JSON.stringify(w.logs.filter(([l]) => l === "warn")),
  );

  const cleanup = agentCtx.cleanups[0];
  check("清理函数是函数", typeof cleanup === "function");
  const returned = cleanup();
  const isThenable = returned !== null && typeof returned === "object" && typeof returned.then === "function";
  check(
    "清理函数返回 thenable（否则宿主 .catch() 会炸）",
    isThenable,
    `实际返回 ${returned === undefined ? "undefined" : typeof returned}`,
  );

  // 注销器本身也要能再次调用而不抛错（宿主可能调两次）
  const dispose = agentCtx.effect === undefined ? null : null;
  void dispose;
  let threw = false;
  try {
    cleanup();
  } catch {
    threw = true;
  }
  eq("清理函数重复调用不抛错", threw, false);
}

// ── ③ 全局段的清理也必须返回 thenable ───────────────────────
{
  const w = await boot();
  eq("apply 期间建立了若干 effect", w.effects.length > 0, true);
  // 直接用回调已经产出的那个清理函数；不要再调一次回调（那等于重复注册，
  // 真实宿主会以同名冲突拒绝 —— 这条测试第一次写错就是这么炸的）。
  const { cleanup } = w.effects[0];
  check("全局段的清理函数是函数", typeof cleanup === "function");
  const returned = cleanup();
  const isThenable =
    returned !== null && typeof returned === "object" && typeof returned.then === "function";
  check("全局段的清理同样返回 thenable", isThenable, `实际 ${returned === undefined ? "undefined" : typeof returned}`);
}

// ── ④ 降级路径：拿不到 agent.ctx 时只警告、不抛错 ────────────
{
  const w = await boot();
  const listener = w.listeners.get("agent/created")[0];

  let threw = false;
  try {
    listener({ agent: { id: "s-no-ctx" } });
  } catch (error) {
    threw = true;
    check("不该抛错", false, String(error?.message));
  }
  eq("缺 agent.ctx 不抛错", threw, false);
  eq("也没有多注册段落", w.sections.length, 1);
  check(
    "打了降级警告",
    w.logs.some(([level, m]) => level === "warn" && m.includes("agent.ctx")),
    JSON.stringify(w.logs),
  );

  // 连 agent 本身都没有
  try {
    listener({});
  } catch (error) {
    check("空 payload 也不该抛错", false, String(error?.message));
  }
  passed += 1; // 走到这里说明没抛
}

// ── ⑤ effect 抛错时只降级，绝不让 agent 创建失败 ──────────────
{
  const w = await boot();
  const listener = w.listeners.get("agent/created")[0];
  // 作用域里有 systemPrompt（能走到注册那一步），但 effect 本身炸掉
  const evil = {
    get: (name) => (name === "systemPrompt" ? { section: () => () => {} } : undefined),
    effect() {
      throw new Error("effect 炸了");
    },
  };
  let threw = false;
  try {
    listener({ agent: { id: "s-evil", ctx: evil } });
  } catch (error) {
    threw = true;
  }
  eq("effect 抛错不会冒泡（否则 agent 创建会失败）", threw, false);
  check(
    "并且说明了降级",
    w.logs.some(([level, m]) => level === "warn" && m.includes("降级")),
    JSON.stringify(w.logs),
  );
}

// ── ⑤b agent 作用域里取不到 systemPrompt 也只降级 ─────────────
{
  const w = await boot();
  const listener = w.listeners.get("agent/created")[0];
  let threw = false;
  try {
    listener({ agent: { id: "s-no-sp", ctx: { effect: (fn) => fn() } } });
  } catch {
    threw = true;
  }
  eq("取不到作用域 systemPrompt 不抛错", threw, false);
  eq("也没有往全局层乱注册", w.sections.length, 1);
  check(
    "说明了本次只有全局注入",
    w.logs.some(([level, m]) => level === "warn" && m.includes("只有全局注入")),
    JSON.stringify(w.logs),
  );
}

// ── ⑥ section() 本身抛错也只降级 ────────────────────────────
{
  const w = await boot();
  const listener = w.listeners.get("agent/created")[0];
  // 让 systemPrompt.section 在这次调用里抛错
  w.systemPrompt.section = () => {
    throw new Error("section 炸了");
  };
  let threw = false;
  try {
    listener({ agent: { id: "s-evil2", ctx: fakeAgentCtx() } });
  } catch (error) {
    threw = true;
  }
  eq("section 抛错同样不冒泡", threw, false);
}

// ── ⑦ 同一个会话再次创建（resume）要先注销旧的 ──────────────
{
  const w = await boot();
  const listener = w.listeners.get("agent/created")[0];
  const first = fakeAgentCtx();
  const second = fakeAgentCtx();
  listener({ agent: { id: "s-repeat", ctx: first } });
  listener({ agent: { id: "s-repeat", ctx: second } });
  eq("第二次注册到新 ctx", second.cleanups.length, 1);

  // 旧的那份应当已被注销：再调一次它的清理也不该炸
  let threw = false;
  try {
    first.cleanups[0]();
  } catch {
    threw = true;
  }
  eq("旧段落被注销且可重复调用", threw, false);
}

// ── ⑧ 逃生开关 ──────────────────────────────────────────────
{
  process.env.DSH_AGENT_PROFILES_NO_SESSION_SCOPE = "1";
  const w = await boot();
  const listener = w.listeners.get("agent/created")[0];
  listener({ agent: { id: "s-escape", ctx: fakeAgentCtx() } });
  eq("逃生开关打开时不注册作用域段落", w.sections.length, 1);
  delete process.env.DSH_AGENT_PROFILES_NO_SESSION_SCOPE;
}

// ── ⑨ 段落文本真的按会话取内容 ──────────────────────────────
{
  const w = await boot();
  const listener = w.listeners.get("agent/created")[0];
  // 作用域段落现在注册在 **agent 自己的** systemPrompt 上，所以要从那个假对象里读。
  const agentCtx = fakeAgentCtx();
  listener({ agent: { id: "s-text", ctx: agentCtx } });

  // 给这个会话写一条专属设定（走真实 store）
  const command = w.routes.find((r) => r.path === "/__ap/command");
  const respond = () => {
    const res = {
      statusCode: 0,
      body: "",
      writeHead(code) {
        this.statusCode = code;
        return this;
      },
      end(chunk) {
        if (chunk !== undefined) this.body = String(chunk);
        return this;
      },
    };
    return res;
  };
  const req = (body) => ({
    method: "POST",
    url: "/__ap/command",
    headers: { host: "127.0.0.1:43120" },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify(body), "utf8");
    },
  });

  const res = respond();
  await command.handler(
    req({ op: "session.set", sessionId: "s-text", patch: { note: "本次对话只看方案" } }),
    res,
  );
  eq("写入本对话设定成功", res.statusCode, 200);

  const scopedText = agentCtx.scopedSections[0].text();
  check("本对话段落渲染出专属设定", scopedText.includes("本次对话只看方案"), scopedText.slice(0, 200));

  // 另一个没有设定的会话：回落全局配置，不含别人的专属内容
  const w2 = await boot();
  const otherCtx = fakeAgentCtx();
  w2.listeners.get("agent/created")[0]({ agent: { id: "s-other", ctx: otherCtx } });
  const otherText = otherCtx.scopedSections[0].text();
  check("未设定的对话不含别人的专属设定", !otherText.includes("本次对话只看方案"), otherText.slice(0, 200));
}

// ── ⑩ 技能目录：配置以技能形式存在（双通道的另一半）──────────
{
  const w = await boot();
  eq("注册了 1 个技能 provider", w.providers.length, 1);
  eq("provider 名字固定", w.providers[0]?.provider?.name, "agent-profiles");
  const provider = w.providers[0].provider;

  const listed = await provider.list({});
  const candidates = Array.isArray(listed) ? listed : listed.candidates;
  eq(
    "有内容的配置都进目录（出厂 3 套都有内容）",
    candidates.length,
    3,
    JSON.stringify(candidates.map((c) => c.name)),
  );
  check("技能名是 kebab-case", candidates.every((c) => /^[a-z0-9-]+$/.test(c.name)), JSON.stringify(candidates.map((c) => c.name)));
  check("技能名带 agent-profile- 前缀", candidates.every((c) => c.name.startsWith("agent-profile-")));
  check("名字互不重复", new Set(candidates.map((c) => c.name)).size === candidates.length);
  check(
    "描述是一行且够短（目录会进系统提示词）",
    candidates.every((c) => c.description.length <= 90 && !c.description.includes("\n")),
    JSON.stringify(candidates.map((c) => c.description)),
  );
  check("候选带 locator（加载时回查配置用）", candidates.every((c) => typeof c.locator?.profileId === "string"));
  check("候选声明模型可调用", candidates.every((c) => c.invocation?.modelInvocable === true));

  const loaded = await provider.get(candidates[0], {});
  check("加载出全文", typeof loaded?.content === "string" && loaded.content.length > 0);
  check(
    "全文就是该配置的完整人设（与注入同一份渲染）",
    // 三套出厂配置各有一句标志性的角色设定，命中任意一句即可
    ["通用型助手", "资深软件工程师", "中文写作教练"].some((needle) => loaded.content.includes(needle)),
    loaded.content?.slice(0, 120),
  );
  check("全文带标题", loaded.content.includes("# 智能体配置"));
  eq("加载结果沿用候选名", loaded.name, candidates[0].name);

  // ⚠ 技能目录是系统提示词的一部分：这里**任何输入都不能抛错**
  eq("配置不存在 → undefined", await provider.get({ name: "x", locator: { profileId: "p-没有" } }, {}), undefined);
  eq("没有 locator → undefined", await provider.get({ name: "x" }, {}), undefined);
  eq("候选是 null → undefined", await provider.get(null, {}), undefined);
  const hostile = {
    name: "x",
    get locator() {
      throw new Error("候选对象自己炸了");
    },
  };
  eq("候选对象取值就抛错 → 仍然返回 undefined", await provider.get(hostile, {}), undefined);
  const listShape = await provider.list({});
  check("list() 返回 {candidates, complete} 形状", Array.isArray(listShape.candidates) && listShape.complete === true);
}

// ── ⑪ 配置变更要让技能目录失效重算 ───────────────────────────
{
  const w = await boot();
  const before = w.invalidations.count;
  const command = w.routes.find((r) => r.path === "/__ap/command");
  const res = {
    statusCode: 0,
    body: "",
    writeHead(code) {
      this.statusCode = code;
      return this;
    },
    end(chunk) {
      if (chunk !== undefined) this.body = String(chunk);
      return this;
    },
  };
  await command.handler(
    {
      method: "POST",
      url: "/__ap/command",
      headers: { host: "127.0.0.1:43120" },
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(
          JSON.stringify({ op: "profile.create", profile: { name: "临时", role: "角色" } }),
          "utf8",
        );
      },
    },
    res,
  );
  eq("写入成功", res.statusCode, 200);
  check("成功的写入让技能目录失效重算", w.invalidations.count > before, `${before} → ${w.invalidations.count}`);
}

fs.rmSync(dir, { recursive: true, force: true });

if (failures.length === 0) {
  console.log(`OK — ${passed} 项断言全部通过`);
  process.exit(0);
}
console.log(`FAIL — ${passed} 项通过，${failures.length} 项失败：`);
for (const line of failures) console.log(`  ✗ ${line}`);
process.exit(1);
