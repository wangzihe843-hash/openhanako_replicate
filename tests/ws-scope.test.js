import { describe, expect, it } from "vitest";
import {
  createWsClientRecord,
  subscribeWsClientToSession,
  wsClientCanReceiveEvent,
  wsClientCanSendMessage,
} from "../server/ws-scope.js";

describe("websocket scope filtering", () => {
  it("allows local owner to receive legacy global events", () => {
    const client = createWsClientRecord({
      principal: {
        kind: "local_user",
        credentialKind: "loopback_token",
        connectionKind: "local",
        userId: "user_1",
        studioId: "studio_1",
        serverNodeId: "node_1",
      },
    });
    expect(wsClientCanReceiveEvent(client, { type: "plugin_ui_changed" })).toBe(true);
    expect(wsClientCanSendMessage(client, { type: "prompt", sessionPath: "/s/a.jsonl" })).toBe(true);
  });

  it("denies remote session events outside subscribed session", () => {
    const client = createWsClientRecord({
      principal: {
        kind: "device",
        credentialKind: "device_credential",
        connectionKind: "lan",
        userId: "user_1",
        studioId: "studio_1",
        serverNodeId: "node_1",
        scopes: ["chat.read"],
      },
      subscriptions: [{ kind: "session", studioId: "studio_1", sessionPath: "/s/a.jsonl" }],
    });
    expect(wsClientCanReceiveEvent(client, {
      type: "message",
      studioId: "studio_1",
      sessionPath: "/s/b.jsonl",
    })).toBe(false);
    expect(wsClientCanReceiveEvent(client, {
      type: "message",
      studioId: "studio_1",
      sessionPath: "/s/a.jsonl",
    })).toBe(true);
  });

  it("allows same-Studio remote clients through a studio subscription", () => {
    const client = createWsClientRecord({
      principal: {
        kind: "device",
        credentialKind: "device_credential",
        connectionKind: "lan",
        userId: "user_1",
        studioId: "studio_1",
        serverNodeId: "node_1",
        scopes: ["chat"],
      },
      subscriptions: [{ kind: "studio", studioId: "studio_1" }],
    });
    expect(wsClientCanReceiveEvent(client, {
      type: "session_user_message",
      studioId: "studio_1",
      sessionPath: "/s/new.jsonl",
    })).toBe(true);
    expect(wsClientCanSendMessage(client, {
      type: "prompt",
      sessionPath: "/s/new.jsonl",
    })).toBe(true);
  });

  it("blocks remote base64 media events and unknown global events", () => {
    const client = createWsClientRecord({
      principal: {
        kind: "device",
        credentialKind: "device_credential",
        connectionKind: "lan",
        userId: "user_1",
        studioId: "studio_1",
        serverNodeId: "node_1",
        scopes: ["chat"],
      },
      subscriptions: [{ kind: "studio", studioId: "studio_1" }],
    });
    expect(wsClientCanReceiveEvent(client, {
      type: "browser_status",
      studioId: "studio_1",
      sessionPath: "/s/a.jsonl",
      thumbnail: "data:image/png;base64,xxx",
    })).toBe(false);
    expect(wsClientCanReceiveEvent(client, { type: "plugin_ui_changed" })).toBe(false);
  });

  it("adds session subscriptions without losing prior principal", () => {
    const client = createWsClientRecord({
      principal: {
        kind: "device",
        credentialKind: "device_credential",
        connectionKind: "lan",
        userId: "user_1",
        studioId: "studio_1",
        serverNodeId: "node_1",
        scopes: ["chat.read"],
      },
    });
    const next = subscribeWsClientToSession(client, {
      studioId: "studio_1",
      sessionPath: "/s/a.jsonl",
    });
    expect(next.principal.principalId).toBe(client.principal.principalId);
    expect(next.subscriptions).toEqual([
      { kind: "session", studioId: "studio_1", sessionPath: "/s/a.jsonl" },
    ]);
  });
});
