import { describe, expect, it } from "vitest";
import { extractMeta } from "../lib/workflow/meta.js";

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
