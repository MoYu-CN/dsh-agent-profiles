/**
 * 会话日志诊断：把 .jsonl.zstd 解出来，检查某个提示词段落到底有没有被组装。
 *
 * 为什么需要它：本插件的注入能力**没有界面证据** ——
 * 能截图的是设置页，能打开的是 profiles.json，而
 * 「模型到底收没收到这段提示词」只能从会话记录里看。
 *
 * 用法：node test/inspect-session.mjs <session.jsonl.zstd> [关键词...]
 */

import fs from "node:fs";
import zlib from "node:zlib";
import { Readable } from "node:stream";

const file = process.argv[2];
const terms = process.argv.slice(3);
if (file === undefined) {
  console.log("用法：node test/inspect-session.mjs <session.jsonl.zstd> [关键词...]");
  process.exit(2);
}

/** 逐帧解压：会话日志是**多个 zstd 帧**拼接的，单次解压只能拿到第一帧。 */
function decodeAll(buffer) {
  const parts = [];
  let offset = 0;
  while (offset < buffer.length) {
    const slice = buffer.subarray(offset);
    let out;
    try {
      out = zlib.zstdDecompressSync(slice);
    } catch (error) {
      parts.push(`<<frame decode failed at ${offset}: ${error.code ?? error.message}>>`);
      break;
    }
    parts.push(out.toString("utf8"));
    // 重新压一遍来量出这一帧占了多少输入 —— zstd 的 sync API 不返回消耗长度。
    try {
      const recompressed = zlib.zstdCompressSync(out);
      // 压缩结果不会逐字节相同，所以退一步：按解压产物长度比例估不动，
      // 改为在输入里找下一帧的魔数（0x28 B5 2F FD）。
      const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
      const next = slice.indexOf(magic, 4);
      if (next <= 0) break;
      offset += next;
    } catch {
      break;
    }
  }
  return parts.join("");
}

const raw = fs.readFileSync(file);
const text = decodeAll(raw);

console.log(`文件：${file}`);
console.log(`原始 ${raw.length} 字节 → 解出 ${text.length} 字符`);
console.log(`行数：${text.split("\n").filter((l) => l.trim() !== "").length}`);

if (terms.length === 0) {
  const types = new Map();
  for (const line of text.split("\n")) {
    const match = /"type"\s*:\s*"([^"]+)"/.exec(line);
    if (match !== null) types.set(match[1], (types.get(match[1]) ?? 0) + 1);
  }
  console.log("\n事件类型：");
  for (const [name, count] of [...types.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${count.toString().padStart(5)}  ${name}`);
  }
} else {
  for (const term of terms) {
    // ⚠ 只数「出现几次」是不够的：插件源码本身会被 tool/call 事件记进日志
    //   （write 工具的参数就是文件内容）。所以必须**按事件类型分组** ——
    //   命中出现在 request/context、system/message 这类事件里，
    //   才说明它进了提示词；只出现在 tool/call 里，那只是我自己写的代码。
    const byType = new Map();
    let total = 0;
    const samples = [];
    for (const line of text.split("\n")) {
      if (line.includes(term) !== true) continue;
      const count = line.split(term).length - 1;
      total += count;
      const type = /"type"\s*:\s*"([^"]+)"/.exec(line);
      const name = type === null ? "(unknown)" : type[1];
      byType.set(name, (byType.get(name) ?? 0) + count);
      if (samples.length < 2) {
        const at = line.indexOf(term);
        samples.push(`${name}: …${line.slice(Math.max(0, at - 100), at + 140).replace(/\s+/g, " ")}…`);
      }
    }
    console.log(`\n「${term}」 → 总计 ${total} 处`);
    for (const [name, count] of [...byType.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${count.toString().padStart(4)}  ${name}`);
    }
    for (const sample of samples) console.log(`    · ${sample}`);
  }
}

// 上面若因多帧而解不动，退化用流式解压再试一次。
if (text.length === 0 && raw.length > 0) {
  try {
    const chunks = [];
    const stream = Readable.from(raw).pipe(zlib.createZstdDecompress());
    for await (const chunk of stream) chunks.push(chunk);
    console.log(`流式解压得到 ${Buffer.concat(chunks).length} 字节`);
  } catch (error) {
    console.log(`流式解压也失败：${error.code ?? error.message}`);
  }
}
