/**
 * 主题 token 审计：插件 CSS 里引用的**每一个** `--dsw-*` 都必须真实注册过。
 *
 * ## 为什么需要它
 * 0.2.1 出过一个「面板是透明的、字看不清」的问题。根因不是透明度写错，
 * 而是**token 名根本不存在**：我写了 `--dsw-alias-bg-base-secondary`，
 * 但这个部署的主题里没有这个名字 ⇒ 整条 `background` 声明被浏览器丢弃
 * ⇒ 背景透明 ⇒ 面板后面就是对话正文，字叠字看不清。
 *
 * 这类错误的可怕之处：**没有任何报错**。CSS 里写错一个变量名，
 * 浏览器只会安静地忽略那一行；组件照常渲染、测试照常通过，
 * 只有人眼看得出来。而人眼要等到某个具体场景（浮层压在有字的内容上）才会发现。
 *
 * ## 权威来源
 * 白名单来自 `cordis_inspect_query`（client / Theme / listTokens）——
 * 也就是**这个部署当前真正注册的** token 清单，不是我猜的。
 *
 * 用法：node test/theme-tokens.test.mjs
 */

import fs from "node:fs";
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

/** 主题注册表（来自 cordis_inspect_query: client / Theme / listTokens）。 */
const REGISTERED = new Set([
  "--dsw-alias-bg-base",
  "--dsw-alias-bg-document-preview",
  "--dsw-alias-bg-layer-1",
  "--dsw-alias-bg-layer-2",
  "--dsw-alias-bg-layer-3",
  "--dsw-alias-bg-module-platform",
  "--dsw-alias-bg-overlay",
  "--dsw-alias-border-l1",
  "--dsw-alias-border-l2",
  "--dsw-alias-brand-primary",
  "--dsw-alias-brand-primary-invert",
  "--dsw-alias-brand-text",
  "--dsw-alias-button-contrast-fill",
  "--dsw-alias-button-elevated-fill",
  "--dsw-alias-button-floating-fill",
  "--dsw-alias-button-floating-hover",
  "--dsw-alias-button-ghost-active-border",
  "--dsw-alias-button-ghost-active-fill",
  "--dsw-alias-button-ghost-active-hover",
  "--dsw-alias-button-info-fill",
  "--dsw-alias-button-info-hover",
  "--dsw-alias-button-primary-dimmed",
  "--dsw-alias-button-primary-hover",
  "--dsw-alias-interactive-bg-active",
  "--dsw-alias-interactive-bg-hover",
  "--dsw-alias-interactive-bg-hover-accent",
  "--dsw-alias-interactive-bg-hover-solid",
  "--dsw-alias-label-caption",
  "--dsw-alias-label-dimmed",
  "--dsw-alias-label-document-preview",
  "--dsw-alias-label-primary",
  "--dsw-alias-label-primary-bluish",
  "--dsw-alias-label-primary-dimmed",
  "--dsw-alias-label-primary-foreground",
  "--dsw-alias-label-primary-inverted",
  "--dsw-alias-label-secondary",
  "--dsw-alias-label-tertiary",
  "--dsw-alias-link",
  "--dsw-alias-markdown-citation",
  "--dsw-alias-markdown-code-block",
  "--dsw-alias-markdown-code-block-banner",
  "--dsw-alias-markdown-code-segment-selected",
  "--dsw-alias-markdown-code-segment-unselected",
  "--dsw-alias-markdown-inline-code",
  "--dsw-alias-markdown-placeholder",
  "--dsw-alias-markdown-tag",
  "--dsw-alias-scrollbar-bg-l1",
  "--dsw-alias-scrollbar-bg-l2",
  "--dsw-alias-scrollbar-hover-l1",
  "--dsw-alias-scrollbar-hover-l2",
  "--dsw-alias-state-business-primary",
  "--dsw-alias-state-business-tertiary",
  "--dsw-alias-state-error-primary",
  "--dsw-alias-state-idle-primary",
  "--dsw-alias-state-success-primary",
  "--dsw-alias-state-warn-primary",
  "--dsw-alias-toast-bg",
  "--dsw-alias-tooltip-bg",
  "--dsw-linear-gradient-think",
  "--dsw-linear-think-select",
  "--dsw-specific-bubble",
  "--dsw-specific-bubble-highlight",
  "--dsw-specific-input-major",
  "--dsw-specific-selector",
  "--dsw-specific-sidebar-fill",
  "--dsw-specific-sidebar-nav-item-active",
  "--dsw-specific-sidebar-nav-item-active-accent",
  "--dsw-specific-sidebar-nav-item-hover",
  "--dsw-specific-tip",
]);

// ⚠ 用 import.meta.url 定位，不用 path.resolve("lib/client.js") —— 后者看的是
//    **当前工作目录**，从别处跑（CI、任务调度器）就会 ENOENT。
const source = fs.readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

// ⚠ 必须剥掉注释再扫：事故说明里就写着那两个错误的名字，
//   拿它当「还在用」会得出假警报。（同一课：注释不是代码。）
const code = source
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^[ \t]*\/\/.*$/gm, "");

// ── ① 用到的每个 token 都必须注册过 ─────────────────────────
const used = new Set(code.match(/--dsw-[a-z0-9-]+/g) ?? []);
check("确实扫到了 token（防止正则失效导致空过）", used.size >= 5, `只扫到 ${used.size} 个`);

const unknown = [...used].filter((token) => REGISTERED.has(token) !== true);
check(
  "每个 --dsw-* token 都在主题注册表里",
  unknown.length === 0,
  unknown.length === 0 ? "" : `不存在的 token：${unknown.join(", ")}`,
);

// ── ② 明确禁止那两个害人的名字 ──────────────────────────────
for (const banned of ["--dsw-alias-bg-base-secondary", "--dsw-alias-bg-base-tertiary"]) {
  check(`不再使用不存在的 ${banned}`, code.includes(banned) !== true);
}

// ── ③ 浮层必须是不透明的两层叠加 ────────────────────────────
{
  const rule = /\.ap-pop \{[^}]*\}/.exec(source);
  check("找得到 .ap-pop 规则", rule !== null);
  const css = rule === null ? "" : rule[0];
  check("浮层有不透明的底色（bg-base）", css.includes("--dsw-alias-bg-base"), css);
  check("浮层叠了主题的浮层色（bg-overlay）", css.includes("--dsw-alias-bg-overlay"), css);
  check(
    "浮层用的是 background-color + background-image 两层（不是单个可能带 alpha 的 background）",
    css.includes("background-color:") && css.includes("background-image:"),
    css,
  );
  // 只写 background: <token> 是这次事故的形态，必须不再出现
  check("浮层没有退回单层 background 写法", /background:\s*var\(--dsw-alias-bg-overlay\)/.test(css) !== true, css);
}

// ── ④ 浮层的层级与定位仍然正确 ──────────────────────────────
{
  const rule = /\.ap-pop \{[^}]*\}/.exec(source)?.[0] ?? "";
  check("浮层有 z-index", rule.includes("z-index:"));
  check("浮层向上弹出（composer 在底部）", rule.includes("bottom: calc(100%"));
  check("浮层有阴影（和底图分离）", rule.includes("box-shadow"));
}

if (failures.length === 0) {
  console.log(`OK — ${passed} 项断言全部通过（用到 ${used.size} 个 token，全部已注册）`);
  process.exit(0);
}
console.log(`FAIL — ${passed} 项通过，${failures.length} 项失败：`);
for (const line of failures) console.log(`  ✗ ${line}`);
process.exit(1);
