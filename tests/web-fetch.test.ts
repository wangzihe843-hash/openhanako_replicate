import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWebFetchTool } from "../lib/tools/web-fetch.ts";
import { htmlToMarkdownDocument } from "../lib/tools/web-reader.ts";

vi.mock("dns/promises", () => ({ lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]) }));
vi.mock("../lib/tools/web-reader.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/tools/web-reader.ts")>(),
  htmlToMarkdownDocument: vi.fn((await importOriginal<typeof import("../lib/tools/web-reader.ts")>()).htmlToMarkdownDocument),
}));

const fetchMock = vi.fn<typeof fetch>();
const run = (params: { url?: string; maxLength?: number } = {}, signal?: AbortSignal) =>
  createWebFetchTool().execute("read-1", { url: "https://example.com/article", ...params }, signal);
const hash = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;

beforeEach(() => { vi.stubGlobal("fetch", fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("web_fetch read evidence", () => {
  it("proves a complete single text response in both model output and details", async () => {
    fetchMock.mockResolvedValueOnce(new Response("full body", { headers: { "Content-Type": "text/plain" } }));
    const result = await run();
    expect(result.isError).toBeUndefined();
    expect(result.details.readEvidence).toMatchObject({
      status: "complete", scope: "single_response_text", sourceUrl: "https://example.com/article",
      resolvedUrl: "https://example.com/article", processorVersion: "web-fetch/1", httpStatus: 200,
      responseTextHash: hash("full body"), outputTextHash: hash("full body"),
      extractedCharacters: 9, returnedCharacters: 9, missingReasons: [],
    });
    expect(result.content[0].text).toContain('"status":"complete"');
  });

  it("distinguishes formatted JSON output from decoded response hash", async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"ok":true}', { headers: { "Content-Type": "application/problem+json" } }));
    const { readEvidence } = (await run()).details;
    expect(readEvidence.status).toBe("complete");
    expect(readEvidence.responseTextHash).toBe(hash('{"ok":true}'));
    expect(readEvidence.outputTextHash).toBe(hash('{\n  "ok": true\n}'));
  });

  it("does not turn invalid JSON into a complete parse", async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"broken":', { headers: { "Content-Type": "application/json" } }));
    expect((await run()).details.readEvidence).toMatchObject({ status: "partial", missingReasons: ["invalid_json"] });
  });

  it("retains the response hash and separately hashes a truncated output", async () => {
    fetchMock.mockResolvedValueOnce(new Response("abcdefghij", { headers: { "Content-Type": "text/plain" } }));
    const result = await run({ maxLength: 4 });
    expect(result.details.readEvidence).toMatchObject({
      status: "partial", responseTextHash: hash("abcdefghij"), outputTextHash: hash("abcd"),
      extractedCharacters: 10, returnedCharacters: 4, missingReasons: ["output_truncated"],
    });
    expect(result.content[0].text).not.toContain("abcdefghij");
  });

  it("keeps HTML coverage conservative and records unread media and login/script limitations", async () => {
    fetchMock.mockResolvedValueOnce(new Response('<article><h1>Summary</h1><p>Preview only.</p><img src="figure.png"><form><input type="password"></form><script>loadArticle()</script></article>', { headers: { "Content-Type": "text/html" } }));
    expect((await run()).details.readEvidence).toMatchObject({
      status: "partial", mediaReferences: 1,
      missingReasons: ["html_coverage_unverified", "media_not_read", "login_form_detected", "script_content_not_executed"],
    });
  });

  it.each(["", "<html><head><title>Article</title></head><body><script>load()</script></body></html>"])("fails on empty/script-only body instead of trusting HTTP 200", async (body) => {
    fetchMock.mockResolvedValueOnce(new Response(body, { headers: { "Content-Type": "text/html" } }));
    const result = await run();
    expect(result.isError).toBe(true);
    expect(result.details.readEvidence.status).toBe("failed");
    expect(result.details.readEvidence.missingReasons).toContain("empty_body");
  });

  it("marks fallback extraction as partial", async () => {
    vi.mocked(htmlToMarkdownDocument).mockRejectedValueOnce(new Error("parser unavailable"));
    fetchMock.mockResolvedValueOnce(new Response("<p>Readable fallback</p>", { headers: { "Content-Type": "text/html" } }));
    const result = await run();
    expect(result.content[0].text).toContain("Readable fallback");
    expect(result.details.readEvidence).toMatchObject({ status: "partial", missingReasons: ["html_coverage_unverified", "html_parser_failed_fallback"] });
  });

  it.each(["application/pdf", "image/png", "application/octet-stream", ""])("rejects unsupported or unknown MIME %s", async (mime) => {
    fetchMock.mockResolvedValueOnce(new Response(new Uint8Array([0, 1]), { headers: mime ? { "Content-Type": mime } : {} }));
    const result = await run();
    expect(result.isError).toBe(true);
    expect(result.details.readEvidence.missingReasons).toEqual(["unsupported_or_missing_content_type"]);
  });

  it("does not claim a server-provided partial response is complete", async () => {
    fetchMock.mockResolvedValueOnce(new Response("slice", { status: 206, headers: { "Content-Type": "text/plain", "Content-Range": "bytes 0-4/100" } }));
    expect((await run()).details.readEvidence).toMatchObject({ status: "partial", missingReasons: ["partial_response"] });
  });

  it("keeps HTTP failures explicit and preserves source evidence", async () => {
    fetchMock.mockResolvedValueOnce(new Response("Sign in", { status: 403 }));
    expect(await run()).toMatchObject({ isError: true, details: { readEvidence: { status: "failed", httpStatus: 403, missingReasons: ["http_error"] } } });
  });

  it("follows a public 303 and preserves both source and resolved URL", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 303, headers: { Location: "/final" } }));
    fetchMock.mockResolvedValueOnce(new Response("Read", { headers: { "Content-Type": "text/plain" } }));
    expect((await run()).details.readEvidence).toMatchObject({ sourceUrl: "https://example.com/article", resolvedUrl: "https://example.com/final", status: "complete" });
  });

  it.each(["http://127.0.0.1/private", "file:///private"])("blocks an unsafe redirect to %s", async (location) => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: location } }));
    const result = await run();
    expect(result.isError).toBe(true);
    expect(result.details.readEvidence.status).toBe("failed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not reuse successful evidence after a failed retry", async () => {
    fetchMock.mockResolvedValueOnce(new Response("first body", { headers: { "Content-Type": "text/plain" } }));
    const first = await run();
    fetchMock.mockRejectedValueOnce(new Error("disconnected"));
    const retry = await run();
    expect(first.details.readEvidence.status).toBe("complete");
    expect(retry.details.readEvidence).toMatchObject({ status: "failed", missingReasons: ["transport_or_read_error"] });
    expect(retry.details.readEvidence.responseTextHash).toBeUndefined();
    expect(first.details.readEvidence.outputTextHash).toBe(hash("first body"));
  });

  it("propagates cancellation to the actual request", async () => {
    const controller = new AbortController();
    fetchMock.mockImplementationOnce(async (_url, init) => {
      controller.abort();
      init?.signal?.throwIfAborted();
      throw new Error("unreachable");
    });
    expect(await run({}, controller.signal)).toMatchObject({ isError: true, details: { readEvidence: { missingReasons: ["cancelled"] } } });
  });

  it("does not dispatch an already cancelled call", async () => {
    expect((await run({}, AbortSignal.abort())).details.readEvidence.missingReasons).toEqual(["cancelled"]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports timeout distinctly", async () => {
    fetchMock.mockRejectedValueOnce(new DOMException("timed out", "TimeoutError"));
    expect((await run()).details.readEvidence.missingReasons).toEqual(["timeout"]);
  });

  it.each([0, -1, NaN, Infinity])("rejects invalid output limit %s", async (maxLength) => {
    expect((await run({ maxLength })).details.readEvidence.missingReasons).toEqual(["invalid_max_length"]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
