import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginContext } from "../core/plugin-context.ts";

const URL = "https://api.example.com/body";
type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

function network(fetchImpl: FetchImpl, maxResponseBytes = 1024) {
  return createPluginContext({
    pluginId: "body-fixture",
    pluginDir: "/synthetic/plugins/body-fixture",
    dataDir: "/synthetic/plugin-data/body-fixture",
    bus: {},
    capabilities: ["network.fetch"],
    network: { allowedHosts: ["api.example.com"], methods: ["GET", "HEAD"], maxResponseBytes },
    fetchImpl,
  } as Parameters<typeof createPluginContext>[0]).network;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("plugin network response snapshots", () => {
  const cases = [
    { name: "204", status: 204, body: null },
    { name: "205", status: 205, body: null },
    { name: "304", status: 304, body: null },
    { name: "200 null", status: 200, body: null },
    { name: "200 empty stream", status: 200, body: "" },
    { name: "200 nonempty stream", status: 200, body: "hello 世界" },
  ];

  for (const cacheTtlMs of [0, 60_000]) {
    it.each(cases)(`preserves $name with cache TTL ${cacheTtlMs}`, async ({ status, body }) => {
      const responses: Response[] = [];
      const reads: ReturnType<typeof vi.spyOn>[] = [];
      const fetchImpl = vi.fn(async () => {
        const response = new Response(body, {
          status,
          statusText: "Synthetic status",
          headers: { "x-snapshot": "original", "content-type": "text/plain; charset=utf-8" },
        });
        responses.push(response);
        reads.push(vi.spyOn(response, "arrayBuffer"));
        return response;
      });
      const api = network(fetchImpl);
      const first = await api.fetch(URL, { cacheTtlMs });
      expect(first.body === null).toBe(body === null);
      expect(first.bodyUsed).toBe(false);
      expect(first.status).toBe(status);
      expect(first.statusText).toBe("Synthetic status");
      expect([...first.headers]).toEqual([...responses[0].headers]);
      expect(first.clone().body === null).toBe(body === null);
      await expect(first.text()).resolves.toBe(body ?? "");
      expect(first.bodyUsed).toBe(body !== null);
      first.headers.set("x-snapshot", "changed by caller");

      const second = await api.fetch(URL, { cacheTtlMs });
      expect(second).not.toBe(first);
      expect(second.body === null).toBe(body === null);
      expect(second.status).toBe(status);
      expect(second.statusText).toBe("Synthetic status");
      expect(second.headers.get("x-snapshot")).toBe("original");
      expect(second.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      await expect(second.text()).resolves.toBe(body ?? "");
      expect(second.bodyUsed).toBe(body !== null);
      // Only successful GET responses are cached; 304 must still reach fetch.
      expect(fetchImpl).toHaveBeenCalledTimes(cacheTtlMs > 0 && status !== 304 ? 1 : 2);
      for (const read of reads) expect(read).toHaveBeenCalledTimes(body === null ? 0 : 1);
    });
  }

  it.each(["init", "request", "override"])("preserves HEAD from %s without using or populating the GET cache", async (source) => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => new Response(init.method === "HEAD" ? null : "GET body", {
      headers: { "content-length": "8", "x-method": String(init.method) },
    }));
    const api = network(fetchImpl);
    const get = await api.fetch(URL, { cacheTtlMs: 60_000 });
    await expect(get.text()).resolves.toBe("GET body");
    const input = source === "init" ? URL : new Request(URL, {
      method: source === "request" ? "HEAD" : "GET",
      headers: { "x-request": "synthetic" },
    });
    const init = { cacheTtlMs: 60_000, ...(source === "request" ? {} : { method: "head" }) };
    for (let index = 0; index < 2; index++) {
      const head = await api.fetch(input, init);
      expect(head.body).toBeNull();
      expect(head.status).toBe(200);
      expect(head.headers.get("content-length")).toBe("8");
      expect(head.headers.get("x-method")).toBe("HEAD");
      await expect(head.text()).resolves.toBe("");
      expect(head.bodyUsed).toBe(false);
      expect(fetchImpl.mock.calls[index + 1][1].method).toBe("HEAD");
      if (source !== "init") expect(new Headers(fetchImpl.mock.calls[index + 1][1].headers).get("x-request")).toBe("synthetic");
    }
    await expect((await api.fetch(URL, { cacheTtlMs: 60_000 })).text()).resolves.toBe("GET body");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("allows init GET to override a HEAD Request and cache its non-null response", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => new Response(String(init.method)));
    const api = network(fetchImpl);
    const request = new Request(URL, { method: "HEAD" });
    await expect((await api.fetch(request, { method: "GET", cacheTtlMs: 60_000 })).text()).resolves.toBe("GET");
    await expect((await api.fetch(URL, { cacheTtlMs: 60_000 })).text()).resolves.toBe("GET");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("expires a null snapshot and replaces it with an empty non-null body", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<FetchImpl>()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response("", { status: 200 }));
    const api = network(fetchImpl);
    expect((await api.fetch(URL, { cacheTtlMs: 100 })).body).toBeNull();
    expect((await api.fetch(URL, { cacheTtlMs: 100 })).body).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(100);
    const empty = await api.fetch(URL, { cacheTtlMs: 100 });
    expect(empty.status).toBe(200);
    expect(empty.body).not.toBeNull();
    await expect(empty.text()).resolves.toBe("");
    const cached = await api.fetch(URL, { cacheTtlMs: 100 });
    expect(cached.body).not.toBeNull();
    await expect(cached.text()).resolves.toBe("");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["fetch", "read", "size"])("propagates %s failures without caching them, and cleans up the timeout and input signal", async (failure) => {
    vi.useFakeTimers();
    const error = new Error(`synthetic ${failure} failure`);
    const response = new Response("four");
    if (failure === "read") vi.spyOn(response, "arrayBuffer").mockRejectedValue(error);
    const fetchImpl = vi.fn<FetchImpl>();
    if (failure === "fetch") fetchImpl.mockRejectedValueOnce(error);
    else fetchImpl.mockResolvedValueOnce(response);
    fetchImpl.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const api = network(fetchImpl, failure === "size" ? 3 : 1024);
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    const request = api.fetch(URL, { signal: controller.signal, cacheTtlMs: 60_000 });
    if (failure === "size") await expect(request).rejects.toMatchObject({
      code: "PLUGIN_NETWORK_RESPONSE_TOO_LARGE", maxResponseBytes: 3, responseBytes: 4,
    });
    else await expect(request).rejects.toBe(error);
    expect(vi.getTimerCount()).toBe(0);
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
    expect((await api.fetch(URL, { cacheTtlMs: 60_000 })).body).toBeNull();
    expect((await api.fetch(URL, { cacheTtlMs: 60_000 })).body).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("propagates timeout aborts and permits an uncached retry", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<FetchImpl>()
      .mockImplementationOnce(async (_url, init) => new Promise((_resolve, reject) => {
        init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
      }))
      .mockResolvedValueOnce(new Response(null, { status: 205 }));
    const api = network(fetchImpl);
    const rejected = expect(api.fetch(URL, { timeoutMs: 25, cacheTtlMs: 60_000 })).rejects.toThrow("timed out after 25ms");
    await vi.advanceTimersByTimeAsync(25);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
    expect((await api.fetch(URL, { cacheTtlMs: 60_000 })).body).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("forwards an already-aborted signal and its reason without caching the failure", async () => {
    vi.useFakeTimers();
    const reason = new Error("synthetic caller abort");
    const controller = new AbortController();
    controller.abort(reason);
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      if (init.signal?.aborted) throw init.signal.reason;
      return new Response(null, { status: 204 });
    });
    const api = network(fetchImpl);
    await expect(api.fetch(URL, { signal: controller.signal, cacheTtlMs: 60_000 })).rejects.toBe(reason);
    expect(vi.getTimerCount()).toBe(0);
    expect((await api.fetch(URL, { cacheTtlMs: 60_000 })).body).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
