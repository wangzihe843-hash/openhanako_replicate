import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelManager } from "../core/model-manager.ts";
import { ProviderRegistry } from "../core/provider-registry.ts";
import { normalizeProviderContextMessages, normalizeProviderPayload } from "../core/provider-compat.ts";
import { normalizeThinkingLevelForModel } from "../core/session-thinking-level.ts";
import { Type } from "../lib/pi-sdk/index.ts";
import { getModelRuntime } from "../lib/pi-sdk/model-runtime.ts";
import { lookupKnownProvider } from "../shared/known-models.ts";

const PROVIDER = "deepseek-responses";
const MODEL_IDS = ["deepseek-flash", "deepseek-v4-pro"];
const LEVELS = ["off", "low", "high", "max"];
const ENDPOINTS = ["https://api.deepseek.com", "https://proxy.invalid/deepseek"];
type RuntimeContext = Parameters<ReturnType<typeof getModelRuntime>["streamSimple"]>[1];
type Payload = Record<string, unknown> & {
  reasoning?: { effort?: string };
  input?: Record<string, unknown>[];
  max_output_tokens?: number;
};
let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "hana-deepseek-responses-"));
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected Responses test network request"));
});

afterEach(() => {
  try {
    expect(globalThis.fetch).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

async function loadProvider(config: Record<string, unknown> = {}, provider = PROVIDER) {
  const registry = new ProviderRegistry(home);
  const input = { api_key: "synthetic-offline-key", ...config };
  const original = structuredClone(input);
  registry.saveProvider(provider, input);
  expect(input).toEqual(original);
  const saved = structuredClone(registry.getAllProvidersRaw()[provider]);
  const manager = new ModelManager({ hanakoHome: home });
  await manager.init();
  await manager.refreshAvailable();
  expect(manager.modelRegistry.getError()).toBeUndefined();
  expect(manager.providerRegistry.getAllProvidersRaw()[provider]).toEqual(saved);
  const models = manager.availableModels.filter(model => model.provider === provider);
  return { manager, models };
}

// Keep the actual registry models and installed serializer in the path. A map
// merged into a hand-built model here would conceal the original Max clamp.
async function capture(manager, model, level, options: {
  context?: RuntimeContext; maxTokens?: number; mode?: string; outputBudgetSource?: string;
} = {}) {
  const hana = normalizeThinkingLevelForModel(level, model);
  const reasoning = manager.resolveThinkingLevel(hana);
  expect(hana).toBe(level);
  expect(reasoning).toBe(level === "max" ? "xhigh" : level);
  const context: RuntimeContext = options.context ?? {
    messages: [{ role: "user", content: "Offline serializer contract.", timestamp: 1 }],
  };
  const contextBefore = structuredClone(context);
  const modelBefore = structuredClone(model);
  const compatOptions = {
    mode: options.mode ?? "chat", reasoningLevel: reasoning,
    ...(options.outputBudgetSource ? { outputBudgetSource: options.outputBudgetSource } : {}),
  };
  let raw: Payload;
  let final: Payload;
  let payloadAfterCompat: Payload;
  const result = await getModelRuntime(manager.modelRegistry).streamSimple(model, {
    ...context, messages: normalizeProviderContextMessages(context.messages, model, compatOptions),
  }, {
    reasoning, transport: "sse",
    ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
    onPayload(payload) {
      raw = structuredClone(payload) as Payload;
      final = normalizeProviderPayload(payload, model, compatOptions);
      payloadAfterCompat = structuredClone(payload) as Payload;
      throw new Error("OFFLINE_RESPONSES_CAPTURE");
    },
  }).result();
  expect(raw, "must reach the installed Pi serializer before network").toBeDefined();
  expect(result.errorMessage).toContain("OFFLINE_RESPONSES_CAPTURE");
  expect(payloadAfterCompat).toEqual(raw);
  expect(context).toEqual(contextBefore);
  expect(model).toEqual(modelBefore);
  return { raw, final };
}

const legacyModels = () => MODEL_IDS.map(id => ({
  id, api: "openai-responses", context: 1_000_000, maxOutput: 384_000,
  reasoning: true, xhigh: true, thinkingLevels: LEVELS, defaultThinkingLevel: "high",
}));

describe("DeepSeek Responses through ModelManager and the installed Pi serializer", () => {
  it.each([
    { name: "default", config: {} },
    { name: "bare IDs", config: { models: MODEL_IDS } },
    { name: "explicit seed", config: { seed_default_models: true } },
    { name: "legacy full objects without a map", config: { models: legacyModels() } },
    { name: "builtin provider with a custom endpoint", config: { base_url: ENDPOINTS[1] } },
  ])("preserves off/low/high/max for $name", async ({ name, config }) => {
    const { manager, models } = await loadProvider(config);
    expect(models.map(model => model.id).sort()).toEqual([...MODEL_IDS].sort());
    const saved = structuredClone(manager.providerRegistry.getAllProvidersRaw()[PROVIDER]);
    for (const model of models) {
      for (const level of LEVELS) {
        const { raw, final } = await capture(manager, model, level);
        expect.soft(raw.reasoning?.effort, `${model.id}/${level} before compat`).toBe(level === "off" ? "none" : level);
        expect.soft(final.reasoning?.effort, `${model.id}/${level} after compat`).toBe(level === "off" ? "none" : level);
        expect(final.max_output_tokens).toBe(65_536);
      }
      if (name.includes("custom endpoint")) expect(model.baseUrl).toBe(ENDPOINTS[1]);
      if (name.startsWith("legacy")) {
        expect(model).toMatchObject({ contextWindow: 1_000_000, maxTokens: 384_000 });
      }
      expect(model.thinkingLevelMap).toEqual({ xhigh: "max" });
    }
    if (name === "explicit seed") {
      expect(saved.models).toEqual(manager.providerRegistry.getDefaultModelEntries(PROVIDER));
    } else if (name === "default" || name.includes("custom endpoint")) {
      expect(saved).not.toHaveProperty("models");
    }
    await manager.refreshAvailable();
    expect(manager.providerRegistry.getAllProvidersRaw()[PROVIDER]).toEqual(saved);
  });

  it("keeps provider defaults and provider-specific bare-ID metadata consistent", () => {
    const entries = new ProviderRegistry(home).getDefaultModelEntries(PROVIDER);
    expect(entries.map(model => model.id)).toEqual(MODEL_IDS);
    for (const model of entries) {
      expect(model.thinkingLevelMap).toEqual({ xhigh: "max" });
      expect(lookupKnownProvider(PROVIDER, model.id).thinkingLevelMap).toEqual(model.thinkingLevelMap);
    }
  });

  it.each([
    { name: "explicit max", map: { off: "none", low: "low", high: "high", xhigh: "max" }, efforts: ["none", "low", "high", "max"] },
    { name: "custom low/high/max", map: { low: "high", high: "low", xhigh: "high" }, efforts: ["none", "high", "low", "high"] },
    { name: "explicit wire xhigh", map: { xhigh: "xhigh" }, efforts: ["none", "low", "high", "xhigh"] },
    { name: "partial map", map: { low: "low" }, efforts: ["none", "low", "high", "high"] },
    { name: "disabled xhigh", map: { xhigh: null }, efforts: ["none", "low", "high", "high"] },
    { name: "empty map", map: {}, efforts: ["none", "low", "high", "high"] },
  ])("respects the whole user map: $name", async ({ map, efforts }) => {
    for (const base_url of ENDPOINTS) {
      const { manager, models } = await loadProvider({ base_url, models: legacyModels().map(model => ({
        ...model, maxOutput: 8192, thinkingLevelMap: map,
      })) });
      expect(models).toHaveLength(2);
      for (const model of models) {
        expect(model.baseUrl).toBe(base_url);
        expect(model.thinkingLevelMap).toEqual(map);
        for (const [index, level] of LEVELS.entries()) {
          const { raw, final } = await capture(manager, model, level);
          expect(raw.reasoning?.effort).toBe(efforts[index]);
          expect(final.reasoning?.effort).toBe(efforts[index]);
          expect(final.max_output_tokens).toBe(8192);
        }
      }
    }
  });

  it("keeps an explicitly empty model selection disabled", async () => {
    const { manager, models } = await loadProvider({ models: [] });
    expect(models).toEqual([]);
    expect(manager.providerRegistry.getChatModelSelection(PROVIDER).selectionMode).toBe("disabled");
    expect(manager.providerRegistry.getAllProvidersRaw()[PROVIDER].models).toEqual([]);
  });

  it.each(ENDPOINTS)("does not infer a custom provider map from model IDs or endpoint %s", async base_url => {
    const { manager, models } = await loadProvider({
      base_url, api: "openai-responses", models: legacyModels(),
    }, "custom-responses-proxy");
    expect(models).toHaveLength(2);
    for (const model of models) {
      expect(model.baseUrl).toBe(base_url);
      expect(model.thinkingLevelMap).toBeUndefined();
      const { raw, final } = await capture(manager, model, "max");
      expect(raw.reasoning?.effort).toBe("high");
      expect(final.reasoning?.effort).toBe("high");
    }
  });

  it.each(MODEL_IDS)("preserves reasoning/tool history and output budgets for %s", async id => {
    const { manager, models } = await loadProvider();
    const model = models.find(item => item.id === id);
    expect(model).toBeDefined();
    const item = { type: "reasoning", id: "rs_offline", status: "completed",
      content: [{ type: "reasoning_text", text: "Use the synthetic weather tool." }], summary: [] };
    const context: RuntimeContext = {
      messages: [
        { role: "user", content: "Weather?", timestamp: 1 },
        { role: "assistant", api: model.api, provider: model.provider, model: model.id,
          stopReason: "toolUse", timestamp: 2,
          usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          content: [
            { type: "thinking", thinking: "Use the synthetic weather tool.", thinkingSignature: JSON.stringify(item) },
            { type: "toolCall", id: "call_offline|fc_offline", name: "weather", arguments: {} },
          ] },
        { role: "toolResult", toolCallId: "call_offline|fc_offline", toolName: "weather",
          content: [{ type: "text", text: "sunny" }], isError: false, timestamp: 3 },
      ],
      tools: [{ name: "weather", description: "Offline synthetic fixture", parameters: Type.Object({}) }],
    };
    for (const scenario of [
      { level: "high", cap: 65_536 },
      { level: "max", cap: 65_536 },
      { level: "max", maxTokens: 4096, outputBudgetSource: "user", cap: 4096 },
      { level: "max", maxTokens: 100_000, outputBudgetSource: "user", cap: 100_000 },
      { level: "off", maxTokens: 512, mode: "utility", cap: 512 },
    ]) {
      const { final } = await capture(manager, model, scenario.level, { context, ...scenario });
      expect(final.reasoning?.effort).toBe(scenario.level === "off" ? "none" : scenario.level);
      expect(final.max_output_tokens).toBe(scenario.cap);
      expect(final.input.find(entry => entry.type === "reasoning")).toEqual(item);
      expect(final.input).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "function_call", call_id: "call_offline", name: "weather", arguments: "{}" }),
        expect.objectContaining({ type: "function_call_output", call_id: "call_offline", output: "sunny" }),
      ]));
    }
  });
});
