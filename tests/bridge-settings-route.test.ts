import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

import { createBridgeRoute } from "../server/routes/bridge.ts";

import { bridgeHttpLoopback } from "./fixtures/bridge-http-loopback.ts";

function makeApp() {
  let readOnly = false;
  let receiptEnabled = false;
  let richStreamingEnabled = true;
  let permissionMode = "operate";
  const agent = {
    id: "hana",
    sessionDir: "/tmp/hana-bridge-settings",
    config: { bridge: {} },
    updateConfig: vi.fn(),
  };
  const engine = {
    currentAgentId: "hana",
    getAgent: vi.fn((id) => id === "hana" ? agent : null),
    getBridgeIndex: vi.fn(() => ({})),
    getBridgeReadOnly: vi.fn(() => readOnly),
    setBridgeReadOnly: vi.fn((next) => { readOnly = !!next; }),
    getBridgePermissionMode: vi.fn(() => permissionMode),
    setBridgePermissionMode: vi.fn((next) => { permissionMode = next; }),
    getBridgeReceiptEnabled: vi.fn(() => receiptEnabled),
    setBridgeReceiptEnabled: vi.fn((next) => { receiptEnabled = !!next; }),
    getBridgeRichStreamingEnabled: vi.fn(() => richStreamingEnabled),
    setBridgeRichStreamingEnabled: vi.fn((next) => { richStreamingEnabled = !!next; }),
  };
  const bridgeManager = {
    getStatus: vi.fn(() => ({})),
    getMessages: vi.fn(() => []),
    stopPlatform: vi.fn(),
    startPlatformFromConfig: vi.fn(),
  };
  const app = new Hono();
  app.route("/api", createBridgeRoute(engine, bridgeManager));
  return { app, engine };
}

describe("bridge settings route", () => {
  it("returns the persisted global bridge settings after saving", async () => {
    const { app, engine } = makeApp();

    const res = await app.request("/api/bridge/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ readOnly: true, receiptEnabled: true }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(engine.setBridgeReadOnly).toHaveBeenCalledWith(true);
    expect(engine.setBridgeReceiptEnabled).toHaveBeenCalledWith(true);
    expect(body).toEqual({
      ok: true,
      readOnly: true,
      permissionMode: "read_only",
      receiptEnabled: true,
      richStreamingEnabled: true,
    });
  });

  it("persists the explicit bridge permission mode while preserving legacy readOnly shape", async () => {
    const { app, engine } = makeApp();

    const res = await app.request("/api/bridge/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ permissionMode: "auto" }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(engine.setBridgePermissionMode).toHaveBeenCalledWith("auto");
    expect(engine.setBridgeReadOnly).not.toHaveBeenCalled();
    expect(body).toEqual({
      ok: true,
      readOnly: false,
      permissionMode: "auto",
      receiptEnabled: false,
      richStreamingEnabled: true,
    });
  });

  it("persists the bridge rich streaming compatibility switch", async () => {
    const { app, engine } = makeApp();

    const res = await app.request("/api/bridge/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ richStreamingEnabled: false }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(engine.setBridgeRichStreamingEnabled).toHaveBeenCalledWith(false);
    expect(body).toEqual({
      ok: true,
      readOnly: false,
      permissionMode: "operate",
      receiptEnabled: false,
      richStreamingEnabled: false,
    });
  });
});


describe("bridge credential-test redirect policy over HTTPS loopback", () => {
  let loop: Awaited<ReturnType<typeof bridgeHttpLoopback>>;
  const nativeFetch = globalThis.fetch;
  beforeAll(async () => { loop = await bridgeHttpLoopback(); });
  afterEach(() => { vi.unstubAllGlobals(); });
  afterAll(async () => { await loop?.close(); });

  function request(platform: "qq" | "dingtalk", legacy = false) {
    const { app } = makeApp();
    return app.request("/api/bridge/test", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform, credentials: platform === "qq"
        ? { appID: "SYNTHETIC_ID", appSecret: "SYNTHETIC_BODY_SECRET" }
        : { clientId: "SYNTHETIC_ID", clientSecret: "SYNTHETIC_BODY_SECRET", robotCode: "SYNTHETIC_ROBOT", ...(legacy ? { authMode: "legacy_app" } : { corpId: "SYNTHETIC_CORP" }) } }),
    });
  }
  function remapToLoopback() {
    // These exact original API URLs are identifiers only. Every real fetch is
    // rewritten to loopback BEFORE transport; the dispatcher also denies egress.
    const fetchSpy = vi.fn((url: string, init: RequestInit) => {
      const parsed = new URL(url);
      if (!["bots.qq.com", "api.sgroup.qq.com", "api.dingtalk.com", "api.dingtalk.io"].includes(parsed.hostname)) throw new Error("Unexpected credential-test origin");
      const requestInit = { ...init, dispatcher: loop.agent };
      return nativeFetch(loop.source + parsed.pathname, requestInit);
    });
    vi.stubGlobal("fetch", fetchSpy);
    return fetchSpy;
  }

  for (const stage of ["qq-token", "qq-me", "dingtalk-current", "dingtalk-legacy"] as const) {
    for (const destination of ["same-origin", "cross-host", "downgrade"] as const) {
      it.each([301, 302, 303, 307, 308])(`${stage} ${destination} rejects %i before destination contact`, async status => {
        loop.reset();
        const spy = remapToLoopback();
        loop.respond((req, response) => {
          if (stage === "qq-me" && req.path.endsWith("getAppAccessToken")) {
            response.end(JSON.stringify({ access_token: "SYNTHETIC_AUTH_TOKEN" }));
          } else {
            const origin = destination === "same-origin" ? loop.source : destination === "cross-host" ? loop.sink : loop.downgrade;
            response.writeHead(status, { Location: origin + "/capture?secret=SYNTHETIC_LOCATION_SECRET" });
            response.end("SYNTHETIC_RESPONSE_SECRET");
          }
        });
        const response = await request(stage.startsWith("qq") ? "qq" : "dingtalk", stage === "dingtalk-legacy");
        const result = await response.json();
        expect(result.ok).toBe(false);
        expect(result.error).toContain("redirect refused");
        expect(JSON.stringify(result)).not.toMatch(/SYNTHETIC_|capture/);
        expect(loop.sourceRequests).toHaveLength(stage === "qq-me" ? 2 : 1);
        expect(loop.sinkRequests).toEqual([]);
        expect(spy).toHaveBeenCalledTimes(stage === "qq-me" ? 2 : 1);
        for (const [, init] of spy.mock.calls) expect(init.redirect).toBe("manual");
        if (stage === "qq-me") expect(loop.sourceRequests[1].headers.authorization).toBe("QQBot SYNTHETIC_AUTH_TOKEN");
        else expect(loop.sourceRequests[0].body).toContain("SYNTHETIC_BODY_SECRET");
      });
    }
  }

  it.each(["qq", "dingtalk"] as const)("preserves successful %s credential response", async platform => {
    loop.reset();
    remapToLoopback();
    loop.respond((req, response) => response.end(JSON.stringify(req.path === "/users/@me"
      ? { id: "bot", username: "synthetic-bot" }
      : { access_token: "SYNTHETIC_AUTH_TOKEN", expires_in: 7200 })));
    const response = await request(platform);
    expect(await response.json()).toMatchObject({ ok: true });
    expect(loop.sourceRequests).toHaveLength(platform === "qq" ? 2 : 1);
    expect(loop.sinkRequests).toEqual([]);
  });
});
