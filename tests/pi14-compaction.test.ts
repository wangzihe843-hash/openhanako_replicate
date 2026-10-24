/* eslint-disable @typescript-eslint/no-explicit-any -- Synthetic cross-provider wire fixtures intentionally inspect heterogeneous SDK payloads before dispatch. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { compact } from "@earendil-works/pi-coding-agent";
import { normalizeContext } from "@earendil-works/pi-ai";
import { clampMaxTokensToContext } from "@earendil-works/pi-ai/api/simple-options";
import { streamSimple as openaiCompletions } from "@earendil-works/pi-ai/api/openai-completions";
import { streamSimple as openaiResponses } from "@earendil-works/pi-ai/api/openai-responses";
import { streamSimple as codexResponses } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { streamSimple as piMessages } from "@earendil-works/pi-ai/api/pi-messages";
import { streamSimple as anthropicMessages } from "@earendil-works/pi-ai/api/anthropic-messages";
import { streamSimple as googleGenerativeAi } from "@earendil-works/pi-ai/api/google-generative-ai";
import {
  buildNativeCompactionRequestShapes,
  estimateDefaultCompactionOutputTokens,
  estimateDefaultCompactionOutputBudget,
  CompactionBudgetSafetyError,
} from "../lib/pi-sdk/compaction-request-shape.ts";
import {
  estimateCachePreservingCompactionRequest,
  normalizeCompactionProviderPayload,
  shouldHardTruncateCachePreservingCompaction,
} from "../core/session-compactor.ts";

const user = (text: string) => ({ role: "user" as const, content: [{ type: "text" as const, text }], timestamp: 1 });
const preparation = (text = "history") => ({
  firstKeptEntryId: "retained",
  messagesToSummarize: [user(text)],
  turnPrefixMessages: [user("turn prefix")],
  isSplitTurn: true,
  tokensBefore: 12_000,
  previousSummary: "previous summary",
  fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
  settings: { enabled: true, reserveTokens: 640, keepRecentTokens: 100 },
});
const model = (api: string, maxTokens = 32_768, contextWindow = 32_768) => ({
  id: api === "google-generative-ai" ? "gemini-2.5-flash" : "synthetic-summary",
  name: "Synthetic summary",
  api,
  provider: "synthetic",
  baseUrl: "https://example.invalid/v1",
  reasoning: false,
  input: ["text"],
  contextWindow,
  maxTokens,
  compat: { supportsMaxOutputTokens: true },
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
});
const APIs = [
  { api: "openai-completions", stream: openaiCompletions, cap: (payload: any) => payload.max_completion_tokens ?? payload.max_tokens },
  { api: "openai-responses", stream: openaiResponses, cap: (payload: any) => payload.max_output_tokens },
  { api: "anthropic-messages", stream: anthropicMessages, cap: (payload: any) => payload.max_tokens },
  { api: "google-generative-ai", stream: googleGenerativeAi, cap: (payload: any) => payload.config.maxOutputTokens },
];

afterEach(() => vi.unstubAllGlobals());

describe("Pi 1.4 native summaries and provider-default planning", () => {
  it.each([
    { name: "Responses enabled", api: "openai-responses", stream: openaiResponses, compat: { supportsMaxOutputTokens: true }, provider: "synthetic", baseUrl: "https://example.invalid/v1", source: "wire-cap", key: "synthetic-api-key" },
    { name: "Responses disabled", api: "openai-responses", stream: openaiResponses, compat: { supportsMaxOutputTokens: false }, provider: "synthetic", baseUrl: "https://example.invalid/v1", source: "model-limit", key: "synthetic-api-key" },
    { name: "ChatGPT sign-in", api: "openai-responses", stream: openaiResponses, compat: { supportsMaxOutputTokens: true }, provider: "openai", baseUrl: "https://api.openai.com/v1", source: "model-limit", key: "synthetic-sign-in-token" },
    { name: "OpenAI API key (auth not inspected by planner)", api: "openai-responses", stream: openaiResponses, compat: { supportsMaxOutputTokens: true }, provider: "openai", baseUrl: "https://api.openai.com/v1", source: "model-limit", key: "sk-synthetic-test-only" },
    { name: "Codex", api: "openai-codex-responses", stream: codexResponses, compat: { supportsMaxOutputTokens: true }, provider: "openai-codex", baseUrl: "https://example.invalid/v1", source: "model-limit", key: `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" } })).toString("base64url")}.signature` },
  ])("P1: $name uses the real serialized cap contract without dispatch", async (fixture) => {
    const network = vi.fn(() => { throw new Error("Unexpected network attempt"); });
    vi.stubGlobal("fetch", network);
    const requestModel = { ...model(fixture.api, 8192, 8192), provider: fixture.provider, baseUrl: fixture.baseUrl, compat: fixture.compat };
    const messages = [user("x".repeat(3500))];
    const budget = estimateDefaultCompactionOutputBudget(requestModel, messages);
    const clamp = clampMaxTokensToContext(requestModel as any, normalizeContext({ messages }), requestModel.maxTokens);
    let payload: any;
    const result = await fixture.stream(requestModel as any, normalizeContext({ messages }), {
      apiKey: fixture.key, maxRetries: 0, transport: "sse",
      onPayload(value: any) { payload = value; throw new Error("synthetic pre-dispatch stop"); },
    }).result();
    expect(result.errorMessage).toContain("synthetic pre-dispatch stop");
    expect(budget.outputBudgetSource).toBe(fixture.source);
    if (fixture.source === "wire-cap") {
      expect(payload.max_output_tokens).toBe(clamp);
      expect(budget.outputBudgetTokens).toBe(clamp);
    } else {
      if (fixture.key.startsWith("sk-")) expect(payload.max_output_tokens).toBe(clamp);
      else expect(payload).not.toHaveProperty("max_output_tokens");
      expect(budget.outputBudgetTokens).toBe(8192);
      expect(budget.outputBudgetTokens).toBeGreaterThan(clamp);
    }
    const prep = { ...preparation("short history"), isSplitTurn: false, turnPrefixMessages: [] };
    const input = { model: requestModel, preparation: prep, messages: [user("short history")] };
    const before = structuredClone(input);
    if (fixture.source === "wire-cap") {
      expect(shouldHardTruncateCachePreservingCompaction(input)).toMatchObject({ shouldUseNativeFallback: true, shouldHardTruncate: false });
    } else {
      // A large capability ceiling is not evidence that short history needs
      // deleting. This used to report B fit using the absent wire clamp.
      expect(() => shouldHardTruncateCachePreservingCompaction(input)).toThrow(CompactionBudgetSafetyError);
      const fits = shouldHardTruncateCachePreservingCompaction({ ...input, model: { ...requestModel, maxTokens: 2048 } });
      expect(fits).toMatchObject({ cachePreservingFits: true, nativeSummaryFits: true, shouldHardTruncate: false });
    }
    expect(input).toEqual(before);
    expect(network).not.toHaveBeenCalled();
  });

  it("rejects forwarding/custom API bounds and observes pi-messages forwarding no maxTokens", async () => {
    const network = vi.fn(() => { throw new Error("Unexpected network attempt"); });
    vi.stubGlobal("fetch", network);
    const requestModel = model("pi-messages", 8192, 32768);
    let payload: any;
    const result = await piMessages(requestModel as any, normalizeContext({ messages: [user("history")] }), {
      apiKey: "synthetic-key",
      onPayload(value: any) { payload = value; throw new Error("synthetic pre-dispatch stop"); },
    }).result();
    expect(result.errorMessage).toContain("synthetic pre-dispatch stop");
    expect(payload.options.maxTokens).toBeUndefined();
    for (const api of ["pi-messages", "custom-api", undefined]) {
      expect(() => estimateDefaultCompactionOutputBudget({ ...requestModel, api }, [user("history")])).toThrow(CompactionBudgetSafetyError);
    }
    expect(network).not.toHaveBeenCalled();
  });

  it("checks both split requests and never allows an oversized custom focus to bypass B", () => {
    const requestModel = model("openai-responses", 2048, 8192);
    const prep = { ...preparation(), turnPrefixMessages: [user("x".repeat(40000))] };
    const fit = shouldHardTruncateCachePreservingCompaction({ model: requestModel, preparation: prep, messages: [user("x".repeat(40000))] });
    expect(fit.nativeRequests[0].totalTokens).toBeLessThan(requestModel.contextWindow);
    expect(fit.nativeRequests[1].promptTokens).toBeGreaterThan(requestModel.contextWindow);
    expect(fit).toMatchObject({ nativeSummaryFits: false, shouldHardTruncate: true });
    const focused = shouldHardTruncateCachePreservingCompaction({ model: requestModel, preparation: preparation(), messages: [user("history")], customInstructions: "focus".repeat(12000) });
    expect(focused.nativeRequests.every(request => request.promptTokens > requestModel.contextWindow)).toBe(true);
    expect(focused.shouldHardTruncate).toBe(true);
  });
  it.each(APIs)("matches $api serialization for 2048/8192/32768 model limits without network", async ({ api, stream, cap }) => {
    const network = vi.fn(() => { throw new Error("Unexpected network attempt"); });
    vi.stubGlobal("fetch", network);
    for (const maxTokens of [2048, 8192, 32768]) {
      const requestModel = model(api, maxTokens);
      const prep = preparation();
      const shapes = buildNativeCompactionRequestShapes({ preparation: prep, model: requestModel, customInstructions: "preserve tools" }).requests;
      const captured: Array<{ context: any; options: any; payload: any }> = [];
      const streamFn = async (_model: any, context: any, options: any) => {
        let payload: any;
        const response = await stream(requestModel as any, context, {
          ...options,
          apiKey: "synthetic-api-key",
          maxRetries: 0,
          onPayload(value: any) {
            payload = value;
            // Every serializer invokes this before dispatch. Stop there so this
            // is an actual provider payload check with no live provider call.
            throw new Error("synthetic pre-dispatch stop");
          },
        }).result();
        expect(response.stopReason).toBe("error");
        expect(response.errorMessage).toContain("synthetic pre-dispatch stop");
        captured.push({ context, options, payload });
        return { result: async () => ({ role: "assistant", content: [{ type: "text", text: "fixture summary" }], stopReason: "stop", timestamp: 2 }) };
      };
      await compact(prep as any, requestModel as any, undefined, undefined, "preserve tools", undefined, "off", streamFn as any);
      expect(captured).toHaveLength(2);
      for (let index = 0; index < shapes.length; index++) {
        const actual = captured[index];
        const shape = shapes[index];
        expect(actual.options).not.toHaveProperty("maxTokens");
        expect(actual.context.messages.find((message: any) => message.role === "user").content[0].text).toBe(shape.promptText);
        expect(shape.promptText.endsWith("Additional focus: preserve tools")).toBe(true);
        expect(cap(actual.payload)).toBe(shape.outputBudgetTokens);
        const sdkLimit = clampMaxTokensToContext(requestModel as any, normalizeContext({ systemPrompt: shape.systemPrompt, messages: shape.messages }), maxTokens);
        expect(shape.outputBudgetTokens).toBe(api === "openai-responses" ? Math.max(16, sdkLimit) : sdkLimit);
      }
    }
    expect(network).not.toHaveBeenCalled();
  });

  it.each(APIs)("models the tiny-context $api ceiling without NaN or dispatch", async ({ api, stream, cap }) => {
    const network = vi.fn(() => { throw new Error("Unexpected network attempt"); });
    vi.stubGlobal("fetch", network);
    const requestModel = model(api, 8192, 256);
    const shape = buildNativeCompactionRequestShapes({ preparation: preparation(), model: requestModel }).requests[0];
    let payload: any;
    await stream(requestModel as any, normalizeContext({ systemPrompt: shape.systemPrompt, messages: shape.messages }), {
      apiKey: "synthetic-api-key",
      maxRetries: 0,
      onPayload(value: any) { payload = value; throw new Error("synthetic pre-dispatch stop"); },
    }).result();
    expect(shape.outputBudgetTokens).toBe(api === "openai-responses" ? 16 : 1);
    expect(cap(payload)).toBe(shape.outputBudgetTokens);
    const fit = shouldHardTruncateCachePreservingCompaction({ model: requestModel, preparation: preparation(), messages: [user("history")] });
    expect(fit.shouldHardTruncate).toBe(true);
    expect(Number.isFinite(fit.nativeSummaryBudget.totalTokens)).toBe(true);
    expect(network).not.toHaveBeenCalled();
  });

  it.each(APIs)("retains the $api ceiling when reasoning is enabled", async ({ api, stream, cap }) => {
    const network = vi.fn(() => { throw new Error("Unexpected network attempt"); });
    vi.stubGlobal("fetch", network);
    const requestModel = { ...model(api, 8192, 16384), reasoning: true };
    const shape = buildNativeCompactionRequestShapes({ preparation: preparation(), model: requestModel }).requests[0];
    let payload: any;
    const result = await stream(requestModel as any, normalizeContext({ systemPrompt: shape.systemPrompt, messages: shape.messages }), {
      apiKey: "synthetic-api-key",
      reasoning: "high",
      maxRetries: 0,
      onPayload(value: any) { payload = value; throw new Error("synthetic pre-dispatch stop"); },
    }).result();
    expect(result.errorMessage).toContain("synthetic pre-dispatch stop");
    expect(cap(payload)).toBe(shape.outputBudgetTokens);
    expect(network).not.toHaveBeenCalled();
  });

  it("mirrors the native empty split-prefix request rather than inventing no request", async () => {
    const prep = { ...preparation(), messagesToSummarize: [], turnPrefixMessages: [] };
    const requestModel = model("openai-completions", 2048, 8192);
    const shapes = buildNativeCompactionRequestShapes({ preparation: prep, model: requestModel }).requests;
    const requests: any[] = [];
    await compact(prep as any, requestModel as any, undefined, undefined, "focus", undefined, "off", (async (_model: any, context: any) => {
      requests.push(context);
      return { result: async () => ({ role: "assistant", content: [{ type: "text", text: "summary" }], stopReason: "stop" }) };
    }) as any);
    expect(shapes.map(shape => shape.kind)).toEqual(["turn-prefix"]);
    expect(requests).toHaveLength(1);
  });

  it("does not interpret the default output capacity as an explicit 85% reservation", () => {
    const requestModel = model("openai-completions");
    const fit = shouldHardTruncateCachePreservingCompaction({ model: requestModel, preparation: preparation(), messages: [user("history")] });
    // A direct replacement of the old reserve cap with the SDK default, while
    // retaining the old total<=85% rule, would reject even this short summary.
    expect(fit.nativeSummaryBudget.totalTokens).toBeGreaterThan(fit.threshold);
    expect(fit.nativeSummaryBudget.promptTokens).toBeLessThan(fit.threshold);
    expect(fit.nativeSummaryBudget.totalTokens).toBeLessThan(requestModel.contextWindow);
    expect(fit).toMatchObject({ cachePreservingFits: false, nativeSummaryFits: true, shouldUseNativeFallback: true, shouldHardTruncate: false });
    // Optional-cap A has no enforced SDK clamp after its payload hook. Its
    // conservative model ceiling can reject A while the real capped B fits.
    expect(fit.cachePreservingBudget.outputBudgetTokens).toBe(requestModel.maxTokens);
  });

  it("retains A-over/B-fit fallback and both-prompts-over hard truncation", () => {
    const requestModel = model("openai-completions", 8192, 8192);
    const prep = { ...preparation("small old history"), turnPrefixMessages: [], isSplitTurn: false };
    const fallback = shouldHardTruncateCachePreservingCompaction({ model: requestModel, preparation: prep, messages: [user("small old history"), user("x".repeat(30_000))] });
    expect(fallback).toMatchObject({ cachePreservingFits: false, nativeSummaryFits: true, shouldUseNativeFallback: true, shouldHardTruncate: false });
    const oversized = user("x".repeat(60_000));
    const truncate = shouldHardTruncateCachePreservingCompaction({ model: requestModel, preparation: { ...prep, messagesToSummarize: [oversized] }, messages: [oversized] });
    expect(truncate).toMatchObject({ cachePreservingFits: false, nativeSummaryFits: false, shouldUseNativeFallback: false, shouldHardTruncate: true });
  });

  it("keeps provider-default wire policy separate from explicit bounded cache summaries", () => {
    const requestModel = model("openai-completions", 8192, 32768);
    const prep = preparation();
    const request = { model: requestModel, preparation: prep, messages: [user("history")] };
    const defaults = estimateCachePreservingCompactionRequest(request);
    const bounded = estimateCachePreservingCompactionRequest({ ...request, outputPolicy: "bounded" });
    expect(defaults.cachePreservingBudget.maxTokens).toBeUndefined();
    expect(defaults.cachePreservingBudget.outputBudgetTokens).toBe(8192);
    expect(bounded.cachePreservingBudget.maxTokens).toBe(512);
    expect(bounded.cachePreservingBudget.outputBudgetTokens).toBe(512);
    const payload = { messages: [{ role: "user", content: "history" }], max_tokens: 8192 };
    expect(normalizeCompactionProviderPayload(payload, requestModel)).not.toHaveProperty("max_tokens");
    expect(normalizeCompactionProviderPayload({ ...payload, max_tokens: 512 }, requestModel, { outputPolicy: "bounded", boundedMaxTokens: 512 })).toHaveProperty("max_tokens", 512);
    expect(bounded.nativeRequests.every(request => request.maxTokens === undefined && request.outputPolicy === "provider-default")).toBe(true);
  });

  it("preserves the explicit bounded total-at-threshold boundary", () => {
    const request = { model: model("openai-completions", 8192, 32768), preparation: preparation(), messages: [user("history")], outputPolicy: "bounded" as const };
    const budget = estimateCachePreservingCompactionRequest(request).cachePreservingBudget;
    const fits = shouldHardTruncateCachePreservingCompaction({ ...request, model: { ...request.model, contextWindow: budget.totalTokens * 2 }, hardTruncateThreshold: 0.5 });
    const over = shouldHardTruncateCachePreservingCompaction({ ...request, model: { ...request.model, contextWindow: (budget.totalTokens - 1) * 2 }, hardTruncateThreshold: 0.5 });
    expect(fits.cachePreservingFits).toBe(true);
    expect(over.cachePreservingFits).toBe(false);
    expect(over.cachePreservingBudget.promptTokens).toBeLessThan(over.threshold);
    expect(fits.cachePreservingBudget.outputBudgetTokens).toBe(over.cachePreservingBudget.outputBudgetTokens);
  });

  it.each(APIs)("distinguishes the actual $api cache-default payload from native B", async ({ api, stream, cap }) => {
    const network = vi.fn(() => { throw new Error("Unexpected network attempt"); });
    vi.stubGlobal("fetch", network);
    const requestModel = model(api, 32768, 16384);
    const messages = [user("live prefix")];
    const instruction = user("summarize this context");
    const budget = estimateCachePreservingCompactionRequest({ model: requestModel, preparation: preparation(), messages, instruction });
    let nativePayload: any;
    let cachePayload: any;
    const result = await stream(requestModel as any, normalizeContext({ messages: [...messages, instruction] }), {
      apiKey: "synthetic-api-key",
      maxRetries: 0,
      onPayload(value: any) {
        nativePayload = value;
        cachePayload = normalizeCompactionProviderPayload(value, requestModel);
        throw new Error("synthetic pre-dispatch stop");
      },
    }).result();
    expect(result.errorMessage).toContain("synthetic pre-dispatch stop");
    if (api === "anthropic-messages") {
      expect(cap(cachePayload)).toBe(cap(nativePayload));
      expect(budget.cachePreservingBudget.outputBudgetTokens).toBe(cap(cachePayload));
    } else {
      // Google serializes maxOutputTokens inside config; the generic hook only
      // recognizes root cap fields, so its nested SDK cap remains enforced.
      if (api === "google-generative-ai") expect(cap(cachePayload)).toBe(cap(nativePayload));
      else expect(cap(cachePayload)).toBeUndefined();
      expect(budget.cachePreservingBudget.outputBudgetTokens).toBe(requestModel.maxTokens);
      expect(cap(nativePayload)).toBeLessThan(requestModel.maxTokens);
    }
    expect(network).not.toHaveBeenCalled();
  });

  it("removes DeepSeek's implicit SDK cap for A while keeping B's real context clamp", async () => {
    const network = vi.fn(() => { throw new Error("Unexpected network attempt"); });
    vi.stubGlobal("fetch", network);
    const requestModel = { ...model("openai-completions", 32768, 16384), provider: "deepseek" };
    const messages = [user("live prefix")];
    const instruction = user("summarize this context");
    const budget = estimateCachePreservingCompactionRequest({ model: requestModel, preparation: preparation(), messages, instruction });
    let nativePayload: any;
    let cachePayload: any;
    await openaiCompletions(requestModel as any, normalizeContext({ messages: [...messages, instruction] }), {
      apiKey: "synthetic-api-key",
      maxRetries: 0,
      onPayload(value: any) {
        nativePayload = value;
        cachePayload = normalizeCompactionProviderPayload(value, requestModel);
        throw new Error("synthetic pre-dispatch stop");
      },
    }).result();
    expect(nativePayload.max_tokens ?? nativePayload.max_completion_tokens).toBeLessThan(requestModel.maxTokens);
    expect(cachePayload).not.toHaveProperty("max_tokens");
    expect(cachePayload).not.toHaveProperty("max_completion_tokens");
    expect(budget.cachePreservingBudget.outputBudgetTokens).toBe(requestModel.maxTokens);
    expect(budget.nativeSummaryBudget.outputBudgetTokens).toBeLessThan(requestModel.maxTokens);
    expect(network).not.toHaveBeenCalled();
  });

  for (const fixture of [
    { label: "completions", api: "openai-completions", source: "wire-cap" },
    { label: "Responses capped", api: "openai-responses", source: "wire-cap" },
    { label: "Responses omitted", api: "openai-responses", source: "model-limit", compat: { supportsMaxOutputTokens: false } },
    { label: "Responses auth", api: "openai-responses", source: "model-limit", provider: "openai", baseUrl: "https://api.openai.com/v1" },
    { label: "Codex", api: "openai-codex-responses", source: "model-limit" },
  ]) {
    const { label, source, ...override } = fixture;
    const requestModel = { ...model(fixture.api, 8192, 8192), ...override };
    const assistant = {
      role: "assistant" as const, content: [{ type: "text" as const, text: "tail" }],
      api: requestModel.api, provider: requestModel.provider, model: requestModel.id,
      stopReason: "stop" as const, timestamp: 2,
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    it.each([undefined, null])(`F3 rejects absent usage through shared SDK validation: ${label} (%j)`, invalidUsage => {
      const messages = [user("history"), { ...assistant, usage: invalidUsage }];
      const before = structuredClone(messages);
      expect(() => estimateDefaultCompactionOutputBudget(requestModel, messages)).toThrow(CompactionBudgetSafetyError);
      expect(messages).toEqual(before);
    });
    it(`F3 preserves valid usage and the selected output bound: ${label}`, () => {
      const messages = [user("history"), assistant];
      const before = structuredClone(messages);
      const budget = estimateDefaultCompactionOutputBudget(requestModel, messages);
      const clamp = clampMaxTokensToContext(requestModel as any, normalizeContext({ messages }), requestModel.maxTokens);
      expect(budget.outputBudgetSource).toBe(source);
      expect(budget.outputBudgetTokens).toBe(source === "model-limit" ? requestModel.maxTokens : clamp);
      expect(Number.isFinite(budget.outputBudgetTokens)).toBe(true);
      const fit = shouldHardTruncateCachePreservingCompaction({ model: { ...requestModel, maxTokens: 2048 }, preparation: preparation(), messages });
      expect(fit).toMatchObject({ cachePreservingFits: true, nativeSummaryFits: true, shouldHardTruncate: false });
      expect(messages).toEqual(before);
      expect(() => estimateDefaultCompactionOutputBudget({ ...requestModel, maxTokens: undefined }, messages)).toThrow(/finite positive model.maxTokens/);
    });
  }

  it.each([
    undefined,
    { contextWindow: 8192 },
    { maxTokens: Number.NaN, contextWindow: 8192 },
    { maxTokens: Number.POSITIVE_INFINITY, contextWindow: 8192 },
    { maxTokens: 0, contextWindow: 8192 },
    { maxTokens: 8192, contextWindow: Number.NaN },
    { maxTokens: 8192, contextWindow: 0 },
  ])("fails closed for an unknown or invalid model instead of deciding to truncate: %j", invalid => {
    expect(() => shouldHardTruncateCachePreservingCompaction({ model: invalid as Parameters<typeof shouldHardTruncateCachePreservingCompaction>[0]["model"], preparation: preparation(), messages: [user("history")] })).toThrow(/Compaction (fit|output estimation)/);
  });

  it("uses the SDK context estimate with the real system message and tool declarations", () => {
    const requestModel = model("openai-completions", 32768, 8192);
    const messages = [user("history")];
    const tools = [{ name: "lookup", description: "schema".repeat(500), parameters: { type: "object", properties: {} } }];
    const systemPrompt = "system".repeat(500);
    const actual = estimateDefaultCompactionOutputTokens(requestModel, messages, systemPrompt, tools);
    expect(actual).toBe(clampMaxTokensToContext(requestModel as any, normalizeContext({ systemPrompt, messages, tools }), requestModel.maxTokens));
    expect(actual).toBeLessThan(estimateDefaultCompactionOutputTokens(requestModel, messages));
  });
});
