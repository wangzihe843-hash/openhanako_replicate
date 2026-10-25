import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderRegistry } from "../core/provider-registry.ts";
import { PreferencesManager } from "../core/preferences-manager.ts";
import { UniversalMediaManager } from "../core/media/universal-media-manager.ts";
import { resolveImageTarget } from "../core/media/image-task-runner.ts";
import { openaiImageAdapter } from "../core/media-adapters/openai.ts";
import { getDefaultModelId, getKnownModels, resolveModelId } from "../core/media-adapters/model-catalog.ts";
import { createMediaRoute } from "../server/routes/media.ts";

const roots: string[] = [];
const currentOpenAiModels = ["gpt-image-1.5", "gpt-image-1-mini"];
const legacyDefaults = { openai: { models: { "dall-e-3": { modes: { text2image: { quality: "hd" } } } } } };

function fixture({
  providers = { openai: { api_key: "test-key" } },
  imageConfig = {},
  legacy = false,
}: {
  providers?: Record<string, unknown>;
  imageConfig?: Record<string, unknown>;
  legacy?: boolean;
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-retired-image-"));
  roots.push(root);
  const catalogPath = path.join(root, "provider-catalog.json");
  fs.writeFileSync(catalogPath, JSON.stringify({ catalogVersion: 2, providers }));
  const userDir = path.join(root, "user");
  fs.mkdirSync(userDir, { recursive: true });
  const preferencesPath = path.join(userDir, "preferences.json");
  const legacyPath = path.join(root, "plugin-data", "image-gen", "config.json");
  if (legacy) {
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(legacyPath, JSON.stringify({ schemaVersion: 1, global: imageConfig, agents: {}, sessions: {} }));
  } else {
    fs.writeFileSync(preferencesPath, JSON.stringify({ imageGeneration: imageConfig, _imageGenerationLegacyConfigMigrated: true }));
  }
  const registry = new ProviderRegistry(root);
  registry.reload();
  const preferences = new PreferencesManager({ userDir, agentsDir: path.join(root, "agents") });
  const manager = new UniversalMediaManager({
    hanakoHome: root,
    providerRegistry: registry,
    preferences,
    registerSessionFile: () => {},
    builtinAdapters: [openaiImageAdapter],
  });
  const app = new Hono();
  app.route("/api", createMediaRoute({ media: manager }));
  const save = (values: Record<string, unknown>) => app.request("/api/media/image/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ values }),
  });
  const snapshot = () => [catalogPath, preferencesPath, legacyPath]
    .map(file => fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null);
  const bus = {
    request: vi.fn(async (type: string, ref: { providerId: string; modelId?: string }) => {
      if (type === "provider:resolve-media-model") return manager.resolveImageModelRef(ref);
      if (type === "provider:media-providers") return manager.listImageProviders();
      if (type === "provider:credentials") return registry.getCredentials(ref.providerId);
      throw new Error(`Unexpected test bus request: ${type}`);
    }),
  };
  return { root, registry, preferences, manager, app, save, snapshot, bus };
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("retired OpenAI image catalog compatibility", () => {
  it("omits retired models from new suggestions without adding models or changing defaults", async () => {
    const { registry, manager, app, bus } = fixture();
    expect(registry.getMediaModels("openai", "image_generation").map(model => model.id)).toEqual(currentOpenAiModels);
    expect(registry.getMediaProviders("image_generation").find(provider => provider.providerId === "openai")?.models.map(model => model.id))
      .toEqual(currentOpenAiModels);
    expect(registry.getProviderCapabilities("openai")?.media?.imageGeneration?.defaultModelId).toBe("gpt-image-1.5");
    for (const route of ["/api/media/image/providers", "/api/media/providers?capability=image_generation"]) {
      const response = await app.request(route);
      expect(response.status).toBe(200);
      const payload = await response.json();
      expect(payload.providers.openai.models.map((model: { id: string }) => model.id)).toEqual(currentOpenAiModels);
      expect(payload.providers.openai.availableModels).not.toContainEqual(expect.objectContaining({ id: "dall-e-3" }));
      expect(payload.providers.openai.availableModels).not.toContainEqual(expect.objectContaining({ id: "gpt-image-1" }));
      expect(payload.config).toEqual({});
    }
    for (const input of [{}, { provider: "openai" }]) {
      const target = await resolveImageTarget(input, manager.registry, { config: manager.config, bus });
      expect(target).toMatchObject({ providerId: "openai", modelId: "gpt-image-1.5" });
    }
  });

  it("keeps adapter aliases and its default while excluding retired models from suggestions", () => {
    expect(getKnownModels("openai").map(model => model.id)).toEqual([
      "gpt-image-1-mini", "gpt-image-1.5", "gpt-image-2",
    ]);
    expect(getDefaultModelId("openai")).toBe("gpt-image-1.5");
    for (const value of [undefined, null, ""]) expect(resolveModelId("openai", value)).toBe("gpt-image-1.5");
    for (const value of ["dall-e-3", "dalle3", "DALLE3"]) expect(resolveModelId("openai", value)).toBe("dall-e-3");
    for (const value of ["gpt-image-1", "1"]) expect(resolveModelId("openai", value)).toBe("gpt-image-1");
    expect(resolveModelId("custom-proxy", "dall-e-3")).toBe("dall-e-3");
    expect(() => resolveModelId("openai", "unknown-image")).toThrow(/Unknown image model/);
    expect(() => resolveModelId("openai", "unknown-image")).not.toThrow(/Available models:.*dall-e-3/);
    expect(() => resolveModelId("openai", "unknown-image")).not.toThrow(/Available models:.*gpt-image-1,/);
  });

  it.each([false, true])("preserves saved DALL-E selections, parameters and explicit resolution (legacy store=%s)", async legacy => {
    const config = { defaultImageModel: { provider: "openai", id: "dall-e-3" }, providerDefaults: legacyDefaults };
    const { registry, preferences, manager, app, save, snapshot, bus } = fixture({ imageConfig: config, legacy });
    const before = snapshot();
    const response = await app.request("/api/media/image/providers");
    expect((await response.json()).config).toEqual(config);
    expect(manager.getImageConfig()).toEqual(config);
    expect(preferences.getImageGenerationConfig()).toEqual(config);
    expect(snapshot()).toEqual(before);
    for (const modelId of ["dall-e-3", "dalle3"]) {
      expect(registry.resolveMediaModel({ providerId: "openai", modelId }).model).toMatchObject({
        id: "dall-e-3", protocolId: "openai-images", aliases: ["dalle3"],
      });
    }
    expect(await resolveImageTarget({}, manager.registry, { config: manager.config, bus })).toMatchObject({
      providerId: "openai", modelId: "dall-e-3", protocolId: "openai-images",
    });
    const providerDefaults = { ...legacyDefaults, "custom-provider": { vendor_option: "kept" } };
    expect((await save({ providerDefaults })).status).toBe(200);
    expect(manager.getImageConfig()).toEqual({ ...config, providerDefaults });
    expect((await save({ defaultImageModel: config.defaultImageModel })).status).toBe(200);
    expect(preferences.getImageGenerationConfig().defaultImageModel).toEqual(config.defaultImageModel);
    const persisted = snapshot();
    expect(JSON.parse(persisted[2]!).global.defaultImageModel).toEqual(config.defaultImageModel);
    expect(JSON.parse(persisted[1]!).imageGeneration).toEqual({ ...config, providerDefaults });
    registry.reload();
    expect(manager.getImageConfig()).toEqual({ ...config, providerDefaults });
    expect(snapshot()).toEqual(persisted);
  });

  it("still validates explicitly edited legacy model parameters before writing", async () => {
    const { save, snapshot } = fixture({ imageConfig: { providerDefaults: legacyDefaults } });
    const before = snapshot();
    const response = await save({ providerDefaults: { openai: { models: { "dall-e-3": { modes: { text2image: { quality: "high" } } } } } } });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("quality") });
    expect(snapshot()).toEqual(before);
  });

  it.each([false, true])("preserves saved GPT Image 1 defaults and explicit resolution (legacy store=%s)", async legacy => {
    const config = { defaultImageModel: { provider: "openai", id: "gpt-image-1" } };
    const { registry, manager, app, snapshot, bus } = fixture({ imageConfig: config, legacy });
    const before = snapshot();
    expect((await (await app.request("/api/media/image/providers")).json()).config).toEqual(config);
    for (const modelId of ["gpt-image-1", "1"]) {
      expect(registry.resolveMediaModel({ providerId: "openai", modelId }).model.id).toBe("gpt-image-1");
    }
    expect(await resolveImageTarget({}, manager.registry, { config: manager.config, bus })).toMatchObject({
      providerId: "openai", modelId: "gpt-image-1", protocolId: "openai-images",
    });
    expect(snapshot()).toEqual(before);
  });

  it.each(["openai", "custom-proxy"])("preserves explicit proxy GPT Image 1 model lists (%s)", async providerId => {
    const { registry, manager, snapshot } = fixture({ providers: {
      [providerId]: { api_key: "test-key", base_url: "https://proxy.example.test/v1", api: "openai-completions",
        media: { image_generation: { models: ["gpt-image-1"] } } },
    } });
    const before = snapshot();
    expect(registry.getMediaModels(providerId, "image_generation")).toContainEqual(expect.objectContaining({ id: "gpt-image-1" }));
    expect((await manager.listImageProviders()).providers[providerId].models)
      .toContainEqual(expect.objectContaining({ id: "gpt-image-1", adapterAvailable: true }));
    registry.reload();
    expect(snapshot()).toEqual(before);
  });

  it.each([
    { providerId: "openai", models: { media: { image_generation: { models: [{ id: "dall-e-3", name: "Saved DALL-E" }] } } } },
    { providerId: "openai", models: { models: ["dall-e-3"] } },
    { providerId: "custom-proxy", models: { media: { image_generation: { models: [{ id: "dall-e-3", name: "Saved DALL-E" }] } } } },
    { providerId: "custom-proxy", models: { models: [{ id: "dall-e-3", type: "image" }] } },
  ])("preserves explicitly saved same-name models ($providerId, $models)", async ({ providerId, models }) => {
    const { registry, manager, snapshot } = fixture({ providers: {
      [providerId]: { api_key: "test-key", base_url: "https://proxy.example.test/v1", api: "openai-completions", ...models },
    } });
    const before = snapshot();
    expect(registry.getMediaModels(providerId, "image_generation")).toContainEqual(expect.objectContaining({
      id: "dall-e-3", protocolId: "openai-images",
    }));
    expect((await manager.listImageProviders()).providers[providerId].models).toContainEqual(expect.objectContaining({
      id: "dall-e-3", adapterAvailable: true,
    }));
    expect(registry.resolveMediaModel({ providerId, modelId: "dall-e-3" }).model.id).toBe("dall-e-3");
    registry.reload();
    expect(snapshot()).toEqual(before);
    if (providerId === "openai") {
      expect(registry.resolveMediaModel({ providerId, modelId: "dall-e-3" }).model.modes[0].parameterSchema.properties.quality.enum)
        .toEqual(["standard", "hd"]);
    }
  });

  it.each([
    { providerId: "openai", modelId: "dalle3", baseUrl: "https://proxy.example.test/v1" },
    { providerId: "custom-proxy", modelId: "dall-e-3", baseUrl: "https://proxy.example.test/v1" },
    { providerId: "openai", modelId: "gpt-image-1.5", baseUrl: "https://api.openai.com/v1" },
  ])("preserves the request target and body for $providerId/$modelId", async ({ providerId, modelId, baseUrl }) => {
    const { manager, bus } = fixture({
      providers: { [providerId]: {
        api_key: "test-key", base_url: baseUrl, api: "openai-completions",
        ...(providerId === "custom-proxy" ? { media: { image_generation: { models: ["dall-e-3"] } } } : {}),
      } },
      imageConfig: { defaultImageModel: { provider: providerId, id: modelId } },
    });
    const target = await resolveImageTarget({}, manager.registry, { config: manager.config, bus });
    const capture = vi.fn(async (_url: string, _init: { body: string }) => { throw new Error("OFFLINE_REQUEST_CAPTURE"); });
    vi.stubGlobal("fetch", capture);
    await expect(openaiImageAdapter.submit({
      prompt: "test lantern", providerId: target.providerId, modelId: target.modelId,
      ratio: modelId.startsWith("gpt-image") ? "3:2" : "16:9",
    }, {
      config: manager.config, bus,
    })).rejects.toThrow("OFFLINE_REQUEST_CAPTURE");
    expect(capture).toHaveBeenCalledTimes(1);
    const [endpoint, init] = capture.mock.calls[0]!;
    expect(endpoint).toBe(`${baseUrl}/images/generations`);
    const body = JSON.parse(init.body);
    if (modelId.startsWith("gpt-image")) {
      expect(body).toMatchObject({ model: "gpt-image-1.5", output_format: "jpeg", size: "1536x1024" });
      expect(body).not.toHaveProperty("response_format");
    } else {
      expect(body).toMatchObject({ model: "dall-e-3", response_format: "b64_json", size: "1792x1024" });
      expect(body).not.toHaveProperty("output_format");
    }
  });
});
