import { describe, expect, it, vi } from "vitest";
import os from "os";

const createTelegramAdapter = vi.fn();
const createFeishuAdapter = vi.fn();
const createDingTalkAdapter = vi.fn();
const createQQAdapter = vi.fn();
const createWechatAdapter = vi.fn();

vi.mock("../lib/bridge/telegram-adapter.js", () => ({
  createTelegramAdapter: (...args) => createTelegramAdapter(...args),
}));
vi.mock("../lib/bridge/feishu-worker-adapter.ts", () => ({
  createFeishuWorkerAdapter: (...args) => createFeishuAdapter(...args),
}));
vi.mock("../lib/bridge/dingtalk-adapter.js", () => ({
  createDingTalkAdapter: (...args) => createDingTalkAdapter(...args),
}));
vi.mock("../lib/bridge/qq-adapter.js", () => ({
  createQQAdapter: (...args) => createQQAdapter(...args),
}));
vi.mock("../lib/bridge/wechat-adapter.js", () => ({
  createWechatAdapter: (...args) => createWechatAdapter(...args),
}));
vi.mock("../lib/debug-log.js", () => ({
  debugLog: () => null,
  createModuleLogger: () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { BridgeManager } from "../lib/bridge/bridge-manager.ts";
import { Hono } from "hono";
import { createBridgeRoute } from "../server/routes/bridge.ts";

describe("BridgeManager platform status", () => {
  it("passes the optional WeChat endpoint from per-agent config into the adapter", () => {
    createWechatAdapter.mockReset();
    createWechatAdapter.mockReturnValue({ stop: vi.fn() });
    const bm = new BridgeManager({ engine: { hanakoHome: os.tmpdir(), getAgent: () => null }, hub: { eventBus: { emit: vi.fn() } } });
    bm.startPlatformFromConfig("wechat", { enabled: true, botToken: "SYN_TOKEN", baseUrl: "https://ilinkai.weixin.qq.com/" }, "a");
    expect(createWechatAdapter.mock.calls[0][0]).toMatchObject({ botToken: "SYN_TOKEN", baseUrl: "https://ilinkai.weixin.qq.com/", agentId: "a" });
    bm.stopAll(); createWechatAdapter.mockReset();
  });

  it("sanitizes startup/config errors and defensive status reads while retaining error identity", () => {
    createTelegramAdapter.mockReset();
    const cause = Object.assign(new TypeError("ticket=fixtureCause X-Auth-Token=SYN_HEADER_CAUSE"), { code: "ECONNRESET" });
    const error = Object.assign(new Error("appSecret=fixtureStart", { cause }), { code: 0, httpStatus: 503, stage: "connect" });
    createTelegramAdapter.mockImplementation(() => { throw error; });
    const engine = { hanakoHome: os.tmpdir(), agent: null, getAgent: () => null };
    const hub = { eventBus: { emit: vi.fn() } };
    const bm = new BridgeManager({ engine, hub });
    bm.startPlatform("telegram", { token: "fixtureInput" }, "hana");
    bm._setPlatformConfigError("qq", "hana", error);
    const state = bm.getStatus("hana");
    for (const platform of ["telegram", "qq"]) {
      expect(state[platform].error).not.toMatch(/fixtureStart|fixtureCause|SYN_HEADER_CAUSE/);
      expect(state[platform].error).toContain("ECONNRESET");
      expect(state[platform].error).toContain('"code":0');
      expect(state[platform].error).toContain('"httpStatus":503');
    }
    const entry = bm._platforms.get("qq:hana");
    entry.error = "aes_key=fixtureLate";
    expect(bm.getStatus("hana").qq.error).toBe("aes_key=[redacted]");
    expect(entry.error).toBe("aes_key=fixtureLate");
    bm._emitStatus("qq", "error", error, "hana");
    expect(JSON.stringify(hub.eventBus.emit.mock.calls)).not.toMatch(/fixtureStart|fixtureCause|fixtureLate|SYN_HEADER_CAUSE/);
    expect(bm.getStatus("other")).toEqual({});
    expect(error.cause).toBe(cause);
    expect(cause.code).toBe("ECONNRESET");
    expect(error.code).toBe(0);
    expect(error.message).toBe("appSecret=fixtureStart");
    bm.stopAll();
    createTelegramAdapter.mockReset();
  });

  it("redacts adapter errors in storage, events and the status route without changing credentials", async () => {
    createWechatAdapter.mockReset();
    createWechatAdapter.mockReturnValue({ stop: vi.fn() });
    const agent = { id: "hana", config: { bridge: { wechat: { enabled: true } } } };
    const engine = { hanakoHome: os.tmpdir(), agent: null, currentAgentId: "hana", getAgent: () => agent, getBridgeIndex: () => ({}) };
    const hub = { eventBus: { emit: vi.fn() } };
    const bm = new BridgeManager({ engine, hub });
    const credentials = { botToken: "fixtureInputToken", hanaHome: os.tmpdir() };
    bm.startPlatform("wechat", credentials, "hana");
    const { onStatus, botToken } = createWechatAdapter.mock.calls[0][0];
    expect(botToken).toBe(credentials.botToken);
    const raw = 'HTTP 401 context_token=fixtureStatusSecret log_id=trace-123 retry_after=3 ' +
      JSON.stringify({ detail: '{"aes_key":"fixtureNestedStatus"}' }) +
      ' X-Api-Key: SYN_HEADER_STATUS; X-Access-Token=SYN_HEADER_ACCESS';
    onStatus("error", raw);
    const app = new Hono();
    app.route("/api", createBridgeRoute(engine, bm));
    const response = await app.request("/api/bridge/status?agentId=hana");
    expect(response.status).toBe(200);
    for (const output of [bm._platforms.get("wechat:hana"), bm.getStatus("hana"), hub.eventBus.emit.mock.calls, await response.json()]) {
      const text = JSON.stringify(output);
      expect(text).not.toMatch(/fixtureStatusSecret|fixtureNestedStatus|SYN_HEADER_/);
      expect(text).toContain("HTTP 401");
      expect(text).toContain("trace-123");
    }
    expect(raw).toContain("fixtureStatusSecret");
    expect(credentials.botToken).toBe("fixtureInputToken");
    const structured = { ["context_\u0000token"]: "fixtureStructuredStatus", code: 503,
      headers: { "x-acs-dingtalk-access-token": "SYN_HEADER_STRUCTURED" } };
    onStatus("error", structured);
    expect(bm._platforms.get("wechat:hana").error).not.toMatch(/fixtureStructuredStatus|SYN_HEADER_STRUCTURED/);
    expect(bm.getStatus("hana").wechat.error).toContain('"code":503');
    expect(structured["context_\u0000token"]).toBe("fixtureStructuredStatus");
    onStatus("connected", null);
    expect(bm.getStatus("hana").wechat.error).toBeNull();
    bm.stopAll();
  });

  it("starts wechat in connecting state until the adapter reports readiness", () => {
    createTelegramAdapter.mockReset();
    createFeishuAdapter.mockReset();
    createDingTalkAdapter.mockReset();
    createQQAdapter.mockReset();
    createWechatAdapter.mockReset();
    createWechatAdapter.mockReturnValue({ stop: vi.fn() });

    const engine = {
      hanakoHome: os.tmpdir(),
      agent: null,
      getAgent: vi.fn(() => null),
    };
    const hub = { eventBus: { emit: vi.fn() } };
    const bm = new BridgeManager({ engine, hub });

    bm.startPlatform("wechat", { botToken: "wx-token", hanaHome: os.tmpdir() }, "hana");

    expect(bm.getStatus("hana").wechat).toMatchObject({ status: "connecting", error: null });
  });

  it("reports DingTalk config errors when enabled credentials are incomplete", () => {
    createTelegramAdapter.mockReset();
    createFeishuAdapter.mockReset();
    createDingTalkAdapter.mockReset();
    createQQAdapter.mockReset();
    createWechatAdapter.mockReset();

    const engine = {
      hanakoHome: os.tmpdir(),
      agent: null,
      getAgent: vi.fn(() => null),
    };
    const hub = { eventBus: { emit: vi.fn() } };
    const bm = new BridgeManager({ engine, hub });

    bm.startPlatformFromConfig("dingtalk", {
      enabled: true,
      corpId: "corp-1",
      clientId: "dt-client",
      clientSecret: "dt-secret",
    }, "hana");

    expect(createDingTalkAdapter).not.toHaveBeenCalled();
    expect(bm.getStatus("hana").dingtalk).toMatchObject({
      status: "error",
      error: expect.stringMatching(/enterprise robotCode/i),
    });
  });

  it("does not start DingTalk when the new token contract is missing corpId", () => {
    createDingTalkAdapter.mockReset();
    const engine = {
      hanakoHome: os.tmpdir(),
      agent: null,
      getAgent: vi.fn(() => null),
    };
    const hub = { eventBus: { emit: vi.fn() } };
    const bm = new BridgeManager({ engine, hub });

    bm.startPlatformFromConfig("dingtalk", {
      enabled: true,
      clientId: "dt-client",
      clientSecret: "dt-secret",
      robotCode: "ding-robot",
    }, "hana");

    expect(createDingTalkAdapter).not.toHaveBeenCalled();
    expect(bm.getStatus("hana").dingtalk).toMatchObject({
      status: "error",
      error: expect.stringMatching(/corpId/i),
    });
  });

  it("starts a migrated stable DingTalk config only when legacy mode is explicit", () => {
    createDingTalkAdapter.mockReset();
    createDingTalkAdapter.mockReturnValue({ stop: vi.fn() });
    const engine = {
      hanakoHome: os.tmpdir(),
      agent: null,
      getAgent: vi.fn(() => null),
    };
    const hub = { eventBus: { emit: vi.fn() } };
    const bm = new BridgeManager({ engine, hub });

    bm.startPlatformFromConfig("dingtalk", {
      enabled: true,
      authMode: "legacy_app",
      clientId: "dt-client",
      clientSecret: "dt-secret",
      robotCode: "ding-robot",
      apiBaseUrl: "https://api.dingtalk.io/v1.0",
    }, "hana");

    expect(createDingTalkAdapter).toHaveBeenCalledWith(expect.objectContaining({
      authMode: "legacy_app",
      corpId: "",
      clientId: "dt-client",
      clientSecret: "dt-secret",
      apiBaseUrl: "https://api.dingtalk.io/v1.0",
    }));
    expect(bm.getStatus("hana").dingtalk).toMatchObject({
      status: "connecting",
      error: null,
    });
  });

  it("does not revive a legacy QQ token after canonical appSecret was cleared", () => {
    createQQAdapter.mockReset();
    const engine = {
      hanakoHome: os.tmpdir(),
      agent: null,
      getAgent: vi.fn(() => null),
    };
    const hub = { eventBus: { emit: vi.fn() } };
    const bm = new BridgeManager({ engine, hub });

    bm.startPlatformFromConfig("qq", {
      enabled: true,
      appID: "qq-app",
      appSecret: "",
      token: "legacy-must-stay-cleared",
    }, "hana");

    expect(createQQAdapter).not.toHaveBeenCalled();
    expect(bm.getStatus("hana").qq).toBeUndefined();
  });
});
