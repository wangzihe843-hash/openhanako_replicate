import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFileTool } from "../lib/tools/file-tool.ts";
import { createSeatbeltExec } from "../lib/sandbox/seatbelt.ts";
import { spawnAndStream } from "../lib/sandbox/exec-helper.ts";
import { wrapBashTool, wrapCommandExec } from "../lib/sandbox/tool-wrapper.ts";

vi.mock("../lib/i18n.ts", () => ({ t: (key: string) => key }));
vi.mock("../lib/debug-log.ts", () => ({ createModuleLogger: () => ({ warn() {}, error() {}, info() {} }) }));
vi.mock("../lib/document-extract/index.ts", () => ({ extractDocument: vi.fn() }));
vi.mock("../lib/sandbox/exec-helper.ts", () => ({ spawnAndStream: vi.fn() }));

describe.runIf(process.platform !== "win32")("path safety product entrypoints", () => {
  let root: string;
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hana-path-entrypoints-")));
    vi.spyOn(os, "tmpdir").mockReturnValue(root);
    vi.mocked(spawnAndStream).mockReset();
  });
  afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });
  const guard = { check: () => ({ allowed: true }) };

  it("the builtin file copy reports rejection and preserves normal copy", async () => {
    const workspace = path.join(root, "workspace");
    const outside = path.join(root, "outside", "missing.txt");
    fs.mkdirSync(workspace);
    fs.mkdirSync(path.dirname(outside));
    fs.writeFileSync(path.join(workspace, "source.txt"), "synthetic payload");
    fs.symlinkSync(outside, path.join(workspace, "target.txt"));
    const tool = createFileTool({ getCwd: () => workspace });
    const rejected = await tool.execute("copy-rejected", { action: "copy", path: "source.txt", targetPath: "target.txt", conflictPolicy: "overwrite" });
    expect(rejected.details).toEqual({});
    expect(rejected.content[0].text).toContain("ENOENT");
    expect(fs.existsSync(outside)).toBe(false);
    const copied = await tool.execute("copy-normal", { action: "copy", path: "source.txt", targetPath: "normal.txt" });
    expect(copied.details).toMatchObject({ filePath: path.join(workspace, "normal.txt") });
    expect(fs.readFileSync(path.join(workspace, "normal.txt"), "utf8")).toBe("synthetic payload");
  });

  it("the command wrapper returns sandbox initialization failure without fallback", async () => {
    vi.mocked(spawnAndStream).mockResolvedValue({ exitCode: 71 });
    const fallbackExec = vi.fn();
    const exec = wrapCommandExec(createSeatbeltExec({ writablePaths: [root], protectedPaths: [], denyReadPaths: [] }), guard, root, { getSandboxEnabled: () => true, fallbackExec });
    expect(await exec("printf synthetic", root, { onData() {} })).toEqual({ exitCode: 71 });
    expect(fallbackExec).not.toHaveBeenCalled();
    expect(spawnAndStream).toHaveBeenCalledTimes(1);
    expect(vi.mocked(spawnAndStream).mock.calls[0][0]).toBe("sandbox-exec");
  });

  it("the command wrapper propagates profile rejection without fallback", async () => {
    const fallbackExec = vi.fn();
    const exec = wrapCommandExec(createSeatbeltExec({ writablePaths: [path.join(root, "line\nbreak")], protectedPaths: [], denyReadPaths: [] }), guard, root, { getSandboxEnabled: () => true, fallbackExec });
    await expect(exec("printf synthetic", root, { onData() {} })).rejects.toThrow(/control character/);
    expect(fallbackExec).not.toHaveBeenCalled();
    expect(spawnAndStream).not.toHaveBeenCalled();
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it("the bash wrapper propagates a sandboxed SDK error without fallback", async () => {
    const tool = { execute: vi.fn().mockRejectedValue(new Error("sandbox-exec: sandbox_apply: Operation not permitted")) };
    const fallbackTool = { execute: vi.fn() };
    const wrapped = wrapBashTool(tool, guard, root, { getSandboxEnabled: () => true, fallbackTool });
    await expect(wrapped.execute("bash-failed", { command: "printf synthetic" })).rejects.toThrow("sandbox-exec: sandbox_apply: Operation not permitted");
    expect(tool.execute).toHaveBeenCalledTimes(1);
    expect(fallbackTool.execute).not.toHaveBeenCalled();
  });
});
