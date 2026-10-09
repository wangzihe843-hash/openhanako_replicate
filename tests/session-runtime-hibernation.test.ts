import path from "path";
import fs from "node:fs";
import os from "node:os";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { createAgentSessionMock, sessionManagerCreateMock, sessionManagerOpenMock, emitSessionShutdownMock, refreshSessionModelFromRegistryMock } = vi.hoisted(() => ({
  createAgentSessionMock: vi.fn(),
  sessionManagerCreateMock: vi.fn(),
  sessionManagerOpenMock: vi.fn(),
  emitSessionShutdownMock: vi.fn(),
  refreshSessionModelFromRegistryMock: vi.fn(),
}));

const { runtimeWarnMock } = vi.hoisted(() => ({ runtimeWarnMock: vi.fn() }));

vi.mock("../lib/pi-sdk/index.js", () => ({
  createAgentSession: createAgentSessionMock,
  emitSessionShutdown: emitSessionShutdownMock,
  SessionManager: {
    create: sessionManagerCreateMock,
    open: sessionManagerOpenMock,
  },
  SettingsManager: {
    inMemory: vi.fn(() => ({})),
  },
  estimateTokens: vi.fn(() => 0),
  findCutPoint: vi.fn(() => 0),
  generateSummary: vi.fn(),
  getPiModels: vi.fn(() => []),
  refreshSessionModelFromRegistry: refreshSessionModelFromRegistryMock,
}));

vi.mock("../lib/debug-log.js", () => ({
  createModuleLogger: () => ({
    log: vi.fn(),
    warn: runtimeWarnMock,
    error: vi.fn(),
  }),
}));

import { SessionCoordinator } from "../core/session-coordinator.ts";
import { createChatRoute } from "../server/routes/chat.ts";
import type { SessionManager as PiSessionManager } from "../lib/pi-sdk/index.ts";
import type { RuntimeCompactionResult } from "../core/runtime-contracts.ts";

const MODEL = {
  id: "test-model",
  name: "test-model",
  provider: "test",
  input: ["text", "image"],
};

// Unit coverage for manual entry points. Keep the SDK operations synthetic;
// the concurrency suite below separately exercises the real JSONL manager.
describe("manual operations during runtime hibernation", () => {
  let root: string;
  let coord: SessionCoordinator;
  let aPath: string;
  let bPath: string;
  let oldA: ReturnType<typeof runtime>;
  let oldB: ReturnType<typeof runtime>;
  let releases: Array<() => void>;
  let pending: Promise<unknown>[];
  let transcripts: Map<string, Buffer>;
  const nextModel = { ...MODEL, id: "synthetic-next", contextWindow: 128_000 };

  function barrier() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    releases.push(resolve);
    return { promise, resolve };
  }

  async function bounded<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    pending.push(promise);
    try {
      return await Promise.race([promise, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("manual operation did not settle")), 2000);
      })]);
    } finally { clearTimeout(timer!); }
  }

  function compactionResult(summary: string): RuntimeCompactionResult {
    return { summary, firstKeptEntryId: "synthetic-kept-entry", tokensBefore: 0 };
  }

  function runtime(sessionPath: string) {
    const session = makeSession(sessionPath, {
      disposed: false,
      abort: vi.fn(async () => {}),
      extensionRunner: { assertActive: vi.fn(), hasHandlers: vi.fn(() => true) },
      compact: vi.fn(async () => {
        if (session.disposed) throw new Error("compact on disposed runtime");
        return compactionResult("synthetic compaction");
      }),
      setModel: vi.fn(async (model: typeof MODEL) => {
        if (session.disposed) throw new Error("setModel on disposed runtime");
        session.model = model;
      }),
    });
    session.dispose.mockImplementation(() => { session.disposed = true; });
    return session;
  }

  function chatHarness() {
    type ChatMessage = { type: string; status?: string; reason?: string };
    let createHandlers: (context: object) => {
      onMessage(event: { data: string }, socket: { readyState: number; send(raw: string): void }): void;
    };
    const instantCompact = vi.fn(async (session) => session.compact());
    createChatRoute({
      agentsDir: path.join(root, "agents"), hanakoHome: root,
      preferences: { getExperimentValue: (id) => id === "session.instant_simple_compaction" ? true : undefined },
      getSessionManifest: (id) => ({ currentLocator: { path: id === "a" ? aPath : bPath } }),
      getSessionByPath: coord.getSessionByPath.bind(coord),
      ensureSessionLoaded: coord.ensureSessionLoaded.bind(coord),
      reloadSessionRuntime: coord.reloadSessionRuntime.bind(coord),
      withSessionCompaction: coord.withSessionCompaction.bind(coord),
      isSessionStreaming: coord.isSessionStreaming.bind(coord),
      isSessionSwitching: coord.isSessionSwitching.bind(coord),
      getLossyLocalCompactionSummarySource: () => ({ summary: "synthetic summary" }),
    }, { subscribe: vi.fn(), send: vi.fn() }, {
      upgradeWebSocket: (factory) => { createHandlers = factory; return () => new Response(null); },
      runInstantSimpleCompaction: instantCompact,
    });
    const handlers = createHandlers({});
    return {
      instantCompact,
      compact(sessionId = "a", method?: string) {
        const messages: ChatMessage[] = [];
        const result = new Promise<ChatMessage>((resolve) => {
          handlers.onMessage({ data: JSON.stringify({ type: "compact", sessionId, method }) }, {
            readyState: 1,
            send: (raw) => {
              const message = JSON.parse(raw);
              messages.push(message);
              if (message.type === "compaction_result" || message.type === "error") resolve(message);
            },
          });
        });
        return { messages, result: bounded(result) };
      },
    };
  }

  function delayedShutdown(fail = false) {
    const entered = barrier(); const release = barrier();
    emitSessionShutdownMock.mockImplementationOnce(async () => {
      entered.resolve(); await release.promise;
      if (fail) throw new Error("synthetic shutdown failure");
      return true;
    });
    const sleeping = coord.hibernateSessionRuntime(aPath, "test");
    pending.push(sleeping);
    return { entered, release, sleeping };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    releases = []; pending = []; transcripts = new Map();
    root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-manual-hibernate-"));
    const sessionDir = path.join(root, "agents", "hana", "sessions");
    fs.mkdirSync(sessionDir, { recursive: true });
    aPath = path.join(sessionDir, "a.jsonl"); bPath = path.join(sessionDir, "b.jsonl");
    for (const file of [aPath, bPath]) {
      fs.writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: path.basename(file),
        cwd: root, timestamp: "2026-10-08T00:00:00.000Z" }) + "\n");
      transcripts.set(file, fs.readFileSync(file));
    }
    coord = makeCoordinator({ root });
    oldA = runtime(aPath); oldB = runtime(bPath);
    for (const [file, session] of [[aPath, oldA], [bPath, oldB]] as const) {
      coord._sessions.set(file, { session, unsub: vi.fn(), agentId: "hana",
        modelId: MODEL.id, modelProvider: MODEL.provider });
    }
    coord._session = oldA; coord._currentSessionPath = aPath;
    emitSessionShutdownMock.mockReset().mockResolvedValue(true);
    refreshSessionModelFromRegistryMock.mockReturnValue(true);
    sessionManagerOpenMock.mockImplementation((file) => ({ getSessionFile: () => file, getCwd: () => root }));
    createAgentSessionMock.mockImplementation(async ({ sessionManager }) => ({ session: runtime(sessionManager.getSessionFile()) }));
  });

  afterEach(async () => {
    for (const release of releases) release();
    try {
      await bounded(Promise.allSettled(pending));
      expect(coord._sessionCompactionOwners.size).toBe(0);
      expect(coord._sessionRuntimeOperations.size).toBe(0);
      expect(coord._sessionRuntimeClosures.size).toBe(0);
      expect(coord._sessionRuntimeCreations.size).toBe(0);
      for (const [file, original] of transcripts) expect(fs.readFileSync(file)).toEqual(original);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it.each([undefined, "instant_simple"])("rejects compact (%s) during shutdown and accepts a retry on the restored runtime", async (method) => {
    const chat = chatHarness();
    const gate = delayedShutdown();
    await bounded(gate.entered.promise);
    const request = chat.compact("a", method);
    expect(await request.result).toMatchObject({ type: "compaction_result", status: "failed", reason: "session_busy" });
    expect(request.messages.some((message) => message.type === "compaction_accepted")).toBe(false);
    expect(oldA.compact).not.toHaveBeenCalled();
    expect(chat.instantCompact).not.toHaveBeenCalled();
    // Reserving A must not hold up another session's manual operation.
    expect(await chat.compact("b", method).result).toMatchObject({ status: "succeeded" });
    expect(oldB.compact).toHaveBeenCalledOnce();
    gate.release.resolve();
    await bounded(gate.sleeping);
    expect(await chat.compact("a", method).result).toMatchObject({ status: "succeeded" });
    const restored = coord.getSessionByPath(aPath);
    expect(restored).not.toBe(oldA);
    expect(restored.disposed).toBe(false);
    expect(restored.compact).toHaveBeenCalledOnce();
    expect(oldA.dispose).toHaveBeenCalledOnce();
    expect(oldA.compact).not.toHaveBeenCalled();
    expect(coord._sessionRuntimeOperations.size).toBe(0);
  });

  it("rejects model switching during shutdown while another path and a restored runtime remain usable", async () => {
    const gate = delayedShutdown();
    await bounded(gate.entered.promise);
    await expect(bounded(coord.switchSessionModel(aPath, nextModel))).rejects.toThrow("Model switch already in progress");
    expect(oldA.setModel).not.toHaveBeenCalled();
    await bounded(coord.switchSessionModel(bPath, nextModel));
    expect(oldB.setModel).toHaveBeenCalledWith(nextModel);
    gate.release.resolve();
    await bounded(gate.sleeping);
    await bounded(coord.switchSessionModel(aPath, nextModel));
    const restored = coord.getSessionByPath(aPath);
    expect(restored).not.toBe(oldA);
    expect(restored.disposed).toBe(false);
    expect(restored.setModel).toHaveBeenCalledWith(nextModel);
    expect(oldA.setModel).not.toHaveBeenCalled();
    expect(oldA.dispose).toHaveBeenCalledOnce();
    expect(coord._sessionRuntimeOperations.size).toBe(0);
  });

  it.each(["compactDesktopSession", "freshCompactDesktopSession"])("excludes the %s engine entry point during shutdown", async (method) => {
    const { HanaEngine } = await import("../core/engine.ts");
    // Exercise the real facade method without booting an application or loading credentials.
    const engine = Object.create(HanaEngine.prototype);
    engine._sessionCoord = coord;
    const gate = delayedShutdown();
    await bounded(gate.entered.promise);
    const request = engine[method](aPath);
    pending.push(request);
    void request.catch(() => {});
    expect(oldA.compact).not.toHaveBeenCalled();
    await expect(bounded(request)).rejects.toThrow("session_busy");
    await bounded(engine[method](bPath));
    expect(oldB.compact).toHaveBeenCalledOnce();
    gate.release.resolve();
    await bounded(gate.sleeping);
    await bounded(coord.ensureSessionLoaded(aPath));
    const restored = coord.getSessionByPath(aPath);
    await bounded(engine[method](aPath));
    expect(restored.compact).toHaveBeenCalledOnce();
    expect(oldA.compact).not.toHaveBeenCalled();
    expect(oldA.dispose).toHaveBeenCalledOnce();
    expect(coord._sessionRuntimeOperations.size).toBe(0);
  });

  it("keeps manual operations excluded when shutdown fails and allows both after restoration", async () => {
    const chat = chatHarness();
    const gate = delayedShutdown(true);
    await bounded(gate.entered.promise);
    expect(await chat.compact().result).toMatchObject({ status: "failed", reason: "session_busy" });
    await expect(bounded(coord.switchSessionModel(aPath, nextModel))).rejects.toThrow("Model switch already in progress");
    gate.release.resolve();
    await expect(bounded(gate.sleeping)).resolves.toBe(true);
    expect(runtimeWarnMock).toHaveBeenCalledWith(expect.stringContaining("emitSessionShutdown failed: synthetic shutdown failure"));
    expect(oldA.dispose).toHaveBeenCalledOnce();
    expect(await chat.compact().result).toMatchObject({ status: "succeeded" });
    await bounded(coord.switchSessionModel(aPath, nextModel));
    expect(oldA.compact).not.toHaveBeenCalled();
    expect(oldA.setModel).not.toHaveBeenCalled();
    expect(coord.isSessionSwitching(aPath)).toBe(false);
    expect(coord._sessionRuntimeOperations.size).toBe(0);
  });

  it("excludes hibernation and compaction during model switching and releases the busy state on failure", async () => {
    const chat = chatHarness();
    const entered = barrier(); const release = barrier();
    oldA.setModel.mockImplementationOnce(async () => {
      entered.resolve(); await release.promise;
      throw new Error("synthetic model failure");
    });
    const switching = coord.switchSessionModel(aPath, nextModel);
    pending.push(switching);
    await bounded(entered.promise);
    expect(await chat.compact().result).toMatchObject({ status: "failed", reason: "session_busy" });
    await expect(bounded(coord.hibernateSessionRuntime(aPath, "test"))).resolves.toBe(false);
    expect(oldA.dispose).not.toHaveBeenCalled();
    release.resolve();
    await expect(bounded(switching)).rejects.toThrow("synthetic model failure");
    expect(coord.isSessionSwitching(aPath)).toBe(false);
    await expect(bounded(coord.hibernateSessionRuntime(aPath, "test"))).resolves.toBe(true);
    await bounded(coord.switchSessionModel(aPath, nextModel));
    expect(coord.getSessionByPath(aPath)).not.toBe(oldA);
    expect(coord._sessionRuntimeOperations.size).toBe(0);
  });

  it("excludes hibernation and model switching during compact and recovers after compact failure", async () => {
    const chat = chatHarness();
    const entered = barrier(); const release = barrier();
    oldA.compact.mockImplementationOnce(async () => {
      oldA.isCompacting = true;
      try {
        entered.resolve(); await release.promise;
        throw new Error("synthetic compaction failure");
      } finally { oldA.isCompacting = false; }
    });
    const request = chat.compact();
    await bounded(entered.promise);
    await expect(bounded(coord.hibernateSessionRuntime(aPath, "test"))).resolves.toBe(false);
    await expect(bounded(coord.switchSessionModel(aPath, nextModel))).rejects.toThrow("compaction is in progress");
    expect(oldA.dispose).not.toHaveBeenCalled();
    release.resolve();
    expect(await request.result).toMatchObject({ status: "failed", reason: "compaction_failed" });
    await expect(bounded(coord.hibernateSessionRuntime(aPath, "test"))).resolves.toBe(true);
    expect(await chat.compact().result).toMatchObject({ status: "succeeded" });
    expect(coord.getSessionByPath(aPath)).not.toBe(oldA);
    expect(coord._sessionRuntimeOperations.size).toBe(0);
  });

  it.each(["websocket", "compactDesktopSession", "freshCompactDesktopSession"])("reserves %s across the asynchronous SDK abort before its busy marker", async (surface) => {
    const entered = barrier(); const release = barrier();
    // Match the locked SDK's ordering: compact awaits abort before it marks
    // itself busy. This controlled boundary is not a real-SDK acceptance run.
    oldA.abort = vi.fn(async () => { entered.resolve(); await release.promise; });
    oldA.compact.mockImplementationOnce(async () => {
      await oldA.abort();
      oldA.isCompacting = true;
      try {
        if (oldA.disposed) throw new Error("compact resumed on disposed runtime");
        return compactionResult("synthetic compaction after abort");
      } finally { oldA.isCompacting = false; }
    });
    const chat = chatHarness();
    let request: Promise<unknown>;
    if (surface === "websocket") request = chat.compact().result;
    else {
      const { HanaEngine } = await import("../core/engine.ts");
      const engine = Object.create(HanaEngine.prototype);
      engine._sessionCoord = coord;
      request = bounded(engine[surface](aPath));
    }
    void request.catch(() => {});
    await bounded(entered.promise);
    expect(oldA.isCompacting).toBe(false);
    await expect(bounded(coord.hibernateSessionRuntime(aPath, "abort_window"))).resolves.toBe(false);
    await expect(bounded(coord.switchSessionModel(aPath, nextModel))).rejects.toThrow();
    expect(await chat.compact().result).toMatchObject({ status: "failed", reason: "session_busy" });
    expect(await chat.compact("b").result).toMatchObject({ status: "succeeded" });
    expect(oldA.dispose).not.toHaveBeenCalled();
    release.resolve();
    const result = await bounded(request);
    if (surface === "websocket") expect(result).toMatchObject({ status: "succeeded" });
    expect(coord.isSessionSwitching(aPath)).toBe(false);
    await expect(bounded(coord.hibernateSessionRuntime(aPath, "after_compact"))).resolves.toBe(true);
    expect(coord._sessionRuntimeOperations.size).toBe(0);
  });

  it.each([
    ["websocket", false], ["compactDesktopSession", false], ["freshCompactDesktopSession", false],
    ["websocket", true], ["compactDesktopSession", true], ["freshCompactDesktopSession", true],
  ] as const)("keeps %s reserved after reload and through retry (retry fails: %s)", async (surface, failRetry) => {
    const reloaded = barrier(); const resumeRecovery = barrier();
    const retrying = barrier(); const resumeRetry = barrier();
    oldA.extensionRunner.hasHandlers.mockReturnValue(false);
    let restored: ReturnType<typeof runtime>;
    createAgentSessionMock.mockImplementationOnce(async ({ sessionManager }) => {
      restored = runtime(sessionManager.getSessionFile());
      restored.compact.mockImplementationOnce(async () => {
        retrying.resolve(); await resumeRetry.promise;
        if (restored.disposed) throw new Error("retry on disposed runtime");
        if (failRetry) throw new Error("synthetic retry failure");
        return compactionResult("synthetic recovered compaction");
      });
      return { session: restored };
    });
    const reload = coord._reloadSessionRuntime.bind(coord);
    const reloadSpy = vi.spyOn(coord, "_reloadSessionRuntime").mockImplementationOnce(async (...args) => {
      const session = await reload(...args);
      // Hold after the actual coordinator reload and its queue have finished,
      // before the recovery helper receives the new runtime and retries.
      reloaded.resolve(); await resumeRecovery.promise;
      return session;
    });
    const chat = chatHarness();
    let request: Promise<unknown>;
    if (surface === "websocket") request = chat.compact().result;
    else {
      const { HanaEngine } = await import("../core/engine.ts");
      const engine = Object.create(HanaEngine.prototype);
      engine._sessionCoord = coord;
      request = engine[surface](aPath);
      pending.push(request);
    }
    void request.catch(() => {});
    try {
      await bounded(reloaded.promise);
      expect(coord.getSessionByPath(aPath)).toBe(restored);
      expect(coord._sessionRuntimeOperations.size).toBe(0);
      expect(restored.isCompacting).toBe(false);
      expect(restored.compact).not.toHaveBeenCalled();
      expect(oldA.dispose).toHaveBeenCalledOnce();
      await expect(bounded(coord.hibernateSessionRuntime(aPath, "recovery_gap"))).resolves.toBe(false);
      await expect(bounded(coord.reloadSessionRuntime(aPath))).rejects.toThrow("session_busy");
      await expect(bounded(coord.closeSession(aPath))).rejects.toThrow("session_busy");
      await expect(bounded(coord.switchSessionModel(aPath, nextModel))).rejects.toThrow("compaction is in progress");
      await expect(bounded(coord.promptSession(aPath, "synthetic prompt", {}))).rejects.toThrow("session_busy");
      expect(await chat.compact().result).toMatchObject({ status: "failed", reason: "session_busy" });
      expect(await chat.compact("b").result).toMatchObject({ status: "succeeded" });
      expect(restored.dispose).not.toHaveBeenCalled();
      resumeRecovery.resolve();
      await bounded(retrying.promise);
      await expect(bounded(coord.hibernateSessionRuntime(aPath, "during_retry"))).resolves.toBe(false);
      expect(restored.dispose).not.toHaveBeenCalled();
      resumeRetry.resolve();
      if (surface === "websocket") {
        expect(await bounded(request)).toMatchObject(failRetry
          ? { status: "failed", reason: "compaction_failed" } : { status: "succeeded" });
      } else if (failRetry) await expect(bounded(request)).rejects.toThrow("synthetic retry failure");
      else await bounded(request);
      expect(coord.isSessionSwitching(aPath)).toBe(false);
      expect(await chat.compact().result).toMatchObject({ status: "succeeded" });
      await expect(bounded(coord.hibernateSessionRuntime(aPath, "after_retry"))).resolves.toBe(true);
    } finally {
      resumeRecovery.resolve(); resumeRetry.resolve();
      reloadSpy.mockRestore();
    }
  });

  it("rejects compact before acceptance when hibernation is queued but has not entered shutdown", async () => {
    const chat = chatHarness();
    const sleeping = coord.hibernateSessionRuntime(aPath, "queued_first");
    pending.push(sleeping);
    const request = chat.compact();
    expect(await request.result).toMatchObject({ status: "failed", reason: "session_busy" });
    expect(request.messages.some((message) => message.type === "compaction_accepted")).toBe(false);
    expect(oldA.compact).not.toHaveBeenCalled();
    await expect(bounded(sleeping)).resolves.toBe(true);
  });

  it("releases a failed fresh refresh so the missing runtime can be restored", async () => {
    const { HanaEngine } = await import("../core/engine.ts");
    const engine = Object.create(HanaEngine.prototype);
    engine._sessionCoord = coord;
    createAgentSessionMock.mockRejectedValueOnce(new Error("synthetic fresh refresh failure"));
    await expect(bounded(engine.freshCompactDesktopSession(aPath))).rejects.toThrow("synthetic fresh refresh failure");
    expect(oldA.compact).toHaveBeenCalledOnce();
    expect(oldA.dispose).toHaveBeenCalledOnce();
    expect(coord.isSessionSwitching(aPath)).toBe(false);
    expect(await chatHarness().compact().result).toMatchObject({ status: "succeeded" });
    expect(coord.getSessionByPath(aPath)).not.toBe(oldA);
  });

  it("expires scoped reload after a synchronous operation failure", async () => {
    let staleReload: () => Promise<unknown>;
    await expect(bounded(coord.withSessionCompaction(aPath, oldA, ({ reloadSessionRuntime }) => {
      staleReload = reloadSessionRuntime;
      throw new Error("synthetic admission callback failure");
    }))).rejects.toThrow("synthetic admission callback failure");
    expect(coord.isSessionSwitching(aPath)).toBe(false);
    await expect(bounded(staleReload!())).rejects.toThrow("session_busy");
    expect(oldA.dispose).not.toHaveBeenCalled();
    expect(await chatHarness().compact().result).toMatchObject({ status: "succeeded" });
  });

  describe("closing admission during compact", () => {
    function cleanupSpies() {
      const spies = {
        abortBySession: vi.fn(), clearBySession: vi.fn(), closeTerminalsForSession: vi.fn(),
        closeAllTerminals: vi.fn(), onSessionRuntimeDiscarded: vi.fn(),
      };
      coord._d.getConfirmStore = () => spies;
      coord._d.getDeferredResultStore = () => spies;
      Object.assign(coord._d, { closeTerminalsForSession: spies.closeTerminalsForSession,
        closeAllTerminals: spies.closeAllTerminals, onSessionRuntimeDiscarded: spies.onSessionRuntimeDiscarded });
      return spies;
    }

    function holdCompact(session: ReturnType<typeof runtime>, fail: boolean) {
      const entered = barrier(); const release = barrier();
      session.compact.mockImplementationOnce(async () => {
        entered.resolve(); await release.promise;
        if (fail) throw new Error("synthetic held compact failure");
        return compactionResult("synthetic held compact");
      });
      return { entered, release };
    }

    async function deletionHarness() {
      const { AgentManager } = await import("../core/agent-manager.ts");
      const agent = coord._d.getAgentById("hana");
      agent.dispose = vi.fn(async () => {});
      const keep = { id: "keep", dispose: vi.fn(async () => {}) };
      const phoneAbort = vi.fn();
      const manager = new AgentManager({
        agentsDir: path.join(root, "agents"),
        getSessionCoordinator: () => coord,
        getHub: () => ({ abortAgentPhoneSessions: phoneAbort, scheduler: {
          removeAgentCron: vi.fn(), stopHeartbeat: vi.fn(),
        } }),
        getChannelManager: () => ({ cleanupAgentFromChannels: vi.fn() }),
        getPrefs: () => ({ getPrimaryAgent: () => "keep", getPreferences: () => ({ agentOrder: [] }) }),
      });
      manager._agents.set("hana", agent); manager._agents.set("keep", keep);
      manager.activeAgentId = "keep";
      vi.spyOn(manager, "_rebuildAllAgentSystemPrompts").mockImplementation(() => {});
      return { manager, agent, keep, phoneAbort, tombstone: manager._deletedAgentTombstonePath("hana") };
    }

    async function suspendModelAfterLoad() {
      await bounded(coord.hibernateSessionRuntime(bPath, "model_load_test"));
      coord._currentSessionPath = bPath; coord._session = null;
      const loaded = barrier(); const resume = barrier();
      const load = coord.ensureSessionLoaded.bind(coord);
      const loadSpy = vi.spyOn(coord, "ensureSessionLoaded").mockImplementationOnce(async (file) => {
        // Run the actual coordinator load, then hold only the model caller's
        // continuation after the load queue and construction record are gone.
        const session = await load(file);
        loaded.resolve(); await resume.promise;
        return session;
      });
      const switching = coord.switchSessionModel(bPath, nextModel);
      pending.push(switching); void switching.catch(() => {});
      await bounded(loaded.promise);
      const entry = coord._getSessionEntryByPath(bPath);
      expect(entry.session).not.toBe(oldB);
      expect(coord._sessionRuntimeOperations.size).toBe(0);
      expect(coord._sessionRuntimeCreations.size).toBe(0);
      expect(entry._switching).toBeFalsy();
      const writeMeta = vi.spyOn(coord, "writeSessionMeta");
      const renewCache = vi.spyOn(coord, "_renewCachePrefixContract");
      const emitMetadata = vi.spyOn(coord, "_emitSessionMetadataUpdated");
      const modelState = { modelId: entry.modelId, modelProvider: entry.modelProvider,
        modelAvailability: entry.modelAvailability, thinkingLevel: entry.thinkingLevel };
      return { resume, switching, loadSpy, entry, assertUntouched() {
        expect(entry.session.setModel).not.toHaveBeenCalled();
        expect(entry).toMatchObject(modelState);
        for (const spy of [writeMeta, renewCache, emitMetadata]) {
          expect(spy.mock.calls.filter(([file]) => file === bPath)).toEqual([]);
        }
        expect(entry._switching).toBeFalsy();
      } };
    }

    it.each(["closeAllSessions", "discardSessionsForAgent"] as const)("rejects model continuation after runtime load when %s has started", async (method) => {
      const model = await suspendModelAfterLoad();
      const entered = barrier(); const release = barrier();
      emitSessionShutdownMock.mockImplementationOnce(async (session) => {
        expect(session).toBe(oldA);
        entered.resolve(); await release.promise; return true;
      });
      const closing = method === "closeAllSessions" ? coord.closeAllSessions() : coord.discardSessionsForAgent("hana");
      pending.push(closing);
      await bounded(entered.promise);
      expect(coord._sessionRuntimeClosures.size).toBe(1);
      expect(model.entry._switching).toBeFalsy();
      const focusVersion = coord._focusVersion;
      model.resume.resolve();
      await expect(bounded(model.switching)).rejects.toThrow("session_busy");
      model.assertUntouched();
      expect(coord._session).toBeNull();
      expect(coord.currentSessionPath).toBe(bPath);
      expect(coord._focusVersion).toBe(focusVersion);
      expect(model.entry.session.dispose).not.toHaveBeenCalled();
      release.resolve(); await bounded<unknown>(closing);
      expect(model.entry.session.dispose).toHaveBeenCalledOnce();
      model.loadSpy.mockRestore();
      await bounded(coord.switchSessionModel(bPath, nextModel));
      const restored = coord.getSessionByPath(bPath);
      expect(restored).not.toBe(model.entry.session);
      expect(restored.setModel).toHaveBeenCalledWith(nextModel);
    });

    it("rejects model continuation after runtime load during active-agent deletion and foreground replacement", async () => {
      const { manager, agent, keep, tombstone } = await deletionHarness();
      const keepDir = path.join(root, "agents", "keep");
      const keepPath = path.join(keepDir, "sessions", "keep.jsonl");
      fs.mkdirSync(path.dirname(keepPath), { recursive: true });
      Object.assign(keep, makeAgent(root), { id: "keep", agentDir: keepDir, sessionDir: path.dirname(keepPath) });
      manager.activeAgentId = "hana";
      const hub = { ...manager._d.getHub(), pauseForAgentSwitch: vi.fn(async () => {}), resumeAfterAgentSwitch: vi.fn() };
      manager._d.getHub = () => hub;
      manager._d.getModels = coord._d.getModels;
      manager._d.getSkills = () => ({ syncAgentSkills: vi.fn() });
      vi.spyOn(manager, "ensureAgentRuntime").mockImplementation(async (id) => manager._agents.get(id));
      const switchAgent = vi.spyOn(manager, "switchAgent");
      coord._d.getAgent = () => manager.agent;
      coord._d.getActiveAgentId = () => manager.activeAgentId;
      coord._d.getAgentById = (id) => manager._agents.get(id);
      coord._d.getAgents = () => manager._agents;
      coord._d.agentIdFromSessionPath = (file) => manager.agentIdFromSessionPath(file);
      sessionManagerCreateMock.mockImplementationOnce(() => ({ getSessionFile: () => keepPath, getCwd: () => root }));
      const model = await suspendModelAfterLoad();
      const entered = barrier(); const release = barrier();
      emitSessionShutdownMock.mockImplementationOnce(async (session) => {
        expect(session).toBe(oldA);
        entered.resolve(); await release.promise; return true;
      });
      const deletion = manager.deleteAgent("hana"); pending.push(deletion); void deletion.catch(() => {});
      await bounded(entered.promise);
      expect(switchAgent).toHaveBeenCalledWith("keep");
      expect(manager.activeAgentId).toBe("keep");
      const focused = coord.getSessionByPath(keepPath);
      expect(focused).not.toBeNull();
      expect(coord._session).toBe(focused);
      expect(coord.currentSessionPath).toBe(keepPath);
      expect(coord._sessionRuntimeClosures.size).toBe(1);
      expect(fs.existsSync(tombstone)).toBe(false);
      const focusVersion = coord._focusVersion;
      model.resume.resolve();
      await expect(bounded(model.switching)).rejects.toThrow("session_busy");
      model.assertUntouched();
      expect(coord._session).toBe(focused);
      expect(coord.currentSessionPath).toBe(keepPath);
      expect(coord._focusVersion).toBe(focusVersion);
      expect(model.entry.session.dispose).not.toHaveBeenCalled();
      release.resolve(); await bounded(deletion);
      expect(model.entry.session.dispose).toHaveBeenCalledOnce();
      expect(agent.dispose).toHaveBeenCalledOnce();
      expect(fs.existsSync(tombstone)).toBe(true);
      expect(focused.dispose).not.toHaveBeenCalled();
      expect(coord._session).toBe(focused);
      expect(coord._sessions.size).toBe(1);
      model.loadSpy.mockRestore();
    });

    it.each([false, true])("preflights all A/B/C before batch close and retries after compact settles (fails: %s)", async (fail) => {
      const cPath = path.join(path.dirname(aPath), "c.jsonl");
      const c = runtime(cPath);
      coord._sessions.set(cPath, { session: c, agentId: "hana", unsub: vi.fn() });
      const spies = cleanupSpies();
      const gate = holdCompact(oldB, fail);
      const request = chatHarness().compact("b");
      await bounded(gate.entered.promise);
      await expect(bounded(coord.closeAllSessions())).rejects.toThrow("session_busy");
      for (const session of [oldA, oldB, c]) expect(session.dispose).not.toHaveBeenCalled();
      expect(coord._sessions.size).toBe(3);
      expect(coord._session).toBe(oldA);
      expect(spies.abortBySession).not.toHaveBeenCalled();
      expect(spies.closeAllTerminals).not.toHaveBeenCalled();
      gate.release.resolve();
      expect(await request.result).toMatchObject({ status: fail ? "failed" : "succeeded" });
      if (fail) emitSessionShutdownMock.mockImplementation(async (session) => {
        if (session === oldB) throw new Error("synthetic B shutdown failure");
        return true;
      });
      await bounded(coord.closeAllSessions());
      for (const session of [oldA, oldB, c]) expect(session.dispose).toHaveBeenCalledOnce();
      for (const file of [aPath, bPath, cPath]) expect(spies.abortBySession).toHaveBeenCalledWith(file);
      expect(spies.closeAllTerminals).toHaveBeenCalledOnce();
      expect(spies.clearBySession).not.toHaveBeenCalled();
      expect(coord._sessions.size).toBe(0);
      expect(coord._session).toBeNull();
      expect(coord.currentSessionPath).toBeNull();
    });

    it("rejects engine disposal before agent and manifest teardown, then succeeds on retry", async () => {
      const { HanaEngine } = await import("../core/engine.ts");
      const engine = Object.create(HanaEngine.prototype);
      engine._sessionCoord = coord;
      engine._agentMgr = { disposeAll: vi.fn(async () => {}) };
      engine._sessionManifestStore = { close: vi.fn() };
      engine.disposeComputerRuntime = vi.fn(async () => {});
      const gate = holdCompact(oldB, false);
      const request = chatHarness().compact("b");
      await bounded(gate.entered.promise);
      await expect(bounded(engine.dispose())).rejects.toThrow("session_busy");
      expect(engine._agentMgr.disposeAll).not.toHaveBeenCalled();
      expect(engine._sessionManifestStore.close).not.toHaveBeenCalled();
      expect(engine.disposeComputerRuntime).not.toHaveBeenCalled();
      expect(oldA.dispose).not.toHaveBeenCalled();
      gate.release.resolve(); await request.result;
      await bounded(engine.dispose());
      expect(engine._agentMgr.disposeAll).toHaveBeenCalledOnce();
      expect(engine._sessionManifestStore.close).toHaveBeenCalledOnce();
      expect(coord._sessions.size).toBe(0);
    });

    it.each([
      ["recovery", "closeSession"], ["recovery", "discardSessionRuntime"],
      ["recovery", "closeAllSessions"], ["recovery", "discardSessionsForAgent"],
      ["fresh", "closeSession"], ["fresh", "discardSessionRuntime"],
      ["fresh", "closeAllSessions"], ["fresh", "discardSessionsForAgent"],
    ] as const)("rejects %s/%s before replacement publication without clearing sidecars or focus", async (mode, closeMethod) => {
      const entered = barrier(); const release = barrier();
      const spies = cleanupSpies();
      if (mode === "recovery") oldA.extensionRunner.hasHandlers.mockReturnValue(false);
      createAgentSessionMock.mockImplementationOnce(async ({ sessionManager }) => {
        // The SDK factory has not returned: the replacement cannot yet be in _sessions.
        entered.resolve(); await release.promise;
        return { session: runtime(sessionManager.getSessionFile()) };
      });
      const { HanaEngine } = await import("../core/engine.ts");
      const engine = Object.create(HanaEngine.prototype);
      engine._sessionCoord = coord;
      const request = engine[mode === "fresh" ? "freshCompactDesktopSession" : "compactDesktopSession"](aPath);
      pending.push(request); void request.catch(() => {});
      await bounded(entered.promise);
      expect(coord.getSessionByPath(aPath)).toBeNull();
      const focus = coord._session; const focusVersion = coord._focusVersion;
      const close = closeMethod === "discardSessionsForAgent"
        ? coord.discardSessionsForAgent("hana") : closeMethod === "closeAllSessions"
          ? coord.closeAllSessions() : coord[closeMethod](aPath);
      await expect(bounded<unknown>(close)).rejects.toThrow("session_busy");
      for (const spy of Object.values(spies)) expect(spy).not.toHaveBeenCalled();
      expect(coord._session).toBe(focus);
      expect(coord._focusVersion).toBe(focusVersion);
      expect(oldB.dispose).not.toHaveBeenCalled();
      release.resolve(); await bounded(request);
      expect(coord.getSessionByPath(aPath)?.disposed).toBe(false);
      await bounded(coord.closeAllSessions());
      expect(coord._sessions.size).toBe(0);
    });

    it.each([false, true])("rejects agent deletion with held compact and another session, then retries (compact fails: %s)", async (fail) => {
      const { manager, agent, keep, phoneAbort, tombstone } = await deletionHarness();
      const gate = holdCompact(oldA, fail);
      const request = chatHarness().compact();
      await bounded(gate.entered.promise);
      await expect(bounded(manager.deleteAgent("hana"))).rejects.toThrow("session_busy");
      expect(agent.dispose).not.toHaveBeenCalled();
      expect(phoneAbort).not.toHaveBeenCalled();
      expect(fs.existsSync(tombstone)).toBe(false);
      expect(manager._agents.get("hana")).toBe(agent);
      expect(oldB.dispose).not.toHaveBeenCalled();
      gate.release.resolve(); await request.result;
      await bounded(manager.deleteAgent("hana"));
      expect(agent.dispose).toHaveBeenCalledOnce();
      expect(keep.dispose).not.toHaveBeenCalled();
      expect(fs.existsSync(tombstone)).toBe(true);
      expect(oldA.dispose).toHaveBeenCalledOnce();
      expect(oldB.dispose).toHaveBeenCalledOnce();
      expect(coord._sessions.size).toBe(0);
    });

    it("does not delete or tombstone an agent if runtime cleanup unexpectedly rejects", async () => {
      const { manager, agent, tombstone } = await deletionHarness();
      vi.spyOn(coord, "_teardownSessionEntry").mockRejectedValueOnce(new Error("synthetic cleanup failure"));
      await expect(bounded(manager.deleteAgent("hana"))).rejects.toThrow("synthetic cleanup failure");
      expect(agent.dispose).not.toHaveBeenCalled();
      expect(fs.existsSync(tombstone)).toBe(false);
      expect(manager._agents.get("hana")).toBe(agent);
      await bounded(manager.deleteAgent("hana"));
      expect(agent.dispose).toHaveBeenCalledOnce();
      expect(coord._sessions.size).toBe(0);
    });

    it("blocks new compact, load and model admissions for the entire batch shutdown", async () => {
      const entered = barrier(); const release = barrier();
      emitSessionShutdownMock.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return true; });
      const closing = coord.closeAllSessions(); pending.push(closing);
      await bounded(entered.promise);
      expect(await chatHarness().compact("b").result).toMatchObject({ status: "failed", reason: "session_busy" });
      await expect(bounded(coord.ensureSessionLoaded(bPath))).rejects.toThrow("session_busy");
      await expect(bounded(coord.switchSessionModel(bPath, nextModel))).rejects.toThrow("session_busy");
      expect(oldB.dispose).not.toHaveBeenCalled();
      release.resolve(); await bounded(closing);
      expect(oldA.dispose).toHaveBeenCalledOnce();
      expect(oldB.dispose).toHaveBeenCalledOnce();
      await bounded(coord.ensureSessionLoaded(aPath));
      expect(coord.getSessionByPath(aPath)?.disposed).toBe(false);
    });

    it("allows another path to compact while a single-path close is pending", async () => {
      const entered = barrier(); const release = barrier();
      emitSessionShutdownMock.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return true; });
      const closing = coord.closeSession(aPath); pending.push(closing);
      await bounded(entered.promise);
      const chat = chatHarness();
      expect(await chat.compact().result).toMatchObject({ status: "failed", reason: "session_busy" });
      expect(await chat.compact("b").result).toMatchObject({ status: "succeeded" });
      release.resolve(); await bounded(closing);
      expect(oldA.dispose).toHaveBeenCalledOnce();
      expect(oldB.dispose).not.toHaveBeenCalled();
    });

    it("holds the agent fence after runtime removal until agent disposal and tombstone finish", async () => {
      const { manager, agent, tombstone } = await deletionHarness();
      const entered = barrier(); const release = barrier();
      agent.dispose.mockImplementationOnce(async () => { entered.resolve(); await release.promise; });
      coord._d.agentIdFromSessionPath = (file) => path.relative(path.join(root, "agents"), file).split(path.sep)[0];
      const keepPath = path.join(root, "agents", "keep", "sessions", "keep.jsonl");
      const keepRuntime = runtime(keepPath);
      coord._sessions.set(keepPath, { session: keepRuntime, agentId: "keep", unsub: vi.fn() });
      const deletion = manager.deleteAgent("hana"); pending.push(deletion);
      await bounded(entered.promise);
      expect(coord.getSessionByPath(aPath)).toBeNull();
      expect(fs.existsSync(tombstone)).toBe(false);
      await expect(bounded(coord.ensureSessionLoaded(aPath))).rejects.toThrow("session_busy");
      const focusVersion = coord._focusVersion;
      await expect(bounded(coord.createSession(null, root, true, MODEL, { agent }))).rejects.toThrow("session_busy");
      expect(coord._focusVersion).toBe(focusVersion);
      const { HanaEngine } = await import("../core/engine.ts");
      const engine = Object.create(HanaEngine.prototype); engine._sessionCoord = coord;
      await bounded(engine.compactDesktopSession(keepPath));
      expect(keepRuntime.compact).toHaveBeenCalledOnce();
      release.resolve(); await bounded(deletion);
      expect(fs.existsSync(tombstone)).toBe(true);
      expect(keepRuntime.dispose).not.toHaveBeenCalled();
      expect(coord._sessions.size).toBe(1);
    });

    it.each(["recovery", "fresh"])("rejects deletion before %s publication and releases ownership when creation fails", async (mode) => {
      const { manager, agent, tombstone } = await deletionHarness();
      const entered = barrier(); const release = barrier();
      if (mode === "recovery") oldA.extensionRunner.hasHandlers.mockReturnValue(false);
      createAgentSessionMock.mockImplementationOnce(async () => {
        entered.resolve(); await release.promise;
        throw new Error("synthetic pre-publication creation failure");
      });
      const { HanaEngine } = await import("../core/engine.ts");
      const engine = Object.create(HanaEngine.prototype); engine._sessionCoord = coord;
      const compact = engine[mode === "fresh" ? "freshCompactDesktopSession" : "compactDesktopSession"](aPath);
      pending.push(compact); void compact.catch(() => {});
      await bounded(entered.promise);
      expect(coord.getSessionByPath(aPath)).toBeNull();
      await expect(bounded(manager.deleteAgent("hana"))).rejects.toThrow("session_busy");
      expect(agent.dispose).not.toHaveBeenCalled();
      expect(oldB.dispose).not.toHaveBeenCalled();
      expect(fs.existsSync(tombstone)).toBe(false);
      release.resolve();
      await expect(bounded(compact)).rejects.toThrow("synthetic pre-publication creation failure");
      await bounded(manager.deleteAgent("hana"));
      expect(oldB.dispose).toHaveBeenCalledOnce();
      expect(agent.dispose).toHaveBeenCalledOnce();
      expect(fs.existsSync(tombstone)).toBe(true);
      expect(coord._sessions.size).toBe(0);
    });

    it("preflights unpublished creation that has no existing path queue", async () => {
      const entered = barrier(); const release = barrier();
      const cPath = path.join(path.dirname(aPath), "new.jsonl");
      // Hold the construction boundary, while exercising actual create admission.
      vi.spyOn(coord, "_createSessionRuntime").mockImplementationOnce(async () => {
        entered.resolve(); await release.promise;
        // This admission test only needs the synthetic runtime's public surface.
        type CreatedRuntime = Awaited<ReturnType<SessionCoordinator["_createSessionRuntime"]>>;
        const session = runtime(cPath) as unknown as CreatedRuntime["session"];
        return { session, sessionPath: cPath, sessionId: null, agentId: "hana" };
      });
      const creating = coord.createSession(null, root, true, MODEL, { focus: false }); pending.push(creating);
      await bounded(entered.promise);
      expect(coord._sessionRuntimeOperations.size).toBe(0);
      await expect(bounded(coord.closeAllSessions())).rejects.toThrow("session_busy");
      await expect(bounded(coord.discardSessionsForAgent("hana"))).rejects.toThrow("session_busy");
      expect(oldA.dispose).not.toHaveBeenCalled();
      release.resolve(); await bounded(creating);
      await bounded(coord.closeAllSessions());
      expect(coord._sessions.size).toBe(0);
    });
  });

  it.each([false, true])("compaction runtime recovery settles without recursive queue waits (load fails: %s)", async (failLoad) => {
    const chat = chatHarness();
    oldA.extensionRunner.hasHandlers.mockReturnValue(false);
    if (failLoad) createAgentSessionMock.mockRejectedValueOnce(new Error("synthetic runtime load failure"));
    const first = await chat.compact().result;
    if (failLoad) {
      expect(first).toMatchObject({ status: "failed", reason: "compaction_failed" });
      expect(coord._sessionRuntimeOperations.size).toBe(0);
      expect(await chat.compact().result).toMatchObject({ status: "succeeded" });
    } else {
      expect(first).toMatchObject({ status: "succeeded" });
    }
    const restored = coord.getSessionByPath(aPath);
    expect(restored).not.toBe(oldA);
    expect(restored.disposed).toBe(false);
    expect(restored.compact).toHaveBeenCalledOnce();
    expect(oldA.compact).not.toHaveBeenCalled();
    expect(oldA.dispose).toHaveBeenCalledOnce();
    expect(coord._sessionRuntimeOperations.size).toBe(0);
  });
});

function makeSession<Overrides extends object>(sessionPath: string, overrides: Overrides = {} as Overrides) {
  return {
    sessionManager: {
      getSessionFile: () => sessionPath,
      getCwd: () => path.dirname(sessionPath),
    },
    model: MODEL,
    isStreaming: false,
    isCompacting: false,
    messages: [],
    prompt: vi.fn<(text: string) => Promise<void>>(async () => {}),
    subscribe: vi.fn(() => vi.fn()),
    setActiveToolsByName: vi.fn(),
    dispose: vi.fn(),
    ...overrides,
  };
}

function makeAgent(root = "/tmp/hana-runtime-hibernation") {
  return {
    id: "hana",
    agentDir: path.join(root, "agents", "hana"),
    sessionDir: path.join(root, "agents", "hana", "sessions"),
    memoryMasterEnabled: true,
    sessionMemoryEnabled: true,
    setMemoryEnabled: vi.fn(),
    buildSystemPrompt: () => "BASE",
    getToolsSnapshot: vi.fn(() => []),
    config: {},
  };
}

function makeCoordinator( overrides: any = {}) {
  const root = overrides.root || "/tmp/hana-runtime-hibernation";
  const agent = overrides.agent || makeAgent(root);
  const models = overrides.models || {
    currentModel: MODEL,
    availableModels: [MODEL],
    authStorage: {},
    modelRegistry: {},
    resolveThinkingLevel: () => "medium",
  };
  return new SessionCoordinator({
    agentsDir: path.join(root, "agents"),
    getAgent: () => agent,
    getActiveAgentId: () => agent.id,
    getModels: () => models,
    getResourceLoader: () => ({
      getSystemPrompt: () => "BASE",
      getAppendSystemPrompt: () => [],
      getExtensions: () => ({ extensions: [], errors: [] }),
      getSkills: () => ({ skills: [], diagnostics: [] }),
      getAgentsFiles: () => ({ agentsFiles: [] }),
    }),
    getSkills: () => null,
    buildTools: vi.fn(() => ({ tools: [], customTools: [] })),
    emitEvent: vi.fn(),
    getHomeCwd: () => root,
    agentIdFromSessionPath: () => agent.id,
    switchAgentOnly: vi.fn(async () => {}),
    getConfig: () => ({}),
    getPrefs: () => ({ getThinkingLevel: () => "medium" }),
    getAgents: () => new Map([[agent.id, agent]]),
    getActivityStore: () => null,
    getAgentById: () => agent,
    listAgents: () => [agent],
    getDeferredResultStore: () => null,
    memoryPressure: overrides.memoryPressure,
    getEngine: overrides.getEngine,
  });
}

describe("SessionCoordinator runtime hibernation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    refreshSessionModelFromRegistryMock.mockImplementation((session, allowedModel) => {
      if (allowedModel !== undefined) {
        if (session?.agent?.state) session.agent.state.model = allowedModel;
        if (session && Object.prototype.hasOwnProperty.call(session, "model")) session.model = allowedModel;
      } else {
        session?._refreshCurrentModelFromRegistry?.();
      }
      return true;
    });
    emitSessionShutdownMock.mockResolvedValue(false);
    sessionManagerCreateMock.mockReturnValue({ getCwd: () => "/tmp/workspace", getSessionFile: () => "/tmp/session.jsonl" });
  });

  it("releases a focused runtime while preserving the current session path", async () => {
    const sessionPath = "/tmp/hana-runtime-hibernation/agents/hana/sessions/current.jsonl";
    const session = makeSession(sessionPath, {
      getContextUsage: vi.fn(() => ({ tokens: 123, contextWindow: 1000, percent: 12.3 })),
    });
    const unsub = vi.fn();
    const coordinator = makeCoordinator();
    coordinator._session = session;
    coordinator._sessionStarted = true;
    coordinator._sessions.set(sessionPath, {
      session,
      unsub,
      agentId: "hana",
      modelId: "test-model",
      modelProvider: "test",
      workspaceFolders: ["/tmp/workspace", "/tmp/other"],
      permissionMode: "operate",
      accessMode: "operate",
      planMode: false,
      thinkingLevel: "high",
      lastTouchedAt: Date.now() - 60_000,
    });

    await expect(
      coordinator.hibernateSessionRuntime(sessionPath, "test"),
    ).resolves.toBe(true);

    expect(coordinator.getSessionByPath(sessionPath)).toBeNull();
    expect(coordinator.session).toBeNull();
    expect(coordinator.currentSessionPath).toBe(sessionPath);
    expect(coordinator.sessionStarted).toBe(true);
    expect(coordinator.getCurrentSessionModelRef()).toEqual({ id: "test-model", provider: "test" });
    expect(coordinator.getSessionWorkspaceFolders(sessionPath)).toEqual(["/tmp/workspace", "/tmp/other"]);
    expect(coordinator.getPermissionMode(sessionPath)).toBe("operate");
    expect(coordinator.getSessionThinkingLevel(sessionPath)).toBe("high");
    expect(coordinator.getSessionContextUsage(sessionPath)).toEqual({ tokens: 123, contextWindow: 1000, percent: 12.3 });
    expect(unsub).toHaveBeenCalledOnce();
    expect(session.dispose).toHaveBeenCalledOnce();
  });

  it("restores a hibernated focused runtime before prompting", async () => {
    const sessionPath = "/tmp/hana-runtime-hibernation/agents/hana/sessions/current.jsonl";
    const manager = { getCwd: () => "/tmp/workspace", getSessionFile: () => sessionPath };
    const restored = makeSession(sessionPath, { sessionManager: manager });
    sessionManagerOpenMock.mockReturnValue(manager);
    createAgentSessionMock.mockResolvedValue({ session: restored });

    const coordinator = makeCoordinator();
    coordinator._currentSessionPath = sessionPath;
    coordinator._sessionStarted = true;

    await (coordinator as any).promptSession(sessionPath, "hello");

    expect(sessionManagerOpenMock).toHaveBeenCalledWith(sessionPath, expect.stringContaining("sessions"));
    expect(restored.prompt).toHaveBeenCalledWith("hello", { preflightResult: expect.any(Function) });
    expect(coordinator.session).toBe(restored);
    expect(coordinator.currentSessionPath).toBe(sessionPath);
  });

  it("rejects the next live-session prompt before vision or Pi when its model was disabled", async () => {
    const sessionPath = "/tmp/hana-runtime-hibernation/agents/hana/sessions/gpt56.jsonl";
    const staleModel = {
      id: "gpt-5.6-sol",
      provider: "openai-codex",
      input: ["text"],
      contextWindow: 353400,
    };
    const models = {
      currentModel: staleModel,
      availableModels: [staleModel],
      authStorage: {},
      modelRegistry: {},
      resolveThinkingLevel: () => "low",
    };
    const visionPrepare = vi.fn(async () => ({ text: "vision output", images: [] }));
    const session = makeSession(sessionPath, { model: staleModel });
    const coordinator = makeCoordinator({
      models,
      getEngine: () => ({
        isVisionAuxiliaryEnabled: () => true,
        getVisionBridge: () => ({ prepare: visionPrepare }),
      }),
    });
    coordinator._sessions.set(sessionPath, {
      session,
      agentId: "hana",
      modelId: staleModel.id,
      modelProvider: staleModel.provider,
      lastTouchedAt: 0,
    });

    models.availableModels = [];
    coordinator.refreshAllSessionsModels();

    const result = coordinator.promptSession(sessionPath, "describe image", {
      images: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
    });
    await expect(result).rejects.toMatchObject({
      code: "MODEL_NOT_AVAILABLE",
      modelRef: "openai-codex/gpt-5.6-sol",
    });
    expect(visionPrepare).not.toHaveBeenCalled();
    expect(session.prompt).not.toHaveBeenCalled();
    expect(refreshSessionModelFromRegistryMock).not.toHaveBeenCalled();
  });

  it("rebinds a live session to current Hana metadata and continues prompting", async () => {
    const sessionPath = "/tmp/hana-runtime-hibernation/agents/hana/sessions/gpt56-metadata.jsonl";
    const staleModel = {
      id: "gpt-5.6-sol",
      provider: "openai-codex",
      api: "openai-codex-responses",
      baseUrl: "https://stale.example",
      contextWindow: 272000,
      thinkingLevels: ["low", "medium", "high"],
    };
    const freshModel = {
      ...staleModel,
      baseUrl: "https://chatgpt.com/backend-api",
      contextWindow: 353400,
      maxTokens: 128000,
      thinkingLevels: ["low", "medium", "high", "max"],
      thinkingLevelMap: { xhigh: "max" },
    };
    const models = {
      currentModel: freshModel,
      availableModels: [freshModel],
      authStorage: {},
      modelRegistry: {},
      resolveThinkingLevel: (level) => level,
    };
    const session = makeSession(sessionPath, {
      model: staleModel,
      agent: { state: { model: staleModel, systemPrompt: "BASE", tools: [] } },
    });
    const coordinator = makeCoordinator({ models });
    coordinator._sessions.set(sessionPath, {
      session,
      agentId: "hana",
      modelId: staleModel.id,
      modelProvider: staleModel.provider,
      lastTouchedAt: 0,
    });

    coordinator.refreshAllSessionsModels();

    expect(refreshSessionModelFromRegistryMock).toHaveBeenCalledWith(session, freshModel);
    expect(session.model).toBe(freshModel);
    expect(session.model).toMatchObject({
      baseUrl: "https://chatgpt.com/backend-api",
      contextWindow: 353400,
      maxTokens: 128000,
      thinkingLevels: ["low", "medium", "high", "max"],
      thinkingLevelMap: { xhigh: "max" },
    });
    await expect(coordinator.promptSession(sessionPath, "hello", undefined)).resolves.toBeUndefined();
    expect(session.prompt).toHaveBeenCalledWith("hello", { preflightResult: expect.any(Function) });
  });

  it("hibernates only heavy idle runtimes under memory pressure", async () => {
    const sessionPath = "/tmp/hana-runtime-hibernation/agents/hana/sessions/heavy.jsonl";
    const session = makeSession(sessionPath, {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "analyze this" },
            { type: "image", data: "a".repeat(4096), mimeType: "image/png" },
          ],
        },
      ],
    });
    const coordinator = makeCoordinator({
      memoryPressure: {
        getMemoryUsage: () => ({
          rss: 2 * 1024 * 1024 * 1024,
          heapUsed: 128 * 1024 * 1024,
          external: 64 * 1024 * 1024,
          arrayBuffers: 64 * 1024 * 1024,
        }),
        thresholds: {
          minRetainedBytes: 1024,
          highRssBytes: 1024,
          highPayloadBytes: 4096,
        },
      },
    });
    coordinator._currentSessionPath = sessionPath;
    coordinator._session = session;
    coordinator._sessions.set(sessionPath, {
      session,
      unsub: vi.fn(),
      agentId: "hana",
      lastTouchedAt: Date.now() - 60_000,
    });

    await expect(
      coordinator.checkRuntimeMemoryPressure(sessionPath, "test"),
    ).resolves.toMatchObject({ hibernated: true });

    expect(coordinator.getSessionByPath(sessionPath)).toBeNull();
    expect(coordinator.currentSessionPath).toBe(sessionPath);
  });
});

// Exercise the imported coordinator and its runtime construction/operation queue.
// Only SDK session creation and shutdown are mocked; no lifecycle method is copied.
describe.sequential("runtime hibernation concurrency", () => {
  let root: string;
  let coord: SessionCoordinator;
  let a: PiSessionManager;
  let b: PiSessionManager;
  let oldA: ReturnType<typeof sessionFor>;
  let oldB: ReturnType<typeof sessionFor>;
  let phases: unknown[];
  let gates: Array<ReturnType<typeof barrier>>;
  let fixtures: Map<string, Buffer>;
  let allowedAppends: Set<string>;

  function barrier() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
  }

  function state(phase: string) {
    const snapshot = {
      phase,
      focus: coord?.session?.testName ?? null,
      path: coord?.currentSessionPath ?? null,
      version: coord?._focusVersion,
      entries: [...(coord?.sessions ?? [])].map(([key, entry]) => [key, entry.session.testName]),
      queues: [...(coord?._sessionRuntimeOperations.keys() ?? [])],
      shutdowns: emitSessionShutdownMock.mock.calls.map(([session]) => session.testName),
    };
    phases.push(snapshot);
    console.log(JSON.stringify({ time: new Date().toISOString(), ...snapshot }));
  }

  async function bounded<T>(name: string, promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            state(`timeout:${name}`);
            reject(new Error(`Timed out waiting for ${name}: ${JSON.stringify(phases)}`));
          }, 3000);
        }),
      ]);
    } finally { clearTimeout(timer!); }
  }

  function operation<T>(name: string, promise: Promise<T>): Promise<T> {
    state(`submitted:${name}`);
    void promise.then(() => state(`completed:${name}`), () => state(`rejected:${name}`));
    return promise;
  }

  function delayedShutdown() {
    const entered = barrier();
    const release = barrier();
    gates.push(release);
    emitSessionShutdownMock.mockImplementation(async (session) => {
      state(`shutdown:${session.testName}`);
      // A second independently submitted shutdown can finish while the first waits.
      if (session === oldA && emitSessionShutdownMock.mock.calls.filter(([s]) => s === oldA).length === 1) {
        entered.resolve();
        await release.promise;
      }
      return true;
    });
    return { entered, release };
  }

  function sessionFor(manager: PiSessionManager, name: string) {
    const session = makeSession(manager.getSessionFile(), { sessionManager: manager, testName: name, disposed: false });
    session.dispose.mockImplementation(() => { session.disposed = true; });
    session.prompt.mockImplementation(async (text: string) => {
      if (session.disposed) throw new Error(`prompt on disposed ${name}`);
      manager.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
      manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "synthetic reply" }],
        api: "test", provider: "test", model: MODEL.id, stopReason: "stop", timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    });
    return session;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    phases = []; gates = []; fixtures = new Map(); allowedAppends = new Set();
    root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-hibernate-race-"));
    const sdk = await vi.importActual<typeof import("@earendil-works/pi-coding-agent")>("@earendil-works/pi-coding-agent");
    const agent = makeAgent(root);
    fs.mkdirSync(agent.sessionDir, { recursive: true });
    const manager = (name: string) => {
      const file = path.join(agent.sessionDir, `${name}.jsonl`);
      const records = [
        { type: "session", version: 3, id: `synthetic-${name}`, timestamp: "2026-10-08T00:00:00.000Z", cwd: root },
        { type: "message", id: `${name}-user`, parentId: null, timestamp: "2026-10-08T00:00:01.000Z",
          message: { role: "user", content: [{ type: "text", text: `synthetic history ${name}` }], timestamp: 1 } },
        { type: "message", id: `${name}-reply`, parentId: `${name}-user`, timestamp: "2026-10-08T00:00:02.000Z",
          message: { role: "assistant", content: [{ type: "text", text: "synthetic reply" }], api: "test",
            provider: "test", model: MODEL.id, stopReason: "stop", timestamp: 2,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } },
      ];
      fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
      fixtures.set(file, fs.readFileSync(file));
      return sdk.SessionManager.open(file, agent.sessionDir);
    };
    a = manager("a"); b = manager("b");
    oldA = sessionFor(a, "old-a"); oldB = sessionFor(b, "old-b");
    coord = makeCoordinator({ root, agent });
    coord._sessions.set(a.getSessionFile(), { session: oldA, unsub: vi.fn(), agentId: agent.id,
      memoryEnabled: true, modelId: MODEL.id, modelProvider: MODEL.provider });
    coord._sessions.set(b.getSessionFile(), { session: oldB, unsub: vi.fn(), agentId: agent.id,
      modelId: MODEL.id, modelProvider: MODEL.provider });
    coord._session = oldA; coord._currentSessionPath = a.getSessionFile();
    coord._sessionStarted = true;
    sessionManagerOpenMock.mockImplementation((file, dir) => sdk.SessionManager.open(file, dir));
    createAgentSessionMock.mockImplementation(async (options) => ({
      session: sessionFor(options.sessionManager, `new-${path.basename(options.sessionManager.getSessionFile())}`),
    }));
    emitSessionShutdownMock.mockResolvedValue(true);
    refreshSessionModelFromRegistryMock.mockReturnValue(true);
    state("fixture-ready");
  });

  afterEach(() => {
    for (const gate of gates) gate.resolve();
    state("test-end");
    // Pure lifecycle operations may update metadata, but never rewrite these valid transcripts.
    const evidenceDir = process.env.HANA_HIBERNATION_EVIDENCE_DIR;
    if (evidenceDir) {
      fs.mkdirSync(evidenceDir, { recursive: true });
      fs.cpSync(root, path.join(evidenceDir, path.basename(root)), { recursive: true });
    }
    try {
      for (const [file, original] of fixtures) {
        if (!allowedAppends.has(file)) expect(fs.readFileSync(file)).toEqual(original);
        else {
          const before = original.toString("utf8").trim().split("\n").map((line) => JSON.parse(line));
          const after = fs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
          expect(after.slice(0, before.length)).toEqual(before);
          expect(after.slice(before.length).map((r) => r.message?.role)).toEqual(["user", "assistant"]);
          expect(after[before.length].message.content[0].text).toBe("synthetic next turn");
        }
      }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("preserves an established B focus when A shutdown returns", async () => {
    const gate = delayedShutdown();
    const sleeping = operation("hibernate-a", coord.hibernateSessionRuntime(a.getSessionFile(), "test"));
    await bounded("shutdown entry", gate.entered.promise);
    await bounded("switch-b", operation("switch-b", coord.switchSession(b.getSessionFile())));
    const version = coord._focusVersion;
    expect(coord.session).toBe(oldB);
    gate.release.resolve();
    await bounded("hibernate-a", sleeping);
    expect(coord.session).toBe(oldB);
    expect(coord.currentSessionPath).toBe(b.getSessionFile());
    expect(coord._focusVersion).toBe(version);
  });

  it("allows B loading to finish and focus after A shutdown (an interim null focus is valid)", async () => {
    coord._sessions.delete(b.getSessionFile());
    const loading = barrier(); const loaded = barrier(); gates.push(loaded);
    createAgentSessionMock.mockImplementation(async (options) => {
      if (options.sessionManager.getSessionFile() === b.getSessionFile()) {
        state("b-load-entered"); loading.resolve(); await loaded.promise;
      }
      return { session: sessionFor(options.sessionManager, "new-b") };
    });
    const gate = delayedShutdown();
    const sleeping = operation("hibernate-a", coord.hibernateSessionRuntime(a.getSessionFile(), "test"));
    await bounded("shutdown entry", gate.entered.promise);
    const switching = operation("switch-b", coord.switchSession(b.getSessionFile()));
    await bounded("b-load-entered", loading.promise);
    const requestedVersion = coord._focusVersion;
    gate.release.resolve();
    await bounded("hibernate-a", sleeping);
    state("a-closed-b-loading");
    // Check after B completes, rather than interpreting a transient empty focus as corruption.
    loaded.resolve();
    const newB = await bounded("switch-b", switching);
    expect(coord.session).toBe(newB);
    expect(coord.currentSessionPath).toBe(b.getSessionFile());
    expect(coord._focusVersion).toBe(requestedVersion);
  });

  it("does not remove a same-path runtime created through reloadSessionRuntime", async () => {
    const gate = delayedShutdown();
    const sleeping = operation("hibernate-a", coord.hibernateSessionRuntime(a.getSessionFile(), "test"));
    await bounded("shutdown entry", gate.entered.promise);
    const ownsQueue = coord._sessionRuntimeOperations.has(coord._runtimeOperationKey(a.getSessionFile()));
    const reloading = operation("reload-a", coord.reloadSessionRuntime(a.getSessionFile()));
    // Before the fix reload can complete while hibernation waits. After the fix it queues:
    // release shutdown FIRST, never wait for a queued reload while owning its barrier.
    if (!ownsQueue) await bounded("unserialized reload-a", reloading);
    gate.release.resolve();
    const [, restored] = await bounded("hibernate and reload", Promise.all([sleeping, reloading]));
    expect(restored).not.toBe(oldA);
    expect(coord.getSessionByPath(a.getSessionFile())).toBe(restored);
    expect(coord.session).toBe(restored);
    expect(restored.disposed).toBe(false);
    expect(oldA.dispose).toHaveBeenCalledOnce();
    expect(coord._sessionRuntimeOperations.size).toBe(0);
  });

  it("shuts down a runtime only once for duplicate hibernation requests", async () => {
    const gate = delayedShutdown();
    const first = operation("hibernate-a-1", coord.hibernateSessionRuntime(a.getSessionFile(), "test"));
    await bounded("shutdown entry", gate.entered.promise);
    const second = operation("hibernate-a-2", coord.hibernateSessionRuntime(a.getSessionFile(), "test"));
    gate.release.resolve();
    const results = await bounded("duplicate hibernation", Promise.all([first, second]));
    expect(results).toEqual([true, false]);
    expect(emitSessionShutdownMock).toHaveBeenCalledOnce();
    expect(oldA.dispose).toHaveBeenCalledOnce();
  });

  it("attach during hibernation returns a fresh live runtime, never the closing one", async () => {
    const gate = delayedShutdown();
    const sleeping = operation("hibernate-a", coord.hibernateSessionRuntime(a.getSessionFile(), "test"));
    await bounded("shutdown entry", gate.entered.promise);
    const attaching = operation("attach-a", coord.ensureSessionLoaded(a.getSessionFile()));
    gate.release.resolve();
    const [, restored] = await bounded("hibernate and attach", Promise.all([sleeping, attaching]));
    expect(restored).not.toBe(oldA);
    expect(restored.disposed).toBe(false);
    expect(coord.getSessionByPath(a.getSessionFile())).toBe(restored);
    expect(coord._sessionRuntimeOperations.size).toBe(0);
  });

  it("sending during hibernation waits for restore and appends only the accepted turn", async () => {
    const gate = delayedShutdown();
    const sleeping = operation("hibernate-a", coord.hibernateSessionRuntime(a.getSessionFile(), "test"));
    await bounded("shutdown entry", gate.entered.promise);
    allowedAppends.add(a.getSessionFile());
    const sending = operation("prompt-a", coord.promptSession(a.getSessionFile(), "synthetic next turn", undefined));
    gate.release.resolve();
    await bounded("hibernate and prompt", Promise.all([sleeping, sending]));
    const restored = coord.getSessionByPath(a.getSessionFile());
    expect(restored).not.toBe(oldA);
    expect(oldA.prompt).not.toHaveBeenCalled();
    expect(restored.prompt).toHaveBeenCalledOnce();
    const before = fixtures.get(a.getSessionFile())!.toString("utf8").trim().split("\n").map((line) => JSON.parse(line));
    const after = fs.readFileSync(a.getSessionFile(), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.slice(before.length).map((r) => r.message?.role)).toEqual(["user", "assistant"]);
    expect(after[before.length].message.content[0].text).toBe("synthetic next turn");
    // afterEach independently validates this allowed append, including on assertion failure.
    expect(coord._sessionRuntimeOperations.size).toBe(0);
  });

  it("shutdown rejection is warned, disposal completes, and a queued reload still finishes", async () => {
    const gate = delayedShutdown();
    emitSessionShutdownMock.mockImplementationOnce(async () => {
      gate.entered.resolve(); await gate.release.promise; throw new Error("synthetic shutdown failure");
    });
    const sleeping = operation("hibernate-a", coord.hibernateSessionRuntime(a.getSessionFile(), "test"));
    await bounded("shutdown entry", gate.entered.promise);
    const reloading = operation("reload-a", coord.reloadSessionRuntime(a.getSessionFile()));
    gate.release.resolve();
    const [hibernated, restored] = await bounded("shutdown failure and reload", Promise.all([sleeping, reloading]));
    expect(hibernated).toBe(true); // Existing teardown contract catches shutdown errors and continues.
    expect(runtimeWarnMock).toHaveBeenCalledWith(expect.stringContaining("emitSessionShutdown failed: synthetic shutdown failure"));
    expect(oldA.dispose).toHaveBeenCalledOnce();
    expect(coord.getSessionByPath(a.getSessionFile())).toBe(restored);
    expect(coord.session).toBe(restored);
    expect(coord._sessionRuntimeOperations.size).toBe(0);
  });

  it("a queued hibernation cannot unload a replacement produced by an earlier reload", async () => {
    const entered = barrier(); const release = barrier(); gates.push(release);
    coord._d.ensureAgentRuntime = async () => {
      entered.resolve(); await release.promise;
      return { ...coord._d.getAgent(), runtimeInitialized: true };
    };
    const reloading = operation("reload-a", coord.reloadSessionRuntime(a.getSessionFile()));
    await bounded("reload readiness", entered.promise);
    const sleeping = operation("queued-hibernate-a", coord.hibernateSessionRuntime(a.getSessionFile(), "test"));
    release.resolve();
    const [restored, hibernated] = await bounded("reload then hibernate", Promise.all([reloading, sleeping]));
    expect(hibernated).toBe(false);
    expect(coord.getSessionByPath(a.getSessionFile())).toBe(restored);
    expect(coord.session).toBe(restored);
    expect(restored.disposed).toBe(false);
    expect(emitSessionShutdownMock).toHaveBeenCalledOnce();
    expect(coord._sessionRuntimeOperations.size).toBe(0);
  });

  it("rechecks busy state after a failed queued reload without poisoning the queue", async () => {
    const entered = barrier(); const release = barrier(); gates.push(release);
    coord._d.ensureAgentRuntime = async () => {
      entered.resolve(); await release.promise;
      return { ...coord._d.getAgent(), runtimeInitialized: true };
    };
    const reloading = operation("reload-a", coord.reloadSessionRuntime(a.getSessionFile()));
    await bounded("reload readiness", entered.promise);
    const sleeping = operation("queued-hibernate-a", coord.hibernateSessionRuntime(a.getSessionFile(), "test"));
    oldA.isStreaming = true;
    release.resolve();
    await expect(bounded("busy reload", reloading)).rejects.toThrow("session is busy");
    await expect(bounded("busy hibernation", sleeping)).resolves.toBe(false);
    expect(oldA.dispose).not.toHaveBeenCalled();
    expect(coord.getSessionByPath(a.getSessionFile())).toBe(oldA);
    await expect(bounded("attach after queue rejection", coord.ensureSessionLoaded(a.getSessionFile()))).resolves.toBe(oldA);
    expect(coord._sessionRuntimeOperations.size).toBe(0);
  });

  it("isolated REST switch smoke preserves B after A closes and returns session state", async () => {
    const { Hono } = await import("hono");
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const { BrowserManager } = await import("../lib/browser/browser-manager.ts");
    // Browser host is absent in this in-process smoke; it must never open a real browser.
    const browser = { isRunning: () => false, currentUrl: () => null,
      notifyViewerSession: vi.fn(async () => {}),
      resumeForSessionIfAvailable: async () => ({ status: "skipped", canResume: false,
        reason: "no_browser_state", running: false, url: null }) };
    const browserSpy = vi.spyOn(BrowserManager, "instance").mockReturnValue(browser as ReturnType<typeof BrowserManager.instance>);
    const engine = {
      agentsDir: path.join(root, "agents"), hanakoHome: root,
      switchSession: coord.switchSession.bind(coord),
      getSessionByPath: coord.getSessionByPath.bind(coord),
      resolveSessionOwnership: coord.resolveSessionOwnership.bind(coord),
      getAgent: () => coord._d.getAgent(),
      getSessionMemoryEnabled: coord.getSessionMemoryEnabled.bind(coord),
      isSessionStreaming: coord.isSessionStreaming.bind(coord),
      currentModel: MODEL, cwd: root,
    };
    const app = new Hono(); app.route("/api", createSessionsRoute(engine));
    const gate = delayedShutdown();
    const sleeping = operation("hibernate-a", coord.hibernateSessionRuntime(a.getSessionFile(), "test"));
    try {
      await bounded("shutdown entry", gate.entered.promise);
      const response = await bounded("REST switch", Promise.resolve(app.request("/api/sessions/switch", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: b.getSessionFile(), currentSessionPath: a.getSessionFile() }),
      })));
      const body = await response.json();
      console.log(JSON.stringify({ phase: "REST-response", status: response.status, body }));
      expect(response.status).toBe(200);
      expect(body).toMatchObject({ ok: true, agentId: "hana", currentModelId: MODEL.id, isStreaming: false });
      gate.release.resolve(); await bounded("hibernate after REST switch", sleeping);
      expect(coord.session).toBe(oldB);
      expect(coord.currentSessionPath).toBe(b.getSessionFile());
    } finally { gate.release.resolve(); browserSpy.mockRestore(); }
  });
});
