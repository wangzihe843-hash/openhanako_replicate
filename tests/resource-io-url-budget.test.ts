import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UrlProvider } from "../lib/resource-io/providers/url-provider.ts";
import { ResourceIO } from "../lib/resource-io/resource-io.ts";
import { wrapResourceIoFileTools } from "../lib/resource-io/agent-tools.ts";

const ref = { kind: "url" as const, url: "https://example.com/data.bin" };
const tooLarge = { code: "url_response_too_large", status: 413, message: "URL response too large" };
const roots: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function stream(chunks: Uint8Array[], init: ResponseInit = {}, cancelImpl?: () => void | Promise<void>) {
  let pulls = 0;
  let bytes = 0;
  const cancel = vi.fn(cancelImpl ?? (() => {}));
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[pulls];
      if (chunk) { pulls++; bytes += chunk.byteLength; controller.enqueue(chunk); }
      else controller.close();
    },
    cancel,
  }, { highWaterMark: 0 });
  const response = new Response(body, init);
  return { body, response, cancel, stats: () => ({ pulls, bytes }) };
}

function providerFor(response: Response, options: { maxBytes?: number; timeoutMs?: number; materializeRoot?: string } = {}) {
  return new UrlProvider({ fetch: vi.fn(async () => response), resolveHostname: async () => ["93.184.216.34"], maxBytes: 8, ...options });
}

describe("UrlProvider streaming byte budget", () => {
  it.each([undefined, "1", "8", "invalid", "-1", "Infinity"])("stops an over-budget body despite Content-Length=%s", async (length) => {
    const fixture = stream(Array.from({ length: 10 }, () => new Uint8Array(4)), {
      headers: length === undefined ? {} : { "Content-Length": length },
    });
    const arrayBuffer = vi.spyOn(fixture.response, "arrayBuffer");
    await expect(providerFor(fixture.response).read(ref)).rejects.toMatchObject(tooLarge);
    expect(fixture.stats()).toEqual({ pulls: 3, bytes: 12 });
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(fixture.cancel).toHaveBeenCalledOnce();
    expect(fixture.body.locked).toBe(false);
  });

  it("keeps the existing large Content-Length fast rejection and cancels without reading", async () => {
    const fixture = stream([new Uint8Array(4)], { headers: { "Content-Length": "40" } });
    await expect(providerFor(fixture.response).read(ref)).rejects.toMatchObject(tooLarge);
    expect(fixture.stats()).toEqual({ pulls: 0, bytes: 0 });
    expect(fixture.cancel).toHaveBeenCalledOnce();
    expect(fixture.body.locked).toBe(false);
  });

  it("does not retain an oversized first chunk or pull the next chunk", async () => {
    const fixture = stream([new Uint8Array(40), new Uint8Array(4)]);
    await expect(providerFor(fixture.response).read(ref)).rejects.toMatchObject(tooLarge);
    expect(fixture.stats()).toEqual({ pulls: 1, bytes: 40 });
    expect(fixture.cancel).toHaveBeenCalledOnce();
    expect(fixture.body.locked).toBe(false);
  });

  it.each([
    { label: "below", chunks: [new Uint8Array([1, 2])] },
    { label: "exact", chunks: [new Uint8Array(4), new Uint8Array(4)] },
    { label: "empty chunks", chunks: [new Uint8Array(0), new Uint8Array(8), new Uint8Array(0)] },
    { label: "empty stream", chunks: [] },
  ])("returns full bytes and releases the reader at $label limit", async ({ chunks }) => {
    const fixture = stream(chunks, { headers: { etag: '"v1"', "last-modified": "Wed, 21 Oct 2026 00:00:00 GMT" } });
    const result = await providerFor(fixture.response).fetchSafe(ref.url);
    expect(result).toEqual({ finalUrl: ref.url, content: Buffer.concat(chunks), etag: '"v1"', lastModified: "Wed, 21 Oct 2026 00:00:00 GMT" });
    expect(fixture.body.locked).toBe(false);
    expect(fixture.cancel).not.toHaveBeenCalled();
  });

  it("preserves UTF-8 across chunks and counts bytes rather than characters", async () => {
    const bytes = Buffer.from("汉🙂");
    const chunks = [bytes.subarray(0, 1), bytes.subarray(1, 5), bytes.subarray(5)];
    const good = stream(chunks);
    const result = await providerFor(good.response, { maxBytes: 7 }).read(ref);
    expect(result.content.toString("utf8")).toBe("汉🙂");
    expect(result.version).toEqual({ size: 7 });
    const bad = stream(chunks);
    await expect(providerFor(bad.response, { maxBytes: 6 }).read(ref)).rejects.toMatchObject(tooLarge);
    expect(bad.cancel).toHaveBeenCalledOnce();
  });

  it("preserves binary subarray offsets and bytes including a UTF-8 BOM", async () => {
    const source = new Uint8Array([9, 0xef, 0xbb, 0xbf, 0, 0xff, 7]);
    const fixture = stream([source.subarray(1, 4), source.subarray(4, 6)]);
    expect((await providerFor(fixture.response).read(ref)).content).toEqual(Buffer.from([0xef, 0xbb, 0xbf, 0, 0xff]));
  });

  it("accepts byte arrays from another realm", async () => {
    const fixture = stream([runInNewContext("new Uint8Array([0, 255, 7])")]);
    expect((await providerFor(fixture.response).read(ref)).content).toEqual(Buffer.from([0, 255, 7]));
  });

  it.each([200, 204, 205])("retains null-body status %s as an empty successful resource", async (status) => {
    const result = await providerFor(new Response(null, { status }), { maxBytes: 0 }).read(ref);
    expect(result.content).toEqual(Buffer.alloc(0));
    expect(result.version).toEqual({ size: 0 });
  });

  it("rejects a non-byte stream chunk with TypeError and stops reading", async () => {
    const fixture = stream(["not bytes" as unknown as Uint8Array, new Uint8Array(4)]);
    await expect(providerFor(fixture.response).read(ref)).rejects.toBeInstanceOf(TypeError);
    expect(fixture.stats().pulls).toBe(1);
    expect(fixture.cancel).toHaveBeenCalledOnce();
    expect(fixture.body.locked).toBe(false);
  });

  it.each(["full", "partial"])("retains the rejection for a %s consumed response", async (consumption) => {
    const fixture = stream([new Uint8Array(4), new Uint8Array(4)]);
    if (consumption === "full") await fixture.response.arrayBuffer();
    else { const reader = fixture.body.getReader(); await reader.read(); reader.releaseLock(); }
    await expect(providerFor(fixture.response).read(ref)).rejects.toBeInstanceOf(TypeError);
  });

  it("does not release or cancel another owner's locked reader", async () => {
    const fixture = stream([new Uint8Array(4)]);
    const reader = fixture.body.getReader();
    try {
      await expect(providerFor(fixture.response).read(ref)).rejects.toBeInstanceOf(TypeError);
      expect(fixture.body.locked).toBe(true);
      expect(fixture.cancel).not.toHaveBeenCalled();
    } finally { await reader.cancel(); reader.releaseLock(); }
  });

  it.each(["resolve", "throw", "reject", "pending"])("preserves the budget error when cancellation is %s", async (mode) => {
    let finish = () => {};
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const fixture = stream([new Uint8Array(9)], {}, () => {
      if (mode === "throw") throw new Error("cancel failed");
      if (mode === "reject") return Promise.reject(new Error("cancel failed"));
      if (mode === "pending") return pending;
    });
    try {
      await expect(providerFor(fixture.response).read(ref)).rejects.toMatchObject(tooLarge);
      expect(fixture.cancel).toHaveBeenCalledOnce();
      expect(fixture.body.locked).toBe(false);
    } finally { finish(); await pending; }
  });

  it("propagates the original read failure and releases the lock", async () => {
    const failure = new Error("synthetic body failure");
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({ pull(controller) {
      if (pulls++ === 0) controller.enqueue(new Uint8Array(2));
      else controller.error(failure);
    } }, { highWaterMark: 0 });
    await expect(providerFor(new Response(body)).read(ref)).rejects.toBe(failure);
    expect(body.locked).toBe(false);
  });

  it("times out a pending read even when transport ignores the signal and cancel remains pending", async () => {
    vi.useFakeTimers();
    let finish = () => {};
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const cancel = vi.fn(() => pending);
    let bodyController: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(controller) { bodyController = controller; }, pull() {}, cancel }, { highWaterMark: 0 });
    let requestSignal: AbortSignal | undefined;
    const provider = new UrlProvider({ maxBytes: 8, timeoutMs: 10, resolveHostname: async () => ["93.184.216.34"],
      fetch: async (_url, init) => { requestSignal = init.signal; return new Response(body); },
    });
    const result = provider.read(ref).catch(error => error);
    try {
      await vi.advanceTimersByTimeAsync(11);
      // Race avoids leaving the baseline test itself pending forever.
      const outcome = await Promise.race([result, Promise.resolve("pending")]);
      expect(outcome).toBe(requestSignal?.reason);
      expect(requestSignal?.reason).toMatchObject({ name: "AbortError" });
      expect(cancel).toHaveBeenCalledOnce();
      expect(body.locked).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      finish();
      // Make an unpatched baseline's pending reader settle without a real timer.
      try { bodyController.close(); } catch { /* A cancelled stream is already closed. */ }
      await result;
    }
  });

  it("keeps a transport's read AbortError and clears its timeout", async () => {
    vi.useFakeTimers();
    let bodyController: ReadableStreamDefaultController<Uint8Array>;
    let requestSignal: AbortSignal;
    const body = new ReadableStream<Uint8Array>({ start(controller) { bodyController = controller; } });
    const provider = new UrlProvider({ maxBytes: 8, timeoutMs: 10, resolveHostname: async () => ["93.184.216.34"],
      fetch: async (_url, init) => {
        requestSignal = init.signal;
        requestSignal.addEventListener("abort", () => bodyController.error(requestSignal.reason), { once: true });
        return new Response(body);
      },
    });
    const result = provider.read(ref).catch(error => error);
    await vi.advanceTimersByTimeAsync(11);
    expect(await result).toBe(requestSignal.reason);
    expect(body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["success", "oversize", "read error", "fetch error"])("clears timers and owned abort listeners after %s", async (mode) => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal;
    let remove: ReturnType<typeof vi.spyOn>;
    let add: ReturnType<typeof vi.spyOn>;
    const provider = new UrlProvider({ maxBytes: 8, timeoutMs: 10, resolveHostname: async () => ["93.184.216.34"],
      fetch: async (_url, init) => {
        requestSignal = init.signal;
        add = vi.spyOn(requestSignal, "addEventListener"); remove = vi.spyOn(requestSignal, "removeEventListener");
        if (mode === "fetch error") throw new Error("fetch failed");
        if (mode === "read error") return new Response(new ReadableStream({ start(controller) { controller.error(new Error("read failed")); } }));
        return stream([new Uint8Array(mode === "oversize" ? 9 : 2)]).response;
      },
    });
    await provider.read(ref).catch(() => {});
    for (const [event, listener] of add.mock.calls) expect(remove).toHaveBeenCalledWith(event, listener);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(requestSignal.aborted).toBe(false);
  });

  it.each([
    { name: "http error", status: 503, headers: {}, code: "url_fetch_failed" },
    { name: "missing location", status: 302, headers: {}, code: "invalid_url_redirect" },
    { name: "unsafe redirect", status: 302, headers: { location: "http://localhost/private" }, code: "blocked_private_url" },
    { name: "redirect limit", status: 302, headers: { location: "/next" }, code: "url_redirect_limit" },
  ])("cancels unread $name bodies while preserving the error", async ({ name, status, headers, code }) => {
    let finish = () => {};
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const fixture = stream([new Uint8Array(40)], { status, headers }, () => pending);
    const provider = providerFor(fixture.response);
    if (name === "redirect limit") provider.maxRedirects = 0;
    try {
      await expect(provider.read(ref)).rejects.toMatchObject({ code });
      expect(fixture.stats().bytes).toBe(0);
      expect(fixture.cancel).toHaveBeenCalledOnce();
      expect(fixture.body.locked).toBe(false);
    } finally { finish(); await pending; }
  });

  it("cancels a redirect body before fetching the validated destination and retains metadata", async () => {
    const redirect = stream([new Uint8Array(40)], { status: 303, headers: { location: "/final" } });
    const final = stream([Buffer.from("ok")], { headers: { etag: '"v2"' } });
    const fetch = vi.fn(async () => {
      if (fetch.mock.calls.length === 1) return redirect.response;
      expect(redirect.cancel).toHaveBeenCalledOnce();
      return final.response;
    });
    const provider = new UrlProvider({ fetch, resolveHostname: async () => ["93.184.216.34"], maxBytes: 8 });
    expect(await provider.read(ref)).toMatchObject({ resourceKey: "url:" + ref.url,
      resource: { url: ref.url, displayName: "https://example.com/final" }, version: { size: 2, etag: '"v2"' }, content: Buffer.from("ok") });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(final.body.locked).toBe(false);
  });

  it("enforces the budget through the real agent read wrapper and permits a later successful retry", async () => {
    const oversized = stream(Array.from({ length: 10 }, () => new Uint8Array(4)));
    const fetch = vi.fn().mockResolvedValueOnce(oversized.response).mockResolvedValueOnce(new Response("ok"));
    const provider = new UrlProvider({ fetch, maxBytes: 8, resolveHostname: async () => ["93.184.216.34"] });
    const resourceIO = new ResourceIO({ providers: { url: provider } });
    const fallback = vi.fn();
    const [tool] = wrapResourceIoFileTools([{ name: "read", parameters: { type: "object", properties: {} }, execute: fallback }], { cwd: os.tmpdir(), resourceIO });
    await expect(tool.execute("budget", { url: ref.url })).rejects.toMatchObject(tooLarge);
    expect(oversized.stats()).toEqual({ pulls: 3, bytes: 12 });
    const retry = await tool.execute("retry", { url: ref.url });
    expect(retry.content[0]).toEqual({ type: "text", text: "URL: " + ref.url + "\n\nok" });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("does not write or overwrite a materialized file after a budget or read failure", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "url-budget-")); roots.push(root);
    const fetch = vi.fn().mockResolvedValueOnce(new Response("ok"));
    const provider = new UrlProvider({ fetch, maxBytes: 8, materializeRoot: path.join(root, "cache"), resolveHostname: async () => ["93.184.216.34"] });
    const saved = await provider.materialize(ref);
    fetch.mockResolvedValueOnce(stream([new Uint8Array(9)]).response);
    await expect(provider.materialize(ref)).rejects.toMatchObject(tooLarge);
    fetch.mockResolvedValueOnce(new Response(new ReadableStream({ start(controller) { controller.error(new Error("read failed")); } })));
    await expect(provider.materialize(ref)).rejects.toThrow("read failed");
    expect(fs.readFileSync(saved.filePath, "utf8")).toBe("ok");
    expect(fs.readdirSync(provider.materializeRoot)).toHaveLength(1);
    provider.materializeRoot = path.join(root, "absent");
    fetch.mockResolvedValueOnce(stream([new Uint8Array(9)]).response);
    await expect(provider.materialize(ref)).rejects.toMatchObject(tooLarge);
    expect(fs.existsSync(provider.materializeRoot)).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("uses the same bounded read for stat", async () => {
    const fixture = stream([new Uint8Array(9), new Uint8Array(1)]);
    await expect(providerFor(fixture.response).stat(ref)).rejects.toMatchObject(tooLarge);
    expect(fixture.stats().pulls).toBe(1);
    expect(fixture.cancel).toHaveBeenCalledOnce();
  });

  it.each([
    { label: "zero", maxBytes: 0, size: 0 }, { label: "fractional", maxBytes: 1.5, size: 1 },
    { label: "infinite", maxBytes: Infinity, size: 12 }, { label: "NaN", maxBytes: NaN, size: 12 },
  ])("preserves configured $label budget semantics", async ({ maxBytes, size }) => {
    const fixture = stream([new Uint8Array(size)]);
    expect((await providerFor(fixture.response, { maxBytes }).read(ref)).version.size).toBe(size);
    expect(fixture.body.locked).toBe(false);
  });

  it("retains the existing default of 10 MiB without allocating a large body", async () => {
    const fixture = stream([new Uint8Array(1)], { headers: { "Content-Length": String(10 * 1024 * 1024 + 1) } });
    const provider = new UrlProvider({ fetch: async () => fixture.response, resolveHostname: async () => ["93.184.216.34"] });
    expect(provider.maxBytes).toBe(10 * 1024 * 1024);
    await expect(provider.read(ref)).rejects.toMatchObject(tooLarge);
    expect(fixture.stats().bytes).toBe(0);
    expect(fixture.cancel).toHaveBeenCalledOnce();
  });
});
