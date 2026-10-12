/**
 * parse-check.mjs —— 真解析校验（带**故意写坏的对照组**）。
 *
 * ## 为什么不用 `node --check`
 * 那是「成功时无输出」的工具：坏文件会报 SyntaxError，好文件一声不吭。
 * 于是「没输出」既可能是「确实干净」，也可能是「命令根本没跑起来」——
 * 两者外观一模一样。所以这里必须：
 *   1. 每次都打印 `PARSE OK / PARSE FAIL`，绝不静默；
 *   2. 同一轮里跑**故意写坏**的对照文件，它必须 FAIL（否则这趟结论无效）；
 *   3. 两种形态（经典脚本 + ESM）各解析一遍，并如实报告哪种可用。
 *
 * ## 用法
 *   node test/parse-check.mjs                     # 扫 lib/ 下的 .js + 本目录的对照组
 *   node test/parse-check.mjs <文件|目录> [...]    # 只查指定目标
 *
 * ## 退出码
 *   0  每个非对照目标都至少一种形态解析通过，且每个对照目标都失败
 *   1  有目标两种形态都失败，或有对照目标竟然通过了（判据空转）
 *   2  用法错 / 什么都没查到（**拒绝在「什么都没查」时报通过**）
 *
 * `vm.SourceTextModule` 需要 `--experimental-vm-modules`；拿不到时如实打印
 * `PARSE SKIP [module]`，并只凭经典脚本形态下结论 —— 不假装校验过 ESM。
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { here, printSkip, srcDir } from "./_harness.mjs";

const CONTROL = /^_broken-.*\.(js|mjs|cjs)$/u;

/** 收集目录下的 .js（不递归 node_modules / .git）。 */
function collectJs(root) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const full = path.join(root, e.name);
    if (e.isDirectory()) out.push(...collectJs(full));
    else if (/\.(js|mjs|cjs)$/u.test(e.name)) out.push(full);
  }
  return out.sort();
}

const args = process.argv.slice(2);
let targets;
if (args.length > 0) {
  targets = [];
  for (const a of args) {
    const full = path.resolve(a);
    if (!fs.existsSync(full)) {
      console.log(`READ FAIL ${full} :: 路径不存在`);
      process.exit(2);
    }
    if (fs.statSync(full).isDirectory()) targets.push(...collectJs(full));
    else targets.push(full);
  }
} else {
  targets = [...collectJs(srcDir), ...collectJs(here).filter((f) => CONTROL.test(path.basename(f)))];
}

if (targets.length === 0) {
  console.log("NOTHING TO CHECK —— 一个文件都没扫到，拒绝报「干净」（退出码 2）");
  process.exit(2);
}

if (typeof vm.SourceTextModule !== "function") {
  printSkip("vm.SourceTextModule 不可用 → ESM 形态这一栏没查（要查就加 NODE_OPTIONS=--experimental-vm-modules）");
}

const results = [];
for (const file of targets) {
  const isControl = CONTROL.test(path.basename(file));
  let src = "";
  try {
    src = fs.readFileSync(file, "utf8");
  } catch (error) {
    console.log(`READ FAIL ${file} :: ${error?.message ?? error}`);
    results.push({ file, isControl, ok: false, scriptOk: false, moduleOk: false, skippedModule: true });
    continue;
  }

  const probe = (label, make) => {
    try {
      make();
      console.log(`PARSE OK   [${label}] ${file}`);
      return true;
    } catch (error) {
      console.log(`PARSE FAIL [${label}] ${file} :: ${error?.message ?? String(error)}`);
      return false;
    }
  };

  const scriptOk = probe("script", () => new vm.Script(src, { filename: file }));
  let moduleOk = false;
  let skippedModule = false;
  if (typeof vm.SourceTextModule === "function") {
    moduleOk = probe("module", () => new vm.SourceTextModule(src, { identifier: file }));
  } else {
    skippedModule = true;
  }

  const ok = scriptOk || moduleOk;
  console.log(`RESULT ${isControl ? "[对照组] " : ""}${file} :: ${ok ? "OK" : "FAIL"} (script=${scriptOk} module=${moduleOk})`);
  results.push({ file, isControl, ok, scriptOk, moduleOk, skippedModule });
}

const controls = results.filter((r) => r.isControl);
const real = results.filter((r) => !r.isControl);
const badReal = real.filter((r) => !r.ok);
const badControls = controls.filter((r) => r.ok);

console.log("");
console.log(`扫过 ${results.length} 个文件：目标 ${real.length}（解析失败 ${badReal.length}）、对照组 ${controls.length}（竟然通过 ${badControls.length}）`);
console.log(`前 3 个真实扫到的路径（存活证明）：`);
for (const r of real.slice(0, 3)) console.log(`   ${r.file}`);

let exitCode = 0;
if (badReal.length > 0) {
  console.log(`★ 有目标解析失败：`);
  for (const r of badReal) console.log(`   ${r.file}`);
  exitCode = 1;
}
if (controls.length === 0) {
  console.log(`★ 一个对照组都没有 —— 「解析检查会失败」这件事没有被证明，拒绝报通过`);
  exitCode = 2;
} else if (badControls.length > 0) {
  console.log(`★ 对照组竟然解析通过了，说明判据是空转的：`);
  for (const r of badControls) console.log(`   ${r.file}`);
  exitCode = 1;
} else {
  console.log(`对照组全部 FAIL（${controls.length} 个）—— 这个检查不是空转。`);
}
if (real.length === 0) {
  console.log(`★ 没扫到任何非对照目标 —— 「什么都没查」不算通过`);
  exitCode = 2;
}

console.log(`RESULT-ALL :: ${exitCode === 0 ? "OK" : "FAIL"}`);
process.exit(exitCode);
