import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage, FileAuthStorageBackend, InMemoryAuthStorageBackend } from "../lib/pi-sdk/model-runtime.ts";
import { ModelManager } from "../core/model-manager.ts";
import { createAuthRoute } from "../server/routes/auth.ts";
import { createProvidersRoute } from "../server/routes/providers.ts";

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
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
  runtime.registerNativeProvider({
    id: providerId, name: "Fixture OAuth", getModels: () => [], stream: unexpected, streamSimple: unexpected,
    auth: { oauth: { name: "Fixture OAuth", login: unexpected,
      async refresh() { refreshes++; entered.resolve(); await release.promise; return rotated; },
      async toAuth(credential) { return { apiKey: credential.access }; },
    } },
  });
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
