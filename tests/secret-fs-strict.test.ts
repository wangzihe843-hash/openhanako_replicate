import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let root: string;
let target: string;
let writeStrict: typeof import("../shared/secret-fs.ts").writeSecretFileStrictSync;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-strict-secret-"));
  target = path.join(root, "server-info.json");
  fs.writeFileSync(target, "previous fixture");
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  vi.resetModules();
  try {
    Object.defineProperty(process, "platform", { ...descriptor, value: "linux" });
    writeStrict = (await import("../shared/secret-fs.ts")).writeSecretFileStrictSync;
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
  // Exercise POSIX control flow on Windows without claiming NTFS supports modes.
  if (process.platform === "win32") {
    vi.spyOn(fs, "fchmodSync").mockImplementation(() => undefined);
    const actualStat = fs.fstatSync;
    vi.spyOn(fs, "fstatSync").mockImplementation(fd => Object.assign(actualStat(fd), { mode: 0o600 }));
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("strict runtime credential publication", () => {
  it("verifies staged permissions before writing token bytes and replaces old contents", () => {
    const chmod = vi.spyOn(fs, "fchmodSync");
    const stat = vi.spyOn(fs, "fstatSync");
    const write = vi.spyOn(fs, "writeFileSync");
    const open = vi.spyOn(fs, "openSync");
    writeStrict(target, "new fixture");
    expect(open).toHaveBeenCalledWith(expect.stringContaining(`${target}.tmp-`), "wx", 0o600);
    expect(chmod.mock.invocationCallOrder[0]).toBeLessThan(write.mock.invocationCallOrder[0]);
    expect(stat.mock.invocationCallOrder[0]).toBeLessThan(write.mock.invocationCallOrder[0]);
    expect(fs.readFileSync(target, "utf8")).toBe("new fixture");
    expect(fs.readdirSync(root)).toEqual(["server-info.json"]);
  });

  it.each(["refused", "ignored"])("blocks publication when chmod is %s", kind => {
    const failure = Object.assign(new Error("mode refused"), { code: "EPERM" });
    if (kind === "refused") vi.spyOn(fs, "fchmodSync").mockImplementation(() => { throw failure; });
    else {
      const actualStat = fs.fstatSync;
      vi.spyOn(fs, "fstatSync").mockImplementation(fd => Object.assign(actualStat(fd), { mode: 0o644 }));
    }
    const write = vi.spyOn(fs, "writeFileSync");
    const rename = vi.spyOn(fs, "renameSync");
    expect(() => writeStrict(target, "new fixture")).toThrow();
    expect(write).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
    expect(fs.readFileSync(target, "utf8")).toBe("previous fixture");
    expect(fs.readdirSync(root)).toEqual(["server-info.json"]);
  });

  it("does not remove a staging path this invocation could not create", () => {
    const failure = Object.assign(new Error("staging collision"), { code: "EEXIST" });
    vi.spyOn(fs, "openSync").mockImplementation(() => { throw failure; });
    const remove = vi.spyOn(fs, "rmSync");
    expect(() => writeStrict(target, "new fixture")).toThrow(failure);
    expect(remove).not.toHaveBeenCalled();
  });

  it("retains the destination after rename failure and clears its own staged bytes", () => {
    const failure = Object.assign(new Error("publish refused"), { code: "EACCES" });
    vi.spyOn(fs, "renameSync").mockImplementation(() => { throw failure; });
    expect(() => writeStrict(target, "new fixture")).toThrow(failure);
    expect(fs.readFileSync(target, "utf8")).toBe("previous fixture");
    expect(fs.readdirSync(root)).toEqual(["server-info.json"]);
  });

  it("preserves the publication error even if cleanup and reporting fail", async () => {
    const { errorBus } = await import("../shared/error-bus.ts");
    const failure = new Error("publish failure");
    vi.spyOn(fs, "renameSync").mockImplementation(() => { throw failure; });
    vi.spyOn(fs, "rmSync").mockImplementation(() => { throw new Error("cleanup failure"); });
    vi.spyOn(errorBus, "report").mockImplementation(() => { throw new Error("observer failure"); });
    expect(() => writeStrict(target, "new fixture")).toThrow(failure);
    expect(fs.readFileSync(target, "utf8")).toBe("previous fixture");
  });
});
