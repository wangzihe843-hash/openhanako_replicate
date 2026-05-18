import { beforeEach, describe, expect, it, vi } from "vitest";

import { DeferredResultCoordinator } from "../lib/deferred-result-coordinator.js";
import { DeferredResultStore } from "../lib/deferred-result-store.js";

describe("DeferredResultCoordinator", () => {
  let store;
  let sessionCoordinator;
  let coordinator;

  beforeEach(() => {
    store = new DeferredResultStore();
    sessionCoordinator = {
      deliverCustomMessage: vi.fn().mockResolvedValue({ ok: true, mode: "triggerTurn" }),
    };
    coordinator = new DeferredResultCoordinator({
      store,
      sessionCoordinator,
      retryIntervalMs: 0,
      log: { warn: vi.fn(), error: vi.fn(), log: vi.fn() },
    });
    coordinator.start();
  });

  it("delivers resolved task results through hidden custom messages and marks them delivered", async () => {
    store.defer("task-1", "/sessions/a.jsonl", { type: "subagent" });
    store.resolve("task-1", { replyText: "done <ok>" });

    await vi.waitFor(() => {
      expect(sessionCoordinator.deliverCustomMessage).toHaveBeenCalledOnce();
    });

    const [sessionPath, message] = sessionCoordinator.deliverCustomMessage.mock.calls[0];
    expect(sessionPath).toBe("/sessions/a.jsonl");
    expect(message).toMatchObject({
      customType: "hana-background-result",
      display: false,
    });
    expect(message.content).toContain("task-id=\"task-1\"");
    expect(message.content).toContain("status=\"success\"");
    expect(message.content).toContain("&lt;ok&gt;");
    expect(store.query("task-1")).toMatchObject({ delivered: true });
  });

  it("keeps undelivered tasks when custom message delivery fails", async () => {
    sessionCoordinator.deliverCustomMessage.mockRejectedValueOnce(new Error("session unavailable"));
    store.defer("task-2", "/sessions/a.jsonl", { type: "subagent" });
    store.resolve("task-2", "done");

    await vi.waitFor(() => {
      expect(sessionCoordinator.deliverCustomMessage).toHaveBeenCalledOnce();
    });

    expect(store.query("task-2")).toMatchObject({ delivered: false });
  });

  it("flushes old undelivered task results without waiting for a new store event", async () => {
    store._tasks.set("task-3", {
      status: "resolved",
      sessionPath: "/sessions/a.jsonl",
      meta: { type: "subagent" },
      deferredAt: Date.now(),
      result: "done",
      reason: null,
      delivered: false,
    });

    await coordinator.flushUndelivered();

    expect(sessionCoordinator.deliverCustomMessage).toHaveBeenCalledOnce();
    expect(store.query("task-3")).toMatchObject({ delivered: true });
  });
});
