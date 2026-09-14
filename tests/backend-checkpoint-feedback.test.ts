import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { wrapWithCheckpoint } from "../lib/checkpoint-wrapper.ts";
import { CheckpointStore } from "../lib/checkpoint-store.ts";
import { reportNonfatalError } from "../lib/nonfatal-error.ts";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function wrappedTool(name: string, result: unknown, failure?: Error) {
  const execute = vi.fn(async () => { if (failure) throw failure; return result; });
  const save = vi.fn(async () => { throw new Error("backup disk full"); });
  const [tool] = wrapWithCheckpoint([{ name, execute }], {
    store: { save }, maxFileSizeKb: 1024, cwd: path.resolve("project"),
    getSessionPath: () => "session-alpha",
  });
  return { tool, execute, save };
}

describe("checkpoint failure feedback", () => {
  it.each([
    ["write", { path: "note.md" }],
    ["edit", { path: "note.md" }],
    ["bash", { command: "rm note.md" }],
    ["exec_command", { cmd: "mv note.md renamed.md" }],
  ])("reports backup failure without losing %s tool output", async (name, params) => {
    const result = { content: [{ type: "text", text: "operation result" }], details: { exitCode: 0 }, isError: false };
    const { tool, execute } = wrappedTool(String(name), result);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const actual = await tool.execute("call-id", params);

    expect(execute).toHaveBeenCalledOnce();
    expect(actual.isError).toBe(false);
    expect(actual.content[0]).toEqual(result.content[0]);
    expect(actual.details).toMatchObject({ exitCode: 0, checkpointWarning: {
      status: "failed", sessionPath: "session-alpha", filePath: path.resolve("project/note.md"),
    } });
    expect(actual.content[1].text).toContain("backup failed");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("session=session-alpha"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("note.md"));
    expect(result.details).toEqual({ exitCode: 0 });
  });

  it.each(["checkpoint-id", null])("distinguishes created and skipped checkpoints (%s)", async (checkpointId) => {
    const original = { content: [{ type: "text", text: "ok" }], isError: false };
    const [tool] = wrapWithCheckpoint([{ name: "write", execute: async () => original }], {
      store: { save: async () => checkpointId }, maxFileSizeKb: 1024, cwd: path.resolve("project"), getSessionPath: () => "session-alpha",
    });
    const result = await tool.execute("id", { path: "note.md" });
    expect(result.details.checkpoint).toMatchObject({ status: checkpointId ? "created" : "skipped", checkpointId });
    expect(result.content).toEqual(original.content);
    expect(result.isError).toBe(false);
    expect(result.details.checkpointWarning).toBeUndefined();
  });

  it("preserves the original thrown execution error when backup also fails", async () => {
    const original = new Error("write permission denied");
    const { tool } = wrappedTool("write", null, original);
    await expect(tool.execute("id", { path: "note.md" })).rejects.toBe(original);
  });

  it("keeps an error result marked as failed and primitive outputs unchanged", async () => {
    const { tool } = wrappedTool("edit", { content: [{ type: "text", text: "not found" }], isError: true });
    expect((await tool.execute("id", { path: "note.md" })).isError).toBe(true);
    const primitive = wrappedTool("write", "legacy output");
    expect(await primitive.tool.execute("id", { path: "note.md" })).toBe("legacy output");
  });

  it("does not interrupt execution if warning logging itself throws", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => { throw new Error("sink failed"); });
    const { tool, execute } = wrappedTool("write", { content: [] });
    await expect(tool.execute("id", { path: "note.md" })).resolves.toBeDefined();
    expect(execute).toHaveBeenCalledOnce();
  });

  it.each(["EACCES", "EIO"])("does not treat a source stat %s as a skipped backup", async (code) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-checkpoint-feedback-"));
    roots.push(root);
    const store = new CheckpointStore(path.join(root, "checkpoints"));
    const error = Object.assign(new Error("source stat failed"), { code });
    vi.spyOn(fs, "statSync").mockImplementationOnce(() => { throw error; });
    await expect(store.save({ sessionPath: "session", tool: "write", filePath: path.join(root, "note.md"), maxSizeKb: 1024, source: "llm", reason: "test" })).rejects.toBe(error);
    expect(fs.existsSync(path.join(root, "checkpoints"))).toBe(false);
  });

  it("reports explicit checkpoint deletion failure and keeps missing deletion idempotent", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-checkpoint-delete-"));
    roots.push(root);
    const store = new CheckpointStore(root);
    const target = path.join(root, "old.json");
    fs.writeFileSync(target, "preserved");
    const error = Object.assign(new Error("delete denied"), { code: "EACCES" });
    const unlink = vi.spyOn(fs, "unlinkSync").mockImplementationOnce(() => { throw error; });
    await expect(store.remove("old")).rejects.toBe(error);
    expect(fs.readFileSync(target, "utf-8")).toBe("preserved");
    unlink.mockRestore();
    await expect(store.remove("missing")).resolves.toBeUndefined();
  });

  it("does not stringify arbitrary thrown objects in warning diagnostics", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    reportNonfatalError("operation failed", { toString: () => { throw new Error("private payload touched"); } });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Non-Error failure"));
  });
});
