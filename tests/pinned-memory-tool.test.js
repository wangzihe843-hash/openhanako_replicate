import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, beforeEach } from "vitest";
import { createPinnedMemoryTools } from "../lib/tools/pinned-memory.js";
import { loadLocale } from "../lib/i18n.js";

function mktemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hana-pinned-"));
}

function readPinned(agentDir) {
  try { return fs.readFileSync(path.join(agentDir, "pinned.md"), "utf-8"); } catch { return ""; }
}

describe("pinned-memory tool", () => {
  let agentDir;
  loadLocale("en");

  beforeEach(() => { agentDir = mktemp(); });

  afterEach(() => {
    if (agentDir) {
      try { fs.rmSync(agentDir, { recursive: true, force: true }); } catch {}
      agentDir = null;
    }
  });

  function makeTools() {
    // 不传 agentId，避免触发 event log 写入（事件路径有独立单测覆盖）。
    const [pin, unpin] = createPinnedMemoryTools(agentDir);
    return { pin, unpin };
  }

  it("pin_memory: 添加新内容并按行写入 pinned.md", async () => {
    const { pin } = makeTools();
    const res = await pin.execute("call-1", { content: "买牛奶" });
    expect(res.content[0].text).toContain("买牛奶");
    expect(readPinned(agentDir)).toBe("- 买牛奶\n");
  });

  it("pin_memory: 已存在精确同名时返回 already-exists", async () => {
    const { pin } = makeTools();
    await pin.execute("c1", { content: "foo" });
    const res = await pin.execute("c2", { content: "foo" });
    expect(res.content[0].text.toLowerCase()).toContain("already");
    // pinned.md 只该有一行
    expect(readPinned(agentDir).trim().split("\n").length).toBe(1);
  });

  // 回归：旧实现用 existing.includes(content)，pin "foo" 会被 "foobar" 误判为重复
  it("pin_memory: 子串不应被误判为重复（pin 'foo' 不被 'foobar' 阻断）", async () => {
    const { pin } = makeTools();
    await pin.execute("c1", { content: "foobar" });
    const res = await pin.execute("c2", { content: "foo" });
    expect(res.content[0].text.toLowerCase()).not.toContain("already");
    const raw = readPinned(agentDir);
    expect(raw).toContain("- foobar");
    expect(raw).toContain("- foo\n");
  });

  it("unpin_memory: 空文件返回 empty", async () => {
    const { unpin } = makeTools();
    const res = await unpin.execute("c1", { keyword: "anything" });
    expect(res.content[0].text.toLowerCase()).toContain("empty");
  });

  it("unpin_memory: 找不到返回 not-found", async () => {
    const { pin, unpin } = makeTools();
    await pin.execute("c1", { content: "foo" });
    const res = await unpin.execute("c2", { keyword: "totally-different" });
    expect(res.details.removedCount).toBeUndefined();
    expect(readPinned(agentDir)).toContain("- foo");
  });

  // 回归：旧实现用 line.toLowerCase().includes(keyword.toLowerCase())，
  // 'foo' 会同时删掉 'foo' / 'foobar' / 'FOOZ'，过度删除。
  it("unpin_memory: 有精确匹配时只删精确那一条，不顺带删子串", async () => {
    const { pin, unpin } = makeTools();
    await pin.execute("c1", { content: "foo" });
    await pin.execute("c2", { content: "foobar" });
    await pin.execute("c3", { content: "FOOZ" });

    const res = await unpin.execute("c4", { keyword: "foo" });
    expect(res.details.removedCount).toBe(1);

    const raw = readPinned(agentDir);
    expect(raw).not.toMatch(/^- foo$/m);
    expect(raw).toContain("- foobar");
    expect(raw).toContain("- FOOZ");
  });

  // 兼容承诺：i18n 描述说 "会模糊匹配"，没有精确命中时还是要走子串。
  it("unpin_memory: 无精确匹配时回退到模糊（case-insensitive 子串）删除", async () => {
    const { pin, unpin } = makeTools();
    await pin.execute("c1", { content: "buy milk tomorrow" });
    await pin.execute("c2", { content: "Call dentist" });

    const res = await unpin.execute("c3", { keyword: "MILK" });
    expect(res.details.removedCount).toBe(1);

    const raw = readPinned(agentDir);
    expect(raw).not.toContain("buy milk tomorrow");
    expect(raw).toContain("- Call dentist");
  });

  it("unpin_memory: 模糊命中多条时全部移除（保留旧 fuzzy 语义）", async () => {
    const { pin, unpin } = makeTools();
    await pin.execute("c1", { content: "first todo about cats" });
    await pin.execute("c2", { content: "second todo about dogs" });
    await pin.execute("c3", { content: "unrelated" });

    const res = await unpin.execute("c4", { keyword: "todo" });
    expect(res.details.removedCount).toBe(2);
    // pin 写入时会带尾换行，unpin 不主动清理 → 保留 trailing 空行（与原实现一致）
    expect(readPinned(agentDir).trimEnd()).toBe("- unrelated");
  });
});
