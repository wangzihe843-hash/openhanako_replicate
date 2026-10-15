import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../core/llm-client.ts", () => ({ callText: vi.fn().mockResolvedValue("compiled") }));
vi.mock("../lib/i18n.ts", () => ({ getLocale: () => "zh-CN" }));
import { callText } from "../core/llm-client.ts";
import { compileLongterm, migrateLegacyWeekToLongterm } from "../lib/memory/compile.ts";
let root: string;
const model = { model: "test", api: "openai-completions", api_key: "test", base_url: "http://invalid.test" };
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-memory-read-failure-"));
  vi.mocked(callText).mockClear();
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

// Target the intended file, regardless of earlier reset-marker reads. Keep the
// fault one-shot so the existing post-failure verification can read retained data.
function failReadOnce(target: string, failure: Error) {
  const readFile = fs.readFileSync;
  const injected = vi.fn();
  vi.spyOn(fs, "readFileSync").mockImplementation((file, options) => {
    if (file === target && injected.mock.calls.length === 0) {
      injected(file);
      throw failure;
    }
    return readFile(file, options);
  });
  return injected;
}

describe("memory compilation read failures", () => {
  it.each(["EACCES", "EIO"])("preserves old long-term memory on %s without invoking the model", async (code) => {
    const target = path.join(root, "longterm.md");
    const original = Buffer.from("已有的重要记忆。\r\n");
    fs.writeFileSync(target, original);
    const failure = Object.assign(new Error("memory unreadable"), { code });
    const readFile = fs.readFileSync;
    vi.spyOn(fs, "readFileSync").mockImplementation((file, options) => {
      if (file === target) throw failure;
      return readFile(file, options);
    });
    await expect(compileLongterm("new input", target, model)).rejects.toBe(failure);
    expect(readFile(target)).toEqual(original);
    expect(callText).not.toHaveBeenCalled();
    expect(fs.existsSync(`${target}.fingerprint`)).toBe(false);
  });

  it("reports an unreadable fingerprint instead of repeating compilation", async () => {
    const target = path.join(root, "longterm.md");
    fs.writeFileSync(target, "existing memory");
    const failure = Object.assign(new Error("fingerprint unreadable"), { code: "EIO" });
    const injected = failReadOnce(`${target}.fingerprint`, failure);
    await expect(compileLongterm("new input", target, model)).rejects.toBe(failure);
    expect(injected).toHaveBeenCalledTimes(1);
    expect(injected).toHaveBeenCalledWith(`${target}.fingerprint`);
    expect(fs.readFileSync(target, "utf-8")).toBe("existing memory");
    expect(callText).not.toHaveBeenCalled();
  });

  it.each(["EACCES", "EIO"])("does not replace or remove unreadable legacy memory on %s", async (code) => {
    const source = path.join(root, "week.md");
    const target = path.join(root, "longterm.md");
    fs.writeFileSync(source, "legacy memory");
    const failure = Object.assign(new Error("legacy source unreadable"), { code });
    const injected = failReadOnce(source, failure);
    await expect(migrateLegacyWeekToLongterm(root, target, model)).rejects.toBe(failure);
    expect(injected).toHaveBeenCalledTimes(1);
    expect(injected).toHaveBeenCalledWith(source);
    expect(fs.readFileSync(source, "utf-8")).toBe("legacy memory");
    expect(fs.existsSync(`${source}.migrated.bak`)).toBe(false);
    expect(fs.existsSync(target)).toBe(false);
    expect(callText).not.toHaveBeenCalled();
  });

  describe.each(["compileLongterm", "migrateLegacyWeekToLongterm"])("%s reset marker failures", (operation) => {
    it.each(["EACCES", "EIO"])("fails closed on marker %s without modifying memory or invoking the model", async (code) => {
      const marker = path.join(root, "reset.json");
      const markerBytes = JSON.stringify({ compiledResetAt: "2026-10-15T00:00:00.000Z", resetRevision: "test-reset" });
      const source = path.join(root, "week.md");
      const target = path.join(root, "longterm.md");
      fs.writeFileSync(marker, markerBytes);
      fs.writeFileSync(source, "legacy memory");
      fs.writeFileSync(target, "existing memory");
      fs.writeFileSync(`${target}.fingerprint`, "existing fingerprint");
      const failure = Object.assign(new Error("reset marker unreadable"), { code });
      const injected = failReadOnce(marker, failure);
      const work = operation === "compileLongterm"
        ? compileLongterm("new input", target, model)
        : migrateLegacyWeekToLongterm(root, target, model);
      const error = await work.catch((error) => error);
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain("Memory reset marker is unreadable");
      expect(error.cause).toBe(failure);
      expect(injected).toHaveBeenCalledTimes(1);
      expect(injected).toHaveBeenCalledWith(marker);
      expect(fs.readFileSync(marker, "utf-8")).toBe(markerBytes);
      expect(fs.readFileSync(source, "utf-8")).toBe("legacy memory");
      expect(fs.readFileSync(target, "utf-8")).toBe("existing memory");
      expect(fs.readFileSync(`${target}.fingerprint`, "utf-8")).toBe("existing fingerprint");
      expect(fs.existsSync(`${source}.migrated.bak`)).toBe(false);
      expect(callText).not.toHaveBeenCalled();
    });
  });

  it("still creates long-term memory when no prior memory exists", async () => {
    const target = path.join(root, "longterm.md");
    await expect(compileLongterm("first memory", target, model)).resolves.toBe("compiled");
    expect(fs.readFileSync(target, "utf-8")).toContain("compiled");
  });
});
