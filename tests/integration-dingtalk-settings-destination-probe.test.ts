import { Hono } from "hono";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "js-yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentsRoute } from "../server/routes/agents.ts";
import { createBridgeRoute } from "../server/routes/bridge.ts";
import { createConfigRoute } from "../server/routes/config.ts";
import { authorizeHttpRoute } from "../server/http/route-security.ts";
import { saveConfig } from "../lib/memory/config-loader.ts";
import { ConfigCoordinator } from "../core/config-coordinator.ts";
import { MASKED_SECRET } from "../shared/secret-custody.ts";

const trusted = "https://trusted.example.invalid/dingtalk/v1.0";
const other = "https://other.example.invalid/capture";
const secret = "fixture-saved-secret-never-real";
const focusSecret = "fixture-focus-secret-never-real";
const directories: string[] = [];
type FixtureConfig = { bridge?: { dingtalk?: Record<string, unknown> } };

function fixture(saved: Record<string, unknown> = {}, scopes = ["settings.write", "bridge.manage"]) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hana-dingtalk-authority-"));
  directories.push(home);
  const id = "fixture-agent", agentsDir = path.join(home, "agents");
  const directory = path.join(agentsDir, id);
  fs.mkdirSync(directory, { recursive: true });
  const configPath = path.join(directory, "config.yaml");
  fs.writeFileSync(configPath, YAML.dump({ bridge: { dingtalk: {
    corpId: "fixture-corp", clientId: "fixture-client", clientSecret: secret,
    robotCode: "fixture-robot", apiBaseUrl: trusted, enabled: false, ...saved,
  } } }));
  const read = () => YAML.load(fs.readFileSync(configPath, "utf8")) as FixtureConfig;
  const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({
    access_token: "fixture-access", expires_in: 7200,
  }), { status: 200, headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
  const agent = { id, config: read(), updateConfig: vi.fn((patch: Record<string, unknown>) => {
    saveConfig(configPath, patch);
    agent.config = read();
  }) };
  const focusId = "other-focused-agent", focusPath = path.join(agentsDir, focusId, "config.yaml");
  fs.mkdirSync(path.dirname(focusPath), { recursive: true });
  fs.writeFileSync(focusPath, YAML.dump({ bridge: { dingtalk: {
    corpId: "focus-corp", clientId: "focus-client", clientSecret: focusSecret,
    robotCode: "focus-robot", apiBaseUrl: trusted, enabled: false,
  } } }));
  const readFocus = () => YAML.load(fs.readFileSync(focusPath, "utf8")) as FixtureConfig;
  const focus = { id: focusId, config: readFocus(), updateConfig: vi.fn((patch: Record<string, unknown>) => {
    saveConfig(focusPath, patch);
    focus.config = readFocus();
  }) };
  const engine = {
    agentsDir, hanakoHome: home, productDir: path.resolve("."), currentAgentId: focusId,
    getAgent: vi.fn((agentId: string) => agentId === id ? agent : agentId === focusId ? focus : null),
    invalidateAgentListCache: vi.fn(), emitEvent: vi.fn(), setLocale: vi.fn(),
    onProviderChanged: vi.fn(async () => {}),
    providerRegistry: { getAllProvidersRaw: () => ({}), saveProvider: vi.fn() },
    updateConfig: vi.fn(async (patch: Record<string, unknown>, options: { agentId?: string } = {}) => coordinator.updateConfig(patch, options)),
  };
  const coordinator = new ConfigCoordinator({
    getAgent: () => focus, getAgentById: (agentId: string) => engine.getAgent(agentId),
    getActiveAgentId: () => focusId, getModels: () => ({}),
  });
  const manager = { stopPlatform: vi.fn(), startPlatformFromConfig: vi.fn(), getStatus: () => ({}) };
  const principal = { kind: "device", credentialKind: "device_credential", connectionKind: "lan", scopes };
  const app = new Hono<{ Variables: { authPrincipal: unknown } }>();
  app.use("*", async (c, next) => {
    c.set("authPrincipal", principal);
    const auth: { allowed: boolean; error?: string; status?: number } = authorizeHttpRoute({ method: c.req.method, path: c.req.path, principal });
    if (!auth.allowed) return Response.json({ error: auth.error }, { status: auth.status });
    await next();
  });
  app.route("/api", createAgentsRoute(engine));
  app.route("/api", createBridgeRoute(engine, manager));
  app.route("/api", createConfigRoute(engine));
  const request = (url: string, body: unknown, method = "PUT") => app.request(url, {
    method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return {
    read, configPath, agent, focus, focusPath, readFocus, engine, manager, fetchMock, request,
    patch: (dingtalk: unknown, extra = {}) => request("/api/agents/" + id + "/config", { ...extra, bridge: { dingtalk } }),
    test: () => request("/api/bridge/test?agentId=" + id, { platform: "dingtalk", useSavedCredentials: true }, "POST"),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("generic Agent config DingTalk destination authority", () => {
  it("blocks the reported redirect, then still permits testing the original saved endpoint", async () => {
    const f = fixture(), before = fs.readFileSync(f.configPath, "utf8");
    const response = await f.patch({ apiBaseUrl: other });
    const persisted = f.read(), outboundBeforeTest = f.fetchMock.mock.calls.length;
    const testResponse = await f.test(), call = f.fetchMock.mock.calls[0];
    const observation = {
      patchStatus: response.status, persistedDestination: persisted.bridge.dingtalk.apiBaseUrl,
      savedSyntheticSecretRetained: persisted.bridge.dingtalk.clientSecret === secret,
      bytesUnchanged: fs.readFileSync(f.configPath, "utf8") === before,
      outboundBeforeTest, bridgeTestStatus: testResponse.status,
      mockOutboundCount: f.fetchMock.mock.calls.length, mockDestination: call?.[0],
      mockContainsSavedSyntheticSecret: call ? JSON.parse(call[1].body).client_secret === secret : false,
      realNetworkAttempts: (globalThis as typeof globalThis & { __integrationRealNetworkAttempts?: number }).__integrationRealNetworkAttempts ?? 0,
    };
    if (process.env.HANA_A2_EVIDENCE) {
      fs.writeFileSync(path.join(process.env.HANA_A2_EVIDENCE, "observation.json"), JSON.stringify(observation, null, 2));
    }
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "secret_write_scope_required", scope: "secrets.write" });
    expect(observation).toMatchObject({
      persistedDestination: trusted, savedSyntheticSecretRetained: true, bytesUnchanged: true,
      outboundBeforeTest: 0, bridgeTestStatus: 200, mockOutboundCount: 1,
      mockDestination: trusted + "/oauth2/fixture-corp/token", mockContainsSavedSyntheticSecret: true,
      realNetworkAttempts: 0,
    });
    expect(f.engine.updateConfig).not.toHaveBeenCalled();
  });

  it.each([
    { apiBaseUrl: other }, { apiBaseUrl: null }, { apiBaseUrl: "" },
    { corpId: "other-corp" }, { corpId: ".." }, { corpId: "corp/path?query" }, { streamOpenUrl: other },
    { apiBaseUrl: "http://trusted.example.invalid/dingtalk/v1.0" },
    { apiBaseUrl: "https://trusted.example.invalid:8443/dingtalk/v1.0" },
    { streamOpenUrl: "https://trusted.example.invalid/open?capture=1" },
    { clientSecret: MASKED_SECRET, apiBaseUrl: other },
  ])("rejects retained-secret destination changes before all side effects: %j", async patch => {
    const f = fixture({}, ["settings.write", "bridge.manage", "providers.manage"]);
    const before = fs.readFileSync(f.configPath, "utf8");
    const response = await f.patch(patch, { locale: "en", providers: { fixture: { models: [] } } });
    expect(response.status).toBe(403);
    expect(fs.readFileSync(f.configPath, "utf8")).toBe(before);
    expect(f.engine.setLocale).not.toHaveBeenCalled();
    expect(f.engine.providerRegistry.saveProvider).not.toHaveBeenCalled();
    expect(f.engine.updateConfig).not.toHaveBeenCalled();
    expect(f.manager.startPlatformFromConfig).not.toHaveBeenCalled();
    expect(f.fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [{ apiBaseUrl: undefined, restBaseUrl: trusted, clientSecret: undefined, appSecret: secret }, { restBaseUrl: other }],
    [{ restBaseUrl: other }, { apiBaseUrl: null }],
    [{ streamOpenUrl: trusted + "/open" }, { streamOpenUrl: null }],
    [{ corpId: "", authMode: "legacy_app", apiBaseUrl: "https://api.dingtalk.io/v1.0" }, { corpId: "fixture-corp" }],
    [{ corpId: "", authMode: "legacy_app", apiBaseUrl: trusted }, { authMode: null }],
    [{ clientSecret: "", appSecret: secret }, { apiBaseUrl: other }],
    [{ clientSecret: secret, appSecret: "fixture-dormant-secret" }, { clientSecret: null, apiBaseUrl: other }],
  ])("protects aliases, deletion, Stream and auth-mode transitions: %j -> %j", async (saved, patch) => {
    const f = fixture(saved), before = fs.readFileSync(f.configPath, "utf8");
    expect((await f.patch(patch)).status).toBe(403);
    expect(fs.readFileSync(f.configPath, "utf8")).toBe(before);
    expect(f.fetchMock).not.toHaveBeenCalled();
  });

  it("uses persisted credentials even when the runtime copy is stale or unloaded", async () => {
    const f = fixture();
    f.agent.config = { bridge: { dingtalk: { apiBaseUrl: other } } };
    f.engine.getAgent.mockReturnValue(null);
    expect((await f.patch({ apiBaseUrl: other })).status).toBe(403);
    expect(f.read().bridge.dingtalk.apiBaseUrl).toBe(trusted);
  });

  it.each(["missing-runtime", "case-alias"])("binds the guarded disk target to the runtime write: %s", async variant => {
    const f = fixture({ clientSecret: "" });
    if (variant === "missing-runtime") {
      f.engine.getAgent.mockImplementation(id => id === f.focus.id ? f.focus : null);
    }
    const requestId = variant === "case-alias" ? "FIXTURE-AGENT" : "fixture-agent";
    if (variant === "case-alias" && process.platform === "win32") {
      expect(fs.existsSync(path.join(path.dirname(path.dirname(f.configPath)), requestId, "config.yaml"))).toBe(true);
    }
    const before = fs.readFileSync(f.configPath, "utf8"), focusBefore = fs.readFileSync(f.focusPath, "utf8");
    const response = await f.request("/api/agents/" + requestId + "/config", { bridge: { dingtalk: { apiBaseUrl: other } } });
    const testResponse = await f.request("/api/bridge/test?agentId=" + f.focus.id, { platform: "dingtalk", useSavedCredentials: true }, "POST");
    const observation = {
      variant, patchStatus: response.status, focusedDestination: f.readFocus().bridge.dingtalk.apiBaseUrl,
      testStatus: testResponse.status, mockDestination: f.fetchMock.mock.calls[0]?.[0],
      mockContainsFocusedSecret: f.fetchMock.mock.calls[0] ? JSON.parse(f.fetchMock.mock.calls[0][1].body).client_secret === focusSecret : false,
    };
    if (process.env.HANA_A2_EVIDENCE) fs.writeFileSync(path.join(process.env.HANA_A2_EVIDENCE, variant + "-observation.json"), JSON.stringify(observation, null, 2));
    expect(response.status).toBe(404);
    expect(fs.readFileSync(f.configPath, "utf8")).toBe(before);
    expect(fs.readFileSync(f.focusPath, "utf8")).toBe(focusBefore);
    expect(f.engine.updateConfig).not.toHaveBeenCalled();
    expect(observation).toMatchObject({ testStatus: 200, mockDestination: trusted + "/oauth2/focus-corp/token", mockContainsFocusedSecret: true });
  });

  it("keeps a registered target distinct from focus through the real runtime coordinator", async () => {
    const f = fixture({ clientSecret: "" }), focusBefore = fs.readFileSync(f.focusPath, "utf8");
    expect((await f.patch({ apiBaseUrl: other })).status).toBe(200);
    expect(f.read().bridge.dingtalk.apiBaseUrl).toBe(other);
    expect(f.agent.updateConfig).toHaveBeenCalledOnce();
    expect(fs.readFileSync(f.focusPath, "utf8")).toBe(focusBefore);
    expect(f.focus.updateConfig).not.toHaveBeenCalled();
  });

  it("rechecks runtime identity if a provider refresh removes the registered target", async () => {
    const f = fixture({ clientSecret: "" }, ["settings.write", "bridge.manage", "providers.manage"]);
    const before = fs.readFileSync(f.configPath, "utf8"), focusBefore = fs.readFileSync(f.focusPath, "utf8");
    f.engine.onProviderChanged.mockImplementation(async () => {
      f.engine.getAgent.mockImplementation(id => id === f.focus.id ? f.focus : null);
    });
    expect((await f.patch({ apiBaseUrl: other }, { providers: { fixture: { models: [] } } })).status).toBe(404);
    expect(fs.readFileSync(f.configPath, "utf8")).toBe(before);
    expect(f.readFocus().bridge.dingtalk.apiBaseUrl).toBe(trusted);
    // The existing global provider refresh may rewrite focus with an empty
    // patch; the destination-bearing patch must never reach that fallback.
    expect(f.focus.updateConfig.mock.calls.every(([patch]) => Object.keys(patch).length === 0)).toBe(true);
    expect(YAML.load(fs.readFileSync(f.focusPath, "utf8"))).toEqual(YAML.load(focusBefore));
  });

  it("rechecks persisted state after an awaited provider refresh", async () => {
    const f = fixture({ clientSecret: "" }, ["settings.write", "bridge.manage", "providers.manage"]);
    f.engine.onProviderChanged.mockImplementation(async () => {
      saveConfig(f.configPath, { bridge: { dingtalk: { clientSecret: secret } } });
    });
    expect((await f.patch({ apiBaseUrl: other }, { providers: { fixture: { models: [] } } })).status).toBe(403);
    expect(f.read().bridge.dingtalk).toMatchObject({ apiBaseUrl: trusted, clientSecret: secret });
    expect(f.fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    trusted + "/", "HTTPS://TRUSTED.EXAMPLE.INVALID:443/dingtalk/v1.0/",
    trusted + "?ignored=1#ignored", "https://trusted.example.invalid/dingtalk/./v1.0",
  ])("permits an equivalent API destination and preserves its saved key: %s", async apiBaseUrl => {
    const f = fixture();
    expect((await f.patch({ apiBaseUrl })).status).toBe(200);
    expect((await f.test()).status).toBe(200);
    expect(f.fetchMock).toHaveBeenCalledOnce();
    expect(f.fetchMock.mock.calls[0][0]).toBe(trusted + "/oauth2/fixture-corp/token");
    expect(JSON.parse(f.fetchMock.mock.calls[0][1].body).client_secret).toBe(secret);
  });

  it("permits equivalent current-mode legacy default URLs", async () => {
    const f = fixture({ apiBaseUrl: "https://api.dingtalk.com/v1.0" });
    expect((await f.patch({ apiBaseUrl: "https://API.DINGTALK.IO:443/v1.0/" })).status).toBe(200);
    await f.test();
    expect(f.fetchMock.mock.calls[0][0]).toBe("https://api.dingtalk.com/v1.0/oauth2/fixture-corp/token");
  });

  it("preserves equivalent Stream URLs while guarding query changes", async () => {
    const f = fixture({ streamOpenUrl: "https://trusted.example.invalid/open?channel=1" });
    expect((await f.patch({ streamOpenUrl: "https://TRUSTED.example.invalid:443/open?channel=1#ignored" })).status).toBe(200);
    expect((await f.patch({ streamOpenUrl: "https://trusted.example.invalid/open?channel=2" })).status).toBe(403);
    expect(f.read().bridge.dingtalk.clientSecret).toBe(secret);
  });

  it("rejects malformed destination changes without blocking an authorized repair", async () => {
    const f = fixture();
    expect((await f.patch({ apiBaseUrl: "file:///fixture-only" })).status).toBe(400);
    expect(f.read().bridge.dingtalk.apiBaseUrl).toBe(trusted);
    const authorized = fixture({ apiBaseUrl: "invalid-url" }, ["settings.write", "bridge.manage", "secrets.write"]);
    expect((await authorized.patch({ apiBaseUrl: other })).status).toBe(200);
    await authorized.test();
    expect(authorized.fetchMock.mock.calls[0][0]).toBe(other + "/oauth2/fixture-corp/token");
  });

  it("preserves generic merge precedence but rejects subsequently exposing a changed alias", async () => {
    const f = fixture();
    expect((await f.patch({ restBaseUrl: other })).status).toBe(200);
    expect((await f.patch({ apiBaseUrl: null })).status).toBe(403);
    await f.test();
    expect(f.fetchMock.mock.calls[0][0]).toBe(trusted + "/oauth2/fixture-corp/token");
  });

  it.each([{}, { clientSecret: undefined, appSecret: secret }])("keeps masked credentials unchanged: %j", async saved => {
    const f = fixture(saved);
    expect((await f.patch({ clientSecret: MASKED_SECRET, appSecret: MASKED_SECRET, apiBaseUrl: trusted + "/" })).status).toBe(200);
    await f.test();
    expect(f.fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(f.fetchMock.mock.calls[0][1].body).client_secret).toBe(secret);
  });

  it.each([{ apiBaseUrl: other }, { apiBaseUrl: null, restBaseUrl: other }, { corpId: "other-corp" }])(
    "permits authorized destination changes with the saved key: %j", async patch => {
      const f = fixture({}, ["settings.write", "bridge.manage", "secrets.write"]);
      expect((await f.patch(patch)).status).toBe(200);
      expect((await f.test()).status).toBe(200);
      expect(f.fetchMock).toHaveBeenCalledOnce();
      expect(JSON.parse(f.fetchMock.mock.calls[0][1].body).client_secret).toBe(secret);
      expect(f.fetchMock.mock.calls[0][0]).toBe(patch.corpId
        ? trusted + "/oauth2/other-corp/token" : other + "/oauth2/fixture-corp/token");
    },
  );

  it.each([null, { clientSecret: null, appSecret: null, apiBaseUrl: other }, { clientSecret: "", appSecret: "", apiBaseUrl: other }])(
    "preserves deletion of all credential copies: %j", async patch => {
      const f = fixture({ appSecret: "fixture-legacy-secret" });
      expect((await f.patch(patch)).status).toBe(200);
      expect(await (await f.test()).json()).toMatchObject({ ok: false });
      expect(f.fetchMock).not.toHaveBeenCalled();
    },
  );

  it("permits destination-only setup when no saved secret exists", async () => {
    const f = fixture({ clientSecret: "" });
    expect((await f.patch({ apiBaseUrl: other })).status).toBe(200);
    expect(f.read().bridge.dingtalk.apiBaseUrl).toBe(other);
    expect(f.fetchMock).not.toHaveBeenCalled();
  });

  it("preserves deletion of the whole bridge block", async () => {
    const f = fixture();
    expect((await f.request("/api/agents/fixture-agent/config", { bridge: null })).status).toBe(200);
    expect(f.read().bridge).toBeUndefined();
    expect(f.fetchMock).not.toHaveBeenCalled();
  });

  it("does not restore a stale masked key across a provider refresh", async () => {
    const f = fixture({}, ["settings.write", "bridge.manage", "providers.manage"]);
    f.engine.onProviderChanged.mockImplementation(async () => {
      saveConfig(f.configPath, { bridge: { dingtalk: { clientSecret: "fixture-rotated-secret" } } });
    });
    expect((await f.patch({ clientSecret: MASKED_SECRET, apiBaseUrl: trusted }, { providers: { fixture: { models: [] } } })).status).toBe(200);
    await f.test();
    expect(JSON.parse(f.fetchMock.mock.calls[0][1].body).client_secret).toBe("fixture-rotated-secret");
  });

  it("preserves ordinary config edits with invalid stored DingTalk URLs", async () => {
    const f = fixture({ apiBaseUrl: "invalid-url" }, ["settings.write"]);
    expect((await f.patch({ enabled: false, owner: "fixture-owner" }, { locale: "en" })).status).toBe(200);
    expect(f.engine.setLocale).toHaveBeenCalledWith("en");
    expect(f.read().bridge.dingtalk).toMatchObject({ apiBaseUrl: "invalid-url", clientSecret: secret, owner: "fixture-owner" });
  });

  it("keeps /api/config global-only and preserves the existing route scopes", async () => {
    const f = fixture({}, ["settings.write"]);
    expect((await f.request("/api/config", { bridge: { dingtalk: { apiBaseUrl: other } } })).status).toBe(400);
    expect((await f.test()).status).toBe(403);
    expect((await f.patch({ apiBaseUrl: other })).status).toBe(403);
    const bridgeOnly = fixture({}, ["bridge.manage"]);
    expect((await bridgeOnly.patch({ apiBaseUrl: trusted })).status).toBe(403);
    expect((await bridgeOnly.test()).status).toBe(200);
  });
});
