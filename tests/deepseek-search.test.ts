import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createWebSearchTool, MAX_DEEPSEEK_SEARCH_RESULT_BYTES, MAX_DEEPSEEK_SEARCH_TEXT_BYTES, resetWebSearchRateLimiterForTests, verifySearchKey } from "../lib/tools/web-search.ts";
import { MAX_DEEPSEEK_SEARCH_BYTES } from "../lib/tools/deepseek-search.ts";
import { loadLocale, t } from "../lib/i18n.ts";
import { createCompactionGuardExtension } from "../lib/extensions/compaction-guard-ext.ts";
import { SessionManager, convertAgentMessagesToLlm, normalizeContext } from "../lib/pi-sdk/index.ts";
import { convertMessages } from "@earendil-works/pi-ai/api/openai-completions";
import type { AssistantMessage, Model, ToolResultMessage } from "@earendil-works/pi-ai";
import { Readable } from "node:stream";
import { createGunzip, gzipSync } from "node:zlib";
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
  loadLocale("zh");
  resetWebSearchRateLimiterForTests();
  fetchMock.mockReset().mockImplementation(async () => Response.json({ results: [row] }));
  browser.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  loadLocale("zh");
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
      return phase === "request" ? pending() : new Response(new ReadableStream({
        // Deliberately ignores the request signal: the reader must race abort.
        pull() { entered(); },
      }, { highWaterMark: 0 }));
    });
    const pending = search({}, {}, controller.signal);
    await ready; controller.abort();
    expect((await pending).details).toEqual({ error_type: "cancelled" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(browser).not.toHaveBeenCalled();
  });

  it("times out the full response, including its body, after 30 seconds", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }));
    fetchMock.mockResolvedValueOnce(response);
    const pending = search();
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await pending).details).toEqual({ error_type: "timeout" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
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

function streamedResponse(bytes: Uint8Array, headers = {}, chunkSize = 16 * 1024) {
  let delivered = 0;
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (delivered === bytes.length) { controller.close(); return; }
      const next = bytes.subarray(delivered, delivered + chunkSize);
      delivered += next.length;
      controller.enqueue(next);
    },
    cancel,
  }, { highWaterMark: 0 });
  return { response: new Response(body, { headers }), cancel, delivered: () => delivered };
}

function paddedResponse(size: number) {
  const payload = JSON.stringify({ results: [row] });
  return Buffer.from(payload + " ".repeat(size - Buffer.byteLength(payload)));
}

describe("DeepSeek Search response and saved output budgets", () => {
  it.each([-1, 0, 1])("enforces the decoded stream byte limit at delta %s", async delta => {
    const stream = streamedResponse(paddedResponse(MAX_DEEPSEEK_SEARCH_BYTES + delta),
      delta <= 0 ? { "Content-Length": String(MAX_DEEPSEEK_SEARCH_BYTES + delta) } : {});
    fetchMock.mockResolvedValueOnce(stream.response);
    const result = await search();
    if (delta > 0) {
      expect(result.details).toEqual({ error_type: "response_too_large" });
      expect(stream.cancel).toHaveBeenCalledOnce();
    } else {
      expect(result.details).toMatchObject({ results: [{ content: row.summary }] });
    }
    expect(stream.delivered()).toBe(MAX_DEEPSEEK_SEARCH_BYTES + delta);
    expect(stream.response.body?.locked).toBe(false);
  });

  it("rejects a declared oversized response without reading its body", async () => {
    const stream = streamedResponse(paddedResponse(1024), { "Content-Length": String(MAX_DEEPSEEK_SEARCH_BYTES + 1) });
    fetchMock.mockResolvedValueOnce(stream.response);
    expect((await search()).details).toEqual({ error_type: "response_too_large" });
    expect(stream.delivered()).toBe(0);
    expect(stream.cancel).toHaveBeenCalledOnce();
  });

  it("accepts an exact-limit stream with no length header", async () => {
    const stream = streamedResponse(paddedResponse(MAX_DEEPSEEK_SEARCH_BYTES));
    fetchMock.mockResolvedValueOnce(stream.response);
    expect((await search()).details.results[0].url).toBe(row.url);
    expect(stream.delivered()).toBe(MAX_DEEPSEEK_SEARCH_BYTES);
    expect(stream.response.body?.locked).toBe(false);
  });

  it.each([{}, { "Content-Length": "10" }, { "Content-Length": "nonsense" }, { "Content-Length": "Infinity" },
    { "Content-Length": "2e6" }, { "Content-Length": "1048577.5" }, { "Content-Length": "10, 2097152" },
    { "Content-Length": "-1" }, { "Transfer-Encoding": "chunked" }])("bounds missing or untrusted length headers %j", async headers => {
    const stream = streamedResponse(paddedResponse(2 * MAX_DEEPSEEK_SEARCH_BYTES), headers);
    fetchMock.mockResolvedValueOnce(stream.response);
    expect((await search()).details).toEqual({ error_type: "response_too_large" });
    expect(stream.delivered()).toBe(MAX_DEEPSEEK_SEARCH_BYTES + 16 * 1024);
    expect(stream.cancel).toHaveBeenCalledOnce();
    expect(stream.response.body?.locked).toBe(false);
  });

  it("counts decoded bytes even when the compressed Content-Length is small", async () => {
    const compressed = gzipSync(paddedResponse(MAX_DEEPSEEK_SEARCH_BYTES + 1));
    expect(compressed.length).toBeLessThan(MAX_DEEPSEEK_SEARCH_BYTES);
    // Models the decoded body exposed by fetch, with a real local gunzip stream.
    const decoded = Readable.toWeb(Readable.from([compressed]).pipe(createGunzip())) as ReadableStream<Uint8Array>;
    const response = new Response(decoded, { headers: { "Content-Encoding": "gzip", "Content-Length": String(compressed.length) } });
    fetchMock.mockResolvedValueOnce(response);
    expect((await search()).details).toEqual({ error_type: "response_too_large" });
    expect(response.body?.locked).toBe(false);
  });

  it("preserves split UTF-8, BOM and escaped Unicode exactly", async () => {
    const unicode = { ...row, title: "标题😀", summary: "正文𠮷e\u0301👩‍💻", snippet: "摘录🌍", site_name: "来源" };
    for (const text of [JSON.stringify({ results: [unicode] }), "\uFEFF" + JSON.stringify({ results: [unicode] }),
      JSON.stringify({ results: [unicode] }).replace(/[\u007f-\uffff]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)]) {
      const stream = streamedResponse(Buffer.from(text), {}, 1);
      fetchMock.mockResolvedValueOnce(stream.response);
      const result = await search();
      expect(result.details).toMatchObject({ results: [{ title: unicode.title, content: unicode.summary,
        metadata: { snippet: unicode.snippet, site_name: unicode.site_name } }] });
      expect(result.content[0].text).toContain(unicode.summary);
      expect(JSON.stringify(result)).not.toContain("�");
    }
  });

  it.each(["汉", "😀"])("rejects 50 %s records whose complete sources still exceed the display budget", async character => {
    const rows = Array.from({ length: 50 }, (_, i) => ({ ...row, title: `${i} ${character.repeat(100)}`,
      url: `https://example.com/${i}/${"u".repeat(256)}`, summary: character.repeat(800), snippet: character.repeat(200),
      site_name: character.repeat(30), site_icon: `https://example.com/${"i".repeat(128)}` }));
    // Escaped surrogate pairs cost 12 bytes per character on the wire.
    const text = JSON.stringify({ results: rows }).replace(/[\u007f-\uffff]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
    expect(Buffer.byteLength(text)).toBeLessThan(MAX_DEEPSEEK_SEARCH_BYTES);
    fetchMock.mockResolvedValueOnce(new Response(text));
    const result = await search({}, { maxResults: 50 });
    expect(result.details).toEqual({ error_type: "response_too_large" });
    expect(result.content[0].text).toContain("display size limit");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([-1, 0, 1])("budgets the complete serialized tool result at delta %s", async delta => {
    fetchMock.mockResolvedValueOnce(Response.json({ results: [{ ...row, snippet: "" }] }));
    const base = await search();
    const budget = MAX_DEEPSEEK_SEARCH_RESULT_BYTES + delta;
    const snippet = "N".repeat(budget - Buffer.byteLength(JSON.stringify(base)));
    fetchMock.mockResolvedValueOnce(Response.json({ results: [{ ...row, snippet }] }));
    const result = await search();
    if (delta > 0) {
      expect(result.details).toEqual({ error_type: "response_too_large" });
      expect(result.content[0].text).toContain("fewer results");
      expect(JSON.stringify(result)).not.toContain("N".repeat(100));
    } else {
      expect(Buffer.byteLength(JSON.stringify(result))).toBe(budget);
      expect(result.details.results[0].metadata.snippet).toBe(snippet);
      expect(result.content).toEqual(base.content);
    }
  });

  it("counts UTF-8 and JSON escaping in retained metadata without splitting characters", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ results: [{ ...row, snippet: "" }] }));
    const base = await search();
    const room = MAX_DEEPSEEK_SEARCH_RESULT_BYTES - Buffer.byteLength(JSON.stringify(base));
    const snippet = "😀".repeat(Math.floor(room / 4)) + "s".repeat(room % 4);
    for (const [text, accepted] of [[snippet, true], [snippet + "😀", false], ["\u0000".repeat(Math.floor(room / 6) + 1), false]] as const) {
      fetchMock.mockResolvedValueOnce(Response.json({ results: [{ ...row, snippet: text }] }));
      const result = await search();
      if (accepted) expect(result.details.results[0].metadata.snippet).toBe(text);
      else expect(result.details).toEqual({ error_type: "response_too_large" });
    }
  });

  it.each(["summary", "snippet", "title", "url", "site_name", "site_icon", "date"])("budgets a long retained %s without silently discarding fields", async field => {
    fetchMock.mockResolvedValueOnce(Response.json({ results: [{ ...row, [field]: "X".repeat(MAX_DEEPSEEK_SEARCH_RESULT_BYTES) }] }));
    const result = await search();
    expect(result.details).toEqual({ error_type: "response_too_large" });
    expect(JSON.stringify(result)).not.toContain("X".repeat(100));
  });

  it("bounds excess arrays and unused content before parsing, preserving tail validation", async () => {
    for (const payload of [{ results: Array.from({ length: 1024 }, () => ({ ...row, summary: "S".repeat(2048) })) },
      { results: [{ ...row, content: "C".repeat(2 * MAX_DEEPSEEK_SEARCH_BYTES) }] }]) {
      const stream = streamedResponse(Buffer.from(JSON.stringify(payload)));
      fetchMock.mockResolvedValueOnce(stream.response);
      expect((await search({}, { maxResults: 1 })).details).toEqual({ error_type: "response_too_large" });
      expect(stream.delivered()).toBeLessThanOrEqual(MAX_DEEPSEEK_SEARCH_BYTES + 16 * 1024);
      expect(stream.cancel).toHaveBeenCalledOnce();
    }
    fetchMock.mockResolvedValueOnce(Response.json({ results: [row, { ...row, summary: 1 }] }));
    expect((await search({}, { maxResults: 1 })).details).toEqual({ error_type: "invalid_response" });
    fetchMock.mockResolvedValueOnce(Response.json({ results: Array.from({ length: 100 }, () => row) }));
    expect((await search({}, { maxResults: 1 })).details.results).toHaveLength(1);
  });

  it("cancels and releases a reader after an I/O failure without echoing it", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
    const response = new Response(body);
    const reader = body.getReader();
    const cancel = vi.spyOn(reader, "cancel");
    vi.spyOn(body, "getReader").mockReturnValue(reader);
    fetchMock.mockResolvedValueOnce(response);
    const pending = search();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    controller.error(new Error("synthetic-search-key read failure"));
    const result = await pending;
    expect(result.details).toEqual({ error_type: "invalid_response" });
    expect(JSON.stringify(result)).not.toContain("synthetic-search-key");
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it.each([401, 402, 413, 429])("disposes HTTP %s error bodies without reading them", async status => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }, { highWaterMark: 0 }), { status });
    fetchMock.mockResolvedValueOnce(response);
    expect((await search()).details).toHaveProperty("error_type");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("does not apply the DeepSeek output policy to other search providers", async () => {
    const content = "A".repeat(MAX_DEEPSEEK_SEARCH_RESULT_BYTES);
    fetchMock.mockResolvedValueOnce(Response.json({ results: [{ title: "Other provider", url: row.url, content }] }));
    const result = await search({ provider: "anysearch_free", api_keys: {} });
    expect(result.details.results[0].content).toBe(content);
    expect(result.content[0].text).toContain(content);
  });
});

describe("DeepSeek Search source-preserving presentation", () => {
  const marker = "[Shorter excerpt from search provider] ";
  const textFor = (rows: typeof row[]) => t("error.searchResults", { provider: "deepseek" })
    .replaceAll("{results}", () => rows.map((r, i) =>
      `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.summary || r.snippet}`).join("\n\n"));
  const mapped = (rows: typeof row[]) => rows.map((r, i) => ({
    title: r.title, url: r.url, content: r.summary || r.snippet, rank: i + 1, score: r.rerank_score,
    metadata: { snippet: r.snippet, site_name: r.site_name, site_icon: r.site_icon, date: r.date, authority: r.authority },
  }));
  function expectUnchangedByL1(result) {
    let onResult;
    createCompactionGuardExtension()({ on(name, fn) { if (name === "tool_result") onResult = fn; } });
    expect(onResult).toBeTypeOf("function");
    expect(onResult({ toolName: "web_search", content: result.content, details: result.details, isError: false })).toBeUndefined();
  }

  it.each(["en", "zh"])("keeps normal short summary/fallback behavior in %s", async locale => {
    loadLocale(locale);
    const rows = [
      { ...row, summary: "Longer summary", snippet: "短摘" },
      { ...row, summary: "Short", snippet: "A much longer snippet" },
      { ...row, summary: "same", snippet: "same" },
      { ...row, summary: "", snippet: "fallback😀" },
      { ...row, summary: "summary", snippet: "" },
      { ...row, summary: "", snippet: "" },
      { ...row, summary: " \n ", snippet: "unchanged existing behavior" },
    ];
    fetchMock.mockResolvedValueOnce(Response.json({ results: rows }));
    const result = await search();
    expect(result.content[0].text).toBe(textFor(rows));
    expect(result.details.results).toEqual(mapped(rows));
    expectUnchangedByL1(result);
  });

  it.each(["en", "zh"])("preserves literal titles, URLs and Unicode excerpts in %s", async locale => {
    loadLocale(locale);
    const literal = "$& $` $' $$ {results} e\u0301𠮷👩‍💻";
    const rows = [{ ...row, title: literal, url: `https://example.com/路径?q=$&x=$'&r=$\`#😀`,
      summary: literal, snippet: "other" }];
    fetchMock.mockResolvedValueOnce(Response.json({ results: rows }));
    const result = await search();
    expect(result.content[0].text).toBe(textFor(rows));
    expect(result.details.results).toEqual(mapped(rows));
  });

  it.each(["a", "汉", "😀"])("keeps every source at counts 1, 10 and 50 for %s text", async character => {
    for (const count of [1, 10, 50]) {
      const rows = Array.from({ length: count }, (_, i) => ({ ...row, title: `${i} ${character.repeat(8)}`,
        url: `https://example.com/${i}/${"u".repeat(32)}`, summary: character.repeat(800), snippet: character.repeat(100),
        rerank_score: i % 4, authority: i % 6 - 1, site_name: `site-${i}` }));
      fetchMock.mockResolvedValueOnce(Response.json({ results: rows }));
      const result = await search({}, { maxResults: count });
      const text = result.content[0].text;
      expect(result.details).toMatchObject({ provider: "deepseek", source_type: "api", results: mapped(rows) });
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MAX_DEEPSEEK_SEARCH_TEXT_BYTES);
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(MAX_DEEPSEEK_SEARCH_RESULT_BYTES);
      let lastPosition = -1;
      for (const [i, r] of rows.entries()) {
        const source = `${i + 1}. **${r.title}**\n   ${r.url}\n   `;
        const position = text.indexOf(source);
        expect(position).toBeGreaterThan(lastPosition);
        lastPosition = position;
        expect(text.includes(source + r.summary) || text.includes(source + marker + r.snippet)).toBe(true);
      }
      if (Buffer.byteLength(textFor(rows)) > MAX_DEEPSEEK_SEARCH_TEXT_BYTES) expect(text).toContain(marker);
      else expect(text).toBe(textFor(rows));
      expectUnchangedByL1(result);
    }
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(browser).not.toHaveBeenCalled();
  });

  it("uses the largest byte savings first without moving sources or changing details", async () => {
    const rows = [
      { ...row, title: "first", summary: "A".repeat(15000), snippet: "a".repeat(14000) },
      { ...row, title: "second", summary: "B".repeat(15000), snippet: "b".repeat(100) },
      { ...row, title: "third", summary: "C".repeat(5000), snippet: "c".repeat(100) },
    ];
    fetchMock.mockResolvedValueOnce(Response.json({ results: rows }));
    const result = await search();
    expect(result.content[0].text).toBe(textFor([rows[0], { ...rows[1], summary: marker + rows[1].snippet }, rows[2]]));
    expect(result.details.results).toEqual(mapped(rows));
    expectUnchangedByL1(result);
  });

  it("breaks equal savings ties by source order and accounts for Unicode bytes and the marker", async () => {
    const rows = [
      { ...row, title: "first", summary: "😀".repeat(4000), snippet: "汉".repeat(30) },
      { ...row, title: "second", summary: "𠮷".repeat(4000), snippet: "文".repeat(30) },
      { ...row, title: "third", summary: "tail".repeat(500), snippet: "" },
    ];
    fetchMock.mockResolvedValueOnce(Response.json({ results: rows }));
    const result = await search();
    expect(result.content[0].text).toBe(textFor([{ ...rows[0], summary: marker + rows[0].snippet }, rows[1], rows[2]]));
    expect(result.details.results).toEqual(mapped(rows));
  });

  it.each([-1, 0, 1])("enforces the display boundary at delta %s without splitting sources", async delta => {
    const base = { ...row, summary: "", snippet: "" };
    const length = MAX_DEEPSEEK_SEARCH_TEXT_BYTES + delta - Buffer.byteLength(textFor([base]));
    const source = { ...base, summary: "S".repeat(length) };
    fetchMock.mockResolvedValueOnce(Response.json({ results: [source] }));
    const result = await search();
    if (delta > 0) expect(result.details).toEqual({ error_type: "response_too_large" });
    else {
      expect(Buffer.byteLength(result.content[0].text)).toBe(MAX_DEEPSEEK_SEARCH_TEXT_BYTES + delta);
      expect(result.content[0].text).toBe(textFor([source]));
      expectUnchangedByL1(result);
    }
  });

  it.each([-1, 0, 1])("counts the excerpt marker at the compact display boundary, delta %s", async delta => {
    const source = { ...row, summary: "S".repeat(40000), snippet: "" };
    const room = MAX_DEEPSEEK_SEARCH_TEXT_BYTES + delta - Buffer.byteLength(textFor([{ ...source, summary: marker }]));
    source.snippet = "😀".repeat(Math.floor(room / 4)) + "n".repeat(room % 4);
    fetchMock.mockResolvedValueOnce(Response.json({ results: [source] }));
    const result = await search();
    if (delta > 0) expect(result.details).toEqual({ error_type: "response_too_large" });
    else {
      expect(Buffer.byteLength(result.content[0].text)).toBe(MAX_DEEPSEEK_SEARCH_TEXT_BYTES + delta);
      expect(result.content[0].text).toBe(textFor([{ ...source, summary: marker + source.snippet }]));
      expect(result.details.results).toEqual(mapped([source]));
      expectUnchangedByL1(result);
    }
  });

  it.each([
    { name: "empty", snippet: "" }, { name: "blank", snippet: " \n\t " },
    { name: "equal", snippet: "S".repeat(40000) }, { name: "longer", snippet: "N".repeat(41000) },
    { name: "larger with marker", snippet: "n".repeat(39999) },
  ])("rejects a long source with an unusable $name excerpt", async ({ snippet }) => {
    fetchMock.mockResolvedValueOnce(Response.json({ results: [{ ...row, summary: "S".repeat(40000), snippet }] }));
    const result = await search();
    expect(result.details).toEqual({ error_type: "response_too_large" });
    expect(JSON.stringify(result)).not.toContain("S".repeat(100));
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("handles one long summary using its intact excerpt but never cuts a fallback snippet", async () => {
    const source = { ...row, summary: "S".repeat(40000), snippet: "摘录e\u0301👩‍💻𠮷$&".repeat(10) };
    fetchMock.mockResolvedValueOnce(Response.json({ results: [source] }));
    const result = await search();
    expect(result.content[0].text).toBe(textFor([{ ...source, summary: marker + source.snippet }]));
    expect(result.details.results).toEqual(mapped([source]));
    fetchMock.mockResolvedValueOnce(Response.json({ results: [{ ...source, summary: "", snippet: "N".repeat(40000) }] }));
    expect((await search()).details).toEqual({ error_type: "response_too_large" });
  });

  it.each(["title", "url"])("rejects oversized %s even when the excerpt is short", async field => {
    fetchMock.mockResolvedValueOnce(Response.json({ results: [{ ...row, [field]: "X".repeat(33000),
      summary: "S".repeat(40000), snippet: "tiny" }] }));
    const result = await search();
    expect(result.details).toEqual({ error_type: "response_too_large" });
    expect(JSON.stringify(result)).not.toContain("X".repeat(100));
  });

  it("still bounds original details after compacting the model-visible text", async () => {
    const source = { ...row, summary: "S".repeat(280000), snippet: "short", site_name: "N".repeat(280000) };
    fetchMock.mockResolvedValueOnce(Response.json({ results: [source] }));
    const result = await search();
    expect(result.details).toEqual({ error_type: "response_too_large" });
    expect(result.content[0].text).toContain("saved output size limit");
    expect(JSON.stringify(result)).not.toContain("S".repeat(100));
  });

  it.each(["50-sources", "near-saved-limit", "display-error", "saved-error", "read-error"])(
    "preserves the bounded %s result through L1, synthetic Pi JSONL and OpenAI conversion", async scenario => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-presentation-session-"));
    try {
      let rows = [{ ...row }];
      if (scenario === "50-sources") rows = Array.from({ length: 50 }, (_, i) => ({
        ...row, title: `来源${i}😀`, url: `https://example.com/${i}?q=原文#🧪`,
        summary: `summary-${i}:` + "汉".repeat(800), snippet: `snippet-${i}:` + "文".repeat(100),
      }));
      if (scenario === "near-saved-limit") {
        fetchMock.mockResolvedValueOnce(Response.json({ results: [{ ...row, snippet: "" }] }));
        const base = await search({}, { maxResults: 50 });
        rows = [{ ...row, snippet: "D".repeat(MAX_DEEPSEEK_SEARCH_RESULT_BYTES - Buffer.byteLength(JSON.stringify(base))) }];
      }
      if (scenario === "display-error") rows = [{ ...row, title: "T".repeat(40000) }];
      if (scenario === "saved-error") rows = [{ ...row, site_name: "N".repeat(MAX_DEEPSEEK_SEARCH_RESULT_BYTES) }];
      if (scenario === "read-error") rows = [{ ...row, content: "C".repeat(MAX_DEEPSEEK_SEARCH_BYTES) }];
      fetchMock.mockResolvedValueOnce(Response.json({ results: rows }));
      const result = await search({}, { maxResults: 50 });
      const failed = scenario.endsWith("-error");
      if (failed) expect(result.details).toEqual({ error_type: "response_too_large" });
      else expect(result.details.results).toEqual(mapped(rows));
      expectUnchangedByL1(result);
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(MAX_DEEPSEEK_SEARCH_RESULT_BYTES);
      if (scenario === "near-saved-limit") expect(Buffer.byteLength(JSON.stringify(result))).toBe(MAX_DEEPSEEK_SEARCH_RESULT_BYTES);
      const model: Model<"openai-completions"> = { id: "synthetic", name: "Synthetic", provider: "synthetic",
        api: "openai-completions", input: ["text"], baseUrl: "https://example.invalid",
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, reasoning: false, contextWindow: 128000, maxTokens: 4096 };
      const assistant: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: [{ type: "toolCall", id: "synthetic", name: "web_search", arguments: { query: "query" } }],
        stopReason: "toolUse", timestamp: 0,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const message: ToolResultMessage = { role: "toolResult", toolCallId: "synthetic", toolName: "web_search",
        content: [{ type: "text", text: result.content[0].text }], details: result.details, isError: false, timestamp: 0 };
      const sm = SessionManager.create(root, path.join(root, "sessions"));
      sm.appendMessage(assistant);
      sm.appendMessage(message);
      const jsonl = fs.readFileSync(sm.getSessionFile()!, "utf8");
      const saved = jsonl.trim().split("\n").map(line => JSON.parse(line)).find(e => e.message?.role === "toolResult").message;
      expect(saved.details).toEqual(result.details);
      expect(saved.content).toEqual(result.content);
      expect(Buffer.byteLength(jsonl)).toBeLessThan(MAX_DEEPSEEK_SEARCH_RESULT_BYTES + 4096);
      const converted = convertMessages(model, normalizeContext({ messages: convertAgentMessagesToLlm([assistant, message]) }),
        { supportsStore: true, supportsDeveloperRole: true, supportsReasoningEffort: true,
          supportsUsageInStreaming: true, supportsFinishReason: true, maxTokensField: "max_completion_tokens",
          requiresToolResultName: false, requiresAssistantAfterToolResult: false, requiresThinkingAsText: false,
          requiresReasoningContentOnAssistantMessages: false, thinkingFormat: "openai",
          openRouterRouting: {}, vercelGatewayRouting: {}, chatTemplateKwargs: {}, chatTemplateArgs: {},
          zaiToolStream: false, supportsStrictMode: false, supportsOpenAIGrammarTools: false,
          supportsMidConvoSystemMessages: false, supportsMidConvoToolAdditions: false,
          sendSessionAffinityHeaders: false, sessionAffinityFormat: "openai", supportsLongCacheRetention: true });
      const providerText = converted.find(m => m.role === "tool")!.content;
      expect(providerText).toBe(result.content[0].text);
      expect(JSON.stringify(converted)).not.toContain('"details"');
      if (scenario === "50-sources") rows.forEach(r => expect(providerText).toContain(r.url));
      if (scenario === "near-saved-limit") expect(JSON.stringify(converted)).not.toContain("D".repeat(100));
      expect(jsonl).not.toContain("synthetic-search-key");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
