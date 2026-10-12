/**
 * 客户端渲染自测：把 lib/client.js **真的跑起来**，看设置页到底渲染出了什么。
 *
 * ## 为什么需要它
 * 「设置页空白」有几种在界面上长得一模一样的成因：
 *   (a) 组件渲染时抛错 —— 官方机制的后果是**整个插槽条目被清空**；
 *   (b) 组件正常返回，但树是空的（子元素被丢掉、条件分支走了空值）；
 *   (c) 组件卡在「读取中」。
 * 肉眼看不出区别，猜更不行。这个文件是当时定位 (b) 的工具，现在留着防回归。
 *
 * ## 怎么做到不装 React DOM
 * 本机 app 目录里有 react 18.3.1，但**没有 react-dom**，用不了 renderToStaticMarkup。
 * 这里接管 React 18 的 hook 派发器
 * （`__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher`）
 * 自己实现 useState/useEffect/useRef，并写了一个极简渲染器：
 * 函数组件过派发器、class 组件实例化后调 render、Fragment 展开、
 * 渲染期抛错走 getDerivedStateFromError。够用来判断「有没有东西、抛没抛错」。
 *
 * 用法：node test/client-render.test.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

/**
 * 官方 Host 程序目录（`<安装根>/resources/app`）—— 本测试从那里借真的 react。
 *
 * 解析顺序（**不写死本机路径**）：
 *   1. `DSH_APP_DIR` —— 直接给 `<安装根>/resources/app`（最明确）
 *   2. `DSH_INSTALL_DIR` —— 给 `<安装根>`，自动补 `resources/app`
 *   3. 由 `process.execPath` 反推（Electron 跑本文件时就是 DSH 主程序自身）
 *   4. 常见默认安装位置
 *
 * 四步都落空 → 打印一句说明并**以退出码 2 失败**（不静默跳过）。
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
  ]) {
    if (fs.existsSync(path.join(candidate, "index.js"))) return candidate;
  }

  for (const candidate of [
    "C:/Program Files/DSH Desktop/resources/app",
    "C:/Program Files (x86)/DSH Desktop/resources/app",
  ]) {
    if (fs.existsSync(path.join(candidate, "index.js"))) return candidate;
  }

  console.error(
    [
      "找不到官方 Host 程序目录（<安装根>/resources/app），本测试无法运行。",
      "请显式指定后重跑，例如：",
      '  $env:DSH_APP_DIR = "D:/Apps/DSH Desktop/resources/app"',
      "（或在 DSH 里跑：$env:ELECTRON_RUN_AS_NODE=1; & \"<安装根>/DSH Desktop.exe\" test/client-render.test.mjs）",
    ].join("\n"),
  );
  process.exit(2);
}

const APP_DIR = resolveAppDir();
const appRequire = createRequire(path.join(APP_DIR, "index.js"));
const React = appRequire("react");

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

// ── 浏览器环境替身 ──────────────────────────────────────────
globalThis.window = { __ModuleLoader__: null };
const styleEls = [];
globalThis.document = {
  getElementById: () => null,
  createElement: () => ({ id: "", textContent: "", remove() {} }),
  head: { appendChild: (el) => styleEls.push(el) },
  body: { appendChild() {}, removeChild() {} },
};

/** 当前场景要用的 fetch；每个场景自己设置。 */
let currentFetch = () => Promise.reject(new Error("fetch not stubbed"));
/**
 * 客户端诊断上报的记录。
 *
 * 为什么拦它：这条通道是我在**真实环境**里唯一的排查手段
 * （客户端 console 进不了宿主日志），所以它自己也得被测。
 */
let diagCalls = [];
/**
 * 真字典 + 当前语言。
 *
 * 为什么要收下来：原来 `locale.register` 是空实现、`bind` 直接 `return key`，
 * 于是所有断言看到的都是 `tt()` 的**中文兜底**（`fallbackOf` → DICT_ZH）——
 * 也就是说这套测试**从来没验过英文界面**。收下插件真正 register 的字典、
 * 再把 `bind` 接到它上面，中英文两条路才都能渲染出来验。
 * 默认仍是 `zh`，所以前面所有场景看到的文字与改造前**逐字相同**。
 */
const localeDicts = {};
let activeLocale = "zh";
globalThis.fetch = (...args) => {
  const url = String(args[0] ?? "");
  if (url.includes("/__ap/diag")) {
    try {
      diagCalls.push(JSON.parse(args[1].body));
    } catch {
      /* 记不下来就算了 */
    }
    return Promise.resolve({ json: () => Promise.resolve({ ok: true }) });
  }
  return currentFetch(...args);
};

// ── hook 派发器 ─────────────────────────────────────────────
const internals = React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;
const dispatcherSlot = internals.ReactCurrentDispatcher;

function createHookStore() {
  const cells = [];
  const effects = [];
  let index = 0;

  const dispatcher = {
    useState(initial) {
      const i = index++;
      if (!(i in cells)) cells[i] = typeof initial === "function" ? initial() : initial;
      return [
        cells[i],
        (value) => {
          cells[i] = typeof value === "function" ? value(cells[i]) : value;
        },
      ];
    },
    useRef(initial) {
      const i = index++;
      if (!(i in cells)) cells[i] = { current: initial };
      return cells[i];
    },
    useEffect(fn, deps) {
      const i = index++;
      const prev = effects[i];
      const changed =
        prev === undefined ||
        deps === undefined ||
        prev.deps === undefined ||
        deps.length !== prev.deps.length ||
        deps.some((d, k) => d !== prev.deps[k]);
      if (changed) {
        try {
          prev?.cleanup?.();
        } catch {
          /* 清理报错不影响渲染 */
        }
        const cleanup = fn();
        effects[i] = { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined, fn };
      }
    },
    useLayoutEffect(fn, deps) {
      this.useEffect(fn, deps);
    },
    useMemo(fn) {
      index += 1;
      return fn();
    },
    useCallback(fn) {
      index += 1;
      return fn;
    },
    useReducer(reducer, initial) {
      const i = index++;
      if (!(i in cells)) cells[i] = initial;
      return [cells[i], (action) => { cells[i] = reducer(cells[i], action); }];
    },
    useContext() {
      index += 1;
      return undefined;
    },
    useDebugValue() {},
    useDeferredValue(value) {
      index += 1;
      return value;
    },
    useTransition() {
      index += 1;
      return [false, (fn) => fn()];
    },
    useId() {
      index += 1;
      return ":r0:";
    },
    useSyncExternalStore(_subscribe, getSnapshot) {
      index += 1;
      return getSnapshot();
    },
    useInsertionEffect() {},
    useImperativeHandle() {},
  };

  return { begin() { index = 0; }, dispatcher };
}

const instanceStores = new WeakMap();
function callComponent(component, props) {
  let store = instanceStores.get(component);
  if (store === undefined) {
    store = createHookStore();
    instanceStores.set(component, store);
  }
  store.begin();
  dispatcherSlot.current = store.dispatcher;
  try {
    return { ok: true, tree: component(props) };
  } catch (error) {
    return { ok: false, error };
  } finally {
    dispatcherSlot.current = null;
  }
}

function isElement(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    value.props !== undefined &&
    // ⚠ React.Fragment 的 type 是 **Symbol**，只认 string|function 会把
    //   所有 <Fragment> 判成「不可渲染」，于是又得出「界面是空的」这个错误结论。
    (typeof value.type === "string" || typeof value.type === "function" || typeof value.type === "symbol")
  );
}
function isClassComponent(type) {
  return typeof type === "function" && type.prototype !== undefined && typeof type.prototype.render === "function";
}

/**
 * 极简渲染器。**必须递归**：槽位条目现在是「包装组件 → 错误边界 → 内容」三层，
 * 只看最外层会以为页面是空的 —— 那正是当初漏掉 bug 的原因。
 */
function walk(node, depth, acc) {
  if (node === null || node === undefined || typeof node === "boolean") return acc;
  if (typeof node === "string" || typeof node === "number") {
    const text = String(node);
    acc.textLength += text.length;
    // ⚠ **不要截断**：断言要在这个字符串上做 includes，
    //   截断会让「内容明明在、断言却说没有」——那是测试在骗自己。
    //   打印的时候另外用 .slice() 收窄。
    if (text.trim() !== "" && acc.lines.length < 20000) {
      acc.lines.push(`${"  ".repeat(depth)}"${text}"`);
    }
    return acc;
  }
  if (Array.isArray(node)) {
    for (const child of node) walk(child, depth, acc);
    return acc;
  }
  if (!isElement(node)) {
    acc.lines.push(`${"  ".repeat(depth)}?unrenderable:${typeof node}`);
    return acc;
  }

  const type = node.type;
  if (type === React.Fragment) {
    walk(node.props.children, depth, acc);
    return acc;
  }

  if (isClassComponent(type)) {
    const instance = new type(node.props);
    instance.props = node.props;
    if (instance.state === undefined) instance.state = {};
    // ⚠ try 必须连**子树的渲染**一起包住：React 里子组件的抛错是在
    //   父组件的协调过程中冒上来的，只包住 instance.render() 什么也接不到。
    const mark = acc.lines.length;
    try {
      const out = instance.render();
      walk(out, depth, acc);
    } catch (error) {
      const derived =
        typeof type.getDerivedStateFromError === "function" ? type.getDerivedStateFromError(error) : null;
      if (derived === null) throw error;
      acc.lines.length = mark; // 丢掉失败那一趟的半截输出
      instance.state = { ...instance.state, ...derived };
      acc.boundaryCaught = String(error && error.message);
      // 忠实模拟 React：边界捕获后也要调 componentDidCatch（我靠它把错误报给宿主日志）
      try {
        if (typeof instance.componentDidCatch === "function") {
          instance.componentDidCatch(error, { componentStack: "" });
        }
      } catch {
        /* 边界自己的上报失败不影响兜底渲染 */
      }
      walk(instance.render(), depth, acc);
    }
    return acc;
  }

  if (typeof type === "function") {
    const result = callComponent(type, node.props);
    if (result.ok !== true) throw result.error;
    walk(result.tree, depth, acc);
    return acc;
  }

  // ⚠ 打印**全部** class，不是只取第一个：
  //   只取第一个会让 `.ap-avatar-fallback`、`.ap-item-sel` 这类
  //   「靠第二个 class 表达状态」的元素在断言里永远看不见。
  const cls =
    node.props.className !== undefined
      ? "." + String(node.props.className).trim().split(/\s+/).join(".")
      : "";
  const extra = [];
  if (node.props.role !== undefined) extra.push(`role=${node.props.role}`);
  if (node.props["aria-checked"] !== undefined) extra.push(`aria-checked=${node.props["aria-checked"]}`);
  if (node.props.type !== undefined) extra.push(`type=${node.props.type}`);
  // ⚠ 把 value 也打出来：断言「编辑区里是哪套配置」只能看控件里的值。
  //   用「页面上出现过某段文字」去断言会被左栏的摘要文案骗到 ——
  //   左栏每一条都带角色设定摘要，于是任何角色文本都能在列表里命中。
  if (typeof node.props.value === "string" && node.props.value !== "") {
    extra.push(`value="${node.props.value.slice(0, 40)}"`);
  }
  // src 也打出来：断言「显示的是图片还是回落图标」只能看这个。
  if (typeof node.props.src === "string" && node.props.src !== "") {
    extra.push(`src="${node.props.src.slice(0, 34)}…"`);
  }
  acc.lines.push(`${"  ".repeat(depth)}<${type}${cls}${extra.length > 0 ? ` ${extra.join(" ")}` : ""}>`);
  acc.types.push(type);
  if (typeof acc.match === "function" && acc.match(node.props) === true) acc.matched.push(node.props);
  walk(node.props.children, depth + 1, acc);
  return acc;
}

function outline(node, match) {
  const acc = { lines: [], textLength: 0, types: [], boundaryCaught: null, matched: [], match };
  try {
    walk(node, 0, acc);
  } catch (error) {
    acc.threw = error;
  }
  acc.flat = acc.lines.join("\n");
  return acc;
}

/**
 * 渲染到满足条件为止（或超时）。
 *
 * 为什么不能只 sleep 一个固定时长：`refresh()` 是「fetch → json → setCache →
 * 通知订阅者 → 重渲染」的一条异步链，链上有几跳取决于实现，
 * 用固定 sleep 猜时机就是在测试里赌时序 —— 赌输了会得到
 * 「产品明明是好的、测试却说空白」这种最浪费时间的失败。
 */
async function renderUntil(component, predicate, timeoutMs = 1500, props = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = outline(callComponent(component, props).tree);
  while (!predicate(last) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    last = outline(callComponent(component, props).tree);
  }
  return last;
}

// ── 装载客户端模块（每个场景一份全新实例）────────────────────
let loadCount = 0;

/**
 * 每次都用带随机 query 的 import 拿一个**全新模块实例**：
 * 客户端把状态缓存在模块级变量里（一份缓存 + 订阅者集合），
 * 复用同一个实例会让第二个场景读到第一个场景的错误缓存 ——
 * 那验的就不是产品代码，而是测试自己的脏状态。
 */
/**
 * 假的「官方 turn-process 渲染器」。用它来验「顶替 = 包一层」这条路：
 * 我的组件必须把它**原样渲染出来**，而不是自己重写那一行。
 *
 * ⚠ 它**像真官方一样要求 `t`**：真组件第一句就是 `t("message.turnProcess.took")`，
 *   而 `t` 是宿主按注册选项里的 `locale` 注入进 props 的。少了它就会抛
 *   "t is not a function" —— 这正是线上那次「头像出现了、下面那行却坏了」的原因。
 *   假对象必须同样严格，否则测试抓不到这类回归。
 *   `officialShouldThrow` 另行模拟「官方渲染器抛错」。
 */
let officialShouldThrow = false;
function OfficialTurnProcess(props) {
  if (officialShouldThrow === true) throw new Error("官方渲染器炸了（模拟）");
  if (typeof props?.t !== "function") throw new Error("t is not a function");
  return React.createElement("div", { className: "official-turn-process" }, "已完成，用时 5m42s");
}

/**
 * 模拟宿主：**条目声明了 `locale` 才把 `t` 注入 props**。
 * 造 props 时走这个函数，才复现得了真实机制。
 */
function entryProps(reg, base) {
  if (reg?.locale === undefined) return Object.assign({}, base);
  return Object.assign({}, base, { t: (key) => `T:${key}` });
}

async function loadClient(options = {}) {
  const withOfficial = options.withOfficial !== false;
  officialShouldThrow = options.officialThrows === true;
  diagCalls = [];
  delete globalThis.__DSH_AGENT_PROFILES_REGISTERED__;
  styleEls.length = 0;
  let captured = null;
  globalThis.window = {
    __ModuleLoader__: {
      load(spec) {
        captured = spec;
      },
    },
  };
  loadCount += 1;
  const url = new URL("../lib/client.js", import.meta.url);
  url.searchParams.set("fresh", String(loadCount));
  await import(url.href);
  if (captured === null) throw new Error("客户端模块没有向 __ModuleLoader__ 注册");

  const mod = captured.factory((name) => appRequire(name));
  const registrations = [];
  const effects = [];
  const logs = [];
  /**
   * 假的槽位服务：既要能 register，也要能 `entries(key)` / `subscribe(key, fn)`
   * —— 后者是「取官方渲染器」和「等官方条目出现再接管」用的公开方法。
   */
  const officialEntry = {
    options: { key: "turn-process", priority: 0 },
    component: OfficialTurnProcess,
  };
  const subscribers = [];
  const slotsService = {
    entries(key) {
      if (key !== "conversation.chat.node") return [];
      return withOfficial ? [officialEntry] : [];
    },
    subscribe(key, fn) {
      subscribers.push({ key, fn });
      return () => {};
    },
  };
  if (options.withSubscribe === false) delete slotsService.subscribe;
  const ctx = {
    effect(fn) {
      effects.push(fn);
      const result = fn();
      return typeof result === "function" ? result : () => {};
    },
    get: (name) => (name === "slots" ? slotsService : undefined),
    logger: {
      error: (m) => logs.push(["error", String(m)]),
      warn: (m) => logs.push(["warn", String(m)]),
      info: (m) => logs.push(["info", String(m)]),
    },
    locale: {
      // ⚠ 本插件的注册姿势是**三参**：`register(NS, "zh", DICT_ZH)`（见 lib/client.js 的 apply）。
      //   写成 `(ns, dicts)` 会把语言名当成字典收下来，于是永远取不到词条、
      //   整页回落中文兜底 —— 那正是「英文渲染没人验过」能长期藏着的原因。
      register: (ns, lang, dicts) => {
        if (localeDicts[ns] === undefined) localeDicts[ns] = {};
        localeDicts[ns][lang] = dicts;
        return () => {};
      },
      bind: (ns) => (key) => {
        const d = localeDicts[ns];
        if (d === undefined) return key; // 没注册过就原样返回 key（与真 locale 服务同行为）
        const table = activeLocale === "en" ? d.en : d.zh;
        return table?.[key] ?? key;
      },
    },
    slots: {
      inject(_key, callback) {
        callback();
        return () => {};
      },
      register(options, component) {
        registrations.push({
          key: options.name,
          id: options.id,
          order: options.order,
          priority: options.priority,
          entryKey: options.key,
          locale: options.locale,
          component,
        });
        return () => {};
      },
      entries: (key) => slotsService.entries(key),
      subscribe: (key, fn) => slotsService.subscribe(key, fn),
    },
  };
  let applyError = null;
  try {
    mod.apply(ctx);
  } catch (error) {
    applyError = error;
  }
  return {
    mod,
    registrations,
    applyError,
    id: captured.id,
    inject: mod.inject,
    logs,
    effects,
    subscribers,
    diagCalls: () => diagCalls.slice(),
  };
}

// ── 场景 0：模块契约 + 幂等栅栏 ──────────────────────────────
const first = await loadClient();
eq("模块 id 等于包名", first.id, "dsh-agent-profiles");
eq("apply 不抛错", first.applyError, null, first.applyError === null ? "" : String(first.applyError));
eq("客户端 inject 声明 slots 与 locale", first.inject.join(","), "slots,locale");
eq("注册了 3 个槽位条目", first.registrations.length, 3);
eq("样式挂了一次", styleEls.length, 1);

// 用户看完实际效果后的决定：「回合尾的就不用了」——这里把它钉成断言，
// 免得以后有人「顺手」把回合尾那份加回来。
check(
  "不再注册回合贡献区（turnTail）",
  first.registrations.some((r) => r.key === "conversation.chat.turnTail") === false,
  JSON.stringify(first.registrations.map((r) => r.key)),
);

// 回合头：顶替 conversation.chat.node 的 turn-process 键（官方「已完成 …」那一行）
const headReg = first.registrations.find((r) => r.key === "conversation.chat.node");
check("接管了 conversation.chat.node", headReg !== undefined);
eq("接管的是 turn-process 这个键", headReg?.entryKey, "turn-process");
eq("用更小的 priority 顶替（官方是 0，更小者渲染）", headReg?.priority, -10);
// ⚠ 这条断言直接对应线上那次「头像出现、下面那行变错误提示」：
//   官方的 t 是宿主按 locale 注入的，不声明就拿不到 ⇒ 转发过去必炸。
eq("声明了官方那个 locale 命名空间（否则官方渲染器拿不到 t）", headReg?.locale, "chat");
check("接管时没有告警", first.logs.some(([level]) => level === "warn") === false, JSON.stringify(first.logs));

const settingsReg = first.registrations.find((r) => r.key === "settings.section");
const quickReg = first.registrations.find((r) => r.key === "conversation.input.left");
check("设置页注册在 settings.section（用 id 不是 key）", settingsReg !== undefined);
eq("设置页槽位 id", settingsReg?.id, "agent-profiles");
check("快速切换器注册在 conversation.input.left", quickReg !== undefined);

// 幂等栅栏：不清全局标记再 import 一次，不应重复注册
{
  let capturedAgain = null;
  globalThis.window = { __ModuleLoader__: { load(spec) { capturedAgain = spec; } } };
  const url = new URL("../lib/client.js", import.meta.url);
  url.searchParams.set("fresh", "again");
  await import(url.href);
  eq("重复注入不再注册（幂等栅栏生效）", capturedAgain, null);
}

// ── 场景 1：数据还没到（首帧）────────────────────────────────
{
  const client = await loadClient();
  currentFetch = () => new Promise(() => {}); // 永不落地
  const reg = client.registrations.find((r) => r.key === "settings.section");
  const quick = client.registrations.find((r) => r.key === "conversation.input.left");

  const page = outline(callComponent(reg.component, {}).tree);
  const failure = page.threw;
  check("设置页首帧不抛错", failure === undefined, String(failure?.stack ?? failure));
  check("设置页首帧没被错误边界兜住", page.boundaryCaught === null, String(page.boundaryCaught));
  check("设置页首帧不是空树", page.lines.length > 0, page.flat);
  check("设置页首帧有可见文字", page.textLength > 0, `文字长度 ${page.textLength}`);
  console.log("\n【设置页首帧】\n" + page.flat);

  const sw = outline(callComponent(quick.component, {}).tree);
  check("切换器首帧不抛错", sw.threw === undefined, String(sw.threw?.stack ?? sw.threw));
  check("切换器首帧不是空树", sw.lines.length > 0 && sw.textLength > 0, sw.flat);
  console.log("\n【切换器首帧】\n" + sw.flat);
}

// ── 场景 2：接口返回 3 套配置 ────────────────────────────────
const serverState = {
  version: 1,
  activeId: "p-1",
  profiles: [
    { id: "p-1", name: "通用助手", icon: "🤖", role: "", personality: "", speech: "", rules: "",
      memorySummary: "", injectMemory: true, memories: [], createdAt: 1, updatedAt: 1 },
    { id: "p-2", name: "编程助手", icon: "🧑‍💻", role: "你是资深工程师", personality: "严谨",
      speech: "先结论", rules: "不确定就说不确定", memorySummary: "", injectMemory: true,
      memories: [{ id: "m1", text: "用户用 TS", createdAt: 1 }], createdAt: 1, updatedAt: 1 },
    { id: "p-3", name: "写作教练", icon: "✍️", role: "你是写作教练", personality: "耐心",
      speech: "给改法", rules: "只改让改的部分", memorySummary: "写过一本书", injectMemory: false,
      memories: [], createdAt: 1, updatedAt: 1 },
  ],
};
const serverMeta = {
  dataDir: "C:/tmp", file: "C:/tmp/profiles.json", profileCount: 3, activeId: "p-1",
  activeName: "通用助手", memoryCount: 1, lastError: null, loadedFromDisk: true, promptChars: 128,
  diagnostics: { renders: 7, emptyRenders: 3, lastRenderAt: 1700000000000, lastChars: 0 },
};

{
  currentFetch = (url) => {
    if (String(url).includes("/__ap/state")) {
      return Promise.resolve({
        json: () => Promise.resolve({ ok: true, state: serverState, meta: serverMeta }),
      });
    }
    return Promise.reject(new Error(`unexpected fetch ${url}`));
  };

  const client = await loadClient();
  const reg = client.registrations.find((r) => r.key === "settings.section");
  const quick = client.registrations.find((r) => r.key === "conversation.input.left");

  callComponent(reg.component, {}); // 首帧 → effect 里发出 fetch
  callComponent(quick.component, {});

  // ⚠ 判定条件不能用「角色设定」这种词：左栏占位文案里就有
  //   「（未填角色设定）」，会在编辑器还没渲染出来时就误判为已完成。
  //   用编辑器最末尾那张卡片上的「注入统计」当锚点，它出现即整页就绪。
  const page = await renderUntil(reg.component, (acc) => acc.flat.includes("注入统计"));
  check("数据到达后不抛错", page.threw === undefined, String(page.threw?.stack ?? page.threw));
  check("数据到达后没被兜住", page.boundaryCaught === null, String(page.boundaryCaught));
  console.log("\n【数据到达后（截断 80 行）】\n" + page.lines.slice(0, 80).join("\n"));

  check("左栏列出 3 套配置",
    page.flat.includes("通用助手") && page.flat.includes("编程助手") && page.flat.includes("写作教练"),
    page.flat.slice(0, 300));
  check("右侧渲染了编辑表单", page.flat.includes("<textarea"), page.flat.slice(0, 300));
  check("有「角色设定」标签", page.flat.includes("角色设定"));
  check("有「性格特点」与说明", page.flat.includes("性格特点") && page.flat.includes("语气与态度倾向"));
  check("有「说话习惯」", page.flat.includes("说话习惯"));
  check("有「行为准则」", page.flat.includes("行为准则"));
  check("有「长期记忆摘要」", page.flat.includes("长期记忆摘要"));
  check("有记忆条目区", page.flat.includes("记忆条目"));
  check("有记忆注入开关", page.flat.includes("将记忆注入到每次会话"));
  check("注入开关是 role=switch 且带 aria-checked", page.flat.includes("role=switch") && page.flat.includes("aria-checked="), page.flat.slice(0, 400));
  check("有导入/导出/恢复默认", page.flat.includes("导入") && page.flat.includes("导出") && page.flat.includes("恢复默认"));
  check("有生成预览", page.flat.includes("生成预览"));
  check("有注入统计与说明", page.flat.includes("注入统计") && page.flat.includes("本对话段"), page.flat.slice(-800));
  check("统计里有会话专属设定计数", page.flat.includes("对话专属设定"), page.flat.slice(-800));
  check("显示了存储位置", page.flat.includes("C:/tmp/profiles.json"));
  check("当前配置显示为已启用", page.flat.includes("当前已启用"), page.flat.slice(0, 800));

  // ── 交互：点左栏另一套配置，编辑区要跟着换 ──
  // 静态断言只能证明「渲染出了东西」，证明不了「点了有用」。
  // 配置项上带了 title=名字，用它把元素捞出来直接触发 onClick。
  const item = outline(callComponent(reg.component, {}).tree, (p) => p.title === "编程助手").matched[0];
  check("能在左栏找到「编程助手」这一项", item !== undefined);
  if (item !== undefined) {
    check("该行带点击处理", typeof item.onClick === "function");
    item.onClick(); // 切到非当前配置
    // 判据必须精确到「编辑区里的值」：用「页面上有这段文字」会被左栏摘要骗到，
    // 于是在状态还没切换完时就误判为已完成，后面所有断言都测了个中间态。
    const page2 = await renderUntil(
      reg.component,
      (acc) => acc.flat.includes('value="你是资深工程师"') && acc.flat.includes("用户用 TS"),
    );
    check("切到非当前配置后按钮变为「设为当前配置」", page2.flat.includes("设为当前配置"), page2.flat.slice(0, 600));
    check(
      "编辑区装的是所选配置（角色设定控件里是「你是资深工程师」）",
      page2.flat.includes('value="你是资深工程师"'),
      page2.flat.slice(0, 600),
    );
    check("该配置的记忆条目也带出来了", page2.flat.includes("用户用 TS"), page2.flat.slice(0, 1200));
    check("切换后不再显示未保存徽标", !page2.flat.includes("有未保存改动"), page2.flat.slice(0, 400));
    check("编辑器仍然没被错误边界兜住", page2.boundaryCaught === null, String(page2.boundaryCaught));
  }

  const sw = await renderUntil(quick.component, (acc) => acc.flat.includes("通用助手"));
  check("切换器数据到达后不抛错", sw.threw === undefined, String(sw.threw?.stack ?? sw.threw));
  check("切换器渲染出 select", sw.flat.includes("<select"), sw.flat);
  check("切换器列出 3 套配置", sw.flat.includes("通用助手") && sw.flat.includes("编程助手"), sw.flat);
  console.log("\n【切换器（有数据）】\n" + sw.flat);
}

// ── 场景 3：接口失败 ────────────────────────────────────────
{
  currentFetch = () => Promise.reject(new Error("network down"));
  const client = await loadClient();
  const reg = client.registrations.find((r) => r.key === "settings.section");
  callComponent(reg.component, {});
  const page = await renderUntil(reg.component, (acc) => acc.flat.includes("读取配置失败"));
  check("失败时不抛错", page.threw === undefined, String(page.threw?.stack ?? page.threw));
  check("失败时没被兜住", page.boundaryCaught === null, String(page.boundaryCaught));
  check("失败时给出可见文字而不是空白", page.textLength > 0, page.flat);
  check("失败时写明了原因", page.flat.includes("network down") || page.flat.includes("读取配置失败"), page.flat);
  console.log("\n【接口失败时】\n" + page.flat);
}

// ── 场景 4：错误边界真的能兜住 ───────────────────────────────
{
  const client = await loadClient();
  const reg = client.registrations.find((r) => r.key === "settings.section");
  const boundaryType = reg.component({}).type;
  check("槽位条目外层套了错误边界",
    typeof boundaryType?.getDerivedStateFromError === "function", String(boundaryType));

  function Boom() {
    throw new Error("boom-for-test");
  }
  const caught = outline(React.createElement(boundaryType, null, React.createElement(Boom)));
  check("边界捕获了子组件抛错", caught.boundaryCaught === "boom-for-test", String(caught.boundaryCaught));
  check("兜底界面有可读文字（不是又一次空白）", caught.textLength > 0, `${caught.textLength} 字`);
  check("兜底界面给出了原因", caught.flat.includes("boom-for-test"), caught.flat.slice(0, 400));
  check("兜底界面说明配置没坏", caught.flat.includes("不是你的配置坏了"), caught.flat.slice(0, 400));
  console.log("\n【错误边界兜底】\n" + caught.lines.slice(0, 14).join("\n"));

  // 紧凑模式（输入框工具行用）只给一行
  const compact = outline(React.createElement(boundaryType, { compact: true }, React.createElement(Boom)));
  check("紧凑模式也兜住了", compact.boundaryCaught === "boom-for-test");
  check("紧凑模式只有一行文字", compact.lines.length <= 3, compact.flat);
}

// ── 场景 5：本对话控件 + 本对话设定的浮层面板 ───────────────
{
  const SESSION = "session-test-1";
  currentFetch = (url) => {
    if (String(url).includes("/__ap/state")) {
      return Promise.resolve({
        json: () =>
          Promise.resolve({
            ok: true,
            state: {
              ...serverState,
              sessions: {
                [SESSION]: {
                  profileId: "p-2",
                  note: "这次只讨论方案，先别改代码",
                  memories: [{ id: "sm1", text: "用户这次只要结论", createdAt: 1 }],
                  updatedAt: 1,
                },
              },
            },
            meta: { ...serverMeta, sessionCount: 1, sessionMemoryCount: 1 },
          }),
      });
    }
    return Promise.reject(new Error(`unexpected fetch ${url}`));
  };

  const client = await loadClient();
  const quick = client.registrations.find((r) => r.key === "conversation.input.left");
  const props = { sessionId: SESSION };

  const sw = await renderUntil(quick.component, (acc) => acc.flat.includes("跟随全局"), 1500, props);
  check("本对话控件不抛错", sw.threw === undefined, String(sw.threw?.stack ?? sw.threw));
  check("本对话控件没被兜住", sw.boundaryCaught === null, String(sw.boundaryCaught));
  check("下拉里有「跟随全局」这一项", sw.flat.includes("跟随全局"), sw.flat);
  check("下拉的值是本对话绑定的配置 p-2", sw.flat.includes('value="p-2"'), sw.flat);
  check("有绑定时按钮标出「本对话」", sw.flat.includes("本对话"), sw.flat);
  console.log("\n【本对话控件】\n" + sw.flat);

  // 打开面板（按钮上带 title，用它把元素捞出来直接点）
  const btn = outline(callComponent(quick.component, props).tree, (p) => p.title === "本对话的智能体设定")
    .matched[0];
  check("找得到打开面板的按钮", btn !== undefined, "按钮不存在");
  check("按钮带点击处理", typeof btn?.onClick === "function");
  btn.onClick();

  // 面板的草稿是在 effect 里初始化的：setState 之后 React 会再渲染一次。
  // 所以这里必须轮询到内容出现，而不是只看点击后的那一帧
  // （只看一帧会得到「读取中…」——那是中间态，不是缺陷）。
  const opened = await renderUntil(
    quick.component,
    (acc) => acc.flat.includes("本对话补充设定"),
    1500,
    props,
  );
  check("面板没抛错", opened.threw === undefined, String(opened.threw?.stack ?? opened.threw));
  check("面板没被兜住", opened.boundaryCaught === null, String(opened.boundaryCaught));
  check("面板渲染出「本对话的智能体」标题", opened.flat.includes("本对话的智能体"), opened.flat);
  check("面板有绑定状态说明", opened.flat.includes("本对话使用"), opened.flat);
  check("面板有补充设定输入框且带出已存内容",
    opened.flat.includes("本对话补充设定") && opened.flat.includes('value="这次只讨论方案，先别改代码"'), opened.flat);
  check("面板有专属记忆区且带出已存条目",
    opened.flat.includes("本对话专属记忆") && opened.flat.includes("用户这次只要结论"), opened.flat);
  check("面板有保存与清除按钮",
    opened.flat.includes("保存到本对话") && opened.flat.includes("清除本对话设定"), opened.flat);
  check("面板显示会话 id（便于排查）", opened.flat.includes(SESSION), opened.flat);
  console.log("\n【本对话面板】\n" + opened.lines.slice(0, 40).join("\n"));
}

// ── 场景 6：头像（设置里显示 / 未设回落 / 加载失败回落 / 助手消息条目）──
{
  const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
  const withAvatar = {
    ...serverState,
    profiles: serverState.profiles.map((p) => (p.id === "p-1" ? { ...p, avatar: PNG } : p)),
  };
  currentFetch = (url) => {
    if (String(url).includes("/__ap/state")) {
      return Promise.resolve({
        json: () => Promise.resolve({ ok: true, state: withAvatar, meta: serverMeta }),
      });
    }
    return Promise.reject(new Error(`unexpected fetch ${url}`));
  };

  const client = await loadClient();
  const page = client.registrations.find((r) => r.key === "settings.section");
  const rendered = await renderUntil(page.component, (acc) => acc.flat.includes("上传图片"));
  check("设置页渲染出上传按钮", rendered.flat.includes("上传图片"), rendered.flat.slice(0, 300));
  check("设了头像时渲染 <img>", rendered.flat.includes("ap-avatar") && rendered.flat.includes("src="), rendered.flat);
  check("设了头像时不显示回落图标", !rendered.flat.includes("ap-avatar-fallback"), rendered.flat.slice(0, 400));
  check("头像用 data URL 作为 src", rendered.flat.includes("data:image/png;base64"), rendered.flat.slice(0, 400));
  check("有移除头像按钮", rendered.flat.includes("移除头像"));
  check("写了头像说明（缩放到 512px / 回落规则）",
    rendered.flat.includes("512px") && rendered.flat.includes("破图"), rendered.flat.slice(0, 600));
  console.log("\n【头像（已设置）】\n" + rendered.flat.split("\n").filter((l) => l.includes("avatar") || l.includes("头像") || l.includes("上传")).join("\n"));

  // 加载失败 → 必须回落成 emoji 图标，而且不留破图
  const img = outline(callComponent(page.component, {}).tree, (p) => p.className === "ap-avatar").matched[0];
  check("找得到头像 <img> 元素", img !== undefined);
  check("头像 <img> 带 onError", typeof img?.onError === "function");
  img.onError();
  const afterError = outline(callComponent(page.component, {}).tree);
  check("加载失败后回落到 emoji 图标", afterError.flat.includes("ap-avatar-fallback"), afterError.flat.slice(0, 400));
  check("加载失败后不再渲染 <img>", !afterError.flat.includes("ap-avatar\" src"), afterError.flat.slice(0, 400));
  check("加载失败不算渲染错误（没被错误边界兜住）", afterError.boundaryCaught === null, String(afterError.boundaryCaught));
}

// ── 场景 7：没设头像 + 助手消息条目 ─────────────────────────
{
  const SESSION = "session-avatar-1";
  currentFetch = (url) => {
    if (String(url).includes("/__ap/state")) {
      return Promise.resolve({
        json: () =>
          Promise.resolve({
            ok: true,
            state: {
              ...serverState,
              sessions: {
                [SESSION]: { profileId: "p-2", note: "", memories: [], updatedAt: 1 },
              },
            },
            meta: serverMeta,
          }),
      });
    }
    return Promise.reject(new Error(`unexpected fetch ${url}`));
  };

  const client = await loadClient();
  const page = client.registrations.find((r) => r.key === "settings.section");
  const rendered = await renderUntil(page.component, (acc) => acc.flat.includes("上传图片"));
  check("没设头像时显示回落图标", rendered.flat.includes("ap-avatar-fallback"), rendered.flat.slice(0, 400));
  check("没设头像时不渲染 <img>", !rendered.flat.includes("src="), rendered.flat.slice(0, 400));
  check("回落显示的是该配置的 emoji", rendered.flat.includes("🤖"), rendered.flat.slice(0, 400));

  // ── 回合头：必须同时渲染「我的头像+名称」和「官方那一行」──
  const props = { sessionId: SESSION };
  const head = client.registrations.find((r) => r.key === "conversation.chat.node");
  check("回合头条目已注册", head !== undefined);
  // ⚠ 用 entryProps：模拟宿主按 locale 注入 t，否则官方渲染器会抛 "t is not a function"
  const headRendered = await renderUntil(
    head.component,
    (acc) => acc.flat.includes("已完成"),
    1500,
    entryProps(head, props),
  );
  check("回合头不抛错", headRendered.threw === undefined, String(headRendered.threw?.stack ?? headRendered.threw));
  check("回合头没被错误边界兜住", headRendered.boundaryCaught === null, String(headRendered.boundaryCaught));
  check("回合头渲染出「头像 + 名称」", headRendered.flat.includes("ap-turn-head") && headRendered.flat.includes("编程助手"), headRendered.flat);
  check("回合头带该配置的头像（未设时是图标）", headRendered.flat.includes("ap-avatar"), headRendered.flat);
  // 用户明确要求「头像放大到大约两倍」：22px → 44px，文字尺寸不变。
  // ⚠ 内联 style 不在 outline 的文本里（打印机不输出它）——必须直接取节点读 props，
  //   否则这条断言会因为「打印不出来」而假失败，或者更糟：假通过。
  const headAvatar = outline(callComponent(head.component, entryProps(head, props)).tree, (p) =>
    typeof p.className === "string" && p.className.includes("ap-avatar"),
  ).matched[0];
  eq("回合头头像宽度 44px（用户要求的两倍）", headAvatar?.style?.width, "44px");
  eq("回合头头像高度 44px", headAvatar?.style?.height, "44px");
  // ⚠ 这条是本设计的核心：官方那一行必须**原样**还在，而不是被我重写掉。
  check("官方「已完成 …」那一行原样保留", headRendered.flat.includes("official-turn-process") && headRendered.flat.includes("已完成，用时 5m42s"), headRendered.flat);
  check("我的头排在官方那一行**前面**", headRendered.flat.indexOf("ap-turn-head") < headRendered.flat.indexOf("official-turn-process"), headRendered.flat);
  console.log("\n【回合头（顶替 + 包一层官方）】\n" + headRendered.flat);

  // 没绑定的对话 → 回落全局当前配置（通用助手）
  const other = await renderUntil(head.component, (acc) => acc.flat.includes("通用助手"), 1500, entryProps(head, {
    sessionId: "session-other",
  }));
  check("未绑定的对话回落到全局当前配置", other.flat.includes("通用助手"), other.flat);
}

// ── 场景 8：能力探测 —— 取不到官方渲染器时**不许接管** ────────
{
  // 槽位服务里没有官方 turn-process 条目（例如 ui-chat 还没加载）
  const client = await loadClient({ withOfficial: false });
  const head = client.registrations.find((r) => r.key === "conversation.chat.node");
  check("取不到官方渲染器时不注册接管", head === undefined, JSON.stringify(client.registrations.map((r) => r.key)));
  // 这时候**不该告警**：还挂着订阅在等官方条目出现（加载顺序兜底），是正常状态。
  check(
    "挂上了等待官方条目的订阅（加载顺序兜底）",
    client.subscribers.some((s) => s.key === "conversation.chat.node"),
    JSON.stringify(client.subscribers),
  );
  check("没有误报告警", client.logs.some(([level]) => level === "warn") === false, JSON.stringify(client.logs));
  // 其余条目不受影响
  check("设置页照常注册", client.registrations.some((r) => r.key === "settings.section"));
  check("回合结尾不再注册（用户要求去掉）", client.registrations.some((r) => r.key === "conversation.chat.turnTail") === false);
}

// ── 场景 8b：连订阅都没有、又取不到官方渲染器 → 必须上报诊断 ──
{
  const client = await loadClient({ withOfficial: false, withSubscribe: false });
  const calls = client.diagCalls();
  check(
    "把「没找到官方渲染器」上报给宿主日志（我没法看页面，只能靠这条）",
    calls.some((c) => String(c.tag).includes("未找到官方渲染器")),
    JSON.stringify(calls),
  );
  check(
    "并且带上了「看到了什么」（entries 的长度与 key 列表）",
    calls.some((c) => String(c.tag).includes("未找到官方渲染器") && String(c.detail).includes("长度=")),
    JSON.stringify(calls),
  );
  check(
    "也上报了「没有订阅能力」",
    calls.some((c) => String(c.tag).includes("没有订阅能力")),
    JSON.stringify(calls),
  );
  check("依然不注册接管", client.registrations.some((r) => r.key === "conversation.chat.node") === false);
}

// ── 场景 8c：诊断通道本身（apply 走完必须报一笔）─────────────
{
  const client = await loadClient();
  check(
    "apply 走完会上报「apply/完成」",
    client.diagCalls().some((c) => c.tag === "apply/完成"),
    JSON.stringify(client.diagCalls()),
  );
  check(
    "接管成功会上报「已接管」",
    client.diagCalls().some((c) => String(c.tag).includes("已接管")),
    JSON.stringify(client.diagCalls()),
  );
  const head = client.registrations.find((r) => r.key === "conversation.chat.node");
  // ⚠ 必须等**徽标**出现，不能等官方那行 —— 官方那行是同步渲染的，
  //   而徽标要等状态拉回来（effectiveProfile 拿不到配置时返回 null）。
  await renderUntil(head.component, (acc) => acc.flat.includes("ap-turn-head"), 1500, entryProps(head, {
    sessionId: "s-diag",
  }));
  check(
    "徽标真渲染出来时会再报一笔（这是「接管生效」的直接证据）",
    client.diagCalls().some((c) => String(c.tag).includes("徽标已渲染")),
    JSON.stringify(client.diagCalls()),
  );
}

// ── 场景 8d：官方渲染器抛错时，边界必须抓住并上报 ─────────────
{
  const client = await loadClient({ officialThrows: true });
  const head = client.registrations.find((r) => r.key === "conversation.chat.node");
  // ⚠ 这里**故意按宿主的真实机制**给 props（走 entryProps ⇒ 带 t），
  //   再让官方渲染器抛错，验边界能不能抓住并上报。
  const rendered = await renderUntil(
    head.component,
    (acc) => acc.flat.includes("ap-turn-head"),
    1500,
    entryProps(head, { sessionId: "s-boom" }),
  );
  check("官方抛错时我的头像头仍然渲染", rendered.flat.includes("ap-turn-head"), rendered.flat);
  check(
    "边界捕获了官方的抛错（boundaryCaught）",
    String(rendered.boundaryCaught ?? "").includes("官方渲染器炸了"),
    String(rendered.boundaryCaught),
  );
  check(
    "并把错误上报到宿主日志（这是「渲染了但没提交」唯一能看到的证据）",
    client.diagCalls().some((c) => String(c.tag).includes("boundary/捕获") && String(c.detail).includes("官方渲染器炸了")),
    JSON.stringify(client.diagCalls()),
  );
}

// ── 场景 12：英文界面（界面文案跟宿主语言走）─────────────────
// 用户口径：「对模型来说中英文没区别，我要的是**用户在设置里看到的按钮文字
// 是他自己语言的文字**」⇒ 所以必须真的把英文渲染出来看，而不是只数字典里的键。
{
  // ⚠ 数据也用英文：这样「整页一个中文都没有」才能当硬断言用 ——
  //   任何中文都只可能来自**界面文案**（角色模板按钮、字段标签…）。
  const enState = {
    activeId: "p-1",
    profiles: [
      { id: "p-1", name: "General", icon: "🤖", role: "", personality: "", speech: "", rules: "",
        memorySummary: "", injectMemory: true, memories: [], createdAt: 1, updatedAt: 1 },
      { id: "p-2", name: "Engineer", icon: "🧑‍💻", role: "You are a senior engineer", personality: "Rigorous",
        speech: "Conclusion first", rules: "Say when you are unsure", memorySummary: "", injectMemory: true,
        memories: [{ id: "m1", text: "The user works in TS", createdAt: 1 }], createdAt: 1, updatedAt: 1 },
      { id: "p-3", name: "Coach", icon: "✍️", role: "You are a writing coach", personality: "Patient",
        speech: "Give the fix", rules: "Only change what was asked", memorySummary: "Wrote a book", injectMemory: false,
        memories: [], createdAt: 1, updatedAt: 1 },
    ],
  };
  const enMeta = {
    dataDir: "C:/tmp", file: "C:/tmp/profiles.json", profileCount: 3, activeId: "p-1",
    activeName: "General", memoryCount: 1, lastError: null, loadedFromDisk: true, promptChars: 128,
    diagnostics: { renders: 7, emptyRenders: 3, lastRenderAt: 1700000000000, lastChars: 0 },
  };
  activeLocale = "en";
  currentFetch = (url) => {
    if (String(url).includes("/__ap/state")) {
      return Promise.resolve({ json: () => Promise.resolve({ ok: true, state: enState, meta: enMeta }) });
    }
    return Promise.reject(new Error(`unexpected fetch ${url}`));
  };

  const client = await loadClient();
  const reg = client.registrations.find((r) => r.key === "settings.section");
  const page = await renderUntil(reg.component, (acc) => acc.flat.includes("Injection:"), 2500);
  console.log("\n【英文界面（截断 60 行）】\n" + page.lines.slice(0, 60).join("\n"));

  check("英文界面没被错误边界兜住", page.boundaryCaught === null, String(page.boundaryCaught));
  check("英文页整页**一个中文都没有**", !/[\u4e00-\u9fff]/u.test(page.flat), page.flat.slice(0, 500));
  check("英文页有英文的注入统计行", page.flat.includes("Injection:"), page.flat.slice(0, 500));

  // 6 个角色模板按钮：改造前是硬编码中文（label / role 都写死在 ROLE_TEMPLATES 里）。
  const CHIPS = ["Engineering", "Writing coach", "Translation", "Product manager", "Data analysis", "Study partner"];
  const chipLabels = outline(callComponent(reg.component, {}).tree, (p) => p.className === "ap-chip").matched.map(
    (p) => p.children,
  );
  console.log(`   模板按钮实际文字：${JSON.stringify(chipLabels)}`);
  check(
    `6 个模板按钮全是英文（${CHIPS.join(" / ")}）`,
    JSON.stringify(chipLabels) === JSON.stringify(CHIPS),
    JSON.stringify(chipLabels),
  );
  check("模板按钮里没有中文", !chipLabels.some((l) => /[\u4e00-\u9fff]/u.test(String(l))), JSON.stringify(chipLabels));

  // 点一个模板：填进「角色设定」的正文也必须是英文。
  const engineer = outline(
    callComponent(reg.component, {}).tree,
    (p) => p.className === "ap-chip" && p.children === "Engineering",
  ).matched[0];
  check("能捞到 Engineering 这个模板按钮", engineer !== undefined);
  if (engineer !== undefined) {
    check("该模板按钮带点击处理", typeof engineer.onClick === "function");
    engineer.onClick();
    const after = await renderUntil(reg.component, (acc) => acc.flat.includes("You are a senior software engineer"), 1500);
    check(
      "点模板后「角色设定」里填的是英文正文",
      after.flat.includes('value="You are a senior software engineer'),
      after.flat.slice(-900),
    );
  }

  // 渲染失败时的紧凑提示：`boundary.compactTitle` 曾经是英文字典里唯一缺的键，
  // 缺了就会漏出中文兜底（审计报告第 1 层「唯一的真缺口」）。
  const Boom2 = function Boom2() {
    throw new Error("boom-for-i18n");
  };
  const boundaryType = reg.component({}).type;
  const compactMatch = outline(
    React.createElement(boundaryType, { compact: true }, React.createElement(Boom2)),
    (p) => typeof p.title === "string" && p.title.includes("plugin defect"),
  ).matched;
  check("紧凑错误提示用的是英文词条（boundary.compactTitle 不再回落中文）", compactMatch.length === 1, JSON.stringify(compactMatch.map((p) => p.title)));
  const compactAny = outline(
    React.createElement(boundaryType, { compact: true }, React.createElement(Boom2)),
    (p) => typeof p.title === "string",
  ).matched;
  check(
    "紧凑错误提示里没有中文",
    compactAny.length > 0 && compactAny.every((p) => !/[\u4e00-\u9fff]/u.test(p.title)),
    JSON.stringify(compactAny.map((p) => p.title)),
  );
  activeLocale = "zh";
}

// ── 结果 ────────────────────────────────────────────────────
if (failures.length === 0) {
  console.log(`\nOK — ${passed} 项断言全部通过`);
  process.exit(0);
}
console.log(`\nFAIL — ${passed} 项通过，${failures.length} 项失败：`);
for (const line of failures) console.log(`  ✗ ${line}`);
process.exit(1);
