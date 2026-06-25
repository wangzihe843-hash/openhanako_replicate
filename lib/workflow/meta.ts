import vm from "node:vm";

const META_EVAL_TIMEOUT_MS = 500;

/**
 * 静态提取并校验 workflow 脚本开头的 `export const meta = {...}` 字面量，
 * 返回 meta 对象与剥离 export 后可在 async function 里执行的 body。
 * meta 必须是纯对象字面量（spec 约束：无变量 / 函数调用 / 模板插值）。
 * @param {string} script
 * @returns {{ meta: { name: string, description: string, phases?: any[] }, body: string }}
 */
export function extractMeta(script) {
  if (typeof script !== "string" || !script.trim()) {
    throw new Error("workflow script 不能为空");
  }
  const marker = /export\s+const\s+meta\s*=/.exec(script);
  if (!marker) {
    throw new Error("workflow script 必须以 export const meta = {...} 开头");
  }
  const braceStart = script.indexOf("{", marker.index + marker[0].length);
  if (braceStart === -1) throw new Error("workflow meta 必须是对象字面量");
  const braceEnd = matchBrace(script, braceStart);
  if (braceEnd === -1) throw new Error("workflow meta 对象字面量未闭合");

  const literal = script.slice(braceStart, braceEnd + 1);
  let meta;
  try {
    // 在纯净 context 求值字面量：不暴露任何宿主能力。
    meta = vm.runInNewContext("(" + literal + ")", Object.create(null), { timeout: META_EVAL_TIMEOUT_MS });
  } catch (err) {
    throw new Error("workflow meta 不是合法对象字面量: " + err.message);
  }
  if (!meta || typeof meta !== "object" ||
      typeof meta.name !== "string" || typeof meta.description !== "string") {
    throw new Error("workflow meta 必须含 name 和 description 字符串");
  }

  const strippedMeta =
    script.slice(0, marker.index) +
    script.slice(marker.index).replace(/export\s+const\s+meta/, "const meta");
  return { meta, body: normalizeExports(strippedMeta) };
}

/**
 * 归一化 meta 之外的 export，使脚本能在 vm 非模块上下文执行（vm 不认 export，
 * 否则报 "Unexpected token 'export'"）。模型常把 workflow 写成
 * `export default async function(api){...}`（合法且自然），必须支持：
 * - `export default <expr>` → `const __wf_default = <expr>`，并在末尾
 *   `return await __wf_default(__wf_api)`（__wf_api 由 sandbox 注入完整 host API；
 *   入口是函数则用 host API 调用，非函数则直接作结果）。
 * - 其余 `export const/let/var/function/class/async` → 剥掉 export 前缀成局部声明。
 *
 * 改写必须 lexer-aware：只命中代码区（depth-0 语句边界）真实的 export 关键字，
 * 绝不碰字符串/模板/正则/行注释/块注释内出现的 `export` 字面文本——否则模型脚本里
 * 形如 'export const config from db' 的 prompt 会被误改，甚至 in-string 的
 * `export default ` 会让 hasDefault 误判而追加一个引用未声明变量的 trailer 导致崩溃。
 * @param {string} body
 * @returns {string}
 */
function normalizeExports(body) {
  let out = "";
  let hasDefault = false;
  let depth = 0;           // 顶层 {}/[]/() 嵌套深度；只在 depth-0 改写顶层语句的 export
  // 上一个有意义（非空白、非注释）的代码字符，用于判定 `/` 是除号还是正则开头。
  let prevSignificant = "";
  // 是否处于语句起始（脚本开头 / 上个有意义字符是 ; { } / 其后出现过换行，即 ASI 边界）。
  // 只在此位置改写顶层 export，杜绝表达式中间的 `export` 文本被命中。
  let atStatementStart = true;
  // 上下文栈：栈空 = 顶层代码；栈顶决定当前解析模式。模板插值 `${...}` 是嵌套代码上下文
  // （里面可再开字符串 / 模板 / 注释 / 正则），故必须用栈而非单一 inStr 标志——否则
  // 形如 `${`it's ${1}`}` 这类嵌套模板里的引号/反引号会让扫描器失步、漏剥真实 export。
  // 帧：{k:'str',q} 普通串 | {k:'tmpl'} 模板字面量文本 | {k:'interp',brace} 插值内代码 |
  //     {k:'line'}/{k:'block'} 注释 | {k:'regex'} 正则。
  const stack = [];
  const top = () => (stack.length ? stack[stack.length - 1] : null);

  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    const next = body[i + 1];
    const t = top();

    // ── 非代码上下文：原样拷贝，只负责正确退出 ──
    if (t && t.k === "line") {
      out += c;
      if (c === "\n") stack.pop();
      continue;
    }
    if (t && t.k === "block") {
      out += c;
      if (c === "*" && next === "/") { out += next; i++; stack.pop(); }
      continue;
    }
    if (t && t.k === "regex") {
      out += c;
      if (c === "\\") { if (i + 1 < body.length) { out += body[i + 1]; i++; } continue; }
      // 正则收尾：prevSignificant 记为「值结尾」字符，否则紧跟的 `/`（除号）会被
      // regexAllowedAfter 当成新正则开头、推一个跑到 EOF 的 regex 帧吞掉后面真实的
      // export（vm 报 Unexpected token export）。用 ")"（在 disallow 集内）；注意不能用
      // "/"——它不在 regexAllowedAfter 的 disallow 集里，修不掉。
      if (c === "/") { stack.pop(); prevSignificant = ")"; }
      continue;
    }
    if (t && t.k === "str") {
      out += c;
      if (c === "\\") { if (i + 1 < body.length) { out += body[i + 1]; i++; } continue; }
      if (c === t.q) stack.pop();
      continue;
    }
    if (t && t.k === "tmpl") {
      // 模板字面量文本：copy；`\` 转义；`` ` `` 收尾；`${` 进入插值代码上下文。
      // 注意单/双引号在模板文本里是普通字符，不开字符串（这正是旧单标志失步处）。
      if (c === "\\") { out += c; if (i + 1 < body.length) { out += body[i + 1]; i++; } continue; }
      if (c === "`") { out += c; stack.pop(); continue; }
      // 进入插值代码：prevSignificant 复位为语句起始态（""），否则它还留着模板开头那个
      // "`"，会让插值里第一个 `/`（正则开头，如 `${ /a/ ... }`）被 regexAllowedAfter('`')
      // 误判为除号、扫描失步、末尾 `/` 开一个跑到 EOF 的 regex 帧吞掉真实 export。
      if (c === "$" && next === "{") { out += c; out += next; i++; stack.push({ k: "interp", brace: 0 }); prevSignificant = ""; continue; }
      out += c;
      continue;
    }

    // ── 代码上下文：栈空=顶层代码（做 export 改写）；栈顶=interp=插值内代码（不改写）──
    const inInterp = !!(t && t.k === "interp");

    if (/\s/.test(c)) {
      if (c === "\n" && !inInterp && depth === 0) atStatementStart = true;
      out += c;
      continue;
    }

    // 进入注释 / 字符串 / 模板 / 正则（顶层与插值内同样适用）
    if (c === "/" && next === "/") { stack.push({ k: "line" }); out += c; continue; }
    if (c === "/" && next === "*") { stack.push({ k: "block" }); out += c; continue; }
    if (c === '"' || c === "'") { stack.push({ k: "str", q: c }); out += c; prevSignificant = c; if (!inInterp) atStatementStart = false; continue; }
    if (c === "`") { stack.push({ k: "tmpl" }); out += c; prevSignificant = c; if (!inInterp) atStatementStart = false; continue; }
    if (c === "/" && regexAllowedAfter(prevSignificant)) { stack.push({ k: "regex" }); out += c; if (!inInterp) atStatementStart = false; continue; }

    if (inInterp) {
      // 插值内：只用 {}/} 配平找到本插值的收尾 `}`；其余字符原样拷贝，不做顶层 export 改写。
      if (c === "{") { t.brace++; out += c; prevSignificant = c; continue; }
      if (c === "}") {
        if (t.brace === 0) { stack.pop(); out += c; prevSignificant = c; continue; }
        t.brace--; out += c; prevSignificant = c; continue;
      }
      out += c;
      prevSignificant = c;
      continue;
    }

    // ── 顶层代码：括号深度 / 语句边界 / export 改写 ──
    if (c === "{" || c === "[" || c === "(") { depth++; out += c; prevSignificant = c; atStatementStart = (c === "{"); continue; }
    if (c === "}" || c === "]" || c === ")") { if (depth > 0) depth--; out += c; prevSignificant = c; atStatementStart = (c === "}"); continue; }
    if (c === ";") { out += c; prevSignificant = c; atStatementStart = true; continue; }

    if (
      c === "e" && depth === 0 && atStatementStart &&
      body.startsWith("export", i) && !isIdentChar(body[i - 1]) && !isIdentChar(body[i + 6])
    ) {
      const rewritten = rewriteExportAt(body, i);
      if (rewritten) {
        out += rewritten.text;
        if (rewritten.isDefault) hasDefault = true;
        i = rewritten.end - 1; // for 循环 i++ 后落到 rewritten.end
        const trimmed = rewritten.text.replace(/\s+$/, "");
        prevSignificant = trimmed ? trimmed.slice(-1) : prevSignificant;
        atStatementStart = false;
        continue;
      }
    }

    out += c;
    prevSignificant = c;
    atStatementStart = false;
  }

  if (hasDefault) {
    out += "\n;return await (typeof __wf_default === 'function' ? __wf_default(__wf_api) : __wf_default);";
  }
  return out;
}

/** 标识符字符（用于判断 export 是否被更长的标识符包住，如 `exporter`/`myexport`）。 */
function isIdentChar(ch) {
  return ch != null && /[A-Za-z0-9_$]/.test(ch);
}

/**
 * 紧跟某字符的 `/` 是否应解析为正则开头（而非除号）。前一个有意义字符是运算符 /
 * 分隔符 / 语句起始时是正则；是标识符 / 字面量结尾 / 闭合括号时是除号。
 */
function regexAllowedAfter(prevSignificant) {
  if (prevSignificant === "") return true;
  return !/[A-Za-z0-9_$)\]}'"`]/.test(prevSignificant);
}

/**
 * 在已确认 i 处是顶层真实 `export` 关键字时，给出改写后的文本与消耗到的下标。
 * - `export default ` → `const __wf_default = `（isDefault=true，仅此真实命中才置位）
 * - `export <const|let|var|function|class|async>` → 剥掉 `export` 前缀
 * 不匹配任何已知形态则返回 null（保持原样，交给 vm 自行报错而非静默吞掉）。
 * @returns {{ text: string, end: number, isDefault: boolean } | null}
 */
function rewriteExportAt(body, i) {
  // 跳过 export 后的空白
  let j = i + 6;
  while (j < body.length && /\s/.test(body[j])) j++;
  if (body.startsWith("default", j) && !isIdentChar(body[j + 7])) {
    // export default <expr> → const __wf_default = <expr>
    let k = j + 7;
    while (k < body.length && /\s/.test(body[k])) k++;
    return { text: "const __wf_default = ", end: k, isDefault: true };
  }
  for (const kw of ["const", "let", "var", "function", "class", "async"]) {
    if (body.startsWith(kw, j) && !isIdentChar(body[j + kw.length])) {
      // export const/... → 剥掉 export 前缀，保留 export 与关键字之间的实际空白
      return { text: body.slice(j, j + kw.length), end: j + kw.length, isDefault: false };
    }
  }
  return null;
}

/**
 * 从 start 处的 `{` 找到配对的 `}`（跳过字符串字面量内的花括号）。
 * @param {string} s
 * @param {number} start
 * @returns {number} 配对 `}` 的下标，未闭合返回 -1
 */
function matchBrace(s, start) {
  let depth = 0;
  let inStr = null;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === "\\") { i++; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { inStr = c; continue; }
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return i; }
  }
  return -1;
}
