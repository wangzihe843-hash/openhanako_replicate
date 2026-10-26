import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PreferencesManager } from "../core/preferences-manager.ts";
import { ProviderRegistry } from "../core/provider-registry.ts";
import { UniversalMediaManager } from "../core/media/universal-media-manager.ts";
import { agnesImageAdapter, agnesVideoAdapter } from "../core/media-adapters/agnes.ts";

const MODEL = "agnes-video-v2.0";
const FAKE_KEY = "synthetic-agnes-retirement-key";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5ioAAAAASUVORK5CYII=";
const fixtures: Array<{ root: string; manager: UniversalMediaManager }> = [];

function createFixture({ withDefault = false, baseUrl = "https://apihub.agnes-ai.com/v1" } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-agnes-retirement-"));
  const userDir = path.join(root, "user");
  fs.mkdirSync(userDir, { recursive: true });
  const preferences = new PreferencesManager({ userDir, agentsDir: path.join(root, "agents") });
  if (withDefault) {
    preferences.setVideoGenerationConfig({ defaultVideoModel: { provider: "agnes", id: MODEL } });
  }
  const registry = new ProviderRegistry(root);
  registry.saveProvider("agnes", { api_key: FAKE_KEY, base_url: baseUrl });
  registry.register({
    id: "synthetic-other-video",
    displayName: "Synthetic other video",
    authType: "none",
    capabilities: {
      media: {
        videoGeneration: {
          models: [{ id: "other-video", protocolId: "synthetic-other-videos", inputs: ["text"], outputs: ["video"] }],
        },
      },
    },
  });
  registry.reload();
  const otherSubmit = vi.fn(async () => ({ taskId: "unexpected-other-provider-task" }));
  const handlers = new Map<string, (value: Record<string, unknown>) => unknown>();
  const bus = {
    handle: vi.fn((name: string, handler: (value: Record<string, unknown>) => unknown) => {
      handlers.set(name, handler);
      return () => handlers.delete(name);
    }),
    subscribe: vi.fn(() => () => {}),
    request: vi.fn(async (name: string, value: Record<string, unknown> = {}) => {
      if (name === "provider:credentials") return registry.getCredentials(String(value.providerId));
      if (name === "provider:resolve-media-model") return manager.resolveImageModelRef(value);
      if (handlers.has(name)) return handlers.get(name)!(value);
      return {};
    }),
    emit: vi.fn(),
  };
  const createManager = () => new UniversalMediaManager({
    hanakoHome: root,
    providerRegistry: registry,
    preferences,
    registerSessionFile: vi.fn(() => null),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    builtinAdapters: [
      agnesImageAdapter,
      agnesVideoAdapter,
      { id: "synthetic-other-video", protocolId: "synthetic-other-videos", types: ["video"], submit: otherSubmit },
    ],
  });
  const manager = createManager();
  manager.start(bus);
  const fixture = { root, manager };
  fixtures.push(fixture);
  return { ...fixture, preferences, registry, bus, otherSubmit, reopen: () => {
    manager.dispose();
    const reopened = createManager();
    reopened.start(bus);
    fixtures.push({ root, manager: reopened });
    return reopened;
  } };
}

afterEach(() => {
  const completed = fixtures.splice(0);
  for (const { manager } of completed) manager.dispose();
  for (const root of new Set(completed.map((fixture) => fixture.root))) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  vi.unstubAllGlobals();
});

describe("Agnes V2.0 retirement selection contract", () => {
  it("retains the selected model, video schema and 3:2 defaults while explaining retirement in settings data", async () => {
    const { manager, registry } = createFixture({ withDefault: true });
    const network = vi.fn(async () => { throw new Error("unexpected network"); });
    vi.stubGlobal("fetch", network);

    const projection = await manager.listVideoProviders();
    const video = projection.providers.agnes.models.find((model) => model.id === MODEL);
    expect(video).toMatchObject({ id: MODEL, protocolId: "agnes-videos", adapterAvailable: true, ratios: ["3:2"], resolutions: ["720p"] });
    expect(video.name).toMatch(/retired|退役/i);
    expect(video.modes.find((mode) => mode.id === "text2video").defaults).toEqual({ ratio: "3:2", video_resolution: "720p", duration: 5, frame_rate: 24 });
    expect(projection.config.defaultVideoModel).toEqual({ provider: "agnes", id: MODEL });
    expect(registry.resolveMediaModel({ providerId: "agnes", modelId: MODEL, capability: "video_generation" }).model.id).toBe(MODEL);
    expect(network).not.toHaveBeenCalled();
  });

  it.each([
    { label: "explicit provider and model", input: { provider: "agnes", model: MODEL }, withDefault: false },
    { label: "explicit provider alone", input: { provider: "agnes" }, withDefault: false },
    { label: "explicit model alone", input: { model: MODEL }, withDefault: false },
    { label: "persisted default", input: {}, withDefault: true },
    { label: "implicit first video model", input: {}, withDefault: false },
  ])("blocks $label locally on repeated new submission without choosing a different provider", async ({ input, withDefault }) => {
    const { manager, otherSubmit, registry } = createFixture({ withDefault });
    const configBefore = structuredClone(manager.getVideoConfig());
    const catalogBefore = structuredClone(registry.getAllProvidersRaw());
    // A successful fake response exposes the old behavior without reaching any service.
    const network = vi.fn(async (_url: string, _request?: RequestInit) => new Response(JSON.stringify({ task_id: "old-submit-would-succeed", video_id: "old-video-id" }), { status: 200 }));
    vi.stubGlobal("fetch", network);

    for (let attempt = 0; attempt < 2; attempt++) {
      const error = await manager.generateVideoFromBus({
        input: { prompt: "synthetic retirement contract", delivery: { mode: "response" }, ...input },
      }).then(() => null, (err: Error) => err);
      expect(error).toBeInstanceOf(Error);
      expect(error!.message).toMatch(/agnes-video-v2\.0/i);
      expect(error!.message).toMatch(/retired|退役/i);
      expect(error!.message).not.toContain(FAKE_KEY);
    }

    expect(network).not.toHaveBeenCalled();
    expect(otherSubmit).not.toHaveBeenCalled();
    expect(manager.listTasks()).toEqual([]);
    expect(manager.getVideoConfig()).toEqual(configBefore);
    expect(registry.getAllProvidersRaw()).toEqual(catalogBefore);
  });

  it("continues the image path through the selected Agnes credentials and original endpoint", async () => {
    const { manager, otherSubmit } = createFixture({ withDefault: true });
    const network = vi.fn(async (_url: string, _request?: RequestInit) => new Response(JSON.stringify({ data: [{ b64_json: PNG }] }), { status: 200 }));
    vi.stubGlobal("fetch", network);

    const result = await manager.generateImageFromBus({
      input: { provider: "agnes", model: "agnes-image-2.1-flash", prompt: "synthetic image", delivery: { mode: "response" } },
    });
    await vi.waitFor(() => expect(manager.getTask(result.tasks[0].taskId)?.status).toBe("done"));

    expect(network).toHaveBeenCalledTimes(1);
    const [url, request] = network.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://apihub.agnes-ai.com/v1/images/generations");
    expect(request.method).toBe("POST");
    expect(request.headers).toMatchObject({ Authorization: `Bearer ${FAKE_KEY}` });
    expect(JSON.parse(request.body as string)).toMatchObject({ model: "agnes-image-2.1-flash", size: "1152x768" });
    expect(manager.getTask(result.tasks[0].taskId)).toMatchObject({ providerId: "agnes", modelId: "agnes-image-2.1-flash", files: [expect.stringMatching(/\.png$/)] });
    expect(otherSubmit).not.toHaveBeenCalled();
  });

  it("retains completed and failed history and resumes only pending historical video queries after restart", async () => {
    const { manager: original, reopen, otherSubmit } = createFixture({ withDefault: true });
    const network = vi.fn(async (_url: string, _request?: RequestInit) => new Response(JSON.stringify({ status: "pending" }), { status: 200 }));
    vi.stubGlobal("fetch", network);
    for (const status of ["done", "failed", "pending"]) {
      original.store.add({
        taskId: `historic-${status}`,
        adapterTaskId: `provider-${status}`,
        adapterId: "agnes-videos",
        providerId: "agnes",
        modelId: MODEL,
        protocolId: "agnes-videos",
        batchId: "historic-batch",
        type: "video",
        prompt: "synthetic historical video",
        params: { providerId: "agnes", modelId: MODEL, model: MODEL },
        deliveryMode: "response",
      });
      original.store.update(`historic-${status}`, { status, ...(status === "done" ? { files: ["historic.mp4"] } : {}), ...(status === "failed" ? { failReason: "historical provider failure" } : {}) });
    }
    const historicalFile = path.join(original.generatedDir, "historic.mp4");
    fs.writeFileSync(historicalFile, "synthetic historical video bytes");
    expect(original.store.flushSync()).toBe(true);
    const manager = reopen();
    expect(manager.getTask("historic-done")).toMatchObject({ status: "done", files: ["historic.mp4"], modelId: MODEL });
    expect(manager.getTask("historic-failed")).toMatchObject({ status: "failed", failReason: "historical provider failure", modelId: MODEL });
    const completedBefore = structuredClone(manager.getTask("historic-done"));
    const failedBefore = structuredClone(manager.getTask("historic-failed"));

    await manager.poller.checkNow("historic-done");
    await manager.poller.checkNow("historic-failed");
    await manager.poller.checkNow("historic-pending");

    expect(network).toHaveBeenCalledTimes(1);
    expect(network.mock.calls[0][0]).toBe("https://apihub.agnes-ai.com/agnesapi?video_id=provider-pending&model_name=agnes-video-v2.0");
    expect(manager.getTask("historic-done")).toEqual(completedBefore);
    expect(manager.getTask("historic-failed")).toEqual(failedBefore);
    expect(manager.getTask("historic-pending").status).toBe("pending");
    expect(manager.listTasks({ filter: "videos" })).toHaveLength(3);
    expect(otherSubmit).not.toHaveBeenCalled();
    expect(await manager.retryImageTask("historic-failed")).toMatchObject({ ok: false, status: 400, error: "only image tasks can be retried here" });
    expect(network).toHaveBeenCalledTimes(1);
    expect(manager.getTask("historic-failed")).toEqual(failedBefore);
    expect(fs.readFileSync(historicalFile, "utf8")).toBe("synthetic historical video bytes");
  });
});
