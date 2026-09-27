import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProviderRegistry } from "../core/provider-registry.ts";
import { syncModels } from "../core/model-sync.ts";
import { normalizeProviderPayload } from "../core/provider-compat.ts";
import { getReasoningProfile, resolveModelAudioInputTransport, resolveModelVideoInputTransport } from "../shared/model-capabilities.ts";
import { lookupKnownProvider, lookupKnown } from "../shared/known-models.ts";
import { callText } from "../core/llm-client.ts";
import { completeSimple } from "../lib/pi-sdk/index.ts";

let home: string;
let registry: ProviderRegistry;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "hana-current-model-catalog-"));
  registry = new ProviderRegistry(home);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

function project(provider: string, id: string) {
  const entry = registry.get(provider);
  const modelsJsonPath = path.join(home, "models.json");
  syncModels({
    [provider]: {
      base_url: entry.baseUrl, api: entry.api, api_key: "test-not-a-real-key", models: [id],
    },
  }, { modelsJsonPath });
  const config = JSON.parse(fs.readFileSync(modelsJsonPath, "utf8")).providers[provider];
  return { provider, api: config.api, baseUrl: config.baseUrl, ...config.models[0] };
}

function runtimeModel(provider: string, id: string) {
  return { ...project(provider, id), ...lookupKnownProvider(provider, id) };
}

const toolMessages = () => [
  { role: "user", content: "Check the weather." },
  { role: "assistant", content: [
    { type: "thinking", thinking: "Use the weather tool.", thinkingSignature: "reasoning_content" },
  ], tool_calls: [{ id: "weather_1", type: "function", function: { name: "weather", arguments: "{}" } }] },
  { role: "tool", tool_call_id: "weather_1", content: "sunny" },
];

describe("official model catalog refreshed 2026-09-27", () => {
  it("offers the current DeepSeek models through both protocols, with Flash vision", () => {
    for (const provider of ["deepseek", "deepseek-responses"]) {
      expect(registry.getDefaultModels(provider)).toEqual(["deepseek-flash", "deepseek-v4-pro"]);
      const flash = project(provider, "deepseek-flash");
      expect(flash).toMatchObject({ contextWindow: 1000000, maxTokens: 384000, input: ["text", "image"] });
      expect(getReasoningProfile(flash)).toBe(provider === "deepseek" ? "deepseek-v4-openai" : "deepseek-v4-responses");
    }
    expect(lookupKnown("deepseek", "deepseek-v4-flash").image).toBe(true);
    expect(lookupKnown("unknown-proxy", "deepseek-v4-flash").image).toBe(false);
  });

  it.each([
    ["anthropic", "claude-opus-5-5"], ["anthropic", "claude-fable-5-1"],
    ["openai", "gpt-6-sol"], ["openai-codex-oauth", "gpt-6-luna"],
    ["dashscope", "qwen3.8-max"], ["dashscope-coding", "qwen3.7-plus"],
    ["gemini", "gemini-3.8-flash"], ["moonshot", "kimi-k3"],
    ["zhipu", "glm-5.3"], ["zhipu-coding", "glm-5.3"], ["opencode-go", "glm-5.3"],
    ["mimo", "mimo-v2.6-pro"], ["mimo-token-plan", "mimo-v2.6-flash"],
    ["groq", "openai/gpt-oss-120b"], ["xai", "grok-4.7"],
    ["agnes", "agnes-2.5-flash"], ["stepfun", "step-3.7-flash"],
  ])("projects the current %s / %s default with provider metadata", (provider, id) => {
    expect(registry.getDefaultModels(provider)).toContain(id);
    expect(lookupKnownProvider(provider, id)).not.toBeNull();
    expect(project(provider, id)).toMatchObject({ id });
  });

  it.each([
    ["anthropic", ["claude-opus-4-1", "claude-sonnet-4-20250514", "claude-3-7-sonnet", "claude-3-5-haiku"]],
    ["moonshot", ["moonshot-v1-128k", "moonshot-v1-32k", "moonshot-v1-8k", "kimi-k2.5"]],
    ["gemini", ["gemini-3-pro-preview"]],
    ["groq", ["mixtral-8x7b-32768", "llama-3.1-8b-instant", "llama-3.3-70b-versatile"]],
    ["mimo", ["mimo-v2-pro", "mimo-v2-flash", "mimo-v2-omni", "mimo-v2-tts"]],
    ["openai-codex-oauth", ["gpt-5.4", "gpt-5.4-mini"]],
  ])("excludes retired or restricted %s models from new defaults", (provider, retired) => {
    const defaults = registry.getDefaultModels(provider);
    for (const id of retired) expect(defaults).not.toContain(id);
  });

  it("keeps explicit user selections, opt-outs and proxy models intact", () => {
    registry.saveProvider("deepseek", { api_key: "test", models: ["deepseek-v4-flash"] });
    expect(registry.getChatModelSelection("deepseek").models).toEqual(["deepseek-v4-flash"]);
    expect(registry.getChatDiscoverableModelEntries("deepseek")).toContain("deepseek-flash");
    registry.saveProvider("deepseek", { models: [] });
    expect(registry.getChatModelSelection("deepseek").models).toEqual([]);
    const proxy = { provider: "custom", id: "deepseek-flash", api: "openai-completions",
      baseUrl: "https://proxy.example/v1", reasoning: true };
    expect(getReasoningProfile(proxy)).toBeNull();
    expect(lookupKnownProvider("custom", "gpt-6-sol")).toBeNull();
  });

  it("keeps API and Codex OAuth context and wire contracts separate", () => {
    expect(project("openai", "gpt-6-sol")).toMatchObject({ api: "openai-responses", contextWindow: 1050000 });
    expect(project("openai-codex-oauth", "gpt-6-sol")).toMatchObject({ api: "openai-codex-responses", contextWindow: 272000 });
    expect(project("gemini", "gemini-3.8-flash").thinkingLevelMap).toMatchObject({ off: null, minimal: null, low: "low" });
    expect(project("dashscope", "qwen3.6-max-preview").contextWindow).toBe(256000);
    expect(project("dashscope", "qwen3.6-flash").contextWindow).toBe(1000000);
    expect(project("dashscope", "qwen3.5-flash").contextWindow).toBe(1000000);
  });

  it("uses each hosted DeepSeek endpoint's documented thinking switch", () => {
    const messages = [{ role: "user", content: "hello" }];
    for (const id of ["deepseek-v4-pro-0813", "deepseek-v4-flash-0731"]) {
      const result = normalizeProviderPayload({ messages }, runtimeModel("infini", id), { mode: "utility" });
      expect(result.thinking).toEqual({ type: "disabled" });
    }
    for (const id of ["deepseek-ai/DeepSeek-V4-Pro", "deepseek-ai/DeepSeek-V4-Flash"]) {
      const result = normalizeProviderPayload({ messages }, runtimeModel("siliconflow", id), { mode: "utility" });
      expect(result.enable_thinking).toBe(false);
      expect(result).not.toHaveProperty("thinking");
    }
  });
});

describe("current model request contracts", () => {
  it.each([
    ["openai", "gpt-6-sol", "xhigh", { reasoning: { effort: "max" } }],
    ["openai-codex-oauth", "gpt-6-sol", "xhigh", { reasoning: { effort: "max" } }],
    ["xai", "grok-4.7", "xhigh", { reasoning: { effort: "xhigh" } }],
    ["gemini", "gemini-3.8-flash", "off", { config: { thinkingConfig: { thinkingLevel: "LOW" } } }],
    ["anthropic", "claude-opus-5-5", "high", { thinking: { type: "adaptive" } }],
    ["mimo", "mimo-v2.6-pro", "high", { thinking: { type: "enabled" } }],
    ["deepseek", "deepseek-flash", "xhigh", { thinking: { type: "enabled" }, reasoning_effort: "max" }],
    ["moonshot", "kimi-k3", "xhigh", { reasoning_effort: "max" }],
  ] as const)("serializes %s / %s through the installed SDK without network access", async (provider, id, reasoning, expected) => {
    const model = runtimeModel(provider, id);
    model.maxTokens ||= 8192;
    model.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network request"));
    const jwt = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } })).toString("base64url");
    let captured: unknown;
    await completeSimple(model, { messages: [{ role: "user", content: "hello", timestamp: 1 }] }, {
      apiKey: provider === "openai-codex-oauth" ? `header.${jwt}.signature` : "test-not-a-real-key",
      reasoning: reasoning === "off" ? undefined : reasoning,
      onPayload(payload) {
        captured = normalizeProviderPayload(payload, model, { mode: "chat", reasoningLevel: reasoning });
        // Abort after real SDK serialization, before sending any request.
        throw new Error("Payload captured");
      },
    });
    expect(captured).toMatchObject(expected);
    if (id === "kimi-k3") expect(captured).not.toHaveProperty("thinking");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("replays real tool reasoning for the new DeepSeek Flash alias", () => {
    const model = runtimeModel("deepseek", "deepseek-flash");
    const result = normalizeProviderPayload({ model: model.id, messages: toolMessages() }, model, { mode: "chat", reasoningLevel: "max" });
    expect(result).toMatchObject({ thinking: { type: "enabled" }, reasoning_effort: "max" });
    expect(result.messages[1].reasoning_content).toBe("Use the weather tool.");
    expect(() => normalizeProviderPayload({ messages: toolMessages().map(m => m.role === "assistant" ? { ...m, content: "" } : m) }, model, { reasoningLevel: "high" })).toThrow(/reasoning_content/);
  });

  it.each([["moonshot", "kimi-k3"], ["zhipu", "glm-5.3"], ["zhipu-coding", "glm-5.3"], ["opencode-go", "glm-5.3"]])(
    "%s / %s keeps thinking enabled with low effort for utility and off requests", (provider, id) => {
      const model = runtimeModel(provider, id);
      for (const options of [{ mode: "utility", reasoningLevel: "off" }, { mode: "chat", reasoningLevel: "off" }]) {
        const payload = { messages: toolMessages(), thinking: { type: "disabled" }, reasoning_effort: "none", temperature: 0.2, top_p: 0.7 };
        const result = normalizeProviderPayload(payload, model, options);
        expect(result.reasoning_effort).toBe("low");
        if (id === "kimi-k3") expect(result).not.toHaveProperty("thinking");
        else expect(result.thinking.type).toBe("enabled");
        expect(result.messages[1].reasoning_content).toBe("Use the weather tool.");
        expect(payload.thinking.type).toBe("disabled");
        if (provider === "moonshot") {
          expect(result).not.toHaveProperty("temperature");
          expect(result).not.toHaveProperty("top_p");
        }
        if (provider === "opencode-go") expect(result.thinking).not.toHaveProperty("clear_thinking");
      }
      expect(() => normalizeProviderPayload({ messages: toolMessages().map(m => m.role === "assistant" ? { ...m, content: "" } : m) }, model, { mode: "utility" })).toThrow(/reasoning_content/);
    },
  );

  it.each(["kimi-k2.7-code", "kimi-k2.7-code-highspeed"])("%s uses max_tokens and omits unsupported effort and sampling fields", id => {
    const model = runtimeModel("moonshot", id);
    const result = normalizeProviderPayload({ messages: [{ role: "user", content: "Hello" }], max_completion_tokens: 512, reasoning_effort: "max", temperature: 0.2 }, model, { mode: "utility" });
    expect(result).toMatchObject({ thinking: { type: "enabled" }, max_tokens: 512 });
    for (const key of ["max_completion_tokens", "temperature", "reasoning_effort"]) expect(result).not.toHaveProperty(key);
  });

  it.each(["mimo", "mimo-token-plan"])("%s V2.6 uses the current top-level thinking and output fields", provider => {
    const model = runtimeModel(provider, "mimo-v2.6-pro");
    const payload = { messages: toolMessages(), max_tokens: 4096, chat_template_kwargs: { enable_thinking: true, preserve_thinking: true } };
    const result = normalizeProviderPayload(payload, model, { mode: "chat", reasoningLevel: "high" });
    expect(result).toMatchObject({ thinking: { type: "enabled" }, max_completion_tokens: 4096 });
    expect(result).not.toHaveProperty("chat_template_kwargs");
    expect(result).not.toHaveProperty("max_tokens");
    expect(result.messages[1].reasoning_content).toBe("Use the weather tool.");
    expect(project(provider, "mimo-v2.6-pro").input).toEqual(["text", "image"]);
    expect(resolveModelAudioInputTransport(model)).toBe("mimo-input-audio");
    expect(resolveModelVideoInputTransport(model)).toBe("openai-video-url");
    const utility = normalizeProviderPayload(payload, model, { mode: "utility" });
    expect(utility.thinking).toEqual({ type: "disabled" });
    expect(utility.messages[1]).not.toHaveProperty("reasoning_content");
  });

  it.each([
    ["deepseek", "deepseek-flash", "disabled"],
    ["moonshot", "kimi-k3", "omitted"],
    ["moonshot", "kimi-k2.7-code", "enabled"],
    ["zhipu", "glm-5.3", "enabled"],
    ["mimo", "mimo-v2.6-pro", "disabled"],
  ])("sends the current %s / %s contract through the real utility client", async (provider, id, thinkingType) => {
    const model = runtimeModel(provider, id);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: "ok" } }],
    }), { status: 200 }));
    expect(await callText({ api: model.api, baseUrl: model.baseUrl, apiKey: "test-not-a-real-key", model,
      messages: [{ role: "user", content: "hello" }], maxTokens: 512, timeoutMs: 5000 })).toBe("ok");
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(`${model.baseUrl.replace(/\/$/, "")}/chat/completions`);
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe(id);
    if (thinkingType === "omitted") expect(body).not.toHaveProperty("thinking");
    else expect(body.thinking.type).toBe(thinkingType);
    if (id === "kimi-k3" || id === "glm-5.3") expect(body.reasoning_effort).toBe("low");
    if (id === "kimi-k2.7-code") expect(body).not.toHaveProperty("reasoning_effort");
  });
});
