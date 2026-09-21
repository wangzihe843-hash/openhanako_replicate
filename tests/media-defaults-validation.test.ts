import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { PreferencesManager } from "../core/preferences-manager.ts";
import { UniversalMediaManager } from "../core/media/universal-media-manager.ts";
import { resolveMediaParameters } from "../core/media/media-parameters.ts";
import { createMediaRoute } from "../server/routes/media.ts";
import { volcenginePlugin } from "../lib/providers/volcengine.ts";
import { openaiPlugin } from "../lib/providers/openai.ts";

const roots: string[] = [];
const volcengineModels = volcenginePlugin.capabilities.media.imageGeneration.models;
const typedModel = {
  id: "typed-model",
  modes: ["text2image", "text2video"].map(id => ({
    id,
    parameterSchema: { properties: {
      watermark: { type: "boolean" },
      level: { type: "integer", enum: [0, 1] },
      enabled: { type: "boolean", enum: [false, true] },
      duration: { type: "number", minimum: 1, maximum: 10 },
    } },
  })),
};

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-media-defaults-"));
  roots.push(root);
  const userDir = path.join(root, "user");
  fs.mkdirSync(userDir, { recursive: true });
  const preferences = new PreferencesManager({ userDir, agentsDir: path.join(root, "agents") });
  const manager = new UniversalMediaManager({
    hanakoHome: root,
    preferences,
    providerRegistry: {
      getMediaProviders: (capability: string) => [
        { providerId: "typed", models: [typedModel] },
        ...(capability === "image_generation" ? [
          { providerId: "volcengine", models: volcengineModels },
          { providerId: "openai", models: openaiPlugin.capabilities.media.imageGeneration.models },
        ] : []),
      ],
    },
    registerSessionFile: () => {},
  });
  const app = new Hono();
  app.route("/api", createMediaRoute({ media: manager }));
  const save = (kind: "image" | "video", providerDefaults: unknown) => app.request(`/api/media/${kind}/config`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ values: { providerDefaults } }),
  });
  const diskSnapshot = () => [
    path.join(userDir, "preferences.json"),
    path.join(root, "plugin-data", "image-gen", "config.json"),
  ].map(file => fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null);
  return { manager, preferences, save, diskSnapshot };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("media defaults save validation", () => {
  it.each([false, true])("round trips Volcengine watermark=%s through HTTP and native/legacy persistence", async watermark => {
    const { manager, preferences, save } = fixture();
    const model = volcengineModels[0];
    const defaults = { volcengine: { models: { [model.id]: { modes: { text2image: { watermark } } } } } };
    const response = await save("image", defaults);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ config: { providerDefaults: defaults } });
    expect(preferences.getImageGenerationConfig().providerDefaults).toEqual(defaults);
    expect(manager.config.get("providerDefaults")).toEqual(defaults);
    expect(resolveMediaParameters({ kind: "image", model, providerDefaults: defaults.volcengine }).resolvedParameters.watermark).toBe(watermark);

    expect((await save("image", null)).status).toBe(200);
    expect(manager.getImageConfig().providerDefaults).toBeUndefined();
    expect(manager.config.get("providerDefaults")).toBeUndefined();
  });

  it.each(["image", "video"] as const)("preserves numeric and boolean enum defaults for %s", async kind => {
    const { manager, save } = fixture();
    const mode = kind === "image" ? "text2image" : "text2video";
    const defaults = { typed: { models: { "typed-model": { modes: { [mode]: { level: 0, enabled: false, watermark: true } } } } } };
    expect((await save(kind, defaults)).status).toBe(200);
    const config = kind === "image" ? manager.getImageConfig() : manager.getVideoConfig();
    expect(config.providerDefaults).toEqual(defaults);
    expect(resolveMediaParameters({ kind, input: { mode }, model: typedModel, providerDefaults: defaults.typed }).resolvedParameters).toEqual({ level: 0, enabled: false, watermark: true });
  });

  it.each(["image", "video"] as const)("rejects invalid scoped %s defaults before changing persisted config", async kind => {
    const { manager, save, diskSnapshot } = fixture();
    const mode = kind === "image" ? "text2image" : "text2video";
    const valid = { typed: { watermark: false } };
    expect((await save(kind, valid)).status).toBe(200);
    const before = diskSnapshot();
    for (const invalid of [{ watermark: "false" }, { level: "0" }, { enabled: "true" }, { duration: 99 }]) {
      const response = await save(kind, { typed: { models: { "typed-model": { modes: { [mode]: invalid } } } } });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: expect.stringContaining("Media parameter") });
      expect(kind === "image" ? manager.getImageConfig() : manager.getVideoConfig()).toEqual({ providerDefaults: valid });
      expect(diskSnapshot()).toEqual(before);
    }
  });

  it.each([
    { watermark: "false" },
    { options: { watermark: "false" } },
    { modes: { text2image: { watermark: "false" } } },
    { models: { "typed-model": { watermark: "false" } } },
    { models: { "typed-model": { modes: { text2image: { options: { watermark: "false" } } } } } },
  ])("rejects invalid booleans in each known default scope (%j)", async defaults => {
    const { save } = fixture();
    const response = await save("image", { typed: defaults });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'Media parameter "watermark" must be boolean' });
  });

  it("lets the UI repair multiple previously saved string booleans one field at a time", async () => {
    const { preferences, manager, save } = fixture();
    const [firstModel, secondModel] = volcengineModels;
    const previous = { volcengine: { models: {
      [firstModel.id]: { modes: { text2image: { watermark: "true" as string | boolean } } },
      [secondModel.id]: { modes: { text2image: { watermark: "false" as string | boolean } } },
    } } };
    // Seed only isolated test preferences with data produced by the former UI.
    preferences.setImageGenerationConfig({ providerDefaults: previous });
    const firstRepair = structuredClone(previous);
    firstRepair.volcengine.models[firstModel.id].modes.text2image.watermark = true;
    expect((await save("image", firstRepair)).status).toBe(200);
    expect(manager.getImageConfig().providerDefaults).toEqual(firstRepair);
    const secondRepair = structuredClone(firstRepair);
    secondRepair.volcengine.models[secondModel.id].modes.text2image.watermark = false;
    expect((await save("image", secondRepair)).status).toBe(200);
    expect(manager.getImageConfig().providerDefaults).toEqual(secondRepair);
    for (const model of [firstModel, secondModel]) {
      expect(() => resolveMediaParameters({ kind: "image", model, providerDefaults: secondRepair.volcengine })).not.toThrow();
    }
    expect((await save("image", previous)).status).toBe(400);
    expect(manager.getImageConfig().providerDefaults).toEqual(secondRepair);
  });

  it.each(["image", "video"] as const)("inherits provider mode parameters when a %s model overrides a different parameter", async kind => {
    const { save, manager } = fixture();
    const mode = kind === "image" ? "text2image" : "text2video";
    const defaults = { typed: {
      options: { duration: 1, level: 0 },
      modes: { [mode]: { watermark: false, options: { duration: 7 } } },
      models: { "typed-model": {
        duration: 2,
        enabled: true,
        modes: { [mode]: { level: 1, options: { enabled: false } } },
      } },
    } };
    expect((await save(kind, defaults)).status).toBe(200);
    const config = kind === "image" ? manager.getImageConfig() : manager.getVideoConfig();
    const resolve = (input: Record<string, unknown> = {}) => resolveMediaParameters({
      kind, model: typedModel, providerDefaults: config.providerDefaults.typed, input: { mode, ...input },
    }).resolvedParameters;
    expect(resolve()).toEqual({ duration: 7, level: 1, enabled: false, watermark: false });
    expect(resolve({ options: { level: 0, watermark: true }, duration: 9 })).toEqual({
      duration: 9, level: 0, enabled: false, watermark: true,
    });
    expect(() => resolve({ duration: 99 })).toThrow(/duration/);
    expect(config.providerDefaults).toEqual(defaults);
  });

  it("keeps legacy shared defaults, custom models, unknown keys, and narrower valid overrides compatible", async () => {
    const { save, manager } = fixture();
    const defaults = {
      openai: {
        quality: "high",
        legacy_extra: "kept",
        models: {
          "dall-e-3": { modes: { text2image: { quality: "hd" } } },
          "custom-model": { modes: { vendor_mode: { vendor_option: "custom" } } },
        },
      },
      volcengine: { watermark: false, models: { [volcengineModels[0].id]: { modes: { text2image: { guidance_scale: 5 } } } } },
      "custom-provider": { untyped_option: "kept" },
    };
    expect((await save("image", defaults)).status).toBe(200);
    expect(manager.getImageConfig().providerDefaults).toEqual(defaults);
    const dallE = openaiPlugin.capabilities.media.imageGeneration.models.find(model => model.id === "dall-e-3");
    expect(resolveMediaParameters({ kind: "image", model: dallE, providerDefaults: defaults.openai }).resolvedParameters.quality).toBe("hd");
    const response = await save("image", { openai: { models: { "dall-e-3": { modes: { text2image: { quality: "high" } } } } } });
    expect(response.status).toBe(400);
  });
});
