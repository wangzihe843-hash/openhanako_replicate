import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { OpenAICompletionsOptions } from "../node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js";
import {
  AuthStorage, createAgentSession, createModelRegistry, DefaultResourceLoader,
  registerModelProvider, SessionManager, SettingsManager, Type,
} from "../lib/pi-sdk/index.ts";
import { normalizeProviderPayload } from "../core/provider-compat.ts";

type Payload = Record<string, unknown>;
type Choice = OpenAICompletionsOptions["toolChoice"];
const disposals: Array<() => void> = [];

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected DeepSeek test network request"));
});
afterEach(() => {
  try {
    expect(globalThis.fetch).not.toHaveBeenCalled();
  } finally {
    for (const dispose of disposals.splice(0).reverse()) dispose();
    vi.restoreAllMocks();
  }
});

async function capture(options: {
  choice?: Choice; level?: "high" | "off"; withTools?: boolean; plugin?: "before" | "after";
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-deepseek-chat-choice-"));
  disposals.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const registry = await createModelRegistry(AuthStorage.inMemory());
  registerModelProvider(registry, "deepseek", {
    baseUrl: "https://api.deepseek.com/v1", api: "openai-completions", apiKey: "synthetic-offline-key",
    models: [{ id: "deepseek-v4-pro", name: "Offline DeepSeek", reasoning: true, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000_000, maxTokens: 384_000 }],
  });
  const level = options.level ?? "high";
  const model = registry.find("deepseek", "deepseek-v4-pro");
  const modelBefore = structuredClone(model);
  const order: string[] = [];
  const compatInputs: Array<{ before: Payload; after: Payload }> = [];
  // Same dispatcher boundary as engine.ts's core before_provider_request hook.
  // The session, Agent onPayload, extension runner and serializer below are real.
  const core: ExtensionFactory = pi => {
    pi.on("before_provider_request", (event, ctx) => {
      order.push("compat");
      const before = structuredClone(event.payload) as Payload;
      const result = normalizeProviderPayload(event.payload, ctx.model, { mode: "chat", reasoningLevel: level });
      compatInputs.push({ before, after: structuredClone(event.payload) as Payload });
      return result;
    });
  };
  const setter: ExtensionFactory = pi => {
    pi.on("before_provider_request", event => {
      order.push("plugin");
      return { ...(event.payload as Payload), tool_choice: "none" };
    });
  };
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off",
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd: dir, agentDir: dir, settingsManager, systemPrompt: "Offline tool choice contract",
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: options.plugin === "before" ? [setter, core]
      : options.plugin === "after" ? [core, setter] : [core],
  });
  await resourceLoader.reload();
  expect(resourceLoader.getExtensions().errors).toEqual([]);
  const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "unexpected tool call" }] }));
  const { session } = await createAgentSession({
    cwd: dir, agentDir: dir, modelRegistry: registry, model, thinkingLevel: level,
    resourceLoader, settingsManager, sessionManager: SessionManager.inMemory(dir),
    tools: options.withTools === false ? [] : [{
      name: "offline_noop", label: "Offline", description: "Synthetic tool, never executed",
      parameters: Type.Object({}), execute,
    }],
  });
  disposals.push(() => session.dispose());
  const agentOnPayload = vi.spyOn(session.agent, "onPayload");
  const raw: Payload[] = [];
  const wire: Payload[] = [];
  const fetchImpl: NonNullable<SimpleStreamOptions["fetch"]> = vi.fn(async (url, init) => {
    expect(String(url)).toBe("https://api.deepseek.com/v1/chat/completions");
    wire.push(JSON.parse(String(init?.body)));
    const chunk = { id: "offline", object: "chat.completion.chunk", created: 1, model: model.id,
      choices: [{ index: 0, delta: { role: "assistant", content: "Offline response" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
      headers: { "Content-Type": "text/event-stream" },
    });
  });
  const stream = session.agent.streamFn;
  session.agent.streamFn = (requestModel, context, streamOptions) => stream(requestModel, context, {
    ...streamOptions, fetch: fetchImpl, maxRetries: 0,
    // A deliberate pre-serializer injection exercises the latent contract. The
    // ordinary Agent path does not currently supply toolChoice by itself.
    // Pi's simple type exposes only none/auto, while the installed Chat
    // serializer forwards the provider-specific required/named forms too.
    ...(options.choice === undefined ? {} : { toolChoice: options.choice as SimpleStreamOptions["toolChoice"] }),
    onPayload: async (payload, requestModel) => {
      raw.push(structuredClone(payload) as Payload);
      return streamOptions.onPayload(payload, requestModel);
    },
  });
  await session.prompt("Synthetic offline request");
  expect(agentOnPayload).toHaveBeenCalledOnce();
  expect(fetchImpl).toHaveBeenCalledOnce();
  expect(raw).toHaveLength(1);
  expect(wire).toHaveLength(1);
  expect(compatInputs).toHaveLength(1);
  expect(compatInputs[0].after).toEqual(compatInputs[0].before);
  expect(model).toEqual(modelBefore);
  expect(execute).not.toHaveBeenCalled();
  expect(session.agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
  expect(wire[0].tools).toEqual(raw[0].tools);
  expect(wire[0].messages).toEqual(raw[0].messages);
  return { raw: raw[0], wire: wire[0], order, compatInput: compatInputs[0].before };
}

describe("DeepSeek Chat through the installed serializer, Agent onPayload and dispatcher", () => {
  it.each([
    { label: "unset", choice: undefined, expected: undefined },
    { label: "none", choice: "none" as const, expected: "none" },
    { label: "auto", choice: "auto" as const, expected: "auto" },
    { label: "required", choice: "required" as const, expected: undefined },
    { label: "named", choice: { type: "function" as const, function: { name: "offline_noop" } }, expected: undefined },
  ])("sends the final thinking request for $label with its tools intact", async ({ choice, expected }) => {
    const { raw, wire, order } = await capture({ choice });
    if (choice === undefined) expect(raw).not.toHaveProperty("tool_choice");
    else expect(raw.tool_choice).toEqual(choice);
    if (expected === undefined) expect(wire).not.toHaveProperty("tool_choice");
    else expect(wire.tool_choice).toBe(expected);
    expect(wire.tools).toHaveLength(1);
    expect(wire.thinking).toEqual({ type: "enabled" });
    expect(wire.reasoning_effort).toBe("high");
    expect(order).toEqual(["compat"]);
  });

  it("preserves none with thinking off", async () => {
    const { raw, wire } = await capture({ choice: "none", level: "off" });
    expect(raw.tool_choice).toBe("none");
    expect(wire.tool_choice).toBe("none");
    expect(wire.thinking).toEqual({ type: "disabled" });
  });

  it("preserves none without tools", async () => {
    const { wire } = await capture({ choice: "none", withTools: false });
    expect(wire.tool_choice).toBe("none");
    expect(wire).not.toHaveProperty("tools");
  });

  it.each(["before", "after"] as const)("preserves a %s-compat hook's none in the final request", async plugin => {
    const { raw, wire, order, compatInput } = await capture({ plugin });
    expect(raw).not.toHaveProperty("tool_choice");
    expect(wire.tool_choice).toBe("none");
    expect(wire.tools).toHaveLength(1);
    expect(order).toEqual(plugin === "before" ? ["plugin", "compat"] : ["compat", "plugin"]);
    if (plugin === "before") expect(compatInput.tool_choice).toBe("none");
    else expect(compatInput).not.toHaveProperty("tool_choice");
  });
});
