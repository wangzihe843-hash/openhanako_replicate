import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { BridgeHttpError, type BridgeOutboundRequestOptions } from "../lib/bridge/outbound-http.ts";

vi.mock("ws", async () => {
  const { EventEmitter } = await import("node:events");
  class MockWebSocket extends EventEmitter {
    static OPEN = 1;
    static CLOSED = 3;
    readyState = 1;
    constructor() {
      super();
      queueMicrotask(() => {
        this.emit("message", JSON.stringify({ op: 10, d: { heartbeat_interval: 30_000 } }));
        this.emit("message", JSON.stringify({ op: 0, t: "READY", s: 1, d: { session_id: "synthetic-session" } }));
      });
    }
    send(value: string) { if (JSON.parse(value).op === 1) this.emit("message", JSON.stringify({ op: 11 })); }
    close() { this.readyState = 3; this.emit("close", 1000); }
  }
  return { default: MockWebSocket };
});

vi.mock("../lib/debug-log.js", () => ({
  debugLog: () => null,
  createModuleLogger: () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

// #1612：adapter 的所有出站 REST 必须经由 Bridge outbound HTTP helper（带 stage），
// 这里 mock 成 globalThis.fetch 透传，既捕获 stage 标签，又让既有断言继续工作。
const outboundCapture = vi.hoisted(() => ({
  platforms: [] as string[],
  requests: [] as Array<{ stage: string; url: string; method: string; idempotent?: boolean }>,
}));

vi.mock("../lib/bridge/outbound-http.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/bridge/outbound-http.ts")>(),
  createBridgeOutboundHttp: ({ platform }: any) => {
    outboundCapture.platforms.push(platform);
    return {
      request: async ({ stage, url, method = "GET", headers, body, idempotent }: BridgeOutboundRequestOptions) => {
        outboundCapture.requests.push({ stage, url: String(url), method, idempotent });
        return (globalThis as any).fetch(url, { method, headers, body });
      },
    };
  },
}));

import { createQQAdapter, deriveQQPrincipal } from "../lib/bridge/qq-adapter.ts";

function jsonResponse(body) {
  return {
    ok: true,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function emptyResponse() {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers(),
    json: async () => ({}),
    text: async () => "",
  };
}

describe("createQQAdapter media delivery", () => {
  let tmpDir = null;

  beforeEach(() => {
    outboundCapture.platforms.length = 0;
    outboundCapture.requests.length = 0;
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const href = String(url);
      if (href.includes("/app/getAppAccessToken")) {
        return jsonResponse({ access_token: "qq-token", expires_in: 7200 });
      }
      if (href.endsWith("/gateway")) {
        return jsonResponse({ url: "ws://localhost/qq" });
      }
      if (href.includes("cos.example.com")) {
        return emptyResponse();
      }
      if (href.includes("/upload_prepare")) {
        return jsonResponse({
          upload_id: "upload-1",
          block_size: "5",
          parts: [
            { index: 0, block_size: "5", presigned_url: "https://cos.example.com/part-0" },
            { index: 1, block_size: "5", presigned_url: "https://cos.example.com/part-1" },
          ],
          upload_config: { concurrency: 1, retry_timeout: 300, retry_delay: 1 },
        });
      }
      if (href.includes("/upload_part_finish")) {
        return emptyResponse();
      }
      if (href.includes("/files")) {
        return jsonResponse({ file_uuid: "file-uuid", file_info: "file-info", ttl: 3600 });
      }
      return jsonResponse({});
    }));
  });

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function makeTempFile(name, content) {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-qq-adapter-"));
    const filePath = path.join(tmpDir, name);
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  function md5Hex(value) {
    return crypto.createHash("md5").update(value).digest("hex");
  }

  function sha1Hex(value) {
    return crypto.createHash("sha1").update(value).digest("hex");
  }

  it("rejects local buffer media with an explicit unsupported error", async () => {
    const adapter = createQQAdapter({
      appID: "app-id",
      appSecret: "app-secret",
      agentId: "hana",
      onMessage: vi.fn(),
    } as any);

    await expect(
      adapter.sendMediaBuffer("chat-1", Buffer.from("png"), {
        mime: "image/png",
        filename: "image.png",
      }),
    ).rejects.toThrow(/QQ.*本地.*staged file/);

    expect(fetch).not.toHaveBeenCalledWith(
      expect.stringContaining("/files"),
      expect.anything(),
    );
    adapter.stop();
  });

  it("uploads local C2C staged files through QQ chunked upload before sending rich media", async () => {
    const filePath = makeTempFile("note.txt", "helloworld");
    const adapter = createQQAdapter({
      appID: "app-id",
      appSecret: "app-secret",
      agentId: "hana",
      onMessage: vi.fn(),
    } as any);

    await adapter.sendMediaFile("user-openid", filePath, {
      kind: "document",
      mime: "text/plain",
      filename: "note.txt",
      isGroup: false,
    });

    const prepareCall = (fetch as any).mock.calls.find(([url]: any) => String(url).includes("/v2/users/user-openid/upload_prepare"));
    expect(prepareCall).toBeTruthy();
    expect(JSON.parse(prepareCall[1].body)).toMatchObject({
      file_type: 4,
      file_name: "note.txt",
      file_size: "10",
      md5: md5Hex("helloworld"),
      sha1: sha1Hex("helloworld"),
      md5_10m: md5Hex("helloworld"),
    });

    const putCalls = (fetch as any).mock.calls.filter(([url]: any) => String(url).includes("cos.example.com"));
    expect(putCalls).toHaveLength(2);
    expect(await putCalls[0][1].body.text()).toBe("hello");
    expect(await putCalls[1][1].body.text()).toBe("world");

    const partFinishCalls = (fetch as any).mock.calls.filter(([url]: any) => String(url).includes("/v2/users/user-openid/upload_part_finish"));
    expect(partFinishCalls).toHaveLength(2);
    expect(JSON.parse(partFinishCalls[0][1].body)).toMatchObject({
      upload_id: "upload-1",
      part_index: 0,
      block_size: "5",
      md5: md5Hex("hello"),
    });
    expect(JSON.parse(partFinishCalls[1][1].body)).toMatchObject({
      upload_id: "upload-1",
      part_index: 1,
      block_size: "5",
      md5: md5Hex("world"),
    });

    const completeCall = (fetch as any).mock.calls.find(([url, init = {}]: any) =>
      String(url).includes("/v2/users/user-openid/files")
      && init.body
      && JSON.parse(init.body).upload_id === "upload-1"
    );
    expect(completeCall).toBeTruthy();
    expect(JSON.parse(completeCall[1].body)).toEqual({ upload_id: "upload-1", file_name: "note.txt", file_type: 4, srv_send_msg: false });

    const messageCall = (fetch as any).mock.calls.find(([url]: any) => String(url).includes("/v2/users/user-openid/messages"));
    expect(JSON.parse(messageCall[1].body)).toMatchObject({
      msg_type: 7,
      media: { file_info: "file-info" },
    });
    adapter.stop();
  });

  it("sends QQ group replies as markdown passive replies with msg_id and distinct msg_seq values", async () => {
    const adapter = createQQAdapter({
      appID: "app-id",
      appSecret: "app-secret",
      agentId: "hana",
      onMessage: vi.fn(),
    } as any);

    await adapter.sendReply("group-openid", "first", {
      messageId: "qq-mid-1",
      targetType: "group",
      isGroup: true,
    });
    await adapter.sendReply("group-openid", "second", {
      messageId: "qq-mid-1",
      targetType: "group",
      isGroup: true,
    });

    const messageCalls = (fetch as any).mock.calls.filter(([url]: any) => String(url).includes("/v2/groups/group-openid/messages"));
    expect(messageCalls).toHaveLength(2);
    expect(JSON.parse(messageCalls[0][1].body)).toEqual({
      msg_type: 2,
      markdown: { content: "first" },
      msg_id: "qq-mid-1",
      msg_seq: 1,
    });
    expect(JSON.parse(messageCalls[1][1].body)).toEqual({
      msg_type: 2,
      markdown: { content: "second" },
      msg_id: "qq-mid-1",
      msg_seq: 2,
    });
    expect((fetch as any).mock.calls.some(([url]: any) => String(url).includes("/v2/users/group-openid/messages"))).toBe(false);
    adapter.stop();
  });

  it("sends QQ C2C replies as official markdown messages", async () => {
    const adapter = createQQAdapter({
      appID: "app-id",
      appSecret: "app-secret",
      agentId: "hana",
      onMessage: vi.fn(),
    } as any);

    await adapter.sendReply("user-openid", "**bold**\n- item", {
      messageId: "qq-dm-1",
      targetType: "user",
      isGroup: false,
    });

    const messageCall = (fetch as any).mock.calls.find(([url]: any) => String(url).includes("/v2/users/user-openid/messages"));
    expect(JSON.parse(messageCall[1].body)).toEqual({
      msg_type: 2,
      markdown: { content: "**bold**\n- item" },
      msg_id: "qq-dm-1",
      msg_seq: 1,
    });
    adapter.stop();
  });

  it("sends legacy QQ channel replies with the channel markdown object", async () => {
    const adapter = createQQAdapter({
      appID: "app-id",
      appSecret: "app-secret",
      agentId: "hana",
      onMessage: vi.fn(),
    } as any);

    await adapter.sendReply("channel-id", "# Title", {
      messageId: "qq-channel-mid-1",
      targetType: "channel",
      isGroup: true,
    });

    const messageCall = (fetch as any).mock.calls.find(([url]: any) => String(url).includes("/channels/channel-id/messages"));
    expect(JSON.parse(messageCall[1].body)).toEqual({
      markdown: { content: "# Title" },
      msg_id: "qq-channel-mid-1",
      msg_seq: 1,
    });
    adapter.stop();
  });

  it.each(["user", "group"])("preserves %s markdown chunks and sequence across later text and media", async (targetType) => {
    const adapter = createQQAdapter({
      appID: "app-id",
      appSecret: "app-secret",
      agentId: "hana",
      onMessage: vi.fn(),
      dmGuildMap: undefined,
      onDmGuildDiscovered: undefined,
      onStatus: undefined,
    });
    const chatId = `${targetType}-openid`;
    const isGroup = targetType === "group";
    const context = { messageId: "qq-chunk-mid", targetType, isGroup };
    const chunks = ["中".repeat(2000), "文".repeat(100)];

    await adapter.sendReply(chatId, chunks.join(""), context);
    await adapter.sendReply(chatId, "**later**", context);
    await adapter.sendMedia(chatId, "https://cdn.example.com/image.png", {
      kind: "image",
      isGroup,
      replyContext: context,
    });

    const messageCalls = vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith("/messages"));
    expect(messageCalls.map(([url]) => new URL(String(url)).pathname)).toEqual(
      Array(4).fill(`/v2/${isGroup ? "groups" : "users"}/${chatId}/messages`),
    );
    expect(messageCalls.map(([, init]) => JSON.parse(init?.body as string))).toEqual([
      ...[...chunks, "**later**"].map((content, index) => ({
        msg_type: 2,
        markdown: { content },
        msg_id: context.messageId,
        msg_seq: index + 1,
      })),
      {
        content: " ",
        msg_type: 7,
        media: { file_info: "file-info" },
        msg_id: context.messageId,
        msg_seq: 4,
      },
    ]);
    expect(outboundCapture.requests.filter(({ stage }) => stage === "send_reply").map(({ idempotent }) => idempotent))
      .toEqual([false, false, false]);
    adapter.stop();
  });

  it.each([
    ["user", 403], ["group", 403], ["channel", 403],
    ["user", 503], ["group", 503], ["channel", 503],
    ["user", "network"], ["group", "network"], ["channel", "network"],
  ])("does not resend or send later chunks after %s markdown fails with %s", async (targetType, failure) => {
    const adapter = createQQAdapter({
      appID: "app-id",
      appSecret: "app-secret",
      agentId: "hana",
      onMessage: vi.fn(),
      dmGuildMap: undefined,
      onDmGuildDiscovered: undefined,
      onStatus: undefined,
    });
    await vi.advanceTimersByTimeAsync(0);
    vi.mocked(fetch).mockClear();
    vi.mocked(fetch).mockImplementation(async () => {
      // This file stubs the helper, so retain its production transport-error contract.
      if (failure === "network") throw new BridgeHttpError("synthetic unknown send result", {
        platform: "qq", stage: "send_reply", method: "POST", host: "api.bot.qq.com",
        proxied: false, proxyUrl: "", attempts: 1, timedOut: false,
      });
      return new Response('{"message":"synthetic rejection"}', { status: Number(failure) });
    });

    const sending = adapter.sendReply("target-id", "x".repeat(2001), {
      messageId: "qq-failed-mid",
      targetType,
    });
    if (failure === 403) await expect(sending).rejects.toThrow(/synthetic rejection/);
    else await expect(sending).rejects.toMatchObject({ deliveryUnknown: true, retryable: false });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(new URL(String(url)).pathname).toBe(targetType === "channel"
      ? "/channels/target-id/messages"
      : `/v2/${targetType === "group" ? "groups" : "users"}/target-id/messages`);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({
      ...(targetType === "channel" ? {} : { msg_type: 2 }),
      markdown: { content: "x".repeat(2000) },
      msg_id: "qq-failed-mid",
      msg_seq: 1,
    });
    expect(outboundCapture.requests.filter(({ stage }) => stage === "send_reply"))
      .toEqual([{ stage: "send_reply", url: String(url), method: "POST", idempotent: false }]);
    adapter.stop();
  });

  it("uploads local group images through QQ group chunked upload", async () => {
    const filePath = makeTempFile("image.png", "helloworld");
    const adapter = createQQAdapter({
      appID: "app-id",
      appSecret: "app-secret",
      agentId: "hana",
      onMessage: vi.fn(),
    } as any);

    await adapter.sendMediaFile("group-openid", filePath, {
      kind: "image",
      mime: "image/png",
      filename: "image.png",
      isGroup: true,
    });

    const prepareCall = (fetch as any).mock.calls.find(([url]: any) => String(url).includes("/v2/groups/group-openid/upload_prepare"));
    expect(prepareCall).toBeTruthy();
    expect(JSON.parse(prepareCall[1].body)).toMatchObject({ file_type: 1 });
    expect((fetch as any).mock.calls.some(([url]: any) => String(url).includes("/v2/users/group-openid/upload_prepare"))).toBe(false);

    const messageCall = (fetch as any).mock.calls.find(([url]: any) => String(url).includes("/v2/groups/group-openid/messages"));
    expect(JSON.parse(messageCall[1].body)).toMatchObject({
      msg_type: 7,
      media: { file_info: "file-info" },
    });
    adapter.stop();
  });

  it.each(["prepare-business", "finish-business", "finish-body", "merge-unknown", "merge-invalid", "merge-body", "message-unknown"])(
    "never repeats a local upload or media message after %s, even without explicit scope",
    async failure => {
      const filePath = makeTempFile("image.png", "helloworld");
      const mockedFetch = vi.mocked(fetch);
      const original = mockedFetch.getMockImplementation()!;
      mockedFetch.mockImplementation(async (url, init) => {
        const endpoint = new URL(String(url)).pathname;
        if ((failure === "prepare-business" && endpoint.endsWith("/upload_prepare"))
          || (failure === "finish-business" && endpoint.endsWith("/upload_part_finish"))) {
          return Response.json({ code: 850031, message: "synthetic rejected file" });
        }
        if (failure === "merge-invalid" && endpoint.endsWith("/files")) return Response.json({ file_info: 123 });
        if ((failure === "finish-body" && endpoint.endsWith("/upload_part_finish"))
          || (failure === "merge-body" && endpoint.endsWith("/files"))) {
          return new Response(new ReadableStream({ start(controller) {
            controller.error(new TypeError("synthetic truncated response"));
          } }));
        }
        if ((failure === "merge-unknown" && endpoint.endsWith("/files"))
          || (failure === "message-unknown" && endpoint.endsWith("/messages"))) throw new TypeError("synthetic unknown outcome");
        return original(url, init);
      });
      const adapter = createQQAdapter({ appID: "synthetic-id", appSecret: "synthetic-secret", agentId: "hana", onMessage: vi.fn(), onStatus: vi.fn(), dmGuildMap: undefined, onDmGuildDiscovered: undefined });
      try {
        await expect(adapter.sendMediaFile("synthetic-target", filePath, { kind: "image" })).rejects.toThrow();
        const urls = mockedFetch.mock.calls.map(([url]) => String(url));
        expect(urls.some(url => url.includes("/groups/"))).toBe(false);
        expect(urls.filter(url => url.endsWith("/upload_prepare"))).toHaveLength(1);
        expect(urls.filter(url => url.endsWith("/files"))).toHaveLength(failure.startsWith("prepare") || failure.startsWith("finish") ? 0 : 1);
        expect(urls.filter(url => url.endsWith("/messages"))).toHaveLength(failure === "message-unknown" ? 1 : 0);
      } finally { adapter.stop(); }
    },
  );

  it("sends QQ rich media replies with passive reply context", async () => {
    const adapter = createQQAdapter({
      appID: "app-id",
      appSecret: "app-secret",
      agentId: "hana",
      onMessage: vi.fn(),
    } as any);

    await adapter.sendMedia("group-openid", "https://cdn.example.com/image.png", {
      kind: "image",
      mime: "image/png",
      filename: "image.png",
      isGroup: true,
      replyContext: {
        messageId: "qq-mid-1",
        targetType: "group",
      },
    });

    const messageCall = (fetch as any).mock.calls.find(([url]: any) => String(url).includes("/v2/groups/group-openid/messages"));
    expect(JSON.parse(messageCall[1].body)).toMatchObject({
      msg_type: 7,
      media: { file_info: "file-info" },
      msg_id: "qq-mid-1",
      msg_seq: 1,
    });
    adapter.stop();
  });

  it("rejects local group documents before chunked upload", async () => {
    const filePath = makeTempFile("note.txt", "helloworld");
    const adapter = createQQAdapter({
      appID: "app-id",
      appSecret: "app-secret",
      agentId: "hana",
      onMessage: vi.fn(),
    } as any);

    await expect(adapter.sendMediaFile("group-openid", filePath, {
      kind: "document",
      mime: "text/plain",
      filename: "note.txt",
      isGroup: true,
    })).rejects.toThrow(/群聊.*暂不开放文件类型/);

    expect((fetch as any).mock.calls.some(([url]: any) => String(url).includes("/upload_prepare"))).toBe(false);
    adapter.stop();
  });

  it("uses staged file metadata to choose QQ rich-media image file_type for extensionless URLs", async () => {
    const adapter = createQQAdapter({
      appID: "app-id",
      appSecret: "app-secret",
      agentId: "hana",
      onMessage: vi.fn(),
    } as any);

    await adapter.sendMedia("user-openid", "https://hana.example.com/api/bridge/media/token_123", {
      kind: "image",
      mime: "image/png",
      filename: "image.png",
    });

    const uploadCall = (fetch as any).mock.calls.find(([url]: any) => String(url).includes("/v2/users/user-openid/files"));
    expect(uploadCall).toBeTruthy();
    expect(JSON.parse(uploadCall[1].body)).toMatchObject({
      file_type: 1,
      url: "https://hana.example.com/api/bridge/media/token_123",
      srv_send_msg: false,
    });
    const messageCall = (fetch as any).mock.calls.find(([url]: any) => String(url).includes("/v2/users/user-openid/messages"));
    expect(JSON.parse(messageCall[1].body)).toMatchObject({
      msg_type: 7,
      media: { file_info: "file-info" },
    });
    adapter.stop();
  });

  it("sends C2C documents with QQ rich-media file_type 4", async () => {
    const adapter = createQQAdapter({
      appID: "app-id",
      appSecret: "app-secret",
      agentId: "hana",
      onMessage: vi.fn(),
    } as any);

    await adapter.sendMedia("user-openid", "https://cdn.example.com/note.txt", {
      kind: "document",
      mime: "text/plain",
      filename: "note.txt",
    });

    const uploadCall = (fetch as any).mock.calls.find(([url]: any) => String(url).includes("/v2/users/user-openid/files"));
    expect(uploadCall).toBeTruthy();
    expect(JSON.parse(uploadCall[1].body)).toMatchObject({
      file_type: 4,
      url: "https://cdn.example.com/note.txt",
      srv_send_msg: false,
    });
    adapter.stop();
  });

  it("uses the group rich-media endpoint directly when Bridge knows the target is a group", async () => {
    const adapter = createQQAdapter({
      appID: "app-id",
      appSecret: "app-secret",
      agentId: "hana",
      onMessage: vi.fn(),
    } as any);

    await adapter.sendMedia("group-openid", "https://cdn.example.com/image.png", {
      kind: "image",
      mime: "image/png",
      filename: "image.png",
      isGroup: true,
    });

    expect((fetch as any).mock.calls.some(([url]: any) => String(url).includes("/v2/users/group-openid/files"))).toBe(false);
    const uploadCall = (fetch as any).mock.calls.find(([url]: any) => String(url).includes("/v2/groups/group-openid/files"));
    expect(uploadCall).toBeTruthy();
    expect(JSON.parse(uploadCall[1].body)).toMatchObject({ file_type: 1 });
    adapter.stop();
  });

  it("labels every QQ outbound REST call with an explicit stage for diagnostics (#1612)", async () => {
    const filePath = makeTempFile("note.txt", "helloworld");
    const adapter = createQQAdapter({
      appID: "app-id",
      appSecret: "app-secret",
      agentId: "hana",
      onMessage: vi.fn(),
    } as any);

    // 排空后台 connect()（token + gateway）的微任务链
    await vi.advanceTimersByTimeAsync(0);

    await adapter.sendReply("user-openid", "hi", {
      messageId: "qq-dm-1",
      targetType: "user",
      isGroup: false,
    });
    await adapter.sendMediaFile("user-openid", filePath, {
      kind: "document",
      mime: "text/plain",
      filename: "note.txt",
      isGroup: false,
    });

    expect(outboundCapture.platforms).toContain("qq");
    const stages = outboundCapture.requests.map((r) => r.stage);
    expect(stages).toContain("token");
    expect(stages).toContain("gateway");
    expect(stages).toContain("send_reply");
    expect(stages).toContain("upload_prepare");
    expect(stages).toContain("upload_part_put");
    expect(stages).toContain("upload_part_finish");
    expect(stages).toContain("upload_complete");
    expect(stages).toContain("send_media_message");
    // 每一笔出站调用都必须显式带 stage，禁止匿名出站
    expect(outboundCapture.requests.length).toBeGreaterThan(0);
    expect(outboundCapture.requests.every((r) => typeof r.stage === "string" && r.stage.length > 0)).toBe(true);
    adapter.stop();
  });

  it("rejects QQ group documents before upload because the official API has not opened file_type 4 for groups", async () => {
    const adapter = createQQAdapter({
      appID: "app-id",
      appSecret: "app-secret",
      agentId: "hana",
      onMessage: vi.fn(),
    } as any);

    await expect(adapter.sendMedia("group-openid", "https://cdn.example.com/note.txt", {
      kind: "document",
      mime: "text/plain",
      filename: "note.txt",
      isGroup: true,
    })).rejects.toThrow(/群聊.*暂不开放文件类型/);

    expect((fetch as any).mock.calls.some(([url]: any) => String(url).includes("/v2/groups/group-openid/files"))).toBe(false);
    adapter.stop();
  });
});

describe("QQ principal metadata", () => {
  it("prefers stable author id as principal while keeping C2C openid as delivery alias", () => {
    expect(deriveQQPrincipal({
      id: "stable-user-id",
      user_openid: "c2c-openid",
      username: "User",
    })).toEqual({
      principalId: "stable-user-id",
      aliases: ["stable-user-id", "c2c-openid"],
      displayName: null,
      fallbackName: "QQ stab…r-id",
    });
  });

  it("uses member openid as a QQ alias without treating placeholder username as display name", () => {
    expect(deriveQQPrincipal({
      id: "stable-user-id",
      member_openid: "member-openid",
      username: "User",
    })).toEqual({
      principalId: "stable-user-id",
      aliases: ["stable-user-id", "member-openid"],
      displayName: null,
      fallbackName: "QQ stab…r-id",
    });
  });

  it("uses QQ member card and avatar metadata when username is a placeholder", () => {
    expect(deriveQQPrincipal({
      id: "stable-user-id",
      username: "User",
      avatar: "https://example.com/fallback.png",
    }, {
      member_openid: "member-openid",
      card: "Alice Card",
      avatarUrl: "https://example.com/alice.png",
    })).toEqual({
      principalId: "stable-user-id",
      aliases: ["stable-user-id", "member-openid"],
      displayName: "Alice Card",
      avatarUrl: "https://example.com/alice.png",
      fallbackName: "QQ stab…r-id",
    });
  });
});
