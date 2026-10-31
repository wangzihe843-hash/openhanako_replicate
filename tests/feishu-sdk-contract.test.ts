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
        httpInstance: {
          request: (request: CapturedRequest) => sdk.defaultHttpInstance.request({
            ...request,
            // Keep the installed SDK's Axios JSON serializer, replacing only
            // the final I/O adapter. No token or message endpoint reaches I/O.
            adapter: async (config) => ({
              data: await adapterTransport.request({
                ...request,
                data: JSON.parse(config.data),
                rawBody: config.data,
              }),
              status: 200,
              statusText: "OK",
              headers: {},
              config,
            }),
          }),
        } as unknown as HttpInstance,
      });
    }
  }

  class MockEventDispatcher {
    register() { return this; }
  }

  class MockWSClient {
    getConnectionStatus() { return { state: "connected" }; }
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
  rawBody?: string;
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
  cardId = "card_1",
}: { messageIds?: Array<string | null>; updateError?: Error; cardId?: string } = {}) {
  const requests: CapturedRequest[] = [];
  let messageIndex = 0;
  adapterTransport.request.mockReset();
  // Every SDK HTTP request terminates here. Unknown endpoints are errors and
  // never fall through to the network, including token requests.
  adapterTransport.request.mockImplementation(async (request: CapturedRequest) => {
    const url = new URL(request.url);
    requests.push({ method: request.method, url: request.url, data: request.data, params: request.params, rawBody: request.rawBody });
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
      return { code: 0, data: { card_id: cardId } };
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

describe("Feishu ordinary message UTF-8 envelope budget through the installed SDK", () => {
  const chatId = "oc_synthetic";
  const maxBytes = 30_000;
  const byteLength = (body: unknown) => Buffer.byteLength(JSON.stringify(body), "utf8");
  const cases = [
    { label: "post create", operation: "create", kind: "post", method: "POST" },
    { label: "interactive create", operation: "create", kind: "interactive", method: "POST" },
    { label: "post update", operation: "update", kind: "post", method: "PUT" },
    { label: "interactive patch", operation: "patch", kind: "interactive", method: "PATCH" },
  ] as const;
  type EnvelopeCase = typeof cases[number];

  function bodyFor(testCase: EnvelopeCase, text: string, receiveId = chatId) {
    const content = testCase.kind === "post" ? postContent(text) : cardContent(text);
    if (testCase.operation === "create") {
      return { receive_id: receiveId, msg_type: testCase.kind, content };
    }
    return testCase.operation === "update" ? { msg_type: "post", content } : { content };
  }

  function textAtBytes(testCase: EnvelopeCase, bytes: number, seed = "", receiveId = chatId) {
    const prefix = testCase.kind === "interactive" ? `${table}\n\n${seed}` : seed;
    const padding = bytes - byteLength(bodyFor(testCase, prefix, receiveId));
    expect(padding).toBeGreaterThanOrEqual(0);
    return `${prefix}${"x".repeat(padding)}`;
  }

  async function prepare(testCase: EnvelopeCase) {
    const harness = createAdapterHarness();
    const state = testCase.operation === "create" ? null : await harness.adapter.startStreamReply(
      chatId, testCase.kind === "post" ? "initial" : table,
    );
    harness.requests.length = 0;
    return {
      ...harness,
      send: (text: string, receiveId = chatId) => testCase.operation === "create"
        ? harness.adapter.sendReply(receiveId, text)
        : harness.adapter.updateStreamReply(receiveId, state, text),
    };
  }

  for (const testCase of cases) {
    it.each([29_999, 30_000, 30_001])(`${testCase.label} applies the exact %i-byte final JSON boundary`, async (bytes) => {
      const { send, requests } = await prepare(testCase);
      const text = textAtBytes(testCase, bytes);
      const expected = bodyFor(testCase, text);
      expect(byteLength(expected)).toBe(bytes);

      if (bytes > maxBytes) {
        await expect(send(text)).rejects.toMatchObject({
          name: "FeishuMessageTooLargeError",
          code: "FEISHU_MESSAGE_TOO_LARGE",
          operation: testCase.operation,
          actualBytes: bytes,
          maxBytes,
        });
        expect(requests).toEqual([]);
      } else {
        await send(text);
        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({ method: testCase.method, data: expected });
        expect(requests[0].rawBody).toBe(JSON.stringify(expected));
        expect(Buffer.byteLength(requests[0].rawBody!, "utf8")).toBe(bytes);
      }
    });
  }

  it.each([
    { label: "Chinese", seed: "汉字".repeat(2_000) },
    { label: "emoji", seed: "🙂🚀".repeat(1_500) },
    { label: "quotes and backslashes", seed: '"\\'.repeat(2_000) },
    { label: "JSON control escapes", seed: "\u0000\t".repeat(1_000) },
  ])("counts $label after both levels of JSON escaping, preserving an accepted body", async ({ seed }) => {
    const testCase = cases[0];
    const { send, requests } = await prepare(testCase);
    const text = textAtBytes(testCase, maxBytes, seed);
    expect(text.length).toBeLessThan(maxBytes);
    expect(Buffer.byteLength(postContent(text), "utf8")).toBeLessThan(maxBytes);

    await send(text);
    expect(requests[0].rawBody).toBe(JSON.stringify(bodyFor(testCase, text)));
    expect(Buffer.byteLength(requests[0].rawBody!, "utf8")).toBe(maxBytes);
    expect(JSON.parse(requests[0].data.content as string).zh_cn.content[0][0].text).toBe(text);
    requests.length = 0;
    await expect(send(`${text}x`)).rejects.toMatchObject({ actualBytes: maxBytes + 1, maxBytes });
    expect(requests).toEqual([]);
  });

  it("counts nested mention tags and the escaped receive_id as part of the create body", async () => {
    const { adapter, requests } = createAdapterHarness();
    const receiveId = 'oc_汉🙂"\\';
    const mention = '<at user_id="ou_test">名字🙂</at>';
    const mentionContent = (tail: string) => JSON.stringify({ zh_cn: { content: [[
      { tag: "at", user_id: "ou_test", user_name: "名字🙂" },
      { tag: "md", text: tail },
    ]] } });
    const body = (tail: string) => ({ receive_id: receiveId, msg_type: "post", content: mentionContent(tail) });
    const tail = "x".repeat(maxBytes - byteLength(body("")));

    await adapter.sendReply(receiveId, `${mention}${tail}`);
    expect(requests[0].rawBody).toBe(JSON.stringify(body(tail)));
    expect(Buffer.byteLength(requests[0].rawBody!, "utf8")).toBe(maxBytes);
    requests.length = 0;
    await expect(adapter.sendReply(receiveId, `${mention}${tail}x`)).rejects.toMatchObject({
      actualBytes: maxBytes + 1, maxBytes, operation: "create",
    });
    expect(requests).toEqual([]);
  });

  it.each(["sendReply", "sendBlockReply", "startStreamReply"] as const)("rejects 15,000 Chinese characters before %s sends any request", async (method) => {
    const { adapter, requests } = createAdapterHarness();
    const text = "汉".repeat(15_000);
    const actualBytes = byteLength(bodyFor(cases[0], text));
    expect(text.length).toBeLessThan(150_000);
    expect(Buffer.byteLength(postContent(text), "utf8")).toBe(45_048);
    await expect(adapter[method](chatId, text)).rejects.toMatchObject({
      code: "FEISHU_MESSAGE_TOO_LARGE", operation: "create", actualBytes, maxBytes,
    });
    expect(requests).toEqual([]);
  });

  it.each(["post", "interactive"] as const)("keeps the original %s stream unchanged when finish exceeds the byte budget", async (kind) => {
    const { adapter, requests } = createAdapterHarness();
    const state = await adapter.startStreamReply(chatId, kind === "post" ? "working" : table);
    const originalState = { ...state };
    requests.length = 0;
    const testCase = kind === "post" ? cases[2] : cases[3];
    const text = textAtBytes(testCase, maxBytes + 1);
    await expect(adapter.finishStreamReply(chatId, state, text)).rejects.toMatchObject({
      code: "FEISHU_MESSAGE_TOO_LARGE", operation: testCase.operation,
    });
    expect(requests).toEqual([]);
    expect(state).toEqual(originalState);
  });

  it("rejects an oversized post-to-card transition before replacing the original post with a hint", async () => {
    const { adapter, requests } = createAdapterHarness();
    const state = await adapter.startStreamReply(chatId, "working");
    const originalState = { ...state };
    requests.length = 0;
    const text = textAtBytes(cases[1], maxBytes + 1);
    await expect(adapter.updateStreamReply(chatId, state, text)).rejects.toMatchObject({
      code: "FEISHU_MESSAGE_TOO_LARGE", operation: "create", actualBytes: maxBytes + 1,
    });
    expect(requests).toEqual([]);
    expect(state).toEqual(originalState);
  });

  it("does not apply the ordinary-message cap to CardKit entity JSON or element content", async () => {
    const { adapter, requests } = createAdapterHarness();
    const text = "汉🙂".repeat(8_000);
    const state = await adapter.startRichStreamReply(chatId, text);
    await adapter.updateRichStreamReply(chatId, state, text);
    await adapter.finishRichStreamReply(chatId, state, text);
    expect(Buffer.byteLength(requests[0].rawBody!, "utf8")).toBeGreaterThan(maxBytes);
    const contentRequests = requests.filter((request) => request.url.endsWith("/content"));
    expect(contentRequests).toHaveLength(2);
    expect(contentRequests.every((request) => request.data.content === text)).toBe(true);
    expect(contentRequests.every((request) => Buffer.byteLength(request.rawBody!, "utf8") > maxBytes)).toBe(true);
  });

  it.each(["receive_id", "card_id"])("guards the standard IM CardKit reference envelope with an oversized %s", async (field) => {
    const largeId = '汉🙂"\\'.repeat(5_000);
    const receiveId = field === "receive_id" ? largeId : chatId;
    const cardId = field === "card_id" ? largeId : "card_1";
    const { adapter, requests } = createAdapterHarness({ cardId });
    const body = {
      receive_id: receiveId,
      msg_type: "interactive",
      content: JSON.stringify({ type: "card", data: { card_id: cardId } }),
    };

    await expect(adapter.startRichStreamReply(receiveId, "working")).rejects.toMatchObject({
      code: "FEISHU_MESSAGE_TOO_LARGE", operation: "create", actualBytes: byteLength(body), maxBytes,
    });

    // The independent entity API can already have run; its content budget is
    // separate. No standard IM send or streaming settings may follow rejection.
    expect(requests).toHaveLength(1);
    expect(new URL(requests[0].url).pathname).toBe("/open-apis/cardkit/v1/cards");
  });

  it.each([
    Object.assign(new Error("synthetic timeout with unknown delivery"), { code: "ETIMEDOUT" }),
    Object.assign(new Error("synthetic rate limit"), { response: { status: 429, data: { code: 99991400, msg: "limited" } } }),
  ])("does not retry or replace an accepted-size PUT after $message", async (error) => {
    const { adapter, requests } = createAdapterHarness({ updateError: error });
    const state = await adapter.startStreamReply(chatId, "working");
    requests.length = 0;
    await expect(adapter.updateStreamReply(chatId, state, "final")).rejects.toMatchObject({ cause: error });
    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe("PUT");
  });
});
