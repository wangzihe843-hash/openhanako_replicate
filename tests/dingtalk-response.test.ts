import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DINGTALK_TOKEN_RESPONSE_BODY_TIMEOUT_MS,
  DINGTALK_TOKEN_RESPONSE_MAX_BYTES,
  readDingTalkResponse,
} from "../lib/bridge/dingtalk-api.ts";

const encoder = new TextEncoder();

function chunkedResponse(chunks: Uint8Array[], headers?: HeadersInit) {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  }), { headers });
}

describe("DingTalk response body budget", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("retains the local ten-second, 64KiB defaults", () => {
    expect(DINGTALK_TOKEN_RESPONSE_BODY_TIMEOUT_MS).toBe(10_000);
    expect(DINGTALK_TOKEN_RESPONSE_MAX_BYTES).toBe(65_536);
  });

  it("reads one real stream as JSON and releases its lock", async () => {
    const response = chunkedResponse([encoder.encode('{"ok":true,"count":3}')]);
    const json = vi.spyOn(response, "json");
    const text = vi.spyOn(response, "text");
    await expect(readDingTalkResponse(response)).resolves.toEqual({ ok: true, count: 3 });
    expect(response.body.locked).toBe(false);
    expect(json).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
  });

  it("decodes UTF-8 after joining chunks that split Chinese and emoji bytes", async () => {
    const expected = { message: "你好🙂" };
    const bytes = encoder.encode(JSON.stringify(expected));
    const response = chunkedResponse(Array.from(bytes, byte => new Uint8Array([byte])));
    await expect(readDingTalkResponse(response, { maxBytes: bytes.byteLength })).resolves.toEqual(expected);
    expect(response.body.locked).toBe(false);
  });

  it.each([undefined, "1", "999999999"])("accepts exactly 64KiB based on actual bytes, Content-Length=%s", async contentLength => {
    const body = JSON.stringify({ value: "x".repeat(65_524) });
    expect(encoder.encode(body)).toHaveLength(65_536);
    const response = chunkedResponse(
      [encoder.encode(body)],
      contentLength === undefined ? undefined : { "Content-Length": contentLength },
    );
    await expect(readDingTalkResponse(response)).resolves.toEqual(JSON.parse(body));
    expect(response.body.locked).toBe(false);
  });

  it.each([undefined, "0", "8"])("rejects 64KiB plus one byte despite Content-Length=%s", async contentLength => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(65_536));
        controller.enqueue(new Uint8Array(1));
      },
      cancel,
    }), { headers: contentLength === undefined ? undefined : { "Content-Length": contentLength } });
    await expect(readDingTalkResponse(response, { stage: "send_dm" })).rejects.toThrow(/DingTalk send_dm response body exceeded 65536 bytes/);
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body.locked).toBe(false);
  });

  it("counts UTF-8 bytes rather than JavaScript characters", async () => {
    const body = '"🙂"';
    expect(body).toHaveLength(4);
    expect(encoder.encode(body)).toHaveLength(6);
    await expect(readDingTalkResponse(chunkedResponse([encoder.encode(body)]), { maxBytes: 6 })).resolves.toBe("🙂");
    await expect(readDingTalkResponse(chunkedResponse([encoder.encode(body)]), { maxBytes: 5 })).rejects.toThrow(/exceeded 5 bytes/);
  });

  it("uses one total body deadline even when new chunks keep arriving", async () => {
    let interval: ReturnType<typeof setInterval>;
    const cancel = vi.fn(() => clearInterval(interval));
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        interval = setInterval(() => controller.enqueue(encoder.encode(" ")), 3_000);
      },
      cancel,
    }));
    const result = readDingTalkResponse(response, { stage: "stream_open" }).catch(error => error);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(cancel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBeInstanceOf(Error);
    expect((await result).message).toMatch(/DingTalk stream_open response body timed out after 10000ms/);
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body.locked).toBe(false);
  });

  it("cancels a completely stalled real stream and releases its reader", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }));
    const result = readDingTalkResponse(response).catch(error => error);
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await result).message).toMatch(/DingTalk token response body timed out/);
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body.locked).toBe(false);
  });

  it("stops an infinite ready stream at its byte limit", async () => {
    const cancel = vi.fn();
    const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => controller.enqueue(new Uint8Array(1024)));
    const response = new Response(new ReadableStream<Uint8Array>({ pull, cancel }));
    await expect(readDingTalkResponse(response)).rejects.toThrow(/exceeded 65536 bytes/);
    expect(cancel).toHaveBeenCalledOnce();
    expect(pull.mock.calls.length).toBeLessThan(70);
    expect(response.body.locked).toBe(false);
  });

  it("checks the deadline even when empty chunks are immediately ready", async () => {
    let pulls = 0;
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        vi.setSystemTime(Date.now() + 1_000);
        // Close eventually so a broken deadline cannot hang the test process.
        if (pulls > 15) controller.close();
        else controller.enqueue(new Uint8Array(0));
      },
      cancel,
    }));
    await expect(readDingTalkResponse(response)).rejects.toThrow(/timed out/);
    expect(pulls).toBeLessThan(15);
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body.locked).toBe(false);
  });

  it.each([new Error("read failed"), new DOMException("aborted by transport", "AbortError")])("preserves a failed read and releases/cancels its reader (%s)", async failure => {
    const cancel = vi.spyOn(ReadableStreamDefaultReader.prototype, "cancel");
    const release = vi.spyOn(ReadableStreamDefaultReader.prototype, "releaseLock");
    const response = new Response(new ReadableStream<Uint8Array>({
      pull() { throw failure; },
    }));
    await expect(readDingTalkResponse(response)).rejects.toBe(failure);
    expect(cancel).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(response.body.locked).toBe(false);
  });

  it.each(["timeout", "size"])("does not await an underlying cancel that never settles after %s", async reason => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        if (reason === "size") controller.enqueue(new Uint8Array(65_537));
      },
      cancel,
    }));
    const result = readDingTalkResponse(response).catch(error => error);
    if (reason === "timeout") await vi.advanceTimersByTimeAsync(10_000);
    expect((await result).message).toMatch(reason === "timeout" ? /timed out/ : /exceeded/);
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body.locked).toBe(false);
  });

  it.each(["timeout", "size"])("handles an underlying cancel rejection after %s", async reason => {
    const cancel = vi.fn(async () => { throw new Error("synthetic cancel rejection"); });
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        if (reason === "size") controller.enqueue(new Uint8Array(65_537));
      },
      cancel,
    }));
    const result = readDingTalkResponse(response).catch(error => error);
    if (reason === "timeout") await vi.advanceTimersByTimeAsync(10_000);
    expect((await result).message).toMatch(reason === "timeout" ? /timed out/ : /exceeded/);
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body.locked).toBe(false);
  });

  it.each(["", "not JSON <html>synthetic upstream error</html>"])("reads empty/non-JSON bodies exactly once (%s)", async body => {
    const response = chunkedResponse([encoder.encode(body)]);
    await expect(readDingTalkResponse(response)).resolves.toEqual(body || {});
    expect(response.body.locked).toBe(false);
  });

  it("uses the text-only shim once and never falls through to json after a read rejection", async () => {
    const text = vi.fn(async () => '{"value":"fixture"}');
    const json = vi.fn();
    await expect(readDingTalkResponse({ text, json })).resolves.toEqual({ value: "fixture" });
    expect(text).toHaveBeenCalledOnce();
    expect(json).not.toHaveBeenCalled();
    const failure = new Error("shim read failed");
    text.mockRejectedValueOnce(failure);
    await expect(readDingTalkResponse({ text, json })).rejects.toBe(failure);
    expect(text).toHaveBeenCalledTimes(2);
    expect(json).not.toHaveBeenCalled();
  });

  it("retains the json-only shim as one read", async () => {
    const json = vi.fn(async () => ({ value: "fixture" }));
    await expect(readDingTalkResponse({ json })).resolves.toEqual({ value: "fixture" });
    expect(json).toHaveBeenCalledOnce();
  });

  it.each(["text", "json"])("bounds %s-only shim time and size", async kind => {
    const pending = vi.fn(() => new Promise(() => {}));
    const result = readDingTalkResponse({ [kind]: pending }, { timeoutMs: 20 }).catch(error => error);
    await vi.advanceTimersByTimeAsync(20);
    expect((await result).message).toMatch(/timed out/);
    expect(pending).toHaveBeenCalledOnce();
    const body = kind === "text" ? '"🙂"' : "🙂";
    const read = vi.fn(async () => body);
    await expect(readDingTalkResponse({ [kind]: read }, { maxBytes: 6 })).resolves.toBe("🙂");
    await expect(readDingTalkResponse({ [kind]: read }, { maxBytes: 5 })).rejects.toThrow(/exceeded 5 bytes/);
    expect(read).toHaveBeenCalledTimes(2);
  });
});
