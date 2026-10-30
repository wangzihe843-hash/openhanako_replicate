import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderRegistry } from "../core/provider-registry.ts";
import { MediaAdapterRegistry } from "../core/media-adapter-registry.ts";
import { MODEL_CATALOG, getDefaultModelId, getKnownModels, resolveModelId } from "../core/media-adapters/model-catalog.ts";
import { openaiImageAdapter } from "../core/media-adapters/openai.ts";
import { openaiPlugin } from "../lib/providers/openai.ts";
import { resolveImageTarget, retryImageTask } from "../core/media/image-task-runner.ts";
import { submitImageGeneration } from "../core/media/submit-image.ts";
import { resolveMediaParameters } from "../core/media/media-parameters.ts";
import { TaskStore } from "../core/media/task-store.ts";
import { Poller } from "../core/media/poller.ts";
import { SessionFileRegistry } from "../lib/session-files/session-file-registry.ts";

const SUNBURST = "gpt-image-2.5-sunburst";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5wAAAABJRU5ErkJggg==", "base64");
type FixtureBusResponse = Partial<ReturnType<ProviderRegistry["getCredentials"]> & {
  providers: Record<string, ReturnType<ProviderRegistry["getMediaProviders"]>[number]
    & ReturnType<ProviderRegistry["getMediaProviderCredentialStatus"]>>;
  providerId: string;
  modelId: string;
  model: ReturnType<ProviderRegistry["resolveMediaModel"]>["model"];
  protocolId: string;
  credentialProviderId: string;
}>;

const cleanups: Array<() => void> = [];

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected network request"); }));
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function response() {
  return new Response(JSON.stringify({ data: [{ b64_json: PNG.toString("base64") }] }));
}

function fixture({ settings = {}, provider = {} }: { settings?: Record<string, unknown>; provider?: Record<string, unknown> } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-openai-runtime-"));
  const catalogFile = path.join(root, "provider-catalog.json");
  const settingsFile = path.join(root, "preferences.json");
  const historyFile = path.join(root, "historical-images.json");
  fs.writeFileSync(catalogFile, JSON.stringify({ catalogVersion: 2, providers: {
    openai: { api_key: "synthetic-openai-key", base_url: "https://api.openai.com/v1", ...provider },
  } }));
  fs.writeFileSync(settingsFile, JSON.stringify(settings));
  fs.writeFileSync(historyFile, JSON.stringify([{ model: "gpt-image-1.5", file: "historical.png" }]));
  const originalBytes = [catalogFile, settingsFile, historyFile].map(file => fs.readFileSync(file));
  const providers = new ProviderRegistry(root);
  providers.reload();
  const registry = new MediaAdapterRegistry();
  registry.register(openaiImageAdapter);
  const store = new TaskStore(path.join(root, "tasks"));
  const config = { get: vi.fn((key: string) => settings[key]), set: vi.fn() };
  const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };
  const sessionPath = path.join(root, "agents", "synthetic-agent", "sessions", "session.jsonl");
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  fs.writeFileSync(sessionPath, "{}\n");
  const sessionFiles = new SessionFileRegistry();
  const registerSessionFile = vi.fn(input => sessionFiles.registerFile(input));
  const bus = {
    request: vi.fn(async (event: string, input: { providerId?: string; modelId?: string; capability?: string } = {}): Promise<FixtureBusResponse> => {
      if (event === "provider:credentials") return providers.getCredentials(input.providerId);
      if (event === "provider:media-providers") return { providers: Object.fromEntries(providers.getMediaProviders("image_generation")
        .map(provider => [provider.providerId, { ...provider, ...providers.getMediaProviderCredentialStatus(provider.providerId) }])) };
      if (event === "provider:resolve-media-model") {
        const resolved = providers.resolveMediaModel(input);
        return { providerId: resolved.providerId, modelId: resolved.model.id, model: resolved.model,
          protocolId: resolved.model.protocolId, credentialProviderId: resolved.providerId };
      }
      if (/^(deferred:|task:)/.test(event)) return {};
      throw new Error(`Unexpected bus request: ${event}`);
    }),
    emit: vi.fn(),
  };
  const poller = new Poller({ store, registry, bus, dataDir: root, generatedDir: path.join(root, "generated"), log, registerSessionFile });
  const ctx = { dataDir: root, sessionId: "synthetic-session", sessionPath, config, log, bus, _mediaGen: { registry, store, poller } };
  const fetchMock = vi.fn(async (_endpoint: string, _init: RequestInit) => response());
  vi.stubGlobal("fetch", fetchMock);
  cleanups.push(() => { poller.stop(); store.destroy(); fs.rmSync(root, { recursive: true, force: true }); });
  const start = async (input = {}) => {
    const result = await submitImageGeneration({ input: { prompt: "synthetic lantern", provider: "openai", model: SUNBURST, ...input }, ctx });
    return result.tasks[0].taskId as string;
  };
  const settled = async (taskId: string) => {
    await vi.waitFor(() => expect(store.get(taskId).status).not.toBe("pending"));
    return store.get(taskId);
  };
  const assertUnchanged = () => {
    expect(config.set).not.toHaveBeenCalled();
    [catalogFile, settingsFile, historyFile].forEach((file, i) => expect(fs.readFileSync(file)).toEqual(originalBytes[i]));
  };
  return { root, providers, registry, store, poller, ctx, fetchMock, start, settled, registerSessionFile, sessionFiles, assertUnchanged };
}

describe("OpenAI image model identity and selection", () => {
  it("adds only an explicit unlisted Sunburst entry, keeping both old menus and defaults", async () => {
    const f = fixture();
    expect(f.providers.getMediaModels("openai", "image_generation").map(m => m.id)).toEqual(["gpt-image-1.5", "gpt-image-1-mini"]);
    expect(getKnownModels("openai").map(m => m.id)).toEqual(["gpt-image-1-mini", "gpt-image-1.5", "gpt-image-2"]);
    expect(getDefaultModelId("openai")).toBe("gpt-image-1.5");
    expect(openaiPlugin.capabilities.media.imageGeneration.defaultModelId).toBe("gpt-image-1.5");
    expect(MODEL_CATALOG.openai.find(m => m.id === SUNBURST)).toMatchObject({ listed: false });
    const { model } = f.providers.resolveMediaModel({ providerId: "openai", modelId: SUNBURST });
    expect(model).toMatchObject({ id: SUNBURST, listed: false, protocolId: "openai-images", resolutions: ["1K"] });
    expect(model.aliases || []).toEqual([]);
    expect(model.modes.find(m => m.id === "image2image").inputLimits.referenceImages).toEqual({ min: 1, max: 16 });
    expect(f.providers.resolveMediaModel({ providerId: "openai", modelId: "gpt-image-1.5" }).model.modes[1].inputLimits.referenceImages).toEqual({ min: 1 });
    expect(resolveModelId("openai", SUNBURST)).toBe(SUNBURST);
    for (const [alias, id] of [["1", "gpt-image-1"], ["1.5", "gpt-image-1.5"], ["2", "gpt-image-2"], ["mini", "gpt-image-1-mini"]]) {
      expect(resolveModelId("openai", alias)).toBe(id);
    }
    for (const id of ["sunburst", "gpt-image-2.5-flare", `${SUNBURST}-2026-09-08`, `${SUNBURST}-typo`]) {
      expect(() => resolveModelId("openai", id)).toThrow(/Unknown/);
      expect(() => f.providers.resolveMediaModel({ providerId: "openai", modelId: id })).toThrow(/not found/);
    }
    await expect(resolveImageTarget({ model: SUNBURST }, f.registry, f.ctx)).rejects.toThrow();
    expect(f.fetchMock).not.toHaveBeenCalled();
    f.assertUnchanged();
  });

  it.each([
    { input: {}, settings: {}, expected: "gpt-image-1.5" },
    { input: { provider: "openai" }, settings: {}, expected: "gpt-image-1.5" },
    { input: { provider: "openai", model: "gpt-image-1.5" }, settings: {}, expected: "gpt-image-1.5" },
    { input: { provider: "openai", model: "mini" }, settings: {}, expected: "gpt-image-1-mini" },
    { input: {}, settings: { defaultImageModel: { provider: "openai", id: "gpt-image-1-mini" } }, expected: "gpt-image-1-mini" },
  ])("preserves selection $expected for $input", async ({ input, settings, expected }) => {
    const f = fixture({ settings });
    const target = await resolveImageTarget(input, f.registry, f.ctx);
    expect(target.modelId).toBe(expected);
    const result = await submitImageGeneration({ input: { prompt: "old selection", ...input }, ctx: f.ctx });
    expect((await f.settled(result.tasks[0].taskId)).status).toBe("done");
    expect(JSON.parse(String(f.fetchMock.mock.calls[0]![1].body)).model).toBe(expected);
    f.assertUnchanged();
  });

  it("preserves first-available order and legacy adapter fallback", async () => {
    const f = fixture();
    f.providers.register({ id: "first-fixture", authType: "none", capabilities: { media: { imageGeneration: {
      models: [{ id: "first-image", protocolId: "first-images" }],
    } } } });
    f.providers.reload();
    f.registry.register({ id: "first-fixture", protocolId: "first-images", types: ["image"] });
    const ordinaryBus = f.ctx.bus.request.getMockImplementation()!;
    f.ctx.bus.request.mockImplementation(async (event, input) => {
      const result = await ordinaryBus(event, input);
      if (event === "provider:media-providers") return { providers: {
        "first-fixture": result.providers["first-fixture"], openai: result.providers.openai,
      } };
      return result;
    });
    expect((await resolveImageTarget({}, f.registry, f.ctx)).modelId).toBe("first-image");
    f.registry.unregister("first-fixture");
    f.ctx.bus.request.mockImplementation(async (event, input) => event === "provider:media-providers" ? { providers: {} } : ordinaryBus(event, input));
    const target = await resolveImageTarget({}, f.registry, f.ctx);
    expect(target.modelId).toBeNull();
    await target.adapter.submit({ prompt: "legacy" }, f.ctx);
    expect(JSON.parse(String(f.fetchMock.mock.calls[0]![1].body)).model).toBe("gpt-image-1.5");
    f.assertUnchanged();
  });

  it.each(["media", "models"])("honors a previously saved same-name %s entry without rewriting configuration", async source => {
    const custom = { id: SUNBURST, type: "image", displayName: "Saved Sunburst", protocolId: "openai-images",
      modes: [{ id: "text2image", defaults: { ratio: "1:1", resolution: "1K", quality: "low" } }] };
    const f = fixture({
      provider: { base_url: "https://saved-proxy.example.test/v1", ...(source === "media" ? { media: { image_generation: { models: [custom] } } } : { models: [custom] }) },
      settings: { defaultImageModel: { provider: "openai", id: SUNBURST }, providerDefaults: { openai: {
        format: "png", quality: "low", models: { [SUNBURST]: { quality: "medium", modes: { text2image: { quality: "high" } } } },
      } } },
    });
    const model = f.providers.getMediaModels("openai", "image_generation").find(m => m.id === SUNBURST);
    expect(model).toMatchObject({ displayName: "Saved Sunburst", modes: custom.modes });
    expect((await resolveImageTarget({ provider: "openai" }, f.registry, f.ctx)).modelId).toBe("gpt-image-1.5");
    const result = await submitImageGeneration({ input: { prompt: "saved explicit selection" }, ctx: f.ctx });
    expect((await f.settled(result.tasks[0].taskId)).status).toBe("done");
    const [endpoint, init] = f.fetchMock.mock.calls[0]!;
    expect(endpoint).toBe("https://saved-proxy.example.test/v1/images/generations");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer synthetic-openai-key");
    expect(JSON.parse(String(init.body))).toMatchObject({ model: SUNBURST, size: "1024x1024", quality: "high", output_format: "png" });
    f.assertUnchanged();
  });
});

describe("OpenAI registry to image task runtime", () => {
  it.each(["url", "file_id", "local"])("runs %s edits through registry, parameter resolution, adapter and delivery", async kind => {
    const f = fixture();
    const local = path.join(f.root, "reference.png");
    fs.writeFileSync(local, PNG);
    const image = kind === "local" ? local : kind === "url" ? "https://reference.example.test/a.png" : "file-synthetic";
    const task = await f.settled(await f.start({ image, format: "png", options: { n: 1, background: "transparent" } }));
    expect(task).toMatchObject({ status: "done", modelId: SUNBURST });
    expect(f.fetchMock).toHaveBeenCalledTimes(1);
    const [endpoint, init] = f.fetchMock.mock.calls[0]!;
    expect(endpoint).toBe("https://api.openai.com/v1/images/edits");
    if (kind === "local") {
      expect(init.body).toBeInstanceOf(FormData);
      expect((init.body as FormData).get("model")).toBe(SUNBURST);
    } else {
      expect(JSON.parse(String(init.body)).images).toEqual([kind === "url" ? { image_url: image } : { file_id: image }]);
    }
    expect(f.registerSessionFile).toHaveBeenCalledTimes(1);
    f.assertUnchanged();
  });

  it.each([
    [{}, "1536x1024"], [{ ratio: "1:1", resolution: "1K" }, "1024x1024"],
    [{ ratio: "2:3", resolution: "1K" }, "1024x1536"],
    [{ size: "auto" }, "auto"], [{ size: "1024x1024", ratio: "2:3", resolution: "1K" }, "1024x1024"],
  ])("keeps standard size through real parameter resolution: %j", async (input, size) => {
    const f = fixture();
    const task = await f.settled(await f.start(input));
    expect(task.status).toBe("done");
    expect(JSON.parse(String(f.fetchMock.mock.calls[0]![1].body))).toMatchObject({ model: SUNBURST, size });
    expect(task.params.modelId).toBe(SUNBURST);
    f.assertUnchanged();
  });

  it("keeps scoped defaults, explicit size precedence, and exact SessionFile ownership", async () => {
    const f = fixture({ settings: { providerDefaults: { openai: {
      size: "1024x1024", format: "png", quality: "low", modes: { image2image: { background: "transparent" } },
      models: { [SUNBURST]: { quality: "medium", modes: { image2image: { quality: "high" } } } },
    } } } });
    const task = await f.settled(await f.start({ image: "file-synthetic", ratio: "2:3", resolution: "1K" }));
    expect(task).toMatchObject({ status: "done", sessionId: f.ctx.sessionId, sessionPath: f.ctx.sessionPath, imageWidth: 1, imageHeight: 1 });
    expect(JSON.parse(String(f.fetchMock.mock.calls[0]![1].body))).toMatchObject({
      model: SUNBURST, size: "1024x1536", quality: "high", output_format: "png", background: "transparent", images: [{ file_id: "file-synthetic" }],
    });
    expect(f.registerSessionFile).toHaveBeenCalledTimes(1);
    const registered = f.registerSessionFile.mock.results[0]!.value;
    expect(registered).toMatchObject({ sessionId: f.ctx.sessionId, sessionPath: f.ctx.sessionPath, mime: "image/png", origin: "plugin_output", storageKind: "plugin_data" });
    expect(createHash("sha256").update(fs.readFileSync(registered.filePath)).digest("hex")).toBe(createHash("sha256").update(PNG).digest("hex"));
    expect(f.sessionFiles.get(registered.id, { sessionId: "different-session", sessionPath: path.join(f.root, "agents", "other", "session.jsonl") })).toBeNull();
    await f.poller.checkNow(task.taskId);
    expect(f.registerSessionFile).toHaveBeenCalledTimes(1);
    expect(f.ctx.bus.request.mock.calls.filter(([event]) => event === "deferred:resolve")).toHaveLength(1);
    f.assertUnchanged();
  });

  it.each([{ resolution: "2K" }, { resolution: "4K" }, { quality: "max" }, { options: { n: 0 } }, { options: { n: 11 } },
    { options: { n: 1.5 } }, { mode: "image2image" }, { image: Array(17).fill("file-synthetic") },
  ])("rejects invalid declared input before submission: %j", async input => {
    const f = fixture();
    await expect(f.start(input)).rejects.toThrow();
    expect(f.fetchMock).not.toHaveBeenCalled();
    f.assertUnchanged();
  });

  it("keeps combination validation and redacted errors at the stored task boundary", async () => {
    const f = fixture();
    const invalid = await f.settled(await f.start({ options: { background: "transparent", format: "jpeg" } }));
    expect(invalid.status).toBe("failed");
    expect(f.fetchMock).not.toHaveBeenCalled();
    f.fetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: { message: "Bearer synthetic-bearer https://example.test/a?token=synthetic-token" } }), { status: 429 }));
    const failed = await f.settled(await f.start());
    expect(failed.status).toBe("failed");
    f.store.flushSync();
    const persisted = new TaskStore(path.join(f.root, "tasks"));
    try {
      expect(persisted.get(failed.taskId).failReason).toContain("API error 429");
      expect(JSON.stringify([persisted.get(failed.taskId), f.ctx.log.error.mock.calls])).not.toMatch(/synthetic-bearer|synthetic-token/);
    } finally { persisted.destroy(); }
    expect(f.fetchMock).toHaveBeenCalledTimes(1);
    expect(f.registerSessionFile).not.toHaveBeenCalled();
    f.assertUnchanged();
  });

  it.each([false, true])("fences late results after cancellation (retry=%s) without changing the stored model", async retry => {
    const f = fixture();
    const submitSpy = vi.spyOn(openaiImageAdapter, "submit");
    let finishOld: (res: Response) => void = () => {};
    f.fetchMock.mockImplementationOnce(() => new Promise<Response>(resolve => { finishOld = resolve; }));
    const taskId = await f.start({ format: "png", suggestedFilename: "old-attempt" });
    await vi.waitFor(() => expect(f.fetchMock).toHaveBeenCalledTimes(1));
    const params = structuredClone(f.store.get(taskId).params);
    f.poller.cancel(taskId);
    if (retry) {
      expect(await retryImageTask({ taskId, ctx: f.ctx })).toMatchObject({ ok: true });
      expect((await f.settled(taskId)).status).toBe("done");
      expect(f.store.get(taskId).params).toEqual(params);
    }
    finishOld(response());
    await submitSpy.mock.results[0]!.value;
    await new Promise(resolve => setImmediate(resolve));
    expect(f.store.get(taskId).status).toBe(retry ? "done" : "cancelled");
    expect(f.store.get(taskId).params.modelId).toBe(SUNBURST);
    expect(f.registerSessionFile).toHaveBeenCalledTimes(retry ? 1 : 0);
    expect(f.ctx.bus.request.mock.calls.filter(([event]) => event === "deferred:resolve")).toHaveLength(retry ? 1 : 0);
    f.assertUnchanged();
  });

  it("does not enlarge the old model or OAuth schemas", () => {
    const f = fixture();
    const oauth = f.providers.resolveMediaModel({ providerId: "openai-codex-oauth", modelId: "gpt-image-2" }).model;
    expect(oauth.modes[0].defaults).toMatchObject({ resolution: "2K" });
    expect(oauth.modes[0].parameterSchema.properties.resolution.enum).toEqual(["1K", "2K"]);
    const legacy = f.providers.resolveMediaModel({ providerId: "openai", modelId: "gpt-image-1.5" }).model;
    expect(resolveMediaParameters({ kind: "image", model: legacy, input: {} }).resolvedParameters).toEqual({ ratio: "3:2", resolution: "1K" });
    f.assertUnchanged();
  });
});
