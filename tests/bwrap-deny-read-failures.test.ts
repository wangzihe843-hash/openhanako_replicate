import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildBwrapArgs, createBwrapExec } from "../lib/sandbox/bwrap.ts";

let root: string;
let denied: string;
const policy = () => ({ allowExternalReads: true, writablePaths: [root], denyReadPaths: [denied] });
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-bwrap-denial-"));
  denied = path.join(root, "credential.json");
  fs.writeFileSync(denied, "fixture");
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("bwrap denied-path probe failures", () => {
  it.each(["EIO", "EACCES"])("rejects construction when stat fails with %s despite an enclosing root mount", code => {
    const realStat = fs.statSync;
    vi.spyOn(fs, "statSync").mockImplementation((target, options) => {
      if (target === denied) throw Object.assign(new Error("probe failed"), { code });
      return realStat(target, options);
    });
    expect(() => buildBwrapArgs(policy())).toThrow("Cannot enforce sandbox read denial");
  });

  it("does not use existsSync failure to drop a real denial", () => {
    const exists = fs.existsSync;
    vi.spyOn(fs, "existsSync").mockImplementation(target => target === denied ? false : exists(target));
    const args = buildBwrapArgs(policy());
    const index = args.lastIndexOf(denied);
    expect(args.slice(index - 2, index + 1)).toEqual(["--ro-bind", "/dev/null", denied]);
  });

  it("omits only a confirmed absent denied path", () => {
    fs.unlinkSync(denied);
    expect(buildBwrapArgs(policy())).not.toContain(denied);
  });

  it("rejects stat ENOENT when the path is still present", () => {
    const realStat = fs.statSync;
    vi.spyOn(fs, "statSync").mockImplementation((target, options) => {
      if (target === denied) throw Object.assign(new Error("missing target"), { code: "ENOENT" });
      return realStat(target, options);
    });
    expect(() => buildBwrapArgs(policy())).toThrow("Cannot enforce sandbox read denial");
  });

  it("shadows an existing denied directory with tmpfs", () => {
    fs.unlinkSync(denied);
    fs.mkdirSync(denied);
    const args = buildBwrapArgs(policy());
    const index = args.lastIndexOf(denied);
    expect(args.slice(index - 1, index + 1)).toEqual(["--tmpfs", denied]);
  });

  it("cleans the command script when policy construction fails before spawn", async () => {
    const realStat = fs.statSync;
    vi.spyOn(fs, "statSync").mockImplementation((target, options) => {
      if (target === denied) throw Object.assign(new Error("probe failed"), { code: "EACCES" });
      return realStat(target, options);
    });
    const unlink = vi.spyOn(fs, "unlinkSync");
    const exec = createBwrapExec(policy());
    await expect(exec("echo fixture", root, { onData: () => undefined, signal: undefined, timeout: undefined, env: {} })).rejects.toThrow("Cannot enforce sandbox read denial");
    expect(unlink).toHaveBeenCalledOnce();
    expect(fs.existsSync(String(unlink.mock.calls[0][0]))).toBe(false);
  });
});
