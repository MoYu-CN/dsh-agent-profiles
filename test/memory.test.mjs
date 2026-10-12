/**
 * 长期记忆自动化的测试。
 *
 * 这里验的是本插件**风险最高**的一段：后台自己调模型、自己往用户的配置里写数据。
 * 所以覆盖的重点不是「正常路径能跑」，而是每一条「出事了会怎样」：
 *
 *   - 模型调用失败 / 超时 → 会不会影响对话、会不会写脏数据
 *   - 拿不到服务（llm / sessionQuery / tools）→ 会不会抛
 *   - 同一会话并发触发 → 会不会重复写
 *   - 送进模型的对话摘录 → 有没有长度上限（那是用户的钱）
 *   - 压缩结果为空 → 会不会把记忆覆盖成空的
 *   - 写入目标 → 是不是**本对话生效的那套配置**（切了配置不能写错地方）
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProfileStore, LIMITS, memoryChars } from "../lib/store.js";
import {
  EXTRACT_EVERY_TURNS,
  EXTRACT_MAX_CHARS,
  EXTRACT_MAX_NEW,
  MEMORY_TOOL_NAME,
  effectiveProfileFor,
  installAutoMemory,
  installMemoryTool,
  parseCompactResult,
  parseMemoryLines,
} from "../lib/memory.js";

let passed = 0;
const failures = [];
function eq(label, actual, expected, extra = "") {
  if (actual === expected) {
    passed += 1;
    return;
  }
  failures.push(`${label} — 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}${extra === "" ? "" : ` (${extra})`}`);
}
function check(label, ok, detail = "") {
  if (ok === true) {
    passed += 1;
    return;
  }
  failures.push(`${label}${detail === "" ? "" : ` — ${detail}`}`);
}
const dirs = [];
function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-mem-"));
  dirs.push(dir);
  const store = new ProfileStore(dir);
  store.load();
  return store;
}

/** 等一个条件成立（异步链是 fire-and-forget，不能只 sleep 一个固定时长）。 */
async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate() === true) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

/**
 * 造一个假的宿主上下文。
 *
 * `llmReplies` 是脚本化的模型回复队列，每次 stream 取一条；
 * `llmBehavior` 可以设成 "throw" 来模拟调用失败。
 */
function makeCtx(options = {}) {
  const logs = [];
  const listeners = new Map();
  const tools = [];
  const llmCalls = [];
  const replies = [...(options.llmReplies ?? [])];
  const messages = options.messages ?? [];
  const ctx = {
    logger: {
      info: (m) => logs.push(["info", String(m)]),
      warn: (m) => logs.push(["warn", String(m)]),
      error: (m) => logs.push(["error", String(m)]),
    },
    effect(fn) {
      const cleanup = fn();
      return typeof cleanup === "function" ? cleanup : () => {};
    },
    on(event, listener) {
      listeners.set(event, listener);
      return () => listeners.delete(event);
    },
    get(name) {
      if (name === "tools" && options.withTools !== false) {
        return {
          register(definition) {
            tools.push(definition);
            return () => {};
          },
        };
      }
      if (name === "sessionQuery" && options.withQuery !== false) {
        return {
          filterEvents: async () => messages,
        };
      }
      if (name === "llm" && options.withLlm !== false) {
        return {
          stream(call) {
            llmCalls.push(call);
            if (options.llmBehavior === "throw") throw new Error("模拟的模型调用失败");
            const reply = replies.length > 0 ? replies.shift() : "";
            return (async function* generate() {
              if (options.llmBehavior === "error-chunk") {
                yield { type: "finish", reason: { kind: "error", failure: { message: "模拟的流内错误" } } };
                return;
              }
              yield { type: "text-delta", text: reply };
              yield { type: "finish", reason: { kind: "stop" } };
            })();
          },
        };
      }
      if (name === "agentDefaultModel") {
        return { currentSelection: () => ({ provider: "deepseek", model: "deepseek-chat" }) };
      }
      return undefined;
    },
  };
  return { ctx, logs, listeners, tools, llmCalls };
}

// ── ① 记忆行解析 ─────────────────────────────────────────────
{
  eq("空输入 → 无", parseMemoryLines("").length, 0);
  eq("「无」被识别为空", parseMemoryLines("无").length, 0);
  eq("「没有。」被识别为空", parseMemoryLines("没有。").length, 0);
  const lines = parseMemoryLines("1. 用户喜欢简洁的回答\n- 用户在做插件开发\n* 用户要求实事求是\n• 用户要求实事求是\n\n3) 用户在 Windows 上开发");
  eq("剥掉编号与项目符号", lines.length, 4, JSON.stringify(lines));
  eq("首条内容干净", lines[0], "用户喜欢简洁的回答");
  eq("重复项被去掉", lines.filter((l) => l === "用户要求实事求是").length, 1);
  eq("「摘要：」行不进条目", parseMemoryLines("摘要：这是一段摘要").length, 0);
  const long = parseMemoryLines("啊".repeat(LIMITS.memoryText + 50));
  eq("超长条目被截到上限", long[0].length, LIMITS.memoryText);
}

// ── ② 压缩结果解析 ───────────────────────────────────────────
{
  const parsed = parseCompactResult("摘要：用户是插件作者，偏好简洁直白的回答。\n用户在 Windows 上开发\n1. 用户要求实事求是");
  check("摘要被取出", parsed.summary.includes("插件作者"), parsed.summary);
  eq("条目被取出并剥掉编号", parsed.texts.join("|"), "用户在 Windows 上开发|用户要求实事求是");
  const empty = parseCompactResult("");
  eq("空输入 → 空摘要", empty.summary, "");
  eq("空输入 → 空条目", empty.texts.length, 0);
  const huge = parseCompactResult(`摘要：${"字".repeat(LIMITS.memorySummary + 100)}`);
  eq("超长摘要被截断到上限", huge.summary.length, LIMITS.memorySummary);
}

// ── ③ 生效配置解析（写对地方的前提）──────────────────────────
{
  const state = {
    activeId: "p-a",
    profiles: [{ id: "p-a", name: "A" }, { id: "p-b", name: "B" }],
    sessions: { "s-bound": { profileId: "p-b" } },
  };
  eq("没绑定 → 全局当前", effectiveProfileFor({ state }, "s-other").id, "p-a");
  eq("绑定了 → 用绑定的", effectiveProfileFor({ state }, "s-bound").id, "p-b");
  eq("state 为空 → null", effectiveProfileFor({ state: null }, "s"), null);
  eq("store 抛错 → null（不冒泡）", effectiveProfileFor({ get state() { throw new Error("boom"); } }, "s"), null);
}

// ── ④ 记忆工具：注册 + 执行 ──────────────────────────────────
{
  const store = makeStore();
  const { ctx, tools } = makeCtx();
  installMemoryTool(ctx, { store, logger: ctx.logger });
  eq("注册了 1 个工具", tools.length, 1);
  const def = tools[0];
  eq("工具名固定", def.name, MEMORY_TOOL_NAME);
  check("描述里说清了「长期」与「不要存什么」", def.description.includes("长期") && def.description.includes("不要存"), def.description);
  eq("参数要求 content", def.parameters.required.join(","), "content");
  check("有输出定义（render）", typeof def.output?.render === "function");
  check("不是并发安全的（要按顺序写同一个文件）", def.isConcurrencySafe?.() === false);

  // 全局当前配置
  const active = store.activeProfile();
  const okResult = await def.execute({ content: "用户偏好简洁直白的回答" }, { agent: { id: "s-1" } });
  eq("执行成功", okResult.ok, true);
  eq("写进了全局当前配置", store.profileById(active.id).memories.length, 1);
  eq("返回条数", okResult.count, 1);
  check("渲染出中文提示", def.output.render({}, okResult)[0].text.includes("已记住"), def.output.render({}, okResult)[0].text);

  // 本对话绑定了另一套 → 必须写进那一套
  const other = store.state.profiles[1];
  await store.command({ op: "session.set", sessionId: "s-bound", patch: { profileId: other.id } });
  const bound = await def.execute({ content: "这条属于绑定配置" }, { agent: { id: "s-bound" } });
  eq("绑定对话执行成功", bound.ok, true);
  eq("写进了本对话绑定的那套（不是全局当前）", store.profileById(other.id).memories.length, 1, JSON.stringify(store.profileById(other.id).memories));
  eq("全局当前那套没被写", store.profileById(active.id).memories.length, 1);

  // 坏输入
  eq("空内容被拒", (await def.execute({ content: "   " }, { agent: { id: "s-1" } })).ok, false);
  eq("没有 content 被拒", (await def.execute({}, { agent: { id: "s-1" } })).ok, false);
  const noAgent = await def.execute({ content: "没有 agent 上下文" }, {});
  eq("没有 agent 时回落到全局当前配置", noAgent.ok, true);
  check("失败时的渲染文字可读", tools[0].output.render({}, { ok: false, error: "内容为空。" })[0].text.includes("内容为空"), "");

  // 重复内容不重复存（注意：前面的用例往这套配置里写过别的，所以比的是**增量**）
  const beforeDedupe = store.profileById(active.id).memories.length;
  await def.execute({ content: "用户偏好简洁直白的回答" }, { agent: { id: "s-1" } });
  eq("重复内容不再存第二条", store.profileById(active.id).memories.length, beforeDedupe);
}

// ── ⑤ 没有 tools 服务时：只降级，不抛错 ──────────────────────
{
  const store = makeStore();
  const { ctx, logs } = makeCtx({ withTools: false });
  let threw = null;
  try {
    installMemoryTool(ctx, { store, logger: ctx.logger });
  } catch (error) {
    threw = error;
  }
  eq("缺 tools 时不抛错", threw, null);
  check("留下了可查的告警", logs.some(([level, m]) => level === "warn" && m.includes("tools")), JSON.stringify(logs));
}

// ── ⑥ 后台提炼：第 5 个回合才跑，输入有上限 ──────────────────
{
  const store = makeStore();
  const longText = "这是一段很长的对话内容。".repeat(400); // 远超上限
  const messages = [
    { type: "user/message", text: "第一句" },
    { type: "assistant/message", text: longText },
  ];
  const { ctx, listeners, llmCalls } = makeCtx({
    llmReplies: ["用户偏好简洁直白的回答\n用户在 Windows 上开发插件"],
    messages,
  });
  const diagnostics = {};
  const dispose = installAutoMemory(ctx, { store, logger: ctx.logger, diagnostics });
  const fire = listeners.get("agent/status");
  check("监听的是 agent/status", typeof fire === "function");

  const active = store.activeProfile();
  for (let i = 0; i < EXTRACT_EVERY_TURNS - 1; i += 1) fire({ agent: { id: "s-1" }, status: "idle" });
  eq("不到第 5 回合不调用模型", llmCalls.length, 0);
  fire({ agent: { id: "s-1" }, status: "running" });
  eq("running 不触发（回合才开始）", llmCalls.length, 0);

  fire({ agent: { id: "s-1" }, status: "idle" });
  // ⚠ 等**诊断**而不是等记忆条数：记忆是在 command 里先写进去的，
  //   诊断在同一段异步链的稍后一步 —— 等错了就会得到「假失败」。
  const grew = await waitFor(() => diagnostics.memory?.extracts === 1);
  check("第 5 回合触发了提炼并写入 2 条", grew, JSON.stringify(store.profileById(active.id).memories));
  eq("调用了一次模型", llmCalls.length, 1);
  eq("用的是默认模型", `${llmCalls[0].provider}/${llmCalls[0].model}`, "deepseek/deepseek-chat");
  check("带上了系统提示词", typeof llmCalls[0].system === "string" && llmCalls[0].system.includes("长期记忆"));
  check("输出有 token 上限", typeof llmCalls[0].maxTokens === "number" && llmCalls[0].maxTokens > 0);
  check("传了取消信号（卡住的调用能中止）", llmCalls[0].signal !== undefined);
  const sent = llmCalls[0].messages[0].content[0].text;
  check(
    `送进模型的对话被截断到 ${EXTRACT_MAX_CHARS} 字以内（这是用户的钱）`,
    sent.length <= EXTRACT_MAX_CHARS,
    `实际 ${sent.length}`,
  );
  check("摘录带角色标注", sent.includes("用户：") || sent.includes("助手："), sent.slice(0, 80));
  check("写了可查的诊断", diagnostics.memory?.extracts === 1, JSON.stringify(diagnostics.memory));
  dispose();
}

// ── ⑦ 后台提炼：一次最多存几条 ───────────────────────────────
{
  const store = makeStore();
  const many = Array.from({ length: 12 }, (_, i) => `第 ${i + 1} 条记忆`).join("\n");
  const { ctx, listeners } = makeCtx({
    llmReplies: [many],
    messages: [{ type: "user/message", text: "一些对话" }],
  });
  installAutoMemory(ctx, { store, logger: ctx.logger });
  const fire = listeners.get("agent/status");
  const active = store.activeProfile();
  for (let i = 0; i < EXTRACT_EVERY_TURNS; i += 1) fire({ agent: { id: "s-1" }, status: "idle" });
  await waitFor(() => store.profileById(active.id).memories.length > 0);
  eq(`一次最多新增 ${EXTRACT_MAX_NEW} 条（多了就是搬运不是提炼）`, store.profileById(active.id).memories.length, EXTRACT_MAX_NEW);
}

// ── ⑧ 模型调用失败：不影响对话、不写脏数据 ───────────────────
{
  const store = makeStore();
  const { ctx, listeners, logs, llmCalls } = makeCtx({
    llmBehavior: "throw",
    messages: [{ type: "user/message", text: "一些对话" }],
  });
  installAutoMemory(ctx, { store, logger: ctx.logger });
  const fire = listeners.get("agent/status");
  const active = store.activeProfile();
  let threw = null;
  try {
    for (let i = 0; i < EXTRACT_EVERY_TURNS; i += 1) fire({ agent: { id: "s-1" }, status: "idle" });
  } catch (error) {
    threw = error;
  }
  eq("模型调用抛错不会冒泡到事件回调（否则会影响会话）", threw, null);
  // ⚠ 等**模型被调用**而不是等日志：日志是调用之后才写的，
  //   等日志等于赌「写日志」和「轮询」的先后 —— 赢了是运气，输了是假失败。
  const called = await waitFor(() => llmCalls.length > 0);
  const warned = await waitFor(() => logs.some(([level, m]) => level === "warn" && m.includes("后台模型调用失败")));
  check("失败前确实调用了模型（证明走到了这一步）", called, `llmCalls=${llmCalls.length}`);
  eq("失败时没有写入任何记忆", store.profileById(active.id).memories.length, 0);
  check("模型失败留下了可查的告警", warned, JSON.stringify(logs));
}

// ── ⑨ 模型明确报错（流内 error）：不写脏数据 ─────────────────
{
  const store = makeStore();
  const { ctx, listeners } = makeCtx({
    llmBehavior: "error-chunk",
    messages: [{ type: "user/message", text: "一些对话" }],
  });
  installAutoMemory(ctx, { store, logger: ctx.logger });
  const fire = listeners.get("agent/status");
  const active = store.activeProfile();
  for (let i = 0; i < EXTRACT_EVERY_TURNS; i += 1) fire({ agent: { id: "s-1" }, status: "idle" });
  await new Promise((resolve) => setTimeout(resolve, 60));
  eq("流内报错时没有写入", store.profileById(active.id).memories.length, 0);
}

// ── ⑩ 超限压缩：合并成摘要 + 精简条目 ────────────────────────
{
  const store = makeStore();
  const active = store.activeProfile();
  // 灌到超预算
  const chunk = "用户在某次对话里提到过一个细节。".repeat(6); // 约 100 字
  for (let i = 0; i < 60; i += 1) {
    await store.command({ op: "memory.autoAdd", profileId: active.id, texts: [`第 ${i + 1} 条：${chunk}`] });
  }
  const before = memoryChars(store.profileById(active.id));
  check(`压缩前确实超预算（${before} > ${LIMITS.memoryTotal}）`, before > LIMITS.memoryTotal, `实际 ${before}`);

  const { ctx, listeners, llmCalls } = makeCtx({
    // 没有可读对话（messages 为空）→ 只会走压缩分支
    messages: [],
    llmReplies: ["摘要：用户是一位插件作者，偏好简洁直白的回答。\n用户偏好简洁直白的回答\n用户在 Windows 上开发"],
  });
  installAutoMemory(ctx, { store, logger: ctx.logger });
  const fire = listeners.get("agent/status");
  for (let i = 0; i < EXTRACT_EVERY_TURNS; i += 1) fire({ agent: { id: "s-1" }, status: "idle" });

  const shrunk = await waitFor(() => memoryChars(store.profileById(active.id)) <= LIMITS.memoryTotal);
  const after = store.profileById(active.id);
  check("压缩后回到预算内", shrunk, `压缩后 ${memoryChars(after)}`);
  check("写了摘要", after.memorySummary.includes("插件作者"), after.memorySummary);
  eq("条目被精简成 2 条", after.memories.length, 2, JSON.stringify(after.memories.map((m) => m.text)));
  check("确实调用了模型", llmCalls.length >= 1);
  check("压缩提示词要求「不要编造」", String(llmCalls[0].system).includes("不要编造"), "");
}

// ── ⑪ 压缩结果为空：绝不覆盖（宁可不压缩）────────────────────
{
  const store = makeStore();
  const active = store.activeProfile();
  const chunk = "用户在某次对话里提到过一个细节。".repeat(6);
  for (let i = 0; i < 60; i += 1) {
    await store.command({ op: "memory.autoAdd", profileId: active.id, texts: [`第 ${i + 1} 条：${chunk}`] });
  }
  const before = memoryChars(store.profileById(active.id));
  const { ctx, listeners, logs } = makeCtx({ messages: [], llmReplies: ["   "] });
  installAutoMemory(ctx, { store, logger: ctx.logger });
  const fire = listeners.get("agent/status");
  for (let i = 0; i < EXTRACT_EVERY_TURNS; i += 1) fire({ agent: { id: "s-1" }, status: "idle" });
  await new Promise((resolve) => setTimeout(resolve, 60));
  eq("空结果时记忆原样保留", memoryChars(store.profileById(active.id)), before);
  check("留了告警说明没有覆盖", logs.some(([level, m]) => level === "warn" && m.includes("压缩结果为空")), JSON.stringify(logs));
}

// ── ⑫ 缺服务：只降级，不抛错，而且**装载时就说清楚** ─────────
{
  // ⑫a：没有 sessionQuery（读不到对话）→ 装载时就报警告，且不抛错
  const store = makeStore();
  const { ctx, listeners, logs } = makeCtx({ withQuery: false });
  installAutoMemory(ctx, { store, logger: ctx.logger });
  const fire = listeners.get("agent/status");
  let threw = null;
  try {
    for (let i = 0; i < EXTRACT_EVERY_TURNS; i += 1) fire({ agent: { id: "s-1" }, status: "idle" });
  } catch (error) {
    threw = error;
  }
  eq("缺 sessionQuery 时不抛错", threw, null);
  check(
    "装载时就报告了缺 sessionQuery（可查）",
    logs.some(([level, m]) => level === "warn" && m.includes("sessionQuery")),
    JSON.stringify(logs),
  );

  // ⑫b：有对话可读但没有 llm（提炼要调模型时才发现）→ 也要有可查的告警
  const store2 = makeStore();
  const second = makeCtx({
    withLlm: false,
    messages: [{ type: "user/message", text: "一些对话" }],
  });
  installAutoMemory(second.ctx, { store: store2, logger: second.ctx.logger });
  const fire2 = second.listeners.get("agent/status");
  let threw2 = null;
  try {
    for (let i = 0; i < EXTRACT_EVERY_TURNS; i += 1) fire2({ agent: { id: "s-1" }, status: "idle" });
  } catch (error) {
    threw2 = error;
  }
  eq("缺 llm 时不抛错", threw2, null);
  const warnedLlm = await waitFor(() =>
    second.logs.some(([level, m]) => level === "warn" && m.includes("llm")),
  );
  check("报告了缺 llm（可查）", warnedLlm, JSON.stringify(second.logs));
  eq("缺 llm 时没有写入记忆", store2.activeProfile().memories.length, 0);
}

// ── ⑬ 同一会话并发触发：不重复写 ─────────────────────────────
{
  const store = makeStore();
  const { ctx, listeners, llmCalls } = makeCtx({
    llmReplies: ["一条记忆", "一条记忆", "一条记忆", "一条记忆"],
    messages: [{ type: "user/message", text: "一些对话" }],
  });
  installAutoMemory(ctx, { store, logger: ctx.logger });
  const fire = listeners.get("agent/status");
  const active = store.activeProfile();
  // 第 5 和第 10 回合连着触发，第二次触发时第一次可能还没跑完
  for (let i = 0; i < EXTRACT_EVERY_TURNS * 2; i += 1) fire({ agent: { id: "s-1" }, status: "idle" });
  await waitFor(() => store.profileById(active.id).memories.length > 0);
  await new Promise((resolve) => setTimeout(resolve, 80));
  eq("同一会话不会因为并发而重复存同一条", store.profileById(active.id).memories.length, 1, JSON.stringify(store.profileById(active.id).memories));
  check("最多调了 2 次（两个触发点各一次）", llmCalls.length <= 2, `实际 ${llmCalls.length}`);
}

for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });

if (failures.length === 0) {
  console.log(`OK — ${passed} 项断言全部通过`);
  process.exit(0);
}
console.log(`FAIL — ${passed} 项通过，${failures.length} 项失败：`);
for (const line of failures) console.log(`  ✗ ${line}`);
process.exit(1);
