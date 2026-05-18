import { describe, expect, it, vi } from "vitest";

import { SessionCoordinator } from "../core/session-coordinator.js";

function makeCoordinator(overrides = {}) {
  return new SessionCoordinator({
    agentsDir: "/tmp/fake",
    getAgent: () => ({ id: "test-agent" }),
    getActiveAgentId: () => "test-agent",
    getModels: () => ({}),
    getResourceLoader: () => ({}),
    getSkills: () => ({}),
    buildTools: () => ({ tools: [], customTools: [] }),
    emitEvent: () => {},
    getHomeCwd: () => "/tmp",
    agentIdFromSessionPath: () => "test-agent",
    switchAgentOnly: async () => {},
    getConfig: () => ({}),
    getAgents: () => new Map(),
    getActivityStore: () => ({}),
    getAgentById: () => ({ id: "test-agent" }),
    listAgents: () => [],
    getPrefs: () => ({ getThinkingLevel: () => "medium" }),
    ...overrides,
  });
}

function makeSession({ isStreaming }) {
  return {
    isStreaming,
    sendCustomMessage: vi.fn().mockResolvedValue(undefined),
  };
}

describe("SessionCoordinator deferred custom delivery", () => {
  it("wakes an idle live session with triggerTurn instead of steer", async () => {
    const coord = makeCoordinator();
    const session = makeSession({ isStreaming: false });
    coord.sessions.set("/sessions/a.jsonl", {
      session,
      agentId: "test-agent",
      lastTouchedAt: 0,
    });
    coord.steerSession = vi.fn();

    const result = await coord.deliverCustomMessage("/sessions/a.jsonl", {
      customType: "hana-background-result",
      content: "<hana-background-result />",
      display: false,
    });

    expect(result).toMatchObject({ ok: true, mode: "triggerTurn" });
    expect(session.sendCustomMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: "hana-background-result", display: false }),
      { triggerTurn: true },
    );
    expect(coord.steerSession).not.toHaveBeenCalled();
  });

  it("queues custom delivery as a follow-up when the session is currently streaming", async () => {
    const coord = makeCoordinator();
    const session = makeSession({ isStreaming: true });
    coord.sessions.set("/sessions/a.jsonl", {
      session,
      agentId: "test-agent",
      lastTouchedAt: 0,
    });

    const result = await coord.deliverCustomMessage("/sessions/a.jsonl", {
      customType: "hana-background-result",
      content: "<hana-background-result />",
      display: false,
    });

    expect(result).toMatchObject({ ok: true, mode: "followUp" });
    expect(session.sendCustomMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: "hana-background-result", display: false }),
      { deliverAs: "followUp" },
    );
  });

  it("cold-loads an unloaded session before delivering the custom message", async () => {
    const coord = makeCoordinator();
    const session = makeSession({ isStreaming: false });
    coord.ensureSessionLoaded = vi.fn(async (sessionPath) => {
      coord.sessions.set(sessionPath, {
        session,
        agentId: "test-agent",
        lastTouchedAt: 0,
      });
      return session;
    });

    const result = await coord.deliverCustomMessage("/sessions/cold.jsonl", {
      customType: "hana-background-result",
      content: "<hana-background-result />",
      display: false,
    });

    expect(result).toMatchObject({ ok: true, mode: "triggerTurn" });
    expect(coord.ensureSessionLoaded).toHaveBeenCalledWith("/sessions/cold.jsonl");
    expect(session.sendCustomMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: "hana-background-result", display: false }),
      { triggerTurn: true },
    );
  });
});
