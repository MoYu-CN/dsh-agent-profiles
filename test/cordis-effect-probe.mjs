/**
 * Cordis effect 探针：验证「effect 回调返回清理函数」到底会不会炸。
 *
 * 背景：宿主日志里出现
 *   [agent-registry] agent "...": agent/disposed listener threw:
 *   TypeError: Cannot read properties of undefined (reading 'catch')
 *
 * cordis/lib/index.js 第 1266 行是：
 *   task?.catch(() => { ... }).catch((error) => this.ctx.logger.error(error));
 * 如果 `task` 是 undefined，`task?.catch(...)` 得到 undefined，
 * 紧接着的 `.catch(...)` 就会抛「reading 'catch'」。
 *
 * 用法：node test/cordis-effect-probe.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

/**
 * 官方 Host 程序目录（`<安装根>/resources/app`）。
 * 解析顺序：`DSH_APP_DIR` → `DSH_INSTALL_DIR` → 由 `process.execPath` 反推 → 常见默认位置。
 * 全部落空 → 打印说明并以退出码 2 失败（不静默跳过）。
 */
function resolveAppDir() {
  const explicit = process.env.DSH_APP_DIR;
  if (typeof explicit === "string" && explicit.trim() !== "") return path.resolve(explicit.trim());
  const installDir = process.env.DSH_INSTALL_DIR;
  if (typeof installDir === "string" && installDir.trim() !== "") {
    return path.join(path.resolve(installDir.trim()), "resources", "app");
  }
  const exeDir = path.dirname(path.resolve(process.execPath));
  for (const candidate of [
    path.join(exeDir, "resources", "app"),
    path.join(exeDir, "..", "resources", "app"),
    "C:/Program Files/DSH Desktop/resources/app",
    "C:/Program Files (x86)/DSH Desktop/resources/app",
  ]) {
    if (fs.existsSync(path.join(candidate, "index.js"))) return candidate;
  }
  console.error(
    "找不到官方 Host 程序目录（<安装根>/resources/app）。请设 DSH_APP_DIR 后重跑，例如：\n" +
      '  $env:DSH_APP_DIR = "D:/Apps/DSH Desktop/resources/app"',
  );
  process.exit(2);
}

const appRequire = createRequire(
  path.join(resolveAppDir(), "index.js"),
);
const cordis = appRequire("@deepseek-ai/cordis");
console.log("cordis 导出：", Object.keys(cordis).slice(0, 12).join(", "));

const Context = cordis.Context ?? cordis.default;
if (typeof Context !== "function") {
  console.log("拿不到 Context 构造器，放弃");
  process.exit(2);
}

function attempt(label, fn) {
  const ctx = new Context();
  try {
    const disposer = fn(ctx);
    console.log(`  ${label} → 没抛错，返回 ${typeof disposer}`);
    try {
      disposer?.();
      console.log(`     并且调用返回值成功`);
    } catch (error) {
      console.log(`     但调用返回值抛错：${error.message}`);
    }
  } catch (error) {
    console.log(`  ${label} → 抛错：${error.constructor.name}: ${error.message}`);
  }
  try {
    ctx.stop?.();
  } catch {
    /* 无所谓 */
  }
}

console.log("\n=== 四种写法 ===");
attempt("① 返回清理函数（我用的写法）", (ctx) => ctx.effect(() => () => {}));
attempt("② 返回 undefined", (ctx) => ctx.effect(() => {}));
attempt("③ 返回 Promise<清理函数>", (ctx) => ctx.effect(() => Promise.resolve(() => {})));
attempt("④ 返回 Promise<undefined>", (ctx) => ctx.effect(async () => {}));
attempt("⑤ async 回调里 return 清理函数", (ctx) =>
  ctx.effect(async () => {
    return () => {};
  }),
);

// ── 关键：**注销器被调用时返回什么** ──────────────────────────
//
// 会话日志里的崩溃是 host 在 agent 销毁时对「effect 注销器的返回值」调
// `.catch()`，而那个返回值是 undefined 时就会抛
// TypeError: Cannot read properties of undefined (reading 'catch')。
// 所以真正要问的是：注销器什么时候返回 thenable。
console.log("\n=== 注销器（effect 的返回值）被调用时返回什么 ===");
function disposal(label, fn) {
  const ctx = new Context();
  const dispose = fn(ctx);
  let returned;
  try {
    returned = dispose();
  } catch (error) {
    console.log(`  ${label} → 调用注销器抛错：${error.message}`);
    return;
  }
  const kind =
    returned === undefined
      ? "undefined"
      : returned !== null && typeof returned.then === "function"
        ? "thenable ✓（host 的 .catch() 能用）"
        : typeof returned;
  console.log(`  ${label} → ${kind}`);
}

disposal("① 同步清理（() => () => {}）", (ctx) => ctx.effect(() => () => {}));
disposal("② 什么都不返回", (ctx) => ctx.effect(() => {}));
disposal(
  "③ 同步清理但返回 Promise（() => () => Promise.resolve()）",
  (ctx) => ctx.effect(() => () => Promise.resolve()),
);
disposal("④ 回调本身是 async", (ctx) => ctx.effect(async () => {}));

console.log("\n结论：要让 host 的 .catch() 拿得到东西，注销器必须返回 thenable。");

// ── 复现宿主真实的调用姿势 ──────────────────────────────────
//
// 宿主在 agent 销毁时是这么用的（就是崩在这里）：
//     const dispose = agentCtx.effect(注册回调);
//     ...
//     dispose().catch(onError)          // ← 注销器返回 undefined 时抛 TypeError
//
// 下面用**真的 cordis** 把这个姿势跑一遍：旧写法必炸，新写法通过。
console.log("\n=== 用真 cordis 复现宿主的调用姿势 ===");
function hostPattern(label, register) {
  const ctx = new Context();
  const dispose = ctx.effect(register);
  let outcome;
  try {
    dispose().catch((error) => {
      outcome = `宿主拿到 rejection：${error.message}`;
    });
    outcome = outcome ?? "宿主拿到了 thenable，没抛错 ✓";
  } catch (error) {
    outcome = `宿主抛错：${error.constructor.name}: ${error.message}`;
  }
  console.log(`  ${label}\n      → ${outcome}`);
}

hostPattern("旧写法（0.2.0 事故版）：() => someDisposer()", () => () => undefined);
hostPattern(
  "新写法（0.2.1 修复版）：() => Promise.resolve().then(() => someDisposer())",
  () => () => Promise.resolve().then(() => undefined),
);


