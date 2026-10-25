import { afterEach, describe, expect, it, vi } from "vitest";
import { Client, type HttpInstance } from "@larksuiteoapi/node-sdk";
import { renderFeishuCardKitSettings } from "../lib/bridge/bridge-presentation.ts";

const adapterTransport = vi.hoisted(() => ({ request: vi.fn() }));

vi.mock("../lib/bridge/optional-sdks.ts", async () => {
  const sdk = await vi.importActual<typeof import("@larksuiteoapi/node-sdk")>("@larksuiteoapi/node-sdk");

  class TransportClient extends sdk.Client {
    constructor(options: ConstructorParameters<typeof Client>[0]) {
      super({
        ...options,
        disableTokenCache: true,
        loggerLevel: sdk.LoggerLevel.fatal,
        httpInstance: { request: adapterTransport.request } as unknown as HttpInstance,
      });
    }
  }

  class MockEventDispatcher {
    register() { return this; }
  }

  class MockWSClient {
    wsConfig = { wsInstance: { readyState: 1 } };
    async start() {}
    close() {}
  }

  return {
    loadFeishuSdk: () => ({
      ...sdk,
      Client: TransportClient,
      EventDispatcher: MockEventDispatcher,
      WSClient: MockWSClient,
    }),
  };
});

import { createFeishuAdapter } from "../lib/bridge/feishu-adapter.ts";

type CapturedRequest = {
  method: string;
  url: string;
  data: Record<string, unknown>;
  params?: Record<string, unknown>;
};

const adapters: ReturnType<typeof createFeishuAdapter>[] = [];
const table = "| Name | Status |\n| --- | --- |\n| Hana | ready |";

afterEach(() => {
  for (const adapter of adapters) adapter.stop();
  adapters.length = 0;
});

function postContent(text: string) {
  return JSON.stringify({ zh_cn: { content: [[{ tag: "md", text }]] } });
}

function cardContent(text: string) {
  return JSON.stringify({
    schema: "2.0",
    config: { update_multi: true },
    body: { elements: [{ tag: "markdown", content: text }] },
  });
}

function createAdapterHarness({
  messageIds = ["om_message_1", "om_message_2"],
  updateError,
}: { messageIds?: Array<string | null>; updateError?: Error } = {}) {
  const requests: CapturedRequest[] = [];
  let messageIndex = 0;
  adapterTransport.request.mockReset();
  // Every SDK HTTP request terminates here. Unknown endpoints are errors and
  // never fall through to the network, including token requests.
  adapterTransport.request.mockImplementation(async (request: CapturedRequest) => {
    const url = new URL(request.url);
    requests.push({ method: request.method, url: request.url, data: request.data, params: request.params });
    if (url.origin !== "https://open.feishu.cn") throw new Error(`Unexpected SDK origin: ${url.origin}`);
    if (url.pathname === "/open-apis/im/v1/messages" && request.method === "POST") {
      const messageId = messageIds[messageIndex++];
      return { code: 0, data: messageId ? { message_id: messageId } : {} };
    }
    if (/^\/open-apis\/im\/v1\/messages\/om_message_[12]$/.test(url.pathname)
      && (request.method === "PUT" || request.method === "PATCH")) {
      if (updateError) throw updateError;
      return { code: 0 };
    }
    if (url.pathname === "/open-apis/cardkit/v1/cards" && request.method === "POST") {
      return { code: 0, data: { card_id: "card_1" } };
    }
    if (url.pathname === "/open-apis/cardkit/v1/cards/card_1/settings" && request.method === "PATCH") {
      return { code: 0 };
    }
    if (url.pathname === "/open-apis/cardkit/v1/cards/card_1/elements/hana_stream_markdown/content"
      && request.method === "PUT") {
      return { code: 0 };
    }
    throw new Error(`Unexpected SDK request: ${request.method} ${url.pathname}`);
  });
  const adapter = createFeishuAdapter({
    appId: "synthetic-app-id",
    appSecret: "synthetic-app-secret",
    agentId: "synthetic-agent",
    onMessage: vi.fn(),
  });
  adapters.push(adapter);
  return {
    adapter,
    requests,
    sequence: () => requests.map(({ method, url, data }) => ({ method, path: new URL(url).pathname, data })),
  };
}

function createClientHarness() {
  const request = vi.fn(async () => ({ data: { card_id: "card_1" } }));
  const client = new Client({
    appId: "app-id",
    appSecret: "app-secret",
    disableTokenCache: true,
    httpInstance: { request } as unknown as HttpInstance,
  });
  return { client, request };
}

describe("Feishu SDK CardKit payload contract", () => {
  it("unwraps the SDK data envelope into the HTTP request body", async () => {
    const { client, request } = createClientHarness();

    await client.cardkit.v1.card.create({
      data: {
        type: "card_json",
        data: "{\"schema\":\"2.0\"}",
      },
    });

    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      method: "POST",
      data: {
        type: "card_json",
        data: "{\"schema\":\"2.0\"}",
      },
    }));
  });

  it.each([true, false])("passes the nested CardKit streaming config through the SDK for %s", async (streamingMode) => {
    const { client, request } = createClientHarness();

    await client.cardkit.v1.card.settings({
      path: { card_id: "card_1" },
      data: {
        settings: renderFeishuCardKitSettings(streamingMode),
        sequence: 2,
      },
    });

    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      data: {
        settings: streamingMode
          ? '{"config":{"streaming_mode":true}}'
          : '{"config":{"streaming_mode":false}}',
        sequence: 2,
      },
    }));
  });
});

describe("Feishu adapter request contract through the installed SDK", () => {
  it("keeps post stream updates and finish on PUT with post content", async () => {
    const { adapter, requests, sequence } = createAdapterHarness();
    const state = await adapter.startStreamReply("oc_synthetic", "first");
    await adapter.updateStreamReply("oc_synthetic", state, "second");
    await adapter.finishStreamReply("oc_synthetic", state, "final");

    expect(sequence()).toEqual([
      {
        method: "POST", path: "/open-apis/im/v1/messages",
        data: { receive_id: "oc_synthetic", msg_type: "post", content: postContent("first") },
      },
      {
        method: "PUT", path: "/open-apis/im/v1/messages/om_message_1",
        data: { msg_type: "post", content: postContent("second") },
      },
      {
        method: "PUT", path: "/open-apis/im/v1/messages/om_message_1",
        data: { msg_type: "post", content: postContent("final") },
      },
    ]);
    expect(requests[0].params).toEqual({ receive_id_type: "chat_id" });
  });

  it("uses content-only PATCH for interactive stream updates and finish on the original message", async () => {
    const { adapter, sequence } = createAdapterHarness();
    const state = await adapter.startStreamReply("oc_synthetic", table);
    await adapter.updateStreamReply("oc_synthetic", state, `${table}\n\nsecond`);
    await adapter.finishStreamReply("oc_synthetic", state, "final without a table");

    expect(sequence()).toEqual([
      {
        method: "POST", path: "/open-apis/im/v1/messages",
        data: { receive_id: "oc_synthetic", msg_type: "interactive", content: cardContent(table) },
      },
      {
        method: "PATCH", path: "/open-apis/im/v1/messages/om_message_1",
        data: { content: cardContent(`${table}\n\nsecond`) },
      },
      {
        method: "PATCH", path: "/open-apis/im/v1/messages/om_message_1",
        data: { content: cardContent("final without a table") },
      },
    ]);
    expect(state).toEqual({ messageId: "om_message_1", renderKind: "interactive" });
  });

  it("transitions post to one new card and PATCHes the same card for subsequent update and finish", async () => {
    const { adapter, sequence } = createAdapterHarness();
    const state = await adapter.startStreamReply("oc_synthetic", "working");
    await adapter.updateStreamReply("oc_synthetic", state, table);
    await adapter.updateStreamReply("oc_synthetic", state, `${table}\n\nsecond`);
    await adapter.finishStreamReply("oc_synthetic", state, "final without a table");

    expect(sequence()).toEqual([
      {
        method: "POST", path: "/open-apis/im/v1/messages",
        data: { receive_id: "oc_synthetic", msg_type: "post", content: postContent("working") },
      },
      {
        method: "PUT", path: "/open-apis/im/v1/messages/om_message_1",
        data: { msg_type: "post", content: postContent("已切换为表格卡片。") },
      },
      {
        method: "POST", path: "/open-apis/im/v1/messages",
        data: { receive_id: "oc_synthetic", msg_type: "interactive", content: cardContent(table) },
      },
      {
        method: "PATCH", path: "/open-apis/im/v1/messages/om_message_2",
        data: { content: cardContent(`${table}\n\nsecond`) },
      },
      {
        method: "PATCH", path: "/open-apis/im/v1/messages/om_message_2",
        data: { content: cardContent("final without a table") },
      },
    ]);
    expect(state).toEqual({
      messageId: "om_message_2", previousMessageId: "om_message_1", renderKind: "interactive",
    });
  });

  it("sends a one-shot interactive reply with one POST", async () => {
    const { adapter, sequence } = createAdapterHarness();
    await adapter.sendReply("oc_synthetic", table);

    expect(sequence()).toEqual([{
      method: "POST", path: "/open-apis/im/v1/messages",
      data: { receive_id: "oc_synthetic", msg_type: "interactive", content: cardContent(table) },
    }]);
  });

  it("preserves CardKit creation, instance send, content updates, and streaming settings", async () => {
    const { adapter, requests, sequence } = createAdapterHarness();
    const state = await adapter.startRichStreamReply("oc_synthetic", "first");
    await adapter.updateRichStreamReply("oc_synthetic", state, "second");
    await adapter.finishRichStreamReply("oc_synthetic", state, "final");

    expect(sequence()).toEqual([
      {
        method: "POST", path: "/open-apis/cardkit/v1/cards",
        data: { type: "card_json", data: expect.any(String) },
      },
      {
        method: "POST", path: "/open-apis/im/v1/messages",
        data: {
          receive_id: "oc_synthetic", msg_type: "interactive",
          content: '{"type":"card","data":{"card_id":"card_1"}}',
        },
      },
      {
        method: "PATCH", path: "/open-apis/cardkit/v1/cards/card_1/settings",
        data: { settings: '{"config":{"streaming_mode":true}}', sequence: 2 },
      },
      {
        method: "PUT", path: "/open-apis/cardkit/v1/cards/card_1/elements/hana_stream_markdown/content",
        data: { content: "second", sequence: 3 },
      },
      {
        method: "PUT", path: "/open-apis/cardkit/v1/cards/card_1/elements/hana_stream_markdown/content",
        data: { content: "final", sequence: 4 },
      },
      {
        method: "PATCH", path: "/open-apis/cardkit/v1/cards/card_1/settings",
        data: { settings: '{"config":{"streaming_mode":false}}', sequence: 5 },
      },
    ]);
    expect(JSON.parse(requests[0].data.data as string)).toMatchObject({
      schema: "2.0", config: { update_multi: true },
      body: { elements: [{ tag: "markdown", element_id: "hana_stream_markdown", content: "first" }] },
    });
  });

  it.each([
    { kind: "post", text: "first" },
    { kind: "interactive", text: table },
  ])("does not send more requests when initial $kind create has no message_id", async ({ text }) => {
    const { adapter, requests } = createAdapterHarness({ messageIds: [null] });
    const state = await adapter.startStreamReply("oc_synthetic", text);
    await adapter.updateStreamReply("oc_synthetic", state, table);
    await adapter.finishStreamReply("oc_synthetic", state, "final");

    expect(state).toEqual({ messageId: null, missingMessageId: true });
    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe("POST");
  });

  it("does not recreate or update a transition card whose create response has no message_id", async () => {
    const { adapter, requests } = createAdapterHarness({ messageIds: ["om_message_1", null] });
    const state = await adapter.startStreamReply("oc_synthetic", "working");
    await adapter.updateStreamReply("oc_synthetic", state, table);
    await adapter.updateStreamReply("oc_synthetic", state, `${table}\n\nsecond`);
    await adapter.finishStreamReply("oc_synthetic", state, "final");

    expect(state).toEqual({
      messageId: null, previousMessageId: "om_message_1", renderKind: "interactive", missingMessageId: true,
    });
    expect(requests.map(({ method }) => method)).toEqual(["POST", "PUT", "POST"]);
  });

  it.each(["update", "finish"])("does not retry or create a replacement after an uncertain interactive %s failure", async (operation) => {
    const error = new Error("synthetic transport failure after unknown delivery");
    const { adapter, sequence } = createAdapterHarness({ updateError: error });
    const state = await adapter.startStreamReply("oc_synthetic", table);
    const update = operation === "update" ? adapter.updateStreamReply : adapter.finishStreamReply;

    await expect(update.call(adapter, "oc_synthetic", state, "second")).rejects.toMatchObject({ cause: error });

    expect(sequence()).toEqual([
      {
        method: "POST", path: "/open-apis/im/v1/messages",
        data: { receive_id: "oc_synthetic", msg_type: "interactive", content: cardContent(table) },
      },
      {
        method: "PATCH", path: "/open-apis/im/v1/messages/om_message_1",
        data: { content: cardContent("second") },
      },
    ]);
  });
});
