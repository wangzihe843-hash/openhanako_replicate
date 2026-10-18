import { Hono } from "hono";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigCoordinator } from "../core/config-coordinator.ts";
import { PreferencesManager } from "../core/preferences-manager.ts";
import { ProviderRegistry } from "../core/provider-registry.ts";
import { ModelManager } from "../core/model-manager.ts";
import { resolveDeepSeekFetchApiKey } from "../core/deepseek-tool-credentials.ts";
import { createPreferencesRoute } from "../server/routes/preferences.ts";
import { createWebFetchTool } from "../lib/tools/web-fetch.ts";
import { createSearchRateLimiter } from "../lib/tools/search-rate-limiter.ts";

vi.mock("dns/promises", () => ({ lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]) }));
let root: string;
let registry: ProviderRegistry;
let prefs: PreferencesManager;
let coordinator: ConfigCoordinator;
const fetchMock = vi.fn<typeof fetch>();
const endpoint = "https://api.deepseek.com/v1/tools/fetch";
function credentialSource() {
  return { providerRegistry: registry, resolveProviderCredentials: (id: string) => ModelManager.prototype.resolveProviderCredentials.call({ providerRegistry: registry }, id) };
}
function resolveKey() { return resolveDeepSeekFetchApiKey(coordinator.getWebFetchConfig(), coordinator.getSearchConfig(), credentialSource()); }
function saveProvider(id = "official", patch = {}) {
  registry.saveProvider(id, { base_url: "https://api.deepseek.com", api_key: `synthetic-${id}-key`, models: ["deepseek-chat"], ...patch });
}
function appFor(scopes?: string[]) {
  const app = new Hono();
  if (scopes) app.use("*", async (c, next) => { c.set("authPrincipal" as never, { kind: "device", connectionKind: "lan", scopes } as never); await next(); });
  app.route("/api", createPreferencesRoute({
    ...credentialSource(), hanakoHome: root, config: {},
    getSearchConfig: () => coordinator.getSearchConfig(), setSearchConfig: patch => coordinator.setSearchConfig(patch),
    getWebFetchConfig: () => coordinator.getWebFetchConfig(), setWebFetchConfig: patch => coordinator.setWebFetchConfig(patch),
    getSharedModels: () => ({}), getUtilityApi: () => ({}), emitEvent: vi.fn(),
  }));
  return app;
}
function save(patch: unknown, scopes?: string[]) {
  return appFor(scopes).request("/api/preferences/models", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ web_fetch: patch }) });
}
function tool(rateLimiter = { run: (_provider, _type, operation) => operation() }) {
  return createWebFetchTool({ fetchConfigResolver: () => ({ ...coordinator.getWebFetchConfig(), resolveApiKey: resolveKey }), rateLimiter });
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-fetch-config-"));
  registry = new ProviderRegistry(root);
  prefs = new PreferencesManager({ userDir: path.join(root, "user"), agentsDir: path.join(root, "agents") });
  coordinator = new ConfigCoordinator({ getPrefs: () => prefs });
  saveProvider();
  fetchMock.mockReset().mockImplementation(async url => url === endpoint ? Response.json({ title: "", content: "Markdown" }) : new Response("Direct", { headers: { "Content-Type": "text/plain" } }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); fs.rmSync(root, { recursive: true, force: true }); });

describe("independent Fetch opt-in and credential custody", () => {
  it("keeps default direct behavior despite existing Search/model credentials", async () => {
    coordinator.setSearchConfig({ provider: "deepseek", api_key: "synthetic-search-key", credential_provider: "official" });
    expect(coordinator.getWebFetchConfig().provider).toBe("direct");
    const result = await tool().execute("read", { url: "https://example.com/?q=public" });
    expect(result.details.readEvidence.status).toBe("complete");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).not.toBe(endpoint);
    expect(() => resolveKey()).toThrow(/not enabled/);
  });
  it("reuses a Search override, including when Search itself is in Auto, without copying it", async () => {
    coordinator.setSearchConfig({ provider: "auto", api_keys: { deepseek: "synthetic-search-key", brave: "wrong-key" }, credential_provider: "missing" });
    coordinator.setWebFetchConfig({ provider: "deepseek" });
    expect(resolveKey()).toBe("synthetic-search-key");
    expect(prefs.getPreferences()).not.toHaveProperty("web_fetch_api_key");
  });
  it("reuses the pinned Search account and observes rotations without persisting the key", () => {
    coordinator.setSearchConfig({ provider: "deepseek", credential_provider: "official" });
    coordinator.setWebFetchConfig({ provider: "deepseek" });
    expect(resolveKey()).toBe("synthetic-official-key");
    saveProvider("official", { api_key: "synthetic-rotated", display_name: "New display name" });
    expect(resolveKey()).toBe("synthetic-rotated");
    expect(JSON.stringify(prefs.getPreferences())).not.toContain("synthetic-");
  });
  it("applies Fetch override > Fetch account > Search override > Search account precedence", async () => {
    saveProvider("second");
    coordinator.setSearchConfig({ provider: "deepseek", api_key: "synthetic-search", credential_provider: "official" });
    coordinator.setWebFetchConfig({ provider: "deepseek", api_key: "synthetic-fetch", credential_provider: "second" });
    expect(resolveKey()).toBe("synthetic-fetch");
    expect((await save({ api_key: "" })).status).toBe(200);
    expect(resolveKey()).toBe("synthetic-second-key");
    expect((await save({ credential_provider: "" })).status).toBe(200);
    expect(resolveKey()).toBe("synthetic-search");
    coordinator.setSearchConfig({ api_key: "" });
    expect(resolveKey()).toBe("synthetic-official-key");
  });
  it("requires an explicit reference and never borrows another provider's legacy key", () => {
    saveProvider("second");
    coordinator.setSearchConfig({ provider: "brave", api_key: "must-not-send" });
    coordinator.setWebFetchConfig({ provider: "deepseek" });
    expect(() => resolveKey()).toThrow(/explicit selection/);
  });
  it.each(["deleted", "id_renamed", "proxy", "empty_key", "oauth"])("fails closed for an explicit %s reference despite valid Search credentials", async failure => {
    coordinator.setSearchConfig({ provider: "deepseek", api_key: "synthetic-search" });
    coordinator.setWebFetchConfig({ provider: "deepseek", credential_provider: "official" });
    if (failure === "deleted" || failure === "id_renamed") { registry.removeProvider("official"); saveProvider("replacement"); }
    if (failure === "proxy") saveProvider("official", { base_url: "https://proxy.example" });
    if (failure === "empty_key") saveProvider("official", { api_key: "" });
    if (failure === "oauth") saveProvider("official", { auth_type: "oauth" });
    const result = await tool().execute("read", { url: "https://example.com/" });
    expect(result.isError).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => url === endpoint)).toBe(false);
  });
  it("also rejects an effective proxy endpoint before sending its key", () => {
    coordinator.setWebFetchConfig({ provider: "deepseek", credential_provider: "official" });
    const source = { providerRegistry: registry, resolveProviderCredentials: () => ({ api_key: "proxy-key", base_url: "https://proxy.example" }) };
    expect(() => resolveDeepSeekFetchApiKey(coordinator.getWebFetchConfig(), {}, source)).toThrow(/official/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("projects only masks and reference IDs without resolving model credentials", async () => {
    coordinator.setWebFetchConfig({ provider: "deepseek", api_key: "synthetic-fetch", credential_provider: "official" });
    const resolver = vi.spyOn(ModelManager.prototype, "resolveProviderCredentials");
    const body = await (await appFor().request("/api/preferences/models")).json();
    expect(body.web_fetch).toEqual({ provider: "deepseek", api_key: "********", credential_provider: "official" });
    expect(JSON.stringify(body)).not.toContain("synthetic-");
    expect(resolver).not.toHaveBeenCalled();
    await save({ api_key: "********" });
    expect(coordinator.getWebFetchConfig().api_key).toBe("synthetic-fetch");
  });
  it("saving opt-in/reference is local and preserves Search configuration", async () => {
    coordinator.setSearchConfig({ provider: "deepseek", credential_provider: "official" });
    const search = coordinator.getSearchConfig();
    expect((await save({ provider: "deepseek", credential_provider: "official" })).status).toBe(200);
    expect(coordinator.getSearchConfig()).toEqual(search);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each([null, [], "deepseek", { provider: "auto" }, { credential_provider: {} }, { api_key: 42 }])("rejects malformed config %# without writes", async patch => {
    const before = prefs.getPreferences();
    expect((await save(patch)).status).toBe(400);
    expect(prefs.getPreferences()).toEqual(before);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("preserves the explicit Fetch reference across a preferences restart without copying model keys", () => {
    coordinator.setWebFetchConfig({ provider: "deepseek", credential_provider: "official" });
    prefs = new PreferencesManager({ userDir: path.join(root, "user"), agentsDir: path.join(root, "agents") });
    coordinator = new ConfigCoordinator({ getPrefs: () => prefs });
    expect(resolveKey()).toBe("synthetic-official-key");
    expect(prefs.getPreferences()).toMatchObject({ web_fetch_provider: "deepseek", web_fetch_credential_provider: "official" });
    expect(JSON.stringify(prefs.getPreferences())).not.toContain("synthetic-");
  });
  it("requires settings scope and existing secret scope for independent keys", async () => {
    expect((await save({ provider: "deepseek" }, [])).status).toBe(403);
    expect((await save({ api_key: "new-key" }, ["settings.write"])).status).toBe(403);
    expect((await save({ provider: "deepseek", credential_provider: "official" }, ["settings.write"])).status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each(["disabled", "deleted", "proxy", "rotated"])("re-resolves %s state after queueing", async change => {
    vi.useFakeTimers();
    coordinator.setWebFetchConfig({ provider: "deepseek", credential_provider: "official" });
    const limiter = createSearchRateLimiter();
    const instance = tool(limiter);
    await instance.execute("first", { url: "https://example.com/" });
    const pending = instance.execute("second", { url: "https://example.com/" });
    await vi.advanceTimersByTimeAsync(0);
    if (change === "disabled") coordinator.setWebFetchConfig({ provider: "direct" });
    if (change === "deleted") registry.removeProvider("official");
    if (change === "proxy") saveProvider("official", { base_url: "https://proxy.example" });
    if (change === "rotated") saveProvider("official", { api_key: "synthetic-rotated" });
    await vi.advanceTimersByTimeAsync(200);
    const result = await pending;
    const requests = fetchMock.mock.calls.filter(([url]) => url === endpoint);
    if (change === "rotated") {
      expect(requests).toHaveLength(2);
      expect(requests[1][1]?.headers).toHaveProperty("Authorization", "Bearer synthetic-rotated");
    } else {
      expect(result.isError).toBe(true); expect(requests).toHaveLength(1);
    }
    limiter.reset();
  });
});
