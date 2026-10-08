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

const MODEL = {
  id: "test-model",
  name: "test-model",
  provider: "test",
  input: ["text", "image"],
};

function makeSession(sessionPath, overrides: any = {}) {
  const sessionManager = overrides.sessionManager || {
    getSessionFile: () => sessionPath,
    getCwd: () => path.dirname(sessionPath),
  };
  return {
    sessionManager,
    model: MODEL,
    isStreaming: false,
    isCompacting: false,
    messages: [],
    prompt: vi.fn(async () => {}),
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
  let a: any;
  let b: any;
  let oldA: any;
  let oldB: any;
  let phases: any[];
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

  function sessionFor(manager: any, name: string) {
    const session = makeSession(manager.getSessionFile(), { sessionManager: manager, testName: name });
    session.disposed = false;
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
    const sdk = await vi.importActual<any>("@earendil-works/pi-coding-agent");
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
    const browserSpy = vi.spyOn(BrowserManager, "instance").mockReturnValue(browser as any);
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
