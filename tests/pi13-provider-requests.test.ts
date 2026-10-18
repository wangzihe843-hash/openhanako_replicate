import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage, createModelRegistry, getPiModel, Type } from "../lib/pi-sdk/index.ts";
import { getModelRuntime } from "../lib/pi-sdk/model-runtime.ts";
import { syncModels } from "../core/model-sync.ts";
import { ModelManager } from "../core/model-manager.ts";
import { ProviderRegistry } from "../core/provider-registry.ts";
import { normalizeProviderPayload } from "../core/provider-compat.ts";
import { opencodeGoPlugin } from "../lib/providers/opencode-go.ts";
import { kimiProjectionCases } from "./fixtures/kimi-context-cases.ts";
import { opencodePlugin } from "../lib/providers/opencode.ts";

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
async function fixture(provider: string, base: string, models: unknown[], api: string, config = {}, syncOptions = {}) {
  // Any request outside the explicit mock fails closed; no real credentials.
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected network request"); }));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-pi13-provider-")); dirs.push(dir);
  const file = path.join(dir, "models.json");
  const configuredProvider = { ...config, base_url: base, api, api_key: "synthetic-only", models };
  syncModels({ [provider]: configuredProvider }, { ...syncOptions, modelsJsonPath: file });
  const projection = JSON.parse(fs.readFileSync(file, "utf8")).providers[provider];
  const auth = AuthStorage.inMemory();
  await auth.setRuntimeApiKey(provider, "synthetic-only");
  const registry = await createModelRegistry(auth, file);
  return { registry, runtime: getModelRuntime(registry), projection, configuredProvider, dir };
}
async function capture(runtime, model, headers = {}, context = {}, options = {}) {
  const requests: Request[] = [];
  const fetchMock = async (input, init) => {
    requests.push(new Request(input, init));
    return new Response(JSON.stringify({ error: { message: "Synthetic request captured" } }), {
      status: 400, headers: { "content-type": "application/json" },
    });
  };
  // Google accepts the global fetch implementation, not a distinct override.
  vi.stubGlobal("fetch", fetchMock);
  const output = await runtime.streamSimple(model, {
    messages: [{ role: "user", content: [{ type: "text", text: "normal compatibility request" }], timestamp: 1 }],
    ...context,
  }, {
    ...options,
    sessionId: "synthetic-session", maxRetries: 0, headers,
    fetch: fetchMock,
  }).result();
  expect(output.stopReason).toBe("error");
  expect(requests).toHaveLength(1);
  return requests[0];
}

describe("Pi 1.3 normal provider mock requests", () => {
  it.each([
    ["opencode", "gpt-5.4", "openai-responses", "/v1/responses"],
    ["opencode", "minimax-m3", "openai-completions", "/v1/chat/completions"],
    ["opencode", "claude-sonnet-4-6", "anthropic-messages", "/v1/messages?beta=true"],
    ["opencode", "gemini-3.1-pro", "google-generative-ai", "/v1/models/gemini-3.1-pro:streamGenerateContent?alt=sse"],
    ["opencode-go", "glm-5.3", "openai-completions", "/go/v1/chat/completions"],
    ["opencode-go", "minimax-m3", "anthropic-messages", "/go/v1/messages?beta=true"],
  ])("projects and dispatches %s/%s through %s", async (provider, id, api, suffix) => {
    const plugin = provider === "opencode-go" ? opencodeGoPlugin : opencodePlugin;
    const { registry, runtime } = await fixture(provider, `https://opencode.ai/zen${provider === "opencode-go" ? "/go/v1" : ""}`, [id], plugin.defaultApi);
    const model = registry.find(provider, id)!;
    expect(model.api).toBe(api);
    const request = await capture(runtime, model);
    expect(request.url).toBe(`https://opencode.ai/inference${suffix}`);
    expect(request.headers.get("x-opencode-session")).toBe("synthetic-session");
    const custom = await capture(runtime, model, { "X-OpenCode-Session": "explicit-session" });
    expect(custom.headers.get("x-opencode-session")).toBe("explicit-session");
  });

  it.each([
    [opencodeGoPlugin.defaultBaseUrl, "https://opencode.ai/inference/go/v1"],
    ["https://opencode.ai/zen/go/v1", "https://opencode.ai/inference/go/v1"],
    ["https://opencode.ai/inference/go", "https://opencode.ai/inference/go/v1"],
    ["https://opencode.ai/inference/go/v1/", "https://opencode.ai/inference/go/v1"],
    ["https://gateway.example/custom/v1", "https://gateway.example/custom/v1"],
    ["https://gateway.example/custom/v1/", "https://gateway.example/custom/v1"],
    ["https://gateway.example/custom", "https://gateway.example/custom"],
    ["https://gateway.example/v1/tenant/v1/", "https://gateway.example/v1/tenant/v1"],
  ])("dispatches mixed Go protocols using real defaults at %s", async (base, completionsBase) => {
    const { id: provider, defaultApi } = opencodeGoPlugin;
    const { registry, runtime } = await fixture(provider, base, ["minimax-m3", "glm-5.3"], defaultApi);
    const anthropic = registry.find(provider, "minimax-m3")!;
    const completions = registry.find(provider, "glm-5.3")!;
    expect(anthropic.api).toBe("anthropic-messages");
    expect(completions.api).toBe("openai-completions");
    const anthropicRequest = await capture(runtime, anthropic);
    const completionsRequest = await capture(runtime, completions);
    // Only the terminal version belongs to the SDK; embedded gateway paths survive.
    const anthropicRoot = completionsBase.replace(/\/v1$/, "");
    expect(anthropicRequest.url).toBe(`${anthropicRoot}/v1/messages?beta=true`);
    expect(completionsRequest.url).toBe(`${completionsBase}/chat/completions`);
    for (const request of [anthropicRequest, completionsRequest]) {
      expect(request.headers.get("x-opencode-session")).toBe("synthetic-session");
    }
  });

  it("preserves explicit Go model and gateway overrides when model URL differs", async () => {
    const { id: provider, defaultApi } = opencodeGoPlugin;
    const { registry, runtime } = await fixture(provider, "https://gateway.example/custom/v1", [{
      id: "minimax-m3", name: "My MiniMax", context: 123456, image: false,
      maxOutput: 4096, reasoning: false,
    }], defaultApi, { headers: { "x-gateway-override": "gateway-value" } }, {
      chatProjectionPlans: {
        [provider]: { modelExecutionHeaders: { "minimax-m3": { "x-model-override": "model-value" } } },
      },
    });
    const model = registry.find(provider, "minimax-m3")!;
    expect(model).toMatchObject({
      name: "My MiniMax", api: "anthropic-messages", contextWindow: 123456,
      input: ["text"], maxTokens: 4096, reasoning: false,
    });
    const request = await capture(runtime, model, { "X-OpenCode-Session": "explicit-session" });
    expect(request.url).toBe("https://gateway.example/custom/v1/messages?beta=true");
    expect(request.headers.get("x-opencode-session")).toBe("explicit-session");
    expect(request.headers.get("x-model-override")).toBe("model-value");
    expect(request.headers.get("x-gateway-override")).toBe("gateway-value");
  });

  it("preserves legacy Go native tool and output declarations while applying Hana payload policy", async () => {
    const { registry, runtime, projection } = await fixture("opencode-go", "https://opencode.ai/zen/go/v1", [{
      id: "glm-5.3", context: 123456, contextWindow: 234567, maxOutput: 4096, reasoning: false,
    }], "anthropic-messages");
    const model = registry.find("opencode-go", "glm-5.3")!;
    const nativeCompat = getPiModel("opencode-go", "glm-5.3")!.compat;
    expect(nativeCompat).toMatchObject({ maxTokensField: "max_tokens", supportsStrictMode: true,
      supportsStore: false, supportsDeveloperRole: false });
    expect(projection.models[0].compat).toMatchObject(nativeCompat);
    expect(model).toMatchObject({ api: "openai-completions", contextWindow: 234567, maxTokens: 4096,
      baseUrl: "https://opencode.ai/inference/go/v1", compat: nativeCompat });
    const context = { tools: [{ name: "normal_lookup", description: "Normal mock lookup",
      parameters: Type.Object({ query: Type.String() }),
      constrainedSampling: { type: "json_schema", strict: "prefer" },
    }] };
    const rawRequest = await capture(runtime, model, {}, context, { maxTokens: 4096 });
    const rawBody = await rawRequest.json();
    expect(rawBody.max_tokens).toBe(4096);
    expect(rawBody).not.toHaveProperty("max_completion_tokens");
    expect(rawBody).not.toHaveProperty("store");
    expect(rawBody.tools[0].function).toMatchObject({ name: "normal_lookup", strict: true });

    const hanaRequest = await capture(runtime, model, {}, context, {
      maxTokens: 4096,
      onPayload: payload => normalizeProviderPayload(payload, model, { reasoningLevel: "off" }),
    });
    const hanaBody = await hanaRequest.json();
    for (const request of [rawRequest, hanaRequest]) {
      expect(request.url).toBe("https://opencode.ai/inference/go/v1/chat/completions");
      expect(request.headers.get("x-opencode-session")).toBe("synthetic-session");
    }
    expect(hanaBody.max_tokens).toBe(4096);
    expect(hanaBody).not.toHaveProperty("max_completion_tokens");
    expect(hanaBody).not.toHaveProperty("store");
    expect(hanaBody.tools[0].function.name).toBe("normal_lookup");
    expect(hanaBody.tools[0].function).not.toHaveProperty("strict");
    expect(model.compat).toMatchObject(nativeCompat);
  });

  it.each(["https://api.kimi.com/coding", "https://api.kimi.com/coding/v1", "https://gateway.example/custom/v1"])(
    "sends a valid Kimi tool contract and reads reasoning via %s", async base => {
      const { registry, runtime } = await fixture("kimi-coding", base, [{
        id: "kimi-for-coding", api: "openai-completions", image: false, context: 123456,
      }], "openai-completions");
      const model = registry.find("kimi-coding", "kimi-for-coding")!;
      expect(model.api).toBe("openai-completions");
      expect(model.contextWindow).toBe(123456);
      expect(model.input).toEqual(["text"]);
      let request: Request;
      const output = await runtime.streamSimple(model, {
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 }],
        tools: [{ name: "normal_lookup", description: "Normal mock lookup", parameters: Type.Object({ query: Type.String() }) }],
      }, {
        maxRetries: 0, reasoning: "high",
        fetch: async (input, init) => {
          request = new Request(input, init);
          const chunks = [
            { choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "synthetic reasoning" }, finish_reason: null }] },
            { choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }] },
            { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
          ];
          return new Response(chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", {
            headers: { "content-type": "text/event-stream" },
          });
        },
      }).result();
      expect(request!.url).toBe(base.includes("api.kimi.com")
        ? "https://api.kimi.com/coding/v1/chat/completions" : `${base}/chat/completions`);
      const body = await request!.json();
      expect(body.tools[0].function).toMatchObject({ name: "normal_lookup", parameters: { properties: { query: { type: "string" } } } });
      expect(output.stopReason).toBe("stop");
      expect(output.content).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "thinking", thinking: "synthetic reasoning" }),
        expect.objectContaining({ type: "text", text: "hello" }),
      ]));
    });
});


describe("Kimi legacy budget and wire contracts against the installed SDK", () => {
  it.each(kimiProjectionCases.filter(c => ["com", "ai", "proxy"].includes(c.label)))(
    "dispatches once for $label/$api/$modelApi with bare, single and conflicting budgets", async c => {
      for (const budget of [undefined, { context: 123456 }, { contextWindow: 234567 }, { context: 123456, contextWindow: 234567 }]) {
        const entry = !budget && !c.modelApi ? "kimi-for-coding"
          : { id: "kimi-for-coding", ...budget, ...(c.modelApi ? { api: c.modelApi } : {}) };
        const { registry, runtime } = await fixture("kimi-coding", c.base_url!, [entry], c.api);
        const model = registry.find("kimi-coding", "kimi-for-coding")!;
        const wireApi = c.label === "com" ? "openai-completions" : c.modelApi || c.api || "openai-completions";
        expect(model.api).toBe(wireApi);
        expect(model.contextWindow).toBe(c.builtin
          ? budget?.contextWindow ?? budget?.context ?? c.expected
          : budget?.context ?? budget?.contextWindow ?? c.expected);
        expect(model.maxTokens).toBe(32768);
        if (wireApi === "anthropic-messages") {
          expect(model.compat).toMatchObject({ allowEmptySignature: true, forceAdaptiveThinking: true });
          expect(model.compat).not.toHaveProperty("requiresReasoningContentOnAssistantMessages");
          expect(model.compat).not.toHaveProperty("supportsReasoningEffort");
        }
        const request = await capture(runtime, model);
        expect(request.url).toBe(wireApi === "anthropic-messages"
          ? `${c.base_url!.replace(/\/v1$/, "")}/v1/messages?beta=true`
          : `${c.base_url}/chat/completions`);
        const body = await request.json();
        expect(body.model).toBe("kimi-for-coding");
        expect(body.messages).toHaveLength(1);
      }
    });

  it.each(["https://api.kimi.ai/coding/v1", "https://proxy.example/coding/v1"])(
    "retains legacy K3 metadata and explicit capabilities at %s", async base => {
      const { registry, runtime, projection, configuredProvider, dir } = await fixture("kimi-coding", base, ["k3", {
        id: "kimi-for-coding", name: "My Kimi", context: 123456, contextWindow: 234567,
        image: false, reasoning: false, maxOutput: 4096, defaultThinkingLevel: "off",
        compat: { outputCapField: "max_tokens" },
      }], "anthropic-messages", { headers: { "x-priority": "provider" } }, {
        chatProjectionPlans: { "kimi-coding": { modelExecutionHeaders: { "kimi-for-coding": { "x-model": "model", "x-execution": "execution", "X-Priority": "model" } } } },
      });
      const inputLimits = { images: { resize: { maxWidth: 2000, maxHeight: 2000, maxBytes: 4718592, jpegQuality: 80 } } };
      const nativeFields = { name: "My Kimi", contextWindow: 234567, maxTokens: 4096, input: ["text"],
        reasoning: false, compat: { outputCapField: "max_tokens" },
        cost: { input: 0.95, output: 4, cacheRead: 0.19, cacheWrite: 0 }, inputLimits };
      expect(projection.models.find(entry => entry.id === "kimi-for-coding")).toMatchObject({
        ...nativeFields, defaultThinkingLevel: "off",
      });
      const k3 = registry.find("kimi-coding", "k3")!;
      expect(k3).toMatchObject({ api: "anthropic-messages", contextWindow: 1048576, maxTokens: 131072,
        input: ["text", "image"], cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 }, inputLimits });
      const k3Request = await capture(runtime, k3);
      expect(k3Request.url).toBe(`${base.replace(/\/v1$/, "")}/v1/messages?beta=true`);
      expect(k3Request.headers.get("x-priority")).toBe("provider");
      const model = registry.find("kimi-coding", "kimi-for-coding")!;
      expect(model).toMatchObject({ ...nativeFields, api: "anthropic-messages", baseUrl: base.replace(/\/v1$/, "") });
      // The SDK Model schema does not carry Hana's thinking default.
      expect(model).not.toHaveProperty("defaultThinkingLevel");
      for (const key of ["supportsReasoningEffort", "requiresReasoningContentOnAssistantMessages", "maxTokensField", "supportsStrictMode"]) {
        expect(model.compat).not.toHaveProperty(key);
      }
      const managerHome = path.join(dir, "hana");
      fs.mkdirSync(managerHome, { recursive: true });
      new ProviderRegistry(managerHome).saveProvider("kimi-coding", configuredProvider);
      const manager = new ModelManager({ hanakoHome: managerHome });
      await manager.init();
      await manager.refreshAvailable();
      expect(manager.modelRegistry.getError()).toBeUndefined();
      const effectiveModel = manager.availableModels.find(entry => entry.provider === "kimi-coding" && entry.id === "kimi-for-coding");
      expect(effectiveModel).toMatchObject({ ...nativeFields, defaultThinkingLevel: "off" });
      expect(manager.resolveExecutionModel("kimi-coding/kimi-for-coding")).toBe(effectiveModel);
      expect((await manager.resolveModelWithCredentialsFresh("kimi-coding/kimi-for-coding")).model).toMatchObject({
        ...nativeFields, defaultThinkingLevel: "off",
      });
      expect(manager.getModelDefaultThinkingLevel("kimi-coding/kimi-for-coding")).toBe("off");
      expect((await capture(runtime, model)).headers.get("x-priority")).toBe("model");
      const request = await capture(runtime, model, { "x-priority": "session" });
      expect(request.headers.get("x-priority")).toBe("session");
      expect(request.headers.get("x-model")).toBe("model");
      expect(request.headers.get("x-execution")).toBe("execution");
      const body = await request.json();
      expect(body.max_tokens).toBe(4096);
      expect(body.thinking).toBeUndefined();
    });
});
