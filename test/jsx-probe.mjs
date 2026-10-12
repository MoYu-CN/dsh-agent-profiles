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

const req = createRequire(path.join(resolveAppDir(), "index.js"));
const jsxRuntime = req("react/jsx-runtime");
const React = req("react");

const viaJsx = jsxRuntime.jsx(
  "div",
  { className: "x" },
  React.createElement("span", null, "A"),
  React.createElement("span", null, "B"),
);
console.log("jsx(type, props, child1, child2):");
console.log("  props.children =", JSON.stringify(viaJsx.props.children));
console.log("  key            =", JSON.stringify(viaJsx.key));

const viaCreate = React.createElement(
  "div",
  { className: "x" },
  React.createElement("span", null, "A"),
  React.createElement("span", null, "B"),
);
console.log("createElement(type, props, child1, child2):");
console.log("  children 长度 =", Array.isArray(viaCreate.props.children) ? viaCreate.props.children.length : 1);
console.log("  key           =", JSON.stringify(viaCreate.key));

try {
  jsxRuntime.jsx(jsxRuntime.Fragment, null, React.createElement("span", null, "A"));
  console.log("jsx(Fragment, null, child) → 没抛错");
} catch (error) {
  console.log("jsx(Fragment, null, child) → 抛错:", error.message);
}

try {
  const f = React.createElement(React.Fragment, null, React.createElement("span", null, "A"));
  console.log("createElement(Fragment, null, child) → ok, children 长度 =",
    Array.isArray(f.props.children) ? f.props.children.length : 1);
} catch (error) {
  console.log("createElement(Fragment, null, child) → 抛错:", error.message);
}
