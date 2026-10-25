import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage, createModelRegistry } from "../lib/pi-sdk/index.ts";
import { getModelRuntime } from "../lib/pi-sdk/model-runtime.ts";
import { syncModels } from "../core/model-sync.ts";
import { normalizeProviderPayload } from "../core/provider-compat.ts";
import { normalizeModelProtocolCompat } from "../shared/model-capabilities.ts";
import { callText } from "../core/llm-client.ts";
import { matches } from "../core/provider-compat/ollama.ts";

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function fixture(extra: Record<string, unknown> = {}, provider = "ollama", api = "openai-completions") {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected network request"); }));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-ollama-request-"));
  dirs.push(dir);
  const file = path.join(dir, "models.json");
  const source = { [provider]: { base_url: "http://127.0.0.1:11434/v1", api, auth_type: "none",
    models: [{ id: "qwen3:8b", context: 8192, maxOutput: 64, reasoning: true, ...extra }] } };
  const before = structuredClone(source);
  syncModels(source, { modelsJsonPath: file });
  expect(source).toEqual(before);
  const projected = JSON.parse(fs.readFileSync(file, "utf8")).providers[provider].models[0];
  const registry = await createModelRegistry(AuthStorage.inMemory(), file);
  const model = registry.find(provider, "qwen3:8b")!;
  expect(model).toBeDefined();
  return { model, projected, runtime: getModelRuntime(registry) };
}

async function sdkRequest(extra: Record<string, unknown> = {}, provider = "ollama", reasoning = "off", api = "openai-completions") {
  const { model, projected, runtime } = await fixture(extra, provider, api);
  const requests: Request[] = [];
  const fetchMock = async (input, init) => {
    requests.push(new Request(input, init));
    return new Response(JSON.stringify({ error: { message: "INTENTIONAL_REQUEST_CAPTURE" } }), {
      status: 400, headers: { "content-type": "application/json" },
    });
  };
  vi.stubGlobal("fetch", fetchMock);
  const output = await runtime.streamSimple(model, {
    messages: [{ role: "user", content: [{ type: "text", text: "Synthetic 17+25" }], timestamp: 1 }],
  }, {
    apiKey: "synthetic-only", fetch: fetchMock, maxRetries: 0, maxTokens: 32, reasoning,
    onPayload: payload => normalizeProviderPayload(payload, model, { mode: "chat", reasoningLevel: reasoning, outputBudgetSource: "user" }),
  } as Parameters<typeof runtime.streamSimple>[2]).result();
  expect(output.stopReason).toBe("error");
  expect(requests).toHaveLength(1);
  return { body: await requests[0].json(), model, projected };
}

const localModel = (extra = {}) => ({ id: "qwen3:8b", provider: "ollama", api: "openai-completions",
  baseUrl: "http://127.0.0.1:11434/v1", reasoning: true, maxTokens: 64, ...extra });

describe("Ollama final request contract", () => {
  it.each([undefined, { outputCapField: "max_tokens", maxTokensField: "max_completion_tokens" }])(
    "normalizes configuration through the real Pi serializer and final hook: %j", async compat => {
      const { body, projected } = await sdkRequest(compat ? { compat } : {});
      expect(body).toMatchObject({ model: "qwen3:8b", max_tokens: 32, reasoning_effort: "none" });
      expect(body).not.toHaveProperty("max_completion_tokens");
      expect(projected.compat).not.toHaveProperty("maxTokensField");
      if (compat) expect(projected.compat.outputCapField).toBe("max_tokens");
    });

  it.each(["max_tokens", "max_completion_tokens", "max_output_tokens", "maxOutputTokens"])(
    "honors the existing explicit outputCapField %s", async field => {
      const { body } = await sdkRequest({ compat: { outputCapField: field } });
      expect(body[field]).toBe(32);
      for (const other of ["max_tokens", "max_completion_tokens", "max_output_tokens", "maxOutputTokens"]) {
        if (other !== field) expect(body).not.toHaveProperty(other);
      }
    });

  it.each([undefined, { low: "medium" }, { off: "none" }, { off: "custom-off" }])(
    "honors explicit off mappings after the generic disabled-effort cleanup: %j", async map => {
      const { body } = await sdkRequest(map ? { thinkingLevelMap: map } : {});
      expect(body.reasoning_effort).toBe(map?.off || "none");
    });

  it("keeps the SDK clamp for an explicitly unsupported off level", async () => {
    const { body } = await sdkRequest({ thinkingLevelMap: { off: null, minimal: null } });
    expect(body.reasoning_effort).toBe("low");
  });

  it.each(["low", "medium", "high", "auto"])("does not force thinking off for %s", async level => {
    const { body } = await sdkRequest({}, "ollama", level);
    if (level === "auto") expect(body).not.toHaveProperty("reasoning_effort");
    else expect(body.reasoning_effort).toBe(level);
  });

  it.each(["chat", "utility"])("takes the smaller conflicting cap without mutating %s input", mode => {
    const payload = Object.freeze({ messages: [], max_tokens: 19, max_completion_tokens: 32 });
    const body = normalizeProviderPayload(payload, localModel(), { mode, reasoningLevel: "off" });
    expect(body).toMatchObject({ max_tokens: 19, reasoning_effort: "none" });
    expect(body).not.toHaveProperty("max_completion_tokens");
    expect(payload).toEqual({ messages: [], max_tokens: 19, max_completion_tokens: 32 });
  });

  it("uses chat defaults when mode is omitted", () => {
    expect(normalizeProviderPayload({ messages: [] }, localModel(), { reasoningLevel: "off" }).reasoning_effort).toBe("none");
  });

  it.each([null, "custom-off"])("honors utility off override %j", off => {
    const payload = Object.freeze({ messages: [], max_tokens: 32 });
    const body = normalizeProviderPayload(payload, localModel({ thinkingLevelMap: { off } }), { mode: "utility" });
    if (off === null) expect(body).not.toHaveProperty("reasoning_effort");
    else expect(body.reasoning_effort).toBe(off);
    expect(payload).not.toHaveProperty("reasoning_effort");
  });

  it.each([
    [null, false], [undefined, false], [{}, false],
    [{ provider: "ollama" }, false],
    [{ provider: "OLLAMA", api: "openai-completions" }, true],
    [{ provider: "ollama", api: "openai-responses" }, false],
    [{ provider: "ollama", api: "OPENAI-COMPLETIONS" }, false],
    [{ provider: "custom", api: "openai-completions", baseUrl: "http://127.0.0.1:11434/v1" }, false],
  ])("matches only an explicit Ollama transport %j", (model, expected) => {
    expect(matches(model)).toBe(expected);
  });

  it.each([[32, 19], [19, 32]])("takes the smaller alias in either order %j/%j", (max_tokens, max_completion_tokens) => {
    expect(normalizeProviderPayload({ messages: [], max_tokens, max_completion_tokens }, localModel(), { mode: "utility" }).max_tokens).toBe(19);
  });

  it("keeps smaller SDK context budgets and the shared model output bound", () => {
    for (const [cap, expected] of [[7, 7], [200, 64]]) {
      const body = normalizeProviderPayload({ messages: [], max_completion_tokens: cap }, localModel(), { mode: "chat", reasoningLevel: "off" });
      expect(body.max_tokens).toBe(expected);
    }
  });

  it.each([{ quirks: ["enable_thinking"] }, { id: "mimo-v2.5", compat: { reasoningProfile: "mimo-openai" } }])(
    "uses Ollama transport before inferred model family controls %j", extra => {
      const body = normalizeProviderPayload({ messages: [], max_completion_tokens: 32 }, localModel(extra), { mode: "chat", reasoningLevel: "off" });
      expect(body).toMatchObject({ max_tokens: 32, reasoning_effort: "none" });
      expect(body).not.toHaveProperty("enable_thinking");
      expect(body).not.toHaveProperty("chat_template_kwargs");
    });

  it("disables thinking for a non-reasoning Ollama declaration", () => {
    expect(normalizeProviderPayload({ messages: [] }, localModel({ reasoning: false }), { mode: "chat", reasoningLevel: "medium" }).reasoning_effort).toBe("none");
  });

  it("does not infer off from an omitted chat reasoning level", () => {
    const body = normalizeProviderPayload({ messages: [], max_completion_tokens: 32 }, localModel(), { mode: "chat" });
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  it("keeps other providers on the same model and loopback endpoint unchanged", async () => {
    const { body } = await sdkRequest({ compat: { outputCapField: "max_tokens" } }, "custom");
    expect(body.max_completion_tokens).toBe(32);
    expect(body).not.toHaveProperty("max_tokens");
    expect(body).not.toHaveProperty("reasoning_effort");
    expect(normalizeModelProtocolCompat({ outputCapField: "max_tokens", maxTokensField: "max_tokens" })).toEqual({ outputCapField: "max_tokens" });
  });

  it("does not apply Ollama rules to its Responses API override", async () => {
    const { body } = await sdkRequest({}, "ollama", "off", "openai-responses");
    expect(body.max_output_tokens).toBe(32);
    expect(body).not.toHaveProperty("max_tokens");
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  it.each([32, undefined])("runs the real callText utility path with budget %j", async maxTokens => {
    const { model } = await fixture();
    const requests: Request[] = [];
    vi.stubGlobal("fetch", async (input, init) => {
      requests.push(new Request(input, init));
      return new Response(JSON.stringify({ choices: [{ message: { content: "42" } }] }), { headers: { "content-type": "application/json" } });
    });
    await expect(callText({ api: model.api, baseUrl: model.baseUrl, model: { ...model }, messages: [{ role: "user", content: "Synthetic 17+25" }],
      maxTokens, timeoutMs: 1000 })).resolves.toBe("42");
    expect(requests).toHaveLength(1);
    const body = await requests[0].json();
    expect(body.reasoning_effort).toBe("none");
    if (maxTokens === undefined) expect(body).not.toHaveProperty("max_tokens");
    else expect(body.max_tokens).toBe(32);
    expect(body).not.toHaveProperty("max_completion_tokens");
  });
});
