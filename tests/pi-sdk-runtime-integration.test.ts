import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools,
  type AssistantMessage, type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { Extension } from "@earendil-works/pi-coding-agent";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  AuthStorage, createAgentSession, createModelRegistry, DefaultResourceLoader,
  registerModelProvider, SessionManager, SettingsManager, setSessionSystemPrompt, setSessionActiveRunSystemPrompt, Type,
} from "../lib/pi-sdk/index.ts";
import { applySessionTurnSystemContext, createSessionTurnContextExtension } from "../core/session-turn-context.ts";
import { runCachePreservingCompactionForSession } from "../core/session-compactor.ts";
import { SessionCoordinator } from "../core/session-coordinator.ts";

const disposals: Array<() => void> = [];
afterEach(() => { for (const dispose of disposals.splice(0).reverse()) dispose(); });
type CompletedAssistantMessage = AssistantMessage & { stopReason: "stop" | "toolUse" };

const summary = `## Goal
Continue the user's task.
## Constraints & Preferences
Preserve the role and tool boundaries.
## Progress
### Done
- Read the earlier conversation.
### In Progress
- Continue the next turn.
### Blocked
- Nothing.
## Key Decisions
- Keep the retained context.
## Next Steps
- Answer the user.
## Critical Context
The user is testing a session.`;

async function fixture(createManager = (dir: string) => SessionManager.inMemory(dir), hooks: {
  streamSimple?: (...args: Parameters<StreamFn>) => ReturnType<typeof createAssistantMessageEventStream>;
  beforeSettle?: () => Promise<void>;
  settled?: () => Promise<void>;
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-pi-runtime-"));
  disposals.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const registry = await createModelRegistry(AuthStorage.inMemory());
  const requests: TranscriptContext[] = [];
  const responses: Partial<CompletedAssistantMessage>[] = [];
  registerModelProvider(registry, "hana-test", {
    baseUrl: "https://example.invalid/v1", api: "openai-completions", apiKey: "test-only",
    models: [{ id: "mock", name: "Mock", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 4096 }],
    streamSimple: (model, context, options) => {
      requests.push(structuredClone(context));
      if (hooks.streamSimple) return hooks.streamSimple(model, context, options);
      const response = responses.shift() ?? {};
      const message: CompletedAssistantMessage = {
        role: "assistant", content: [{ type: "text", text: "reply" }],
        api: model.api, provider: model.provider, model: model.id,
        usage: { input: 20, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 25,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        timestamp: Date.now(), stopReason: "stop", ...response,
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: message.stopReason, message });
      stream.end(message);
      return stream;
    },
  });
  let turnContext: { system: string } | null = null;
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false, reserveTokens: 1000, keepRecentTokens: 30 },
    retry: { enabled: false }, cacheWarming: "off",
  });
  const extension = createSessionTurnContextExtension({ getTurnContext: () => turnContext });
  if (hooks.beforeSettle) extension.handlers.set("agent_before_settle", [hooks.beforeSettle]);
  if (hooks.settled) extension.handlers.set("agent_settled", [hooks.settled]);
  const resourceLoader = new DefaultResourceLoader({
    cwd: dir, agentDir: dir, settingsManager, systemPrompt: "base persona",
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await resourceLoader.reload();
  const getExtensions = resourceLoader.getExtensions.bind(resourceLoader);
  resourceLoader.getExtensions = () => ({ ...getExtensions(), extensions: [extension as unknown as Extension] });
  const execute = vi.fn(async () => ({
    content: [{ type: "text", text: "permission denied" }], isError: true, details: { errorCode: "TOOL_DENIED" },
    structuredContent: { allowed: false, reason: "permission denied" },
  }));
  const { session } = await createAgentSession({
    cwd: dir, agentDir: dir, modelRegistry: registry, model: registry.find("hana-test", "mock"),
    resourceLoader, settingsManager, sessionManager: createManager(dir),
    tools: [{ name: "read", label: "Read", description: "Read safely", parameters: Type.Object({}), execute }],
  });
  disposals.push(() => session.dispose());
  setSessionSystemPrompt(session, "frozen persona");
  return { session, requests, responses, execute, setTurnContext: (value: typeof turnContext) => { turnContext = value; } };
}

function deferred() {
  let resolve: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve: () => resolve() };
}

describe("Pi 1.0 runtime integration", () => {
  it("projects the post-commit scoped prompt into the actual provider request", async () => {
    const { session, requests, setTurnContext } = await fixture();
    setSessionSystemPrompt(session, "branch A contains retracted story event");
    setTurnContext({ system: "temporary expression direction" });
    await session.prompt("retry this turn", {
      preflightResult: (accepted) => {
        if (!accepted) return;
        setSessionActiveRunSystemPrompt(session, applySessionTurnSystemContext(
          "branch B contains independent retained event", { system: "temporary expression direction" }));
      },
    });
    expect(requests).toHaveLength(1);
    const providerPrompt = getCurrentSystemPrompt(requests[0].messages);
    expect(providerPrompt).toContain("independent retained event");
    expect(providerPrompt).toContain("temporary expression direction");
    expect(providerPrompt).not.toContain("retracted story event");
  });
  it("continues a pre-upgrade v3 JSONL branch with its history and identity intact", async () => {
    const { session, requests } = await fixture(dir => {
      const file = path.join(dir, "legacy-session.jsonl");
      const entries = [
        { type: "session", version: 3, id: "legacy-session", timestamp: "2026-09-01T00:00:00.000Z", cwd: dir },
        { type: "model_change", id: "model001", parentId: null, timestamp: "2026-09-01T00:00:00.000Z", provider: "hana-test", modelId: "mock" },
        { type: "message", id: "user0001", parentId: "model001", timestamp: "2026-09-01T00:00:01.000Z",
          message: { role: "user", content: [{ type: "text", text: "pre-upgrade history" }], timestamp: 1 } },
      ];
      fs.writeFileSync(file, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
      return SessionManager.open(file, dir);
    });
    await session.prompt("continue after upgrade");
    expect(session.sessionManager.getSessionId()).toBe("legacy-session");
    expect(session.sessionManager.getEntry("user0001")?.type).toBe("message");
    expect(JSON.stringify(requests[0].messages)).toContain("pre-upgrade history");
    expect(getCurrentSystemPrompt(requests[0].messages)).toBe("frozen persona");
  });

  it("projects recognized legacy failures from JSONL without rewriting stored outcomes", async () => {
    let original: string;
    const { session, requests } = await fixture(dir => {
      const file = path.join(dir, "legacy-outcomes.jsonl");
      const header = { type: "session", version: 3, id: "legacy-outcomes", timestamp: "2026-09-01T00:00:00.000Z", cwd: dir };
      const messages = [
        { role: "user", content: [{ type: "text", text: "old request" }], timestamp: 1 },
        { role: "assistant", content: ["known", "warning"].map(id => ({ type: "toolCall", id, name: "read", arguments: {} })),
          api: "openai-completions", provider: "hana-test", model: "mock", stopReason: "toolUse", timestamp: 2,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
        { role: "toolResult", toolCallId: "known", toolName: "read", isError: false, timestamp: 3,
          content: [{ type: "text", text: "denied" }], details: { errorCode: "TOOL_DENIED" } },
        { role: "toolResult", toolCallId: "warning", toolName: "read", isError: false, timestamp: 4,
          content: [{ type: "text", text: "completed" }], details: { error: "diagnostic warning" } },
      ];
      original = [header, ...messages.map((message, index) => ({ type: "message", id: `legacy${index}`,
        parentId: index ? `legacy${index - 1}` : null, timestamp: header.timestamp, message }))]
        .map(entry => JSON.stringify(entry)).join("\n") + "\n";
      fs.writeFileSync(file, original);
      return SessionManager.open(file, dir);
    });
    await session.prompt("continue the legacy session");
    expect(requests[0].messages.find(message => message.role === "toolResult" && message.toolCallId === "known"))
      .toMatchObject({ isError: true });
    expect(requests[0].messages.find(message => message.role === "toolResult" && message.toolCallId === "warning"))
      .toMatchObject({ isError: false });
    expect(session.sessionManager.getEntry("legacy2")).toMatchObject({ message: { isError: false } });
    expect(fs.readFileSync(session.sessionManager.getSessionFile(), "utf8").startsWith(original)).toBe(true);
  });

  it("projects a temporary role instruction once and preserves the sandbox tool allowlist", async () => {
    const { session, requests, setTurnContext } = await fixture();
    setTurnContext({ system: "temporary scene" });
    await session.prompt("hello");
    setTurnContext(null);
    await session.prompt("next turn");
    expect(getCurrentSystemPrompt(requests[0].messages)).toBe(
      applySessionTurnSystemContext("frozen persona", { system: "temporary scene" }),
    );
    expect(getCurrentSystemPrompt(requests[1].messages)).toBe("frozen persona");
    expect(getCurrentTools(requests[0].messages).map(tool => tool.name)).toEqual(["read"]);
    expect(JSON.stringify(session.sessionManager.getEntries())).not.toContain("temporary scene");
  });

  it("runs a repeated tool id once and preserves denied outcomes through the real loop", async () => {
    const { session, requests, responses, execute } = await fixture();
    const toolResults = [];
    session.subscribe(event => { if (event.type === "tool_execution_end") toolResults.push(event); });
    const call: Partial<CompletedAssistantMessage> = { stopReason: "toolUse", content: [{ type: "toolCall", id: "same-call", name: "read", arguments: {} }] };
    responses.push(call, call, {});
    await session.prompt("read twice");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(3);
    expect(requests[1].messages.find(message => message.role === "toolResult")?.isError).toBe(true);
    expect(toolResults[0]).toMatchObject({ isError: true, result: {
      structuredContent: { allowed: false, reason: "permission denied" }, details: { errorCode: "TOOL_DENIED" },
    } });
  });

  it.each(["error", "aborted"] as const)("persists the first user before a provider %s and reopens without duplicate entries", async reason => {
    const entered = deferred();
    let finish: () => void;
    const { session } = await fixture(dir => SessionManager.create(dir, path.join(dir, "sessions")), {
      streamSimple: (model, _context, options) => {
        const stream = createAssistantMessageEventStream();
        finish = () => {
          const message: AssistantMessage = {
            role: "assistant", api: model.api, model: model.id, provider: model.provider,
            timestamp: Date.now(), stopReason: reason, errorMessage: `synthetic ${reason}`, content: [],
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          };
          stream.push({ type: "error", reason, error: message });
          stream.end(message);
        };
        options.signal.addEventListener("abort", finish, { once: true });
        entered.resolve();
        return stream;
      },
    });
    const running = session.prompt("first durable user");
    await entered.promise;
    const file = session.sessionManager.getSessionFile();
    const beforeFailure = fs.readFileSync(file, "utf8");
    const durable = SessionManager.open(file, path.dirname(file));
    expect(durable.buildSessionContext().messages).toContainEqual(expect.objectContaining({
      role: "user", content: [{ type: "text", text: "first durable user" }],
    }));
    if (reason === "aborted") await session.abort();
    else finish();
    await running;
    await session.waitForIdle();
    const afterFailure = fs.readFileSync(file, "utf8");
    expect(afterFailure.startsWith(beforeFailure)).toBe(true);
    const reopened = SessionManager.open(file, path.dirname(file));
    expect(reopened.getSessionId()).toBe(session.sessionManager.getSessionId());
    const entries = reopened.getEntries();
    expect(new Set(entries.map(entry => entry.id)).size).toBe(entries.length);
    expect(entries.filter(entry => entry.type === "message" && entry.message.role === "user")).toHaveLength(1);
    expect(reopened.buildSessionContext().messages.at(-1)).toMatchObject({ role: "assistant", stopReason: reason });
  });

  it("emits coordinator completion once after the real session settles, including abort and idle waiters", async () => {
    const entered = deferred(), release = deferred(), settled = deferred(), releaseSettled = deferred();
    const { session } = await fixture(dir => SessionManager.create(dir, path.join(dir, "agents", "owner", "sessions")), {
      beforeSettle: async () => { entered.resolve(); await release.promise; },
      settled: async () => { settled.resolve(); await releaseSettled.promise; },
    });
    const file = session.sessionManager.getSessionFile();
    const emitEvent = vi.fn();
    const owner = { id: "owner" };
    const coordinator = new SessionCoordinator({
      agentsDir: path.resolve(path.dirname(file), "../.."), memoryPressure: { enabled: false }, emitEvent,
      getModels: () => ({ availableModels: [session.model] }), getAgent: () => owner, getAgentById: () => owner,
    });
    // A restored, cached owner keeps the public desktop prompt path on this real SDK session.
    coordinator._sessions.set(file, { session, agentId: owner.id, sessionId: session.sessionManager.getSessionId() });
    let promptDone = false, abortDone = false, idleDone = false;
    const running = coordinator.promptSession(file, "hold final settlement", {}).then(() => { promptDone = true; });
    await entered.promise;
    await session.agent.waitForIdle();
    const aborting = session.abort().then(() => { abortDone = true; });
    const idle = session.waitForIdle().then(() => { idleDone = true; });
    try {
      await new Promise(resolve => setImmediate(resolve));
      expect(session.isStreaming).toBe(true);
      expect(session.isIdle).toBe(false);
      expect([promptDone, abortDone, idleDone]).toEqual([false, false, false]);
      expect(emitEvent.mock.calls.filter(([event]) => event.type === "session_run_end")).toHaveLength(0);
      release.resolve();
      await settled.promise;
      await new Promise(resolve => setImmediate(resolve));
      // The SDK clears isStreaming before awaiting agent_settled extensions,
      // but the prompt and previously registered waiters must still wait.
      expect([promptDone, abortDone, idleDone]).toEqual([false, false, false]);
      expect(emitEvent.mock.calls.filter(([event]) => event.type === "session_run_end")).toHaveLength(0);
    } finally {
      release.resolve();
      releaseSettled.resolve();
      await Promise.all([running, aborting, idle]);
    }
    expect(session.isStreaming).toBe(false);
    expect(session.isIdle).toBe(true);
    expect(emitEvent.mock.calls.filter(([event]) => event.type === "session_run_end")).toHaveLength(1);
    coordinator._notifySessionRunIdle(file, session);
    expect(emitEvent.mock.calls.filter(([event]) => event.type === "session_run_end")).toHaveLength(1);
  });

  it("honors context edits through compaction, reopen and a second compaction", async () => {
    const first = await fixture(dir => SessionManager.create(dir, path.join(dir, "sessions")));
    await first.session.prompt(`omit-this-context ${"old details ".repeat(30)}`);
    await first.session.prompt(`replace-this-context ${"old details ".repeat(30)}`);
    for (let i = 0; i < 3; i++) await first.session.prompt(`retained turn ${i}: ${"details ".repeat(30)}`);
    const manager = first.session.sessionManager;
    const users = manager.getEntries().filter(entry => entry.type === "message" && entry.message.role === "user");
    manager.appendContextEdit(users[0].id, null);
    manager.appendContextEdit(users[1].id, { content: [{ type: "text", text: "replacement-visible" }] });
    const file = manager.getSessionFile();
    const editedBytes = fs.readFileSync(file, "utf8");
    first.responses.push({ content: [{ type: "text", text: summary }] });
    await runCachePreservingCompactionForSession(first.session, {
      settings: { enabled: true, reserveTokens: 1000, keepRecentTokens: 30 },
    });
    const compactionRequest = JSON.stringify(first.requests.at(-1).messages);
    expect(compactionRequest).toContain("replacement-visible");
    expect(compactionRequest).not.toContain("omit-this-context");
    expect(compactionRequest).not.toContain("replace-this-context");
    expect(fs.readFileSync(file, "utf8").startsWith(editedBytes)).toBe(true);
    const second = await fixture(() => SessionManager.open(file, path.dirname(file)));
    expect(second.session.sessionManager.getSessionId()).toBe(manager.getSessionId());
    for (let i = 0; i < 3; i++) await second.session.prompt(`after reopen ${i}: ${"new details ".repeat(30)}`);
    second.responses.push({ content: [{ type: "text", text: summary }] });
    await runCachePreservingCompactionForSession(second.session, {
      settings: { enabled: true, reserveTokens: 1000, keepRecentTokens: 30 },
    });
    await second.session.prompt("after both compactions");
    const final = second.requests.at(-1).messages;
    expect(getCurrentSystemPrompt(final)).toBe("frozen persona");
    expect(JSON.stringify(final)).not.toMatch(/omit-this-context|replace-this-context/);
    expect(second.session.sessionManager.getBranch().filter(entry => entry.type === "compaction")).toHaveLength(2);
    expect(second.session.sessionManager.getBranch().filter(entry => entry.type === "context_edit")).toHaveLength(2);
  });

  it("uses the canonical branch after compaction and does not duplicate the system prompt", async () => {
    const { session, requests, responses } = await fixture();
    for (let i = 0; i < 4; i++) await session.prompt(`turn ${i}: ${"earlier context ".repeat(30)}`);
    responses.push({ content: [{ type: "text", text: summary }] });
    await runCachePreservingCompactionForSession(session, {
      settings: { enabled: true, reserveTokens: 1000, keepRecentTokens: 30 },
    });
    await session.prompt("after compaction");
    const messages = requests.at(-1).messages;
    expect(getCurrentSystemPrompt(messages)).toBe("frozen persona");
    expect(JSON.stringify(messages)).toContain("Continue the user's task.");
    expect(JSON.stringify(messages)).not.toContain("turn 0:");
    expect(session.sessionManager.getBranch().some(entry => entry.type === "compaction")).toBe(true);
    for (let i = 0; i < 3; i++) await session.prompt(`new turn ${i}: ${"additional context ".repeat(30)}`);
    responses.push({ content: [{ type: "text", text: summary }] });
    await runCachePreservingCompactionForSession(session, {
      settings: { enabled: true, reserveTokens: 1000, keepRecentTokens: 30 },
    });
    await session.prompt("after second compaction");
    expect(getCurrentSystemPrompt(requests.at(-1).messages)).toBe("frozen persona");
    expect(JSON.stringify(requests.at(-1).messages)).not.toContain("turn 0:");
  });
});
