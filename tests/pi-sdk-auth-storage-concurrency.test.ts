import fs from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createModels, type Provider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage, FileAuthStorageBackend, InMemoryAuthStorageBackend } from "../lib/pi-sdk/model-runtime.ts";
import { ModelManager } from "../core/model-manager.ts";
import { createAuthRoute } from "../server/routes/auth.ts";
import { createProvidersRoute } from "../server/routes/providers.ts";
import { AuthFixtureLifetime } from "./helpers/auth-fixture-lifetime.ts";
import { getPiCodingAgentVersion } from "../lib/pi-sdk/session-options.ts";

const dirs: string[] = [];
const cleanups: (() => Promise<void>)[] = [];
const faultScope = new AsyncLocalStorage<symbol>();
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
const require = createRequire(import.meta.url);
// Inject at the filesystem boundary used by the real Pi/proper-lockfile backend.
const lockFs: typeof fs = createRequire(require.resolve("proper-lockfile"))("graceful-fs");
const originalMkdir = lockFs.mkdir;
afterEach(async () => {
  try {
    const results = await Promise.allSettled(cleanups.splice(0).map(cleanup => cleanup()));
    const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, "Auth fixture cleanup failed");
  } finally {
    vi.restoreAllMocks();
    Object.defineProperty(process, "platform", platformDescriptor);
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
    expect(lockFs.mkdir).toBe(originalMkdir);
    expect(Object.getOwnPropertyDescriptor(process, "platform")).toEqual(platformDescriptor);
  }
});

function windowsLockFailure(authPath: string, failures = 1, platform = "win32") {
  const scope = Symbol("raw credential read");
  // A non-Windows negative must not change a concurrent reader's host behavior.
  Object.defineProperty(process, "platform", {
    configurable: true, enumerable: platformDescriptor.enumerable,
    get: () => faultScope.getStore() === scope ? platform : platformDescriptor.value,
  });
  const lockPath = path.resolve(authPath) + ".lock";
  const error = Object.assign(new Error("Synthetic Windows lock-directory access denied"), {
    code: "EPERM", syscall: "mkdir", path: lockPath,
  });
  const mkdir = lockFs.mkdir.bind(lockFs);
  let injected = 0;
  vi.spyOn(lockFs, "mkdir").mockImplementation((...args: Parameters<typeof fs.mkdir>) => {
    // Other readers of this file (including a failed availability pass's
    // unfinished siblings) must not consume this operation's failure budget.
    if (faultScope.getStore() === scope && args[0] === lockPath && injected < failures) {
      injected++;
      const callback = args[args.length - 1] as fs.NoParamCallback;
      queueMicrotask(() => callback(error));
      return;
    }
    return mkdir(...args);
  });
  return { error, injected: () => injected, run: <T>(operation: () => T) => faultScope.run(scope, operation) };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const providerId = "fixture-oauth";
const oldCredential = { type: "oauth" as const, access: "fixture-old", refresh: "fixture-refresh-old", expires: 1 };
const rotatedCredential = () => ({ type: "oauth" as const, access: "fixture-rotated", refresh: "fixture-refresh-new", expires: Date.now() + 3600_000 });

function fixture(mode = "file", managerFixture = false, failRegistration = false) {
  const lifetime = new AuthFixtureLifetime();
  cleanups.push(() => lifetime.dispose());
  return lifetime.setup(() => setupFixture(lifetime, mode, managerFixture, failRegistration));
}

async function setupFixture(lifetime: AuthFixtureLifetime, mode: string, managerFixture: boolean, failRegistration: boolean) {
  lifetime.checkOpen();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-auth-lock-"));
  dirs.push(dir);
  lifetime.removeOnClose(() => fs.rmSync(dir, { recursive: true, force: true }));
  const authPath = path.join(dir, "auth.json");
  fs.writeFileSync(authPath, JSON.stringify({ [providerId]: oldCredential }));
  const backend = mode === "memory" ? new InMemoryAuthStorageBackend() : new FileAuthStorageBackend(authPath);
  if (mode === "memory") backend.withLock(() => ({ result: undefined, next: JSON.stringify({ [providerId]: oldCredential }) }));
  const withLock = backend.withLockAsync.bind(backend);
  backend.withLockAsync = (...args) => lifetime.child(() => withLock(...args));
  const pendingReads = new Set<Promise<unknown>>();
  const availabilityRelease = deferred();
  lifetime.releaseOnClose(availabilityRelease.resolve);
  let holdAvailabilityReads = false;
  const trackRead = <T>(read: Promise<T>): Promise<T> => {
    pendingReads.add(read);
    void read.then(() => pendingReads.delete(read), () => pendingReads.delete(read));
    return lifetime.track(read);
  };
  const watchStorage = (storage: AuthStorage) => {
    const get = storage.get.bind(storage);
    const removeCredential = storage.remove.bind(storage);
    const logout = storage.logout.bind(storage);
    // Public operations may not start once closing. Internal credential-store
    // continuations are still tracked so an accepted rotation can finish writing.
    vi.spyOn(storage, "get").mockImplementation(id => lifetime.run(() => get(id)));
    vi.spyOn(storage, "remove").mockImplementation(id => lifetime.run(() => removeCredential(id)));
    vi.spyOn(storage, "logout").mockImplementation(id => lifetime.run(() => logout(id)));
    const read = storage.credentials.read.bind(storage.credentials);
    const list = storage.credentials.list.bind(storage.credentials);
    const modify = storage.credentials.modify.bind(storage.credentials);
    const remove = storage.credentials.delete.bind(storage.credentials);
    vi.spyOn(storage.credentials, "read").mockImplementation((...args) => lifetime.child(() => trackRead(read(...args).then(async value => {
      if (holdAvailabilityReads) await availabilityRelease.promise;
      return value;
    }))));
    vi.spyOn(storage.credentials, "list").mockImplementation((...args) => lifetime.child(() => trackRead(list(...args))));
    vi.spyOn(storage.credentials, "modify").mockImplementation((...args) => lifetime.child(() => modify(...args)));
    vi.spyOn(storage.credentials, "delete").mockImplementation((...args) => lifetime.child(() => remove(...args)));
    return storage;
  };
  let manager: ModelManager | undefined;
  let storage: AuthStorage;
  if (managerFixture) {
    fs.writeFileSync(path.join(dir, "added-models.yaml"), 'providers:\n  deepseek:\n    base_url: https://fixture.example.invalid/v1\n    api: openai-completions\n    api_key: fixture-catalog-key\n    models: []\n');
    manager = new ModelManager({ hanakoHome: dir });
    const create = AuthStorage.create.bind(AuthStorage);
    const creation = vi.spyOn(AuthStorage, "create").mockImplementation(file => watchStorage(create(file)));
    try { await manager.init(); } finally { creation.mockRestore(); }
    lifetime.checkOpen();
    storage = manager.authStorage;
    await backend.withLockAsync(async current => ({ result: undefined, next: JSON.stringify({
      ...JSON.parse(current!), deepseek: { type: "api_key", key: "fixture-stale" },
    }) }));
  } else storage = watchStorage(mode === "cached-file" ? AuthStorage.create(authPath) : AuthStorage.fromStorage(backend));
  const entered = deferred();
  const release = deferred();
  lifetime.releaseOnClose(release.resolve);
  lifetime.checkOpen();
  // ModelRuntime intentionally scans every built-in provider. Production uses
  // create()'s revision cache; raw lock tests use Pi's public single-provider
  // Models API so they exercise real storage without unrelated global fanout.
  const runtime = mode === "cached-file" || managerFixture
    ? await storage.getRuntime() : createModels({ credentials: storage.credentials });
  await lifetime.drain();
  lifetime.checkOpen();
  const rotated = rotatedCredential();
  let refreshes = 0;
  let readersAtRotation = 0;
  const unexpected = () => { throw new Error("Synthetic fixture refuses login/model requests"); };
  const provider: Provider = {
    id: providerId, name: "Fixture OAuth", getModels: () => [], stream: unexpected, streamSimple: unexpected,
    auth: { oauth: { name: "Fixture OAuth", login: unexpected,
      async refresh() { refreshes++; readersAtRotation = pendingReads.size; entered.resolve(); await release.promise; return rotated; },
      async toAuth(credential) { return { apiKey: credential.access }; },
    } },
  };
  let registrationPending = 0;
  if (runtime instanceof ModelRuntime) {
    const registrationRefresh = vi.spyOn(runtime, "refresh");
    const registrationError = new Error("Synthetic availability-list failure");
    if (failRegistration) vi.mocked(storage.credentials.list).mockImplementationOnce(() => {
      // Pause real sibling reads at the failing availability pass, not during
      // the earlier model refresh. This race stays deterministic with caching.
      holdAvailabilityReads = true;
      return trackRead(Promise.reject(registrationError));
    });
    runtime.registerNativeProvider(provider);
    const registration = registrationRefresh.mock.results[0].value;
    registrationRefresh.mockRestore();
    await lifetime.track(registration);
    registrationPending = pendingReads.size;
    if (failRegistration) expect(runtime.getError()).toContain(registrationError.message);
    holdAvailabilityReads = false;
    availabilityRelease.resolve();
  } else {
    runtime.setProvider(provider);
    await lifetime.track(runtime.getAvailable());
    expect(runtime.getProviders().map(provider => provider.id)).toEqual([providerId]);
  }
  // Pi catches availability errors before siblings settle. Drain actual reads,
  // including late children, before starting the deliberate OAuth rotation.
  await lifetime.drain();
  const refresh = lifetime.rotate(() => runtime.getAuth(providerId));
  await Promise.race([entered.promise, refresh.then(() => { throw new Error("OAuth refresh did not enter"); })]);
  lifetime.checkOpen();
  const duringRefresh = async <T>(operation: () => T | Promise<T>): Promise<T> => {
    lifetime.checkOpen();
    const result = lifetime.run(operation);
    setImmediate(release.resolve);
    try { return await result; }
    finally { release.resolve(); await refresh; }
  };
  return { dir, authPath, storage, backend, runtime, manager, rotated, duringRefresh, registrationPending, readersAtRotation, refreshes: () => refreshes };
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
  it("owns paused setup until disposal and prevents a late rotation from starting", async () => {
    const paused = deferred();
    const resume = deferred();
    const getRuntime = AuthStorage.prototype.getRuntime;
    vi.spyOn(AuthStorage.prototype, "getRuntime").mockImplementation(async function (...args) {
      paused.resolve();
      await resume.promise;
      return getRuntime.apply(this, args);
    });
    // Observe immediately even in the old fixture, so the red control reports
    // the ownership assertion without causing an unrelated unhandled rejection.
    const setup = fixture("cached-file").then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
    await paused.promise;
    const dir = dirs.at(-1)!;
    const cleanup = cleanups.pop()!;
    const getAuth = vi.spyOn(ModelRuntime.prototype, "getAuth");
    const failure = windowsLockFailure(path.join(dir, "auth.json"));
    let disposed = false;
    const disposal = cleanup().then(() => { disposed = true; });
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(disposed).toBe(false);
      expect(fs.existsSync(dir)).toBe(true);
      resume.resolve();
      const outcome = await setup;
      await disposal;
      expect(outcome.error?.message).toBe("Auth fixture is closing");
      expect(getAuth).not.toHaveBeenCalled();
      expect(failure.injected()).toBe(0);
      expect(fs.existsSync(dir)).toBe(false);
    } finally {
      resume.resolve();
      const outcome = await setup;
      if (outcome.value) await outcome.value.duringRefresh(() => undefined);
      await disposal;
    }
  });

  it("surfaces early getAuth rejection before waiting for OAuth entry", async () => {
    const error = new Error("Synthetic early getAuth failure");
    const called = deferred();
    vi.spyOn(ModelRuntime.prototype, "getAuth").mockImplementationOnce(() => {
      const rejected = Promise.reject(error);
      called.resolve();
      return rejected;
    });
    const pending = Symbol("still waiting for OAuth entry");
    const setup = fixture("cached-file").then(() => undefined, failure => failure);
    await called.promise;
    const cleanup = cleanups.pop()!;
    try {
      const outcome = await Promise.race([setup, new Promise(resolve => setImmediate(() => resolve(pending)))]);
      expect(outcome).toBe(error);
    } finally {
      await expect(cleanup()).rejects.toBe(error);
    }
  });

  it("waits for an owned credential modification before removing its directory", async () => {
    const f = await fixture();
    await f.duringRefresh(() => undefined);
    const remove = fs.rmSync.bind(fs);
    let modificationSettled = false;
    let persisted;
    vi.spyOn(fs, "rmSync").mockImplementation((target, options) => {
      if (target === f.dir) {
        expect(modificationSettled).toBe(true);
        persisted = JSON.parse(fs.readFileSync(f.authPath, "utf8"))[providerId];
      }
      return remove(target, options);
    });
    const entered = deferred();
    const release = deferred();
    const modification = f.storage.credentials.modify(providerId, async credential => {
      entered.resolve();
      await release.promise;
      expect(fs.existsSync(f.dir)).toBe(true);
      return { ...credential, access: "fixture-final-modification" };
    });
    const outcome = modification.then(value => {
      modificationSettled = true;
      return { value, error: undefined };
    }, error => {
      modificationSettled = true;
      return { value: undefined, error };
    });
    await entered.promise;
    const cleanup = cleanups.pop()!;
    let disposed = false;
    const disposal = cleanup().then(() => { disposed = true; });
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(disposed).toBe(false);
      release.resolve();
      const result = await outcome;
      expect(result.error).toBeUndefined();
      expect(result.value).toMatchObject({ access: "fixture-final-modification" });
      await disposal;
      expect(persisted).toMatchObject({ access: "fixture-final-modification" });
      expect(fs.existsSync(f.dir)).toBe(false);
    } finally {
      release.resolve();
      await outcome;
      await disposal;
    }
  });

  it("disposal releases OAuth rotation and waits for its durable write before removal", async () => {
    const f = await fixture();
    const remove = fs.rmSync.bind(fs);
    let persisted;
    vi.spyOn(fs, "rmSync").mockImplementation((target, options) => {
      if (target === f.dir) persisted = JSON.parse(fs.readFileSync(f.authPath, "utf8"))[providerId];
      return remove(target, options);
    });
    await cleanups.pop()!();
    expect(persisted).toEqual(f.rotated);
    expect(f.refreshes()).toBe(1);
    expect(fs.existsSync(f.dir)).toBe(false);
    await expect(f.storage.get(providerId)).rejects.toThrow("Auth fixture is closing");
    const failure = windowsLockFailure(f.authPath);
    await expect(failure.run(() => f.storage.credentials.modify(providerId, async () => f.rotated)))
      .rejects.toThrow("Auth fixture is closing");
    expect(failure.injected()).toBe(0);
  });

  it.each(["file", "cached-file", "memory"])("reads fresh raw credentials asynchronously while %s refresh owns the lock", async mode => {
    const f = await fixture(mode);
    const credential = await f.duringRefresh(() => f.storage.get(providerId));
    expect(credential).toEqual(f.rotated);
    expect(f.refreshes()).toBe(1);
    expect(await f.storage.has(providerId)).toBe(true);
    if (mode !== "memory") expect(await AuthStorage.create(f.authPath).get(providerId)).toEqual(f.rotated);
  });

  it("checks includeFallback=false without blocking the in-flight refresh", async () => {
    const f = await fixture("cached-file");
    expect(await f.duringRefresh(() => f.storage.getApiKey(providerId, { includeFallback: false }))).toBe(f.rotated.access);
    expect(await f.storage.has("missing-fixture-provider")).toBe(false);
    expect(await f.storage.getApiKey("missing-fixture-provider", { includeFallback: false })).toBeUndefined();
  });

  it.each(["/auth/oauth/status", "/providers/summary"])("keeps %s available during refresh", async route => {
    const f = await fixture("cached-file");
    const app = appFor(f.storage);
    const response = await f.duringRefresh(() => app.request("/api" + route));
    expect(response.status).toBe(200);
    const body = await response.json();
    if (route === "/auth/oauth/status") expect(body[providerId].loggedIn).toBe(true);
    else expect(body.providers[providerId].logged_in).toBe(true);
    expect(JSON.stringify(body)).not.toContain(f.rotated.access);
  });

  it("keeps summary fresh after a transient Windows lock mkdir failure", async () => {
    const f = await fixture("cached-file");
    const app = appFor(f.storage);
    const failure = windowsLockFailure(f.authPath);
    const response = await f.duringRefresh(() => failure.run(() => app.request("/api/providers/summary")));
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
    expect(await f.duringRefresh(() => failure.run(() => f.storage.get(providerId)))).toEqual(f.rotated);
    expect(failure.injected()).toBe(3);
    expect(f.refreshes()).toBe(1);
    expect(JSON.parse(fs.readFileSync(f.authPath, "utf8"))[providerId]).toEqual(f.rotated);
  });

  it("surfaces persistent Windows lock-directory permission denial without reporting stale login status", async () => {
    const f = await fixture("cached-file");
    const app = appFor(f.storage);
    const errors: Error[] = [];
    app.onError((error, c) => { errors.push(error); return c.text("Storage unavailable", 500); });
    const failure = windowsLockFailure(f.authPath, Infinity);
    const response = await f.duringRefresh(() => failure.run(() => app.request("/api/providers/summary")));
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
  ])("preserves $name with only the backend's reviewed acquisition budget", async ({ platform, code, syscall, target }) => {
    const f = await fixture();
    const failure = windowsLockFailure(f.authPath, Infinity, platform);
    Object.assign(failure.error, { code, syscall, path: target === "lock" ? failure.error.path
      : target === "auth" ? f.authPath : target === "parent" ? f.dir : path.join(f.dir, target) });
    await expect(f.duringRefresh(() => failure.run(() => f.storage.get(providerId)))).rejects.toBe(failure.error);
    // Pi 1.2.0 retries acquisition EPERM itself (even if the OS error metadata
    // is unusual). Hana must not add an outer retry or replay the read callback.
    expect(failure.injected()).toBe(getPiCodingAgentVersion() === "1.2.0" && platform === "win32" && code === "EPERM" ? 6 : 1);
  });

  it.each(["win32", "linux"])("isolates %s denial from another read after an availability pass fails early", async platform => {
    const f = await fixture("cached-file", false, true);
    expect(f.registrationPending).toBeGreaterThan(0);
    expect(f.readersAtRotation).toBe(0);
    const failure = windowsLockFailure(f.authPath, Infinity, platform);
    expect(process.platform).toBe(platformDescriptor.value);
    expect(failure.run(() => process.platform)).toBe(platform);
    await f.duringRefresh(async () => {
      const denied = expect(failure.run(() => f.storage.get(providerId))).rejects.toBe(failure.error);
      // This same-file reader uses the real Pi backend outside the fault's
      // context. It must still wait for and observe the one committed rotation.
      const other = f.storage.get(providerId);
      const [, credential] = await Promise.all([denied, other]);
      expect(credential).toEqual(f.rotated);
    });
    expect(failure.injected()).toBe(platform === "win32" ? 6 : 1);
    expect(f.refreshes()).toBe(1);
    expect(await AuthStorage.create(f.authPath).get(providerId)).toEqual(f.rotated);
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
    await expect(failure.run(() => f.storage.get(providerId))).rejects.toBeInstanceOf(SyntaxError);
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
    const f = await fixture("cached-file");
    await f.duringRefresh(() => f.storage.logout(providerId));
    expect(await AuthStorage.create(f.authPath).get(providerId)).toBeUndefined();
    expect(await f.runtime.getAuth(providerId)).toBeUndefined();
  });

  it("config cleanup awaits API-key deletion and preserves the concurrent OAuth rotation", async () => {
    const f = await fixture("cached-file", true);
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
