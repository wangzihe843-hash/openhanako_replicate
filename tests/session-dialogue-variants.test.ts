import { describe, expect, it, vi } from "vitest";
import { SessionManager, type AgentMessage } from "../lib/pi-sdk/index.ts";
import {
  DIALOGUE_VARIANT_RECORD_TYPE, generateSessionDialogueVariant, adoptSessionDialogueVariant,
  listSessionDialogueVariants, cancelSessionDialogueVariant, discardSessionDialogueVariant,
} from "../core/session-dialogue-variants.ts";

type FixtureResponse = { content: Array<{ type: string; text?: string; name?: string; id?: string }>; stopReason: string };
function fixture() {
  const manager = SessionManager.inMemory("/workspace");
  const inputId = manager.appendMessage({ role: "user", content: [{ type: "text", text: "Post the project update" }] } as unknown as Parameters<SessionManager["appendMessage"]>[0]);
  manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "post-original", name: "channel", arguments: { action: "post", channel: "team", content: "hello" } }] } as unknown as Parameters<SessionManager["appendMessage"]>[0]);
  const resultId = manager.appendMessage({ role: "toolResult", toolCallId: "post-original", toolName: "channel", content: [{ type: "text", text: "Posted" }], details: { effect: { effectId: "a".repeat(64), status: "committed", receipt: { channel: "team", sender: "hana", timestamp: "today" } } } } as unknown as Parameters<SessionManager["appendMessage"]>[0]);
  const sourceId = manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "I posted the project update." }], stopReason: "stop" } as unknown as Parameters<SessionManager["appendMessage"]>[0]);
  const streamFn = vi.fn(async (_model: unknown, _context: { tools: unknown[]; messages: Array<{ content: Array<{ text?: string }> }> }, _options: { signal: AbortSignal }): Promise<{ result: () => Promise<FixtureResponse> }> => ({ result: async () => ({ content: [{ type: "text", text: "The project update has been posted." }], stopReason: "stop" }) }));
  const session = { sessionManager: manager, model: { id: "test" }, agent: { streamFn, state: { systemPrompt: "Be helpful", messages: manager.buildSessionContext().messages }, replaceMessages: vi.fn() } };
  const engine = {
    getSessionManifest: vi.fn(() => ({ lifecycle: "active", ownerAgentId: "hana", currentLocator: { path: "/session.jsonl" } })),
    getSessionIdForPath: vi.fn(() => "sess_one"),
    ensureSessionLoaded: vi.fn(async () => session), isSessionStreaming: vi.fn(() => false),
    getSessionDialogueVariantStreamFn: vi.fn(() => streamFn),
    setSessionBranchHead: vi.fn(), emitEvent: vi.fn(), submit: vi.fn(),
  };
  const opts = { sessionId: "sess_one", target: { role: "assistant", entryId: sourceId }, requestId: "request-one" };
  return { manager, session, engine, opts, streamFn, sourceId, inputId, resultId };
}
const invalidateDerivedState = vi.fn();

describe("expression-only dialogue variants", () => {
  it("allows a latest response after model and thinking changes and preserves those settings on adoption", async () => {
    const f = fixture();
    f.manager.appendModelChange("fixture-provider", "fixture-new-model");
    f.manager.appendThinkingLevelChange("high");
    const before = f.manager.buildSessionContext();

    const { candidate } = await generateSessionDialogueVariant(f.engine, f.opts);
    expect(candidate.status).toBe("ready");
    await adoptSessionDialogueVariant(f.engine, { sessionId: "sess_one", candidateId: candidate.candidateId }, { invalidateDerivedState });

    const after = f.manager.buildSessionContext();
    expect(after.model).toEqual(before.model);
    expect(after.thinkingLevel).toBe(before.thinkingLevel);
    expect(f.manager.getBranch().filter(entry => entry.type === "model_change" || entry.type === "thinking_level_change")).toEqual([
      expect.objectContaining({ type: "model_change", provider: "fixture-provider", modelId: "fixture-new-model" }),
      expect.objectContaining({ type: "thinking_level_change", thinkingLevel: "high" }),
    ]);
    expect(f.manager.getBranch().some(entry => entry.id === f.resultId)).toBe(true);
  });

  it("still rejects a candidate if model metadata changes after its generation", async () => {
    const f = fixture();
    const { candidate } = await generateSessionDialogueVariant(f.engine, f.opts);
    f.manager.appendModelChange("fixture-provider", "fixture-later-model");
    const before = f.manager.getLeafId();
    await expect(adoptSessionDialogueVariant(f.engine, { sessionId: "sess_one", candidateId: candidate.candidateId }, { invalidateDerivedState })).rejects.toMatchObject({ code: "dialogue_variant_stale" });
    expect(f.manager.getLeafId()).toBe(before);
  });

  it("uses a tool-free direct transport and leaves completed effects and main memory unchanged until adoption", async () => {
    const f = fixture();
    const originalMessages = f.manager.buildSessionContext().messages;
    const result = await generateSessionDialogueVariant(f.engine, f.opts);
    expect(result.candidate).toMatchObject({ status: "ready", sourceEntryId: f.sourceId });
    expect(f.manager.buildSessionContext().messages).toEqual(originalMessages);
    expect(f.session.agent.replaceMessages).not.toHaveBeenCalled();
    expect(f.engine.submit).not.toHaveBeenCalled();
    const context = f.streamFn.mock.calls[0][1];
    expect(context.tools).toEqual([]);
    expect(context.messages).toHaveLength(1);
    expect(context.messages[0].content[0].text).toContain('"status":"committed"');
    expect(result.candidate).not.toHaveProperty("sourceFingerprint");

    const adopted = await adoptSessionDialogueVariant(f.engine, { sessionId: "sess_one", candidateId: result.candidate.candidateId }, { invalidateDerivedState });
    expect(adopted.candidate.status).toBe("adopted");
    expect(f.manager.getBranch().some(entry => entry.id === f.resultId)).toBe(true);
    expect(f.manager.getBranch().some(entry => entry.id === f.sourceId)).toBe(false);
    const textMessages = f.manager.buildSessionContext().messages.filter((message) => message.role === "assistant" && message.content.some((block) => block.type === "text"));
    expect(textMessages).toHaveLength(1);
    expect((textMessages[0] as Extract<AgentMessage, { role: "assistant" }>).content).toEqual([{ type: "text", text: "The project update has been posted." }]);
    expect(f.streamFn).toHaveBeenCalledTimes(1);
    const leaf = f.manager.getLeafId();
    await adoptSessionDialogueVariant(f.engine, { sessionId: "sess_one", candidateId: result.candidate.candidateId }, { invalidateDerivedState });
    expect(f.manager.getLeafId()).toBe(leaf);
  });

  it("persists candidates and deduplicates repeated request IDs across reads", async () => {
    const f = fixture();
    const first = await generateSessionDialogueVariant(f.engine, f.opts);
    const second = await generateSessionDialogueVariant(f.engine, f.opts);
    expect(second).toEqual(first);
    expect(f.streamFn).toHaveBeenCalledTimes(1);
    expect((await listSessionDialogueVariants(f.engine, { sessionId: "sess_one" })).candidates).toEqual([first.candidate]);
    await discardSessionDialogueVariant(f.engine, { sessionId: "sess_one", candidateId: first.candidate.candidateId });
    await expect(adoptSessionDialogueVariant(f.engine, { sessionId: "sess_one", candidateId: first.candidate.candidateId }, { invalidateDerivedState })).rejects.toMatchObject({ code: "dialogue_variant_not_ready" });
    expect(f.manager.getBranch().some(entry => entry.id === f.sourceId)).toBe(true);
  });

  it("rejects tool-call-bearing provider output without executing any action", async () => {
    const f = fixture();
    f.streamFn.mockImplementation(async () => ({ result: async () => ({ content: [{ type: "toolCall", name: "channel", id: "evil" }], stopReason: "toolUse" }) }));
    await expect(generateSessionDialogueVariant(f.engine, f.opts)).rejects.toMatchObject({ code: "dialogue_variant_tools_forbidden" });
    expect(f.engine.submit).not.toHaveBeenCalled();
    expect(f.manager.getBranch().some(entry => entry.id === f.sourceId)).toBe(true);
    expect((await listSessionDialogueVariants(f.engine, { sessionId: "sess_one" })).candidates[0].status).toBe("failed");
  });

  it("rejects adoption when a later user turn or task outcome arrived", async () => {
    const f = fixture();
    const { candidate } = await generateSessionDialogueVariant(f.engine, f.opts);
    f.manager.appendCustomMessageEntry("background-result", "A late task completed", true);
    const before = f.manager.getLeafId();
    await expect(adoptSessionDialogueVariant(f.engine, { sessionId: "sess_one", candidateId: candidate.candidateId }, { invalidateDerivedState })).rejects.toMatchObject({ code: "dialogue_variant_stale" });
    expect(f.manager.getLeafId()).toBe(before);
  });

  it("cancels pending generation and rejects a late response", async () => {
    const f = fixture();
    let finish: (value: FixtureResponse) => void;
    const pending = new Promise<FixtureResponse>(resolve => { finish = resolve; });
    f.streamFn.mockImplementation(async () => ({ result: () => pending }));
    const generation = generateSessionDialogueVariant(f.engine, f.opts);
    const rejection = expect(generation).rejects.toMatchObject({ code: "dialogue_variant_cancelled" });
    await vi.waitFor(() => expect(f.streamFn).toHaveBeenCalledTimes(1));
    const duplicate = await generateSessionDialogueVariant(f.engine, f.opts);
    expect(duplicate.candidate.status).toBe("generating");
    await expect(generateSessionDialogueVariant(f.engine, { ...f.opts, requestId: "different" })).rejects.toMatchObject({ code: "session_busy" });
    await cancelSessionDialogueVariant(f.engine, { sessionId: "sess_one", requestId: "request-one" });
    expect(f.streamFn.mock.calls[0][2].signal.aborted).toBe(true);
    await rejection; // cancellation does not wait for an uncooperative provider
    finish!({ content: [{ type: "text", text: "late result" }], stopReason: "stop" });
    expect((await listSessionDialogueVariants(f.engine, { sessionId: "sess_one" })).candidates[0].status).toBe("cancelled");
    expect((f.manager.buildSessionContext().messages.at(-1) as Extract<AgentMessage, { role: "assistant" }>)?.content).toEqual([{ type: "text", text: "I posted the project update." }]);
  });

  it("recovers interrupted generation conservatively after process restart", async () => {
    const f = fixture();
    f.manager.appendCustomEntry(DIALOGUE_VARIANT_RECORD_TYPE, { version: 1, sessionId: "sess_one", candidateId: "interrupted", requestId: "old", status: "generating", sourceEntryId: f.sourceId });
    const listed = await listSessionDialogueVariants(f.engine, { sessionId: "sess_one" });
    expect(listed.candidates[0]).toMatchObject({ status: "cancelled", error: "generation_interrupted" });
    expect(f.streamFn).not.toHaveBeenCalled();
  });

  it("rolls back adoption and keeps its candidate if derived invalidation fails", async () => {
    const f = fixture();
    const { candidate } = await generateSessionDialogueVariant(f.engine, f.opts);
    const original = f.manager.buildSessionContext().messages;
    await expect(adoptSessionDialogueVariant(f.engine, { sessionId: "sess_one", candidateId: candidate.candidateId }, { invalidateDerivedState: () => { throw new Error("invalidation unavailable"); } })).rejects.toThrow("invalidation unavailable");
    expect(f.manager.buildSessionContext().messages).toEqual(original);
    expect((await listSessionDialogueVariants(f.engine, { sessionId: "sess_one" })).candidates[0].status).toBe("ready");
  });
  it("rejects historical targets before invoking the model and explains the fork path", async () => {
    const f = fixture();
    f.manager.appendMessage({ role: "user", content: [{ type: "text", text: "Next task" }], timestamp: Date.now() });
    await expect(generateSessionDialogueVariant(f.engine, f.opts)).rejects.toMatchObject({ code: "dialogue_variant_requires_latest_response", message: expect.stringContaining("Fork") });
    expect(f.streamFn).not.toHaveBeenCalled();
    expect((await listSessionDialogueVariants(f.engine, { sessionId: "sess_one" })).candidates).toEqual([]);
  });

  it("fails closed without an isolated transport instead of borrowing the main session stream", async () => {
    const f = fixture();
    await expect(generateSessionDialogueVariant({ ...f.engine, getSessionDialogueVariantStreamFn: undefined }, f.opts)).rejects.toMatchObject({ code: "dialogue_variant_model_unavailable" });
    expect(f.streamFn).not.toHaveBeenCalled();
    expect((await listSessionDialogueVariants(f.engine, { sessionId: "sess_one" })).candidates).toEqual([]);
  });

});
