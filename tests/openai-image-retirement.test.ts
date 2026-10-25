import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openaiImageAdapter } from "../core/media-adapters/openai.ts";
import { retryImageTask } from "../core/media/image-task-runner.ts";
import { TaskStore } from "../core/media/task-store.ts";

const roots: string[] = [];
const secret = "synthetic-retirement-test-secret";
const captureMessage = "OFFLINE_REQUEST_CAPTURE";

function fixture(baseUrl = "https://api.openai.com/v1") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-openai-retirement-"));
  roots.push(root);
  const fetchMock = vi.fn(async (_endpoint: string, _init: { body: string }) => {
    throw new Error(captureMessage);
  });
  vi.stubGlobal("fetch", fetchMock);
  const ctx = {
    dataDir: root,
    config: { get: vi.fn((_key: string) => null) },
    bus: { request: vi.fn(async () => ({ apiKey: secret, baseUrl })) },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  return { root, ctx, fetchMock };
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("official OpenAI image model retirement", () => {
  it.each([
    { model: "gpt-image-1", date: "2026-10-23" },
    { model: "1", date: "2026-10-23" },
    { model: "dall-e-3", date: "2026-05-12" },
    { model: "dalle3", date: "2026-05-12" },
    { model: "DALLE3", date: "2026-05-12" },
  ])("rejects $model generation and editing before any fetch", async ({ model, date }) => {
    const { root, ctx, fetchMock } = fixture();
    for (const image of [undefined, "https://reference.example.test/image.png", "/private/reference.png"]) {
      await expect(openaiImageAdapter.submit({ prompt: "test", model, image }, ctx))
        .rejects.toThrow(new RegExp(`retired.*${date}`));
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fs.readdirSync(root)).toEqual([]);
    expect(ctx.log.info).not.toHaveBeenCalled();
  });

  it.each([
    "https://api.openai.com/v1///",
    "https://API.OPENAI.COM:443/v1/",
    "https://api.openai.com/unused/../v1",
    `https://unused:${secret}@api.openai.com/v1`,
  ])("recognizes the normalized official target without echoing credentials (%s)", async baseUrl => {
    const { ctx, fetchMock } = fixture(baseUrl);
    const error = await openaiImageAdapter.submit({ prompt: "test", modelId: "1" }, ctx).catch(error => error);
    expect(error.message).toContain('"gpt-image-1"');
    expect(error.message).toMatch(/retired.*2026-10-23/);
    expect(error.message).not.toContain(secret);
    expect(error.message).not.toContain(baseUrl);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("checks the effective credential endpoint even for a custom provider", async () => {
    const { ctx, fetchMock } = fixture();
    await expect(openaiImageAdapter.submit({
      prompt: "test", providerId: "custom", credentialProviderId: "official-key", modelId: "gpt-image-1",
    }, ctx)).rejects.toThrow(/retired.*2026-10-23/);
    expect(ctx.bus.request).toHaveBeenCalledWith("provider:credentials", { providerId: "official-key" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    "https://proxy.example.test/v1",
    "https://api.openai.com.proxy.example.test/v1",
    "https://proxy.example.test/api.openai.com/v1",
    "https://api.openai.com@proxy.example.test/v1",
    "https://api.openai.com:8443/v1",
    "http://api.openai.com/v1",
    "https://api.openai.com/custom/v1",
    "https://api.openai.com/v1?route=",
  ])("preserves same-name models on other origins or paths (%s)", async baseUrl => {
    const { ctx, fetchMock } = fixture(baseUrl);
    for (const model of ["gpt-image-1", "dall-e-3"]) {
      await expect(openaiImageAdapter.submit({ prompt: "test", model }, ctx)).rejects.toThrow(captureMessage);
      const [endpoint, init] = fetchMock.mock.calls.at(-1)!;
      expect(endpoint).toBe(`${baseUrl}/images/generations`);
      expect(JSON.parse(init.body).model).toBe(model);
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(["gpt-image-1.5", "1.5", "gpt-image-1-mini", "mini", "1-mini"])(
    "keeps currently supported %s generation and editing targets", async model => {
      const { ctx, fetchMock } = fixture();
      for (const image of [undefined, "https://reference.example.test/image.png"]) {
        await expect(openaiImageAdapter.submit({ prompt: "test", model, image }, ctx)).rejects.toThrow(captureMessage);
      }
      expect(fetchMock.mock.calls.map(([endpoint]) => endpoint)).toEqual([
        "https://api.openai.com/v1/images/generations", "https://api.openai.com/v1/images/edits",
      ]);
      const expectedModel = ["gpt-image-1.5", "1.5"].includes(model) ? "gpt-image-1.5" : "gpt-image-1-mini";
      for (const [, init] of fetchMock.mock.calls) expect(JSON.parse(init.body).model).toBe(expectedModel);
    },
  );

  it("preserves custom-provider model IDs and proxy image edits", async () => {
    const { ctx, fetchMock } = fixture("https://proxy.example.test/v1");
    for (const modelId of ["gpt-image-1", "dall-e-3", "1"]) {
      const image = modelId === "dall-e-3" ? undefined : "file-synthetic-reference";
      await expect(openaiImageAdapter.submit({ prompt: "test", providerId: "custom", modelId, image }, ctx))
        .rejects.toThrow(captureMessage);
      const [endpoint, init] = fetchMock.mock.calls.at(-1)!;
      expect(endpoint).toBe(`https://proxy.example.test/v1/images/${image ? "edits" : "generations"}`);
      expect(JSON.parse(init.body).model).toBe(modelId);
    }
  });

  it.each(["gpt-image-1-custom", "gpt-image-1.5-2025-12-16", "dall-e-3-custom", "GPT-IMAGE-1", "toString"])(
    "does not treat custom model %s as an exact retired ID", async modelId => {
      const { ctx, fetchMock } = fixture();
      await expect(openaiImageAdapter.submit({ prompt: "test", providerId: "custom", modelId }, ctx))
        .rejects.toThrow(captureMessage);
      expect(JSON.parse(fetchMock.mock.calls[0]![1].body).model).toBe(modelId);
    },
  );

  it("preserves the implicit model and blocks an explicit saved old selection without rewriting it", async () => {
    const { ctx, fetchMock } = fixture();
    await expect(openaiImageAdapter.submit({ prompt: "test" }, ctx)).rejects.toThrow(captureMessage);
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).model).toBe("gpt-image-1.5");
    fetchMock.mockClear();
    const saved = { provider: "openai", id: "gpt-image-1" };
    ctx.config.get.mockImplementation(key => key === "defaultImageModel" ? saved : null);
    await expect(openaiImageAdapter.submit({ prompt: "test" }, ctx)).rejects.toThrow(/retired.*2026-10-23/);
    expect(saved).toEqual({ provider: "openai", id: "gpt-image-1" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["gpt-image-1", "dall-e-3"])("reads persisted %s history and rejects retry without network or model substitution", async modelId => {
    const { root, ctx, fetchMock } = fixture();
    const store = new TaskStore(root);
    store.add({ taskId: "old-task", batchId: "old-batch", adapterId: "openai", type: "image", prompt: "old prompt",
      providerId: "openai", modelId, params: { prompt: "old prompt", modelId }, deliveryMode: "response" });
    store.update("old-task", { status: "done", files: ["historical.png"] });
    store.flushSync();
    const loaded = new TaskStore(root);
    const history = loaded.get("old-task");
    expect(history).toMatchObject({ status: "done", modelId, files: ["historical.png"] });
    expect(loaded.listAll().find(task => task.taskId === "old-task")).toMatchObject({ modelId });
    expect(fetchMock).not.toHaveBeenCalled();
    loaded.update("old-task", { status: "failed" });
    const poller = { add: vi.fn(), checkNow: vi.fn() };
    const result = await retryImageTask({ taskId: "old-task", ctx: {
      ...ctx, _mediaGen: { store: loaded, registry: { get: () => openaiImageAdapter }, poller },
    } });
    expect(result.ok).toBe(true);
    await vi.waitFor(() => expect(loaded.get("old-task")).toMatchObject({
      status: "failed", submitState: "failed", modelId, failReason: expect.stringMatching(/retired/),
      params: expect.objectContaining({ modelId, model: modelId }),
    }));
    expect(fetchMock).not.toHaveBeenCalled();
    store.flushSync();
    loaded.flushSync();
  });
});
