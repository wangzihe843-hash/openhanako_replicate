import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Extension, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import {
  AuthStorage, createAgentSession, createModelRegistry, DefaultResourceLoader,
  registerModelProvider, SessionManager, SettingsManager,
} from "../lib/pi-sdk/index.ts";
import { SessionCoordinator } from "../core/session-coordinator.ts";
import {
  adoptSessionDialogueVariant, cancelSessionDialogueVariant, discardSessionDialogueVariant,
  generateSessionDialogueVariant, listSessionDialogueVariants, type ExpressionTransport,
} from "../core/session-dialogue-variants.ts";
import {
  compactSessionWithCachePreservationRecoveringRuntime, isDirectCompactionInProgress,
  runLossyLocalCompactionForSession,
} from "../core/session-compactor.ts";
import { createChatRoute } from "../server/routes/chat.ts";
import { INSTANT_SIMPLE_COMPACTION_METHOD } from "../shared/compaction-mode.ts";

const ORIGINAL = `ORIGINAL_FINAL ${"x".repeat(100_000)}`;
const ADOPTED = `ADOPTED_FINAL ${"y".repeat(100_000)}`;
const cleanup: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dispose of cleanup.splice(0).reverse()) dispose();
});

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture({ summaryInstalled = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-variant-compaction-"));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const sessionDir = path.join(root, "agents", "fixture", "sessions");
  const manager = SessionManager.create(root, sessionDir);
  const append = (message: unknown) => manager.appendMessage(message as Parameters<SessionManager["appendMessage"]>[0]);
  append({ role: "user", content: "Older question", timestamp: 1 });
  append({ role: "assistant", content: [{ type: "text", text: "Older answer" }], stopReason: "stop", timestamp: 2 });
  append({ role: "user", content: "Report the completed work", timestamp: 3 });
  append({ role: "assistant", content: [{ type: "toolCall", id: "completed", name: "fixture", arguments: {} }], stopReason: "toolUse", timestamp: 4 });
  const toolResultId = append({ role: "toolResult", toolCallId: "completed", toolName: "fixture", content: [{ type: "text", text: "Completed receipt" }], timestamp: 5 });
  const sourceId = append({ role: "assistant", content: [{ type: "text", text: ORIGINAL }], stopReason: "stop", timestamp: 6 });
  const sessionPath = manager.getSessionFile()!;
  const sessionId = manager.getSessionId();
  const hooks = {
    beforeSummary: async (_event: SessionBeforeCompactEvent) => {},
    cancelSummary: false,
    getSummarySource: async () => ({ summary: "Synthetic older-region summary" }),
  };
  const preparations: SessionBeforeCompactEvent["preparation"][] = [];
  const registry = await createModelRegistry(AuthStorage.inMemory());
  registerModelProvider(registry, "ma01-fixture", {
    baseUrl: "https://example.invalid/v1", api: "openai-completions", apiKey: "synthetic-only",
    models: [{ id: "fake", name: "Fake", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 4096 }],
    streamSimple: () => { throw new Error("Unexpected model request: compaction uses the synthetic summary hook"); },
  });
  async function makeRuntime(sm: SessionManager, installSummary = true) {
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
      retry: { enabled: false }, cacheWarming: "off",
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd: root, agentDir: root, settingsManager, systemPrompt: "Synthetic fixture",
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    });
    await resourceLoader.reload();
    if (installSummary) {
      const extension = {
        path: "ma01-synthetic-summary", tools: new Map(), flags: new Map(), shortcuts: new Map(),
        commands: new Map(), messageRenderers: new Map(),
        handlers: new Map([["session_before_compact", [async (event: SessionBeforeCompactEvent) => {
          preparations.push(event.preparation);
          await hooks.beforeSummary(event);
          if (hooks.cancelSummary) return { cancel: true };
          return { compaction: { summary: "Synthetic older-region summary; retain the final answer verbatim.",
            firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } };
        }]]]),
      } as unknown as Extension;
      const getExtensions = resourceLoader.getExtensions.bind(resourceLoader);
      resourceLoader.getExtensions = () => ({ ...getExtensions(), extensions: [extension] });
    }
    const { session } = await createAgentSession({
      cwd: root, agentDir: root, modelRegistry: registry, model: registry.find("ma01-fixture", "fake"),
      resourceLoader, settingsManager, sessionManager: sm, tools: [],
    });
    cleanup.push(() => session.dispose());
    return session;
  }
  const session = await makeRuntime(manager, summaryInstalled);
  const owner = { id: "fixture", sessionDir, runtimeInitialized: true };
  const coordinator = new SessionCoordinator({
    agentsDir: path.join(root, "agents"), memoryPressure: { enabled: false },
    getAgent: () => owner, getAgentById: () => owner, agentIdFromSessionPath: () => owner.id,
    getModels: () => ({ availableModels: [session.model] }), emitEvent: () => {},
  });
  coordinator._sessions.set(sessionPath, { session, agentId: owner.id, sessionId, sessionPath, memoryEnabled: false });
  const streamFn: ExpressionTransport = () => ({ result: async () => ({ content: [{ type: "text", text: ADOPTED }], stopReason: "stop" }) });
  const engine = {
    agentsDir: path.join(root, "agents"), hanakoHome: root,
    preferences: { getExperimentValue: () => true },
    getSessionManifest: () => ({ lifecycle: "active", currentLocator: { path: sessionPath } }),
    getSessionIdForPath: () => sessionId,
    getSessionByPath: coordinator.getSessionByPath.bind(coordinator),
    ensureSessionLoaded: coordinator.ensureSessionLoaded.bind(coordinator),
    withSessionCompaction: coordinator.withSessionCompaction.bind(coordinator),
    isSessionStreaming: coordinator.isSessionStreaming.bind(coordinator),
    isSessionSwitching: coordinator.isSessionSwitching.bind(coordinator),
    getSessionDialogueVariantStreamFn: () => streamFn,
    getLossyLocalCompactionSummarySource: () => hooks.getSummarySource(),
    setSessionBranchHead: vi.fn(), emitEvent: vi.fn(),
  };
  const options = { sessionId, requestId: "ready", target: { role: "assistant", entryId: sourceId } };
  const { candidate } = await generateSessionDialogueVariant(engine, options);
  const adopt = () => adoptSessionDialogueVariant(engine, { sessionId, candidateId: candidate.candidateId }, { invalidateDerivedState: () => {} });
  const compact = () => coordinator.withSessionCompaction(sessionPath, coordinator.getSessionByPath(sessionPath), ({ reloadSessionRuntime }) =>
    compactSessionWithCachePreservationRecoveringRuntime({ session: coordinator.getSessionByPath(sessionPath), sessionPath, reloadSessionRuntime: () => reloadSessionRuntime() }));
  const snapshot = () => {
    const sm = coordinator.getSessionByPath(sessionPath).sessionManager;
    return { leaf: sm.getLeafId(), branch: JSON.stringify(sm.getBranch()), entries: JSON.stringify(sm.getEntries()), bytes: fs.readFileSync(sessionPath) };
  };
  const cold = () => SessionManager.open(sessionPath, sessionDir);
  return { root, sessionDir, manager, sourceId, toolResultId, sessionPath, sessionId, session, hooks, preparations,
    makeRuntime, coordinator, engine, options, candidate, adopt, compact, snapshot, cold };
}

function chatCompaction(f: Awaited<ReturnType<typeof fixture>>, method?: typeof INSTANT_SIMPLE_COMPACTION_METHOD) {
  type Message = { type: string; status?: string; reason?: string };
  let createHandlers!: (context: object) => { onMessage(event: { data: string }, socket: { readyState: number; send(raw: string): void }): void };
  // The production route is invoked in memory; no socket or listener is opened.
  createChatRoute(f.engine, { subscribe: vi.fn(), send: vi.fn() }, {
    upgradeWebSocket: factory => { createHandlers = factory; return () => new Response(null); },
  });
  const messages: Message[] = [];
  const result = new Promise<Message>(resolve => {
    createHandlers({}).onMessage({ data: JSON.stringify({ type: "compact", sessionId: f.sessionId, method }) }, {
      readyState: 1, send: raw => {
        const message = JSON.parse(raw);
        messages.push(message);
        if (message.type === "compaction_result" || message.type === "error") resolve(message);
      },
    });
  });
  return { messages, result };
}

function expectRetained(manager: SessionManager, answerId: string, text: string) {
  const branch = manager.getBranch();
  const checkpoint = branch.findLast(entry => entry.type === "compaction");
  expect(checkpoint).toMatchObject({ firstKeptEntryId: answerId });
  expect(branch.some(entry => entry.id === checkpoint.firstKeptEntryId)).toBe(true);
  expect(JSON.stringify(manager.buildSessionContext().messages)).toContain(text);
}

describe("dialogue adoption and real compaction admission", () => {
  it("rejects adoption during a paused manual summary without any branch or JSONL write, then rejects stale adoption", async () => {
    const f = await fixture();
    const entered = gate(), release = gate();
    f.hooks.beforeSummary = async () => { entered.resolve(); await release.promise; };
    const compact = chatCompaction(f);
    try {
      await entered.promise;
      expect(f.preparations[0].firstKeptEntryId).toBe(f.sourceId);
      expect(f.engine.isSessionSwitching(f.sessionPath)).toBe(true);
      expect(f.session.isCompacting).toBe(true);
      expect(f.engine.isSessionStreaming(f.sessionPath)).toBe(false);
      expect(await chatCompaction(f).result).toMatchObject({ status: "failed", reason: "session_busy" });
      const before = f.snapshot();
      await expect(f.adopt().then(result => result.candidate.status)).rejects.toMatchObject({ status: 409, code: "session_busy" });
      expect(f.snapshot()).toEqual(before);
    } finally { release.resolve(); await compact.result; }
    expect(await compact.result).toMatchObject({ status: "succeeded" });
    expect(f.engine.isSessionSwitching(f.sessionPath)).toBe(false);
    expectRetained(f.manager, f.sourceId, ORIGINAL);
    expectRetained(f.cold(), f.sourceId, ORIGINAL);
    const before = f.snapshot();
    await expect(f.adopt().then(result => result.candidate.status)).rejects.toMatchObject({ code: "dialogue_variant_stale" });
    expect(f.snapshot()).toEqual(before);
  });

  it("observes the reservation before SDK compact sets isCompacting", async () => {
    const f = await fixture();
    const entered = gate(), release = gate();
    const abort = f.session.abort.bind(f.session);
    vi.spyOn(f.session, "abort").mockImplementation(async () => { await abort(); entered.resolve(); await release.promise; });
    const compact = f.compact();
    try {
      await entered.promise;
      expect(f.session.isCompacting).toBe(false);
      expect(f.engine.isSessionSwitching(f.sessionPath)).toBe(true);
      const before = f.snapshot();
      await expect(f.adopt().then(result => result.candidate.status)).rejects.toMatchObject({ code: "session_busy" });
      expect(f.snapshot()).toEqual(before);
    } finally { release.resolve(); await compact; }
    expectRetained(f.cold(), f.sourceId, ORIGINAL);
  });

  it("also rejects adoption during direct SDK compaction without a coordinator reservation", async () => {
    const f = await fixture();
    const entered = gate(), release = gate();
    f.hooks.beforeSummary = async () => { entered.resolve(); await release.promise; };
    const compact = f.session.compact();
    try {
      await entered.promise;
      expect(f.engine.isSessionSwitching(f.sessionPath)).toBe(false);
      expect(f.session.isCompacting).toBe(true);
      const before = f.snapshot();
      await expect(f.adopt().then(result => result.candidate.status)).rejects.toMatchObject({ code: "session_busy" });
      expect(f.snapshot()).toEqual(before);
    } finally { release.resolve(); await compact; }
    expectRetained(f.cold(), f.sourceId, ORIGINAL);
  });

  it.each(["manual instant", "direct local"])("protects the retained anchor during %s compaction", async mode => {
    const f = await fixture();
    const entered = gate(), release = gate();
    f.hooks.getSummarySource = async () => { entered.resolve(); await release.promise; return { summary: "Synthetic instant summary" }; };
    const compact = mode === "manual instant" ? chatCompaction(f, INSTANT_SIMPLE_COMPACTION_METHOD).result
      : runLossyLocalCompactionForSession(f.session, { getSummarySource: f.hooks.getSummarySource });
    try {
      await Promise.race([entered.promise, compact.then(() => { throw new Error("local summary did not pause"); })]);
      expect(f.session.isCompacting).toBe(false);
      expect(isDirectCompactionInProgress(f.session)).toBe(true);
      expect(f.engine.isSessionSwitching(f.sessionPath)).toBe(mode === "manual instant");
      const before = f.snapshot();
      await expect(f.adopt().then(result => result.candidate.status)).rejects.toMatchObject({ code: "session_busy" });
      expect(f.snapshot()).toEqual(before);
    } finally { release.resolve(); await compact; }
    if (mode === "manual instant") expect(await compact).toMatchObject({ status: "succeeded" });
    expect(isDirectCompactionInProgress(f.session)).toBe(false);
    expectRetained(f.cold(), f.sourceId, ORIGINAL);
  });

  it("keeps adoption before compaction valid, with completed effects and the new anchor surviving reopen", async () => {
    const f = await fixture();
    const result = await f.adopt();
    expect(result.candidate.status).toBe("adopted");
    expect(f.manager.getBranch().some(entry => entry.id === f.toolResultId)).toBe(true);
    expect(f.manager.getBranch().some(entry => entry.id === f.sourceId)).toBe(false);
    expect(f.manager.getEntries().some(entry => entry.id === f.sourceId)).toBe(true);
    await f.compact();
    expectRetained(f.manager, result.candidate.adoptedEntryId!, ADOPTED);
    expectRetained(f.cold(), result.candidate.adoptedEntryId!, ADOPTED);
  });

  it("rejects a completed compaction as stale without rewriting its branch", async () => {
    const f = await fixture();
    await f.compact();
    const before = f.snapshot();
    await expect(f.adopt().then(result => result.candidate.status)).rejects.toMatchObject({ code: "dialogue_variant_stale" });
    expect(f.snapshot()).toEqual(before);
    expectRetained(f.cold(), f.sourceId, ORIGINAL);
  });

  it("rechecks after an adoption load queued across the real runtime reload and compaction retry", async () => {
    const f = await fixture({ summaryInstalled: false });
    const teardownEntered = gate(), releaseTeardown = gate(), summaryEntered = gate(), releaseSummary = gate();
    // Only runtime construction/disposal are replaced. The coordinator reservation,
    // reload owner check, runtime queue, ensureSessionLoaded, and SDK compact all run.
    vi.spyOn(f.coordinator, "_teardownSessionEntry").mockImplementation(async old => {
      teardownEntered.resolve(); await releaseTeardown.promise; old.session.dispose();
    });
    vi.spyOn(f.coordinator, "_createSessionRuntime").mockImplementation(async sm => {
      const session = await f.makeRuntime(sm);
      f.coordinator._sessions.set(f.sessionPath, { session, agentId: "fixture", sessionPath: f.sessionPath, memoryEnabled: false });
      return { session, sessionPath: f.sessionPath } as Awaited<ReturnType<SessionCoordinator["_createSessionRuntime"]>>;
    });
    f.hooks.beforeSummary = async () => { summaryEntered.resolve(); await releaseSummary.promise; };
    const compact = f.compact();
    let adoption: Promise<unknown> | undefined;
    try {
      await Promise.race([teardownEntered.promise, compact.then(() => { throw new Error("reload did not pause"); })]);
      expect(f.engine.isSessionSwitching(f.sessionPath)).toBe(true);
      let settled = false;
      adoption = f.adopt().then(value => { settled = true; return value.candidate.status; }, error => { settled = true; return error; });
      await new Promise(resolve => setImmediate(resolve));
      expect(settled).toBe(false);
      releaseTeardown.resolve();
      await Promise.race([summaryEntered.promise, compact.then(() => { throw new Error("summary did not pause"); })]);
      expect(f.coordinator.getSessionByPath(f.sessionPath)).not.toBe(f.session);
      const before = f.snapshot();
      expect(await adoption).toMatchObject({ code: "session_busy", status: 409 });
      expect(f.snapshot()).toEqual(before);
    } finally { releaseTeardown.resolve(); releaseSummary.resolve(); await Promise.all([compact, adoption]); }
    expect((await compact).recovered).toBe(true);
    expectRetained(f.cold(), f.sourceId, ORIGINAL);
    expect(f.coordinator._sessionRuntimeOperations.size).toBe(0);
    expect(f.coordinator._sessionCompactionOwners.size).toBe(0);
  });

  it("keeps list, cancel and discard available during a paused summary", async () => {
    const f = await fixture();
    const entered = gate(), release = gate();
    f.hooks.beforeSummary = async () => { entered.resolve(); await release.promise; };
    const compact = f.compact();
    try {
      await entered.promise;
      expect((await listSessionDialogueVariants(f.engine, f.options)).candidates[0].status).toBe("ready");
      expect((await cancelSessionDialogueVariant(f.engine, { sessionId: f.sessionId, candidateId: f.candidate.candidateId })).candidate.status).toBe("ready");
      expect((await discardSessionDialogueVariant(f.engine, { sessionId: f.sessionId, candidateId: f.candidate.candidateId })).candidate.status).toBe("discarded");
    } finally { release.resolve(); await compact; }
    expectRetained(f.cold(), f.sourceId, ORIGINAL);
  });

  it("releases both reservations on cancelled compaction so the original candidate can still be adopted", async () => {
    const f = await fixture();
    const entered = gate(), release = gate();
    f.hooks.beforeSummary = async () => { entered.resolve(); await release.promise; };
    const compact = f.compact();
    const cancelled = expect(compact).rejects.toThrow("Compaction cancelled");
    try {
      await entered.promise;
      await expect(f.adopt().then(result => result.candidate.status)).rejects.toMatchObject({ code: "session_busy" });
    } finally { f.session.abortCompaction(); release.resolve(); await cancelled; }
    expect(f.engine.isSessionSwitching(f.sessionPath)).toBe(false);
    expect(f.session.isCompacting).toBe(false);
    expect((await f.adopt()).candidate.status).toBe("adopted");
    expect(JSON.stringify(f.cold().buildSessionContext().messages)).toContain(ADOPTED);
  });

  it("preserves the existing streaming rejection through the real coordinator preprompt state", async () => {
    const f = await fixture();
    f.coordinator._prePromptAbortControllers.set(f.sessionPath, new AbortController());
    const before = f.snapshot();
    await expect(f.adopt().then(result => result.candidate.status)).rejects.toMatchObject({ code: "session_busy" });
    expect(f.snapshot()).toEqual(before);
    f.coordinator._prePromptAbortControllers.delete(f.sessionPath);
    expect((await f.adopt()).candidate.status).toBe("adopted");
  });
});
