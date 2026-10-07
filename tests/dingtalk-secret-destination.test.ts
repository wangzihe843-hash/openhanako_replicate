import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBridgeRoute } from "../server/routes/bridge.ts";
import { MASKED_SECRET } from "../shared/secret-custody.ts";

const trusted = "https://trusted.example.invalid/dingtalk/v1.0";
const other = "https://other.example.invalid/capture";
function fixture(scopes = ["bridge.manage"], saved = {}) {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ access_token: "fixture-access", expires_in: 7200 }), {
    status: 200, headers: { "Content-Type": "application/json" },
  }));
  vi.stubGlobal("fetch", fetchMock);
  const agent = {
    id: "fixture-agent", config: { bridge: { dingtalk: {
      corpId: "fixture-corp", clientId: "fixture-client", clientSecret: "fixture-saved-secret", robotCode: "fixture-robot",
      apiBaseUrl: trusted, enabled: false, ...saved,
    } } },
    updateConfig: vi.fn((patch: { bridge: { dingtalk: Record<string, unknown> } }): void => { Object.assign(agent.config.bridge.dingtalk, patch.bridge.dingtalk); }),
  };
  const manager = { stopPlatform: vi.fn(), startPlatformFromConfig: vi.fn(), getStatus: () => ({}) };
  const app = new Hono<{ Variables: { authPrincipal: unknown } }>();
  app.use("*", async (c, next) => {
    c.set("authPrincipal", { kind: "device", credentialKind: "device_credential", connectionKind: "lan", scopes });
    await next();
  });
  app.route("/api", createBridgeRoute({ currentAgentId: agent.id, getAgent: id => id === agent.id ? agent : null }, manager));
  const request = (route: string, credentials: Record<string, unknown>) => app.request(`/api/bridge/${route}?agentId=${agent.id}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ platform: "dingtalk", useSavedCredentials: true, credentials, enabled: true }),
  });
  return { request, fetchMock, agent, manager };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("DingTalk saved credential destination authority", () => {
  for (const route of ["config", "test"]) {
    it.each([
      { apiBaseUrl: other },
      { corpId: "other-corp" },
      { corpId: "..", apiBaseUrl: trusted + "/oauth2/fixture-corp" },
      { restBaseUrl: other },
      { apiBaseUrl: null },
      { restBaseUrl: "" },
      { streamOpenUrl: other },
      { clientSecret: MASKED_SECRET, apiBaseUrl: other },
      { appSecret: MASKED_SECRET, restBaseUrl: other },
    ])(`${route} rejects changed destinations before persistence or outbound requests: %j`, async credentials => {
      const f = fixture();
      const res = await f.request(route, credentials);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: "secret_write_scope_required", scope: "secrets.write" });
      expect(f.fetchMock).not.toHaveBeenCalled();
      expect(f.agent.updateConfig).not.toHaveBeenCalled();
      expect(f.manager.startPlatformFromConfig).not.toHaveBeenCalled();
    });

    it(`${route} guards implicit destination changes when upgrading legacy credentials`, async () => {
      const f = fixture(["bridge.manage"], { corpId: "", authMode: "legacy_app", apiBaseUrl: "https://api.dingtalk.io/v1.0" });
      const res = await f.request(route, { corpId: "fixture-corp" });
      expect(res.status).toBe(403);
      expect(f.fetchMock).not.toHaveBeenCalled();
      expect(f.agent.updateConfig).not.toHaveBeenCalled();
    });

    it(`${route} retains the original normalized destination without secret scope`, async () => {
      const f = fixture();
      const res = await f.request(route, { apiBaseUrl: trusted + "/", restBaseUrl: other, clientSecret: MASKED_SECRET });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true });
      if (route === "test") {
        expect(f.fetchMock).toHaveBeenCalledOnce();
        expect(f.fetchMock.mock.calls[0][0]).toBe(trusted + "/oauth2/fixture-corp/token");
        expect(JSON.parse(f.fetchMock.mock.calls[0][1].body)).toMatchObject({ client_secret: "fixture-saved-secret" });
      } else expect(f.manager.startPlatformFromConfig).toHaveBeenCalledOnce();
    });

    it(`${route} permits an explicitly authorized destination change`, async () => {
      const f = fixture(["bridge.manage", "secrets.write"]);
      const res = await f.request(route, { restBaseUrl: other });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true });
    });
  }
});
