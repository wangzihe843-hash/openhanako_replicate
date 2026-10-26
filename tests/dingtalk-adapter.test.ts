import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DINGTALK_BOT_CALLBACK_TOPIC,
  DINGTALK_STREAMING_CAPABILITIES,
  createDingTalkAdapter,
} from "../lib/bridge/dingtalk-adapter.ts";

type FakeWebSocketHandler = (payload?: unknown) => void;

class FakeWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  closeCalls = 0;
  url: string;
  options: any;
  sent: string[] = [];
  handlers = new Map<string, FakeWebSocketHandler[]>();

  constructor(url: string, options?: any) {
    this.url = url;
    this.options = options;
    FakeWebSocket.instances.push(this);
  }

  on(event: string, handler: FakeWebSocketHandler) {
    const list = this.handlers.get(event) || [];
    list.push(handler);
    this.handlers.set(event, list);
    return this;
  }

  emit(event: string, payload?: any) {
    if (event === "open") this.readyState = FakeWebSocket.OPEN;
    if (event === "close") this.readyState = FakeWebSocket.CLOSED;
    for (const handler of this.handlers.get(event) || []) {
      handler(payload);
    }
  }

  send(payload: string) {
    this.sent.push(payload);
  }

  close() {
    this.closeCalls += 1;
    this.emit("close");
  }
}

function jsonResponse(data: any, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

function makeAdapter(
  fetchMock: ReturnType<typeof vi.fn>,
  onMessage = vi.fn(),
  onStatus = vi.fn(),
  overrides: Record<string, any> = {},
) {
  return createDingTalkAdapter({
    corpId: "corp-1",
    clientId: "dt-client",
    clientSecret: "dt-secret",
    robotCode: "ding-robot",
    agentId: "hana",
    onMessage,
    onStatus,
    fetchImpl: fetchMock as any,
    WebSocketImpl: FakeWebSocket as any,
    ...overrides,
  });
}

function streamEnvelope(data: any, messageId = "msg-1") {
  return JSON.stringify({
    type: "CALLBACK",
    headers: {
      topic: DINGTALK_BOT_CALLBACK_TOPIC,
      contentType: "application/json",
      messageId,
      time: Date.now(),
    },
    data: JSON.stringify(data),
  });
}

function pingEnvelope(messageId = "ping-1", opaque: unknown = "opaque-1") {
  return JSON.stringify({
    type: "SYSTEM",
    headers: { topic: "ping", contentType: "application/json", messageId, time: 123 },
    data: JSON.stringify({ opaque }),
  });
}

describe("DingTalk Stream application ping", () => {
  const adapters: ReturnType<typeof makeAdapter>[] = [];
  afterEach(() => {
    for (const adapter of adapters.splice(0)) adapter.stop();
    vi.useRealTimers();
  });

  async function fixture(overrides: Record<string, unknown> = {}) {
    FakeWebSocket.instances = [];
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      endpoint: "wss://stream.example/connect?region=synthetic",
      ticket: "ticket-1",
    }));
    const onMessage = vi.fn();
    const onStatus = vi.fn();
    const adapter = makeAdapter(fetchMock, onMessage, onStatus, overrides);
    adapters.push(adapter);
    // Registration is fully fake; no socket opens until the fixture emits open.
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    return { adapter, fetchMock, onMessage, onStatus, socket: FakeWebSocket.instances[0] };
  }

  it("echoes the complete application ACK once per ping without normalizing messageId or opaque", async () => {
    const { socket, fetchMock, onMessage, onStatus } = await fixture();
    socket.emit("open");
    const statuses = onStatus.mock.calls.slice();
    socket.emit("message", pingEnvelope(" ping-original ", " opaque-original "));
    socket.emit("message", Buffer.from(pingEnvelope("ping-2", { nested: [0, false, "opaque"] })));
    expect(socket.sent.map((frame) => JSON.parse(frame))).toEqual([
      {
        code: 200,
        headers: { contentType: "application/json", messageId: " ping-original " },
        message: "OK",
        data: JSON.stringify({ opaque: " opaque-original " }),
      },
      {
        code: 200,
        headers: { contentType: "application/json", messageId: "ping-2" },
        message: "OK",
        data: JSON.stringify({ opaque: { nested: [0, false, "opaque"] } }),
      },
    ]);
    expect(onMessage).not.toHaveBeenCalled();
    expect(onStatus.mock.calls).toEqual(statuses);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(socket.readyState).toBe(FakeWebSocket.OPEN);
  });

  it.each([
    ["bad envelope JSON", "{"],
    ["null envelope", "null"],
    ["missing headers", JSON.stringify({ type: "SYSTEM", data: '{"opaque":"one"}' })],
    ["missing messageId", JSON.stringify({ type: "SYSTEM", headers: { topic: "ping" }, data: '{"opaque":"one"}' })],
    ["empty messageId", pingEnvelope("")],
    ["blank messageId", pingEnvelope(" ")],
    ["non-string messageId", JSON.stringify({ type: "SYSTEM", headers: { topic: "ping", messageId: 7 }, data: '{"opaque":"one"}' })],
    ["missing data", JSON.stringify({ type: "SYSTEM", headers: { topic: "ping", messageId: "one" } })],
    ["bad data JSON", JSON.stringify({ type: "SYSTEM", headers: { topic: "ping", messageId: "one" }, data: "{" })],
    ["null data", JSON.stringify({ type: "SYSTEM", headers: { topic: "ping", messageId: "one" }, data: "null" })],
    ["missing opaque", JSON.stringify({ type: "SYSTEM", headers: { topic: "ping", messageId: "one" }, data: "{}" })],
    ["array data", JSON.stringify({ type: "SYSTEM", headers: { topic: "ping", messageId: "one" }, data: "[]" })],
    ["unknown SYSTEM topic", JSON.stringify({ type: "SYSTEM", headers: { topic: "other", messageId: "one" }, data: '{"opaque":"one"}' })],
    ["ping on CALLBACK type", JSON.stringify({ type: "CALLBACK", headers: { topic: "ping", messageId: "one" }, data: '{"opaque":"one"}' })],
  ])("ignores %s without ACK or state changes", async (_label, raw) => {
    const { socket, onMessage, onStatus, fetchMock } = await fixture();
    socket.emit("open");
    const statuses = onStatus.mock.calls.slice();
    expect(() => socket.emit("message", raw)).not.toThrow();
    expect(socket.sent).toEqual([]);
    expect(socket.closeCalls).toBe(0);
    expect(socket.readyState).toBe(FakeWebSocket.OPEN);
    expect(onMessage).not.toHaveBeenCalled();
    expect(onStatus.mock.calls).toEqual(statuses);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([0, 2, 3, undefined])("does not ACK on a non-OPEN socket (%s)", async (readyState) => {
    const { socket, onStatus, onMessage } = await fixture();
    socket.readyState = readyState as number;
    const statuses = onStatus.mock.calls.slice();
    socket.emit("message", pingEnvelope());
    expect(socket.sent).toEqual([]);
    expect(socket.readyState).toBe(readyState);
    expect(onStatus.mock.calls).toEqual(statuses);
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("does not turn WebSocket control ping/pong events into application ACKs", async () => {
    const { socket, onStatus } = await fixture();
    socket.emit("open");
    const statuses = onStatus.mock.calls.slice();
    socket.emit("ping", Buffer.from("control-ping"));
    socket.emit("pong", Buffer.from("control-pong"));
    expect(socket.sent).toEqual([]);
    expect(onStatus.mock.calls).toEqual(statuses);
  });

  it("ignores a stale socket ping and ACKs only the current OPEN socket after fresh registration", async () => {
    const { socket: oldSocket, fetchMock, onStatus, onMessage } = await fixture({ reconnectDelayMs: 1 });
    oldSocket.emit("open");
    fetchMock.mockResolvedValueOnce(jsonResponse({
      endpoint: "wss://another-stream.example/next?region=second",
      ticket: "ticket-2",
    }));
    vi.useFakeTimers();
    oldSocket.emit("message", JSON.stringify({ type: "SYSTEM", headers: { topic: "disconnect", messageId: "disconnect-1" } }));
    expect(oldSocket.closeCalls).toBe(1);
    expect(oldSocket.sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeWebSocket.instances).toHaveLength(2);
    const currentSocket = FakeWebSocket.instances[1];
    expect(currentSocket.url).toBe("wss://another-stream.example/next?region=second&ticket=ticket-2");
    expect(oldSocket.url).toBe("wss://stream.example/connect?region=synthetic&ticket=ticket-1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Even a late message whose old source still claims OPEN cannot ACK on either socket.
    oldSocket.readyState = FakeWebSocket.OPEN;
    currentSocket.emit("open");
    const statuses = onStatus.mock.calls.slice();
    oldSocket.emit("message", pingEnvelope("stale-ping"));
    expect(oldSocket.sent).toEqual([]);
    expect(currentSocket.sent).toEqual([]);
    currentSocket.emit("message", pingEnvelope("current-ping", "current-opaque"));
    expect(currentSocket.sent.map((frame) => JSON.parse(frame))).toEqual([{
      code: 200,
      headers: { contentType: "application/json", messageId: "current-ping" },
      message: "OK",
      data: '{"opaque":"current-opaque"}',
    }]);
    expect(onStatus.mock.calls).toEqual(statuses);
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("does not ACK late ping messages after stop even if the source still claims OPEN", async () => {
    const { adapter, socket, onStatus, onMessage, fetchMock } = await fixture();
    socket.emit("open");
    adapter.stop();
    const statuses = onStatus.mock.calls.slice();
    expect(statuses.at(-1)).toEqual(["disconnected"]);
    socket.readyState = FakeWebSocket.OPEN;
    socket.emit("message", pingEnvelope());
    expect(socket.sent).toEqual([]);
    expect(socket.closeCalls).toBe(1);
    expect(onStatus.mock.calls).toEqual(statuses);
    expect(onMessage).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("DingTalk bridge adapter", () => {
  it("opens the official stream connection and subscribes to bot callbacks", async () => {
    FakeWebSocket.instances = [];
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({
      endpoint: "wss://api.dingtalk.com/connect",
      ticket: "ticket-1",
    }));
    const onStatus = vi.fn();

    const adapter = makeAdapter(fetchMock, vi.fn(), onStatus);

    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.dingtalk.com/v1.0/gateway/connections/open",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining(DINGTALK_BOT_CALLBACK_TOPIC),
      }),
    );
    const registerBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(registerBody).toMatchObject({
      clientId: "dt-client",
      clientSecret: "dt-secret",
      subscriptions: [{ topic: DINGTALK_BOT_CALLBACK_TOPIC, type: "CALLBACK" }],
    });
    expect(FakeWebSocket.instances[0].url).toBe("wss://api.dingtalk.com/connect?ticket=ticket-1");

    FakeWebSocket.instances[0].emit("open");
    expect(onStatus).toHaveBeenCalledWith("connected");

    adapter.stop();
  });

  it("normalizes DingTalk private text callbacks and acknowledges the stream message", async () => {
    FakeWebSocket.instances = [];
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({
      endpoint: "wss://api.dingtalk.com/connect",
      ticket: "ticket-1",
    }));
    const onMessage = vi.fn();

    const adapter = makeAdapter(fetchMock, onMessage);
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));

    FakeWebSocket.instances[0].emit("message", streamEnvelope({
      conversationId: "cid-private",
      conversationType: "1",
      msgId: "ding-msg-1",
      senderNick: "Alice",
      senderStaffId: "manager1234",
      senderId: "sender-open-id",
      senderAvatarUrl: "https://example.com/alice.png",
      msgtype: "text",
      text: { content: "hello DingTalk!" },
      robotCode: "ding-robot",
    }, "stream-msg-1"));

    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
      platform: "dingtalk",
      agentId: "hana",
      chatId: "manager1234",
      userId: "manager1234",
      sessionKey: "dt_dm_manager1234@hana",
      text: "hello DingTalk!",
      senderName: "Alice",
      displayName: "Alice",
      avatarUrl: "https://example.com/alice.png",
      principalId: "manager1234",
      isGroup: false,
      _msgId: "ding-msg-1",
    }));
    expect(FakeWebSocket.instances[0].sent).toHaveLength(1);
    expect(JSON.parse(FakeWebSocket.instances[0].sent[0])).toEqual({
      code: 200,
      headers: {
        contentType: "application/json",
        messageId: "stream-msg-1",
      },
      message: "OK",
      data: "{}",
    });

    adapter.stop();
  });

  it("uses conversation-scoped session keys for group callbacks", async () => {
    FakeWebSocket.instances = [];
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({
      endpoint: "wss://api.dingtalk.com/connect",
      ticket: "ticket-1",
    }));
    const onMessage = vi.fn();

    const adapter = makeAdapter(fetchMock, onMessage);
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));

    FakeWebSocket.instances[0].emit("message", streamEnvelope({
      conversationId: "cid-group",
      conversationType: "2",
      msgId: "ding-msg-2",
      senderNick: "Bob",
      senderStaffId: "staff-bob",
      msgtype: "text",
      text: { content: "group hello" },
      robotCode: "ding-robot",
    }));

    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
      chatId: "cid-group",
      userId: "staff-bob",
      sessionKey: "dt_group_cid-group@hana",
      text: "group hello",
      isGroup: true,
    }));

    adapter.stop();
  });

  it("sends private and group replies through DingTalk robot REST APIs", async () => {
    FakeWebSocket.instances = [];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ endpoint: "wss://api.dingtalk.com/connect", ticket: "ticket-1" }))
      .mockResolvedValueOnce(jsonResponse({ access_token: "token-1", expires_in: 7200 }))
      .mockResolvedValueOnce(jsonResponse({ processQueryKey: "dm-task" }))
      .mockResolvedValueOnce(jsonResponse({ processQueryKey: "group-task" }));

    const adapter = makeAdapter(fetchMock);
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));

    await adapter.sendReply("manager1234", "direct hello", { targetScope: "dm" });
    await adapter.sendReply("cid-group", "group hello", { targetScope: "group" });

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://api.dingtalk.com/v1.0/oauth2/corp-1/token",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          client_id: "dt-client",
          client_secret: "dt-secret",
          grant_type: "client_credentials",
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "x-acs-dingtalk-access-token": "token-1" }),
      }),
    );
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({
      robotCode: "ding-robot",
      userIds: ["manager1234"],
      msgKey: "sampleMarkdown",
      msgParam: JSON.stringify({ title: "Hana", text: "direct hello" }),
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      "https://api.dingtalk.com/v1.0/robot/groupMessages/send",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "x-acs-dingtalk-access-token": "token-1" }),
      }),
    );
    expect(JSON.parse(fetchMock.mock.calls[3][1].body)).toEqual({
      robotCode: "ding-robot",
      openConversationId: "cid-group",
      msgKey: "sampleMarkdown",
      msgParam: JSON.stringify({ title: "Hana", text: "group hello" }),
    });

    adapter.stop();
  });

  it("uses the stable token payload and legacy/custom send base in explicit legacy mode", async () => {
    FakeWebSocket.instances = [];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ endpoint: "wss://api.dingtalk.com/connect", ticket: "ticket-1" }))
      .mockResolvedValueOnce(jsonResponse({ accessToken: "legacy-token", expireIn: 7200 }))
      .mockResolvedValueOnce(jsonResponse({ processQueryKey: "dm-task" }));

    const adapter = makeAdapter(fetchMock, vi.fn(), vi.fn(), {
      authMode: "legacy_app",
      corpId: "",
      apiBaseUrl: "https://legacy-gateway.example/dingtalk/v1.0/",
    });
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));

    await adapter.sendReply("manager1234", "legacy hello", { targetScope: "dm" });

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://legacy-gateway.example/dingtalk/v1.0/oauth2/accessToken",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ appKey: "dt-client", appSecret: "dt-secret" }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "https://legacy-gateway.example/dingtalk/v1.0/robot/oToMessages/batchSend",
      expect.objectContaining({
        headers: expect.objectContaining({ "x-acs-dingtalk-access-token": "legacy-token" }),
      }),
    );

    adapter.stop();
  });

  it("builds token and robot send requests from the DingTalk API base URL only", async () => {
    FakeWebSocket.instances = [];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ endpoint: "wss://stream.example/connect", ticket: "ticket-1" }))
      .mockResolvedValueOnce(jsonResponse({ access_token: "token-1", expires_in: 7200 }))
      .mockResolvedValueOnce(jsonResponse({ processQueryKey: "dm-task" }))
      .mockResolvedValueOnce(jsonResponse({ processQueryKey: "group-task" }));

    const adapter = makeAdapter(fetchMock, vi.fn(), vi.fn(), {
      corpId: "corp/custom",
      apiBaseUrl: "https://tenant-gateway.example/dingtalk/v1.0/",
      streamOpenUrl: "https://stream-gateway.example/v1.0/gateway/connections/open",
    });
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));

    await adapter.sendReply("manager1234", "direct hello", { targetScope: "dm" });
    await adapter.sendReply("cid-group", "group hello", { targetScope: "group" });

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "https://stream-gateway.example/v1.0/gateway/connections/open",
      "https://tenant-gateway.example/dingtalk/v1.0/oauth2/corp%2Fcustom/token",
      "https://tenant-gateway.example/dingtalk/v1.0/robot/oToMessages/batchSend",
      "https://tenant-gateway.example/dingtalk/v1.0/robot/groupMessages/send",
    ]);

    adapter.stop();
  });

  it("reports outbound degradation after token failure and clears it after a successful reply", async () => {
    FakeWebSocket.instances = [];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ endpoint: "wss://api.dingtalk.com/connect", ticket: "ticket-1" }))
      .mockResolvedValueOnce(jsonResponse({ code: "dt-secret", message: "invalid dt-secret" }, 401))
      .mockResolvedValueOnce(jsonResponse({ access_token: "token-2", expires_in: 7200 }))
      .mockResolvedValueOnce(jsonResponse({ processQueryKey: "dm-task" }));
    const onStatus = vi.fn();
    const adapter = makeAdapter(fetchMock, vi.fn(), onStatus);
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    FakeWebSocket.instances[0].emit("open");

    await expect(adapter.sendReply("manager1234", "hello", { targetScope: "dm" }))
      .rejects.toThrow(/invalid \[redacted\].*code=\[redacted\]/);
    expect(onStatus).toHaveBeenCalledWith("connected");
    expect(onStatus).toHaveBeenCalledWith(
      "error",
      expect.stringMatching(/invalid \[redacted\].*code=\[redacted\]/),
    );
    expect(JSON.stringify(onStatus.mock.calls)).not.toContain("dt-secret");

    await expect(adapter.sendReply("manager1234", "retry", { targetScope: "dm" }))
      .resolves.toMatchObject({ processQueryKey: "dm-task" });
    expect(onStatus.mock.calls.at(-1)).toEqual(["connected"]);

    adapter.stop();
  });

  it("redacts the access token from robot-send errors and degraded status", async () => {
    FakeWebSocket.instances = [];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ endpoint: "wss://api.dingtalk.com/connect", ticket: "ticket-1" }))
      .mockResolvedValueOnce(jsonResponse({ access_token: "token-must-not-leak", expires_in: 7200 }))
      .mockResolvedValueOnce(jsonResponse({
        code: "token-must-not-leak",
        message: "rejected token-must-not-leak",
      }, 403));
    const onStatus = vi.fn();
    const adapter = makeAdapter(fetchMock, vi.fn(), onStatus);
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    FakeWebSocket.instances[0].emit("open");

    await expect(adapter.sendReply("manager1234", "hello", { targetScope: "dm" }))
      .rejects.toThrow(/rejected \[redacted\].*code=\[redacted\]/);
    expect(JSON.stringify(onStatus.mock.calls)).not.toContain("token-must-not-leak");
    expect(onStatus).toHaveBeenCalledWith(
      "error",
      expect.stringMatching(/rejected \[redacted\].*code=\[redacted\]/),
    );

    adapter.stop();
  });

  it("redacts the one-time Stream ticket from WebSocket construction errors", async () => {
    class ThrowingWebSocket {
      static CLOSED = 3;

      constructor(url: string) {
        throw new Error(`failed to connect ${url}`);
      }
    }

    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({
      endpoint: "wss://api.dingtalk.com/connect",
      ticket: "ticket-must-not-leak",
    }));
    const onStatus = vi.fn();
    const adapter = makeAdapter(fetchMock, vi.fn(), onStatus, {
      WebSocketImpl: ThrowingWebSocket as any,
      reconnectDelayMs: 60_000,
    });

    await vi.waitFor(() => expect(onStatus).toHaveBeenCalledWith(
      "error",
      expect.stringContaining("[redacted]"),
    ));
    expect(JSON.stringify(onStatus.mock.calls)).not.toContain("ticket-must-not-leak");

    adapter.stop();
  });

  it("rejects custom robot webhook credentials for the Enterprise Stream connector", () => {
    const fetchMock = vi.fn();

    expect(() => makeAdapter(fetchMock, vi.fn(), vi.fn(), {
      webhookUrl: "https://oapi.dingtalk.com/robot/send?access_token=custom",
      webhookSecret: "custom-secret",
    })).toThrow(/custom robot webhook fields/i);
  });

  it("splits long replies before sending DingTalk markdown payloads", async () => {
    FakeWebSocket.instances = [];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ endpoint: "wss://api.dingtalk.com/connect", ticket: "ticket-1" }))
      .mockResolvedValueOnce(jsonResponse({ access_token: "token-1", expires_in: 7200 }))
      .mockResolvedValueOnce(jsonResponse({ processQueryKey: "part-1" }))
      .mockResolvedValueOnce(jsonResponse({ processQueryKey: "part-2" }));
    const adapter = makeAdapter(fetchMock);
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));

    await adapter.sendReply("manager1234", "你".repeat(5000), { targetScope: "dm" });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    const first = JSON.parse(JSON.parse(fetchMock.mock.calls[2][1].body).msgParam);
    const second = JSON.parse(JSON.parse(fetchMock.mock.calls[3][1].body).msgParam);
    expect(first.title).toBe("Hana 1/2");
    expect(second.title).toBe("Hana 2/2");
    expect(first.text + second.text).toBe("你".repeat(5000));

    adapter.stop();
  });

  it("declares batch text streaming only after the final message is ready", () => {
    expect(DINGTALK_STREAMING_CAPABILITIES).toMatchObject({
      platform: "dingtalk",
      mode: "batch",
      scopes: ["dm", "group"],
      renderer: "text",
    });
  });
});


describe("DingTalk response body budgets", () => {
  const adapters: ReturnType<typeof makeAdapter>[] = [];
  afterEach(() => {
    for (const adapter of adapters.splice(0)) adapter.stop();
    vi.useRealTimers();
  });

  function streamedResponse(text: string, status = 200, contentLength?: string) {
    const bytes = new TextEncoder().encode(text);
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(bytes); controller.close(); },
      cancel,
    });
    const response = new Response(body, {
      status, headers: contentLength === undefined ? {} : { "Content-Length": contentLength },
    });
    return { response, body, cancel };
  }

  async function fixture(sendResponse: Response) {
    FakeWebSocket.instances = [];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(streamedResponse(JSON.stringify({ endpoint: "wss://stream.example/connect", ticket: "ticket-1" })).response)
      .mockResolvedValueOnce(streamedResponse(JSON.stringify({ access_token: "token-1", expires_in: 7200 })).response)
      .mockResolvedValue(sendResponse);
    const onStatus = vi.fn();
    const adapter = makeAdapter(fetchMock, vi.fn(), onStatus);
    adapters.push(adapter);
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    return { adapter, fetchMock, onStatus };
  }

  it.each(["dm", "group"])("accepts exactly 64KiB of JSON for %s despite a false Content-Length", async targetScope => {
    const text = JSON.stringify({ result: "你😀", pad: "" });
    const data = JSON.parse(text);
    data.pad = " ".repeat(65_536 - new TextEncoder().encode(text).length);
    const { response, body } = streamedResponse(JSON.stringify(data), 200, "999999");
    const { adapter, fetchMock } = await fixture(response);
    await expect(adapter.sendReply("synthetic-target", "hello", { targetScope })).resolves.toEqual(data);
    expect(body.locked).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each(["dm", "group"])("rejects an oversized %s response without resending or reading the next message chunk", async targetScope => {
    const { response, body } = streamedResponse(" ".repeat(65_537), 200, "1");
    const { adapter, fetchMock, onStatus } = await fixture(response);
    await expect(adapter.sendReply("synthetic-target", "你".repeat(5000), { targetScope }))
      .rejects.toThrow(new RegExp(`DingTalk send_${targetScope} response body exceeded 65536 bytes`));
    expect(body.locked).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(onStatus).toHaveBeenCalledWith("error", expect.stringContaining(`send_${targetScope}`));
  });

  it.each(["dm", "group"])("times out a stalled %s body after 10 seconds and cancels its stream", async targetScope => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const { adapter, fetchMock } = await fixture(new Response(body));
    vi.useFakeTimers();
    const outcome = adapter.sendReply("synthetic-target", "hello", { targetScope }).then(
      value => ({ value, error: undefined }), error => ({ value: undefined, error }),
    );
    await vi.advanceTimersByTimeAsync(9_999);
    expect(cancel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(cancel).toHaveBeenCalledOnce();
    expect((await outcome).error?.message).toMatch(new RegExp(`DingTalk send_${targetScope} response body timed out`));
    expect(body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each(["oversized", "stalled"])("bounds a %s registration body and keeps the existing reconnect delay", async kind => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) { if (kind === "oversized") controller.enqueue(new Uint8Array(65_537)); },
      cancel,
    });
    const onStatus = vi.fn();
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(body));
    const adapter = makeAdapter(fetchMock, vi.fn(), onStatus);
    adapters.push(adapter);
    await vi.advanceTimersByTimeAsync(kind === "stalled" ? 10_000 : 0);
    expect(onStatus).toHaveBeenCalledWith("error", expect.stringMatching(/DingTalk stream_open response body (exceeded|timed out)/));
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
    adapter.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["dm", "group"])("keeps non-JSON HTTP errors safe and does not retry %s sends", async targetScope => {
    const { adapter, fetchMock, onStatus } = await fixture(streamedResponse("<html>token-1 dt-secret arbitrary upstream dump</html>", 503).response);
    await expect(adapter.sendReply("synthetic-target", "hello", { targetScope }))
      .rejects.toThrow(new RegExp(`\\[dingtalk:send_${targetScope}\\] request failed \\(code=503\\)`));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(onStatus.mock.calls)).not.toMatch(/token-1|dt-secret|arbitrary upstream dump/);
  });

  it("keeps a successful non-JSON send response as bounded text", async () => {
    const { adapter } = await fixture(streamedResponse("accepted").response);
    await expect(adapter.sendReply("synthetic-target", "hello")).resolves.toBe("accepted");
  });
});
