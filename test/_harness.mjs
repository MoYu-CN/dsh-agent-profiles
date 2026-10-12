/**
 * _harness.mjs —— 本插件 test/ 下所有测试共用的「干净检出也能跑」脚手架。
 *
 * ## 为什么每个测试都要用这里的函数
 * 一个测试脚本里只要还剩一处写死的插件路径或真实数据路径，
 * 「从干净检出就能跑」就不成立 —— 换台机器、换个目录名立刻失效。
 * 所以：
 *   - **插件自己的位置**：一律 `import.meta.url`/`process.argv[1]` 反推，谁都不许写字面量；
 *   - **数据目录**：只走 `DSH_*_DATA`；没设就 `mkdtemp` 自建，并在结束时可清理；
 *   - **官方包 / react**：只走 `DSH_APP_DIR`（或从 `DSH_INSTALL_DIR` / `process.execPath` 反推），
 *     全都找不到时返回 `null`，**由调用方打印一句说明并跳过**（不许静默跳过）。
 *
 * ## 为什么把 `srcDir` 从 `here` 里独立推导
 * 开发机上的实装是 Junction，`import.meta.url` 会指向**被链接进 profile 的那条路径**，
 * 而 checkout 里的 `test/` 可能通过另一条路径被访问。`srcDir` 只取相对位置
 * （`…/test/_harness.mjs` → 上一级），因此两条路径都成立。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

/** 本文件所在目录（= 本插件的 `test/`），真实路径。 */
export const here = path.dirname(fs.realpathSync(fileURLToPath(import.meta.url)));

/** 本插件的 `lib/` —— 测试真正要 import 的那份源码。 */
export const srcDir = path.resolve(here, "..", "lib");

/** 单个源文件的绝对路径，例如 `pluginFile("kb-store.js")`。 */
export const pluginFile = (name) => path.join(srcDir, name);

/** 本插件根目录。 */
export const pluginRoot = path.resolve(here, "..");

/** 按 `name` 取环境变量；未设 / 空串都算「没设」。 */
export function envPath(name) {
  const value = process.env[name];
  return value === undefined || value === null || value.trim() === "" ? null : path.resolve(value);
}

/**
 * 定位 DSH 安装根（含 `resources/app` 的那一级）。
 *
 * 顺序：`DSH_APP_DIR`（直接给 app 目录）→ `DSH_INSTALL_DIR` → 由 `process.execPath`
 * 反推（Electron-as-node 下就是 DSH Desktop.exe）→ 各平台常见默认安装位置。
 *
 * @returns {{ appDir: string, pkgDir: string, source: string } | null}
 *   `pkgDir` = `appDir/node_modules/@deepseek-ai`；全落空时返回 `null`。
 */
export function resolveApp() {
  const candidates = [];
  const direct = envPath("DSH_APP_DIR");
  if (direct !== null) candidates.push({ appDir: direct, source: "DSH_APP_DIR" });
  const install = envPath("DSH_INSTALL_DIR");
  if (install !== null) candidates.push({ appDir: path.join(install, "resources", "app"), source: "DSH_INSTALL_DIR" });

  const exe = process.execPath;
  if (typeof exe === "string" && exe !== "") {
    const exeDir = path.dirname(exe);
    candidates.push({ appDir: path.join(exeDir, "resources", "app"), source: "process.execPath" });
    // macOS：<App>.app/Contents/MacOS/<exe> → <App>.app/Contents/Resources/app
    candidates.push({ appDir: path.resolve(exeDir, "..", "Resources", "app"), source: "process.execPath(mac)" });
  }

  const local = process.env.LOCALAPPDATA;
  if (typeof local === "string" && local !== "") {
    candidates.push({ appDir: path.join(local, "Programs", "DSH Desktop", "resources", "app"), source: "LOCALAPPDATA" });
  }
  candidates.push({ appDir: "/Applications/DSH Desktop.app/Contents/Resources/app", source: "macOS 默认位置" });

  for (const c of candidates) {
    if (fs.existsSync(path.join(c.appDir, "package.json"))) {
      return { appDir: c.appDir, pkgDir: path.join(c.appDir, "node_modules", "@deepseek-ai"), source: c.source };
    }
  }
  return null;
}

/** `resolveApp()` 的简写：只要 `@deepseek-ai` 那一层，落空返回 `null`。 */
export function officialPkgDir() {
  const app = resolveApp();
  return app === null ? null : app.pkgDir;
}

/**
 * 官方包里的某个文件（如 `["dsh-tools","lib","index.js"]`）。
 * 安装根找不到、或文件不存在时返回 `null`。
 */
export function officialFile(...segments) {
  const pkg = officialPkgDir();
  if (pkg === null) return null;
  const file = path.join(pkg, ...segments);
  return fs.existsSync(file) ? file : null;
}

/** `react/index.js` 的绝对路径；安装根找不到或没装 react 时返回 `null`。 */
export function reactFile() {
  const app = resolveApp();
  if (app === null) return null;
  const file = path.join(app.appDir, "node_modules", "react", "index.js");
  return fs.existsSync(file) ? file : null;
}

/** 打印一条「为什么跳过了这项」的说明（**必须**在跳过前调用，不许静默跳过）。 */
export function printSkip(reason) {
  console.log(`SKIP  ${reason}`);
}

/** 打印一条「因为拿不到某个外部依赖，所以跳过」的标准说明。 */
export function printSkipMissingApp(what) {
  console.log(
    `SKIP  ${what}：拿不到 DSH 安装目录（没设 DSH_APP_DIR、也没能从 process.execPath 反推出来）。\n` +
      `      要跑这一项请设 DSH_APP_DIR=<安装根>/resources/app，例如：\n` +
      `      $env:DSH_APP_DIR = "C:\\Program Files\\DSH Desktop\\resources\\app"`,
  );
}

/**
 * 建一个临时目录。
 *
 * @param prefix - 目录名前缀，便于在系统临时目录里认出来。
 * @returns `{dir, cleanup}`
 */
export function tempDir(prefix = "dsh-test-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    dir,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * 解析「数据目录」：
 *   - 环境变量 `envName` 有值 → 用它（调用方负责别指向真实数据目录）；
 *   - 没设 → 在临时目录里现建一个，并登记 `onExit` 清理。
 *
 * @param envName - 数据目录环境变量的名字。
 * @param prefix - 自建临时目录时的前缀。
 * @param options - `{setEnv=true, onExit=true}`：是否写回 `process.env`、是否注册退出清理。
 * @returns `{dir, selfMade, cleanup}`。`selfMade=true` 表示这是脚本自己建的临时目录。
 */
export function testDataDir(envName, prefix, options = {}) {
  const { setEnv = true, onExit = true } = options;
  const given = envPath(envName);
  if (given !== null) {
    fs.mkdirSync(given, { recursive: true });
    const cleanup = () => fs.rmSync(given, { recursive: true, force: true });
    return { dir: given, selfMade: false, cleanup };
  }
  const made = tempDir(prefix);
  if (setEnv) process.env[envName] = made.dir;
  if (onExit) {
    process.on("exit", () => {
      try {
        made.cleanup();
      } catch {
        /* 退出时清理失败不该改变测试结论 */
      }
    });
  }
  console.log(`${envName} 未设 → 自建临时数据目录：${made.dir}（进程退出时删除）`);
  return { dir: made.dir, selfMade: true, cleanup: made.cleanup };
}

/**
 * 把「要落盘的原始输出」写到哪。
 *
 * 规则：`DSH_TEST_OUT_DIR` 设了就写那儿；没设就写系统临时目录。
 * **绝不往仓库里写** —— 否则跑一次测试就会在 git status 里多出一堆文件。
 *
 * @param fileName - 输出文件名。
 * @returns 绝对路径（目录会被建出来），并把 `saved` 登记进本次运行的产物清单。
 */
const savedOutputs = [];
export function outFile(fileName) {
  const dir = envPath("DSH_TEST_OUT_DIR") ?? fs.mkdtempSync(path.join(os.tmpdir(), "dsh-test-out-"));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, fileName);
  savedOutputs.push(file);
  return file;
}

/** 本次运行写出的所有产物文件（供脚本在结尾打印）。 */
export function savedOutFiles() {
  return [...savedOutputs];
}

/** 收集 `root` 下所有文件的相对路径（排序），用于「目录有没有被动过」的对比。 */
export function filesUnder(root, prefix = "") {
  const out = [];
  if (!fs.existsSync(root)) return out;
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, e.name);
    if (e.isDirectory()) out.push(...filesUnder(full, `${prefix}${e.name}/`));
    else out.push(`${prefix}${e.name}`);
  }
  return out.sort();
}

/** 取路径的 `mtimeMs`；不存在返回 `null`。 */
export function mtimeOf(p) {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * 把 `lib/` 下的源码复制进临时镜像目录，并把内部相对 import 的 `.js` 改成 `.mjs`。
 *
 * 为什么需要镜像：ESM 在**没有 package.json 的目录**里拒绝按 `.js` 加载模块，
 * 那是模块解析问题、不改语义 —— 但从镜像 import 才是「跑的是真源码」。
 * 所以复制完必须**逐字符校验**（改回 `.js` 后与源码完全相同），
 * 并核对改写次数 == 源码里相对 import 的条数（只比 sha256 会恒不等，那是假失败）。
 *
 * @param options - `{files, srcDir=srcDir, scratch}`。
 * @returns `{dir, identical, rewrites, specifiers, diff}`。
 */export function mirrorLib({ files, srcDir: src = srcDir, scratch }) {
  const mirror = path.join(scratch, "plugin");
  fs.mkdirSync(path.join(mirror, "lib"), { recursive: true });
  const backToJs = (t) => t.replace(/from "\.\/([a-z0-9-]+)\.mjs"/g, 'from "./$1.js"');
  const firstDiff = (a, b) => {
    const la = a.split("\n");
    const lb = b.split("\n");
    for (let i = 0; i < Math.max(la.length, lb.length); i += 1) {
      if (la[i] !== lb[i]) return { line: i + 1, src: la[i], mir: lb[i] };
    }
    return null;
  };

  let rewrites = 0;
  let specifiers = 0;
  for (const n of files) {
    const text = fs.readFileSync(path.join(src, n), "utf8");
    specifiers += [...text.matchAll(/from "\.\/[a-z0-9-]+\.js"/g)].length;
    const out = text.replace(/from "\.\/([a-z0-9-]+)\.js"/g, (_m, b) => {
      rewrites += 1;
      return `from "./${b}.mjs"`;
    });
    fs.writeFileSync(path.join(mirror, "lib", n.replace(/\.js$/, ".mjs")), out, "utf8");
  }

  let identical = true;
  let diff = null;
  for (const n of files) {
    const a = fs.readFileSync(path.join(src, n), "utf8");
    const b = fs.readFileSync(path.join(mirror, "lib", n.replace(/\.js$/, ".mjs")), "utf8");
    if (a !== backToJs(b)) {
      identical = false;
      diff = { n, d: firstDiff(a, backToJs(b)) };
    }
  }
  identical = identical && rewrites === specifiers;
  return { dir: mirror, identical, rewrites, specifiers, diff };
}

/**
 * 在一个独立的 vm 上下文里求值一段源码，并把里面 `require(spec)` 的解析交给 `makeRequire`。
 *
 * 为什么要自己造 `require`：插件的客户端 bundle 是 lazy-CJS（`__ModuleLoader__` 那种），
 * 它 `require("react")` 拿到的是**宿主提供的**那一份。要真跑它，就必须把解析表摆出来 ——
 * 而且这份解析表只有装得下真货才有意义。
 *
 * @param code - 源码文本。
 * @param makeRequire - `(spec) => module`。
 * @param filename - 出错信息里显示的文件名。
 * @returns 上下文里的 `module.exports`（源码没写 exports 时返回 `{}`）。
 */
export function evalBareFile(code, makeRequire, filename = "bundle.js") {
  const module = { exports: {} };
  const context = vm.createContext({
    module,
    exports: module.exports,
    require: (spec) => makeRequire(spec),
    console,
  });
  new vm.Script(code, { filename }).runInContext(context, { timeout: 20000 });
  return module.exports;
}

/**
 * 把一段独立函数源码求值出来（官方包里常有 `import ... .module.css`，
 * Node 不认那个扩展名 —— 那就把**它那一段函数源码**抠出来求值，
 * 逻辑仍然是官方那一份，只是绕开了进不来的 import）。
 *
 * @param source - 函数源码文本（形如 `function f(a) { ... }`）。
 * @param globals - 该函数用到的全局量。
 * @param filename - 出错信息里显示的文件名。
 * @returns 求值出来的函数。
 */
export function evalFunction(source, globals = {}, filename = "fn.js") {
  return vm.runInNewContext(`(${source})`, globals, { filename });
}
