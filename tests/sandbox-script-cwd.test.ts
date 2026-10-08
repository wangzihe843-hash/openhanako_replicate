import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeScript } from "../lib/sandbox/script.ts";

vi.mock("../lib/debug-log.ts", () => ({ createModuleLogger: () => ({ warn() {}, error() {} }) }));

describe.runIf(process.platform !== "win32")("sandbox script literal cwd", () => {
  let root: string;
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hana-script-cwd-")));
    vi.spyOn(os, "tmpdir").mockReturnValue(root);
  });
  afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

  it.each(["ordinary", "with spaces", "中文目录", "single'quote", 'double"quote', "$HANA_CWD_MARKER", "`printf expanded`", "back\\slash", "line\nbreak"])("executes in literal directory %j", (name) => {
    const cwd = path.join(root, name);
    fs.mkdirSync(cwd);
    // A harmless expansion would select this sibling on the vulnerable implementation.
    fs.mkdirSync(path.join(root, "expanded"));
    const { scriptPath } = writeScript("/bin/pwd -P", cwd);
    const result = spawnSync("/bin/bash", [scriptPath], { cwd, env: { PATH: "/usr/bin:/bin", HANA_CWD_MARKER: "expanded" }, encoding: "utf8" });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(fs.realpathSync(cwd) + "\n");
  });

  it("does not execute the business command when the script cwd is invalid", () => {
    const { scriptPath } = writeScript("printf business-ran > sentinel", path.join(root, "missing"));
    const result = spawnSync("/bin/bash", [scriptPath], { cwd: root, env: { PATH: "/usr/bin:/bin" }, encoding: "utf8" });
    expect(fs.existsSync(path.join(root, "sentinel"))).toBe(false);
    expect(result.status).not.toBe(0);
  });
});
