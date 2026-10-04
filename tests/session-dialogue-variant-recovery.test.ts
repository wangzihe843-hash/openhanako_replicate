import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../lib/pi-sdk/index.ts";
import { DIALOGUE_VARIANT_ROLLBACK_RECORD_TYPE, projectCurrentSessionBranchEntries, readCurrentSessionBranch } from "../lib/session-jsonl.ts";
import { generateSessionDialogueVariant, adoptSessionDialogueVariant, listSessionDialogueVariants } from "../core/session-dialogue-variants.ts";
import { memoryScopeFromBranch, SESSION_MEMORY_SCOPE_RECORD } from "../core/session-memory-scope.ts";
import { SessionCoordinator } from "../core/session-coordinator.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

async function fixture(narrative = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-variant-recovery-"));
  roots.push(root);
  const manager = SessionManager.create(root, path.join(root, "sessions"));
  if (narrative) manager.appendCustomEntry(SESSION_MEMORY_SCOPE_RECORD, { memoryScope: { version: 1, agentId: "hana", realm: "story", worldId: "world", branchId: "branch", knowledge: "shared" } });
  const inputId = manager.appendMessage({ role: "user", content: "Say hello", timestamp: Date.now() });
  const sourceId = manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Original hello" }], stopReason: "stop", timestamp: Date.now() } as unknown as Parameters<SessionManager["appendMessage"]>[0]);
  const sessionPath = manager.getSessionFile()!;
  const state = { head: null as null | { sessionId: string; leafId: string | null; observedTailLeafId: string | null }, fail: "", failed: false };
  const session = { sessionManager: manager, model: { id: "fixture" }, refreshContext: () => {} };
  const engine = {
    getSessionManifest: () => ({ lifecycle: "active", currentLocator: { path: sessionPath } }),
    getSessionIdForPath: () => "sess-recovery", ensureSessionLoaded: async () => session,
    getSessionDialogueVariantStreamFn: () => async () => ({ result: async () => ({ content: [{ type: "text", text: "Changed hello" }], stopReason: "stop" }) }),
    setSessionBranchHead: (_p: string, head: { leafId: string | null }) => {
      if (state.fail === "before" || state.failed) throw new Error("head store unavailable");
      state.head = { sessionId: "sess-recovery", leafId: head.leafId, observedTailLeafId: manager.getEntries().at(-1)?.id || null };
      if (state.fail === "after") { state.failed = true; throw new Error("head store acknowledgement lost"); }
    },
  };
  const { candidate } = await generateSessionDialogueVariant(engine, { sessionId: "sess-recovery", requestId: "one", target: { role: "assistant", entryId: sourceId } });
  const adopt = () => adoptSessionDialogueVariant(engine, { sessionId: "sess-recovery", candidateId: candidate.candidateId }, { invalidateDerivedState: () => {} });
  const cold = () => {
    const projection = readCurrentSessionBranch(sessionPath, { branchHead: state.head });
    const reopened = SessionManager.open(sessionPath, path.dirname(sessionPath));
    if (projection.selectedLeafId) reopened.branch(projection.selectedLeafId); else reopened.resetLeaf();
    return { projection, messages: reopened.buildSessionContext().messages };
  };
  return { manager, state, engine, candidate, sourceId, inputId, sessionPath, adopt, cold };
}

describe("durable dialogue variant adoption rollback", () => {
  it.each(["before", "after"])("restores the original cold branch when the head write fails %s commit and compensation cannot write the head", async (failure) => {
    const f = await fixture();
    const original = f.manager.buildSessionContext().messages;
    f.state.fail = failure;
    await expect(f.adopt()).rejects.toThrow("head store");
    expect(f.manager.buildSessionContext().messages).toEqual(original);
    expect(f.cold().messages).toEqual(original);
    if (failure === "after") expect(f.cold().projection.headResolution).toBe("dialogue_variant_rollback_recovery");
    expect((await listSessionDialogueVariants(f.engine, { sessionId: "sess-recovery" })).candidates[0].status).toBe("ready");
    expect(f.manager.getEntries().some(entry => entry.id === f.sourceId)).toBe(true);
  });

  it("recovers a failed derived-state update after an acknowledged adoption even if the compensation head write fails", async () => {
    const f = await fixture();
    const original = f.manager.buildSessionContext().messages;
    await expect(adoptSessionDialogueVariant(f.engine, { sessionId: "sess-recovery", candidateId: f.candidate.candidateId }, {
      invalidateDerivedState: () => { f.state.fail = "before"; throw new Error("invalidation unavailable"); },
    })).rejects.toThrow("invalidation unavailable");
    expect(f.cold().messages).toEqual(original);
  });

  it("allows a later successful adoption without reactivating the rejected replacement", async () => {
    const f = await fixture();
    f.state.fail = "after";
    await expect(f.adopt()).rejects.toThrow("acknowledgement lost");
    const rollback = f.manager.getEntries().find(entry => entry.type === "custom" && entry.customType === DIALOGUE_VARIANT_ROLLBACK_RECORD_TYPE)!;
    f.state.fail = "";
    f.state.failed = false;
    const adopted = await f.adopt();
    expect(adopted.candidate.status).toBe("adopted");
    expect(adopted.candidate.adoptedEntryId).not.toBe((rollback as { data: { rejectedEntryId: string } }).data.rejectedEntryId);
    expect(f.cold().messages).toEqual(f.manager.buildSessionContext().messages);
    expect(JSON.stringify(f.cold().messages.at(-1))).toContain("Changed hello");
  });

  it("keeps later restored-branch appends and unrelated explicit rewind selections", async () => {
    const f = await fixture();
    f.state.fail = "after";
    await expect(f.adopt()).rejects.toThrow();
    f.manager.appendMessage({ role: "user", content: "Next turn", timestamp: Date.now() });
    expect(f.cold().messages).toEqual(f.manager.buildSessionContext().messages);
    f.state.head = { sessionId: "sess-recovery", leafId: f.inputId, observedTailLeafId: f.manager.getEntries().at(-1)!.id };
    expect(f.cold().projection.selectedLeafId).toBe(f.inputId);
    expect(f.cold().messages).toHaveLength(1);
  });

  it("keeps generic and narrative active-branch forks independently cold-readable after rollback", async () => {
    const f = await fixture();
    f.state.fail = "after";
    await expect(f.adopt()).rejects.toThrow();
    const projection = f.cold().projection;
    const source = SessionManager.open(f.sessionPath, path.dirname(f.sessionPath));
    source.branch(projection.selectedLeafId!);
    const forkPath = source.createBranchedSession(source.getLeafId()!);
    expect(source.getBranch().some(entry => entry.type === "custom" && entry.customType === DIALOGUE_VARIANT_ROLLBACK_RECORD_TYPE)).toBe(false);
    for (const narrative of [false, true]) {
      if (narrative) source.appendCustomEntry(SESSION_MEMORY_SCOPE_RECORD, { memoryScope: { version: 1, agentId: "hana", realm: "story", worldId: "world", branchId: "fork", knowledge: "shared" } });
      const child = readCurrentSessionBranch(forkPath!, { branchHead: { sessionId: "sess-child", leafId: source.getLeafId(), observedTailLeafId: source.getEntries().at(-1)!.id } });
      expect(child.messages.map(message => message.content)).toEqual(f.cold().projection.messages.map(message => message.content));
      expect(child.messages.some(message => JSON.stringify(message.content).includes("Changed hello"))).toBe(false);
      expect(memoryScopeFromBranch(source.getBranch(), "hana").realm).toBe(narrative ? "story" : "legacy");
    }
  });

  it("also leaves raw SDK open and fork on the restored physical tail", async () => {
    const f = await fixture();
    f.state.fail = "after";
    await expect(f.adopt()).rejects.toThrow();
    const raw = SessionManager.open(f.sessionPath, path.dirname(f.sessionPath));
    expect(raw.buildSessionContext().messages).toEqual(f.cold().messages);
    const childPath = raw.createBranchedSession(raw.getLeafId()!);
    expect(readCurrentSessionBranch(childPath!).messages.map(message => message.content))
      .toEqual(f.cold().projection.messages.map(message => message.content));
  });

  it.each([
    { narrative: false, loaded: false }, { narrative: false, loaded: true },
    { narrative: true, loaded: false }, { narrative: true, loaded: true },
  ])("projects the production fork source after an interrupted final append ($narrative, loaded=$loaded)", async ({ narrative, loaded }) => {
    const f = await fixture(narrative);
    const append = f.manager.appendCustomEntry.bind(f.manager);
    let markerAppended = false;
    const spy = vi.spyOn(f.manager, "appendCustomEntry").mockImplementation((type, data) => {
      if (markerAppended) throw new Error("final compensation append unavailable");
      const id = append(type, data);
      if (type === DIALOGUE_VARIANT_ROLLBACK_RECORD_TYPE) markerAppended = true;
      return id;
    });
    f.state.fail = "after";
    await expect(f.adopt()).rejects.toMatchObject({ code: "dialogue_variant_rollback_failed" });
    spy.mockRestore();
    const raw = SessionManager.open(f.sessionPath, path.dirname(f.sessionPath));
    expect(JSON.stringify(raw.buildSessionContext().messages.at(-1))).toContain("Changed hello");
    const manifest = { sessionId: "sess-recovery", lifecycle: "active", ownerAgentId: "hana", currentLocator: { path: f.sessionPath } };
    const agent = { id: "hana", sessionDir: path.dirname(f.sessionPath) };
    const selected = vi.fn((_input: { retainedEntries: Array<{ id: string }> }) => { throw new Error("fork source selected"); });
    const coordinator = Object.assign(Object.create(SessionCoordinator.prototype), {
      _sessionManifestStore: {
        getBranchHead: () => f.state.head,
        setBranchHead: (_id: string, head: { leafId: string | null; observedTailLeafId: string | null }) => { f.state.head = { sessionId: "sess-recovery", ...head }; },
      },
      _normalizeSessionRef: () => ({ sessionId: manifest.sessionId, sessionPath: f.sessionPath }),
      _resolveSessionWriteRef: () => ({ sessionId: manifest.sessionId, sessionPath: f.sessionPath, manifest }),
      _ensureBranchManifestForPath: () => manifest,
      _assertActiveDesktopSessionPath: () => {}, _assertCurrentActiveSessionLocator: () => {},
      _isDeletedAgentSessionPath: () => false, _getRuntimeValueForPath: () => null,
      _getSessionEntryByPath: () => loaded ? { session: { sessionManager: raw } } : null,
      isSessionStreaming: () => false, isSessionSwitching: () => false,
      resolveSessionOwnership: () => ({ agentId: "hana" }),
      _d: { getAgentById: () => agent }, _ensureAgentRuntimeReady: async () => agent,
      _assertNoSharedActiveForkTasks: selected,
    }) as SessionCoordinator;
    await expect(coordinator._forkSessionAtNodeUnlocked({
      sessionId: manifest.sessionId, mode: narrative ? "narrative_branch" : "fork",
      target: { role: "assistant_turn", turnInputEntryId: f.inputId },
    })).rejects.toThrow("fork source selected");
    const retained = selected.mock.calls[0][0].retainedEntries;
    expect(retained.some(entry => entry.id === f.sourceId)).toBe(true);
    expect(retained.at(-1)?.id).toBe(f.cold().projection.selectedLeafId);
    const canonical = coordinator.openSessionManagerAtCurrentBranch(f.sessionPath);
    const childPath = canonical.createBranchedSession(retained.at(-1)!.id);
    expect(readCurrentSessionBranch(childPath!).messages.map(message => message.content)).toEqual(f.cold().projection.messages.map(message => message.content));
  });

  it.each(["candidateId", "sessionId", "sourceEntryId", "rejectedEntryId", "restoredLeafId", "version"])("fails closed for a malformed %s recovery field", async (field) => {
    const f = await fixture();
    f.state.fail = "after";
    await expect(f.adopt()).rejects.toThrow();
    const entries = JSON.parse(JSON.stringify(f.manager.getEntries()));
    const rollback = entries.find(entry => entry.customType === DIALOGUE_VARIANT_ROLLBACK_RECORD_TYPE);
    rollback.data[field] = field === "version" ? 2 : "unrelated";
    expect(() => projectCurrentSessionBranchEntries(entries, { branchHead: f.state.head })).toThrow(expect.objectContaining({ code: "session_branch_invalid_variant_rollback" }));
  });
});
