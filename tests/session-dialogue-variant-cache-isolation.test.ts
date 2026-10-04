import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "../lib/pi-sdk/index.ts";
import { SessionCoordinator } from "../core/session-coordinator.ts";
import { generateSessionDialogueVariant } from "../core/session-dialogue-variants.ts";

type RequestContext = { systemPrompt: string; tools: unknown[]; messages: unknown[] };
type RequestOptions = {
  sessionId?: string; signal?: AbortSignal; reasoning?: string;
  headers?: Record<string, string>;
  onPayload?: (payload: Record<string, unknown>, model: unknown) => Promise<Record<string, unknown>>;
};
type ProviderResponse = { content: Array<{ type: string; text?: string; id?: string; name?: string }>; stopReason: string };

function fixture() {
  const sessionPath = "/session-cache-isolation.jsonl";
  const manager = SessionManager.inMemory("/workspace");
  manager.appendMessage({ role: "user", content: "Report the completed result", timestamp: Date.now() });
  const sourceEntryId = manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "The task completed." }], stopReason: "stop", timestamp: Date.now() } as unknown as Parameters<SessionManager["appendMessage"]>[0]);
  const model = { id: "fixture", provider: "openai", api: "openai-completions", compat: { sendSessionAffinityHeaders: true } };
  const rawStream = vi.fn(async (_model: unknown, _context: RequestContext, _options: RequestOptions): Promise<{ result: () => Promise<ProviderResponse> }> => ({
    result: async () => ({ content: [{ type: "text", text: "The completed task is ready." }], stopReason: "stop" }),
  }));
  const tool = { name: "read", description: "Read a file", parameters: { type: "object" } };
  const session = { sessionManager: manager, model, isStreaming: false, isCompacting: false,
    agent: { sessionId: "main-pi-session", streamFn: rawStream, state: { model, systemPrompt: "MAIN SESSION PROMPT", tools: [tool], messages: manager.buildSessionContext().messages } } };
  Object.defineProperty(session, "model", { get: () => session.agent.state.model });
  manager.getSessionFile = () => sessionPath;
  const owner = { buildSystemPrompt: vi.fn(() => "FRESH ISOLATED PROMPT") };
  const models = { availableModels: [model] };
  const entry = { session, agentId: "hana", runtimePromptAppendix: "\nRUNTIME APPENDIX", providerCacheAffinityKey: "main-lineage", cachePrefixContract: undefined as unknown,
    cachePrefixContractRequestCount: 0, cachePrefixContractRenewReason: "" };
  const emitEvent = vi.fn();
  const coordinator = Object.assign(Object.create(SessionCoordinator.prototype), {
    _getSessionEntryByPath: (requestedPath: string) => requestedPath === sessionPath ? entry : null,
    _getRuntimeValueForPath: () => null,
    _turnContextBySession: new Map(),
    _sessionIdForPath: () => "sess-isolation",
    getSessionMemoryScope: () => ({ version: 1, agentId: "hana", realm: "legacy" }),
    _d: { emitEvent, getModels: () => models, getAgentById: () => owner },
  }) as SessionCoordinator;
  coordinator._renewCachePrefixContract(sessionPath, entry, "scoped_post_commit_refresh");
  coordinator._installCachePrefixGuard(sessionPath, entry);
  const engine = {
    getSessionManifest: () => ({ lifecycle: "active", currentLocator: { path: sessionPath } }),
    getSessionIdForPath: () => "sess-isolation",
    ensureSessionLoaded: async () => session,
    isSessionStreaming: () => false,
    setSessionBranchHead: vi.fn(),
    getSessionDialogueVariantStreamFn: (requestedPath: string) => coordinator.getSessionDialogueVariantStreamFn(requestedPath),
  };
  const opts = { sessionId: "sess-isolation", target: { role: "assistant", entryId: sourceEntryId }, requestId: "one" };
  const normalContext: RequestContext = { systemPrompt: session.agent.state.systemPrompt, tools: [tool], messages: [] };
  return { coordinator, engine, opts, session, entry, rawStream, emitEvent, sessionPath, model, normalContext, models, owner };
}

describe("dialogue variant provider isolation", () => {
  it("preserves the main cache contract and affinity across normal → variant → normal requests", async () => {
    const f = fixture();
    await f.session.agent.streamFn(f.model, f.normalContext, { sessionId: "main-pi-session" });
    const mainContract = f.entry.cachePrefixContract;
    const requestCount = f.entry.cachePrefixContractRequestCount;
    const renewReason = f.entry.cachePrefixContractRenewReason;
    const originalMessages = [...f.session.agent.state.messages];
    const { candidate } = await generateSessionDialogueVariant(f.engine, f.opts);
    expect(candidate.status).toBe("ready");
    expect(f.entry.cachePrefixContract).toBe(mainContract);
    expect(f.entry.cachePrefixContractRequestCount).toBe(requestCount);
    expect(f.entry.cachePrefixContractRenewReason).toBe(renewReason);
    expect(f.entry.providerCacheAffinityKey).toBe("main-lineage");
    expect(f.session.agent.state.messages).toEqual(originalMessages);
    expect(f.session.agent.state.systemPrompt).toBe("MAIN SESSION PROMPT");
    expect(f.session.agent.state.tools).toHaveLength(1);
    const variantOptions = f.rawStream.mock.calls[1][2];
    const variantId = `dialogue-variant:${candidate.candidateId}`;
    expect(f.rawStream.mock.calls[1][1].tools).toEqual([]);
    expect(f.rawStream.mock.calls[1][1].systemPrompt).toContain("FRESH ISOLATED PROMPT\nRUNTIME APPENDIX");
    expect(f.rawStream.mock.calls[1][1].systemPrompt).not.toContain("MAIN SESSION PROMPT");
    expect(variantOptions.sessionId).toBe(variantId);
    expect(variantOptions.headers?.session_id).toBe(variantId);
    await expect(variantOptions.onPayload!({ prompt_cache_key: "old-key" }, f.model)).resolves.toMatchObject({ prompt_cache_key: variantId });
    await f.session.agent.streamFn(f.model, f.normalContext, { sessionId: "main-pi-session" });
    expect(f.entry.cachePrefixContract).toBe(mainContract);
    expect(f.entry.cachePrefixContractRequestCount).toBe(requestCount + 1);
    expect(f.rawStream.mock.calls[2][2].headers?.session_id).toBe("main-lineage");
    expect(f.emitEvent).not.toHaveBeenCalled();

    // Genuine main-turn drift must remain observable; this is lane separation,
    // not a broad diagnostic bypass or a temporary mutation of the live guard.
    await f.session.agent.streamFn(f.model, { ...f.normalContext, systemPrompt: "UNEXPECTED NORMAL TURN MUTATION" }, { sessionId: "main-pi-session" });
    expect(f.emitEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "cache_contract_violation", action: "renewed" }), f.sessionPath);
  });

  it("keeps tool-call rejection and leaves main diagnostics untouched after a rejected variant", async () => {
    const f = fixture();
    const mainContract = f.entry.cachePrefixContract;
    f.rawStream.mockImplementationOnce(async () => ({ result: async () => ({ content: [{ type: "toolCall", id: "forbidden", name: "read" }], stopReason: "toolUse" }) }));
    await expect(generateSessionDialogueVariant(f.engine, f.opts)).rejects.toMatchObject({ code: "dialogue_variant_tools_forbidden" });
    expect(f.rawStream.mock.calls[0][1].tools).toEqual([]);
    expect(f.entry.cachePrefixContract).toBe(mainContract);
    expect(f.entry.cachePrefixContractRequestCount).toBe(0);
    expect(f.emitEvent).not.toHaveBeenCalled();
  });

  it("requires a separate request ID and rejects tool definitions at the isolated transport boundary", () => {
    const f = fixture();
    const stream = f.coordinator.getSessionDialogueVariantStreamFn(f.sessionPath)!;
    const options = { signal: new AbortController().signal, sessionId: "main-pi-session", reasoning: "off" };
    expect(() => stream(f.model, { systemPrompt: "variant", messages: [], tools: [] }, options)).toThrow("isolated request identity");
    expect(() => stream(f.model, { systemPrompt: "variant", messages: [], tools: f.normalContext.tools as never[] }, { ...options, sessionId: "dialogue-variant:11111111-1111-4111-8111-111111111111" })).toThrow("forbids tools");
    expect(f.rawStream).not.toHaveBeenCalled();
    expect(f.coordinator.getSessionDialogueVariantStreamFn("/unknown.jsonl")).toBeNull();
  });

  it("enforces disabled and removed model policy before any provider request", async () => {
    const f = fixture();
    Object.assign(f.entry, { modelAvailability: { available: false, reason: "disabled", modelRef: "openai/fixture" } });
    await expect(generateSessionDialogueVariant(f.engine, f.opts)).rejects.toMatchObject({ code: "MODEL_NOT_AVAILABLE" });
    expect(f.rawStream).not.toHaveBeenCalled();
    const removed = fixture();
    removed.models.availableModels = [];
    await expect(generateSessionDialogueVariant(removed.engine, removed.opts)).rejects.toMatchObject({ code: "MODEL_NOT_AVAILABLE" });
    expect(removed.rawStream).not.toHaveBeenCalled();
  });

  it("rebinds the current registry model at dispatch while preserving the isolated affinity", async () => {
    const f = fixture();
    const current = { ...f.model, baseUrl: "https://current-provider.invalid" };
    f.models.availableModels = [current];
    const contract = f.entry.cachePrefixContract;
    const { candidate } = await generateSessionDialogueVariant(f.engine, f.opts);
    expect(f.rawStream.mock.calls[0][0]).toBe(current);
    expect(f.session.model).toBe(current);
    expect(f.rawStream.mock.calls[0][2].headers?.session_id).toBe(`dialogue-variant:${candidate.candidateId}`);
    expect(f.entry.cachePrefixContract).toBe(contract);
    expect(f.entry.providerCacheAffinityKey).toBe("main-lineage");
    expect(f.owner.buildSystemPrompt).toHaveBeenCalledWith(expect.objectContaining({ targetModel: current }));
  });
});
