import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Agent } from "../core/agent.ts";
import { SessionCoordinator } from "../core/session-coordinator.ts";
import { generateSessionDialogueVariant } from "../core/session-dialogue-variants.ts";
import { SESSION_MEMORY_SCOPE_RECORD } from "../core/session-memory-scope.ts";
import { SessionManager } from "../lib/pi-sdk/index.ts";
import { ScopedDerivationStore } from "../lib/memory/scoped-derivation-store.ts";
import { normalizeMemoryScopeContext } from "../shared/memory-scope.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const story = normalizeMemoryScopeContext({ agentId: "hana", realm: "story", worldId: "world", branchId: "branch" });

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-variant-projection-"));
  roots.push(root);
  const agentDir = path.join(root, "agents", "hana");
  const memoryDir = path.join(agentDir, "memory");
  const productDir = path.join(root, "product");
  const userDir = path.join(root, "user");
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.mkdirSync(path.join(productDir, "yuan"), { recursive: true });
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(path.join(productDir, "yuan", "hanako.md"), "BASE_IDENTITY");
  fs.writeFileSync(path.join(userDir, "user.md"), "REAL_USER_PROFILE_MARKER");
  fs.writeFileSync(path.join(memoryDir, "memory.md"), "LEGACY_COMPILED_MARKER");
  const owner = new Agent({ id: "hana", agentsDir: path.join(root, "agents"), productDir, userDir, channelsDir: undefined, searchConfigResolver: undefined });
  owner._config = { locale: "en", agent: { name: "Hana", yuan: "hanako" }, memory: { enabled: true }, experience: { enabled: false } };
  owner.agentName = "Hana";
  owner.userName = "User";
  owner._memoryMasterEnabled = true;
  owner._memorySessionEnabled = true;
  owner._experienceEnabled = false;
  const store = new ScopedDerivationStore(memoryDir, { agentId: "hana" });
  const dependency = store.registerSource({ sessionId: "source-a", memoryScope: story, revision: "r1" });
  store.commitArtifact({ kind: "facts", slot: "a", memoryScope: story, body: "RETRACTED_MEMORY_MARKER", dependencies: [dependency] });
  const manager = SessionManager.inMemory(root);
  manager.appendCustomEntry(SESSION_MEMORY_SCOPE_RECORD, { memoryScope: story });
  manager.appendMessage({ role: "user", content: "Say hello", timestamp: Date.now() });
  const sourceEntryId = manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Hello" }], stopReason: "stop", timestamp: Date.now() } as unknown as Parameters<SessionManager["appendMessage"]>[0]);
  const sessionPath = path.join(root, "session.jsonl");
  manager.getSessionFile = () => sessionPath;
  const model = { id: "fixture", provider: "openai", api: "openai-completions" };
  const rawStream = vi.fn(async (_model: unknown, _context: { systemPrompt: string; tools: unknown[] }) => ({
    result: async () => ({ content: [{ type: "text", text: "Hi!" }], stopReason: "stop" }),
  }));
  const session = { sessionManager: manager, model, agent: { sessionId: "main", streamFn: rawStream,
    state: { model, systemPrompt: owner.buildSystemPrompt({ memoryScope: story }), messages: manager.buildSessionContext().messages } } };
  const entry = { session, agentId: "hana", memoryEnabled: true, experienceEnabled: false, workMode: false,
    runtimePromptAppendix: "\nFROZEN_RUNTIME_APPENDIX", providerCacheAffinityKey: "main-affinity", cachePrefixContract: undefined as unknown };
  const coordinator = Object.assign(Object.create(SessionCoordinator.prototype), {
    _getSessionEntryByPath: () => entry, _sessionIdForPath: () => "sess-projection",
    resolveSessionOwnership: () => ({ agentId: "hana" }),
    _getRuntimeValueForPath: () => null, _turnContextBySession: new Map(),
    _d: { getModels: () => ({ availableModels: [model] }), getAgentById: () => owner, emitEvent: vi.fn() },
  }) as SessionCoordinator;
  coordinator._renewCachePrefixContract(sessionPath, entry, "scoped_post_commit_refresh");
  coordinator._installCachePrefixGuard(sessionPath, entry);
  const engine = {
    getSessionManifest: () => ({ lifecycle: "active", currentLocator: { path: sessionPath } }),
    getSessionIdForPath: () => "sess-projection", ensureSessionLoaded: async () => session,
    setSessionBranchHead: vi.fn(), getSessionDialogueVariantStreamFn: (p: string) => coordinator.getSessionDialogueVariantStreamFn(p),
  };
  return { store, owner, session, entry, rawStream, engine, opts: { sessionId: "sess-projection", target: { role: "assistant", entryId: sourceEntryId }, requestId: "first" } };
}

describe("dialogue variant live scope and provenance", () => {
  it("excludes newly invalidated artifacts on every side request without mutating the main prefix", async () => {
    const f = fixture();
    const cachedPrompt = f.session.agent.state.systemPrompt;
    const cachedMessages = f.session.agent.state.messages;
    const contract = f.entry.cachePrefixContract;
    expect(cachedPrompt).toContain("RETRACTED_MEMORY_MARKER");
    await generateSessionDialogueVariant(f.engine, f.opts);
    expect(f.rawStream.mock.calls[0][1].systemPrompt).toContain("RETRACTED_MEMORY_MARKER");
    f.store.invalidateSource("source-a");
    await generateSessionDialogueVariant(f.engine, { ...f.opts, requestId: "second" });
    const prompt = f.rawStream.mock.calls[1][1].systemPrompt;
    expect(prompt).not.toContain("RETRACTED_MEMORY_MARKER");
    expect(prompt).not.toContain("REAL_USER_PROFILE_MARKER");
    expect(prompt).toContain("FROZEN_RUNTIME_APPENDIX");
    expect(f.rawStream.mock.calls[1][1].tools).toEqual([]);
    expect(f.session.agent.state.systemPrompt).toBe(cachedPrompt);
    expect(f.session.agent.state.messages).toBe(cachedMessages);
    expect(f.entry.cachePrefixContract).toBe(contract);
    expect(f.entry.providerCacheAffinityKey).toBe("main-affinity");
  });

  it("uses the durable story scope even when the restored live snapshot is legacy", async () => {
    const f = fixture();
    f.session.agent.state.systemPrompt = f.owner.buildSystemPrompt();
    expect(f.session.agent.state.systemPrompt).toContain("REAL_USER_PROFILE_MARKER");
    await generateSessionDialogueVariant(f.engine, f.opts);
    const prompt = f.rawStream.mock.calls[0][1].systemPrompt;
    expect(prompt).not.toContain("REAL_USER_PROFILE_MARKER");
    expect(prompt).not.toContain("LEGACY_COMPILED_MARKER");
    expect(prompt).toContain("RETRACTED_MEMORY_MARKER");
    expect(f.session.agent.state.systemPrompt).toContain("REAL_USER_PROFILE_MARKER");
  });

  it("reconciles changed current-session source entries before projecting compiled memory", async () => {
    const f = fixture();
    const dependency = f.store.syncSessionSourceSnapshot("sess-projection", story, [
      { entryId: "obsolete", role: "assistant", content: "old source" },
    ]);
    f.store.commitArtifact({ kind: "facts", slot: "obsolete", memoryScope: story, body: "OBSOLETE_SOURCE_MARKER", dependencies: [dependency] });
    expect(f.owner.buildSystemPrompt({ memoryScope: story })).toContain("OBSOLETE_SOURCE_MARKER");
    await generateSessionDialogueVariant(f.engine, f.opts);
    expect(f.rawStream.mock.calls[0][1].systemPrompt).not.toContain("OBSOLETE_SOURCE_MARKER");
  });
});
