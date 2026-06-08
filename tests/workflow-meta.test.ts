import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { extractMeta } from "../lib/workflow/meta.ts";

/** body 能在 vm 非模块上下文里编译（顶层 export 都被剥掉了才行）。只 parse 不执行。 */
function bodyCompiles(body) {
  return () => new vm.Script("(async function(__wf_api){" + body + "\n})");
}

describe("workflow meta extraction", () => {
  it("提取合法 meta 并剥离 export", () => {
    const script = `export const meta = { name: 'demo', description: '演示' }\nreturn 1 + 1`;
    const { meta, body } = extractMeta(script);
    expect(meta.name).toBe("demo");
    expect(meta.description).toBe("演示");
    expect(body).not.toMatch(/export\s+const\s+meta/);
    expect(body).toMatch(/const meta =/);
  });

  it("剥离 export default 转成入口调用，杂散 export 前缀剥成局部声明", () => {
    const script = `export const meta = { name: 'x', description: 'd' }\nexport const helper = 1\nexport default async function(api){ return helper }`;
    const { body } = extractMeta(script);
    expect(body).not.toMatch(/export\s+default/);
    expect(body).not.toMatch(/export\s+const\s+helper/);
    expect(body).toMatch(/__wf_default/); // export default 被转成入口变量 + 调用
  });

  it("字符串字面量里的 export default 原样保留（不被改写）", () => {
    const script = `export const meta = { name: 'x', description: 'd' }\nconst p = 'export const config from db'; return p`;
    const { body } = extractMeta(script);
    // 字符串内容完整保留，未被剥掉 export 前缀
    expect(body).toMatch(/'export const config from db'/);
  });

  it("模板字面量里的 export const 原样保留（不被改写）", () => {
    const script = "export const meta = { name: 'x', description: 'd' }\nconst t = `export const config from db`; return t";
    const { body } = extractMeta(script);
    expect(body).toMatch(/`export const config from db`/);
  });

  it("仅字符串里出现 export default 时不追加 __wf_default trailer（防引用未声明变量崩溃）", () => {
    const script = `export const meta = { name: 'x', description: 'd' }\nreturn 'export default values'`;
    const { body } = extractMeta(script);
    expect(body).not.toMatch(/__wf_default/);
    expect(body).toMatch(/return 'export default values'/);
  });

  it("真实 export default 与字符串内 export 并存：只改真实那个", () => {
    const script = `export const meta = { name: 'x', description: 'd' }\nconst note = 'export default skip me'\nexport default async function(api){ return note }`;
    const { body } = extractMeta(script);
    // 字符串内的保留，真实 export default 转成入口变量 + trailer
    expect(body).toMatch(/'export default skip me'/);
    expect(body).toMatch(/const __wf_default = async function/);
    expect(body).toMatch(/return await \(typeof __wf_default/);
  });

  it("注释里的 export 不被改写", () => {
    const script = `export const meta = { name: 'x', description: 'd' }\n// export default foo\n/* export const bar */ return 1`;
    const { body } = extractMeta(script);
    expect(body).not.toMatch(/__wf_default/);
    expect(body).toMatch(/\/\/ export default foo/);
    expect(body).toMatch(/\/\* export const bar \*\//);
  });

  it("嵌套模板插值（内含奇数引号）后的真实 export default 仍被剥离（不再失步崩溃）", () => {
    // 内层模板里的 it's 是模板文本里的撇号，旧单标志扫描器会误当字符串开头而失步，
    // 把后面的 export default 漏剥，vm 执行报 Unexpected token 'export'。
    const script = "export const meta = { name: 'x', description: 'd' }\nconst t = `${`it's ${1}`}`\nexport default async function(api){ return t }";
    const { body } = extractMeta(script);
    expect(body).toMatch(/const __wf_default = async function/);
    expect(body).toMatch(/return await \(typeof __wf_default/);
    // 内层模板文本原样保留
    expect(body).toMatch(/`\$\{`it's \$\{1\}`\}`/);
    // 剥离后 body 不应再含顶层语句位置的 export 关键字
    expect(body).not.toMatch(/(^|\n)\s*export\s+default/);
  });

  it("嵌套模板插值后的真实 export const 仍被剥离前缀", () => {
    const script = "export const meta = { name: 'x', description: 'd' }\nconst t = `${`a'b`}`\nexport const helper = 2\nreturn helper";
    const { body } = extractMeta(script);
    expect(body).toMatch(/`\$\{`a'b`\}`/);
    expect(body).toMatch(/(^|\n)\s*const helper = 2/);
    expect(body).not.toMatch(/(^|\n)\s*export\s+const helper/);
  });

  it("插值里嵌套模板中的 export 字面文本不被改写", () => {
    const script = "export const meta = { name: 'x', description: 'd' }\nconst t = `${`export default nope`}`\nreturn t";
    const { body } = extractMeta(script);
    expect(body).toMatch(/`\$\{`export default nope`\}`/);
    expect(body).not.toMatch(/__wf_default/);
  });

  it("顶层正则后接除号不吞掉后面的真实 export（vm 可编译）", () => {
    const script = "export const meta = { name: 'x', description: 'd' }\nconst n = /a/ / 1\nexport const y = 1\nreturn y + n";
    const { body } = extractMeta(script);
    expect(body).toMatch(/(^|\n)\s*const y = 1/);
    expect(body).not.toMatch(/(^|\n)\s*export\s/);
    expect(bodyCompiles(body)).not.toThrow();
  });

  it("模板插值开头的正则后接除号不吞掉真实 export（regression：本轮栈式改写曾把它误判为除号）", () => {
    const script = "export const meta = { name: 'x', description: 'd' }\nconst t = `${ /a/ / 1 }`\nexport const y = 1\nreturn y";
    const { body } = extractMeta(script);
    expect(body).toMatch(/(^|\n)\s*const y = 1/);
    expect(body).not.toMatch(/(^|\n)\s*export\s/);
    expect(bodyCompiles(body)).not.toThrow();
  });

  it("正则/除号控制组：带 flag 正则、纯除法、正则方法调用后的 export 仍被剥离且可编译", () => {
    for (const expr of ["/a/g / 1", "6 / 2 / 1", "/a/.test(x)", "'ab'.replace(/a/, 'x')"]) {
      const script = `export const meta = { name: 'x', description: 'd' }\nconst v = ${expr}\nexport const y = 1\nreturn 0`;
      const { body } = extractMeta(script);
      expect(body, expr).not.toMatch(/(^|\n)\s*export\s/);
      expect(bodyCompiles(body), expr).not.toThrow();
    }
  });

  it("meta 含 phases 数组也能解析", () => {
    const script = `export const meta = { name: 'a', description: 'b', phases: [{ title: 'X' }] }\nreturn []`;
    const { meta } = extractMeta(script);
    expect(meta.phases).toEqual([{ title: "X" }]);
  });

  it("缺 meta 抛错", () => {
    expect(() => extractMeta(`return 1`)).toThrow(/必须以 export const meta/);
  });

  it("meta 缺 name/description 抛错", () => {
    expect(() => extractMeta(`export const meta = { name: 'x' }\nreturn 1`)).toThrow(/name 和 description/);
  });

  it("空脚本抛错", () => {
    expect(() => extractMeta("")).toThrow(/不能为空/);
  });
});
