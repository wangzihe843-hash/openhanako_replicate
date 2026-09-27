import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, it, expect, vi } from "vitest";
import { TaskRegistry } from "../lib/task-registry.ts";

afterEach(() => {
  vi.useRealTimers();
});

describe("TaskRegistry", () => {
  it("registerHandler validates abort method", () => {
    const reg = new TaskRegistry();
    expect(() => reg.registerHandler("test", {})).toThrow("must have an abort");
    expect(() => reg.registerHandler("test", { abort: "not a fn" })).toThrow("must have an abort");
  });

  it("register + query returns task info", () => {
    const reg = new TaskRegistry();
    reg.registerHandler("test", { abort: vi.fn() });
    reg.register("t1", { type: "test", parentSessionPath: "/p1" });
    const task = reg.query("t1");
    expect(task).toBeTruthy();
    expect(task.type).toBe("test");
    expect(task.parentSessionPath).toBe("/p1");
    expect(task.aborted).toBe(false);
  });

  it("abort dispatches to handler and returns 'aborted'", () => {
    const reg = new TaskRegistry();
    const abortFn = vi.fn();
    reg.registerHandler("test", { abort: abortFn });
    reg.register("t1", { type: "test", parentSessionPath: "/p1" });
    const result = reg.abort("t1");
    expect(result).toBe("aborted");
    expect(abortFn).toHaveBeenCalledWith("t1");
    expect(reg.query("t1").aborted).toBe(true);
  });

  it("abort with no handler returns 'no_handler'", () => {
    const reg = new TaskRegistry();
    // register task without registering handler first
    reg.register("t1", { type: "unknown", parentSessionPath: "/p1" });
    expect(reg.abort("t1")).toBe("no_handler");
  });

  it("abort on unknown taskId returns 'not_found'", () => {
    const reg = new TaskRegistry();
    expect(reg.abort("nope")).toBe("not_found");
  });

  it("double abort returns 'already_aborted'", () => {
    const reg = new TaskRegistry();
    reg.registerHandler("test", { abort: vi.fn() });
    reg.register("t1", { type: "test", parentSessionPath: "/p1" });
    reg.abort("t1");
    expect(reg.abort("t1")).toBe("already_aborted");
  });

  it("remove cleans up the task", () => {
    const reg = new TaskRegistry();
    reg.registerHandler("test", { abort: vi.fn() });
    reg.register("t1", { type: "test", parentSessionPath: "/p1" });
    reg.remove("t1");
    expect(reg.query("t1")).toBeNull();
  });

  it("unregisterHandler removes handler", () => {
    const reg = new TaskRegistry();
    reg.registerHandler("test", { abort: vi.fn() });
    reg.unregisterHandler("test");
    reg.register("t1", { type: "test", parentSessionPath: "/p1" });
    expect(reg.abort("t1")).toBe("no_handler");
  });

  it("listByType filters by type", () => {
    const reg = new TaskRegistry();
    reg.registerHandler("a", { abort: vi.fn() });
    reg.registerHandler("b", { abort: vi.fn() });
    reg.register("t1", { type: "a", parentSessionPath: "/p1" });
    reg.register("t2", { type: "b", parentSessionPath: "/p2" });
    reg.register("t3", { type: "a", parentSessionPath: "/p3" });
    const aList = reg.listByType("a");
    expect(aList).toHaveLength(2);
    expect(aList.map(t => t.taskId)).toEqual(["t1", "t3"]);
  });

  it("listAll returns all tasks", () => {
    const reg = new TaskRegistry();
    reg.registerHandler("a", { abort: vi.fn() });
    reg.register("t1", { type: "a", parentSessionPath: "/p1" });
    reg.register("t2", { type: "a", parentSessionPath: "/p2" });
    expect(reg.listAll()).toHaveLength(2);
  });

  it("projects scoped status transitions even after a task is removed", () => {
    const reg = new TaskRegistry({ getSessionIdForPath: (sessionPath: string) => (
      sessionPath === "/s/a" ? "sess_a" : sessionPath === "/s/b" ? "sess_b" : null
    ) });
    reg.registerHandler("test", { abort: vi.fn() });
    reg.register("a", { type: "test", parentSessionPath: "/s/a", meta: { secret: "private" } });
    reg.register("b", { type: "test", parentSessionPath: "/s/b" });
    const baseline = reg.presentationStatusForSession({ parentSessionId: "sess_a" });
    expect(baseline.tasks).toEqual([expect.objectContaining({ taskId: "a", status: "running" })]);
    expect(JSON.stringify(baseline)).not.toContain("private");

    reg.complete("a", "done");
    reg.remove("a");
    reg.fail("b", "failed");
    const after = reg.presentationStatusForSession({ parentSessionId: "sess_a" }, baseline.sequence);
    expect(after.tasks).toEqual([]);
    expect(after.changes).toEqual([expect.objectContaining({ taskId: "a", status: "completed" })]);
    expect(JSON.stringify(after)).not.toContain("done");
    expect(JSON.stringify(after)).not.toContain("failed");
  });

  it("records canceled as the last transition and bulk aborts without a handler", () => {
    const reg = new TaskRegistry();
    reg.registerHandler("test", { abort: vi.fn() });
    reg.register("cancel-me", { type: "test", parentSessionPath: "/s/a" });
    reg.register("bulk-me", { type: "unhandled", parentSessionPath: "/s/a" });
    const baseline = reg.presentationStatusForSession({ parentSessionPath: "/s/a" });
    reg.cancel("cancel-me");
    reg.abortByParentSession("/s/a");
    const changes = reg.presentationStatusForSession({ parentSessionPath: "/s/a" }, baseline.sequence).changes;
    expect(changes.filter((change) => change.taskId === "cancel-me").at(-1)?.status).toBe("canceled");
    expect(changes.find((change) => change.taskId === "bulk-me")?.status).toBe("aborted");
  });

  it("aborts active tasks registered under a parent session path", () => {
    const reg = new TaskRegistry();
    const abortFn = vi.fn();
    reg.registerHandler("subagent", { abort: abortFn });
    reg.register("t1", { type: "subagent", parentSessionPath: "/s/a" });
    reg.register("t2", { type: "subagent", parentSessionPath: "/s/b" });
    reg.register("t3", { type: "subagent", parentSessionPath: "/s/a" });
    reg.complete("t3");

    const result = reg.abortByParentSession("/s/a", "parent session archived");

    expect(result).toMatchObject({ aborted: 1, skippedFinal: 1 });
    expect(abortFn).toHaveBeenCalledWith("t1");
    expect(abortFn).not.toHaveBeenCalledWith("t2");
    expect(reg.query("t1")).toMatchObject({
      status: "aborted",
      aborted: true,
      error: "parent session archived",
    });
    expect(reg.query("t2")).toMatchObject({ status: "running", aborted: false });
    expect(reg.query("t3")).toMatchObject({ status: "completed", aborted: false });
  });

  it("aborts active tasks by stable parent session id after the parent path moves", () => {
    const originalPath = "/s/original";
    const movedPath = "/s/archived/renamed";
    const sessionId = "sess_task_registry";
    const reg = new TaskRegistry({
      getSessionIdForPath: (sessionPath: string) => (
        sessionPath === originalPath || sessionPath === movedPath ? sessionId : null
      ),
    });
    const abortFn = vi.fn();
    reg.registerHandler("subagent", { abort: abortFn });
    reg.register("t1", { type: "subagent", parentSessionPath: originalPath });
    reg.register("t2", { type: "subagent", parentSessionPath: "/s/other" });

    const result = reg.abortByParentSession(movedPath, "parent session archived");

    expect(result).toMatchObject({ matched: 1, aborted: 1 });
    expect(abortFn).toHaveBeenCalledWith("t1");
    expect(abortFn).not.toHaveBeenCalledWith("t2");
    expect(reg.query("t1")).toMatchObject({
      parentSessionId: sessionId,
      status: "aborted",
      aborted: true,
    });
    expect(reg.query("t2")).toMatchObject({ status: "running", aborted: false });
  });

  it("update, complete, and fail keep explicit task state", () => {
    const reg = new TaskRegistry();
    reg.registerHandler("render", { abort: vi.fn() });
    reg.register("t1", { type: "render", parentSessionPath: "/s/a", meta: { prompt: "a" } });

    reg.update("t1", {
      status: "running",
      progress: { current: 2, total: 4, message: "half" },
      meta: { model: "image" },
    });

    expect(reg.query("t1")).toMatchObject({
      status: "running",
      progress: { current: 2, total: 4, percent: 50, message: "half" },
      meta: { prompt: "a", model: "image" },
    });

    reg.complete("t1", { url: "file.png" });
    expect(reg.query("t1")).toMatchObject({
      status: "completed",
      result: { url: "file.png" },
    });

    reg.register("t2", { type: "render", parentSessionPath: "/s/a" });
    reg.fail("t2", "network");
    expect(reg.query("t2")).toMatchObject({
      status: "failed",
      error: "network",
    });
  });

  it("cancel delegates to abort handler and marks canceled tasks", () => {
    const reg = new TaskRegistry();
    const abortFn = vi.fn();
    reg.registerHandler("render", { abort: abortFn });
    reg.register("t1", { type: "render", parentSessionPath: "/s/a" });

    expect(reg.cancel("t1", "user")).toEqual({ result: "aborted", canceled: true });
    expect(abortFn).toHaveBeenCalledWith("t1");
    expect(reg.query("t1")).toMatchObject({
      status: "canceled",
      aborted: true,
      error: "user",
    });
  });

  it("persists tasks and restores active tasks as recovering", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-task-registry-"));
    const persistencePath = path.join(dir, "tasks.json");

    const reg = new TaskRegistry({ persistencePath });
    reg.registerHandler("render", { abort: vi.fn() });
    reg.register("t1", { type: "render", parentSessionPath: "/s/a", meta: { prompt: "a" } });
    reg.update("t1", { progress: { current: 1, total: 4 } });

    const restored = new TaskRegistry({ persistencePath });
    expect(restored.query("t1")).toMatchObject({
      type: "render",
      parentSessionPath: "/s/a",
      status: "recovering",
      progress: { current: 1, total: 4, percent: 25 },
      meta: { prompt: "a" },
    });
  });

  it("runs persisted schedules when their handler is registered", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-task-schedules-"));
    const persistencePath = path.join(dir, "tasks.json");

    const first = new TaskRegistry({ persistencePath });
    first.schedule("daily", {
      type: "digest",
      intervalMs: 1000,
      payload: { agentId: "a" },
    });

    const run = vi.fn(async () => ({ ok: true }));
    const restored = new TaskRegistry({ persistencePath });
    restored.registerHandler("digest", { abort: vi.fn(), run });

    await vi.advanceTimersByTimeAsync(1000);

    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      scheduleId: "daily",
      type: "digest",
      payload: { agentId: "a" },
    }));
    expect(restored.querySchedule("daily")).toMatchObject({
      enabled: true,
      runCount: 1,
      lastResult: { ok: true },
    });
    restored.clearTimers();
  });
});
