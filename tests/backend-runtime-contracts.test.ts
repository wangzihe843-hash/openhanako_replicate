import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type { Agent } from "../core/agent.ts";
import type { HanaEngine } from "../core/engine.ts";
import type { SessionCoordinator } from "../core/session-coordinator.ts";
import type { CompactionRuntime, RuntimeAgentIdentity, SessionAbortRequest, SessionCancellation } from "../core/runtime-contracts.ts";
import { compactSessionWithCachePreservationRecoveringRuntime } from "../core/session-compactor.ts";

interface TestCompaction { summary: string; tokensBefore: number }
function runtime(ready = true): CompactionRuntime<TestCompaction> {
  return {
    extensionRunner: { hasHandlers: () => ready },
    compact: vi.fn(async () => ({ summary: "saved", tokensBefore: 100 })),
    getContextUsage: () => ({ tokens: 10, contextWindow: 1000 }),
  };
}

describe("runtime dependency contracts", () => {
  it("shares typed identity and cancellation contracts across engine, coordinator and agent", () => {
    expectTypeOf<Agent>().toMatchTypeOf<RuntimeAgentIdentity>();
    expectTypeOf<HanaEngine>().toMatchTypeOf<SessionCancellation>();
    expectTypeOf<SessionCoordinator>().toMatchTypeOf<SessionCancellation>();
    expectTypeOf<Parameters<HanaEngine["abortSession"]>[1]>().toEqualTypeOf<SessionAbortRequest | undefined>();
  });

  it("retains the generic compaction result and awaits the reload observer", async () => {
    const next = runtime();
    const order: string[] = [];
    const result = await compactSessionWithCachePreservationRecoveringRuntime({
      session: runtime(false), sessionPath: "/sessions/test.jsonl",
      reloadSessionRuntime: async (sessionPath) => {
        expect(sessionPath).toBe("/sessions/test.jsonl");
        order.push("reload"); return next;
      },
      onRuntimeReload: async ({ session, error }) => {
        expect(session).toBe(next); expect(error).toBeInstanceOf(Error);
        await Promise.resolve(); order.push("observer");
      },
    });
    expectTypeOf(result.result).toEqualTypeOf<TestCompaction>();
    expect(result).toMatchObject({ recovered: true, result: { summary: "saved", tokensBefore: 100 } });
    expect(order).toEqual(["reload", "observer"]);
  });

  it("preserves the failed compaction error when runtime reload returns null", async () => {
    const reload = vi.fn(async () => null);
    await expect(compactSessionWithCachePreservationRecoveringRuntime({
      session: runtime(false), sessionPath: "/sessions/test.jsonl", reloadSessionRuntime: reload,
    })).rejects.toThrow("extension is not installed");
    expect(reload).toHaveBeenCalledOnce();
  });

  it("does not retry a provider error or replace a rejected observer error", async () => {
    const original = new Error("provider unavailable");
    const live = runtime();
    live.compact = async () => { throw original; };
    const reload = vi.fn(async () => runtime());
    await expect(compactSessionWithCachePreservationRecoveringRuntime({
      session: live, sessionPath: "test", reloadSessionRuntime: reload,
    })).rejects.toBe(original);
    expect(reload).not.toHaveBeenCalled();
    const observerError = new Error("reload observer failed");
    const next = runtime();
    await expect(compactSessionWithCachePreservationRecoveringRuntime({
      session: runtime(false), sessionPath: "test", reloadSessionRuntime: async () => next,
      onRuntimeReload: async () => { throw observerError; },
    })).rejects.toBe(observerError);
    expect(next.compact).not.toHaveBeenCalled();
  });
});
