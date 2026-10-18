import { Hono } from "hono";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigCoordinator } from "../core/config-coordinator.ts";
import { PreferencesManager } from "../core/preferences-manager.ts";
import { ProviderRegistry } from "../core/provider-registry.ts";
import { ModelManager } from "../core/model-manager.ts";
import { resolveDeepSeekToolApiKey } from "../core/deepseek-tool-credentials.ts";
import { isOfficialDeepSeekBaseUrl } from "../shared/deepseek-tools.ts";
import { MASKED_SECRET } from "../shared/secret-custody.ts";
import { createConfigRoute } from "../server/routes/config.ts";
import { createPreferencesRoute } from "../server/routes/preferences.ts";
import { createWebSearchTool, resetWebSearchRateLimiterForTests } from "../lib/tools/web-search.ts";

let root: string;
let registry: ProviderRegistry;
let prefs: PreferencesManager;
let coordinator: ConfigCoordinator;
const fetchMock = vi.fn();
const immediate = { run: (_provider, _source, operation) => operation() };
function credentialSource() {
  return {
    providerRegistry: registry,
    resolveProviderCredentials: (id: string) => ModelManager.prototype.resolveProviderCredentials.call({ providerRegistry: registry }, id),
  };
}
function makeCoordinator() {
  return new ConfigCoordinator({ getPrefs: () => prefs });
}
function engine() {
  return {
    ...credentialSource(),
    hanakoHome: root, config: {}, configPath: path.join(root, "unused-config.yaml"), currentAgentId: "test",
    getSearchConfig: () => coordinator.getSearchConfig(),
    setSearchConfig: (patch) => coordinator.setSearchConfig(patch),
    getSharedModels: () => ({}), getUtilityApi: () => ({}), updateConfig: vi.fn(), emitEvent: vi.fn(),
  };
}
function appFor(source = engine()) {
  const app = new Hono();
  app.route("/api", createConfigRoute(source));
  app.route("/api", createPreferencesRoute(source));
  return app;
}
function verify(app: Hono, patch = {}) {
  return app.request("/api/search/verify", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "deepseek", api_key: "", credential_provider: "deepseek", ...patch }),
  });
}
function saveProvider(id = "deepseek", patch = {}) {
  registry.saveProvider(id, { base_url: "https://api.deepseek.com", api_key: "synthetic-model-key", models: ["deepseek-chat"], ...patch });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-config-"));
  registry = new ProviderRegistry(root);
  prefs = new PreferencesManager({ userDir: path.join(root, "user"), agentsDir: path.join(root, "agents") });
  coordinator = makeCoordinator();
  saveProvider();
  fetchMock.mockReset().mockImplementation(async () => Response.json({ results: [] }));
  vi.stubGlobal("fetch", fetchMock);
  resetWebSearchRateLimiterForTests();
});
afterEach(() => {
  resetWebSearchRateLimiterForTests();
  vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("official DeepSeek credential references", () => {
  it.each(["https://api.deepseek.com", "https://api.deepseek.com/", "https://api.deepseek.com/v1", "https://api.deepseek.com/v1/", "https://api.deepseek.com:443/v1"])("accepts official base %s", url => {
    expect(isOfficialDeepSeekBaseUrl(url)).toBe(true);
  });
  it.each(["", "http://api.deepseek.com", "https://proxy.example/v1", "https://api.deepseek.com.evil.test/v1", "https://api.deepseek.com@evil.test", "https://user:pass@api.deepseek.com/v1", "https://api.deepseek.com:8443", "https://api.deepseek.com/v1?key=x", "https://api.deepseek.com/#key", "https://api.deepseek.com/v1/chat/completions"])("rejects proxy/ambiguous base %s", url => {
    expect(isOfficialDeepSeekBaseUrl(url)).toBe(false);
    saveProvider("deepseek", { base_url: url });
    if (url) expect(() => resolveDeepSeekToolApiKey("deepseek", credentialSource())).toThrow(/official/);
  });

  it("uses the existing ModelManager resolver, sees rotated keys, and survives display renaming", () => {
    expect(resolveDeepSeekToolApiKey("deepseek", credentialSource())).toBe("synthetic-model-key");
    saveProvider("deepseek", { api_key: "rotated-key", display_name: "My new label" });
    expect(resolveDeepSeekToolApiKey("deepseek", credentialSource())).toBe("rotated-key");
  });

  it("requires an explicit ID with one or multiple accounts; supports explicit custom official account IDs", () => {
    expect(() => resolveDeepSeekToolApiKey("", credentialSource())).toThrow(/Select an official/);
    saveProvider("official-account-b", { api_key: "account-b-key" });
    expect(() => resolveDeepSeekToolApiKey("", credentialSource())).toThrow(/explicit selection/);
    expect(resolveDeepSeekToolApiKey("official-account-b", credentialSource())).toBe("account-b-key");
    expect(resolveDeepSeekToolApiKey("deepseek", credentialSource())).toBe("synthetic-model-key");
  });

  it("fails closed on deleted or renamed IDs even when another eligible account exists", () => {
    saveProvider("new-name");
    registry.removeProvider("deepseek");
    expect(() => resolveDeepSeekToolApiKey("deepseek", credentialSource())).toThrow(/removed or renamed/);
    expect(() => resolveDeepSeekToolApiKey("old-name", credentialSource())).toThrow(/removed or renamed/);
  });

  it.each(["", "   ", MASKED_SECRET])("rejects empty or masked model keys", key => {
    saveProvider("deepseek", { api_key: key });
    expect(() => resolveDeepSeekToolApiKey("deepseek", credentialSource())).toThrow(/no API key/);
  });

  it.each(["oauth", "none", "optional"])("rejects %s credentials", authType => {
    saveProvider("custom-auth", { auth_type: authType });
    expect(() => resolveDeepSeekToolApiKey("custom-auth", credentialSource())).toThrow(/API key/);
  });

  it("validates the effective URL again and sanitizes resolver errors", () => {
    const source = credentialSource();
    source.resolveProviderCredentials = () => ({ api_key: "proxy-secret", base_url: "https://proxy.test", api: "" });
    expect(() => resolveDeepSeekToolApiKey("deepseek", source)).toThrow(/official/);
    source.resolveProviderCredentials = () => { throw new Error("private key and path"); };
    expect(() => resolveDeepSeekToolApiKey("deepseek", source)).toThrow("DeepSeek credentials could not be resolved.");
  });

  it("revalidates references after rate-limit waiting instead of caching a model credential", async () => {
    let queued!: () => Promise<unknown>;
    const limiter = { run: (_p, _s, op) => new Promise(resolve => { queued = () => Promise.resolve().then(op).then(resolve); }) };
    coordinator.setSearchConfig({ provider: "deepseek", credential_provider: "deepseek" });
    const instance = createWebSearchTool({ rateLimiter: limiter, searchConfigResolver: () => ({
      ...coordinator.getSearchConfig(), resolveDeepSeekApiKey: id => resolveDeepSeekToolApiKey(id, credentialSource()),
    }) });
    const pending = instance.execute("call", { query: "query" });
    saveProvider("deepseek", { api_key: "rotated-key" });
    await queued(); await pending;
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer rotated-key");
  });
});

describe("DeepSeek search settings custody", () => {
  it("persists only the reference across restart and masks the optional standalone override", async () => {
    coordinator.setSearchConfig({ provider: "deepseek", credential_provider: "deepseek", api_keys: { brave: "brave-key" } });
    const saved = fs.readFileSync(path.join(root, "user/preferences.json"), "utf8");
    expect(saved).toContain('"search_credential_provider": "deepseek"');
    expect(saved).not.toContain("synthetic-model-key");
    prefs = new PreferencesManager({ userDir: path.join(root, "user"), agentsDir: path.join(root, "agents") });
    coordinator = makeCoordinator();
    expect(coordinator.getSearchConfig()).toMatchObject({ provider: "deepseek", credential_provider: "deepseek", api_key: null, api_keys: { brave: "brave-key" } });
    const read = await appFor().request("/api/preferences/models");
    expect((await read.json()).search).toEqual({ provider: "deepseek", credential_provider: "deepseek", api_key: "", api_keys: { brave: MASKED_SECRET } });
    coordinator.setSearchConfig({ api_keys: { deepseek: "standalone-key" } });
    const readOverride = await appFor().request("/api/preferences/models");
    expect((await readOverride.json()).search).toMatchObject({ api_key: MASKED_SECRET, api_keys: { deepseek: MASKED_SECRET } });
    coordinator.setSearchConfig({ api_key: "", credential_provider: "" });
    expect(coordinator.getSearchConfig()).not.toHaveProperty("credential_provider");
    expect(coordinator.getSearchConfig().api_keys).toEqual({ brave: "brave-key" });
  });

  it("verifies using a model key but saves only an ID, without copying into agent config", async () => {
    const source = engine();
    const response = await verify(appFor(source));
    expect(await response.json()).toEqual({ ok: true });
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer synthetic-model-key");
    expect(coordinator.getSearchConfig()).toEqual({ provider: "deepseek", api_key: null, api_keys: {}, credential_provider: "deepseek" });
    expect(source.updateConfig).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(root, "user/preferences.json"), "utf8")).not.toContain("synthetic-model-key");
  });

  it("verifies a separate override despite a stale reference, then clears it to resume reuse", async () => {
    const source = engine();
    expect(await (await verify(appFor(source), { api_key: "override-key", credential_provider: "stale" })).json()).toEqual({ ok: true });
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer override-key");
    resetWebSearchRateLimiterForTests();
    expect(await (await verify(appFor(source))).json()).toEqual({ ok: true });
    expect(coordinator.getSearchConfig().api_keys).toEqual({});
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe("Bearer synthetic-model-key");
  });

  it("does not borrow another search provider's masked key on verify or preference patch", async () => {
    coordinator.setSearchConfig({ provider: "brave", api_key: "brave-key" });
    const app = appFor();
    const response = await verify(app, { api_key: MASKED_SECRET });
    expect(await response.json()).toEqual({ ok: true });
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer synthetic-model-key");
    coordinator.setSearchConfig({ provider: "brave" });
    await app.request("/api/preferences/models", { method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ search: { provider: "deepseek", api_key: MASKED_SECRET, credential_provider: "deepseek" } }),
    });
    expect(coordinator.getSearchConfig().api_key).toBeNull();
    expect(coordinator.getSearchConfig().api_keys).toEqual({ brave: "brave-key" });
  });

  it.each(["missing", "proxy", "empty", "ambiguous"])("rejects %s references without fetching or changing saved settings", async failure => {
    coordinator.setSearchConfig({ provider: "brave", api_key: "brave-key" });
    if (failure === "proxy") saveProvider("deepseek", { base_url: "https://proxy.test" });
    if (failure === "empty") saveProvider("deepseek", { api_key: "" });
    if (failure === "ambiguous") saveProvider("another-account");
    const before = prefs.getPreferences();
    const response = await verify(appFor(), { credential_provider: failure === "missing" ? "missing" : failure === "ambiguous" ? "" : "deepseek" });
    expect((await response.json()).ok).toBe(false);
    expect(prefs.getPreferences()).toEqual(before);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns sanitized verification errors and saves nothing on HTTP failure", async () => {
    const before = prefs.getPreferences();
    fetchMock.mockResolvedValueOnce(new Response("synthetic-model-key", { status: 401 }));
    const response = await verify(appFor());
    const body = await response.json();
    expect(body).toMatchObject({ ok: false, code: "auth" });
    expect(JSON.stringify(body)).not.toContain("synthetic-model-key");
    expect(prefs.getPreferences()).toEqual(before);
  });

  it("clears a standalone key through preferences without reviving the legacy mirror", async () => {
    coordinator.setSearchConfig({ provider: "deepseek", api_key: "override-key", credential_provider: "deepseek", api_keys: { brave: "brave-key" } });
    const response = await appFor().request("/api/preferences/models", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ search: { api_keys: { deepseek: null } } }),
    });
    expect(response.status).toBe(200);
    expect(coordinator.getSearchConfig()).toEqual({ provider: "deepseek", api_key: null, api_keys: { brave: "brave-key" }, credential_provider: "deepseek" });
    expect(prefs.getPreferences()).not.toHaveProperty("search_api_key");
  });

  it("rejects invalid reference types before writing preferences", () => {
    const before = prefs.getPreferences();
    expect(() => coordinator.setSearchConfig({ provider: "deepseek", credential_provider: { key: "synthetic-secret" } })).toThrow(/provider ID/);
    expect(prefs.getPreferences()).toEqual(before);
  });

  it("cancels verification in flight without saving or echoing abort details", async () => {
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    fetchMock.mockImplementationOnce((_url, request) => new Promise((_resolve, reject) => {
      request.signal.addEventListener("abort", () => reject(new Error("private key details")));
      entered();
    }));
    const controller = new AbortController();
    const before = prefs.getPreferences();
    const pending = appFor().request(new Request("http://localhost/api/search/verify", {
      method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
      body: JSON.stringify({ provider: "deepseek", api_key: "", credential_provider: "deepseek" }),
    }));
    await ready; controller.abort();
    const body = await (await pending).json();
    expect(body).toMatchObject({ ok: false, code: "cancelled" });
    expect(JSON.stringify(body)).not.toContain("private key details");
    expect(prefs.getPreferences()).toEqual(before);
  });

  it("requires settings scope and secret scope for verification mutations", async () => {
    for (const scopes of [[], ["settings.write"]]) {
      const app = new Hono();
      app.use("*", async (c, next) => { c.set("authPrincipal" as never, { kind: "device", connectionKind: "lan", scopes } as never); await next(); });
      app.route("/api", createConfigRoute(engine()));
      expect((await verify(app, { api_key: "new-key" })).status).toBe(403);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps Auto and old providers selected when adding an unused DeepSeek reference", async () => {
    coordinator.setSearchConfig({ provider: "auto", credential_provider: "deepseek", api_keys: { tavily: "tavily-key" } });
    const instance = createWebSearchTool({ rateLimiter: immediate, searchConfigResolver: () => ({
      ...coordinator.getSearchConfig(), resolveDeepSeekApiKey: () => { throw new Error("must not be used"); },
    }) });
    fetchMock.mockResolvedValueOnce(Response.json({ results: [{ title: "Tavily", url: "https://example.com", content: "Result" }] }));
    expect((await instance.execute("call", { query: "query" })).details).toHaveProperty("provider", "tavily");
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.tavily.com/search");
  });
});
