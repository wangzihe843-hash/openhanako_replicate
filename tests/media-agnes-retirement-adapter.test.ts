import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agnesVideoAdapter } from "../core/media-adapters/agnes.ts";

const MODEL = "agnes-video-v2.0";
const roots: string[] = [];
function context(baseUrl?: string, defaults = {}, videoDefaults?: object) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-agnes-guard-"));
  roots.push(root);
  return {
    dataDir: root,
    bus: { request: vi.fn(async () => ({ apiKey: "synthetic-secret-key", baseUrl })) },
    config: { get: () => ({ agnes: defaults }) },
    ...(videoDefaults ? { videoConfig: { get: () => ({ agnes: videoDefaults }) } } : {}),
  };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Agnes retirement at the actual HTTP submission boundary", () => {
  it.each([
    undefined,
    "https://apihub.agnes-ai.com",
    "https://apihub.agnes-ai.com/",
    "https://apihub.agnes-ai.com/v1",
    "https://apihub.agnes-ai.com/v1///",
    "https://APIHUB.AGNES-AI.COM:443/v1",
    "https://apihub.agnes-ai.com/proxy/../v1",
    "https://synthetic-user:synthetic-password@apihub.agnes-ai.com/v1",
  ])("blocks the retired default model at official target %s without HTTP or local image reads", async (baseUrl) => {
    const ctx = context(baseUrl);
    const image = path.join(ctx.dataDir, "private-fixture.png");
    fs.writeFileSync(image, "synthetic-private-image");
    const read = vi.spyOn(fs, "readFileSync");
    const network = vi.fn(async (_url: string, _request?: RequestInit) => new Response(JSON.stringify({ task_id: "unexpected-task" })));
    vi.stubGlobal("fetch", network);
    const error = await agnesVideoAdapter.submit({ prompt: "synthetic", image }, ctx).then(() => null, (err: Error) => err);
    expect(error).toBeInstanceOf(Error);
    expect(error!.message).toMatch(/agnes-video-v2\.0.*retired|retired.*agnes-video-v2\.0/i);
    for (const secret of ["synthetic-secret-key", "synthetic-user", "synthetic-password", image]) expect(error!.message).not.toContain(secret);
    expect(network).not.toHaveBeenCalled();
    expect(read.mock.calls.some(([file]) => file === image)).toBe(false);
  });

  it.each([
    { params: { modelId: MODEL }, defaults: {} },
    { params: { model: MODEL }, defaults: {} },
    { params: {}, defaults: { model: MODEL } },
    { params: {}, defaults: { model: "synthetic-compatible-model" }, videoDefaults: { model: MODEL } },
  ])("blocks the effective model from every existing parameter/default source: %j", async ({ params, defaults, videoDefaults }) => {
    const network = vi.fn(async (_url: string, _request?: RequestInit) => new Response(JSON.stringify({ task_id: "unexpected-task" })));
    vi.stubGlobal("fetch", network);
    await expect(agnesVideoAdapter.submit({ prompt: "synthetic", ...params }, context(undefined, defaults, videoDefaults))).rejects.toThrow(/retired/i);
    expect(network).not.toHaveBeenCalled();
  });

  it.each([
    ["https://compatible.example/v1", "https://compatible.example/v1/videos"],
    ["https://apihub.agnes-ai.com.compatible.example/v1", "https://apihub.agnes-ai.com.compatible.example/v1/videos"],
    ["https://sub.apihub.agnes-ai.com/v1", "https://sub.apihub.agnes-ai.com/v1/videos"],
    ["https://apihub.agnes-ai.com:8443/v1", "https://apihub.agnes-ai.com:8443/v1/videos"],
    ["http://apihub.agnes-ai.com/v1", "http://apihub.agnes-ai.com/v1/videos"],
    ["https://apihub.agnes-ai.com/proxy/v1", "https://apihub.agnes-ai.com/proxy/v1/videos"],
  ])("preserves compatible target %s without applying the official retirement claim", async (baseUrl, endpoint) => {
    const network = vi.fn(async (_url: string, _request?: RequestInit) => new Response(JSON.stringify({ task_id: "synthetic-task", video_id: "synthetic-video" })));
    vi.stubGlobal("fetch", network);
    const result = await agnesVideoAdapter.submit({ prompt: "synthetic", modelId: MODEL }, context(baseUrl));
    expect(network).toHaveBeenCalledTimes(1);
    expect(network.mock.calls[0][0]).toBe(endpoint);
    const request = network.mock.calls[0][1] as RequestInit;
    expect(request.method).toBe("POST");
    expect(JSON.parse(request.body as string)).toMatchObject({ model: MODEL, width: 1152, height: 768, frame_rate: 24, num_frames: 121 });
    expect(result).toEqual({ taskId: "synthetic-task", providerTaskId: "synthetic-video" });
  });

  it("does not rewrite a different explicit model to the retired default", async () => {
    const network = vi.fn(async (_url: string, _request?: RequestInit) => new Response(JSON.stringify({ task_id: "synthetic-task" })));
    vi.stubGlobal("fetch", network);
    await agnesVideoAdapter.submit({ prompt: "synthetic", modelId: "synthetic-compatible-model" }, context());
    expect(network).toHaveBeenCalledTimes(1);
    expect(JSON.parse(network.mock.calls[0][1].body as string).model).toBe("synthetic-compatible-model");
  });
});
