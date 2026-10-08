import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __testing, createSeatbeltExec } from "../lib/sandbox/seatbelt.ts";
import { spawnAndStream } from "../lib/sandbox/exec-helper.ts";

vi.mock("../lib/debug-log.ts", () => ({ createModuleLogger: () => ({ warn() {}, error() {} }) }));
vi.mock("../lib/sandbox/exec-helper.ts", () => ({ spawnAndStream: vi.fn() }));

describe("seatbelt path literals and failure behavior", () => {
  let root: string;
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hana-seatbelt-literal-")));
    vi.spyOn(os, "tmpdir").mockReturnValue(root);
    vi.mocked(spawnAndStream).mockReset();
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });
  const policy = (p: string) => ({ writablePaths: [p], protectedPaths: [p], denyReadPaths: [p] });

  it("encodes quotes and backslashes in every dynamic SBPL path position", () => {
    const target = path.join(root, 'special"back\\slash');
    fs.mkdirSync(target);
    vi.stubEnv("TMPDIR", target);
    const profile = __testing.generateProfile(policy(target), { allowNetwork: false });
    const literal = '"' + target.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
    expect(profile).toContain(`(allow file-write* (subpath ${literal}))`);
    expect(profile).toContain(`(deny file-write* (subpath ${literal}))`);
    expect(profile).toContain(`(deny file-read* (subpath ${literal}))`);
    expect(profile.split(literal).length - 1).toBe(5);
    expect(profile).toContain("(deny network*)");
  });

  it.each(["line\nbreak", "tab\tpath", "carriage\rreturn", "null\0path", "delete\x7fpath"])("rejects unvalidated control characters in %j before launching anything", (name) => {
    const target = path.join(root, name);
    expect(() => __testing.generateProfile(policy(target))).toThrow(/control character/i);
    expect(spawnAndStream).not.toHaveBeenCalled();
  });

  it("does not retry outside the sandbox after parsing/initialization fails and cleans temporary files", async () => {
    vi.mocked(spawnAndStream).mockResolvedValue({ exitCode: 65 });
    const output = await createSeatbeltExec({ writablePaths: [root], protectedPaths: [], denyReadPaths: [] })("printf business-ran > sentinel", root, { onData() {} });
    expect(output.exitCode).toBe(65);
    expect(spawnAndStream).toHaveBeenCalledTimes(1);
    expect(vi.mocked(spawnAndStream).mock.calls[0][0]).toBe("sandbox-exec");
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it("cleans the script if profile generation rejects a path and never launches a fallback", async () => {
    await expect(createSeatbeltExec(policy(path.join(root, "line\nbreak")))("printf business-ran > sentinel", root, { onData() {} })).rejects.toThrow(/control character/i);
    expect(spawnAndStream).not.toHaveBeenCalled();
    expect(fs.readdirSync(root)).toEqual([]);
  });
});
