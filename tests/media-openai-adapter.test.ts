import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openaiImageAdapter } from "../core/media-adapters/openai.ts";

const tmpDirs = [];
const SUNBURST = "gpt-image-2.5-sunburst";
const imageBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5wAAAABJRU5ErkJggg==", "base64");

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected network request"); }));
});

function makeTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openai-adapter-test-"));
  tmpDirs.push(dir);
  return dir;
}

function makeCtx(overrides = {}) {
  return {
    dataDir: makeTmpDir(),
    bus: {
      request: vi.fn(async () => ({ apiKey: "test-key", baseUrl: "https://api.openai.test/v1" })),
    },
    config: {
      get: vi.fn(() => null),
    },
    log: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("OpenAI Sunburst existing Images API subset", () => {
  function capture(data: unknown = { data: [{ b64_json: imageBytes.toString("base64") }] }) {
    const fetchMock = vi.fn(async (_endpoint: string, _init: RequestInit) => new Response(JSON.stringify(data)));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }
  function submit(params = {}, ctx = makeCtx()) {
    return openaiImageAdapter.submit({ prompt: "synthetic lantern", providerId: "openai", modelId: SUNBURST, ...params }, ctx);
  }

  it.each([
    [{}, "1536x1024"], [{ resolution: "1K" }, "1536x1024"],
    [{ ratio: "1:1", resolution: "1K" }, "1024x1024"],
    [{ ratio: "2:3", resolution: "1K" }, "1024x1536"],
    [{ size: "1024x1024", resolution: "1K", ratio: "2:3" }, "1024x1024"],
    [{ size: "auto" }, "auto"],
  ])("uses standard dimensions for %j", async (params, size) => {
    const fetchMock = capture();
    await submit(params);
    const [endpoint, init] = fetchMock.mock.calls[0]!;
    expect(endpoint).toBe("https://api.openai.test/v1/images/generations");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ model: SUNBURST, prompt: "synthetic lantern", n: 1, output_format: "jpeg", size });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    { resolution: "2K" }, { resolution: "4K" }, { size: "2048x2048" },
    { size: "1024x1024", resolution: "2K" }, { ratio: "16:9" },
    { quality: "xhigh" }, { quality: "max" }, { quality: "hd" },
    { n: 0 }, { n: -1 }, { n: 11 }, { n: 1.5 }, { n: "2" },
    { format: "gif" }, { background: "clear" }, { background: "transparent" },
    { format: "png", output_compression: 50 }, { output_compression: -1 },
    { output_compression: 101 }, { output_compression: 1.5 },
    { moderation: "none" }, { mask: "file-mask" }, { stream: true },
    { input_fidelity: "high" }, { partial_images: 1 },
    { image: Array.from({ length: 17 }, () => "file-synthetic") },
    { mode: "image2image" }, { mode: "text2image", image: "file-synthetic" },
    { image: ["file-synthetic", ""] },
  ])("rejects unsupported parameters before HTTP: %j", async params => {
    const fetchMock = capture();
    await expect(submit(params)).rejects.toThrow(/OpenAI.*(unsupported|must|requires|reference|compression|transparent)/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["auto", "low", "medium", "high"])("keeps quality %s", async quality => {
    const fetchMock = capture();
    await submit({ quality });
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1].body)).quality).toBe(quality);
  });

  it.each([
    ["png", "transparent", undefined, "png"], ["webp", "transparent", 0, "webp"],
    ["jpeg", "opaque", 100, "jpg"], ["jpeg", "auto", undefined, "jpg"],
  ])("saves base64 bytes with requested %s output", async (format, background, output_compression, extension) => {
    const ctx = makeCtx();
    const fetchMock = capture({ data: Array.from({ length: 10 }, () => ({ b64_json: imageBytes.toString("base64") })) });
    const result = await submit({ format, background, output_compression, n: 10, filename: "fixture" }, ctx);
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1].body));
    expect(body).toMatchObject({ model: SUNBURST, output_format: format, background, n: 10 });
    expect(body.output_compression).toBe(output_compression);
    expect(body).not.toHaveProperty("response_format");
    expect(new Set(result.files).size).toBe(10);
    for (const file of result.files) {
      expect(file.endsWith(`.${extension}`)).toBe(true);
      expect(fs.readFileSync(path.join(ctx.dataDir, "generated", file))).toEqual(imageBytes);
    }
  });

  it("encodes up to sixteen URL/file_id references as JSON edits without downloading", async () => {
    const fetchMock = capture();
    const refs = ["https://images.example.test/reference.png", ...Array.from({ length: 15 }, (_, i) => `file-synthetic-${i}`)];
    await submit({ image: refs });
    const [endpoint, init] = fetchMock.mock.calls[0]!;
    expect(endpoint).toBe("https://api.openai.test/v1/images/edits");
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: SUNBURST, images: refs.map(ref => ref.startsWith("https:") ? { image_url: ref } : { file_id: ref }),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sends local edit files through real FormData with runtime-owned boundary", async () => {
    const ctx = makeCtx();
    const localFile = path.join(ctx.dataDir, "reference.png");
    fs.writeFileSync(localFile, imageBytes);
    const fetchMock = capture();
    await submit({ image: [localFile], format: "png", background: "transparent", quality: "high" }, ctx);
    const [endpoint, init] = fetchMock.mock.calls[0]!;
    expect(endpoint).toBe("https://api.openai.test/v1/images/edits");
    expect(new Headers(init.headers).has("Content-Type")).toBe(false);
    expect(init.body).toBeInstanceOf(FormData);
    const form = init.body as FormData;
    expect(form.get("model")).toBe(SUNBURST);
    expect(form.get("size")).toBe("1536x1024");
    expect(form.get("output_format")).toBe("png");
    const file = form.getAll("image[]")[0] as File;
    expect([file.name, file.type]).toEqual(["reference.png", "image/png"]);
    expect(Buffer.from(await file.arrayBuffer())).toEqual(imageBytes);
    const request = new Request(endpoint, init);
    expect(request.headers.get("Content-Type")).toMatch(/^multipart\/form-data; boundary=/);
    const wire = Buffer.from(await request.arrayBuffer());
    expect(wire.includes(imageBytes)).toBe(true);
    expect(wire.toString()).toContain('name="image[]"; filename="reference.png"');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockClear();
    await expect(submit({ image: [localFile, "file-synthetic"] }, ctx)).rejects.toThrow(/reference/);
    await expect(submit({ image: `data:image/png;base64,${imageBytes.toString("base64")}` }, ctx)).rejects.toThrow(/reference/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([{}, { data: [] }, { data: {} }, null, { data: [null] }, { data: [{ b64_json: "" }] },
    { data: [{ b64_json: "invalid!base64" }] }, { data: [{ b64_json: imageBytes.toString("base64") }, {}] },
  ])("does not save or succeed with invalid image response %j", async data => {
    const ctx = makeCtx();
    const fetchMock = capture(data);
    await expect(submit({}, ctx)).rejects.toThrow(/image/i);
    expect(fs.existsSync(path.join(ctx.dataDir, "generated"))).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([400, 401, 403, 429, 500, 503])("redacts HTTP %s errors without retry or fallback", async status => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: {
      message: "Bearer synthetic-secret https://images.example.test/a?token=synthetic-token",
    } }), { status }));
    vi.stubGlobal("fetch", fetchMock);
    const error = await submit().catch(error => error);
    expect(error.message).toContain(`API error ${status}`);
    expect(error.message).not.toMatch(/synthetic-secret|synthetic-token/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(["transport", "json", "credentials"])("redacts %s failures before they leave the adapter", async boundary => {
    const ctx = makeCtx();
    const fail = async () => { throw new Error("Bearer synthetic-secret https://images.example.test/a?token=synthetic-token"); };
    const fetchMock = vi.fn(boundary === "transport" ? fail : async () => ({ ok: true, json: fail }));
    vi.stubGlobal("fetch", fetchMock);
    if (boundary === "credentials") ctx.bus.request.mockImplementation(fail);
    const error = await submit({}, ctx).catch(error => error);
    expect(error.message).not.toMatch(/synthetic-secret|synthetic-token/);
    expect(error.message).toContain("[redacted]");
    expect(fetchMock).toHaveBeenCalledTimes(boundary === "credentials" ? 0 : 1);
  });

  it("fails malformed HTTP JSON and file-save errors without returning successful files", async () => {
    const ctx = makeCtx();
    const fetchMock = vi.fn(async () => new Response("{invalid JSON"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(submit({}, ctx)).rejects.toThrow();
    expect(fs.existsSync(path.join(ctx.dataDir, "generated"))).toBe(false);
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ data: [{ b64_json: imageBytes.toString("base64") }] })));
    fs.writeFileSync(path.join(ctx.dataDir, "generated"), "fixture blocks output directory");
    await expect(submit({}, ctx)).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("redacts revised-prompt diagnostics and keeps custom-provider Sunburst protocol behavior", async () => {
    const ctx = makeCtx();
    const fetchMock = capture({ data: [{ b64_json: imageBytes.toString("base64"), revised_prompt: "Bearer synthetic-secret" }] });
    await submit({}, ctx);
    expect(JSON.stringify(ctx.log.info.mock.calls)).not.toContain("synthetic-secret");
    await submit({ providerId: "custom-proxy", resolution: "2K", quality: "xhigh" }, ctx);
    const body = JSON.parse(String(fetchMock.mock.calls[1]![1].body));
    expect(body).toMatchObject({ model: SUNBURST, size: "2048x1360", quality: "xhigh" });
  });
});

describe("openaiImageAdapter", () => {
  it("logs revised_prompt through object-style ctx.log without blocking image save", async () => {
    const ctx = makeCtx();
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: [{
          b64_json: Buffer.from("image-bytes").toString("base64"),
          revised_prompt: "a clearer generated prompt",
        }],
      }),
    })));

    const result = await openaiImageAdapter.submit({
      prompt: "draw a lantern",
      model: "gpt-image-1.5",
      filename: "lantern",
    }, ctx);

    expect(ctx.log.info).toHaveBeenCalledWith("[openai-image] revised_prompt: a clearer generated prompt");
    expect(result.files).toHaveLength(1);
    expect(fs.existsSync(path.join(ctx.dataDir, "generated", result.files[0]))).toBe(true);
  });

  it("keeps custom provider model ids verbatim instead of resolving them against the OpenAI catalog", async () => {
    const ctx = makeCtx({
      bus: {
        request: vi.fn(async () => ({ apiKey: "proxy-key", baseUrl: "https://proxy.example.test/v1" })),
      },
      config: {
        get: vi.fn((key) => key === "providerDefaults" ? { "my-proxy": { quality: "high" } } : null),
      },
    });
    const fetchMock = vi.fn(async (_url: string, _init: { body: string }) => ({
      ok: true,
      json: async () => ({ data: [{ b64_json: Buffer.from("image-bytes").toString("base64") }] }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await openaiImageAdapter.submit({
      prompt: "draw a lantern",
      providerId: "my-proxy",
      credentialProviderId: "my-proxy",
      modelId: "flux-1.1-pro",
    }, ctx);

    expect(ctx.bus.request).toHaveBeenCalledWith("provider:credentials", { providerId: "my-proxy" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [endpoint, init] = fetchMock.mock.calls[0]!;
    expect(endpoint).toBe("https://proxy.example.test/v1/images/generations");
    const body = JSON.parse(init.body);
    // 自定义模型 id 不允许被改写成 OpenAI catalog 的默认模型
    expect(body.model).toBe("flux-1.1-pro");
    // provider 级默认按实际 providerId 取，不再硬编码 "openai"
    expect(body.quality).toBe("high");
  });

  it("still resolves OpenAI catalog aliases for the built-in openai provider", async () => {
    const ctx = makeCtx();
    const fetchMock = vi.fn(async (_url: string, _init: { body: string }) => ({
      ok: true,
      json: async () => ({ data: [{ b64_json: Buffer.from("image-bytes").toString("base64") }] }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await openaiImageAdapter.submit({
      prompt: "draw a lantern",
      providerId: "openai",
      modelId: "1.5",
    }, ctx);

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.model).toBe("gpt-image-1.5");
  });
});
