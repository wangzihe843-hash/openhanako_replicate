import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage, FileAuthStorageBackend, InMemoryAuthStorageBackend } from "../lib/pi-sdk/model-runtime.ts";
import { ModelManager } from "../core/model-manager.ts";
import { createAuthRoute } from "../server/routes/auth.ts";
import { createProvidersRoute } from "../server/routes/providers.ts";

const dirs: string[] = [];
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
const require = createRequire(import.meta.url);
// Inject at the filesystem boundary used by the real Pi/proper-lockfile backend.
const lockFs: typeof fs = createRequire(require.resolve("proper-lockfile"))("graceful-fs");
afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", platformDescriptor);
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function windowsLockFailure(authPath: string, failures = 1) {
  Object.defineProperty(process, "platform", { ...platformDescriptor, value: "win32" });
  const lockPath = path.resolve(authPath) + ".lock";
  const error = Object.assign(new Error("Synthetic Windows lock-directory access denied"), {
    code: "EPERM", syscall: "mkdir", path: lockPath,
  });
  const mkdir = lockFs.mkdir.bind(lockFs);
  let injected = 0;
  vi.spyOn(lockFs, "mkdir").mockImplementation((...args: Parameters<typeof fs.mkdir>) => {
    if (args[0] === lockPath && injected < failures) {
      injected++;
      const callback = args[args.length - 1] as fs.NoParamCallback;
      queueMicrotask(() => callback(error));
      return;
    }
    return mkdir(...args);
  });
  return { error, injected: () => injected };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const providerId = "fixture-oauth";
const oldCredential = { type: "oauth" as const, access: "fixture-old", refresh: "fixture-refresh-old", expires: 1 };
const rotatedCredential = () => ({ type: "oauth" as const, access: "fixture-rotated", refresh: "fixture-refresh-new", expires: Date.now() + 3600_000 });

async function fixture(mode = "file", managerFixture = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-auth-lock-"));
  dirs.push(dir);
  const authPath = path.join(dir, "auth.json");
  fs.writeFileSync(authPath, JSON.stringify({ [providerId]: oldCredential }));
  const backend = mode === "memory" ? new InMemoryAuthStorageBackend() : new FileAuthStorageBackend(authPath);
  if (mode === "memory") backend.withLock(() => ({ result: undefined, next: JSON.stringify({ [providerId]: oldCredential }) }));
  let manager: ModelManager | undefined;
  let storage: AuthStorage;
  if (managerFixture) {
    fs.writeFileSync(path.join(dir, "added-models.yaml"), 'providers:\n  deepseek:\n    base_url: https://fixture.example.invalid/v1\n    api: openai-completions\n    api_key: fixture-catalog-key\n    models: []\n');
    manager = new ModelManager({ hanakoHome: dir });
    await manager.init();
    storage = manager.authStorage;
    await backend.withLockAsync(async current => ({ result: undefined, next: JSON.stringify({
      ...JSON.parse(current!), deepseek: { type: "api_key", key: "fixture-stale" },
    }) }));
  } else storage = mode === "cached-file" ? AuthStorage.create(authPath) : AuthStorage.fromStorage(backend);
  const runtime = await storage.getRuntime();
  const entered = deferred();
  const release = deferred();
  const rotated = rotatedCredential();
  let refreshes = 0;
  const unexpected = () => { throw new Error("Synthetic fixture refuses login/model requests"); };
  const registrationRefresh = vi.spyOn(runtime, "refresh");
  runtime.registerNativeProvider({
    id: providerId, name: "Fixture OAuth", getModels: () => [], stream: unexpected, streamSimple: unexpected,
    auth: { oauth: { name: "Fixture OAuth", login: unexpected,
      async refresh() { refreshes++; entered.resolve(); await release.promise; return rotated; },
      async toAuth(credential) { return { apiKey: credential.access }; },
    } },
  });
  // Registration starts a background availability pass. Drain it before the
  // deliberate rotation so it neither consumes injected faults nor outlives cleanup.
  const registration = registrationRefresh.mock.results[0].value;
  registrationRefresh.mockRestore();
  await registration;
  const refresh = runtime.getAuth(providerId);
  await entered.promise;
  const duringRefresh = async <T>(operation: () => T | Promise<T>): Promise<T> => {
    const result = Promise.resolve().then(operation);
    setImmediate(release.resolve);
    try { return await result; }
    finally { release.resolve(); await refresh; }
  };
  return { dir, authPath, storage, backend, runtime, manager, rotated, duringRefresh, refreshes: () => refreshes };
}

function appFor(storage: AuthStorage) {
  const app = new Hono();
  const entry = { id: providerId, authType: "oauth", displayName: "Fixture OAuth" };
  const engine = {
    authStorage: storage, availableModels: [], preferences: { getOAuthCustomModels: () => ({}) },
    providerRegistry: {
      getAllProvidersRaw: () => ({}), get: () => entry, getAll: () => new Map([[providerId, entry]]),
      getOAuthProviderIds: () => [providerId], getAuthJsonKey: (id: string) => id,
    },
  };
  app.route("/api", createAuthRoute(engine));
  app.route("/api", createProvidersRoute(engine));
  return app;
}

describe("AuthStorage operations during OAuth rotation", () => {
  it.each(["file", "cached-file", "memory"])("reads fresh raw credentials asynchronously while %s refresh owns the lock", async mode => {
    const f = await fixture(mode);
    const credential = await f.duringRefresh(() => f.storage.get(providerId));
    expect(credential).toEqual(f.rotated);
    expect(f.refreshes()).toBe(1);
    expect(await f.storage.has(providerId)).toBe(true);
    if (mode !== "memory") expect(await AuthStorage.create(f.authPath).get(providerId)).toEqual(f.rotated);
  });

  it("checks includeFallback=false without blocking the in-flight refresh", async () => {
    const f = await fixture();
    expect(await f.duringRefresh(() => f.storage.getApiKey(providerId, { includeFallback: false }))).toBe(f.rotated.access);
    expect(await f.storage.has("missing-fixture-provider")).toBe(false);
    expect(await f.storage.getApiKey("missing-fixture-provider", { includeFallback: false })).toBeUndefined();
  });

  it.each(["/auth/oauth/status", "/providers/summary"])("keeps %s available during refresh", async route => {
    const f = await fixture();
    const app = appFor(f.storage);
    const response = await f.duringRefresh(() => app.request("/api" + route));
    expect(response.status).toBe(200);
    const body = await response.json();
    if (route === "/auth/oauth/status") expect(body[providerId].loggedIn).toBe(true);
    else expect(body.providers[providerId].logged_in).toBe(true);
    expect(JSON.stringify(body)).not.toContain(f.rotated.access);
  });

  it.each(["file", "cached-file"])("keeps summary fresh after a transient Windows lock mkdir failure (%s)", async mode => {
    const f = await fixture(mode);
    const app = appFor(f.storage);
    const failure = windowsLockFailure(f.authPath);
    const response = await f.duringRefresh(() => app.request("/api/providers/summary"));
    expect(failure.injected()).toBe(1);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.providers[providerId].logged_in).toBe(true);
    expect(JSON.stringify(body)).not.toContain(f.rotated.access);
    expect(await f.storage.get(providerId)).toEqual(f.rotated);
    expect(f.refreshes()).toBe(1);
  });

  it.each(["file", "cached-file"])("still waits for rotation after repeated Windows lock mkdir failures (%s)", async mode => {
    const f = await fixture(mode);
    const failure = windowsLockFailure(f.authPath, 3);
    expect(await f.duringRefresh(() => f.storage.get(providerId))).toEqual(f.rotated);
    expect(failure.injected()).toBe(3);
    expect(f.refreshes()).toBe(1);
    expect(JSON.parse(fs.readFileSync(f.authPath, "utf8"))[providerId]).toEqual(f.rotated);
  });

  it("surfaces persistent Windows lock-directory permission denial without reporting stale login status", async () => {
    const f = await fixture();
    const app = appFor(f.storage);
    const errors: Error[] = [];
    app.onError((error, c) => { errors.push(error); return c.text("Storage unavailable", 500); });
    const failure = windowsLockFailure(f.authPath, Infinity);
    const response = await f.duringRefresh(() => app.request("/api/providers/summary"));
    expect(response.status).toBe(500);
    expect(errors).toEqual([failure.error]);
    expect(failure.injected()).toBe(6); // Initial attempt + five bounded waits.
    expect(f.refreshes()).toBe(1);
    expect(JSON.parse(fs.readFileSync(f.authPath, "utf8"))[providerId]).toEqual(f.rotated);
  });

  it.each([
    { name: "non-Windows EPERM", platform: "linux", code: "EPERM", syscall: "mkdir", target: "lock" },
    { name: "EACCES", platform: "win32", code: "EACCES", syscall: "mkdir", target: "lock" },
    { name: "I/O failure", platform: "win32", code: "EIO", syscall: "mkdir", target: "lock" },
    { name: "credential-file read denial", platform: "win32", code: "EPERM", syscall: "open", target: "auth" },
    { name: "parent-directory denial", platform: "win32", code: "EPERM", syscall: "mkdir", target: "parent" },
    { name: "another lock directory", platform: "win32", code: "EPERM", syscall: "mkdir", target: "other.lock" },
  ])("does not retry $name", async ({ platform, code, syscall, target }) => {
    const f = await fixture();
    const failure = windowsLockFailure(f.authPath, Infinity);
    Object.defineProperty(process, "platform", { ...platformDescriptor, value: platform });
    Object.assign(failure.error, { code, syscall, path: target === "lock" ? failure.error.path
      : target === "auth" ? f.authPath : target === "parent" ? f.dir : path.join(f.dir, target) });
    await expect(f.duringRefresh(() => f.storage.get(providerId))).rejects.toBe(failure.error);
    expect(failure.injected()).toBe(1);
  });

  it("keeps custom-backend errors visible without retry", async () => {
    const backend = new InMemoryAuthStorageBackend();
    const storage = AuthStorage.fromStorage(backend);
    Object.defineProperty(process, "platform", { ...platformDescriptor, value: "win32" });
    const error = Object.assign(new Error("Custom backend denied"), {
      code: "EPERM", syscall: "mkdir", path: path.resolve("synthetic-auth.json.lock"),
    });
    const read = vi.spyOn(backend, "withLockAsync").mockRejectedValue(error);
    await expect(storage.get(providerId)).rejects.toBe(error);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("does not hide corrupt storage after a transient Windows lock failure", async () => {
    const f = await fixture();
    await f.duringRefresh(() => undefined);
    fs.writeFileSync(f.authPath, "{broken");
    const failure = windowsLockFailure(f.authPath);
    await expect(f.storage.get(providerId)).rejects.toBeInstanceOf(SyntaxError);
    expect(failure.injected()).toBe(1);
    expect(fs.readFileSync(f.authPath, "utf8")).toBe("{broken");
  });

  it("does not replay a raw-read callback after acquiring the lock", async () => {
    const f = await fixture();
    await f.duringRefresh(() => undefined);
    Object.defineProperty(process, "platform", { ...platformDescriptor, value: "win32" });
    const error = Object.assign(new Error("Read callback failure"), {
      code: "EPERM", syscall: "mkdir", path: path.resolve(f.authPath) + ".lock",
    });
    const withLock = f.backend.withLockAsync.bind(f.backend);
    const read = vi.spyOn(f.backend, "withLockAsync").mockImplementation((fn, options) => withLock(async current => {
      await fn(current);
      throw error;
    }, options));
    await expect(f.storage.get(providerId)).rejects.toBe(error);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it.each(["file", "memory"])("removes credentials after %s rotation without resurrecting them", async mode => {
    const f = await fixture(mode);
    await f.duringRefresh(() => f.storage.remove(providerId));
    expect(await f.storage.get(providerId)).toBeUndefined();
    expect(await f.runtime.getAuth(providerId)).toBeUndefined();
    expect(f.refreshes()).toBe(1);
    if (mode === "file") expect(JSON.parse(fs.readFileSync(f.authPath, "utf8"))[providerId]).toBeUndefined();
  });

  it("logout waits for rotation and keeps the credential deleted on disk and reopen", async () => {
    const f = await fixture();
    await f.duringRefresh(() => f.storage.logout(providerId));
    expect(await AuthStorage.create(f.authPath).get(providerId)).toBeUndefined();
    expect(await f.runtime.getAuth(providerId)).toBeUndefined();
  });

  it("config cleanup awaits API-key deletion and preserves the concurrent OAuth rotation", async () => {
    const f = await fixture("file", true);
    await f.duringRefresh(() => f.manager!.reloadAndSync());
    const stored = JSON.parse(fs.readFileSync(f.authPath, "utf8"));
    expect(stored.deepseek).toBeUndefined();
    expect(stored[providerId]).toEqual(f.rotated);
  });

  it("raw reads do not execute configured key commands and corrupt storage fails visibly", async () => {
    const backend = new InMemoryAuthStorageBackend();
    backend.withLock(() => ({ result: undefined, next: JSON.stringify({ fixture: { type: "api_key", key: "!fixture-command-must-not-run" } }) }));
    const storage = AuthStorage.fromStorage(backend);
    expect(await storage.get("fixture")).toEqual({ type: "api_key", key: "!fixture-command-must-not-run" });
    backend.withLock(() => ({ result: undefined, next: "{broken" }));
    await expect(Promise.resolve().then(() => storage.get("fixture"))).rejects.toThrow();
  });
});
