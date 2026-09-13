import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskRegistry } from "../lib/task-registry.ts";
import { sanitizeAssistantMessage } from "../lib/pi-sdk/stream-guard.ts";

const registries: TaskRegistry[] = [];
afterEach(() => {
  for (const registry of registries.splice(0)) registry.clearTimers();
  vi.useRealTimers();
});

describe("runtime audit scheduling and stream regressions", () => {
  it.each(["remove", "disable", "replace"])("R07 preserves %s during an in-flight schedule", async (operation) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-10T00:00:00Z"));
    const gate = Promise.withResolvers<string>();
    const registry = new TaskRegistry();
    registries.push(registry);
    const run = vi.fn(() => gate.promise);
    registry.registerHandler("audit", { abort: vi.fn(), run });
    registry.schedule("periodic", { type: "audit", intervalMs: 1000, payload: { version: 1 } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(1);
    if (operation === "remove") registry.unschedule("periodic");
    else registry.schedule("periodic", {
      type: "audit", enabled: operation !== "disable", intervalMs: 5000,
      payload: { version: 2 },
    });
    const desired = registry.querySchedule("periodic");
    gate.resolve("old execution result");
    await vi.advanceTimersByTimeAsync(0);
    expect(registry.querySchedule("periodic")).toEqual(desired);
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it.each([30, 60])("R09 waits until the actual %i-day deadline", async (days) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-10T00:00:00Z"));
    const registry = new TaskRegistry();
    registries.push(registry);
    const run = vi.fn(async () => "done");
    registry.registerHandler("audit", { abort: vi.fn(), run });
    const duration = days * 86400000;
    registry.schedule("future", { type: "audit", runAt: Date.now() + duration });
    await vi.advanceTimersByTimeAsync(2147483647);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(duration - 2147483647 - 1);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(registry.querySchedule("future").enabled).toBe(false);
  });

  it("R08 does not modify shared source text while recovering an invalid call", () => {
    const message = { role: "assistant", content: [
      { type: "text", text: "A" },
      { type: "toolCall", id: "empty", name: "", arguments: { text: "B" } },
    ] };
    const before = structuredClone(message);
    const partial = sanitizeAssistantMessage(message);
    const final = sanitizeAssistantMessage(message);
    expect(message).toEqual(before);
    expect(partial.content).toEqual([{ type: "text", text: "AB" }]);
    expect(final.content).toEqual(partial.content);
  });
});
