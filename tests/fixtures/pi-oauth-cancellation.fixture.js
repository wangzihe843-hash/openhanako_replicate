import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test, after } from "node:test";

// Official Pi 1.0.3 regression: caller cancellation must not discard rotated credentials.
const root = process.env.HANA_OAUTH_FIXTURE_ROOT;
if (!root) throw new Error("HANA_OAUTH_FIXTURE_ROOT must point to an isolated test directory");
let networkAttempts = 0;
globalThis.fetch = async () => { networkAttempts++; throw new Error("Synthetic suite forbids network"); };
const { AuthStorage, FileAuthStorageBackend } = await import("../../lib/pi-sdk/index.ts");
const providerId = "synthetic-refresh-cancellation";
const old = { type: "oauth", access: "synthetic-old-access", refresh: "synthetic-old-refresh", expires: 1 };
const rotated = () => ({ type: "oauth", access: "synthetic-new-access", refresh: "synthetic-new-refresh", expires: Date.now() + 3_600_000 });
const abortError = error => error?.name === "AbortError";
const unexpected = () => { throw new Error("Unexpected synthetic provider invocation"); };
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
async function waitGate(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Synthetic gate watchdog: ${label}`)), 5000); }),
    ]);
  } finally { clearTimeout(timer); }
}
async function fixture(refresh, seed = old) {
  const dir = await fs.mkdtemp(path.join(root, "tmp", "oauth-regression-"));
  const authPath = path.join(dir, "auth.json");
  await fs.writeFile(authPath, JSON.stringify({ [providerId]: seed }), { mode: 0o600 });
  const backend = new FileAuthStorageBackend(authPath);
  const storage = AuthStorage.fromStorage(backend);
  const runtime = await storage.getRuntime();
  let refreshCalls = 0;
  let streamCalls = 0;
  const unexpectedStream = () => { streamCalls++; return unexpected(); };
  runtime.registerNativeProvider({
    id: providerId, name: "Synthetic cancellation fixture", getModels: () => [],
    stream: unexpectedStream, streamSimple: unexpectedStream,
    auth: { oauth: {
      name: "Synthetic OAuth", login: unexpected,
      async refresh(credential, signal) { refreshCalls++; return refresh(credential, signal); },
      async toAuth(credential) { return { apiKey: credential.access }; },
    } },
  });
  return {
    runtime, backend, storage, authPath, calls: () => refreshCalls, dispatches: () => streamCalls,
    // This waits for an active mutation lock to release before observing disk.
    stored: () => backend.withLockAsync(raw => ({ result: JSON.parse(raw)[providerId] })),
  };
}

test("pre-cancelled caller does not refresh or mutate credentials", { timeout: 10_000 }, async () => {
  const f = await fixture(unexpected);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.runtime.getAuth(providerId, { signal: controller.signal }), abortError);
  assert.equal(f.calls(), 0); assert.deepEqual(await f.stored(), old);
});

test("cancel while waiting for file lock does not start rotation", { timeout: 10_000 }, async () => {
  const f = await fixture(unexpected);
  const held = deferred(); const release = deferred();
  const waiting = deferred();
  const controller = new AbortController();
  const withLockAsync = f.backend.withLockAsync.bind(f.backend);
  const holder = f.backend.withLockAsync(async () => { held.resolve(); await release.promise; return { result: undefined }; });
  try {
    await waitGate(held.promise, "file lock acquired");
    f.backend.withLockAsync = (callback, options) => {
      const operation = withLockAsync(callback, options);
      if (options?.signal === controller.signal) waiting.resolve();
      return operation;
    };
    const rejected = assert.rejects(f.runtime.getAuth(providerId, { signal: controller.signal }), abortError);
    void rejected.catch(() => {});
    await waitGate(waiting.promise, "request attempts the held file lock");
    controller.abort();
    await waitGate(rejected, "cancelled lock waiter returns before releasing the lock");
  } finally { f.backend.withLockAsync = withLockAsync; release.resolve(); await holder; }
  assert.equal(f.calls(), 0); assert.deepEqual(await f.stored(), old);
});

test("caller cancel during refresh rejects caller and preserves completed rotation", { timeout: 10_000 }, async () => {
  const started = deferred(); const complete = deferred(); let providerSignal;
  const f = await fixture(async (credential, signal) => {
    assert.deepEqual(credential, old); providerSignal = signal; started.resolve();
    await complete.promise; return rotated();
  });
  try {
    const controller = new AbortController();
    const rejected = assert.rejects(f.runtime.getAuth(providerId, { signal: controller.signal }), abortError);
    void rejected.catch(() => {});
    await waitGate(started.promise, "provider refresh entered"); controller.abort();
    await waitGate(rejected, "cancelled caller returns before the refresh completes");
    assert.equal(controller.signal.aborted, true);
    assert.equal(providerSignal.aborted, false, "rotation timeout must be independent of caller cancellation");
  } finally { complete.resolve(); await f.stored(); }
  assert.equal((await f.stored()).refresh, "synthetic-new-refresh"); assert.equal(f.calls(), 1);
});

test("cancel at callback return before file persistence still commits rotation", { timeout: 10_000 }, async () => {
  const controller = new AbortController();
  const f = await fixture(async () => { controller.abort(); return rotated(); });
  await assert.rejects(f.runtime.getAuth(providerId, { signal: controller.signal }), abortError);
  assert.equal((await f.stored()).refresh, "synthetic-new-refresh"); assert.equal(f.calls(), 1);
});

test("normal refresh persists rotated credential and reuses it", { timeout: 10_000 }, async () => {
  const f = await fixture(async () => rotated());
  const result = await f.runtime.getAuth(providerId);
  assert.equal(result.auth.apiKey, "synthetic-new-access"); assert.equal(f.calls(), 1);
  assert.equal((await f.stored()).refresh, "synthetic-new-refresh");
  const again = await f.runtime.getAuth(providerId);
  assert.equal(again.auth.apiKey, "synthetic-new-access"); assert.equal(f.calls(), 1);
});

// Each independent runtime keeps its own original watchdog, including setup.
test("fresh credential avoids refresh in an independent runtime", { timeout: 10_000 }, async () => {
  const fresh = await fixture(unexpected, rotated());
  assert.equal((await fresh.runtime.getAuth(providerId)).auth.apiKey, "synthetic-new-access"); assert.equal(fresh.calls(), 0);
});

test("provider failure keeps old credential and releases lock for successful retry", { timeout: 10_000 }, async () => {
  let attempts = 0;
  const f = await fixture(async () => { if (++attempts === 1) throw new Error("synthetic provider failure"); return rotated(); });
  await assert.rejects(f.runtime.getAuth(providerId), /OAuth refresh failed/);
  assert.deepEqual(await f.stored(), old);
  assert.equal((await f.runtime.getAuth(providerId)).auth.apiKey, "synthetic-new-access");
  assert.equal(f.calls(), 2); assert.equal((await f.stored()).refresh, "synthetic-new-refresh");
});

test("true official 15s cooperative timeout releases file lock for retry", { timeout: 25_000 }, async () => {
  const originalTimeout = AbortSignal.timeout;
  const durations = [];
  // AbortSignal.timeout is unref'ed by Node; keep the controlled real trial alive.
  const keepAlive = setInterval(() => {}, 1000);
  AbortSignal.timeout = function (milliseconds) { durations.push(milliseconds); return originalTimeout.call(AbortSignal, milliseconds); };
  try {
    let attempts = 0;
    const f = await fixture(async (credential, signal) => {
      if (++attempts > 1) return rotated();
      return await new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        if (signal.aborted) reject(signal.reason);
      });
    });
    const started = performance.now();
    await assert.rejects(f.runtime.getAuth(providerId), /OAuth refresh failed/);
    const elapsed = performance.now() - started;
    assert.ok(durations.includes(15_000), "official timeout duration must stay 15000ms");
    assert.ok(elapsed >= 14_500 && elapsed < 22_000, `real controlled timeout elapsed ${elapsed}ms`);
    assert.deepEqual(await f.stored(), old);
    assert.equal((await f.runtime.getAuth(providerId)).auth.apiKey, "synthetic-new-access");
    assert.equal(f.calls(), 2);
    console.log(JSON.stringify({ trial: "true-cooperative-timeout", elapsedMilliseconds: elapsed, timeoutDurations: durations }));
  } finally { AbortSignal.timeout = originalTimeout; clearInterval(keepAlive); }
});

test("cancelled original stream never reaches model provider although rotation persists", { timeout: 10_000 }, async () => {
  const controller = new AbortController();
  const f = await fixture(async () => { controller.abort(); return rotated(); });
  const model = { provider: providerId, id: "synthetic-model", name: "Synthetic model", api: "openai-completions", baseUrl: "https://synthetic.invalid", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 256 };
  const stream = f.runtime.streamSimple(model, { systemPrompt: "synthetic", messages: [] }, { signal: controller.signal });
  const events = [];
  for await (const event of stream) events.push(event);
  const result = await stream.result();
  assert.equal(controller.signal.aborted, true);
  assert.equal(controller.signal.reason.name, "AbortError");
  // Pi represents an abort during asynchronous auth setup as a setup-error
  // terminal event; this contract is unchanged from 1.0.2's lazyStream.
  assert.equal(result.stopReason, "error");
  assert.equal(result.errorMessage, controller.signal.reason.message);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "error");
  assert.equal(events[0].error, result);
  assert.equal(f.dispatches(), 0);
  assert.equal((await f.stored()).refresh, "synthetic-new-refresh"); assert.equal(f.calls(), 1);
});

after(() => { assert.equal(networkAttempts, 0, "no actual provider network may occur"); });
