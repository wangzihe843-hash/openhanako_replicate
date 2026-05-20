import { describe, expect, it, vi } from "vitest";

const { estimateTokensMock } = vi.hoisted(() => ({
  estimateTokensMock: vi.fn(() => 2000),
}));

vi.mock("../lib/pi-sdk/index.js", () => ({
  createAgentSession: vi.fn(),
  SessionManager: {
    create: vi.fn(),
    open: vi.fn(),
  },
  estimateTokens: estimateTokensMock,
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

import { SessionCoordinator } from "../core/session-coordinator.js";

const agentsDir = "/tmp/agents";
const sessionPath = `${agentsDir}/hana/sessions/session.jsonl`;
const missingSessionPath = `${agentsDir}/hana/sessions/missing.jsonl`;

describe("SessionCoordinator.switchSessionModel", () => {
  it("reports per-session model switch state through a public query", () => {
    const coord = new SessionCoordinator({
      agentsDir,
      getAgent: () => ({ sessionDir: `${agentsDir}/hana/sessions` }),
      getActiveAgentId: () => "hana",
      getModels: () => null,
      getResourceLoader: () => null,
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      getHomeCwd: () => "/tmp",
      agentIdFromSessionPath: () => null,
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => null,
      listAgents: () => [],
    });

    coord.sessions.set(sessionPath, {
      session: {},
      _switching: true,
    });

    expect(coord.isSessionSwitching(sessionPath)).toBe(true);
    expect(coord.isSessionSwitching(missingSessionPath)).toBe(false);
  });

  it("does not crash when context usage exists and adaptation is needed", async () => {
    const coord = new SessionCoordinator({
      agentsDir,
      getAgent: () => ({ sessionDir: `${agentsDir}/hana/sessions` }),
      getActiveAgentId: () => "hana",
      getModels: () => null,
      getResourceLoader: () => null,
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      getHomeCwd: () => "/tmp",
      agentIdFromSessionPath: () => null,
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => null,
      listAgents: () => [],
    });

    const setModel = vi.fn(async () => {});
    const entry = {
      session: {
        model: { id: "old-model", provider: "test", contextWindow: 64000 },
        isCompacting: false,
        getContextUsage: () => ({ tokens: 10000 }),
        agent: {
          state: {
            messages: [
              { role: "system", content: "sys" },
              { role: "user", content: "question" },
              { role: "assistant", content: "answer" },
            ],
          },
        },
        setModel,
      },
      modelId: "old-model",
      modelProvider: "test",
    };
    coord.sessions.set(sessionPath, entry);

    const compactSpy = vi.spyOn(coord, "_compactWithModel").mockResolvedValue();
    const truncateSpy = vi.spyOn(coord, "_hardTruncate").mockResolvedValue();

    const result = await coord.switchSessionModel(sessionPath, {
      id: "new-model",
      provider: "test",
      contextWindow: 12000,
    });

    expect(result).toEqual({ adaptations: ["compacted"], thinkingLevel: "medium" });
    expect(compactSpy).toHaveBeenCalledOnce();
    expect(truncateSpy).not.toHaveBeenCalled();
    expect(setModel).toHaveBeenCalledWith({
      id: "new-model",
      provider: "test",
      contextWindow: 12000,
    });
    expect(entry.modelId).toBe("new-model");
    expect(entry.modelProvider).toBe("test");
  });

  it("falls back from xhigh to high when switching to a model without max thinking support", async () => {
    const coord = new SessionCoordinator({
      agentsDir,
      getAgent: () => ({ sessionDir: `${agentsDir}/hana/sessions` }),
      getActiveAgentId: () => "hana",
      getModels: () => null,
      getResourceLoader: () => null,
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      getHomeCwd: () => "/tmp",
      agentIdFromSessionPath: () => null,
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "xhigh" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => null,
      listAgents: () => [],
    });
    vi.spyOn(coord, "writeSessionMeta").mockResolvedValue();

    const setModel = vi.fn(async () => {});
    const setThinkingLevel = vi.fn();
    const entry = {
      session: {
        model: { id: "max-model", provider: "test", contextWindow: 64000, xhigh: true },
        isCompacting: false,
        getContextUsage: () => ({ tokens: 1000 }),
        agent: { state: { messages: [] } },
        setModel,
        setThinkingLevel,
      },
      modelId: "max-model",
      modelProvider: "test",
      thinkingLevel: "xhigh",
    };
    coord.sessions.set(sessionPath, entry);

    const result = await coord.switchSessionModel(sessionPath, {
      id: "regular-model",
      provider: "test",
      contextWindow: 64000,
    });

    expect(result).toEqual({ adaptations: [], thinkingLevel: "high" });
    expect(setModel).toHaveBeenCalledOnce();
    expect(setThinkingLevel).toHaveBeenCalledWith("high");
    expect(entry.thinkingLevel).toBe("high");
    expect(coord.writeSessionMeta).toHaveBeenCalledWith(sessionPath, expect.objectContaining({
      thinkingLevel: "high",
    }));
  });
});
