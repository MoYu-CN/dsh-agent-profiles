/**
 * dsh-agent-profiles —— 纯逻辑自测（store + prompt）。
 *
 * 这两层不依赖 Cordis / 浏览器，可以直接用 node 跑。
 * 跑它的目的不是覆盖率，而是把「安装之后没法反复手工验」的边界一次问清：
 * 空配置、损坏文件、删最后一套、导入合并撞 id、记忆开关、超长截断。
 *
 * 用法：node test/store.test.mjs
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ProfileStore,
  applyOp,
  defaultState,
  normalizeState,
  normalizeAvatar,
  exportEnvelope,
  LIMITS,
} from "../lib/store.js";
import { renderProfile, renderActive, renderForSession, renderSessionExtras, PROMPT_SECTION_NAME } from "../lib/prompt.js";

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

// ── ① 规整：垃圾输入不能炸，且不变量必须成立 ──────────────────
const junk = normalizeState({
  activeId: "不存在",
  profiles: [
    null,
    { name: "  ", icon: "", memories: [null, { text: "" }, { text: "留着", id: "dup" }] },
    { id: "dup", name: "撞 id", memories: [{ text: "x" }, { text: "y" }] },
  ],
});
eq("垃圾输入仍有一套以上配置", junk.profiles.length >= 1, true);
check("activeId 一定指向存在的配置", junk.profiles.some((p) => p.id === junk.activeId));
eq("空名字回退成占位名", junk.profiles[0].name.startsWith("未命名配置"), true);
eq("空图标回退", junk.profiles[0].icon, "🤖");
check("id 已去重", new Set(junk.profiles.map((p) => p.id)).size === junk.profiles.length);
eq("空记忆被丢弃", junk.profiles[1].memories.every((m) => m.text !== ""), true);

// ── ② 出厂状态：默认配置带着用户要求的准则 ───────────────────
const fresh = defaultState();
eq("出厂有 3 套示例配置", fresh.profiles.length, 3);
eq("出厂启用第一套", fresh.activeId, fresh.profiles[0].id);
eq("默认启用的是通用助手", fresh.profiles[0].name, "通用助手");
check(
  "三套配置都有内容",
  fresh.profiles.every((p) => renderProfile(p).length > 0),
);

// 默认助手的内容是**有意填好**的（用户明确要求）——把要求本身钉成断言：
// 以后谁把这段清空，测试就会红，而不是悄悄退回「零注入」。
{
  const rendered = renderProfile(fresh.profiles[0]);
  check("默认配置产生注入（不再是零注入）", rendered.length > 0);
  for (const needle of ["实事求是", "不猜想臆想", "简洁直白", "遵守规则", "做没做好都如实说"]) {
    check(`默认准则含「${needle}」`, rendered.includes(needle), rendered.slice(0, 200));
  }
}

// ── ③ 增删改复制：最少保留一套是硬约束 ───────────────────────
{
  const state = defaultState();
  const created = applyOp(state, { op: "profile.create", profile: { name: "测试" } });
  eq("新建成功", created.ok, true);
  eq("新建后自动成为当前", state.activeId, created.id);
  const updated = applyOp(state, { op: "profile.update", id: created.id, patch: { role: "你是测试员" } });
  eq("更新成功", updated.ok, true);
  eq("更新写入了内容", state.profiles.find((p) => p.id === created.id).role, "你是测试员");

  const dup = applyOp(state, { op: "profile.duplicate", id: created.id });
  eq("复制成功", dup.ok, true);
  eq("复制件是新 id", dup.id !== created.id, true);
  eq("复制件名字带副本", state.profiles.some((p) => p.name === "测试 副本"), true);

  const before = state.profiles.length;
  applyOp(state, { op: "profile.delete", id: created.id });
  eq("删除减少一套", state.profiles.length, before - 1);

  // 一路删到只剩一套，再删必须被拒绝
  let guard = 0;
  while (state.profiles.length > 1 && guard < 50) {
    applyOp(state, { op: "profile.delete", id: state.profiles[0].id });
    guard += 1;
  }
  const last = applyOp(state, { op: "profile.delete", id: state.profiles[0].id });
  eq("最后一套删不掉", last.ok, false);
  eq("剩下一套", state.profiles.length, 1);
  check("activeId 仍然有效", state.profiles.some((p) => p.id === state.activeId));

  const unknown = applyOp(state, { op: "profile.update", id: "p-不存在", patch: {} });
  eq("改不存在的配置被拒绝", unknown.ok, false);
  eq("未知 op 被拒绝", applyOp(state, { op: "nope" }).ok, false);
}

// ── ④ 记忆：增改删清 + 上限 ─────────────────────────────────
{
  const state = defaultState();
  const id = state.activeId;
  eq("加记忆", applyOp(state, { op: "memory.add", profileId: id, text: "用户用 TS" }).ok, true);
  eq("空记忆被拒", applyOp(state, { op: "memory.add", profileId: id, text: "   " }).ok, false);
  const profile = state.profiles.find((p) => p.id === id);
  eq("记忆条数 1", profile.memories.length, 1);
  eq("改记忆", applyOp(state, { op: "memory.update", profileId: id, memoryId: profile.memories[0].id, text: "用户主力语言是 TypeScript" }).ok, true);
  eq("改成空被拒", applyOp(state, { op: "memory.update", profileId: id, memoryId: profile.memories[0].id, text: "" }).ok, false);
  eq("删记忆", applyOp(state, { op: "memory.remove", profileId: id, memoryId: profile.memories[0].id }).ok, true);
  eq("删完为空", profile.memories.length, 0);
  eq("删不存在的记忆被拒", applyOp(state, { op: "memory.remove", profileId: id, memoryId: "m-x" }).ok, false);
  eq("空库清空是 no-op", applyOp(state, { op: "memory.clear", profileId: id }).changed, false);
}

// ── ⑤ 记忆开关与渲染 ────────────────────────────────────────
{
  const profile = {
    name: "编程助手",
    icon: "🧑‍💻",
    role: "你是资深工程师",
    personality: "严谨",
    speech: "先结论后理由",
    rules: "不确定就说不确定",
    memorySummary: "用户在做 DSH 插件",
    memories: [{ id: "m1", text: "用户主力语言是 TypeScript" }],
    injectMemory: true,
  };
  const on = renderProfile(profile);
  check("开启时含角色", on.includes("你是资深工程师"));
  check("开启时含记忆摘要", on.includes("用户在做 DSH 插件"));
  check("开启时含记忆条目", on.includes("TypeScript"));
  check("含优先级声明", on.includes("用户在当前对话里的直接指令"));

  const off = renderProfile({ ...profile, injectMemory: false });
  check("关闭后不含记忆摘要", !off.includes("用户在做 DSH 插件"), off.slice(0, 80));
  check("关闭后不含记忆条目", !off.includes("TypeScript"));
  check("关闭后角色仍生效", off.includes("你是资深工程师"));

  const bare = renderProfile({ name: "只有名字", icon: "🤖", injectMemory: true });
  eq("只有名字不注入", bare, "");

  const long = renderProfile({ ...profile, rules: "规".repeat(20000) }, { maxChars: 500 });
  check("超长被截断", long.length < 700, String(long.length));
  check("截断有说明", long.includes("已截断"));

  // store 里真实取一遍（renderActive 是注入路径上真正调用的函数）
  const store = { activeProfile: () => profile };
  eq("renderActive 命中当前配置", renderActive(store).includes("编程助手"), true);
  eq("renderActive 对空 store 返回空串", renderActive({ activeProfile: () => undefined }), "");
  eq("renderActive 对抛错的 store 返回空串", renderActive({ activeProfile: () => { throw new Error("boom"); } }), "");
  check("段落名非空", typeof PROMPT_SECTION_NAME === "string" && PROMPT_SECTION_NAME.length > 0);
}

// ── ⑥ 导入 / 导出 ───────────────────────────────────────────
{
  const source = defaultState();
  const envelope = exportEnvelope(source);
  eq("信封标记", envelope.kind, "dsh-agent-profiles");
  eq("信封带版本", envelope.version, 1);

  const replaced = defaultState();
  eq("覆盖导入", applyOp(replaced, { op: "state.import", mode: "replace", payload: envelope }).ok, true);
  eq("覆盖后套数一致", replaced.profiles.length, source.profiles.length);

  const merged = defaultState();
  const before = merged.profiles.length;
  const result = applyOp(merged, { op: "state.import", mode: "merge", payload: envelope });
  eq("合并导入成功", result.ok, true);
  eq("合并后变多", merged.profiles.length, before + source.profiles.length);
  check("合并件名字带（导入）", merged.profiles.some((p) => p.name.includes("（导入）")));
  check("合并后 id 仍不重复", new Set(merged.profiles.map((p) => p.id)).size === merged.profiles.length);

  // 裸状态（不带信封）也能导入
  const bare = defaultState();
  eq("裸状态可导入", applyOp(bare, { op: "state.import", mode: "replace", payload: { profiles: [{ name: "手写的" }] } }).ok, true);
  eq("裸状态只有一套", bare.profiles.length, 1);
  eq("空文件被拒绝", applyOp(bare, { op: "state.import", mode: "replace", payload: { profiles: [] } }).ok, false);
  eq("垃圾被拒绝", applyOp(bare, { op: "state.import", mode: "replace", payload: { hello: 1 } }).ok, false);
}

// ── ⑦ 恢复默认 ──────────────────────────────────────────────
{
  const state = defaultState();
  applyOp(state, { op: "profile.create", profile: { name: "临时的" } });
  eq("恢复默认", applyOp(state, { op: "state.restoreDefaults" }).ok, true);
  eq("恢复后回到 3 套", state.profiles.length, 3);
  check("临时配置已消失", !state.profiles.some((p) => p.name === "临时的"));
}

// ── ⑧ 落盘 / 读回 / 损坏文件 ────────────────────────────────
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-test-"));
  const store = new ProfileStore(dir);
  eq("首次 load 无文件返回 false", store.load(), false);
  eq("无文件时用默认值", store.state.profiles.length, 3);

  const created = await store.command({ op: "profile.create", profile: { name: "落盘测试", role: "角色" } });
  eq("落盘写入成功", created.ok, true);
  check("文件已存在", fs.existsSync(store.file));
  check("没有残留 tmp", !fs.existsSync(`${store.file}.tmp`));

  const reopened = new ProfileStore(dir);
  eq("重新读取成功", reopened.load(), true);
  eq("读回后套数一致", reopened.state.profiles.length, 4);
  eq("读回后当前配置一致", reopened.state.activeId, created.state.activeId);
  eq("读回后内容一致", reopened.activeProfile().role, "角色");

  // 损坏文件：必须回退默认值而不是抛错
  fs.writeFileSync(store.file, "{ 这不是 JSON", "utf8");
  const broken = new ProfileStore(dir);
  eq("损坏文件不抛错", broken.load(), false);
  check("损坏时记下原因", typeof broken.lastError === "string" && broken.lastError.length > 0);
  eq("损坏时仍可用（默认值）", broken.state.profiles.length, 3);
  eq("损坏时命令仍可执行", (await broken.command({ op: "profile.create" })).ok, true);
  eq("覆盖损坏文件后恢复", broken.load(), true);

  // 并发写：串行链必须保证不丢更新
  const concurrent = new ProfileStore(dir);
  await Promise.all([
    concurrent.command({ op: "memory.add", profileId: concurrent.state.activeId, text: "并发A" }),
    concurrent.command({ op: "memory.add", profileId: concurrent.state.activeId, text: "并发B" }),
    concurrent.command({ op: "memory.add", profileId: concurrent.state.activeId, text: "并发C" }),
  ]);
  eq("并发三次新增都落地", concurrent.activeProfile().memories.length, 3);

  // 落盘失败必须回滚内存（否则界面显示已保存、重启后消失）
  const readonlyDir = path.join(dir, "ro");
  fs.mkdirSync(readonlyDir);
  const blocked = new ProfileStore(path.join(readonlyDir, "nope", "\u0000invalid"));
  const failed = await blocked.command({ op: "profile.create", profile: { name: "写不进去" } });
  eq("非法路径写入失败被如实上报", failed.ok, false);
  eq("失败后内存未变", blocked.state.profiles.length, 3);

  fs.rmSync(dir, { recursive: true, force: true });
}

// ── ⑨ 上限 ──────────────────────────────────────────────────
{
  const state = defaultState();
  const huge = "x".repeat(LIMITS.name + 500);
  applyOp(state, { op: "profile.update", id: state.activeId, patch: { name: huge } });
  eq("名字被截断到上限", state.profiles.find((p) => p.id === state.activeId).name.length, LIMITS.name);

  const many = defaultState();
  const manyActive = () => many.profiles.find((p) => p.id === many.activeId);
  for (let i = 0; i < LIMITS.memories + 20; i += 1) {
    applyOp(many, { op: "memory.add", profileId: many.activeId, text: `记忆 ${i}` });
  }
  eq("记忆条数被限制", manyActive().memories.length, LIMITS.memories);
  eq("到达上限后新增被拒", applyOp(many, { op: "memory.add", profileId: many.activeId, text: "再来一条" }).ok, false);
}

// ── ⑩ 会话专属设定（每个对话一套）────────────────────────────
{
  const S1 = "session-aaa";
  const S2 = "session-bbb";
  const state = defaultState();
  const second = state.profiles[1].id;

  eq("出厂没有会话设定", Object.keys(state.sessions).length, 0);

  const bound = applyOp(state, { op: "session.set", sessionId: S1, patch: { profileId: second } });
  eq("绑定成功", bound.ok, true);
  eq("绑定被记住", state.sessions[S1].profileId, second);

  eq("缺会话 id 被拒", applyOp(state, { op: "session.set", sessionId: "  ", patch: {} }).ok, false);
  eq("绑到不存在的配置被拒",
    applyOp(state, { op: "session.set", sessionId: S1, patch: { profileId: "p-不存在" } }).ok, false);

  // 补充设定与专属记忆
  applyOp(state, { op: "session.set", sessionId: S1, patch: { note: "这次只讨论方案" } });
  eq("补充设定被记住", state.sessions[S1].note, "这次只讨论方案");
  eq("绑定没被覆盖", state.sessions[S1].profileId, second);

  applyOp(state, {
    op: "session.set",
    sessionId: S1,
    patch: { memories: [{ id: "sm1", text: "这次只要结论" }] },
  });
  eq("专属记忆被记住", state.sessions[S1].memories.length, 1);
  eq("专属记忆内容正确", state.sessions[S1].memories[0].text, "这次只要结论");

  // 只留「跟随全局」+ 空内容 ⇒ 这条记录应当消失（否则计数会虚高）
  applyOp(state, { op: "session.set", sessionId: S1, patch: { profileId: null, note: "", memories: [] } });
  eq("清空后记录被删除", state.sessions[S1], undefined);

  // 两个对话互不影响
  applyOp(state, { op: "session.set", sessionId: S1, patch: { note: "一号对话" } });
  applyOp(state, { op: "session.set", sessionId: S2, patch: { note: "二号对话" } });
  eq("两个对话各自独立", state.sessions[S1].note !== state.sessions[S2].note, true);
  eq("会话数 2", Object.keys(state.sessions).length, 2);

  eq("清除单个对话", applyOp(state, { op: "session.clear", sessionId: S1 }).ok, true);
  eq("清除后只剩一个", Object.keys(state.sessions).length, 1);
  eq("清不存在的对话是 no-op", applyOp(state, { op: "session.clear", sessionId: "nope" }).changed, false);

  // effective()：绑定优先，否则跟随全局
  const real = new ProfileStore("C:/tmp/never-used");
  real.state = state;
  eq("未绑定的对话跟随全局", real.effective("session-zzz").profile.id, state.activeId);
  eq("未绑定的对话 bound=false", real.effective("session-zzz").bound, false);
  eq("已绑定的对话用绑定项", real.effective(S2).profile.id, state.activeId); // S2 只写了 note，没绑定
  applyOp(state, { op: "session.set", sessionId: S2, patch: { profileId: second } });
  eq("绑定后 effective 用绑定项", real.effective(S2).profile.id, second);
  eq("绑定后 bound=true", real.effective(S2).bound, true);

  // 删除配置要把指向它的绑定解开
  const deleted = applyOp(state, { op: "profile.delete", id: second });
  eq("删除配置成功", deleted.ok, true);
  eq("指向它的绑定被解开", state.sessions[S2].profileId, null);
  check("提示里说明了影响到几个对话", String(deleted.notice).includes("1 个对话"), deleted.notice);

  // 全部清除
  eq("全部清除", applyOp(state, { op: "sessions.clearAll" }).ok, true);
  eq("清除后为空", Object.keys(state.sessions).length, 0);

  // 恢复出厂也要清掉会话绑定（配置 id 都换了，留着就是悬空）
  applyOp(state, { op: "session.set", sessionId: S1, patch: { note: "x" } });
  applyOp(state, { op: "state.restoreDefaults" });
  eq("恢复默认清空会话设定", Object.keys(state.sessions).length, 0);

  // 导出不含会话（会话 id 是本机的，导出去只会是孤儿）
  applyOp(state, { op: "session.set", sessionId: S1, patch: { note: "导出前的对话" } });
  const env = exportEnvelope(state);
  eq("导出信封不含 sessions", env.state.sessions, undefined);
  check("导出仍然带着配置", env.state.profiles.length > 0);
}

// ── ⑪ 会话表的规整与上限 ────────────────────────────────────
{
  const junk = normalizeState({
    profiles: [{ id: "p-fixed", name: "固定配置" }],
    activeId: "p-fixed",
    sessions: {
      "": { note: "空 id 要被丢掉" },
      "s-keep": { profileId: null, note: "留着" },
      "s-empty": { note: "   ", memories: [] },
      "s-dangling": { profileId: "p-不存在", note: "绑了个寂寞" },
      "s-ok": { profileId: "p-fixed", note: "正常", memories: [{ text: "记忆" }, { text: "" }] },
    },
  });
  eq("空 id 被丢弃", junk.sessions[""], undefined);
  eq("有内容的留下", junk.sessions["s-keep"].note, "留着");
  eq("全空的丢弃", junk.sessions["s-empty"], undefined);
  eq("悬空绑定被清成 null", junk.sessions["s-dangling"].profileId, null);
  eq("正常绑定保留", junk.sessions["s-ok"].profileId, "p-fixed");
  eq("空记忆条目被丢弃", junk.sessions["s-ok"].memories.length, 1);
  eq("会话 id 不是对象时也不炸", normalizeState({ sessions: "不是对象" }).sessions !== undefined, true);
  eq("sessions 是数组时也不炸", Object.keys(normalizeState({ sessions: [1, 2] }).sessions).length, 0);

  // 上限：按最近更新保留
  const raw = {};
  for (let i = 0; i < LIMITS.sessions + 30; i += 1) {
    raw[`s-${i}`] = { note: `n${i}`, updatedAt: 1000 + i };
  }
  const capped = normalizeState({ sessions: raw });
  eq("会话数被限制在上限", Object.keys(capped.sessions).length, LIMITS.sessions);
  check("保留的是最近更新的那批", capped.sessions[`s-${LIMITS.sessions + 29}`] !== undefined);
  eq("最旧的那条被淘汰", capped.sessions["s-0"], undefined);
}

// ── ⑫ 会话设定的落盘读回 ────────────────────────────────────
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-session-"));
  const store = new ProfileStore(dir);
  store.load();
  const target = store.state.profiles[1].id;
  await store.command({
    op: "session.set",
    sessionId: "session-persist",
    patch: { profileId: target, note: "落盘测试", memories: [{ id: "m", text: "会话记忆" }] },
  });
  const reopened = new ProfileStore(dir);
  eq("重新读取成功", reopened.load(), true);
  eq("会话绑定读回来了", reopened.sessionOf("session-persist").profileId, target);
  eq("会话补充设定读回来了", reopened.sessionOf("session-persist").note, "落盘测试");
  eq("会话专属记忆读回来了", reopened.sessionOf("session-persist").memories.length, 1);
  eq("describe 报出会话数", reopened.describe().sessionCount, 1);
  eq("describe 报出会话记忆数", reopened.describe().sessionMemoryCount, 1);

  // 导入不应该波及会话设定
  await reopened.command({ op: "state.import", mode: "replace", payload: exportEnvelope(defaultState()) });
  eq("导入后会话设定仍在", reopened.sessionOf("session-persist") !== null, true);
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── ⑬ 注入文本：配置 + 本对话专属部分 ───────────────────────
{
  const profile = {
    id: "p1",
    name: "编程助手",
    icon: "🧑‍💻",
    role: "你是资深工程师",
    personality: "严谨",
    speech: "先结论",
    rules: "不确定就说不确定",
    memorySummary: "用户在做 DSH 插件",
    memories: [{ id: "m1", text: "配置级记忆" }],
    injectMemory: true,
  };
  const session = {
    profileId: "p1",
    note: "这次只讨论方案，先别改代码",
    memories: [{ id: "s1", text: "本次对话只要结论" }],
    updatedAt: 1,
  };

  eq("没有会话时 extras 为空串", renderSessionExtras(null), "");
  eq("空会话 extras 为空串", renderSessionExtras({ note: "  ", memories: [] }), "");

  const extras = renderSessionExtras(session);
  check("extras 含补充设定", extras.includes("这次只讨论方案"));
  check("extras 含专属记忆", extras.includes("本次对话只要结论"));
  check("extras 小节名清楚", extras.includes("本次对话的补充设定") && extras.includes("本次对话的专属记忆"));

  // 用一个假 store 走完整的 renderForSession
  const fakeStore = {
    state: { activeId: "p1", profiles: [profile], sessions: { "s-x": session } },
    sessionOf(id) {
      return this.state.sessions[id] ?? null;
    },
    profileById(id) {
      return this.state.profiles.find((p) => p.id === id);
    },
    activeProfile() {
      return this.state.profiles[0];
    },
    effective(id) {
      const s = this.sessionOf(id);
      const bound = s !== null && s.profileId !== null;
      return { profile: bound ? this.profileById(s.profileId) : this.activeProfile(), session: s, bound };
    },
  };

  const text = renderForSession(fakeStore, "s-x");
  check("含配置本体", text.includes("你是资深工程师"));
  check("含配置级记忆", text.includes("配置级记忆"));
  check("含本对话补充设定", text.includes("这次只讨论方案"));
  check("含本对话专属记忆", text.includes("本次对话只要结论"));

  const followGlobal = renderForSession(fakeStore, "s-unknown");
  check("未绑定的对话只注入配置", followGlobal.includes("你是资深工程师") && !followGlobal.includes("这次只讨论方案"));

  // ⚠ 关键行为：配置关了「记忆注入」，**本对话专属记忆仍然要注入**
  //   —— 那个开关管的是配置自带的长期记忆，不该吞掉用户为这次对话专门写的东西。
  fakeStore.state.profiles = [{ ...profile, injectMemory: false }];
  const off = renderForSession(fakeStore, "s-x");
  check("关掉配置记忆后不含配置级记忆", !off.includes("配置级记忆"));
  check("关掉配置记忆后仍含本对话专属记忆", off.includes("本次对话只要结论"), off);
  check("关掉配置记忆后补充设定仍在", off.includes("这次只讨论方案"));

  // 配置为空、只有本对话内容时，也要有一个能读懂的开头
  fakeStore.state.profiles = [{ id: "p9", name: "空配置", icon: "🤖", injectMemory: true }];
  fakeStore.state.sessions = { "s-y": { profileId: "p9", note: "只有这句", memories: [], updatedAt: 1 } };
  const onlyNote = renderForSession(fakeStore, "s-y");
  check("空配置 + 本对话设定仍然注入", onlyNote.includes("只有这句"), onlyNote);
  check("并带上标题", onlyNote.includes("# 智能体配置"), onlyNote);

  eq("坏 store 不抛错（返回空串）", renderForSession({ effective() { throw new Error("boom"); } }, "s"), "");
  eq("store 缺方法也不抛错", renderForSession({}, "s"), "");
}

// ── ⑭ 头像 ──────────────────────────────────────────────────
{
  const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const JPEG = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";
  const WEBP = "data:image/webp;base64,UklGRhIAAABXRUJQVlA4TAYAAAAvAAAAAAfQ//73v/+BiOh/AAA=";
  const GIF = "data:image/gif;base64,R0lGODlhAQABAAAAACw=";

  eq("PNG 被接受", normalizeAvatar(PNG), PNG);
  eq("JPEG 被接受", normalizeAvatar(JPEG), JPEG);
  eq("WebP 被接受", normalizeAvatar(WEBP), WEBP);
  eq("GIF 被接受", normalizeAvatar(GIF), GIF);
  eq("前后空白被去掉", normalizeAvatar(`  ${PNG}  `), PNG);

  // ⚠ SVG 必须拒绝：SVG 里能带脚本，等于给配置开一个 XSS 口子。
  eq("SVG 被拒绝", normalizeAvatar("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="), "");
  eq("非图片 data URL 被拒绝", normalizeAvatar("data:text/html;base64,PHNjcmlwdD4="), "");
  eq("普通 URL 被拒绝", normalizeAvatar("https://example.com/a.png"), "");
  eq("base64 体里有非法字符被拒绝", normalizeAvatar("data:image/png;base64,<script>"), "");
  eq("空串保持不变", normalizeAvatar(""), "");
  eq("非字符串被拒绝", normalizeAvatar(12345), "");
  eq("null 被拒绝", normalizeAvatar(null), "");

  const tooLong = `data:image/png;base64,${"A".repeat(LIMITS.avatar)}`;
  eq("超过长度上限被拒绝", normalizeAvatar(tooLong), "");

  // 进配置后要能存住、读回、导出
  const state = defaultState();
  const id = state.activeId;
  const saved = applyOp(state, { op: "profile.update", id, patch: { avatar: PNG } });
  eq("保存头像成功", saved.ok, true);
  eq("头像存进配置", state.profiles.find((p) => p.id === id).avatar, PNG);
  eq("非法头像不报错", applyOp(state, { op: "profile.update", id, patch: { avatar: "https://x/a.png" } }).ok, true);
  eq("非法值落成空串（不是 undefined）", state.profiles.find((p) => p.id === id).avatar, "");

  applyOp(state, { op: "profile.update", id, patch: { avatar: PNG } });
  const env = exportEnvelope(state);
  eq("导出带着头像（配置自包含）", env.state.profiles.find((p) => p.id === id).avatar, PNG);

  const round = normalizeState(JSON.parse(JSON.stringify(state)));
  eq("规整后头像仍在", round.profiles.find((p) => p.id === id).avatar, PNG);

  const dup = applyOp(state, { op: "profile.duplicate", id });
  eq("副本带上了头像", state.profiles.find((p) => p.id === dup.id).avatar, PNG);

  check(
    "提示词里不出现头像数据（base64 不该进模型上下文）",
    renderProfile(state.profiles.find((p) => p.id === id)).includes("base64") === false,
  );
}

// ── ⑮ 变更广播（技能目录靠它失效重算）──────────────────────
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-change-"));
  const store = new ProfileStore(dir);
  store.load();

  let hits = 0;
  const off = store.onChange(() => { hits += 1; });

  await store.command({ op: "profile.create", profile: { name: "广播测试" } });
  eq("成功写入后广播一次", hits, 1);

  // 失败的写入**不该**广播：状态已回滚，广播会让技能目录算出不存在的内容
  await store.command({ op: "profile.delete", id: "p-不存在" });
  eq("失败写入不广播", hits, 1);

  // 一个订阅者抛错不能把写入链带崩（否则等于「配置存不进去」）
  store.onChange(() => { throw new Error("订阅者炸了"); });
  const afterThrow = await store.command({ op: "profile.create", profile: { name: "带坏订阅者" } });
  eq("有订阅者抛错时写入仍然成功", afterThrow.ok, true);
  eq("其他订阅者照样收到广播", hits, 2);

  off();
  await store.command({ op: "profile.create", profile: { name: "退订之后" } });
  eq("退订后不再收到", hits, 2);

  fs.rmSync(dir, { recursive: true, force: true });
}

// ── 结果 ────────────────────────────────────────────────────
if (failures.length === 0) {
  console.log(`OK — ${passed} 项断言全部通过`);
  process.exit(0);
}
console.log(`FAIL — ${passed} 项通过，${failures.length} 项失败：`);
for (const line of failures) console.log(`  ✗ ${line}`);
process.exit(1);
