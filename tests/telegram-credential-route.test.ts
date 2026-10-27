import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
const { transport } = vi.hoisted(() => ({ transport: vi.fn() }));
vi.mock("../lib/net/telegram-fetch.ts", async importOriginal => {
  const actual = await importOriginal<typeof import("../lib/net/telegram-fetch.ts")>();
  return { ...actual, telegramApiOptions: () => actual.telegramApiOptions(transport) };
});
import { createBridgeRoute } from "../server/routes/bridge.ts";

describe("Telegram saved credential probe using the real Api export", () => {
  it.each([false, true])("probes getMe once without polling or changing config (failure=%s)", async failure => {
    transport.mockReset();
    const token = "12345:SYNTHETIC_SAVED_ONLY";
    transport.mockImplementation(async () => Response.json(failure
      ? { ok: false, error_code: 429, description: `bad ${token} https://api.telegram.org/bot${token}/getMe`, parameters: { retry_after: 4 } }
      : { ok: true, result: { id: 1, username: "synthetic", first_name: "Test" } }));
    const config = { bridge: { telegram: { token, enabled: false, owner: "synthetic-owner" } } };
    const agent = { id: "u17", config, updateConfig: vi.fn() };
    const manager = { startPlatformFromConfig: vi.fn(), stopPlatform: vi.fn() };
    const app = new Hono();
    app.route("/api", createBridgeRoute({ getAgent: () => agent, currentAgentId: "u17" }, manager));
    const response = await app.request("/api/bridge/test?agentId=u17", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ platform: "telegram", useSavedCredentials: true, credentials: {} }),
    });
    const body = await response.json();
    expect(body.ok).toBe(!failure);
    if (failure) expect(body.error).toContain("429");
    expect(transport).toHaveBeenCalledOnce();
    expect(transport.mock.calls[0][0]).toBe(`https://api.telegram.org/bot${token}/getMe`);
    expect(transport.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    expect(JSON.stringify(body)).not.toContain(token);
    expect(agent.updateConfig).not.toHaveBeenCalled();
    expect(manager.startPlatformFromConfig).not.toHaveBeenCalled();
    expect(config.bridge.telegram).toEqual({ token, enabled: false, owner: "synthetic-owner" });
  });
});

it("withholds legacy token-bearing avatar metadata without rewriting saved records", async () => {
  const token = "12345:SYNTHETIC_LEGACY_ONLY";
  const raw = { file: "legacy.jsonl", userId: "123", name: "Legacy", avatarUrl: `https://api.telegram.org/file/bot${token}/photos/file.jpg` };
  const agent = { id: "u17", sessionDir: "/tmp/u17-avatar-test", config: { bridge: { telegram: { owner: "123" } } } };
  const app = new Hono();
  app.route("/api", createBridgeRoute({ getAgent: () => agent, currentAgentId: "u17", getBridgeIndex: () => ({ "tg_dm_123@u17": raw }) }, {}));
  const response = await app.request("/api/bridge/sessions?agentId=u17");
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.sessions[0]).toMatchObject({ avatarUrl: null, displayName: "Legacy", isOwner: true });
  expect(JSON.stringify(body)).not.toContain(token);
  expect(raw.avatarUrl).toContain(token);
  const { collectKnownUsers, resolveBridgeSessionIdentity } = await import("../lib/bridge/session-key.ts");
  expect(JSON.stringify(collectKnownUsers({ "tg_dm_123@u17": raw }))).not.toContain(token);
  const safe = { ...raw, avatarUrl: "data:image/png;base64,AAAA" };
  expect(resolveBridgeSessionIdentity(safe, { sessionKey: "tg_dm_123@u17" }).avatarUrl).toBe(safe.avatarUrl);
});
