/**
 * dsh-agent-profiles —— 模块⑤：Host HTTP API。
 *
 * ## 为什么走 webServer 路由，而不是官方 Remote/typert
 * 官方 Remote（`@Remote` 装饰器 + typert 代码生成）需要**编译期生成 schema**，
 * 那是给 TS 源码随包发布的正式插件用的。本插件是**纯 JS 的本地 bundle**，
 * 没有构建步骤，用不了那条链。`webServer.register` 是宿主明确开放给
 * 这类插件的浏览器载体（本机另外两个已装插件也走它），且不引入任何依赖。
 *
 * ## 为什么每个响应都回整份 state
 * 因为**界面只有一份真相**：Host 磁盘上的状态。让客户端自己合并增量
 * （「这次返回的是新建的那条，我把它 push 进本地列表」）在并发写、
 * 校验截断、id 去重这些情况下会算错，而算错的界面比慢一点的界面糟得多。
 * 状态很小（几十套配置几 KB），整份回传是划算的。
 *
 * ## 安全边界
 * 这些路由挂在**本机回环**的 Web 服务上，同源守卫挡的是
 * 「别的网页/跨站请求驱动本机插件」这一类。规则是
 * **硬证据只用于否决，不用于放行**（见 passSameOrigin）。
 */

import fs from "node:fs";
import path from "node:path";
import { LIMITS, memoryChars } from "./store.js";

/** 客户端 bundle 的发布路径。 */
export const CLIENT_SCRIPT_PATH = "/__ap/client.js";

/** tapIndex 注入标记（用于幂等判定）。 */
const SCRIPT_MARKER = "data-agent-profiles-bridge";

/** JSON 请求体上限。导入整份配置可能不小，给到 512KB。 */
const BODY_LIMIT = 512 * 1024;

/**
 * 取 `host`（含端口）。兼容带/不带协议前缀的写法。
 * @param {string} value 原始值。
 * @returns {string|null} 主机名，解析失败返 null。
 */
function hostOf(value) {
  if (typeof value !== "string" || value === "") return null;
  try {
    return new URL(value.includes("://") ? value : `http://${value}`).host;
  } catch {
    return null;
  }
}

/**
 * 同源守卫。
 *
 * ⚠ **语义经过一次修正，别改回去**：`<script src>` 发起的同源 GET
 *   **不带 Origin**（只有 CORS / 表单 / SSE 才带）。所以「只看 Origin」
 *   会让脚本请求恒 403 ⇒ 整个界面空白 —— 正是最该避免的失败形态。
 *
 * 现行规则：**硬证据只用于否决，不用于放行**
 *   1. `Sec-Fetch-Site: cross-site` → 拒
 *   2. 有 `Origin` → 必须与 Host 一致
 *   3. 有 `Referer` → 必须与 Host 一致
 *   4. 都没有 → 放行（非浏览器上下文，例如 curl 探活）
 *
 * @param {object} req 请求。
 * @param {object} res 响应。
 * @returns {boolean} 是否放行。
 */
function passSameOrigin(req, res) {
  const host = hostOf(req.headers?.host);
  const site = req.headers?.["sec-fetch-site"];
  if (site === "cross-site") {
    res.writeHead(403).end();
    return false;
  }
  for (const header of ["origin", "referer"]) {
    const value = req.headers?.[header];
    if (typeof value !== "string" || value === "") continue;
    const valueHost = hostOf(value);
    if (host === null || valueHost === null || valueHost !== host) {
      res.writeHead(403).end();
      return false;
    }
  }
  return true;
}

/**
 * 读 JSON 请求体。
 *
 * ⚠ 要求 `req` **异步可迭代**（Node 原生 IncomingMessage 满足）。
 *   自造 mock 若只用 `on("data")` 就喂不进来 ⇒ 所有 POST 恒 400。
 *
 * @param {object} req 请求。
 * @returns {Promise<{ok: boolean, status?: number, value?: object, error?: string}>}
 */
async function readJsonBody(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    // ⚠ 这三条错误经 `setNotice(body.error)` **原样进界面**，所以是英文：
    //   host 半拿不到界面语言（`ctx.locale` 是客户端服务，宿主侧没有对应服务），
    //   拼不出「按用户语言」的文案；这里也不该塞中文 —— 英文是两边都能看懂的
    //   最小公倍数。文案面向「请求本身不合法」，不是给用户读的操作引导。
    if (body.length > BODY_LIMIT) {
      return { ok: false, status: 413, error: "Request body is too large." };
    }
  }
  if (body.trim() === "") return { ok: true, value: {} };
  let value;
  try {
    value = JSON.parse(body);
  } catch {
    return { ok: false, status: 400, error: "Request body is not valid JSON." };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, status: 400, error: "Request body must be a JSON object." };
  }
  return { ok: true, value };
}

/** 发 JSON 响应。 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

/**
 * 组装 GET /__ap/state 的响应。
 *
 * 单个函数而不是散在路由里：设置页和快速切换器都要这份数据，
 * 两处形状必须一致，否则会出现「一个地方能切换、另一个地方显示旧名字」。
 *
 * @param {object} store ProfileStore。
 * @param {object} ctxInfo `{dataDir, diagnostics, renderPreview}`。
 * @returns {object}
 */
function statePayload(store, ctxInfo) {
  const state = store.snapshot();
  const active = state.profiles.find((p) => p.id === state.activeId);
  return {
    ok: true,
    state,
    meta: {
      ...store.describe(),
      promptChars: typeof active === "undefined" ? 0 : ctxInfo.renderPreview(active).length,
      // 长期记忆的预算上限。**由宿主给，不在客户端写死** ——
      // 写死两份迟早会漂移，那时界面会说「没满」而后台已经在压缩。
      memoryLimit: LIMITS.memoryTotal,
      // 诊断：提示词提供函数被调用了几次。
      // 它是「注入真的在跑」的**唯一**可观测证据（见 README 的验证一节）。
      diagnostics: { ...ctxInfo.diagnostics },
    },
  };
}

/**
 * 注册全部路由与 index.html 注入。
 *
 * @param {object} ctx Cordis 上下文。
 * @param {object} deps `{store, here, prepare, renderPreview}`。
 * @returns {Array<Function>} 清理函数列表。
 */
export function installRoutes(ctx, deps) {
  const { store, here, prepare, renderPreview } = deps;
  const disposers = [];

  const info = { dataDir: store.dataDir, diagnostics: deps.diagnostics, renderPreview };

  // ── 客户端 bundle ──────────────────────────────────────────
  //
  // 两套加载机制并存（`dsh.client` 声明 + 这里的手动路由）是**刻意的冗余**：
  // 官方 clientModules 扫描需要包被正确登记，而手动路由只依赖 webServer。
  // 客户端脚本自带全局幂等栅栏，被加载两次不会重复注册。
  disposers.push(
    ctx.webServer.register({
      kind: "exact",
      path: CLIENT_SCRIPT_PATH,
      handler: (req, res) => {
        if (!passSameOrigin(req, res)) return;
        try {
          const text = fs.readFileSync(path.join(here, "client.js"), "utf8");
          res.writeHead(200, {
            "content-type": "text/javascript; charset=utf-8",
            "cache-control": "no-store",
          });
          res.end(text);
        } catch (error) {
          res.writeHead(500).end(`/* client bundle unavailable: ${error?.code ?? "ERR"} */`);
        }
      },
    }),
  );

  // ── 读状态 ────────────────────────────────────────────────
  disposers.push(
    ctx.webServer.register({
      kind: "exact",
      path: "/__ap/state",
      handler: (req, res) => {
        if (!passSameOrigin(req, res)) return;
        if (req.method !== "GET") {
          res.writeHead(405).end();
          return;
        }
        sendJson(res, 200, statePayload(store, info));
      },
    }),
  );

  // ── 客户端诊断（只写宿主机日志）────────────────────────────
  //
  // 为什么需要它：客户端半跑在浏览器里，它的 `console.warn` **进不了宿主日志**，
  // 而我看不到页面 —— 于是「插槽注册没成功」这类问题**两边都不可见**，只能靠猜。
  // 这条路由让客户端把关键节点的事实交给宿主记一笔，我读日志即可。
  //
  // 客户端那边做了去重，只在状态**变化**时上报，不会刷屏。
  disposers.push(
    ctx.webServer.register({
      kind: "exact",
      path: "/__ap/diag",
      handler: async (req, res) => {
        if (!passSameOrigin(req, res)) return;
        if (req.method !== "POST") {
          res.writeHead(405).end();
          return;
        }
        const parsed = await readJsonBody(req);
        if (parsed.ok !== true) {
          sendJson(res, parsed.status, { ok: false });
          return;
        }
        const tag = String(parsed.value?.tag ?? "").slice(0, 60);
        const detail = String(parsed.value?.detail ?? "").slice(0, 400);
        ctx.logger?.info?.(`[dsh-agent-profiles][client] ${tag}${detail === "" ? "" : " — " + detail}`);
        sendJson(res, 200, { ok: true });
      },
    }),
  );

  // ── 变更（所有写操作唯一入口）──────────────────────────────
  disposers.push(
    ctx.webServer.register({
      kind: "exact",
      path: "/__ap/command",
      handler: async (req, res) => {
        if (!passSameOrigin(req, res)) return;
        if (req.method !== "POST") {
          res.writeHead(405).end();
          return;
        }
        const parsed = await readJsonBody(req);
        if (parsed.ok !== true) {
          sendJson(res, parsed.status, { ok: false, error: parsed.error });
          return;
        }
        const result = await store.command(parsed.value);
        if (result.ok !== true) {
          // 400：这是**用户的输入不合法**（名字超长、删最后一套…），
          // 不是服务器故障。界面据此把提示显示成「操作没做成」而不是「插件坏了」。
          sendJson(res, 400, { ok: false, error: result.error });
          return;
        }
        sendJson(res, 200, {
          ok: true,
          notice: result.notice ?? "",
          ...statePayload(store, info),
        });
      },
    }),
  );

  // ── 预览：渲染**草稿**（未保存的编辑内容）────────────────────
  //
  // 为什么要有它：用户改完「行为准则」想先看看注入长什么样，
  // 若只能预览已保存版本，他就得先保存再看 —— 而保存是破坏性的
  // （覆盖当前生效内容）。渲染逻辑只有 Host 一份，客户端不重复实现。
  disposers.push(
    ctx.webServer.register({
      kind: "exact",
      path: "/__ap/preview",
      handler: async (req, res) => {
        if (!passSameOrigin(req, res)) return;
        if (req.method !== "POST") {
          res.writeHead(405).end();
          return;
        }
        const parsed = await readJsonBody(req);
        if (parsed.ok !== true) {
          sendJson(res, parsed.status, { ok: false, error: parsed.error });
          return;
        }
        const text = prepare(parsed.value?.profile);
        sendJson(res, 200, { ok: true, text, chars: text.length });
      },
    }),
  );

  // ── 导出 ──────────────────────────────────────────────────
  disposers.push(
    ctx.webServer.register({
      kind: "exact",
      path: "/__ap/export",
      handler: (req, res) => {
        if (!passSameOrigin(req, res)) return;
        if (req.method !== "GET") {
          res.writeHead(405).end();
          return;
        }
        sendJson(res, 200, deps.exportEnvelope());
      },
    }),
  );

  // ── 注入客户端脚本 ────────────────────────────────────────
  //
  // ⚠⚠ `tapIndex` 收的是**变换函数**，不是字符串。
  //   传字符串会让 `transform is not a function` ⇒ 整个 index.html 渲染失败
  //   ⇒ 桌面端拿不到认证端点，报 `browser authentication failed`，
  //   而插件日志里一行错都没有。这是本机另一个插件踩过的坑。
  //
  // ⚠ 幂等也必须自己保证：DSH 每次渲染 index 都会重跑所有 tap。
  //   注入两次本身不致命（客户端有栅栏），但会让「谁加载的」无法排查。
  disposers.push(
    ctx.webServer.tapIndex((html) => {
      if (typeof html !== "string" || html.includes(SCRIPT_MARKER)) return html;
      const script = `<script defer src="${CLIENT_SCRIPT_PATH}" ${SCRIPT_MARKER}></script>`;
      return html.includes("</body>") ? html.replace("</body>", `${script}</body>`) : `${html}${script}`;
    }),
  );

  return disposers;
}
