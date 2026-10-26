import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const transport = vi.hoisted(() => ({ fetch: vi.fn(), sockets: [] as string[] }));

// Keep the real HTTP helper and proxy resolver; replace only the network transport.
vi.mock("undici", async (importOriginal) => ({
  ...await importOriginal<typeof import("undici")>(),
  fetch: transport.fetch,
}));
vi.mock("ws", () => ({
  default: class {
    static OPEN = 1;
    readyState = 0;
    constructor(url: string) { transport.sockets.push(url); }
    on() {}
    send() {}
    close() {}
  },
}));
vi.mock("../lib/debug-log.ts", () => ({
  debugLog: () => null,
  createModuleLogger: () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { createQQAdapter } from "../lib/bridge/qq-adapter.ts";
import { createOutboundProxyRuntime, fetchDispatcherForUrl } from "../lib/net/outbound-proxy.ts";

const ORIGIN = "https://api.bot.qq.com";
const STORAGE_URL = "https://upload.example.invalid/part?signature=synthetic";
const GATEWAY_URL = "wss://gateway.example.invalid/socket";
const TOKEN = "synthetic-access-token";
const PROXY = "http://127.0.0.1:7890";

describe("QQ official endpoint and credential contracts", () => {
  const runtime = createOutboundProxyRuntime({ log: () => {}, warn: () => {}, env: {} });
  let adapter: ReturnType<typeof createQQAdapter>;
  let tempDir: string;

  beforeEach(() => {
    transport.fetch.mockReset();
    transport.sockets.length = 0;
    // A second, bare-fetch exit must never bypass the captured transport.
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("unexpected global fetch"); }));
    transport.fetch.mockImplementation(async (url: string) => {
      const pathname = new URL(url).pathname;
      if (pathname === "/app/getAppAccessToken") {
        return Response.json({ access_token: TOKEN, expires_in: "7200" });
      }
      if (pathname === "/gateway") return Response.json({ url: GATEWAY_URL });
      if (pathname.endsWith("/upload_prepare")) {
        return Response.json({
          upload_id: "synthetic-upload", block_size: "4",
          parts: [{ index: 0, block_size: "4", presigned_url: STORAGE_URL }],
          upload_config: { concurrency: 1, retry_timeout: 300, retry_delay: 1 },
        });
      }
      if (pathname.endsWith("/files")) return Response.json({ file_info: "synthetic-file-info" });
      if (pathname === "/part" || pathname.endsWith("/upload_part_finish")) return new Response("");
      if (pathname === "/users/@me" || pathname.endsWith("/messages")) return Response.json({});
      throw new Error(`unexpected synthetic request: ${url}`);
    });
  });

  afterEach(() => {
    adapter?.stop();
    adapter = undefined;
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
    runtime.reset();
    vi.unstubAllGlobals();
  });

  async function connect() {
    adapter = createQQAdapter({
      appID: "synthetic-app-id", appSecret: "synthetic-client-secret", agentId: "synthetic-agent",
      onMessage: vi.fn(), dmGuildMap: undefined, onDmGuildDiscovered: undefined, onStatus: vi.fn(),
    });
    await vi.waitFor(() => expect(transport.sockets).toEqual([GATEWAY_URL]));
  }

  it.each(["direct", "proxy", "api-noProxy", "storage-noProxy", "legacy-noProxy"])(
    "captures every REST path, credentials and per-URL dispatcher in %s mode",
    async (mode) => {
      runtime.apply(mode === "direct" ? { mode: "direct" } : {
        mode: "manual", httpsProxy: PROXY,
        noProxy: mode === "api-noProxy" ? "api.bot.qq.com"
          : mode === "storage-noProxy" ? "upload.example.invalid"
            : mode === "legacy-noProxy" ? "api.sgroup.qq.com,bots.qq.com" : "",
      });
      await connect();
      await adapter.getMe();
      for (const targetType of ["user", "group", "channel"]) {
        await adapter.sendReply(`synthetic-${targetType}`, "hello", { targetType });
      }
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "qq-endpoint-contract-"));
      const filePath = path.join(tempDir, "image.png");
      fs.writeFileSync(filePath, "data");
      for (const isGroup of [false, true]) {
        const chatId = isGroup ? "synthetic-group" : "synthetic-user";
        await adapter.sendMedia(chatId, "https://media.example.invalid/image.png", { isGroup, kind: "image" });
        await adapter.sendMediaFile(chatId, filePath, { isGroup, kind: "image", filename: "image.png" });
      }

      const expected = [
        ["POST", `${ORIGIN}/app/getAppAccessToken`],
        ["GET", `${ORIGIN}/gateway`],
        ["GET", `${ORIGIN}/users/@me`],
        ["POST", `${ORIGIN}/v2/users/synthetic-user/messages`],
        ["POST", `${ORIGIN}/v2/groups/synthetic-group/messages`],
        ["POST", `${ORIGIN}/channels/synthetic-channel/messages`],
        ...["users/synthetic-user", "groups/synthetic-group"].flatMap((target) => [
          ["POST", `${ORIGIN}/v2/${target}/files`],
          ["POST", `${ORIGIN}/v2/${target}/messages`],
          ["POST", `${ORIGIN}/v2/${target}/upload_prepare`],
          ["PUT", STORAGE_URL],
          ["POST", `${ORIGIN}/v2/${target}/upload_part_finish`],
          ["POST", `${ORIGIN}/v2/${target}/files`],
          ["POST", `${ORIGIN}/v2/${target}/messages`],
        ]),
      ];
      expect(transport.fetch.mock.calls.map(([url, init]) => [init.method, String(url)])).toEqual(expected);
      expect(transport.fetch.mock.calls).toHaveLength(20);
      for (const [url, init] of transport.fetch.mock.calls) {
        const headers = new Headers(init.headers);
        const isStorage = url === STORAGE_URL;
        const isToken = new URL(url).pathname === "/app/getAppAccessToken";
        const proxied = mode === "proxy" || mode === "legacy-noProxy" || (mode === "api-noProxy" && isStorage)
          || (mode === "storage-noProxy" && !isStorage);
        const resolved = fetchDispatcherForUrl(url, {});
        expect(resolved.proxyUrl).toBe(proxied ? PROXY : "");
        expect(init.dispatcher).toBe(proxied ? resolved.dispatcher : undefined);
        expect(headers.get("authorization")).toBe(isToken || isStorage ? null : `QQBot ${TOKEN}`);
        if (isStorage) {
          expect(headers.get("content-type")).toBeNull();
          expect(headers.get("content-length")).toBe("4");
          expect(await init.body.text()).toBe("data");
        } else {
          expect(headers.get("content-type")).toBe("application/json");
          if (isToken) {
            expect(JSON.parse(init.body)).toEqual({ appId: "synthetic-app-id", clientSecret: "synthetic-client-secret" });
          } else {
            expect(String(init.body)).not.toContain("synthetic-client-secret");
            expect(String(init.body)).not.toContain(TOKEN);
          }
        }
      }
      expect(globalThis.fetch).not.toHaveBeenCalled();
    },
  );

  it("keeps noProxy host matching separate from lookalike and previous hosts", () => {
    runtime.apply({ mode: "manual", httpsProxy: PROXY, noProxy: "api.bot.qq.com" });
    expect(fetchDispatcherForUrl(`${ORIGIN}/gateway`, {}).dispatcher).toBeNull();
    for (const host of ["api.bot.qq.com.evil.invalid", "evilapi.bot.qq.com", "sub.api.bot.qq.com", "api-bot.qq.com", "api.sgroup.qq.com", "bots.qq.com"]) {
      expect(fetchDispatcherForUrl(`https://${host}/gateway`, {}).proxyUrl).toBe(PROXY);
    }
  });

  it.each(["network", "503"])("does not switch hosts or repeat an explicit-target send after %s failure", async (failure) => {
    runtime.apply({ mode: "direct" });
    await connect();
    transport.fetch.mockImplementationOnce(async () => {
      if (failure === "network") throw new TypeError("synthetic uncertain outcome");
      return Response.json({ code: 123, message: "synthetic failure" }, { status: 503 });
    });
    await expect(adapter.sendReply("synthetic-user", "hello", { targetType: "user" })).rejects.toThrow();
    expect(transport.fetch.mock.calls.map(([url]) => String(url))).toEqual([
      `${ORIGIN}/app/getAppAccessToken`, `${ORIGIN}/gateway`, `${ORIGIN}/v2/users/synthetic-user/messages`,
    ]);
  });
});
