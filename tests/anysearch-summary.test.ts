import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createWebSearchTool } from "../lib/tools/web-search.ts";
import { loadLocale, t } from "../lib/i18n.ts";
import { createCompactionGuardExtension } from "../lib/extensions/compaction-guard-ext.ts";
import { SessionManager, convertAgentMessagesToLlm, normalizeContext } from "../lib/pi-sdk/index.ts";
import { convertMessages } from "@earendil-works/pi-ai/api/openai-completions";
import type { AssistantMessage, Model, ToolResultMessage } from "@earendil-works/pi-ai";

const browser = vi.hoisted(() => vi.fn());
vi.mock("../lib/browser/browser-manager.ts", () => ({
  BrowserManager: { instance: () => ({ searchWeb: browser }) },
}));

const fetchMock = vi.fn();
const immediate = { run: (_provider, _source, operation) => operation() };
const row = { title: "搜索结果 🌸", url: "https://example.com/page?lang=zh#完整片段" };
const temporaryRoots: string[] = [];
const invalidExcerpts = [undefined, null, "", " \n\t\u3000", false, true, 0, 7, {}, ["not text"]];

function temporaryRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "anysearch-summary-test-"));
  temporaryRoots.push(root);
  return root;
}

function respond(results, metadata = {}) {
  fetchMock.mockResolvedValueOnce(Response.json({ code: 0, data: { results, metadata } }));
}

function search(provider = "anysearch", params = {}) {
  return createWebSearchTool({
    searchConfigResolver: () => ({ provider, api_keys: { anysearch: "synthetic-key" } }),
    rateLimiter: immediate,
  }).execute("synthetic", { query: "summary query", ...params });
}

function expectText(result, excerpts: string[]) {
  const formatted = result.details.results.slice(0, excerpts.length)
    .map((r, i) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${excerpts[i]}`).join("\n\n");
  expect(result.content).toEqual([{
    type: "text",
    text: t("error.searchResults", { provider: result.details.provider })
      .replaceAll("{results}", () => formatted),
  }]);
}

beforeEach(() => {
  loadLocale("zh");
  browser.mockReset();
  fetchMock.mockReset().mockImplementation(() => { throw new Error("Unexpected fetch"); });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  loadLocale("zh");
  vi.unstubAllGlobals();
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe.each(["anysearch", "anysearch_free"])("%s native summary selection", provider => {
  it("prefers snippet over compatibility description and cleaned content without trimming it", async () => {
    const snippet = " \n原生摘要 🌸 e\u0301 — 日本語 한국어\t ";
    respond([{ ...row, snippet, description: "Compatibility description", content: "Cleaned body" }]);
    const result = await search(provider);
    expect(result.details.results[0].content).toBe(snippet);
    expect(result.details.results[0].metadata.description).toBe("Compatibility description");
    expectText(result, [snippet]);
    expect(JSON.stringify(result)).not.toContain("Cleaned body");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(browser).not.toHaveBeenCalled();
  });

  it.each(invalidExcerpts)("uses description when snippet is unavailable: %j", async snippet => {
    const description = " \n兼容摘要 😀\t ";
    respond([{ ...row, snippet, description, content: "Cleaned body" }]);
    const result = await search(provider);
    expect(result.details.results[0].content).toBe(description);
    expectText(result, [description]);
  });

  it.each(invalidExcerpts)("keeps body fallback when neither summary is usable: %j", async invalid => {
    const content = "\n正文保留：没有摘要的兼容响应。😀\n";
    respond([{ ...row, snippet: invalid, description: invalid, content }]);
    const result = await search(provider);
    expect(result.details.results[0].content).toBe(content);
    expectText(result, [content]);
  });

  it.each(invalidExcerpts)("returns an empty excerpt, preserving the source, when all text is unusable: %j", async invalid => {
    respond([{ ...row, snippet: invalid, description: invalid, content: invalid }]);
    const result = await search(provider);
    expect(result.details.results).toHaveLength(1);
    expect(result.details.results[0]).toMatchObject({ ...row, content: "", rank: 1 });
    expectText(result, [""]);
    expect(browser).not.toHaveBeenCalled();
  });

  it("does not choose a shorter body over the preferred native summary", async () => {
    const snippet = "可用摘要".repeat(100);
    respond([{ ...row, snippet, description: "描述", content: "正文" }]);
    const result = await search(provider);
    expect(result.details.results[0].content).toBe(snippet);
    expectText(result, [snippet]);
  });

  it.each(["zh", "en", "ja", "ko"])("preserves literal titles, URLs and excerpts in locale %s", async locale => {
    loadLocale(locale);
    const literal = "$& $$ $` $' {results} {provider} 中文 🌸 e\u0301";
    const rows = [
      { title: `标题 ${literal}`, url: `https://example.com/$&/$$/$'/$\`?q=完整#尾部`, snippet: literal, content: "BODY_MARKER" },
      { title: "第二来源", url: "https://example.org/two?x=1&y=2#anchor", description: literal, content: "BODY_MARKER" },
    ];
    respond(rows);
    const result = await search(provider, { maxResults: 2 });
    expect(result.details.results.map(r => r.url)).toEqual(rows.map(r => r.url));
    expectText(result, [literal, literal]);
    expect(result.content[0].text).not.toContain("BODY_MARKER");
  });

  it("preserves the nested envelope, ordering, complete URLs, scores, metadata and diagnostics", async () => {
    const rows = [
      { ...row, snippet: "第一摘要", description: "第一描述", content: "第一正文",
        rank: 8, score: 0, quality_score: 4, signal_scores: { relevance: 0.9 },
        source: "web-a", published_at: "2026-10-20" },
      { title: "第二", url: "https://example.org/2?q=汉字&x=1#second", description: "第二描述",
        content: "第二正文", rank: 0, quality_score: 3, source: "web-b" },
      { title: "第三", url: "https://example.net/3#third", content: "只有正文" },
    ];
    const metadata = { total_results: 3, search_time_ms: 88, request_id: "synthetic-request", cached: false };
    respond(rows, metadata);
    const result = await search(provider, { maxResults: 3 });
    expect(result.details).toEqual({
      query: "summary query", provider, source_type: "api",
      results: [
        { title: row.title, url: row.url, content: "第一摘要", rank: 8, score: 0,
          metadata: { description: "第一描述", quality_score: 4, signal_scores: { relevance: 0.9 },
            source: "web-a", published_at: "2026-10-20" } },
        { title: "第二", url: rows[1].url, content: "第二描述", rank: 0, score: 3,
          metadata: { description: "第二描述", quality_score: 3, signal_scores: {}, source: "web-b", published_at: null } },
        { title: "第三", url: rows[2].url, content: "只有正文", rank: 3, score: null,
          metadata: { description: "", quality_score: null, signal_scores: {}, source: "", published_at: null } },
      ],
      diagnostics: { anonymous: provider === "anysearch_free", ...metadata },
    });
    expectText(result, ["第一摘要", "第二描述", "只有正文"]);
  });

  it("keeps top-level results/metadata compatibility with description-only and body-only results", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({
      results: [{ ...row, description: "兼容摘要", content: "正文" }, { ...row, content: "正文回退" }],
      metadata: { total_results: 2, request_id: "synthetic-legacy" },
    }));
    const result = await search(provider, { maxResults: 2 });
    expect(result.details.diagnostics.request_id).toBe("synthetic-legacy");
    expectText(result, ["兼容摘要", "正文回退"]);
  });

  it("does not retain discarded long bodies in details, L1, JSONL or model content", async () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({
      title: `来源 ${i + 1}`, url: `https://example.com/source-${i + 1}?q=中文#end`,
      snippet: `摘要 ${i + 1} 🌸`, content: `BODY_MARKER_${i}:` + "长正文".repeat(8_000),
    }));
    respond(rows);
    const result = await search(provider, { maxResults: 3 });
    expectText(result, rows.map(r => r.snippet));
    expect(JSON.stringify(result)).not.toContain("BODY_MARKER");
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(4_096);

    let onResult;
    createCompactionGuardExtension()({ on(name, handler) { if (name === "tool_result") onResult = handler; } });
    expect(onResult).toBeTypeOf("function");
    expect(onResult({
      toolName: "web_search", content: result.content, details: result.details, isError: false,
    })).toBeUndefined();

    const root = temporaryRoot();
    const model: Model<"openai-completions"> = {
      id: "synthetic", name: "Synthetic", provider: "synthetic", api: "openai-completions",
      input: ["text"], baseUrl: "https://example.invalid", reasoning: false,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096,
    };
    const assistant: AssistantMessage = {
      role: "assistant", api: model.api, provider: model.provider, model: model.id,
      content: [{ type: "toolCall", id: "synthetic", name: "web_search", arguments: { query: "summary query" } }],
      stopReason: "toolUse", timestamp: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    const message: ToolResultMessage = {
      role: "toolResult", toolCallId: "synthetic", toolName: "web_search", isError: false, timestamp: 0,
      content: [{ type: "text", text: result.content[0].text }], details: result.details,
    };
    const session = SessionManager.create(root, path.join(root, "sessions"));
    session.appendMessage(assistant);
    session.appendMessage(message);
    const jsonl = fs.readFileSync(session.getSessionFile()!, "utf8");
    const saved = jsonl.trim().split("\n").map(line => JSON.parse(line))
      .find(e => e.message?.role === "toolResult").message;
    expect(saved.content).toEqual(result.content);
    expect(saved.details).toEqual(result.details);
    expect(jsonl).not.toContain("BODY_MARKER");
    expect(jsonl).not.toContain("synthetic-key");
    const converted = convertMessages(model, normalizeContext({ messages: convertAgentMessagesToLlm([assistant, message]) }), {
      supportsStore: true, supportsDeveloperRole: true, supportsReasoningEffort: true,
      supportsUsageInStreaming: true, supportsFinishReason: true, maxTokensField: "max_completion_tokens",
      requiresToolResultName: false, requiresAssistantAfterToolResult: false, requiresThinkingAsText: false,
      requiresReasoningContentOnAssistantMessages: false, thinkingFormat: "openai",
      openRouterRouting: {}, vercelGatewayRouting: {}, chatTemplateKwargs: {}, chatTemplateArgs: {},
      zaiToolStream: false, supportsStrictMode: false, supportsOpenAIGrammarTools: false,
      supportsMidConvoSystemMessages: false, supportsMidConvoToolAdditions: false,
      sendSessionAffinityHeaders: false, sessionAffinityFormat: "openai", supportsLongCacheRetention: true,
    });
    expect(converted.find(m => m.role === "tool")!.content).toBe(result.content[0].text);
    expect(JSON.stringify(converted)).not.toContain("BODY_MARKER");
    expect(JSON.stringify(converted)).not.toContain('"details"');
  });
});

describe("AnySearch configuration variants", () => {
  it.each([
    { provider: "anysearch", api_key: "synthetic-legacy-key" },
    { provider: "anysearch", api_keys: { anysearch: "synthetic-map-key" } },
    { provider: "auto", api_keys: { anysearch: "synthetic-map-key", tavily: "unused-synthetic-key" } },
    { provider: "anysearch_free", api_keys: { anysearch: "unused-synthetic-key" } },
    { provider: "auto", api_keys: {} },
  ])("keeps request/auth/provider selection for %j", async config => {
    respond([{ ...row, snippet: "摘要", description: "描述", content: "正文" }]);
    const result = await createWebSearchTool({
      searchConfigResolver: () => config, rateLimiter: immediate,
    }).execute("synthetic", { query: "summary query", maxResults: 3 });
    const expectedKey = config.provider === "anysearch_free" ? "" : config.api_key || config.api_keys?.anysearch || "";
    const selected = expectedKey ? "anysearch" : "anysearch_free";
    expect(result.details.provider).toBe(selected);
    expect(result.details.diagnostics.anonymous).toBe(!expectedKey);
    expectText(result, ["摘要"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.anysearch.com/v1/search");
    expect(request.method).toBe("POST");
    expect(request.headers).toEqual({
      "Content-Type": "application/json",
      ...(expectedKey ? { Authorization: `Bearer ${expectedKey}` } : {}),
    });
    expect(JSON.parse(request.body)).toEqual({ query: "summary query", max_results: 3, language: "zh-CN" });
    expect(browser).not.toHaveBeenCalled();
  });

  it("uses the same selector for a legacy per-agent config file without a resolver", async () => {
    const configPath = path.join(temporaryRoot(), "config.yaml");
    fs.writeFileSync(configPath, "search:\n  provider: anysearch\n  api_key: synthetic-file-key\n");
    respond([{ ...row, description: "兼容摘要", content: "正文" }]);
    const result = await createWebSearchTool({ configPath, rateLimiter: immediate })
      .execute("synthetic", { query: "summary query", maxResults: 1 });
    expectText(result, ["兼容摘要"]);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer synthetic-file-key");
  });
});

describe("other API providers retain their own excerpt contracts", () => {
  it.each([
    { provider: "tavily", response: { results: [{ ...row, content: "Tavily content", snippet: "unused" }] },
      expected: "Tavily content" },
    { provider: "brave", response: { web: { results: [{ ...row, description: "Brave description", snippet: "unused" }] } },
      expected: "Brave description" },
    { provider: "serper", response: { organic: [{ ...row, link: row.url, snippet: "Serper snippet", content: "unused" }] },
      expected: "Serper snippet" },
  ])("keeps $provider mapping", async ({ provider, response, expected }) => {
    fetchMock.mockResolvedValueOnce(Response.json(response));
    const result = await createWebSearchTool({
      searchConfigResolver: () => ({ provider, api_key: "synthetic-key" }), rateLimiter: immediate,
    }).execute("synthetic", { query: "summary query", maxResults: 1 });
    expect(result.details).toMatchObject({ provider, source_type: "api", results: [{ ...row, content: expected }] });
    expectText(result, [expected]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(browser).not.toHaveBeenCalled();
  });
});
