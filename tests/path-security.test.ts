import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isSensitivePath } from "../server/utils/path-security.ts";

describe("sensitive upload paths", () => {
  const tempRoot = os.tmpdir();
  let fixture: string;
  let home: string;

  beforeEach(() => {
    fixture = fs.mkdtempSync(path.join(tempRoot, "hana-path-security-"));
    home = path.join(fixture, "UserHome");
    fs.mkdirSync(home);
    vi.spyOn(os, "homedir").mockReturnValue(home);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    const resolved = path.resolve(fixture);
    if (path.dirname(resolved) !== path.resolve(tempRoot)
      || !path.basename(resolved).startsWith("hana-path-security-")) {
      throw new Error("Refusing to remove an unowned path-security fixture");
    }
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 3 });
  });

  it("blocks a sensitive directory's resolved target as well as its link", () => {
    const target = path.join(fixture, "credential-store");
    const sensitive = path.join(home, ".ssh");
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, "synthetic-key"), "synthetic fixture");
    fs.symlinkSync(target, sensitive, process.platform === "win32" ? "junction" : "dir");

    expect(isSensitivePath(target, undefined)).toBe(true);
    expect(isSensitivePath(path.join(target, "synthetic-key"), undefined)).toBe(true);
    expect(isSensitivePath(path.join(sensitive, "synthetic-key"), undefined)).toBe(true);
  });

  it.runIf(process.platform === "win32")("blocks Windows case aliases of Hana data and credential directories", () => {
    const hanaHome = path.join(fixture, "HanaHome");
    fs.mkdirSync(hanaHome);
    fs.writeFileSync(path.join(hanaHome, "synthetic.json"), "{}");
    fs.mkdirSync(path.join(home, ".ssh"));
    fs.writeFileSync(path.join(home, ".ssh", "synthetic-key"), "synthetic fixture");

    expect(isSensitivePath(path.join(fixture, "hanahome", "synthetic.json"), hanaHome)).toBe(true);
    expect(isSensitivePath(path.join(fixture, "userhome", ".SSH", "synthetic-key"), undefined)).toBe(true);
  });

  it("allows ordinary paths and sibling directories with a sensitive prefix", () => {
    const hanaHome = path.join(fixture, "HanaHome");
    const sibling = path.join(fixture, "HanaHome-export");
    const sshSibling = path.join(home, ".ssh-notes");
    fs.mkdirSync(hanaHome);
    fs.mkdirSync(sibling);
    fs.mkdirSync(sshSibling);

    expect(isSensitivePath(sibling, hanaHome)).toBe(false);
    expect(isSensitivePath(sshSibling, hanaHome)).toBe(false);
    expect(isSensitivePath(hanaHome, hanaHome)).toBe(true);
  });

  it("keeps missing and relative paths fail-closed", () => {
    expect(isSensitivePath(path.join(home, "missing.txt"), undefined)).toBe(true);
    expect(isSensitivePath("relative.txt", undefined)).toBe(true);
  });
});
