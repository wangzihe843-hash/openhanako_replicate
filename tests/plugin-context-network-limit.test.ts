import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginContext } from "../core/plugin-context.ts";
import { runInNewContext } from "node:vm";

const URL = "https://fixture.invalid/body";
const DEFAULT_LIMIT = 5 * 1024 * 1024;
type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

function network(fetchImpl: FetchImpl, ...limits: [unknown?]) {
  const maxResponseBytes = limits.length ? limits[0] : 16;
  return createPluginContext({
    pluginId: "limit-fixture",
    pluginDir: "/synthetic/plugins/limit-fixture",
    dataDir: "/synthetic/plugin-data/limit-fixture",
    bus: {},
    capabilities: ["network.fetch"],
    network: { allowedHosts: ["fixture.invalid"], methods: ["GET", "HEAD"], maxResponseBytes },
    fetchImpl,
  } as Parameters<typeof createPluginContext>[0]).network;
}

function fixture(chunks: Uint8Array[], headers: HeadersInit = {}, cancel?: () => void | Promise<void>) {
  const stats = { pulls: 0, produced: 0, cancelled: 0, closed: false };
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      stats.pulls++;
      if (index === chunks.length) {
        stats.closed = true;
        controller.close();
      } else {
        const chunk = chunks[index++];
        stats.produced += chunk.byteLength;
        controller.enqueue(chunk);
      }
    },
    cancel() {
      stats.cancelled++;
      return cancel?.();
    },
  }, { highWaterMark: 0 });
  const response = new Response(stream, { headers });
  return { response, stream, stats };
}

function tooLarge(limit: number, observed: number) {
  return {
    code: "PLUGIN_NETWORK_RESPONSE_TOO_LARGE", pluginId: "limit-fixture",
    message: `Plugin network.fetch response exceeded ${limit} bytes`,
    maxResponseBytes: limit, responseBytes: observed,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("plugin network streaming response budget", () => {
  it.each([undefined, "4096", "1", "0", "invalid"])("stops a 4096-byte response at its first excess chunk, Content-Length=%s", async (length) => {
    const upstream = fixture(Array.from({ length: 16 }, () => new Uint8Array(256)),
      length === undefined ? {} : { "content-length": length });
    const readAll = vi.spyOn(upstream.response, "arrayBuffer");
    const api = network(async () => upstream.response);
    await expect(api.fetch(URL)).rejects.toMatchObject(tooLarge(16, 256));
    expect(upstream.stats).toEqual({ pulls: 1, produced: 256, cancelled: 1, closed: false });
    expect(upstream.stream.locked).toBe(false);
    expect(readAll).not.toHaveBeenCalled();
  });

  it("counts across chunks and stops immediately after crossing the budget", async () => {
    const upstream = fixture([new Uint8Array(8), new Uint8Array(8), new Uint8Array(1), new Uint8Array(128)]);
    await expect(network(async () => upstream.response).fetch(URL)).rejects.toMatchObject(tooLarge(16, 17));
    expect(upstream.stats).toEqual({ pulls: 3, produced: 17, cancelled: 1, closed: false });
    expect(upstream.stream.locked).toBe(false);
  });

  it.each([
    { name: "empty", chunks: [] },
    { name: "zero-length chunk", chunks: [new Uint8Array(0)] },
    { name: "exact limit with empty chunk", chunks: [new Uint8Array(8), new Uint8Array(0), new Uint8Array(8)] },
  ])(
    "accepts $name without cancellation", async ({ chunks }) => {
      const upstream = fixture(chunks);
      const response = await network(async () => upstream.response).fetch(URL);
      expect(response.body).not.toBeNull();
      expect((await response.arrayBuffer()).byteLength).toBe(chunks.reduce((size, chunk) => size + chunk.byteLength, 0));
      expect(upstream.stats.closed).toBe(true);
      expect(upstream.stats.cancelled).toBe(0);
      expect(upstream.stream.locked).toBe(false);
    },
  );

  it.each(["999999999", "invalid", "0"])("accepts small bodies despite misleading Content-Length=%s", async (length) => {
    const upstream = fixture([new Uint8Array([0, 255, 128, 1])], { "content-length": length });
    const response = await network(async () => upstream.response).fetch(URL);
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([0, 255, 128, 1]);
    expect(response.headers.get("content-length")).toBe(length);
  });

  it("keeps split UTF-8 bytes intact at the exact byte limit", async () => {
    const bytes = new TextEncoder().encode("世🙂界");
    const upstream = fixture(Array.from(bytes, (byte) => new Uint8Array([byte])));
    const response = await network(async () => upstream.response, bytes.byteLength).fetch(URL);
    await expect(response.text()).resolves.toBe("世🙂界");
    expect(upstream.stats.cancelled).toBe(0);
  });

  it("limits response-body bytes, including decoded bytes represented by a compressed transport header", async () => {
    // The injected transport supplies decoded bytes, as Node fetch does for supported encodings.
    // This does not simulate or test an actual decompressor/HTTP transport.
    const bytes = new TextEncoder().encode("世界");
    const upstream = fixture([bytes.subarray(0, 2), bytes.subarray(2, 4), bytes.subarray(4), new Uint8Array(8)],
      { "content-encoding": "gzip", "content-length": "2" });
    await expect(network(async () => upstream.response, 5).fetch(URL)).rejects.toMatchObject(tooLarge(5, 6));
    expect(upstream.stats.produced).toBe(6);
    expect(upstream.stats.cancelled).toBe(1);
  });

  it("preserves binary subarray views, metadata, clones, cache isolation and TTL", async () => {
    vi.useFakeTimers();
    const expected = new Uint8Array([0, 255, 128, 1]);
    const backing = new Uint8Array([55, ...expected, 66]);
    const fetchImpl = vi.fn(async () => new Response(fixture([backing.subarray(1, 3), backing.subarray(3, 5)]).stream, {
      status: 206, statusText: "Partial synthetic", headers: { "x-copy": "original", "content-type": "application/octet-stream" },
    }));
    const api = network(fetchImpl, 4);
    const first = await api.fetch(URL, { cacheTtlMs: 100 });
    const clone = first.clone();
    const received = new Uint8Array(await first.arrayBuffer());
    expect(received).toEqual(expected);
    received.fill(9);first.headers.set("x-copy", "mutated");
    expect(new Uint8Array(await clone.arrayBuffer())).toEqual(expected);
    const hit = await api.fetch(URL, { cacheTtlMs: 100 });
    expect(hit.status).toBe(206);expect(hit.statusText).toBe("Partial synthetic");
    expect(hit.headers.get("x-copy")).toBe("original");
    expect(hit.headers.get("content-type")).toBe("application/octet-stream");
    expect(new Uint8Array(await hit.arrayBuffer())).toEqual(expected);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(100);
    expect(new Uint8Array(await (await api.fetch(URL, { cacheTtlMs: 100 })).arrayBuffer())).toEqual(expected);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["resolve", "throw", "reject", "pending"])("keeps the size error and releases the reader when cancel=%s", async (mode) => {
    let finishCancel = () => {};
    const upstream = fixture([new Uint8Array(17), new Uint8Array(128)], {}, () => {
      if (mode === "throw") throw new Error("synthetic cancel throw");
      if (mode === "reject") return Promise.reject(new Error("synthetic cancel reject"));
      if (mode === "pending") return new Promise<void>((resolve) => { finishCancel = resolve; });
    });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const bounded = Promise.race([
        network(async () => upstream.response).fetch(URL),
        new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error("waited for cancel settlement")), 200); }),
      ]);
      await expect(bounded).rejects.toMatchObject(tooLarge(16, 17));
      expect(upstream.stats.cancelled).toBe(1);
      expect(upstream.stats.produced).toBe(17);
      expect(upstream.stream.locked).toBe(false);
    } finally {
      clearTimeout(deadline);finishCancel();
    }
  });

  it("does not cache a truncated prefix and cleans up timer/signal after overflow", async () => {
    vi.useFakeTimers();
    const upstream = fixture([new Uint8Array(8), new Uint8Array(9), new Uint8Array(128)]);
    const fetchImpl = vi.fn<FetchImpl>().mockResolvedValueOnce(upstream.response).mockResolvedValueOnce(new Response("ok"));
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const api = network(fetchImpl);
    await expect(api.fetch(URL, { cacheTtlMs: 100, signal: controller.signal })).rejects.toMatchObject(tooLarge(16, 17));
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
    controller.abort();
    expect(fetchImpl.mock.calls[0][1].signal?.aborted).toBe(false);
    for (let index = 0; index < 2; index++) await expect((await api.fetch(URL, { cacheTtlMs: 100 })).text()).resolves.toBe("ok");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("propagates a mid-stream failure, releases the reader and retries without a partial cache entry", async () => {
    vi.useFakeTimers();
    const error = new Error("synthetic mid-stream failure");
    let count = 0;
    const stream = new ReadableStream<Uint8Array>({ pull(controller) {
      if (count++ === 0) controller.enqueue(new Uint8Array([65, 66]));
      else controller.error(error);
    } }, { highWaterMark: 0 });
    const fetchImpl = vi.fn<FetchImpl>().mockResolvedValueOnce(new Response(stream)).mockResolvedValueOnce(new Response("ok"));
    const api = network(fetchImpl);
    const caller = new AbortController();
    const remove = vi.spyOn(caller.signal, "removeEventListener");
    await expect(api.fetch(URL, { cacheTtlMs: 100, signal: caller.signal })).rejects.toBe(error);
    expect(stream.locked).toBe(false);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    for (let index = 0; index < 2; index++) await expect((await api.fetch(URL, { cacheTtlMs: 100 })).text()).resolves.toBe("ok");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["caller", "timeout"])("preserves %s abort during a pending read and cleans up", async (mode) => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const reason = new Error("synthetic caller abort during body");
    let started!: () => void;
    const reading = new Promise<void>((resolve) => { started = resolve; });
    let stream!: ReadableStream<Uint8Array>;
    const fetchImpl = vi.fn<FetchImpl>().mockImplementationOnce(async (_url, init) => {
      stream = new ReadableStream<Uint8Array>({
        start(controller) {
          init.signal!.addEventListener("abort", () => controller.error(init.signal!.reason), { once: true });
        },
        pull() { started(); },
      }, { highWaterMark: 0 });
      return new Response(stream);
    }).mockResolvedValueOnce(new Response("ok"));
    const remove = vi.spyOn(caller.signal, "removeEventListener");
    const api = network(fetchImpl);
    const request = api.fetch(URL, { signal: caller.signal, timeoutMs: 25, cacheTtlMs: 100 });
    const rejected = mode === "caller" ? expect(request).rejects.toBe(reason) : expect(request).rejects.toThrow("timed out after 25ms");
    await reading;
    if (mode === "caller") caller.abort(reason);
    else await vi.advanceTimersByTimeAsync(25);
    await rejected;
    expect(stream.locked).toBe(false);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
    await expect((await api.fetch(URL, { cacheTtlMs: 100 })).text()).resolves.toBe("ok");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([undefined, null, 0, -1, NaN, Infinity, -Infinity])("retains the default budget for absent/invalid manifest limit %s", async (limit) => {
    const upstream = fixture([new Uint8Array(DEFAULT_LIMIT), new Uint8Array(1), new Uint8Array(128)]);
    await expect(network(async () => upstream.response, limit).fetch(URL)).rejects.toMatchObject(tooLarge(DEFAULT_LIMIT, DEFAULT_LIMIT + 1));
    expect(upstream.stats.cancelled).toBe(1);
  });

  it.each([0, -1, NaN, Infinity])("retains fallback rather than manifest limit for invalid call limit %s", async (limit) => {
    const api = network(async () => new Response("eight888"), 1);
    await expect((await api.fetch(URL, { maxResponseBytes: limit })).text()).resolves.toBe("eight888");
  });

  it.each([null, undefined])("retains manifest limit for nullish call limit %s", async (limit) => {
    const api = network(async () => new Response("four"), 3);
    await expect(api.fetch(URL, { maxResponseBytes: limit })).rejects.toMatchObject(tooLarge(3, 4));
  });

  it.each([{ name: "number", limit: 16.9 }, { name: "numeric string", limit: "16.9" }])("retains finite fractional coercion for call limit $name", async ({ limit }) => {
    const api = network(async () => new Response(new Uint8Array(17)), 1);
    await expect(api.fetch(URL, { maxResponseBytes: limit })).rejects.toMatchObject(tooLarge(16, 17));
  });

  it("retains the existing sub-unit call limit and separately normalized manifest behavior", async () => {
    const api = network(async () => new Response("a"), 0.5);
    await expect((await api.fetch(URL)).text()).resolves.toBe("a");
    await expect(api.fetch(URL, { maxResponseBytes: 0.5 })).rejects.toMatchObject(tooLarge(0, 1));
  });

  it("accepts exactly the default 5 MiB when the manifest has no limit", async () => {
    const upstream = fixture([new Uint8Array(DEFAULT_LIMIT)]);
    const response = await network(async () => upstream.response, null).fetch(URL);
    expect((await response.arrayBuffer()).byteLength).toBe(DEFAULT_LIMIT);
    expect(upstream.stats.cancelled).toBe(0);
  });

  it("retains per-call override and existing cache-hit semantics", async () => {
    const fetchImpl = vi.fn(async () => new Response("four"));
    const api = network(fetchImpl, 3);
    await expect((await api.fetch(URL, { maxResponseBytes: 4, cacheTtlMs: 100 })).text()).resolves.toBe("four");
    await expect((await api.fetch(URL, { maxResponseBytes: 1, cacheTtlMs: 100 })).text()).resolves.toBe("four");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects non-byte chunks without caching or consuming the remainder", async () => {
    const upstream = fixture(["not bytes" as unknown as Uint8Array, new Uint8Array(8)]);
    const fetchImpl = vi.fn<FetchImpl>().mockResolvedValueOnce(upstream.response).mockResolvedValueOnce(new Response("ok"));
    const api = network(fetchImpl);
    await expect(api.fetch(URL, { cacheTtlMs: 100 })).rejects.toBeInstanceOf(TypeError);
    expect(upstream.stream.locked).toBe(false);
    expect(upstream.stats.cancelled).toBe(1);
    await expect((await api.fetch(URL, { cacheTtlMs: 100 })).text()).resolves.toBe("ok");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("accepts Uint8Array chunks from another JavaScript realm", async () => {
    const bytes = runInNewContext("new Uint8Array([0, 255, 128, 1])") as Uint8Array;
    const upstream = fixture([bytes]);
    const response = await network(async () => upstream.response).fetch(URL);
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([0, 255, 128, 1]);
  });

  it.each(["fully consumed", "partially consumed", "locked"])("rejects a %s upstream body instead of caching an incomplete result", async (state) => {
    const upstream = fixture([new Uint8Array([65, 66]), new Uint8Array([67, 68])]);
    const reader = upstream.stream.getReader();
    if (state !== "locked") {
      await reader.read();
      if (state === "fully consumed") while (!(await reader.read()).done) { /* consume only this synthetic stream */ }
      reader.releaseLock();
    }
    const fetchImpl = vi.fn<FetchImpl>().mockResolvedValueOnce(upstream.response).mockResolvedValueOnce(new Response("ok"));
    const api = network(fetchImpl);
    try {
      await expect(api.fetch(URL, { cacheTtlMs: 100 })).rejects.toBeInstanceOf(TypeError);
      expect(upstream.stream.locked).toBe(state === "locked");
      for (let index = 0; index < 2; index++) await expect((await api.fetch(URL, { cacheTtlMs: 100 })).text()).resolves.toBe("ok");
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      if (state === "locked") reader.releaseLock();
      await upstream.stream.cancel();
    }
  });
});
