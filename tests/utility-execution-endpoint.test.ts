import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ExecutionRouter } from "../core/execution-router.ts";
import { ModelManager } from "../core/model-manager.ts";
import { ProviderRegistry } from "../core/provider-registry.ts";
import { syncModels } from "../core/model-sync.ts";
import { callTextConfigFromUtilityConfig } from "../core/model-execution-config.ts";
import { callText } from "../core/llm-client.ts";

const credential = (baseUrl = "https://catalog.invalid/raw") => ({
  api: "openai-completions", apiKey: "fixture-key", baseUrl, headers: {},
});
const model = (id = "small", provider = "fixture", baseUrl = "https://model.invalid/v1") => ({
  id, provider, api: "openai-completions", baseUrl,
  input: ["text"], contextWindow: 4096, reasoning: false,
});

function fixture(models, credentials = {}, registryOptions = {}) {
  const registry = {
    getCredentials: vi.fn((provider) => credentials[provider] || credential()),
    get: vi.fn(() => ({ api: "openai-completions" })),
    allowsMissingApiKey: vi.fn(() => false),
    ...registryOptions,
  };
  const fresh = vi.fn(async (provider) => credentials[provider] || credential());
  const router = new ExecutionRouter((ref) => models[ref], registry, fresh);
  const manager = Object.create(ModelManager.prototype);
  manager.executionRouter = router;
  const config = { models: { utility: "small", ...(models.large ? { utility_large: "large" } : {}) } };
  return { router, manager, registry, fresh, config };
}

async function capture(config) {
  const calls = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    calls.push({ url: String(url), headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({
      choices: [{ message: { content: "fixture" } }],
      content: [{ type: "text", text: "fixture" }],
      output: [{ type: "message", content: [{ type: "output_text", text: "fixture" }] }],
    }));
  });
  for (const role of ["utility", "utility_large"]) {
    if (!config[role]) continue;
    expect(await callText({
      ...callTextConfigFromUtilityConfig(config, role),
      messages: [{ role: "user", content: "fixture" }],
      timeoutMs: 1000,
    })).toBe("fixture");
  }
  return calls;
}

function projected(provider, baseUrl, api = "openai-completions") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "utility-endpoint-"));
  try {
    const file = path.join(dir, "models.json");
    syncModels({ [provider]: { base_url: baseUrl, api, api_key: "fixture-key", models: ["fixture-small", "fixture-large"] } }, { modelsJsonPath: file });
    const p = JSON.parse(fs.readFileSync(file, "utf8")).providers[provider];
    return Object.fromEntries(["small", "large"].map((role, index) => [role, {
      ...p.models[index], provider, api: p.models[index].api || p.api,
      baseUrl: p.models[index].baseUrl || p.baseUrl,
    }]));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

afterEach(() => vi.restoreAllMocks());

for (const method of ["resolveUtilityConfig", "resolveUtilityConfigFresh"]) {
  describe(`utility execution endpoint: ${method}`, () => {
    const resolve = (f, override = {}, options = {}) => f.manager[method](f.config, {}, override, options);

    it.each([
      ["https://api.kimi.com", "openai-completions"],
      ["https://api.kimi.com/coding/", "anthropic-messages"],
      ["https://api.kimi.com/coding/v1", "anthropic-messages"],
      ["https://api.kimi.com/coding/v1/", "anthropic-messages"],
      ["https://api.kimi.com/coding/v1/chat/completions", "openai-completions"],
    ])("retains the real Kimi projection from %s through both request roles", async (url, configuredApi) => {
      const models = projected("kimi-coding", url, configuredApi);
      expect(models.small).toMatchObject({ api: "openai-completions", baseUrl: "https://api.kimi.com/coding/v1" });
      const before = structuredClone(models);
      const cred = { ...credential(url), api: configuredApi };
      const f = fixture(models, { "kimi-coding": cred });
      const cfg = await resolve(f);
      const calls = await capture(cfg);
      expect(calls.map((c) => c.url)).toEqual(Array(2).fill("https://api.kimi.com/coding/v1/chat/completions"));
      expect([cfg.api, cfg.large_api]).toEqual(["openai-completions", "openai-completions"]);
      expect(calls.map((c) => c.headers.get("authorization"))).toEqual(Array(2).fill("Bearer fixture-key"));
      expect(models).toEqual(before);
    });

    it.each([
      ["https://gateway.invalid", "https://gateway.invalid/chat/completions"],
      ["https://gateway.invalid/team/proxy///", "https://gateway.invalid/team/proxy/chat/completions"],
      ["https://gateway.invalid/v1/", "https://gateway.invalid/v1/chat/completions"],
      ["https://gateway.invalid/v1/chat/completions", "https://gateway.invalid/v1/chat/completions"],
      ["https://api.kimi.com/custom-proxy/", "https://api.kimi.com/custom-proxy/chat/completions"],
    ])("preserves OpenAI-compatible custom paths from %s without adding v1", async (url, expected) => {
      const models = projected("fixture", url);
      const cfg = await resolve(fixture(models, { fixture: credential(url) }));
      expect((await capture(cfg)).map((c) => c.url)).toEqual([expected, expected]);
    });

    it("keeps per-model endpoints and protocols on one provider", async () => {
      const models = {
        small: model(),
        large: { ...model("large", "fixture", "https://large.invalid/api"), api: "anthropic-messages" },
      };
      const f = fixture(models);
      const cfg = await resolve(f);
      expect((await capture(cfg)).map((c) => c.url)).toEqual([
        "https://model.invalid/v1/chat/completions", "https://large.invalid/api/v1/messages",
      ]);
      expect(f.fresh.mock.calls).toEqual(method.endsWith("Fresh") ? [["fixture"]] : []);
    });

    it("resolves distinct providers independently and retains their keys", async () => {
      const f = fixture({ small: model(), large: model("large", "other", "https://other.invalid/v2") }, {
        fixture: credential(), other: { ...credential("https://other.invalid/raw"), apiKey: "fixture-other-key" },
      });
      const calls = await capture(await resolve(f));
      expect(calls.map((c) => c.url)).toEqual(["https://model.invalid/v1/chat/completions", "https://other.invalid/v2/chat/completions"]);
      expect(calls.map((c) => c.headers.get("authorization"))).toEqual(["Bearer fixture-key", "Bearer fixture-other-key"]);
      expect(f.fresh.mock.calls).toEqual(method.endsWith("Fresh") ? [["fixture"], ["other"]] : []);
    });

    it("falls back to catalog defaults only when the model has no endpoint", async () => {
      const { baseUrl: _unused, ...withoutUrl } = model();
      const f = fixture({ small: withoutUrl, large: { ...withoutUrl, id: "large", base_url: "https://snake.invalid/v2/" } });
      expect((await capture(await resolve(f))).map((c) => c.url)).toEqual([
        "https://catalog.invalid/raw/chat/completions", "https://snake.invalid/v2/chat/completions",
      ]);
    });

    it("retains dynamic OAuth URLs from the actual untagged registry interface", async () => {
      const registry = Object.create(ProviderRegistry.prototype);
      registry._loadAddedModels = () => ({});
      registry._plugins = new Map();
      registry.get = () => ({ id: "fixture", api: "openai-completions", authType: "oauth", baseUrl: "https://static.invalid/v1" });
      registry._readOAuthEntry = vi.fn(() => ({ token: "fixture-oauth", resourceUrl: "https://tenant.invalid/dynamic/", accountId: "fixture-account" }));
      const cred = registry.getCredentials("fixture");
      expect(cred).not.toHaveProperty("credentialSource");
      const models = { small: model(), large: model("large") };
      const f = fixture(models, { fixture: cred }, {
        getCredentials: registry.getCredentials.bind(registry),
        resolveChatProvider: registry.resolveChatProvider.bind(registry),
      });
      const cfg = await resolve(f);
      expect((await capture(cfg)).map((c) => c.url)).toEqual(Array(2).fill("https://tenant.invalid/dynamic/chat/completions"));
      expect([cfg.api_key, cfg.large_api_key]).toEqual(["fixture-oauth", "fixture-oauth"]);
      expect(cfg.utility.accountId).toBe("fixture-account");
    });

    it.each(["credentialSource", "credential_source"])("honors declared OAuth %s before catalog metadata", async (key) => {
      const f = fixture({ small: model(), large: model("large") }, {
        fixture: { ...credential("https://tenant.invalid/resource/"), [key]: "auth-storage" },
      }, { resolveChatProvider: () => ({ credentialSource: "provider-catalog" }) });
      expect((await capture(await resolve(f))).map((c) => c.url)).toEqual(Array(2).fill("https://tenant.invalid/resource/chat/completions"));
    });

    it("uses the legacy OAuth auth-type fallback when projection metadata is unavailable", async () => {
      const f = fixture({ small: model(), large: model("large") }, {}, { getAuthType: () => "oauth" });
      expect((await capture(await resolve(f))).map((c) => c.url)).toEqual(Array(2).fill("https://catalog.invalid/raw/chat/completions"));
    });

    it("preserves explicit same-provider overrides and skips fresh credential resolution", async () => {
      const f = fixture({ small: model(), large: model("large", "fixture", "https://large.invalid/v2") });
      const cfg = await resolve(f, { provider: "fixture", api_key: "fixture-override", base_url: "https://override.invalid/custom///" });
      const calls = await capture(cfg);
      expect(calls.map((c) => c.url)).toEqual(Array(2).fill("https://override.invalid/custom/chat/completions"));
      expect(calls.map((c) => c.headers.get("authorization"))).toEqual(Array(2).fill("Bearer fixture-override"));
      expect(f.fresh).not.toHaveBeenCalled();
      if (method.endsWith("Fresh")) expect(f.registry.getCredentials).not.toHaveBeenCalled();
    });

    it("does not pass an override to a different large-model provider", async () => {
      const f = fixture({ small: model(), large: model("large", "other", "https://other.invalid/custom") });
      const cfg = await resolve(f, { provider: "fixture", api_key: "fixture-override", base_url: "https://override.invalid/v1" });
      const calls = await capture(cfg);
      expect(calls.map((c) => c.url)).toEqual(["https://override.invalid/v1/chat/completions", "https://other.invalid/custom/chat/completions"]);
      expect(calls.map((c) => c.headers.get("authorization"))).toEqual(["Bearer fixture-override", "Bearer fixture-key"]);
      expect(f.fresh.mock.calls).toEqual(method.endsWith("Fresh") ? [["other"]] : []);
    });

    it("supports small-only calls without fabricating a large config", async () => {
      const cfg = await resolve(fixture({ small: model() }), {}, { requireUtilityLarge: false });
      expect(cfg.utility_large).toBeNull();
      expect(cfg.large_base_url).toBeNull();
      expect((await capture(cfg)).map((c) => c.url)).toEqual(["https://model.invalid/v1/chat/completions"]);
    });

    it("preserves keyless provider contracts and model metadata", async () => {
      const f = fixture({ small: model(), large: model("large") }, {
        fixture: { ...credential(), apiKey: "" },
      }, { allowsMissingApiKey: () => true });
      const cfg = await resolve(f);
      expect(cfg.utility).toMatchObject({ id: "small", contextWindow: 4096, input: ["text"], reasoning: false });
      expect((await capture(cfg)).map((c) => c.headers.get("authorization"))).toEqual([null, null]);
    });

    it("keeps catalog headers and account metadata at their existing sources", async () => {
      const models = { small: { ...model(), headers: { "X-Model": "fixture-model" } }, large: model("large") };
      const f = fixture(models, { fixture: { ...credential(), headers: { "X-Catalog": "fixture-catalog" }, accountId: "fixture-account" } });
      const cfg = await resolve(f);
      const calls = await capture(cfg);
      expect(calls[0].headers.get("x-model")).toBe("fixture-model");
      expect(calls.map((c) => c.headers.get("x-catalog"))).toEqual(["fixture-catalog", "fixture-catalog"]);
      expect(cfg.utility.accountId).toBe("fixture-account");
    });

    it("retains mismatch and incomplete-override rejection", async () => {
      const f = fixture({ small: model(), large: model("large") });
      await expect(Promise.resolve().then(() => resolve(f, { provider: "other", api_key: "fixture", base_url: "https://override.invalid" }))).rejects.toThrow();
      await expect(Promise.resolve().then(() => resolve(f, { provider: "fixture", api_key: "fixture" }))).rejects.toThrow();
      await expect(Promise.resolve().then(() => resolve(f, { provider: "fixture", base_url: "https://override.invalid" }))).rejects.toThrow();
    });
  });
}
