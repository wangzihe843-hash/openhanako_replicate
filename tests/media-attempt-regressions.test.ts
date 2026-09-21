import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Poller } from "../core/media/poller.ts";
import { TaskStore } from "../core/media/task-store.ts";
import { readImageSize } from "../core/media/image-size.ts";
import { retryImageTask, runSubmitInBackground } from "../core/media/image-task-runner.ts";

vi.mock("../core/media/image-size.ts", () => ({ readImageSize: vi.fn(async () => null) }));

type ProviderResult = { status?: string; taskId?: string; files?: string[] };
function deferred<T>() {
  let resolve: (value: T) => void;
  let reject: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve: (value: T) => resolve(value), reject: (error: Error) => reject(error) };
}
const cleanup: Array<() => void> = [];
const TASK = "reused-task";
function fixture(patch: Record<string, unknown> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-media-attempt-"));
  const store = new TaskStore(root);
  store.add({
    taskId: TASK, adapterId: "fixture", batchId: "batch", type: "image",
    prompt: "draw once", params: { type: "image", prompt: "draw once" },
    sessionPath: "/fixture.jsonl", adapterTaskId: "old-provider", submitState: "submitted",
  });
  store.update(TASK, patch);
  const adapter = {
    id: "fixture",
    query: vi.fn(async (_taskId: string): Promise<ProviderResult> => ({ status: "success", files: ["new.png"] })),
    submit: vi.fn(async (): Promise<ProviderResult> => ({ taskId: "new-provider" })),
  };
  const registry = { get: () => adapter };
  const bus = {
    request: vi.fn(async (_event: string, _payload: unknown): Promise<unknown> => ({})),
    emit: vi.fn(),
  };
  const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };
  const registerSessionFile = vi.fn(() => ({ fileId: "registered-file" }));
  const poller = new Poller({ store, registry, bus, dataDir: root, generatedDir: path.join(root, "generated"), log, registerSessionFile });
  const ctx = { _mediaGen: { store, registry, poller }, dataDir: root, bus, log, config: { get: () => undefined } };
  const submit = () => runSubmitInBackground({ taskId: TASK, adapter, params: {}, submitCtx: {}, store, poller, ctx });
  cleanup.push(() => { poller.stop(); store.destroy(); fs.rmSync(root, { recursive: true, force: true }); });
  return { store, adapter, bus, poller, ctx, submit, registerSessionFile };
}
function callsFor(bus: ReturnType<typeof fixture>["bus"], event: string) {
  return bus.request.mock.calls.filter(([name]) => name === event);
}

afterEach(() => {
  for (const finish of cleanup.splice(0)) finish();
  vi.mocked(readImageSize).mockReset();
  vi.mocked(readImageSize).mockResolvedValue(null);
});

describe("media task attempt ownership", () => {
  it.each(["old-query-first", "new-submit-first"])("keeps a retry's result when a canceled query finishes (%s)", async (order) => {
    const f = fixture();
    const oldQuery = deferred<ProviderResult>();
    const newSubmit = deferred<ProviderResult>();
    f.adapter.query.mockImplementationOnce(() => oldQuery.promise);
    f.adapter.submit.mockImplementationOnce(() => newSubmit.promise);
    f.poller.add(TASK);
    const oldCheck = f.poller.checkNow(TASK);
    await vi.waitFor(() => expect(f.adapter.query).toHaveBeenCalledTimes(1));
    f.poller.cancel(TASK);
    expect(await retryImageTask({ taskId: TASK, ctx: f.ctx })).toMatchObject({ ok: true });
    if (order === "old-query-first") {
      oldQuery.resolve({ status: "success", files: ["old.png"] });
      await oldCheck;
      expect(f.store.get(TASK)).toMatchObject({ status: "pending", files: [], submitState: "submitting" });
    }
    newSubmit.resolve({ taskId: "new-provider" });
    await vi.waitFor(() => expect(f.store.get(TASK).adapterTaskId).toBe("new-provider"));
    await f.poller.checkNow(TASK);
    if (order === "new-submit-first") {
      oldQuery.resolve({ status: "success", files: ["old.png"] });
      await oldCheck;
    }
    expect(f.store.get(TASK)).toMatchObject({ status: "done", files: ["new.png"], adapterTaskId: "new-provider" });
    expect(f.adapter.query.mock.calls.map(([id]) => id)).toEqual(["old-provider", "new-provider"]);
    expect(f.registerSessionFile).toHaveBeenCalledTimes(1);
    expect(callsFor(f.bus, "deferred:resolve")).toHaveLength(1);
    expect(f.bus.emit).toHaveBeenCalledTimes(1);
    expect(f.poller.hasPending(TASK)).toBe(false);
  });

  it.each(["query", "submit-files"])("honors cancellation while reading dimensions after %s", async (source) => {
    const f = fixture(source === "submit-files" ? { files: ["old.png"] } : {});
    const dimensions = deferred<{ width: number; height: number }>();
    vi.mocked(readImageSize).mockImplementationOnce(() => dimensions.promise);
    f.poller.add(TASK);
    const check = f.poller.checkNow(TASK);
    await vi.waitFor(() => expect(readImageSize).toHaveBeenCalledTimes(1));
    f.poller.cancel(TASK);
    dimensions.resolve({ width: 200, height: 100 });
    await check;
    expect(f.store.get(TASK).status).toBe("cancelled");
    expect(f.registerSessionFile).not.toHaveBeenCalled();
    expect(callsFor(f.bus, "deferred:resolve")).toHaveLength(0);
    expect(f.bus.emit).not.toHaveBeenCalled();
  });

  it.each([
    { outcome: "success", cancelNew: false }, { outcome: "failure", cancelNew: false },
    { outcome: "success", cancelNew: true }, { outcome: "failure", cancelNew: true },
  ])("ignores old submit $outcome after retry (new canceled: $cancelNew)", async ({ outcome, cancelNew }) => {
    const f = fixture({ submitState: "submitting", adapterTaskId: null });
    const oldSubmit = deferred<ProviderResult>();
    const newSubmit = deferred<ProviderResult>();
    f.adapter.submit.mockImplementationOnce(() => oldSubmit.promise).mockImplementationOnce(() => newSubmit.promise);
    f.poller.add(TASK);
    const oldRun = f.submit();
    f.poller.cancel(TASK);
    expect(await retryImageTask({ taskId: TASK, ctx: f.ctx })).toMatchObject({ ok: true });
    expect(f.adapter.submit).toHaveBeenCalledTimes(2);
    if (cancelNew) f.poller.cancel(TASK);
    if (outcome === "success") oldSubmit.resolve({ taskId: "old-provider", files: ["old.png"] });
    else oldSubmit.reject(new Error("old provider failure"));
    await oldRun;
    expect(f.store.get(TASK)).toMatchObject({ status: cancelNew ? "cancelled" : "pending", files: [], adapterTaskId: null });
    newSubmit.resolve({ taskId: "new-provider" });
    if (!cancelNew) {
      await vi.waitFor(() => expect(f.store.get(TASK).adapterTaskId).toBe("new-provider"));
      await f.poller.checkNow(TASK);
      expect(f.store.get(TASK)).toMatchObject({ status: "done", files: ["new.png"] });
    } else {
      await Promise.resolve();
      await Promise.resolve();
      expect(f.store.get(TASK)).toMatchObject({ status: "cancelled", files: [], adapterTaskId: null });
    }
    expect(callsFor(f.bus, "deferred:fail")).toHaveLength(0);
  });

  it("shares one in-flight query between immediate checks and interval ticks", async () => {
    const f = fixture();
    const query = deferred<ProviderResult>();
    f.adapter.query.mockImplementationOnce(() => query.promise);
    f.poller.add(TASK);
    const checks = [f.poller.checkNow(TASK), f.poller.checkNow(TASK)];
    f.poller._tick();
    await vi.waitFor(() => expect(f.adapter.query).toHaveBeenCalledTimes(1));
    query.resolve({ status: "pending" });
    await Promise.all(checks);
    await f.poller.checkNow(TASK);
    expect(f.adapter.query).toHaveBeenCalledTimes(2);
    expect(f.store.get(TASK).status).toBe("done");
  });

  it("allows a new query while an old one is pending and ignores the old failure", async () => {
    const f = fixture();
    const oldQuery = deferred<ProviderResult>();
    f.adapter.query.mockImplementationOnce(() => oldQuery.promise);
    f.poller.add(TASK);
    const oldCheck = f.poller.checkNow(TASK);
    await vi.waitFor(() => expect(f.adapter.query).toHaveBeenCalledTimes(1));
    f.poller.cancel(TASK);
    await retryImageTask({ taskId: TASK, ctx: f.ctx });
    await vi.waitFor(() => expect(f.store.get(TASK).adapterTaskId).toBe("new-provider"));
    await f.poller.checkNow(TASK);
    oldQuery.reject(new Error("late old query failure"));
    await oldCheck;
    expect(f.store.get(TASK)).toMatchObject({ status: "done", files: ["new.png"] });
    expect(callsFor(f.bus, "deferred:fail")).toHaveLength(0);
  });

  it("serializes concurrent retry requests before they can submit duplicate jobs", async () => {
    const f = fixture({ status: "failed" });
    const registration = deferred<unknown>();
    f.bus.request.mockImplementation((event) => event === "deferred:retry" ? registration.promise : Promise.resolve({}));
    const first = retryImageTask({ taskId: TASK, ctx: f.ctx });
    expect(await retryImageTask({ taskId: TASK, ctx: f.ctx })).toMatchObject({ ok: false, status: 409 });
    registration.resolve({});
    expect(await first).toMatchObject({ ok: true });
    expect(f.adapter.submit).toHaveBeenCalledTimes(1);
    expect(f.store.get(TASK).retryCount).toBe(1);
  });

  it("does not resurrect a retry canceled during task registration", async () => {
    const f = fixture({ status: "failed" });
    const registration = deferred<unknown>();
    f.bus.request.mockImplementation((event) => event === "task:register" ? registration.promise : Promise.resolve({}));
    const retry = retryImageTask({ taskId: TASK, ctx: f.ctx });
    await vi.waitFor(() => expect(f.poller.hasPending(TASK)).toBe(true));
    f.poller.cancel(TASK);
    registration.resolve({});
    expect(await retry).toMatchObject({ ok: false, status: 409 });
    expect(f.adapter.submit).not.toHaveBeenCalled();
    expect(f.store.get(TASK).status).toBe("cancelled");
  });

  it("does not emit stale completion after deferred notification settles in a newer attempt", async () => {
    const f = fixture();
    const notification = deferred<unknown>();
    f.bus.request.mockImplementation((event) => event === "deferred:resolve" ? notification.promise : Promise.resolve({}));
    f.poller.add(TASK);
    const oldCheck = f.poller.checkNow(TASK);
    await vi.waitFor(() => expect(callsFor(f.bus, "deferred:resolve")).toHaveLength(1));
    // Simulate the lifecycle replacing this task while its previous notification is pending.
    f.store.update(TASK, { status: "pending", adapterTaskId: "new-provider", files: [] });
    f.poller.add(TASK);
    notification.resolve({});
    await oldCheck;
    expect(f.bus.emit).not.toHaveBeenCalled();
    expect(f.poller.hasPending(TASK)).toBe(true);
    expect(f.store.get(TASK).status).toBe("pending");
  });

  it("retains normal failed-submit retry behavior", async () => {
    const f = fixture({ status: "failed" });
    f.adapter.submit.mockRejectedValueOnce(new Error("current provider failure"));
    await retryImageTask({ taskId: TASK, ctx: f.ctx });
    await vi.waitFor(() => expect(f.store.get(TASK).status).toBe("failed"));
    expect(callsFor(f.bus, "deferred:fail")).toHaveLength(1);
    expect(await retryImageTask({ taskId: TASK, ctx: f.ctx })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(f.store.get(TASK).adapterTaskId).toBe("new-provider"));
    await f.poller.checkNow(TASK);
    expect(f.store.get(TASK)).toMatchObject({ status: "done", files: ["new.png"], retryCount: 2 });
  });
});
