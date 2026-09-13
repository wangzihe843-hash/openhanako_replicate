import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  createAgentSessionMock,
  repairInlineMediaMock,
  sessionManagerOpenMock,
} = vi.hoisted(() => ({
  createAgentSessionMock: vi.fn(),
  repairInlineMediaMock: vi.fn(),
  sessionManagerOpenMock: vi.fn(),
}));

vi.mock("../lib/pi-sdk/index.js", () => ({
  createAgentSession: createAgentSessionMock,
  SessionManager: {
    create: vi.fn(),
    open: sessionManagerOpenMock,
  },
  SettingsManager: { inMemory: vi.fn(() => ({})) },
  estimateTokens: vi.fn(() => 0),
  findCutPoint: vi.fn(),
  generateSummary: vi.fn(),
  emitSessionShutdown: vi.fn(),
  refreshSessionModelFromRegistry: vi.fn(),
}));

vi.mock("../lib/debug-log.js", () => ({
  createModuleLogger: () => ({
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock("../core/session-inline-media-prune.js", async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    repairSessionInlineMediaEntriesInFile: (...args: any[]) => repairInlineMediaMock(...args),
  };
});

import { SessionCoordinator } from "../core/session-coordinator.ts";

function makeTool(name) {
  return { name, execute: vi.fn() };
}

function makeAgent({ id, sessionDir }) {
  return {
    id,
    agentDir: path.dirname(sessionDir),
    sessionDir,
    tools: [makeTool(`${id}-tool`)],
    config: { locale: "en", tools: {} },
    memoryMasterEnabled: true,
    get memoryEnabled() { return true; },
    get sessionMemoryEnabled() { return true; },
    setMemoryEnabled: vi.fn(),
    getToolsSnapshot: vi.fn(() => [makeTool(`${id}-tool`)]),
    buildSystemPrompt: vi.fn(() => `${id.toUpperCase()} PROMPT`),
  };
}

function makeRestoredSession(sessionPath) {
  return {
    sessionManager: { getSessionFile: () => sessionPath },
    subscribe: vi.fn(() => vi.fn()),
    setActiveToolsByName: vi.fn(),
    model: { id: "restored-model", provider: "test" },
  };
}

function makeCoordinator({ agentsDir, ownerAgent, tempDir }) {
  return new SessionCoordinator({
    agentsDir,
    getAgent: () => ownerAgent,
    getActiveAgentId: () => "owner",
    getModels: () => ({
      currentModel: { id: "owner-model", provider: "test" },
      availableModels: [{ id: "restored-model", provider: "test" }],
      authStorage: {},
      modelRegistry: {},
      resolveThinkingLevel: () => "medium",
    }),
    getResourceLoader: () => ({
      getSystemPrompt: () => "BASE PROMPT",
      getAppendSystemPrompt: () => [],
      getExtensions: () => ({ extensions: [], errors: [] }),
      getSkills: () => ({ skills: [], diagnostics: [] }),
    }),
    getSkills: () => ({
      getSkillsForAgent: vi.fn(() => ({ skills: [], diagnostics: [] })),
    }),
    buildTools: (_cwd, customTools) => ({
      tools: [makeTool("read")],
      customTools,
    }),
    emitEvent: vi.fn(),
    getHomeCwd: () => tempDir,
    agentIdFromSessionPath: () => "owner",
    switchAgentOnly: async () => {},
    getConfig: () => ({}),
    getPrefs: () => ({ getThinkingLevel: () => "medium" }),
    getAgents: () => new Map(),
    getActivityStore: () => null,
    getAgentById: (id) => (id === "owner" ? ownerAgent : null),
    listAgents: () => [],
  });
}

describe("SessionCoordinator ensureSessionLoaded concurrency", () => {
  let tempDir;
  let agentsDir;
  let ownerSessionDir;
  let sessionPath;
  let ownerAgent;

  beforeEach(() => {
    vi.clearAllMocks();
    repairInlineMediaMock.mockReturnValue({
      repaired: false,
      stripped: 0,
      strippedImages: 0,
      strippedVideos: 0,
      strippedAudios: 0,
    });
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-ensure-race-"));
    agentsDir = path.join(tempDir, "agents");
    ownerSessionDir = path.join(agentsDir, "owner", "sessions");
    fs.mkdirSync(ownerSessionDir, { recursive: true });
    sessionPath = path.join(ownerSessionDir, "shared.jsonl");
    fs.writeFileSync(
      path.join(ownerSessionDir, "session-meta.json"),
      JSON.stringify({ [path.basename(sessionPath)]: { memoryEnabled: true } }, null, 2),
    );
    ownerAgent = makeAgent({ id: "owner", sessionDir: ownerSessionDir });
    sessionManagerOpenMock.mockImplementation((sp) => ({ getSessionFile: () => sp, getCwd: () => tempDir }));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("deduplicates concurrent loads of the same session path into one AgentSession", async () => {
    // 每次 createAgentSession 都造一个新实例：如果双加载发生，两个 caller 会拿到不同对象
    let releaseFirstCreate;
    const firstCreateGate = new Promise((resolve) => { releaseFirstCreate = resolve; });
    createAgentSessionMock.mockImplementation(async () => {
      await firstCreateGate;
      return { session: makeRestoredSession(sessionPath) };
    });

    const coordinator = makeCoordinator({ agentsDir, ownerAgent, tempDir });

    const p1 = coordinator.ensureSessionLoaded(sessionPath);
    const p2 = coordinator.ensureSessionLoaded(sessionPath);
    releaseFirstCreate();
    const [s1, s2] = await Promise.all([p1, p2]);

    expect(createAgentSessionMock).toHaveBeenCalledTimes(1);
    expect(s1).toBe(s2);
    expect(coordinator._sessions.size).toBe(1);
  });

  it("propagates a load failure to all concurrent callers and allows a fresh retry afterwards", async () => {
    createAgentSessionMock.mockRejectedValueOnce(new Error("provider exploded"));

    const coordinator = makeCoordinator({ agentsDir, ownerAgent, tempDir });

    const p1 = coordinator.ensureSessionLoaded(sessionPath);
    const p2 = coordinator.ensureSessionLoaded(sessionPath);
    await expect(p1).rejects.toThrow("provider exploded");
    await expect(p2).rejects.toThrow("provider exploded");

    // 失败后 in-flight 记录必须清除，后续调用可重新加载
    createAgentSessionMock.mockImplementation(async () => ({
      session: makeRestoredSession(sessionPath),
    }));
    const retried = await coordinator.ensureSessionLoaded(sessionPath);
    expect(retried.sessionManager.getSessionFile()).toBe(sessionPath);
    expect(createAgentSessionMock).toHaveBeenCalledTimes(2);
  });

  it("returns the cached entry without re-creating once a load has settled", async () => {
    createAgentSessionMock.mockImplementation(async () => ({
      session: makeRestoredSession(sessionPath),
    }));

    const coordinator = makeCoordinator({ agentsDir, ownerAgent, tempDir });

    const first = await coordinator.ensureSessionLoaded(sessionPath);
    const second = await coordinator.ensureSessionLoaded(sessionPath);
    expect(second).toBe(first);
    expect(createAgentSessionMock).toHaveBeenCalledTimes(1);
  });

  it.each(["switch", "reload", "direct"])("R01 shares ownership between background loading and %s", async (peer) => {
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    createAgentSessionMock.mockImplementation(async () => {
      entered.resolve();
      await gate.promise;
      return { session: makeRestoredSession(sessionPath) };
    });
    const coordinator = makeCoordinator({ agentsDir, ownerAgent, tempDir });
    const first = coordinator.ensureSessionLoaded(sessionPath);
    await entered.promise;
    const second = peer === "switch" ? coordinator.switchSession(sessionPath)
      : peer === "reload" ? coordinator.reloadSessionRuntime(sessionPath)
        : coordinator.createSession(sessionManagerOpenMock(sessionPath), tempDir, true, null, { restore: true });
    gate.resolve();
    const [loaded, other] = await Promise.all([first, second]);
    expect(createAgentSessionMock).toHaveBeenCalledTimes(1);
    expect(peer === "direct" ? other.session : other).toBe(loaded);
    expect(coordinator.getSessionByPath(sessionPath)).toBe(loaded);
  });

  it.each(["attach", "detached", "foreground"])("R06 keeps a newer focus while %s creation completes", async (entry) => {
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    createAgentSessionMock.mockImplementation(async () => {
      entered.resolve();
      await gate.promise;
      return { session: makeRestoredSession(sessionPath) };
    });
    const coordinator = makeCoordinator({ agentsDir, ownerAgent, tempDir });
    const oldPath = path.join(ownerSessionDir, "old.jsonl");
    coordinator._session = makeRestoredSession(oldPath);
    const newerPath = path.join(ownerSessionDir, "newer.jsonl");
    const newer = makeRestoredSession(newerPath);
    coordinator._sessions.set(newerPath, { session: newer, agentId: "owner" });
    const pending = entry === "attach" ? coordinator.ensureSessionLoaded(sessionPath)
      : entry === "foreground" ? coordinator.switchSession(sessionPath)
        : coordinator.createDetachedSession({ sessionMgr: sessionManagerOpenMock(sessionPath),
          agent: ownerAgent, model: { id: "restored-model", provider: "test" }, permissionMode: "read_only" });
    await entered.promise;
    await coordinator.switchSession(newerPath);
    coordinator._pendingPermissionMode = "auto";
    gate.resolve();
    await pending;
    expect(coordinator.currentSessionPath).toBe(newerPath);
    expect(coordinator.session).toBe(newer);
    expect(coordinator._pendingPermissionMode).toBe("auto");
  });
  it('R01 releases a partially initialized SDK owner after snapshot setup fails', async () => {
    const coordinator = makeCoordinator({ agentsDir, ownerAgent, tempDir });
    const broken = { ...makeRestoredSession(sessionPath), dispose: vi.fn() };
    broken.setActiveToolsByName.mockImplementation(() => { throw new Error('snapshot setup failed'); });
    createAgentSessionMock.mockResolvedValueOnce({ session: broken });
    await expect(coordinator.ensureSessionLoaded(sessionPath)).rejects.toThrow('snapshot setup failed');
    expect(broken.dispose).toHaveBeenCalled();
    expect(coordinator.getSessionByPath(sessionPath)).toBeNull();
    const fresh = makeRestoredSession(sessionPath);
    createAgentSessionMock.mockResolvedValueOnce({ session: fresh });
    expect(await coordinator.ensureSessionLoaded(sessionPath)).toBe(fresh);
  });

  it('R04 coordinator emits run completion only after actual SDK idle', async () => {
    const { Agent } = await import('@earendil-works/pi-agent-core');
    const actualAgent = new Agent();
    const session = { ...makeRestoredSession(sessionPath), agent: actualAgent,
      get isStreaming() { return actualAgent.state.isStreaming; },
      subscribe: fn => actualAgent.subscribe(fn),
    };
    createAgentSessionMock.mockResolvedValueOnce({ session });
    const coordinator = makeCoordinator({ agentsDir, ownerAgent, tempDir });
    await coordinator.ensureSessionLoaded(sessionPath);
    const held = (Promise as any).withResolvers();
    actualAgent.subscribe(async event => { if (event.type === 'agent_end') await held.promise; });
    const emit = (coordinator as any)._d.emitEvent;
    const running = (actualAgent as any).runWithLifecycle(async () => {
      await (actualAgent as any).processEvents({ type: 'turn_start' });
      await (actualAgent as any).processEvents({ type: 'turn_end', toolResults: [] });
      await (actualAgent as any).processEvents({ type: 'agent_end', messages: [] });
    });
    await vi.waitFor(() => expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'agent_end' }), sessionPath));
    expect(emit.mock.calls.filter(([e]) => e.type === 'session_run_end')).toHaveLength(0);
    held.resolve(); await running;
    await vi.waitFor(() => expect(emit.mock.calls.filter(([e]) => e.type === 'session_run_end')).toHaveLength(1));
    coordinator._notifySessionRunIdle(sessionPath, session);
    expect(emit.mock.calls.filter(([e]) => e.type === 'session_run_end')).toHaveLength(1);
  });
});

it('R05 coordinator stop cancels a desktop submission before loading completes', async () => {
  const { submitDesktopSessionMessage } = await import('../core/desktop-session-submit.ts');
  const loading = (Promise as any).withResolvers();
  const engine = { ensureSessionLoaded: vi.fn(() => loading.promise), promptSession: vi.fn() };
  const coordinator = new SessionCoordinator({ getEngine: () => engine } as any);
  vi.spyOn(coordinator as any, '_cleanupAbortedSessionSidecars').mockImplementation(() => {});
  const observed = submitDesktopSessionMessage(engine, { sessionPath: '/stopped.jsonl', text: 'old' }).catch(e => e);
  const stopped = await coordinator.abortSession('/stopped.jsonl');
  loading.resolve({});
  expect(stopped).toBe(true);
  expect(await observed).toMatchObject({ name: 'AbortError' });
  expect(engine.promptSession).not.toHaveBeenCalled();
});
