/**
 * ESM cache-busting import.
 * 每次调用都用唯一 timestamp query 绕过 Node.js 的模块缓存。
 * Windows 上必须先转为 file:// URL，否则 `C:\` 会被当作 protocol。
 * @param {string} filePath 绝对路径
 * @returns {Promise<any>} module namespace
 */
import { pathToFileURL } from "node:url";

let _counter = 0;
export async function freshImport(filePath) {
  const url = pathToFileURL(filePath);
  url.searchParams.set("t", `${Date.now()}-${_counter++}`);
  // NOTE: 必须把 url.href 先取到局部变量再 import()。直接写 `import(url.href)`
  // （成员表达式做动态 import 参数）会在 Windows + CRLF 行尾下触发 Vite/vitest
  // ESM import 扫描器的字节偏移敏感 bug，导致 vitest 转换该模块时无输出挂死，
  // 连带 plugin-manager / engine 的整条导入链上的测试全部卡死。
  // `import(标识符)` 走的是另一条代码路径，实测不触发。
  const href = url.href;
  return import(href);
}
