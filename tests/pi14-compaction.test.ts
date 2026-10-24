/* eslint-disable @typescript-eslint/no-explicit-any -- Synthetic cross-provider wire fixtures intentionally inspect heterogeneous SDK payloads before dispatch. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { compact } from "@earendil-works/pi-coding-agent";
import { normalizeContext } from "@earendil-works/pi-ai";
import { clampMaxTokensToContext } from "@earendil-works/pi-ai/api/simple-options";
import { streamSimple as openaiCompletions } from "@earendil-works/pi-ai/api/openai-completions";
import { streamSimple as openaiResponses } from "@earendil-works/pi-ai/api/openai-responses";
import { streamSimple as anthropicMessages } from "@earendil-works/pi-ai/api/anthropic-messages";
import { streamSimple as googleGenerativeAi } from "@earendil-works/pi-ai/api/google-generative-ai";
import {
  buildNativeCompactionRequestShapes,
  estimateDefaultCompactionOutputTokens,
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

  it.each([
    undefined,
    { contextWindow: 8192 },
    { maxTokens: Number.NaN, contextWindow: 8192 },
    { maxTokens: Number.POSITIVE_INFINITY, contextWindow: 8192 },
    { maxTokens: 0, contextWindow: 8192 },
    { maxTokens: 8192, contextWindow: Number.NaN },
    { maxTokens: 8192, contextWindow: 0 },
  ])("fails closed for an unknown or invalid model instead of deciding to truncate: %j", invalid => {
    expect(() => shouldHardTruncateCachePreservingCompaction({ model: invalid, preparation: preparation(), messages: [user("history")] })).toThrow(/Compaction (fit|output estimation)/);
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
