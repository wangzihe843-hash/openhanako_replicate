import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lookup } from "dns/promises";
import { execFileSync } from "node:child_process";
import { createWebFetchTool } from "../lib/tools/web-fetch.ts";
import { fetchDeepSeek, MAX_DEEPSEEK_FETCH_BYTES } from "../lib/tools/deepseek-fetch.ts";
import { createSearchRateLimiter } from "../lib/tools/search-rate-limiter.ts";

vi.mock("dns/promises", () => ({ lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]) }));
const endpoint = "https://api.deepseek.com/v1/tools/fetch";
const source = "https://example.com/article";
const fetchMock = vi.fn<typeof fetch>();
const immediate = { run: (_provider, _type, operation) => operation() };
const resolveApiKey = vi.fn(() => "synthetic-fetch-key");
const run = (params = {}, signal?: AbortSignal) => createWebFetchTool({
  fetchConfigResolver: () => ({ provider: "deepseek", resolveApiKey }), rateLimiter: immediate,
}).execute("fetch", { url: source, ...params }, signal);
const apiCalls = () => fetchMock.mock.calls.filter(([url]) => url === endpoint);
let page: unknown;
let apiResponse: (() => Response) | undefined;

beforeEach(() => {
  page = { title: "Article", content: "# Body\n\nMarkdown content." };
  apiResponse = undefined;
  vi.mocked(lookup).mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as never);
  resolveApiKey.mockReset().mockReturnValue("synthetic-fetch-key");
  fetchMock.mockReset().mockImplementation(async url => url === endpoint
    ? apiResponse?.() || Response.json(page)
    : new Response("<p>Preflight</p>", { headers: { "Content-Type": "text/html" } }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("explicit DeepSeek Fetch protocol and read evidence", () => {
  it("sends only the checked URL and official Bearer POST, with conservative Markdown evidence", async () => {
    const result = await run();
    expect(apiCalls()).toHaveLength(1);
    expect(apiCalls()[0]).toEqual([endpoint, expect.objectContaining({
      method: "POST", body: JSON.stringify({ url: source }), redirect: "error",
      headers: { Authorization: "Bearer synthetic-fetch-key", "Content-Type": "application/json" },
      signal: expect.any(AbortSignal),
    })]);
    expect(fetchMock.mock.calls[0][1]?.headers).not.toHaveProperty("Authorization");
    expect(result.content[0].text).toContain("# Article\n\n# Body");
    expect(result.details.readEvidence).toMatchObject({
      status: "partial", provider: "deepseek", sourceUrl: source, preflightUrl: source,
      preflightHttpStatus: 200, providerHttpStatus: 200,
      missingReasons: ["provider_extraction_unverified", "remote_redirects_unverified"],
    });
    expect(result.details.readEvidence).not.toHaveProperty("resolvedUrl");
    expect(result.details.readEvidence).not.toHaveProperty("httpStatus");
    expect(result.details.readEvidence).not.toHaveProperty("responseTextHash");
    expect(result.content[0].text).not.toContain("synthetic-fetch-key");
  });

  it("allows an empty title and bounds the title plus body even if maxLength is huge", async () => {
    page = { title: "", content: "x".repeat(20_000) };
    const result = await run({ maxLength: 100_000 });
    expect(result.details.readEvidence).toMatchObject({ returnedCharacters: 12_000, extractedCharacters: 20_000 });
    expect(result.details.readEvidence.missingReasons).toContain("output_truncated");
    page = { title: "y".repeat(20_000), content: "body" };
    expect((await run({ maxLength: 4 })).details.readEvidence.returnedCharacters).toBe(4);
  });

  it.each([null, [], {}, { title: null, content: "text" }, { title: "", content: 1 }])("rejects malformed schema %#", async value => {
    page = value;
    expect((await run()).details.readEvidence.missingReasons).toEqual(["invalid_response"]);
  });
  it.each(["", " \n "])("fails on empty Markdown %#", async content => {
    page = { title: "Just a title", content };
    expect(await run()).toMatchObject({ isError: true, details: { readEvidence: { status: "failed", missingReasons: ["empty_body"] } } });
  });
  it.each([
    [401, "auth"], [402, "balance"], [403, "safety"], [404, "no_content"], [408, "http_error"],
    [429, "rate_limit"], [500, "http_error"], [503, "http_error"], [504, "http_error"], [206, "http_error"], [302, "http_error"],
  ])("sanitizes HTTP %i without retries or provider fallback", async (status, reason) => {
    apiResponse = () => new Response("private-upstream-body synthetic-fetch-key", { status: Number(status), headers: { Location: "https://proxy.example", "Retry-After": "3" } });
    const result = await run();
    expect(result.isError).toBe(true);
    expect(result.details.readEvidence.missingReasons).toEqual([reason]);
    expect(JSON.stringify(result)).not.toContain("private-upstream-body");
    expect(JSON.stringify(result)).not.toContain("synthetic-fetch-key");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it.each([
    () => new Response("{secret-invalid-json", { headers: { "Content-Type": "application/json" } }),
    () => new Response("secret-html", { headers: { "Content-Type": "text/html" } }),
  ])("rejects invalid JSON/response type %#", async response => {
    apiResponse = response;
    const result = await run();
    expect(result.details.readEvidence.missingReasons).toEqual(["invalid_response"]);
    expect(JSON.stringify(result)).not.toContain("secret-");
  });
  it("sanitizes network and resolver failures", async () => {
    fetchMock.mockImplementation(async url => {
      if (url === endpoint) throw new Error("private-key-and-path");
      return new Response("ok", { headers: { "Content-Type": "text/plain" } });
    });
    expect(JSON.stringify(await run())).not.toContain("private-key-and-path");
    resolveApiKey.mockImplementation(() => { throw new Error("private-key-and-path"); });
    expect(JSON.stringify(await run())).not.toContain("private-key-and-path");
    expect(apiCalls()).toHaveLength(1);
  });
  it("rejects announced oversized bodies without reading", async () => {
    apiResponse = () => new Response("x", { headers: { "Content-Type": "application/json", "Content-Length": String(MAX_DEEPSEEK_FETCH_BYTES + 1) } });
    expect((await run()).details.readEvidence.missingReasons).toEqual(["response_too_large"]);
  });
  it("bounds streaming responses even without Content-Length and cancels the reader", async () => {
    let cancelled = false;
    apiResponse = () => new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(128 * 1024)); },
      cancel() { cancelled = true; },
    }), { headers: { "Content-Type": "application/json" } });
    expect((await run()).details.readEvidence.missingReasons).toEqual(["response_too_large"]);
    expect(cancelled).toBe(true);
  });
});

describe("URL disclosure and redirect boundaries", () => {
  it.each([
    "file:///etc/passwd", "http://localhost/", "http://local/", "http://machine.internal/", "http://example.local/",
    "http://127.1/", "http://2130706433/", "http://0x7f000001/", "http://10.1.2.3/", "http://172.31.1.1/",
    "http://192.168.1.1/", "http://169.254.169.254/", "http://100.64.1.1/", "http://[::1]/", "http://[::]/",
    "http://[::127.0.0.1]/", "http://[fec0::1]/", "http://[::ffff:127.0.0.1]/", "http://[fc12::1]/", "http://[fe90::1]/", "http://[2002:7f00:1::]/",
    "https://user:password@example.com/", "https://example.com/?token=secret", "https://example.com/?q=public",
    "https://example.com/#token", "https://example.com/?", "https://example.com/#", "not a url",
    `https://example.com/${"x".repeat(8192)}`,
  ])("never sends unsafe/sensitive URL %s", async url => {
    const result = await run({ url });
    expect(result.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(resolveApiKey).not.toHaveBeenCalled();
  });
  it("refuses mixed public/private DNS, unresolved and empty answers", async () => {
    for (const addresses of [[], [{ address: "93.184.216.34", family: 4 }, { address: "10.1.1.1", family: 4 }]]) {
      vi.mocked(lookup).mockResolvedValue(addresses as never);
      expect((await run()).details.readEvidence.missingReasons).toEqual(["private_or_unresolved_host"]);
    }
    vi.mocked(lookup).mockRejectedValue(new Error("private resolver details"));
    expect((await run()).isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each(["http://127.0.0.1/", "file:///private", "https://example.com/?token=secret", "https://user:password@example.com/"])("blocks unsafe redirect %s before delegation", async location => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: location } }));
    expect((await run()).isError).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(apiCalls()).toHaveLength(0);
  });
  it("delegates only the final checked public redirect URL", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 303, headers: { Location: "/final" } }));
    const result = await run();
    expect(apiCalls()[0][1]?.body).toBe(JSON.stringify({ url: "https://example.com/final" }));
    expect(result.details.readEvidence.preflightUrl).toBe("https://example.com/final");
  });
  it("retains the redirect count and missing-location checks", async () => {
    fetchMock.mockImplementation(async () => new Response(null, { status: 302, headers: { Location: "/again" } }));
    expect((await run()).details.readEvidence.missingReasons).toEqual(["redirect_limit"]);
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(apiCalls()).toHaveLength(0);
    fetchMock.mockReset().mockResolvedValue(new Response(null, { status: 302 }));
    expect((await run()).details.readEvidence.missingReasons).toEqual(["redirect_without_location"]);
  });
  it("never delegates when direct preflight fails or its MIME is unsupported", async () => {
    for (const response of [new Response("forbidden", { status: 403 }), new Response("pdf", { headers: { "Content-Type": "application/pdf" } })]) {
      fetchMock.mockResolvedValueOnce(response);
      expect((await run()).isError).toBe(true);
    }
    expect(apiCalls()).toHaveLength(0);
  });
  it("checks DNS again after the queue before resolving credentials", async () => {
    vi.mocked(lookup).mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }] as never)
      .mockResolvedValueOnce([{ address: "10.0.0.1", family: 4 }] as never);
    expect((await run()).details.readEvidence.missingReasons).toEqual(["private_or_unresolved_host"]);
    expect(resolveApiKey).not.toHaveBeenCalled();
    expect(apiCalls()).toHaveLength(0);
  });
});

describe("cancellation, total deadline, and independent quota", () => {
  it("does not leave an unhandled native rejection when transport aborts synchronously", () => {
    const moduleUrl = new URL("../lib/tools/web-fetch-url.ts", import.meta.url).href;
    const output = execFileSync(process.execPath, ["--input-type=module", "--eval", `
      import { withFetchAbort } from ${JSON.stringify(moduleUrl)};
      const seen = [];
      process.on('unhandledRejection', error => seen.push(error.message));
      await withFetchAbort(Promise.reject(new Error('synthetic-rejection')), AbortSignal.abort()).catch(() => {});
      await new Promise(resolve => setImmediate(resolve));
      console.log(JSON.stringify(seen));
    `], { encoding: "utf8" });
    expect(JSON.parse(output.trim())).toEqual([]);
  });
  it("does not dispatch an already cancelled call", async () => {
    expect((await run({}, AbortSignal.abort())).details.readEvidence.missingReasons).toEqual(["cancelled"]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each(["dns", "preflight", "send", "body"])("cancels during %s without waiting for a cooperative transport", async phase => {
    const controller = new AbortController();
    if (phase === "dns") vi.mocked(lookup).mockImplementation(() => { controller.abort(); return new Promise(() => {}); });
    else fetchMock.mockImplementation(async url => {
      if ((phase === "preflight" && url !== endpoint) || (phase === "send" && url === endpoint)) {
        controller.abort(); return new Promise(() => {});
      }
      if (phase === "body" && url === endpoint) return new Response(new ReadableStream({ pull() { controller.abort(); } }), { headers: { "Content-Type": "application/json" } });
      return new Response("ok", { headers: { "Content-Type": "text/plain" } });
    });
    const result = await run({}, controller.signal);
    expect(result.details.readEvidence.missingReasons).toEqual(["cancelled"]);
  });
  it("enforces the existing 15s deadline across response body reading", async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("timeout", "TimeoutError")), ms);
      return controller.signal;
    });
    apiResponse = () => new Response(new ReadableStream({ start() {} }), { headers: { "Content-Type": "application/json" } });
    const pending = run();
    await vi.advanceTimersByTimeAsync(15_000);
    expect((await pending).details.readEvidence.missingReasons).toEqual(["timeout"]);
  });
  it("removes queued cancelled work without sending or resolving a key", async () => {
    vi.useFakeTimers();
    const limiter = createSearchRateLimiter();
    await fetchDeepSeek(source, resolveApiKey, new AbortController().signal, limiter);
    const controller = new AbortController();
    const pending = fetchDeepSeek(source, resolveApiKey, controller.signal, limiter);
    const assertion = expect(pending).rejects.toMatchObject({ code: "cancelled" });
    controller.abort(); await assertion; await vi.advanceTimersByTimeAsync(500);
    expect(apiCalls()).toHaveLength(1); expect(resolveApiKey).toHaveBeenCalledTimes(1);
    limiter.reset();
  });
  it("spaces Fetch across keys while Search has an independent lane", async () => {
    vi.useFakeTimers();
    const limiter = createSearchRateLimiter();
    const times: number[] = [];
    const start = Date.now();
    const promises = [0, 1, 2].map(() => limiter.run("deepseek_fetch", "api", () => { times.push(Date.now() - start); }));
    let searched = false;
    await limiter.run("deepseek", "api", () => { searched = true; });
    expect(searched).toBe(true); expect(times).toEqual([0]);
    await vi.advanceTimersByTimeAsync(400); await Promise.all(promises);
    expect(times).toEqual([0, 200, 400]); limiter.reset();
  });
  it("honors 429 Retry-After without retrying, and does not treat 402 as throttling", async () => {
    vi.useFakeTimers();
    const limiter = createSearchRateLimiter({ random: () => 0 });
    apiResponse = () => new Response("private", { status: 429, headers: { "Retry-After": "2" } });
    await expect(fetchDeepSeek(source, resolveApiKey, new AbortController().signal, limiter)).rejects.toMatchObject({ status: 429, retryAfterMs: 2000 });
    apiResponse = undefined;
    const next = fetchDeepSeek(source, resolveApiKey, new AbortController().signal, limiter);
    await vi.advanceTimersByTimeAsync(1999); expect(apiCalls()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1); await next; expect(apiCalls()).toHaveLength(2);
    limiter.reset();
    apiResponse = () => new Response(null, { status: 402 });
    await expect(fetchDeepSeek(source, resolveApiKey, new AbortController().signal, limiter)).rejects.toMatchObject({ code: "balance" });
    apiResponse = undefined;
    const afterBalance = fetchDeepSeek(source, resolveApiKey, new AbortController().signal, limiter);
    await vi.advanceTimersByTimeAsync(200); await afterBalance;
    expect(apiCalls()).toHaveLength(4); limiter.reset();
  });
});
