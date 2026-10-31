import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DeferredResultStore } from "../lib/deferred-result-store.ts";
import { DeferredResultCoordinator } from "../lib/deferred-result-coordinator.ts";

let dir: string;
const stores: DeferredResultStore[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "deferred-persistence-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.dispose();
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

it.each(["write", "rename"] as const)("retries a failed %s during shutdown and restores the latest task result", (stage) => {
  const persistPath = path.join(dir, "tasks.json");
  const store = new DeferredResultStore(null, persistPath);
  stores.push(store);
  store.defer("task-a", "/sessions/a", { type: "image" });
  vi.advanceTimersByTime(1000);
  expect(JSON.parse(fs.readFileSync(persistPath, "utf-8"))["task-a"].status).toBe("pending");

  const error = Object.assign(new Error("temporary disk failure"), { code: "EACCES" });
  const failingWrite = stage === "write"
    ? vi.spyOn(fs, "writeFileSync").mockImplementationOnce(() => { throw error; })
    : vi.spyOn(fs, "renameSync").mockImplementationOnce(() => { throw error; });
  store.resolve("task-a", { files: ["result.png"] });
  expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
  expect(failingWrite).toHaveBeenCalledOnce();
  expect(JSON.parse(fs.readFileSync(persistPath, "utf-8"))["task-a"].status).toBe("pending");
  failingWrite.mockRestore();

  // No further state mutation occurs to mark the result dirty again.
  store.dispose();
  const reloaded = new DeferredResultStore(null, persistPath);
  stores.push(reloaded);
  expect(reloaded.query("task-a")).toMatchObject({
    status: "resolved",
    result: { files: ["result.png"] },
    delivered: false,
  });
});

it("normalizes legacy attempts without resetting delivered or suppression state and preserves current tokens", () => {
  const persistPath = path.join(dir, "legacy.json");
  const task = { status: "resolved", sessionPath: "/s/a", deferredAt: Date.now(), meta: {}, result: "legacy" };
  type LegacyTask = {
    status: string; sessionPath: string; deferredAt: number; meta: Record<string, unknown>; result: unknown;
    attemptId?: string; reason?: string; delivered?: boolean; deliverySuppressed?: boolean; suppressionReason?: string;
  };
  const legacy: Record<string, LegacyTask> = {
    pending: { ...task, status: "pending", result: null },
    resolved: { ...task, delivered: false },
    failed: { ...task, status: "failed", reason: "old failure", attemptId: "" },
    delivered: { ...task, delivered: true },
    suppressed: { ...task, delivered: true, deliverySuppressed: true, suppressionReason: "discarded branch" },
    current: { ...task, delivered: false, attemptId: "persisted-current-attempt" },
  };
  fs.writeFileSync(persistPath, JSON.stringify(legacy));
  const store = new DeferredResultStore(null, persistPath);
  stores.push(store);
  const snapshots: Record<string, LegacyTask & { attemptId: string }> = Object.fromEntries(Object.keys(legacy).map((id) => [id, store.query(id)]));
  expect(new Set(Object.values(snapshots).map((record) => record.attemptId)).size).toBe(6);
  for (const [id, original] of Object.entries(legacy)) {
    const { attemptId: _oldId, ...rest } = original;
    expect(snapshots[id]).toMatchObject(rest);
    expect(snapshots[id].attemptId).toEqual(expect.any(String));
    expect(snapshots[id].attemptId.length).toBeGreaterThan(0);
  }
  expect(snapshots.current.attemptId).toBe("persisted-current-attempt");
  expect(store.listUndelivered().map((record) => record.taskId).sort()).toEqual(["current", "failed", "resolved"]);
  vi.advanceTimersByTime(1000); // Migration alone is dirty; no task mutation is needed.
  const reopened = new DeferredResultStore(null, persistPath);
  stores.push(reopened);
  for (const id of Object.keys(legacy)) expect(reopened.query(id)).toEqual(snapshots[id]);
});

it.each(["write", "rename"] as const)("keeps a retried attempt and its undelivered result across a failed %s and restart", async (stage) => {
  const persistPath = path.join(dir, "retry.json");
  const store = new DeferredResultStore(null, persistPath);
  stores.push(store);
  store.defer("task", "/s/a", { deliveryIntent: "ui_only" });
  store.fail("task", "OLD_FAILURE");
  const oldId = store.query("task").attemptId;
  vi.advanceTimersByTime(1000);

  store.retry("task", "/s/a", { deliveryIntent: "ui_only" });
  const currentId = store.query("task").attemptId;
  store.resolve("task", "NEW_RESULT");
  expect(store.markDelivered("task", oldId)).toBe(false);
  const error = Object.assign(new Error("synthetic disk failure"), { code: "EIO" });
  const failingWrite = stage === "write"
    ? vi.spyOn(fs, "writeFileSync").mockImplementationOnce(() => { throw error; })
    : vi.spyOn(fs, "renameSync").mockImplementationOnce(() => { throw error; });
  vi.advanceTimersByTime(1000);
  expect(failingWrite).toHaveBeenCalledOnce();
  expect(JSON.parse(fs.readFileSync(persistPath, "utf8")).task.attemptId).toBe(oldId);
  failingWrite.mockRestore();
  store.dispose();

  const reopened = new DeferredResultStore(null, persistPath);
  stores.push(reopened);
  expect(reopened.query("task")).toMatchObject({ attemptId: currentId, result: "NEW_RESULT", delivered: false });
  expect(reopened.markDelivered("task", oldId)).toBe(false);
  const recordCustomEntry = vi.fn(() => ({ ok: true }));
  const coordinator = new DeferredResultCoordinator({ store: reopened, sessionCoordinator: { recordCustomEntry }, retryIntervalMs: 0 });
  await coordinator.flushUndelivered();
  await coordinator.flushUndelivered();
  coordinator.dispose();
  expect(recordCustomEntry).toHaveBeenCalledOnce();
  expect(recordCustomEntry.mock.calls[0]).toEqual(["/s/a", "hana-deferred-result", expect.objectContaining({ result: "NEW_RESULT" })]);
  reopened.dispose();
  const delivered = new DeferredResultStore(null, persistPath);
  stores.push(delivered);
  expect(delivered.query("task")).toMatchObject({ attemptId: currentId, result: "NEW_RESULT", delivered: true });
  expect(delivered.listUndelivered()).toEqual([]);
});

it("retries a failed legacy-token migration on dispose without changing delivery state", () => {
  const persistPath = path.join(dir, "legacy-write-failure.json");
  const original = { status: "failed", sessionPath: "/s/a", deferredAt: Date.now(), reason: "legacy failure", delivered: true };
  fs.writeFileSync(persistPath, JSON.stringify({ task: original }));
  const store = new DeferredResultStore(null, persistPath);
  stores.push(store);
  const attemptId = store.query("task").attemptId;
  const failed = vi.spyOn(fs, "renameSync").mockImplementationOnce(() => { throw new Error("synthetic rename failure"); });
  vi.advanceTimersByTime(1000);
  expect(failed).toHaveBeenCalledOnce();
  expect(JSON.parse(fs.readFileSync(persistPath, "utf8"))).toEqual({ task: original });
  failed.mockRestore();
  store.dispose();
  const reopened = new DeferredResultStore(null, persistPath);
  stores.push(reopened);
  expect(reopened.query("task")).toMatchObject({ ...original, attemptId });
  expect(reopened.listUndelivered()).toEqual([]);
});

it("recovers only the last successful snapshot after repeated write failures, without blanket redelivery", () => {
  const persistPath = path.join(dir, "unflushed.json");
  const store = new DeferredResultStore(null, persistPath);
  stores.push(store);
  store.defer("task", "/s/a");
  store.resolve("task", "DURABLE_RESULT");
  store.markDelivered("task");
  vi.advanceTimersByTime(1000);
  const durable = store.query("task");
  store.retry("task", "/s/a");
  store.resolve("task", "UNFLUSHED_RESULT");
  const failed = vi.spyOn(fs, "renameSync").mockImplementation(() => { throw new Error("persistent synthetic rename failure"); });
  vi.advanceTimersByTime(1000);
  store.dispose();
  expect(failed).toHaveBeenCalledTimes(2);
  // A restarted process cannot see state that never reached disk.
  const reopened = new DeferredResultStore(null, persistPath);
  stores.push(reopened);
  expect(reopened.query("task")).toEqual(durable);
  expect(reopened.listUndelivered()).toEqual([]);
  failed.mockRestore();
});
