import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream, getCurrentTools, type AssistantMessage, type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  AuthStorage, createAgentSession, createModelRegistry, DefaultResourceLoader,
  registerModelProvider, SessionManager, SettingsManager, Type, type AgentEvent, type AgentTool,
} from "../lib/pi-sdk/index.ts";
import { getPiCodingAgentVersion } from "../lib/pi-sdk/session-options.ts";

const disposals: Array<() => void> = [];
const timestamp = "2026-09-01T00:00:00.000Z";
const usage = {
  input: 3, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 5,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

beforeEach(() => { vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected Pi compatibility network request")); });
afterEach(() => {
  try { expect(globalThis.fetch).not.toHaveBeenCalled(); }
  finally {
    for (const dispose of disposals.splice(0).reverse()) dispose();
    vi.restoreAllMocks();
  }
});

function directory() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-pi14-v3-"));
  disposals.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function assistant(content: AssistantMessage["content"], stopReason: "stop" | "toolUse" = "stop"): AssistantMessage {
  return { role: "assistant", content, stopReason, provider: "hana-v3-fixture", model: "offline",
    api: "openai-completions", timestamp: 2, usage };
}

function legacyFile(dir: string) {
  // Written explicitly as old v3 JSONL, without using the installed version's writer.
  const header = { type: "session", version: 3, id: "legacy-v3-tool-session", timestamp, cwd: dir };
  const messages = [
    { role: "system", content: "Legacy persona", tools: [{ name: "obsolete_tool", description: "Old tool", parameters: { type: "object" } }], timestamp: 0 },
    { role: "user", content: [{ type: "text", text: "summarized old question" }], timestamp: 1 },
    assistant([{ type: "text", text: "summarized old answer" }]),
    { role: "user", content: [{ type: "text", text: "retained question" }], timestamp: 3 },
    assistant([{ type: "toolCall", id: "legacy-call", name: "read", arguments: { path: "fixture.txt" } }], "toolUse"),
    { role: "toolResult", toolCallId: "legacy-call", toolName: "read", isError: true, durationMs: 27,
      content: [{ type: "text", text: "legacy permission denied" }], details: { errorCode: "TOOL_DENIED", receipt: { retained: true } }, timestamp: 4 },
    assistant([{ type: "text", text: "abandoned sibling answer" }]),
  ];
  const entries = [
    { type: "model_change", id: "model-v3", parentId: null, timestamp, provider: "hana-v3-fixture", modelId: "offline" },
    { type: "thinking_level_change", id: "thinking-v3", parentId: "model-v3", timestamp, thinkingLevel: "off" },
    ...messages.map((message, index) => ({ type: "message", id: `legacy-${index}`,
      parentId: index ? `legacy-${index - 1}` : "thinking-v3", timestamp, message })),
    // The last append selects a sibling branch; the abandoned answer stays on disk.
    { type: "message", id: "selected-leaf", parentId: "legacy-5", timestamp,
      message: assistant([{ type: "text", text: "selected sibling answer" }]) },
  ];
  const file = path.join(dir, "old-v3.jsonl");
  const original = [header, ...entries].map(entry => JSON.stringify(entry)).join("\n") + "\n";
  fs.writeFileSync(file, original);
  return { file, original, manager: SessionManager.open(file, dir) };
}

async function runtime(manager: SessionManager, options: {
  execute?: AgentTool["execute"];
  extensions?: ExtensionFactory[];
} = {}) {
  const dir = manager.getCwd();
  const requests: TranscriptContext[] = [];
  const responses: AssistantMessage[] = [];
  const registry = await createModelRegistry(AuthStorage.inMemory());
  registerModelProvider(registry, "hana-v3-fixture", {
    baseUrl: "https://example.invalid/v1", api: "openai-completions", apiKey: "synthetic-only",
    models: [{ id: "offline", name: "Offline", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 4096 }],
    streamSimple: (_model, context) => {
      requests.push(structuredClone(context));
      const message = responses.shift() ?? assistant([{ type: "text", text: "offline reply" }]);
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
      stream.end(message);
      return stream;
    },
  });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
  const resourceLoader = new DefaultResourceLoader({
    cwd: dir, agentDir: dir, settingsManager, systemPrompt: "Restored fixture persona",
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: options.extensions,
  });
  await resourceLoader.reload();
  expect(resourceLoader.getExtensions().errors).toEqual([]);
  const execute = vi.fn(options.execute ?? (async () => ({
    content: [{ type: "text", text: "current permission denied" }], isError: true,
    structuredContent: { allowed: false }, details: { errorCode: "TOOL_DENIED" },
  })));
  const { session } = await createAgentSession({
    cwd: dir, agentDir: dir, modelRegistry: registry, model: registry.find("hana-v3-fixture", "offline"),
    resourceLoader, settingsManager, sessionManager: manager,
    tools: [{ name: "read", label: "Read", description: "Read only the synthetic fixture", parameters: Type.Object({}), execute }],
  });
  disposals.push(() => session.dispose());
  return { session, requests, responses, execute };
}

describe("Pi 1.4.0 old-v3 session and tool compatibility", () => {
  it("runs against the exact formal candidate", () => { expect(getPiCodingAgentVersion()).toBe("1.4.0"); });

  it("opens a v3 selected leaf without rewriting, preserving complete paired tool projection", () => {
    const { manager, file, original } = legacyFile(directory());
    expect(manager.getHeader()).toMatchObject({ version: 3, id: "legacy-v3-tool-session" });
    expect(manager.getLeafId()).toBe("selected-leaf");
    const projection = manager.buildSessionProjection();
    expect(projection.messages).toEqual(manager.buildSessionContext().messages);
    const callEntry = projection.entries.find(entry => entry.sourceEntry.id === "legacy-4");
    expect(callEntry.messages).toEqual([assistant([{ type: "toolCall", id: "legacy-call", name: "read", arguments: { path: "fixture.txt" } }], "toolUse")]);
    const resultEntry = projection.entries.find(entry => entry.sourceEntry.id === "legacy-5");
    expect(resultEntry.messages).toEqual([(manager.getEntry("legacy-5") as { message: unknown }).message]);
    expect(resultEntry.messages[0]).toMatchObject({ toolCallId: "legacy-call", toolName: "read", isError: true, durationMs: 27,
      details: { errorCode: "TOOL_DENIED", receipt: { retained: true } } });
    expect(JSON.stringify(projection.messages)).toContain("selected sibling answer");
    expect(JSON.stringify(projection.messages)).not.toContain("abandoned sibling answer");
    expect(manager.getEntry("legacy-6")).toBeDefined();
    expect(fs.readFileSync(file, "utf8")).toBe(original);
  });

  it("reopens a new branch with its leaf, model and source history intact", () => {
    const { manager, file, original } = legacyFile(directory());
    manager.branch("legacy-3");
    expect(manager.getLeafId()).toBe("legacy-3");
    const branchLeaf = manager.appendMessage({ role: "user", content: "new selected branch", timestamp: 10 });
    const reopened = SessionManager.open(file, path.dirname(file));
    expect(reopened.getSessionId()).toBe(manager.getSessionId());
    expect(reopened.getLeafId()).toBe(branchLeaf);
    expect(reopened.getEntry(branchLeaf)).toMatchObject({ parentId: "legacy-3" });
    expect(reopened.buildSessionContext().model).toEqual({ provider: "hana-v3-fixture", modelId: "offline" });
    expect(JSON.stringify(reopened.buildSessionContext().messages)).toContain("new selected branch");
    expect(JSON.stringify(reopened.buildSessionContext().messages)).not.toMatch(/legacy permission denied|sibling answer/);
    expect(reopened.getEntry("legacy-5")).toBeDefined();
    expect(fs.readFileSync(file, "utf8").startsWith(original)).toBe(true);
  });

  it("retains tool pairs and append-only context edits through two compaction checkpoints and cold reopen", () => {
    const { manager, file, original } = legacyFile(directory());
    manager.appendContextEdit("legacy-5", { content: [{ type: "text", text: "edited visible result" }] });
    const checkpoint = manager.appendCompaction("first old-v3 checkpoint", "legacy-3", 8000, { fixture: true }, true);
    const cold = SessionManager.open(file, path.dirname(file));
    const visible = cold.buildSessionProjection();
    expect(visible.entries[0].sourceEntry.id).toBe(checkpoint);
    expect(JSON.stringify(visible.messages)).not.toMatch(/summarized old question|summarized old answer|legacy permission denied|abandoned sibling answer/);
    expect(visible.messages.find(message => message.role === "toolResult")).toMatchObject({
      toolCallId: "legacy-call", isError: true, durationMs: 27, content: [{ type: "text", text: "edited visible result" }],
      details: { errorCode: "TOOL_DENIED", receipt: { retained: true } },
    });
    expect(cold.getEntry("legacy-5")).toMatchObject({ message: { content: [{ type: "text", text: "legacy permission denied" }] } });
    cold.appendCompaction("second old-v3 checkpoint", "legacy-3", 7000, { fixture: true }, true);
    const second = SessionManager.open(file, path.dirname(file));
    const projection = second.buildSessionProjection();
    expect(projection.messages.filter(message => message.role === "compactionSummary")).toHaveLength(1);
    expect(JSON.stringify(projection.messages)).toContain("second old-v3 checkpoint");
    expect(JSON.stringify(projection.messages)).not.toContain("first old-v3 checkpoint");
    expect(projection.entries.find(entry => entry.sourceEntry.id === checkpoint).messages).toEqual([]);
    expect(second.getBranch().filter(entry => entry.type === "compaction")).toHaveLength(2);
    expect(fs.readFileSync(file, "utf8").startsWith(original)).toBe(true);
  });

  it("uses the restored sandbox tools and excludes a late unlisted extension from execution and requests", async () => {
    const { manager, file, original } = legacyFile(directory());
    let extensionApi: ExtensionAPI;
    const extension: ExtensionFactory = pi => { extensionApi = pi; };
    const { session, responses, requests, execute } = await runtime(manager, { extensions: [extension] });
    const forbidden = vi.fn(async () => ({ content: [{ type: "text" as const, text: "forbidden" }], details: {} }));
    const toolResults: Array<Extract<AgentEvent, { type: "tool_execution_end" }>> = [];
    session.subscribe(event => { if (event.type === "tool_execution_end") toolResults.push(event); });
    await session.prompt("first restored turn");
    extensionApi.registerTool({ name: "late_unlisted", label: "Unlisted", description: "Must remain outside the sandbox allowlist",
      parameters: Type.Object({}), execute: forbidden });
    responses.push(assistant([{ type: "toolCall", id: "restored-call", name: "read", arguments: {} }], "toolUse"));
    await session.prompt("use the configured restored tool");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(forbidden).not.toHaveBeenCalled();
    for (const request of requests) expect(getCurrentTools(request.messages).map(tool => tool.name)).toEqual(["read"]);
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]).toMatchObject({ toolCallId: "restored-call", toolName: "read", isError: true,
      result: { structuredContent: { allowed: false }, details: { errorCode: "TOOL_DENIED" } } });
    expect(Number.isFinite(toolResults[0].durationMs)).toBe(true);
    const finalResult = requests.at(-1).messages.find(message => message.role === "toolResult" && message.toolCallId === "restored-call");
    expect(finalResult).toMatchObject({ toolName: "read", isError: true, durationMs: toolResults[0].durationMs });
    expect(finalResult).not.toHaveProperty("structuredContent");
    const reopened = SessionManager.open(file, path.dirname(file));
    expect(reopened.buildSessionContext().messages.find(message => message.role === "toolResult" && message.toolCallId === "restored-call"))
      .toEqual(finalResult);
    expect(fs.readFileSync(file, "utf8").startsWith(original)).toBe(true);
  });

  it("persists one cancelled tool result and never replays its execution when the old session reopens", async () => {
    const dir = directory();
    const manager = SessionManager.create(dir, path.join(dir, "sessions"));
    let signalSeen: AbortSignal;
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const { session, responses, requests, execute } = await runtime(manager, { execute: async (_id, _params, signal: AbortSignal) => {
      signalSeen = signal;
      started();
      return new Promise(resolve => signal.addEventListener("abort", () => resolve({
        content: [{ type: "text", text: "cancelled synthetic tool" }], isError: true,
        structuredContent: { cancelled: true }, details: { errorCode: "TOOL_ABORTED" },
      }), { once: true }));
    } });
    responses.push(assistant([{ type: "toolCall", id: "cancelled-call", name: "read", arguments: {} }], "toolUse"));
    const running = session.prompt("cancel this tool once");
    await entered;
    const file = manager.getSessionFile();
    await session.abort();
    await running;
    await session.waitForIdle();
    expect(signalSeen.aborted).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(1);
    expect(session.isStreaming).toBe(false);
    const reopened = SessionManager.open(file, path.dirname(file));
    const results = reopened.getEntries().filter(entry => entry.type === "message" && entry.message.role === "toolResult");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ message: { toolCallId: "cancelled-call", isError: true,
      content: [{ type: "text", text: "cancelled synthetic tool" }], details: { errorCode: "TOOL_ABORTED" } } });
    expect(new Set(reopened.getEntries().map(entry => entry.id)).size).toBe(reopened.getEntryCount());
    const resumed = await runtime(reopened);
    await resumed.session.prompt("continue after cancellation");
    expect(resumed.execute).not.toHaveBeenCalled();
    expect(resumed.requests).toHaveLength(1);
    expect(resumed.session.sessionManager.getEntries().filter(entry => entry.type === "message" && entry.message.role === "toolResult"))
      .toHaveLength(1);
  });
});
