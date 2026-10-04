import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools,
  type AssistantMessage, type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { Extension } from "@earendil-works/pi-coding-agent";
import {
  AuthStorage, createAgentSession, createModelRegistry, DefaultResourceLoader,
  registerModelProvider, SessionManager, SettingsManager, setSessionSystemPrompt, setSessionActiveRunSystemPrompt, Type,
} from "../lib/pi-sdk/index.ts";
import { applySessionTurnSystemContext, createSessionTurnContextExtension } from "../core/session-turn-context.ts";
import { runCachePreservingCompactionForSession } from "../core/session-compactor.ts";

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

async function fixture(createManager = (dir: string) => SessionManager.inMemory(dir)) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-pi-runtime-"));
  disposals.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const registry = await createModelRegistry(AuthStorage.inMemory());
  const requests: TranscriptContext[] = [];
  const responses: Partial<CompletedAssistantMessage>[] = [];
  registerModelProvider(registry, "hana-test", {
    baseUrl: "https://example.invalid/v1", api: "openai-completions", apiKey: "test-only",
    models: [{ id: "mock", name: "Mock", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 4096 }],
    streamSimple: (model, context) => {
      requests.push(structuredClone(context));
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
  const resourceLoader = new DefaultResourceLoader({
    cwd: dir, agentDir: dir, settingsManager, systemPrompt: "base persona",
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await resourceLoader.reload();
  const getExtensions = resourceLoader.getExtensions.bind(resourceLoader);
  resourceLoader.getExtensions = () => ({ ...getExtensions(), extensions: [extension as unknown as Extension] });
  const execute = vi.fn(async () => ({
    content: [{ type: "text", text: "permission denied" }], isError: true, details: { errorCode: "TOOL_DENIED" },
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

describe("Pi 0.87 runtime integration", () => {
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
    const call: Partial<CompletedAssistantMessage> = { stopReason: "toolUse", content: [{ type: "toolCall", id: "same-call", name: "read", arguments: {} }] };
    responses.push(call, call, {});
    await session.prompt("read twice");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(3);
    expect(requests[1].messages.find(message => message.role === "toolResult")?.isError).toBe(true);
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
