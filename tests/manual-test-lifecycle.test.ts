import { afterEach, expect, it, vi } from "vitest";
import { ManualTestOwner } from "./helpers/manual-test-lifecycle.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => vi.useRealTimers());

it("owns a late body until it exits and prevents it from entering the next fixture", async () => {
  const owner = new ManualTestOwner();
  const controller = new AbortController();
  const first = owner.create(controller.signal);
  const entered = deferred(); const resume = deferred();
  const oldOperation = vi.fn(); const nextOperation = vi.fn();
  const body = first.run(async () => {
    entered.resolve();
    // Represents a non-cancellable await, such as module evaluation.
    await resume.promise;
    first.assertActive();
    oldOperation();
  });
  const rejected = expect(body).rejects.toThrow("manual fixture is closed");
  await entered.promise;
  controller.abort();
  const cleanup = owner.finish(first);
  expect(() => owner.create(new AbortController().signal)).toThrow("previous manual fixture");
  resume.resolve();
  await rejected;
  await cleanup;
  const next = owner.create(new AbortController().signal);
  await next.run(async () => { nextOperation(); });
  await owner.finish(next);
  expect(oldOperation).not.toHaveBeenCalled();
  expect(nextOperation).toHaveBeenCalledOnce();
  expect(() => first.barrier()).toThrow("manual fixture is closed");
});

it("releases held operations on cancellation and drains registrations made by a late finally", async () => {
  const owner = new ManualTestOwner();
  const controller = new AbortController();
  const scope = owner.create(controller.signal);
  const held = scope.barrier(); const entered = deferred();
  const registered = deferred(); const late = deferred();
  let cleanupDone = false;
  const body = scope.run(async () => {
    try {
      entered.resolve();
      await scope.bounded(held.promise);
    } finally {
      scope.track(late.promise);
      registered.resolve();
    }
  });
  const rejected = expect(body).rejects.toThrow("manual fixture is closed");
  await entered.promise;
  controller.abort();
  const cleanup = owner.finish(scope).then(() => { cleanupDone = true; });
  await held.promise;
  await registered.promise;
  await rejected;
  expect(cleanupDone).toBe(false);
  expect(() => owner.assertReady()).toThrow("previous manual fixture");
  late.resolve();
  await cleanup;
  expect(() => owner.assertReady()).not.toThrow();
});

it("fails cleanup at 2 s and prevents reuse even if the old body resumes later", async () => {
  vi.useFakeTimers();
  const owner = new ManualTestOwner();
  const scope = owner.create(new AbortController().signal);
  const entered = deferred(); const resume = deferred();
  const oldOperation = vi.fn();
  const body = scope.run(async () => {
    entered.resolve(); await resume.promise;
    scope.assertActive(); oldOperation();
  });
  const rejected = expect(body).rejects.toThrow("manual fixture is closed");
  await entered.promise;
  const cleanup = expect(owner.finish(scope)).rejects.toThrow("manual fixture cleanup did not settle");
  await vi.advanceTimersByTimeAsync(2000);
  await cleanup;
  expect(() => owner.create(new AbortController().signal)).toThrow("previous manual fixture");
  resume.resolve();
  await rejected;
  expect(oldOperation).not.toHaveBeenCalled();
  expect(() => owner.assertReady()).toThrow("previous manual fixture");
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps the 2 s operation deadline and owns the raw operation after it times out", async () => {
  vi.useFakeTimers();
  const owner = new ManualTestOwner();
  const scope = owner.create(new AbortController().signal);
  const gate = scope.barrier();
  const expired = expect(scope.bounded(gate.promise)).rejects.toThrow("manual operation did not settle");
  await vi.advanceTimersByTimeAsync(2000);
  await expired;
  await owner.finish(scope);
  await gate.promise;
  expect(vi.getTimerCount()).toBe(0);
  expect(() => owner.assertReady()).not.toThrow();
});

it("propagates body failures and clears timers while cleanup releases abandoned gates", async () => {
  vi.useFakeTimers();
  const owner = new ManualTestOwner();
  const scope = owner.create(new AbortController().signal);
  const gate = scope.barrier();
  const failure = new Error("synthetic assertion failure");
  const operation = scope.bounded(gate.promise);
  const rejected = expect(operation).rejects.toThrow("manual fixture is closed");
  await expect(scope.run(async () => { throw failure; })).rejects.toBe(failure);
  await owner.finish(scope);
  await rejected;
  expect(vi.getTimerCount()).toBe(0);
});

it("does not start a body for an already aborted context or accept another owner's cleanup", async () => {
  const owner = new ManualTestOwner();
  const controller = new AbortController(); controller.abort();
  const scope = owner.create(controller.signal);
  const body = vi.fn(async () => {});
  await expect(scope.run(body)).rejects.toThrow("manual fixture is closed");
  expect(body).not.toHaveBeenCalled();
  const other = new ManualTestOwner();
  await expect(other.finish(scope)).rejects.toThrow("owner mismatch");
  await owner.finish(scope);
});
