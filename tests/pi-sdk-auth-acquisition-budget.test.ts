import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage, FileAuthStorageBackend } from "../lib/pi-sdk/model-runtime.ts";
import { getPiCodingAgentVersion } from "../lib/pi-sdk/session-options.ts";

const piRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const lockFs: typeof fs = createRequire(piRequire.resolve("proper-lockfile"))("graceful-fs");
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks(); syncBuiltinESMExports();
  Object.defineProperty(process, "platform", platform);
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-pi-auth-budget-")); dirs.push(dir);
  const file = path.join(dir, "auth.json");
  fs.writeFileSync(file, '{"fixture":{"type":"api_key","key":"public-fixture"}}');
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  const error = Object.assign(new Error("synthetic acquisition denial"), { code: "EPERM", syscall: "mkdir", path: file + ".lock" });
  return { file, error, backend: new FileAuthStorageBackend(file) };
}

// Intentionally deferred until 1.2.0 is actually installed after cooldown.
describe.skipIf(getPiCodingAgentVersion() !== "1.2.0")("installed Pi 1.2.0 acquisition budget", () => {
  it("makes ten total synchronous attempts, never entering the callback", () => {
    const f = fixture(), callback = vi.fn();
    const mkdir = vi.spyOn(lockFs, "mkdirSync").mockImplementation(() => { throw f.error; });
    expect(() => f.backend.withLock(callback)).toThrow(f.error);
    expect(mkdir).toHaveBeenCalledTimes(10);
    expect(callback).not.toHaveBeenCalled();
  });

  it("makes six total asynchronous attempts and one facade get", async () => {
    const f = fixture();
    const mkdir = vi.spyOn(lockFs, "mkdir").mockImplementation((...args: Parameters<typeof fs.mkdir>) => {
      queueMicrotask(() => (args.at(-1) as fs.NoParamCallback)(f.error));
    });
    const lock = vi.spyOn(f.backend, "withLockAsync");
    await expect(AuthStorage.fromStorage(f.backend).get("fixture")).rejects.toBe(f.error);
    expect(lock).toHaveBeenCalledTimes(1);
    expect(mkdir).toHaveBeenCalledTimes(6);
  });

  it.each(["callback", "read", "write"])("does not replay a %s error after acquisition", async stage => {
    const f = fixture(), storage = AuthStorage.fromStorage(f.backend);
    const original = fs.readFileSync(f.file, "utf8");
    const acquisition = vi.spyOn(f.backend as unknown as { acquireLockAsync: (...args: unknown[]) => unknown }, "acquireLockAsync");
    let callbackCount = 0;
    if (stage === "read") {
      const read = fs.readFileSync;
      vi.spyOn(fs, "readFileSync").mockImplementation(((file, ...args) => {
        if (file === f.file) throw f.error;
        return read(file, ...args);
      }) as typeof read);
    } else if (stage === "write") {
      const write = fs.writeFileSync;
      vi.spyOn(fs, "writeFileSync").mockImplementation(((file, ...args) => {
        if (file === f.file) throw f.error;
        return write(file, ...args);
      }) as typeof write);
    }
    syncBuiltinESMExports();
    const operation = stage === "read" ? storage.get("fixture") : f.backend.withLockAsync(async () => {
      callbackCount++;
      if (stage === "callback") throw f.error;
      return { result: undefined, next: '{}' };
    });
    await expect(operation).rejects.toBe(f.error);
    expect(acquisition).toHaveBeenCalledTimes(1);
    expect(callbackCount).toBe(stage === "read" ? 0 : 1);
    vi.restoreAllMocks(); syncBuiltinESMExports();
    expect(fs.readFileSync(f.file, "utf8")).toBe(original);
  });
});
