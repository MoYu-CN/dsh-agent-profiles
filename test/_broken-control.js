// 对照组①：经典脚本形态的语法错误 —— 两种形态都必须解析失败。
// 期望：parse-check.mjs 对它输出 RESULT ... :: FAIL，退出码非 0。
// 若它也 OK，说明那份解析检查是空转的假证据。
function broken( {
  return 1;
}
broken();
