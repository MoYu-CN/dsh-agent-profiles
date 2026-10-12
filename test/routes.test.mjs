/**
 * dsh-agent-profiles —— Host API 自测（routes.js 的真实处理器）。
 *
 * ## 为什么不用 curl 打真实端口
 * 桌面端的 Web 服务在**路由之前**就做了对端准入：连 `/` 和不存在的路径
 * 都返回 403，未获准入的进程根本进不到插件路由。所以「用 curl 验一下」
 * 在这台机器上得到的永远是 403，那个 403 和插件代码无关。
 *
 * ## 这个文件验的是什么
 * 直接构造 mock `ctx.webServer` 与 mock `req`/`res`，调用**真实的处理器**。
 * 覆盖：状态读取、变更分发、非法输入、体积上限、方法限制、
 * 同源守卫的四种分支、预览、导出、客户端脚本投递、index 注入的幂等。
 *
 * 用法：node test/routes.test.mjs
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ProfileStore, exportEnvelope } from "../lib/store.js";
import { renderProfile } from "../lib/prompt.js";
import { installRoutes, CLIENT_SCRIPT_PATH } from "../lib/routes.js";

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

// ── mock 基础设施 ───────────────────────────────────────────
/** Node 的 IncomingMessage 是异步可迭代的，这里的 mock 必须也是。 */
function makeReq(options = {}) {
  const body = options.body;
  return {
    method: options.method ?? "GET",
    url: options.url ?? "/",
    headers: options.headers ?? {},
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(body, "utf8");
    },
  };
}
function makeRes() {
  return {
    statusCode: 0,
    headers: null,
    body: "",
    writeHead(code, headers) {
      this.statusCode = code;
      if (headers !== undefined) this.headers = headers;
      return this;
    },
    end(chunk) {
      if (chunk !== undefined) this.body += String(chunk);
      return this;
    },
    json() {
      try {
        return JSON.parse(this.body);
      } catch {
        return null;
      }
    },
  };
}

// ── 装配 ────────────────────────────────────────────────────
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-routes-"));
const store = new ProfileStore(dataDir);
store.load();

const routes = new Map();
const taps = [];
const diagnostics = { renders: 0, emptyRenders: 0, lastRenderAt: null, lastChars: 0 };
const mockCtx = {
  webServer: {
    register(route) {
      routes.set(`${route.kind} ${route.path}`, route);
      return () => routes.delete(`${route.kind} ${route.path}`);
    },
    tapIndex(transform) {
      taps.push(transform);
      return () => taps.splice(taps.indexOf(transform), 1);
    },
  },
};

const disposers = installRoutes(mockCtx, {
  store,
  // ⚠ 用 import.meta.url 定位，不用 path.resolve("lib") —— 后者看的是**当前工作
  //    目录**，从别处跑（CI、任务调度器）就会指向不存在的位置。
  here: fileURLToPath(new URL("../lib", import.meta.url)),
  prepare: (profile) => renderProfile(profile, { maxChars: 8000 }),
  renderPreview: (profile) => renderProfile(profile, { maxChars: 8000 }),
  diagnostics,
  exportEnvelope: () => exportEnvelope(store.snapshot()),
});

const SAME = { host: "127.0.0.1:43120" };
async function call(method, url, options = {}) {
  const key = `${options.kind ?? "exact"} ${url}`;
  const route = routes.get(key);
  if (route === undefined) throw new Error(`没有注册路由 ${key}`);
  const res = makeRes();
  await route.handler(
    makeReq({ method, url, headers: options.headers ?? SAME, body: options.body }),
    res,
  );
  return res;
}

// ── ① 路由与 index 注入都装上了 ──────────────────────────────
eq("注册了 6 条路由", routes.size, 6);
check("诊断路由存在（客户端把关键节点报给宿主日志）", routes.has("exact /__ap/diag"));
check("客户端脚本路由存在", routes.has(`exact ${CLIENT_SCRIPT_PATH}`));
check("注入了 1 个 index tap", taps.length === 1);

// ── ② 读状态 ────────────────────────────────────────────────
{
  const res = await call("GET", "/__ap/state");
  eq("state 200", res.statusCode, 200);
  const body = res.json();
  eq("state.ok", body.ok, true);
  eq("出厂 3 套配置", body.state.profiles.length, 3);
  eq("activeId 存在", typeof body.state.activeId, "string");
  eq("meta.dataDir 是我给的目录", body.meta.dataDir, dataDir);
  check("meta.file 指向 profiles.json", String(body.meta.file).endsWith("profiles.json"));
  eq("meta.profileCount", body.meta.profileCount, 3);
  eq("meta.memoryCount", body.meta.memoryCount, 0);
  check(
    "promptChars 反映默认配置的实际注入字数（默认助手不再是空的）",
    body.meta.promptChars > 0,
    `实际 ${body.meta.promptChars}`,
  );
  eq("禁缓存", res.headers["cache-control"], "no-store");
  eq("方法限制：POST state 返 405", (await call("POST", "/__ap/state", { body: "{}" })).statusCode, 405);
}

// ── ③ 变更分发 ──────────────────────────────────────────────
let createdId = "";
{
  const res = await call("POST", "/__ap/command", {
    body: JSON.stringify({ op: "profile.create", profile: { name: "接口测试", role: "你是测试员" } }),
  });
  eq("create 200", res.statusCode, 200);
  const body = res.json();
  eq("create.ok", body.ok, true);
  eq("create 后共 4 套", body.state.profiles.length, 4);
  eq("create 自动成为当前", body.state.activeId, body.state.activeId);
  check("有提示文案", typeof body.notice === "string" && body.notice.length > 0);
  createdId = body.state.activeId;
  eq("promptChars 反映了新配置", body.meta.promptChars > 0, true);

  // 落盘：重新打开一个 store 必须读得到
  const reopened = new ProfileStore(dataDir);
  eq("确实落盘了", reopened.load(), true);
  eq("落盘内容一致", reopened.state.profiles.length, 4);
  eq("落盘当前配置一致", reopened.state.activeId, createdId);
}

{
  const res = await call("POST", "/__ap/command", {
    body: JSON.stringify({ op: "profile.activate", id: store.state.profiles[0].id }),
  });
  eq("activate 200", res.statusCode, 200);
  eq("activeId 已切换", res.json().state.activeId, store.state.profiles[0].id);
}

{
  const bad = await call("POST", "/__ap/command", { body: JSON.stringify({ op: "profile.delete", id: "p-不存在" }) });
  eq("非法操作返 400（不是 500）", bad.statusCode, 400);
  eq("错误信息可读", typeof bad.json().error, "string");

  const malformed = await call("POST", "/__ap/command", { body: "{ 不是 JSON" });
  eq("坏 JSON 返 400", malformed.statusCode, 400);

  const array = await call("POST", "/__ap/command", { body: "[1,2,3]" });
  eq("数组体返 400", array.statusCode, 400);

  const empty = await call("POST", "/__ap/command", { body: "" });
  eq("空体不会崩（当作空对象）", empty.statusCode, 400);

  const huge = await call("POST", "/__ap/command", { body: `{"pad":"${"x".repeat(600 * 1024)}"}` });
  eq("超体积返 413", huge.statusCode, 413);
}

// ── ④ 同源守卫的四种分支 ────────────────────────────────────
{
  const crossSite = await call("GET", "/__ap/state", { headers: { host: "127.0.0.1:43120", "sec-fetch-site": "cross-site" } });
  eq("cross-site 拒绝", crossSite.statusCode, 403);

  const badOrigin = await call("GET", "/__ap/state", { headers: { host: "127.0.0.1:43120", origin: "http://evil.example" } });
  eq("Origin 不匹配拒绝", badOrigin.statusCode, 403);

  const badReferer = await call("GET", "/__ap/state", { headers: { host: "127.0.0.1:43120", referer: "http://evil.example/x" } });
  eq("Referer 不匹配拒绝", badReferer.statusCode, 403);

  const noOrigin = await call("GET", "/__ap/state", { headers: { host: "127.0.0.1:43120" } });
  eq("无 Origin/Referer 放行（curl 探活）", noOrigin.statusCode, 200);

  const goodOrigin = await call("GET", "/__ap/state", { headers: { host: "127.0.0.1:43120", origin: "http://127.0.0.1:43120" } });
  eq("Origin 匹配放行", goodOrigin.statusCode, 200);

  // <script src> 不带 Origin —— 这条要是 403，整个界面就是空白
  const scriptNoOrigin = await call("GET", CLIENT_SCRIPT_PATH, { headers: { host: "127.0.0.1:43120" } });
  eq("脚本请求（无 Origin）放行", scriptNoOrigin.statusCode, 200);
}

// ── ⑤ 预览（草稿，未保存）──────────────────────────────────
{
  const draft = { name: "草稿", role: "你是草稿角色", memories: [{ id: "m", text: "草稿记忆" }], injectMemory: true };
  const res = await call("POST", "/__ap/preview", { body: JSON.stringify({ profile: draft }) });
  eq("preview 200", res.statusCode, 200);
  const body = res.json();
  check("预览含角色", body.text.includes("你是草稿角色"));
  check("预览含记忆", body.text.includes("草稿记忆"));
  eq("chars 与 text 一致", body.chars, body.text.length);
  check("预览不会改动已存状态", store.state.profiles.every((p) => p.name !== "草稿"));

  const off = await call("POST", "/__ap/preview", {
    body: JSON.stringify({ profile: { ...draft, injectMemory: false } }),
  });
  check("关闭注入后预览不含记忆", !off.json().text.includes("草稿记忆"));

  const empty = await call("POST", "/__ap/preview", { body: JSON.stringify({ profile: { name: "空" } }) });
  eq("空草稿预览为空串", empty.json().text, "");

  const garbage = await call("POST", "/__ap/preview", { body: JSON.stringify({ profile: "not-an-object" }) });
  eq("垃圾草稿不崩", garbage.statusCode, 200);
}

// ── ⑥ 导出 ──────────────────────────────────────────────────
{
  const res = await call("GET", "/__ap/export");
  eq("export 200", res.statusCode, 200);
  const body = res.json();
  eq("信封 kind", body.kind, "dsh-agent-profiles");
  eq("信封含全部配置", body.state.profiles.length, store.state.profiles.length);
  check("信封含时间戳", typeof body.exportedAt === "string" && body.exportedAt.includes("T"));

  // 导出的东西必须能再导入（往返一致性）
  const before = store.state.profiles.length;
  const round = await call("POST", "/__ap/command", {
    body: JSON.stringify({ op: "state.import", mode: "replace", payload: body }),
  });
  eq("导出→导入成功", round.statusCode, 200);
  eq("往返后套数不变", round.json().state.profiles.length, before);
}

// ── ⑥b 会话专属设定走真实处理器 ─────────────────────────────
{
  const SESSION = "session-routes-1";
  const target = store.state.profiles[1].id;

  const before = await call("GET", "/__ap/state");
  eq("state 里带 sessions 字段", typeof before.json().state.sessions, "object");
  eq("出厂时没有会话设定", Object.keys(before.json().state.sessions).length, 0);

  const bound = await call("POST", "/__ap/command", {
    body: JSON.stringify({ op: "session.set", sessionId: SESSION, patch: { profileId: target } }),
  });
  eq("session.set 200", bound.statusCode, 200);
  eq("响应里绑定已生效", bound.json().state.sessions[SESSION].profileId, target);
  check("有提示文案", String(bound.json().notice).length > 0, bound.json().notice);
  eq("meta 报出会话数", bound.json().meta.sessionCount, 1);

  const withNote = await call("POST", "/__ap/command", {
    body: JSON.stringify({
      op: "session.set",
      sessionId: SESSION,
      patch: { note: "这次只看方案", memories: [{ id: "sm", text: "只要结论" }] },
    }),
  });
  eq("补写设定后绑定仍在", withNote.json().state.sessions[SESSION].profileId, target);
  eq("专属记忆已写入", withNote.json().state.sessions[SESSION].memories.length, 1);
  eq("meta 报出专属记忆数", withNote.json().meta.sessionMemoryCount, 1);

  const bad = await call("POST", "/__ap/command", {
    body: JSON.stringify({ op: "session.set", sessionId: SESSION, patch: { profileId: "p-无" } }),
  });
  eq("绑不存在的配置返 400", bad.statusCode, 400);

  const noId = await call("POST", "/__ap/command", {
    body: JSON.stringify({ op: "session.set", sessionId: "", patch: { note: "x" } }),
  });
  eq("缺会话 id 返 400", noId.statusCode, 400);

  const cleared = await call("POST", "/__ap/command", {
    body: JSON.stringify({ op: "session.clear", sessionId: SESSION }),
  });
  eq("session.clear 200", cleared.statusCode, 200);
  eq("清除后没了", cleared.json().state.sessions[SESSION], undefined);

  await call("POST", "/__ap/command", {
    body: JSON.stringify({ op: "session.set", sessionId: SESSION, patch: { note: "留着" } }),
  });
  const all = await call("POST", "/__ap/command", { body: JSON.stringify({ op: "sessions.clearAll" }) });
  eq("sessions.clearAll 200", all.statusCode, 200);
  eq("全部清除后为空", Object.keys(all.json().state.sessions).length, 0);
}

// ── ⑦ 客户端脚本投递 ────────────────────────────────────────
{
  const res = await call("GET", CLIENT_SCRIPT_PATH, { headers: { host: "127.0.0.1:43120" } });
  eq("脚本 200", res.statusCode, 200);
  eq("内容类型是 JS", res.headers["content-type"], "text/javascript; charset=utf-8");
  check("是 lazy-CJS 形态（不是裸 ESM）", res.body.includes("__ModuleLoader__"));
  check("加载 id 等于包名", res.body.includes('id: "dsh-agent-profiles"'));
  check("含幂等栅栏", res.body.includes("__DSH_AGENT_PROFILES_REGISTERED__"));
  check("含导出契约", res.body.includes("exports.apply") && res.body.includes("exports.inject"));
  check("注册进设置页槽", res.body.includes('"settings.section"'));
  check("注册进输入框槽", res.body.includes('"conversation.input.left"'));
  // 真正的不变量不是「一个反引号都没有」（注释里出现反引号无害），
  // 而是「**代码里**没有反引号」—— 历史上那个事故正是模板串被注释里的
  // 反引号提前终止。所以剥掉注释再断言。
  const codeOnly = res.body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  eq("代码里没有反引号（不会出现模板串事故）", codeOnly.includes("`"), false);
}

// ── ⑧ index 注入的幂等 ──────────────────────────────────────
{
  const transform = taps[0];
  const html = "<html><body><div id=root></div></body></html>";
  const once = transform(html);
  const twice = transform(once);
  eq("注入了一次", once.split("data-agent-profiles-bridge").length - 1, 1);
  eq("重复注入是幂等的", twice, once);
  check("脚本带 defer", once.includes("<script defer src="));
  eq("没有 </body> 时也能注入", transform("<html></html>").includes("data-agent-profiles-bridge"), true);
  eq("非字符串输入原样返回", transform(null), null);
}

// ── ⑨ 注销 ──────────────────────────────────────────────────
{
  for (const dispose of disposers) dispose();
  eq("全部路由已注销", routes.size, 0);
  eq("index tap 已注销", taps.length, 0);
  let threw = false;
  try {
    for (const dispose of disposers) dispose();
  } catch {
    threw = true;
  }
  eq("重复注销不抛错", threw, false);
}

fs.rmSync(dataDir, { recursive: true, force: true });

if (failures.length === 0) {
  console.log(`OK — ${passed} 项断言全部通过`);
  process.exit(0);
}
console.log(`FAIL — ${passed} 项通过，${failures.length} 项失败：`);
for (const line of failures) console.log(`  ✗ ${line}`);
process.exit(1);
