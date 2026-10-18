import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createWebSearchTool, resetWebSearchRateLimiterForTests, verifySearchKey } from "../lib/tools/web-search.ts";
import { createSearchRateLimiter, type SearchRateLimiter } from "../lib/tools/search-rate-limiter.ts";

const browser = vi.hoisted(() => vi.fn());
vi.mock("../lib/browser/browser-manager.ts", () => ({ BrowserManager: { instance: () => ({ searchWeb: browser }) } }));

const row = {
  title: "Search result", url: "https://example.com/page", snippet: "Short snippet",
  summary: "Long summary for the model", content: "", rerank_score: 2.4,
  site_name: "Example", site_icon: null, date: "2026-10-17T00:00:00Z", authority: 3,
};
const immediate = { run: (_provider, _source, operation) => operation() };
const fetchMock = vi.fn();
function tool(config = {}, rateLimiter: Pick<SearchRateLimiter, "run"> = immediate) {
  return createWebSearchTool({
    searchConfigResolver: () => ({ provider: "deepseek", api_keys: { deepseek: "synthetic-search-key" }, ...config }),
    rateLimiter,
  });
}
const search = (config = {}, params = {}, signal?: AbortSignal) => tool(config).execute("call", { query: "query", ...params }, signal);

beforeEach(() => {
  resetWebSearchRateLimiterForTests();
  fetchMock.mockReset().mockImplementation(async () => Response.json({ results: [row] }));
  browser.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  resetWebSearchRateLimiterForTests();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("DeepSeek Search API contract", () => {
  it("uses standalone POST with default count, no model, and maps official result fields", async () => {
    const result = await search();
    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.deepseek.com/v1/tools/search");
    expect(request).toMatchObject({ method: "POST", redirect: "error", headers: {
      Authorization: "Bearer synthetic-search-key", "Content-Type": "application/json",
    } });
    expect(JSON.parse(request.body)).toEqual({ query: "query", count: 10, need_content: false });
    expect(result.details).toMatchObject({ provider: "deepseek", source_type: "api", results: [{
      title: row.title, url: row.url, content: row.summary, rank: 1, score: 2.4,
      metadata: { snippet: row.snippet, site_name: "Example", site_icon: null, date: row.date, authority: 3 },
    }] });
    expect(JSON.stringify(result)).not.toContain("synthetic-search-key");
    expect(browser).not.toHaveBeenCalled();
  });

  it.each([[undefined, 10], [1, 1], [50, 50], [100, 50], [0, 1], [-4, 1], [2.9, 2], [NaN, 10], [Infinity, 10]])("clamps maxResults %s to %s", async (maxResults, count) => {
    await search({}, { maxResults });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).count).toBe(count);
  });

  it.each(["汉".repeat(128), "😀".repeat(128), 'site:example.com "exact words" -ad'])("accepts Unicode/syntax query without rewriting: %s", async query => {
    const result = await search({}, { query });
    expect(result.details).toHaveProperty("provider", "deepseek");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).query).toBe(query);
  });

  it.each(["汉".repeat(129), "😀".repeat(129)])("rejects too-long queries before requesting", async query => {
    expect((await search({}, { query })).details).toEqual({ error_type: "invalid_query" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects empty queries and treats an empty results array as success, without fallback", async () => {
    await search({}, { query: " \n\t " });
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(Response.json({ results: [] }));
    expect((await search()).details).toMatchObject({ provider: "deepseek", results: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(browser).not.toHaveBeenCalled();
  });

  it("falls back to snippet when summary is empty, retaining nullable metadata", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ results: [{ ...row, summary: "", site_name: null, date: null, authority: -1 }] }));
    expect((await search()).details).toMatchObject({ results: [{ content: row.snippet, metadata: { date: null, authority: -1 } }] });
  });

  it.each([null, {}, { results: null }, { results: {} }, { results: [null] },
    { results: [{ ...row, summary: 5 }] }, { results: [{ ...row, authority: "3" }] },
    { results: [{ ...row, rerank_score: 4 }] }, { results: [{ ...row, site_name: {} }] },
    { results: [{ title: "partial", url: "https://example.com" }] },
  ])("rejects malformed result schema without fallback: %j", async payload => {
    fetchMock.mockResolvedValueOnce(Response.json(payload));
    expect((await search()).details).toEqual({ error_type: "invalid_response" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(browser).not.toHaveBeenCalled();
  });

  it("does not echo invalid JSON or transport errors", async () => {
    fetchMock.mockResolvedValueOnce(new Response("synthetic-search-key malformed"));
    const malformed = await search();
    fetchMock.mockRejectedValueOnce(new Error("synthetic-search-key transport"));
    const network = await search();
    expect(malformed.details).toEqual({ error_type: "invalid_response" });
    expect(network.details).toEqual({ error_type: "network" });
    expect(JSON.stringify([malformed, network])).not.toContain("synthetic-search-key");
  });

  it.each([[400, "http_error"], [401, "auth"], [402, "balance"], [403, "auth"], [408, "http_error"],
    [429, "rate_limited"], [500, "http_error"], [504, "http_error"], [302, "http_error"],
  ])("handles HTTP %s without body echo, retry or fallback", async (status, errorType) => {
    fetchMock.mockResolvedValueOnce(new Response("synthetic-search-key", { status: Number(status), headers: { "Retry-After": "2" } }));
    const result = await search();
    expect(result.details).toMatchObject({ error_type: errorType });
    expect(JSON.stringify(result)).not.toContain("synthetic-search-key");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(browser).not.toHaveBeenCalled();
  });

  it("prefers standalone override without invoking the model resolver", async () => {
    const resolveDeepSeekApiKey = vi.fn(() => "synthetic-model-key");
    await search({ credential_provider: "account-a", resolveDeepSeekApiKey });
    expect(resolveDeepSeekApiKey).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer synthetic-search-key");
  });

  it("never sends a saved mask sentinel as a literal standalone key", async () => {
    const result = await search({ api_keys: { deepseek: "********" } });
    expect(result.details).toEqual({ error_type: "key_missing" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not start fallback work after an Auto search is cancelled", async () => {
    const controller = new AbortController();
    fetchMock.mockImplementationOnce(async () => { controller.abort(); return Response.json({ results: [] }); });
    const result = await search({ provider: "auto", api_keys: {} }, {}, controller.signal);
    expect(result.details).toEqual({ error_type: "cancelled" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(browser).not.toHaveBeenCalled();
  });

  it("does not resurrect an old per-agent key or reference after global override clearing", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-stale-config-"));
    try {
      const configPath = path.join(root, "config.yaml");
      fs.writeFileSync(configPath, 'search:\n  provider: deepseek\n  api_key: old-agent-key\n  credential_provider: old-account\n');
      const resolver = vi.fn(() => "current-model-key");
      const instance = createWebSearchTool({ configPath, rateLimiter: immediate,
        searchConfigResolver: () => ({ provider: "deepseek", api_keys: {}, resolveDeepSeekApiKey: resolver }),
      });
      await instance.execute("call", { query: "query" });
      expect(resolver).toHaveBeenCalledWith("");
      expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer current-model-key");
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("never adds DeepSeek to Auto, even with standalone keys and a model reference", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ results: [{ title: "Free", url: "https://example.com", content: "Free result" }] }));
    const resolver = vi.fn();
    const result = await search({ provider: "auto", credential_provider: "account-a", resolveDeepSeekApiKey: resolver });
    expect(result.details).toHaveProperty("provider", "anysearch_free");
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.anysearch.com/v1/search");
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();
    expect(resolver).not.toHaveBeenCalled();
  });
});

describe("DeepSeek cancellation and pacing", () => {
  it("prevents pre-cancelled requests and resolves no credential", async () => {
    const controller = new AbortController(); controller.abort("private reason");
    const resolver = vi.fn();
    const result = await search({ api_keys: {}, resolveDeepSeekApiKey: resolver }, {}, controller.signal);
    expect(result.details).toEqual({ error_type: "cancelled" });
    expect(resolver).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("private reason");
  });

  it.each(["request", "body"])("cancels an in-flight %s without retry or fallback", async phase => {
    const controller = new AbortController();
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    fetchMock.mockImplementationOnce((_url, request) => {
      const pending = () => new Promise((_resolve, reject) => {
        request.signal.addEventListener("abort", () => reject(new Error("private abort details")), { once: true });
        entered();
      });
      return phase === "request" ? pending() : { ok: true, status: 200, json: pending };
    });
    const pending = search({}, {}, controller.signal);
    await ready; controller.abort();
    expect((await pending).details).toEqual({ error_type: "cancelled" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(browser).not.toHaveBeenCalled();
  });

  it("times out the full response, including its body, after 30 seconds", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementationOnce((_url, request) => ({ ok: true, status: 200,
      json: () => new Promise((_resolve, reject) => request.signal.addEventListener("abort", () => reject(new Error("private timeout")))),
    }));
    const pending = search();
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await pending).details).toEqual({ error_type: "timeout" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("paces all DeepSeek tools and verification in one process-wide lane", async () => {
    vi.useFakeTimers({ now: 0 });
    const starts: number[] = [];
    fetchMock.mockImplementation(async () => { starts.push(Date.now()); return Response.json({ results: [] }); });
    const first = verifySearchKey("deepseek", "synthetic-verify-key");
    const calls = Array.from({ length: 5 }, (_, i) => createWebSearchTool({
      searchConfigResolver: () => ({ provider: "deepseek", api_keys: { deepseek: `synthetic-account-${i}` } }),
    })
      .execute("call", { query: "query" }));
    await vi.runAllTimersAsync();
    await Promise.all([first, ...calls]);
    expect(starts).toEqual([0, 200, 400, 600, 800, 1000]);
  });

  it("enforces 5 QPS, removes cancelled queued work, and resolves keys after waiting", async () => {
    vi.useFakeTimers({ now: 0 });
    const limiter = createSearchRateLimiter({ random: () => 0 });
    const starts: number[] = [];
    fetchMock.mockImplementation(async () => { starts.push(Date.now()); return Response.json({ results: [] }); });
    let key = "old-key";
    const resolver = vi.fn(() => key);
    const instance = tool({ api_keys: {}, resolveDeepSeekApiKey: resolver, credential_provider: "account-a" }, limiter);
    const first = instance.execute("first", { query: "query" });
    await vi.advanceTimersByTimeAsync(0);
    const controller = new AbortController();
    const cancelled = instance.execute("cancelled", { query: "query" }, controller.signal);
    const calls = Array.from({ length: 5 }, () => instance.execute("next", { query: "query" }));
    controller.abort(); key = "rotated-key";
    expect((await cancelled).details).toEqual({ error_type: "cancelled" });
    await vi.advanceTimersByTimeAsync(999);
    expect(starts).toEqual([0, 200, 400, 600, 800]);
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all([first, ...calls]);
    expect(starts).toEqual([0, 200, 400, 600, 800, 1000]);
    expect(resolver).toHaveBeenCalledTimes(6);
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe("Bearer rotated-key");
  });

  it("honors Retry-After on 429 without retrying; 402 does not start a cooldown", async () => {
    vi.useFakeTimers({ now: 0 });
    const limiter = createSearchRateLimiter({ random: () => 0 });
    const instance = tool({}, limiter);
    fetchMock.mockResolvedValueOnce(new Response("", { status: 429, headers: { "Retry-After": "2" } }));
    const first = instance.execute("first", { query: "query" });
    await vi.advanceTimersByTimeAsync(0);
    expect((await first).details).toMatchObject({ error_type: "rate_limited", retry_after_ms: 2000 });
    fetchMock.mockResolvedValueOnce(new Response("", { status: 402 }));
    const second = instance.execute("second", { query: "query" });
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await second).details).toEqual({ error_type: "balance" });
    const third = instance.execute("third", { query: "query" });
    await vi.advanceTimersByTimeAsync(200);
    await third;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
