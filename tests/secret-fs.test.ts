import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

import {
  ensureSecretDirModeSync,
  ensureSecretFileModeSync,
  writeSecretFileSync,
} from "../shared/secret-fs.ts";

const POSIX = process.platform !== "win32";

let tmpDir: string | null = null;

function makeTmpDir() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-secret-fs-"));
  return tmpDir;
}

function modeOf(target: string) {
  return fs.statSync(target).mode & 0o777;
}

afterEach(() => {
  vi.restoreAllMocks();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = null;
});

describe("writeSecretFileSync", () => {
  it("writes the exact content it was given", () => {
    const root = makeTmpDir();
    const target = path.join(root, "credential.json");

    writeSecretFileSync(target, '{"api_key":"value"}\n');

    expect(fs.readFileSync(target, "utf-8")).toBe('{"api_key":"value"}\n');
  });

  it.skipIf(!POSIX)("creates new credential files owner-only", () => {
    const root = makeTmpDir();
    const target = path.join(root, "credential.json");

    writeSecretFileSync(target, "{}\n");

    expect(modeOf(target)).toBe(0o600);
  });

  it.skipIf(!POSIX)("tightens an existing world-readable file instead of inheriting its mode", () => {
    const root = makeTmpDir();
    const target = path.join(root, "credential.json");
    fs.writeFileSync(target, "{}\n", { mode: 0o644 });
    fs.chmodSync(target, 0o644);
    expect(modeOf(target)).toBe(0o644);

    writeSecretFileSync(target, '{"rotated":true}\n');

    expect(modeOf(target)).toBe(0o600);
  });

  it("leaves no temporary file behind on success", () => {
    const root = makeTmpDir();
    const target = path.join(root, "credential.json");

    writeSecretFileSync(target, "{}\n");

    expect(fs.readdirSync(root)).toEqual(["credential.json"]);
  });

  it.skipIf(!POSIX)("never exposes the secret through a world-readable temporary file", () => {
    const root = makeTmpDir();
    const target = path.join(root, "credential.json");
    const observed: number[] = [];
    const realRename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((from: any, to: any) => {
      observed.push(fs.statSync(from).mode & 0o777);
      return realRename(from, to);
    });

    writeSecretFileSync(target, "{}\n");

    expect(observed).toEqual([0o600]);
  });

  it.skipIf(!POSIX)("clears a leftover temporary file so the new one is owner-only from creation", () => {
    // A crash during an older write can leave a temporary file behind. Creating
    // a file with a mode has no effect when the file already exists, so the
    // secret would land in whatever mode that leftover carried.
    const root = makeTmpDir();
    const target = path.join(root, "credential.json");
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, "stale\n");
    fs.chmodSync(tmp, 0o644);
    let leftoverPresentAtWrite = true;
    const realWrite = fs.writeFileSync;
    vi.spyOn(fs, "writeFileSync").mockImplementation((p: any, data: any, opts?: any) => {
      if (String(p) === tmp) leftoverPresentAtWrite = fs.existsSync(tmp);
      return realWrite(p, data, opts);
    });

    writeSecretFileSync(target, "{}\n");

    expect(leftoverPresentAtWrite).toBe(false);
    expect(modeOf(target)).toBe(0o600);
  });

  it.skipIf(!POSIX)("still saves the file when the filesystem refuses the mode change", () => {
    // Removable media and some network mounts reject chmod outright. Saving the
    // user's data must not depend on protection that filesystem cannot provide.
    const root = makeTmpDir();
    const target = path.join(root, "credential.json");
    vi.spyOn(fs, "chmodSync").mockImplementation(() => {
      const err: any = new Error("EPERM: operation not permitted");
      err.code = "EPERM";
      throw err;
    });

    expect(() => writeSecretFileSync(target, '{"kept":true}\n')).not.toThrow();
    expect(fs.readFileSync(target, "utf-8")).toBe('{"kept":true}\n');
    expect(fs.readdirSync(root)).toEqual(["credential.json"]);
  });

  it.skipIf(!POSIX)("still saves the file when the filesystem accepts the mode but ignores it", () => {
    const root = makeTmpDir();
    const target = path.join(root, "credential.json");
    const realStat = fs.statSync;
    vi.spyOn(fs, "statSync").mockImplementation((p: any, opts?: any) => {
      const stat = realStat(p, opts);
      return { ...stat, mode: (stat.mode & ~0o777) | 0o644 } as any;
    });

    expect(() => writeSecretFileSync(target, '{"kept":true}\n')).not.toThrow();
    expect(fs.readFileSync(target, "utf-8")).toBe('{"kept":true}\n');
  });

  it("propagates a genuine write failure instead of reporting success", () => {
    const root = makeTmpDir();
    const target = path.join(root, "credential.json");
    vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
      const err: any = new Error("ENOSPC: no space left on device");
      err.code = "ENOSPC";
      throw err;
    });

    expect(() => writeSecretFileSync(target, "{}\n")).toThrowError(/ENOSPC/);
  });

  it("does not destroy the previous content when the write fails", () => {
    const root = makeTmpDir();
    const target = path.join(root, "credential.json");
    fs.writeFileSync(target, "original\n");
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      const err: any = new Error("EIO: i/o error");
      err.code = "EIO";
      throw err;
    });

    expect(() => writeSecretFileSync(target, "replacement\n")).toThrow();
    expect(fs.readFileSync(target, "utf-8")).toBe("original\n");
  });
});

describe("ensureSecretFileModeSync", () => {
  it.skipIf(!POSIX)("tightens a world-readable credential file", () => {
    const root = makeTmpDir();
    const target = path.join(root, "credential.json");
    fs.writeFileSync(target, "{}\n");
    fs.chmodSync(target, 0o644);

    const healed = ensureSecretFileModeSync(target);

    expect(healed).toBe(true);
    expect(modeOf(target)).toBe(0o600);
  });

  it.skipIf(!POSIX)("reports no correction when the filesystem ignores the mode change", () => {
    // Claiming a correction that did not happen would repeat on every launch.
    const root = makeTmpDir();
    const target = path.join(root, "credential.json");
    fs.writeFileSync(target, "{}\n");
    fs.chmodSync(target, 0o644);
    const realStat = fs.statSync;
    vi.spyOn(fs, "statSync").mockImplementation((p: any, opts?: any) => {
      const stat = realStat(p, opts);
      return { ...stat, mode: (stat.mode & ~0o777) | 0o644 } as any;
    });
    vi.spyOn(fs, "chmodSync").mockImplementation(() => undefined as any);

    expect(ensureSecretFileModeSync(target)).toBe(false);
  });

  it.skipIf(!POSIX)("reports no change when the file is already owner-only", () => {
    const root = makeTmpDir();
    const target = path.join(root, "credential.json");
    fs.writeFileSync(target, "{}\n");
    fs.chmodSync(target, 0o600);

    expect(ensureSecretFileModeSync(target)).toBe(false);
    expect(modeOf(target)).toBe(0o600);
  });

  it("treats a missing file as nothing to do", () => {
    const root = makeTmpDir();

    expect(ensureSecretFileModeSync(path.join(root, "absent.json"))).toBe(false);
  });

  it.skipIf(!POSIX)("propagates permission failures instead of swallowing them", () => {
    const root = makeTmpDir();
    const target = path.join(root, "credential.json");
    fs.writeFileSync(target, "{}\n");
    fs.chmodSync(target, 0o644);
    vi.spyOn(fs, "chmodSync").mockImplementation(() => {
      const err: any = new Error("EACCES: permission denied");
      err.code = "EACCES";
      throw err;
    });

    expect(() => ensureSecretFileModeSync(target)).toThrowError(/FS_PERMISSION|EACCES/);
  });
});

describe("ensureSecretDirModeSync", () => {
  it.skipIf(!POSIX)("tightens a world-traversable credential directory", () => {
    const root = makeTmpDir();
    const dir = path.join(root, "credentials");
    fs.mkdirSync(dir);
    fs.chmodSync(dir, 0o755);

    const healed = ensureSecretDirModeSync(dir);

    expect(healed).toBe(true);
    expect(modeOf(dir)).toBe(0o700);
  });

  it("treats a missing directory as nothing to do", () => {
    const root = makeTmpDir();

    expect(ensureSecretDirModeSync(path.join(root, "absent"))).toBe(false);
  });
});

describe("windows contract", () => {
  it.skipIf(POSIX)("writes content without attempting POSIX mode work", () => {
    const root = makeTmpDir();
    const target = path.join(root, "credential.json");
    const chmod = vi.spyOn(fs, "chmodSync");

    writeSecretFileSync(target, "{}\n");

    expect(fs.readFileSync(target, "utf-8")).toBe("{}\n");
    expect(chmod).not.toHaveBeenCalled();
    expect(ensureSecretFileModeSync(target)).toBe(false);
  });
});


describe("secret publication bounded synchronous retry", () => {
  async function platformWriter(platform: string) {
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
    vi.resetModules();
    try {
      Object.defineProperty(process, "platform", { ...descriptor, value: platform });
      return (await import("../shared/secret-fs.ts")).writeSecretFileSync;
    } finally {
      Object.defineProperty(process, "platform", descriptor);
    }
  }

  it.each(["EPERM", "EACCES", "EBUSY"])("retries only the same staged Windows rename after transient %s", async code => {
    const write = await platformWriter("win32");
    const target = path.join(makeTmpDir(), "credential.json");
    const tmp = target + ".tmp";
    fs.writeFileSync(target, "old fixture");
    const writeFile = vi.spyOn(fs, "writeFileSync");
    const remove = vi.spyOn(fs, "rmSync");
    const chmod = vi.spyOn(fs, "chmodSync");
    const wait = vi.spyOn(Atomics, "wait"); // Real bounded synchronous waits.
    const rename = fs.renameSync;
    const attempts: string[][] = [];
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      attempts.push([String(from), String(to)]);
      expect(fs.readFileSync(tmp, "utf8")).toBe("new fixture");
      expect(fs.readFileSync(target, "utf8")).toBe("old fixture");
      if (attempts.length < 3) throw Object.assign(new Error("transient lock"), { code });
      return rename(from, to);
    });
    expect(write(target, "new fixture")).toBeUndefined();
    expect(attempts).toEqual([[tmp, target], [tmp, target], [tmp, target]]);
    expect(wait.mock.calls.map(call => call[3])).toEqual([10, 20]);
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1); // Initial stale-tmp cleanup only.
    expect(remove.mock.calls[0][0]).toBe(tmp);
    expect(chmod).not.toHaveBeenCalled();
    expect(fs.readFileSync(target, "utf8")).toBe("new fixture");
    expect(fs.existsSync(tmp)).toBe(false);
  });

  it.each(["EPERM", "EACCES", "EBUSY"])("terminates persistent Windows %s after 310ms of waits and retains old bytes", async code => {
    const write = await platformWriter("win32");
    const target = path.join(makeTmpDir(), "credential.json");
    const tmp = target + ".tmp";
    fs.writeFileSync(target, "old fixture");
    const refusal = Object.assign(new Error("persistent lock"), { code });
    const wait = vi.spyOn(Atomics, "wait");
    const writeFile = vi.spyOn(fs, "writeFileSync");
    const remove = vi.spyOn(fs, "rmSync");
    const rename = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      expect([from, to]).toEqual([tmp, target]);
      expect(fs.readFileSync(tmp, "utf8")).toBe("new fixture");
      expect(fs.readFileSync(target, "utf8")).toBe("old fixture");
      throw refusal;
    });
    let failure;
    try { write(target, "new fixture"); } catch (err) { failure = err; }
    expect(failure).toBe(refusal);
    expect(rename).toHaveBeenCalledTimes(6);
    expect(wait.mock.calls.map(call => call[3])).toEqual([10, 20, 40, 80, 160]);
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(remove.mock.calls.every(call => call[0] === tmp)).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe("old fixture");
    expect(fs.existsSync(tmp)).toBe(false);
  });

  it.each([["win32", "EIO"], ["win32", "ENOENT"], ["linux", "EPERM"]])("does not retry %s / %s", async (platform, code) => {
    const write = await platformWriter(platform);
    const target = path.join(makeTmpDir(), "credential.json");
    fs.writeFileSync(target, "old fixture");
    const refusal = Object.assign(new Error("not retryable"), { code });
    const wait = vi.spyOn(Atomics, "wait");
    const rename = vi.spyOn(fs, "renameSync").mockImplementation(() => { throw refusal; });
    let failure;
    try { write(target, "new fixture"); } catch (err) { failure = err; }
    expect(failure).toBe(refusal);
    expect(rename).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
    expect(fs.readFileSync(target, "utf8")).toBe("old fixture");
  });
});
