/** OAuth concurrency regression. Never contacts a real OAuth provider.
 * The Vitest wrapper supplies an isolated HOME and credential directory.
 * Imports Hana's public facade so tests reach its actual nested SDK instance.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fork } from "node:child_process";
import { setImmediate as nextTurn } from "node:timers/promises";

const self = fileURLToPath(import.meta.url);
const root = process.env.HANA_OAUTH_FIXTURE_ROOT;
if (!root) throw new Error("HANA_OAUTH_FIXTURE_ROOT must point to an isolated test directory");
let networkAttempts = 0;
globalThis.fetch = async () => {
  networkAttempts += 1;
  throw new Error("Synthetic regression harness refuses every network fetch");
};
const { AuthStorage, FileAuthStorageBackend } = await import("../../lib/pi-sdk/index.ts");
const unexpected = () => { throw new Error("Unexpected login or model request in synthetic regression"); };
const oldCredential = () => ({ type: "oauth", access: "synthetic-old-access", refresh: "synthetic-old-refresh", expires: 1 });
const newCredential = () => ({ type: "oauth", access: "synthetic-new-access", refresh: "synthetic-new-refresh", expires: Date.now() + 3_600_000 });
const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};
async function bounded(promise, label, milliseconds = 25_000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}
async function fixture(label) {
  await fs.mkdir(path.join(root, "tmp"), { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, "tmp", `${label}-`));
  const authPath = path.join(dir, "auth.json");
  const providerId = `synthetic-${label}`;
  const old = oldCredential();
  const rotated = newCredential();
  await fs.writeFile(authPath, JSON.stringify({ [providerId]: old }, null, 2), { mode: 0o600 });
  return { label, dir, authPath, providerId, old, rotated };
}
async function openRuntime(authPath) {
  const backend = new FileAuthStorageBackend(authPath);
  const storage = AuthStorage.fromStorage(backend);
  const runtime = await storage.getRuntime();
  return { backend, storage, runtime };
}
function provider(id, refresh, additional = {}) {
  return {
    id, name: "Synthetic rotation regression provider", getModels: () => [],
    stream: unexpected, streamSimple: unexpected,
    auth: { oauth: { name: "Synthetic OAuth", login: unexpected, refresh,
      async toAuth(credential) { return { apiKey: credential.access }; },
    } }, ...additional,
  };
}
const capture = promise => promise.then(value => ({ value }), error => ({ error }));
function assertCancelled(result, label) {
  assert.equal(result.error?.name, "AbortError", `${label}: caller must still reject with AbortError`);
  assert.equal(result.value, undefined, `${label}: cancelled caller must not resolve auth`);
}
async function assertPersistence(f) {
  // Reopen an actual file-backed store and take its public lock without the
  // cancelled request signal. This also waits for in-flight credential writes.
  const settledBackend = new FileAuthStorageBackend(f.authPath);
  const stored = await settledBackend.withLockAsync(raw => ({ result: JSON.parse(raw)[f.providerId] }));
  const reopened = await openRuntime(f.authPath);
  assert.deepEqual(stored, f.rotated, `${f.label}: exact rotation must survive reopening storage`);
  let unexpectedRefreshes = 0;
  reopened.runtime.registerNativeProvider(provider(f.providerId, () => {
    unexpectedRefreshes += 1;
    throw new Error("Reopened valid rotation must not refresh again");
  }));
  const resolution = await reopened.runtime.getAuth(f.providerId);
  assert.equal(resolution?.auth.apiKey, f.rotated.access);
  assert.equal(unexpectedRefreshes, 0);
  return { reopenedAccess: resolution.auth.apiKey, unexpectedRefreshes };
}
async function settleStore(authPath) {
  const backend = new FileAuthStorageBackend(authPath);
  await bounded(backend.withLockAsync(() => ({ result: undefined })), "file-backed store settles");
}
async function concurrentCallers() {
  const f = await fixture("two-callers");
  const owner = await openRuntime(f.authPath);
  const waiter = await openRuntime(f.authPath);
  const entered = deferred();
  const release = deferred();
  const controller = new AbortController();
  let refreshCalls = 0;
  let refreshSignalAborted;
  const refresh = async (current, signal) => {
    refreshCalls += 1;
    assert.deepEqual(current, f.old);
    assert.equal(signal.aborted, false);
    entered.resolve();
    await release.promise;
    controller.abort();
    assert.equal(controller.signal.aborted, true);
    refreshSignalAborted = signal.aborted;
    assert.equal(refreshSignalAborted, false, "OAuth refresh timeout must be independent of caller cancellation");
    return f.rotated;
  };
  owner.runtime.registerNativeProvider(provider(f.providerId, refresh));
  waiter.runtime.registerNativeProvider(provider(f.providerId, refresh));
  try {
    const cancelled = capture(owner.runtime.getAuth(f.providerId, { signal: controller.signal }));
    await bounded(entered.promise, "same-process refresh entered");
    const survivor = capture(waiter.runtime.getAuth(f.providerId));
    await nextTurn();
    release.resolve();
    const [a, b] = await bounded(Promise.all([cancelled, survivor]), "same-process callers finish");
    assertCancelled(a, f.label);
    assert.equal(b.error, undefined);
    assert.equal(b.value?.auth.apiKey, f.rotated.access);
    assert.equal(refreshCalls, 1, "Only one synthetic refresh may consume the expired refresh token");
    const persistence = await assertPersistence(f);
    return { scenario: f.label, refreshCalls, callerSignalAborted: controller.signal.aborted,
      refreshSignalAborted, survivorAccess: b.value.auth.apiKey, ...persistence };
  } finally {
    release.resolve();
    await settleStore(f.authPath);
  }
}
function childChannel(child) {
  const queued = [];
  const pending = [];
  let failure;
  const fail = error => {
    failure = error;
    while (pending.length) pending.shift().reject(error);
  };
  child.on("error", fail);
  child.on("message", message => {
    if (message.type === "failure") return fail(new Error(message.error));
    const index = pending.findIndex(waiter => waiter.type === message.type);
    if (index >= 0) pending.splice(index, 1)[0].resolve(message);
    else queued.push(message);
  });
  child.on("exit", (code, signal) => {
    if (code !== 0 || pending.length) fail(new Error(`Synthetic child exited: code=${code} signal=${signal}`));
  });
  return {
    wait(type) {
      if (failure) return Promise.reject(failure);
      const index = queued.findIndex(message => message.type === type);
      if (index >= 0) return Promise.resolve(queued.splice(index, 1)[0]);
      return new Promise((resolve, reject) => pending.push({ type, resolve, reject }));
    },
    send(type) { child.send({ type }); },
  };
}
async function processWorker(role, serialized) {
  const f = JSON.parse(serialized);
  const controller = new AbortController();
  const commands = new Map();
  const command = type => {
    if (!commands.has(type)) commands.set(type, deferred());
    return commands.get(type).promise;
  };
  process.on("message", message => {
    if (!commands.has(message.type)) commands.set(message.type, deferred());
    commands.get(message.type).resolve();
  });
  const send = message => process.send(message);
  const { runtime, backend } = await openRuntime(f.authPath);
  let refreshCalls = 0;
  let refreshSignalAborted;
  if (role === "cold-reopen") {
    runtime.registerNativeProvider(provider(f.providerId, () => {
      refreshCalls += 1;
      throw new Error("Fresh OS process must reuse persisted valid credentials without rotation");
    }));
    const resolution = await runtime.getAuth(f.providerId);
    const reopenedBackend = new FileAuthStorageBackend(f.authPath);
    const stored = await bounded(reopenedBackend.withLockAsync(raw => ({ result: JSON.parse(raw)[f.providerId] })), "cold process reads settled file");
    assert.deepEqual(stored, f.rotated);
    assert.equal(resolution?.auth.apiKey, f.rotated.access);
    assert.equal(refreshCalls, 0);
    assert.equal(networkAttempts, 0);
    send({ type: "finished", role, pid: process.pid, refreshCalls, callerAccess: resolution.auth.apiKey, networkAttempts });
    process.disconnect();
    return;
  }
  runtime.registerNativeProvider(provider(f.providerId, async (current, signal) => {
    refreshCalls += 1;
    assert.deepEqual(current, f.old);
    assert.equal(signal.aborted, false);
    // A synthetic token server's one-use marker detects a second refresh even
    // across OS processes, independently of each process's in-memory counters.
    const claim = await fs.open(path.join(f.dir, "refresh-token-consumed"), "wx", 0o600);
    try { await claim.writeFile(String(process.pid)); }
    finally { await claim.close(); }
    await fs.appendFile(path.join(f.dir, "rotations.jsonl"), JSON.stringify({ pid: process.pid, role }) + "\n");
    send({ type: "refresh-entered", role });
    assert.equal(role, "owner", "Waiting process must reuse the first process's committed rotation");
    await command("release");
    controller.abort();
    assert.equal(controller.signal.aborted, true);
    refreshSignalAborted = signal.aborted;
    assert.equal(refreshSignalAborted, false, "Refresh signal must survive request cancellation");
    return f.rotated;
  }));
  let report;
  try {
    send({ type: "ready", role });
    await command("start");
    const withLockAsync = backend.withLockAsync.bind(backend);
    let reportedLockAttempt = false;
    backend.withLockAsync = (callback, options) => {
      const operation = withLockAsync(callback, options);
      if (role === "waiter" && options?.signal === controller.signal && !reportedLockAttempt) {
        reportedLockAttempt = true;
        send({ type: "request-waiting-lock", role });
      }
      return operation;
    };
    const operation = capture(runtime.getAuth(f.providerId, { signal: controller.signal }));
    send({ type: "request-started", role });
    const result = await bounded(operation, `${role} process getAuth`);
    await settleStore(f.authPath);
    if (role === "owner") assertCancelled(result, "two-process owner");
    else {
      assert.equal(result.error, undefined);
      assert.equal(result.value?.auth.apiKey, f.rotated.access);
      assert.equal(refreshCalls, 0);
    }
    assert.equal(networkAttempts, 0);
    report = { type: "finished", role, pid: process.pid, refreshCalls, refreshSignalAborted,
      callerSignalAborted: controller.signal.aborted, callerError: result.error?.name,
      callerAccess: result.value?.auth.apiKey, networkAttempts };
  } finally {
    if (!commands.has("release")) commands.set("release", deferred());
    commands.get("release").resolve();
    await settleStore(f.authPath);
  }
  send(report);
  process.disconnect();
}
async function concurrentProcesses() {
  const f = await fixture("two-processes");
  const children = ["owner", "waiter"].map(role => fork(self, ["--worker", role, JSON.stringify(f)], {
    env: process.env, execArgv: process.execArgv, stdio: ["ignore", "pipe", "pipe", "ipc"],
  }));
  // Drain output, retain diagnostics without exposing any real credential.
  const diagnostics = children.map(() => "");
  children.forEach((child, index) => {
    child.stdout.on("data", data => { diagnostics[index] += data; });
    child.stderr.on("data", data => { diagnostics[index] += data; });
  });
  const [owner, waiter] = children.map(childChannel);
  try {
    await bounded(Promise.all([owner.wait("ready"), waiter.wait("ready")]), "both OS processes ready");
    owner.send("start");
    await bounded(owner.wait("refresh-entered"), "owner has file lock and consumed old synthetic token");
    waiter.send("start");
    await bounded(waiter.wait("request-waiting-lock"), "waiter attempts the file lock still held by owner");
    owner.send("release");
    const results = await bounded(Promise.all([owner.wait("finished"), waiter.wait("finished")]), "two OS processes finish");
    assert.notEqual(results[0].pid, results[1].pid);
    assert.equal(results.reduce((sum, result) => sum + result.refreshCalls, 0), 1);
    assert.equal(results[0].callerError, "AbortError");
    assert.equal(results[0].callerSignalAborted, true);
    assert.equal(results[0].refreshSignalAborted, false);
    assert.equal(results[1].callerAccess, f.rotated.access);
    const rotations = (await fs.readFile(path.join(f.dir, "rotations.jsonl"), "utf8")).trim().split("\n");
    assert.equal(rotations.length, 1);
    const persistence = await assertPersistence(f);
    // Original contenders fully exit before a genuinely fresh process loads
    // this persisted credential through Hana's facade. Same-process reopen
    // above remains a separate, narrower assertion.
    const waitForExit = child => child.exitCode !== null
      ? Promise.resolve(child.exitCode)
      : new Promise((resolve, reject) => {
        child.once("exit", (code, signal) => signal ? reject(new Error(`Unexpected worker signal ${signal}`)) : resolve(code));
        child.once("error", reject);
      });
    const exited = await bounded(Promise.all(children.map(waitForExit)), "original OAuth contenders fully exit");
    assert.deepEqual(exited, [0, 0]);
    const coldChild = fork(self, ["--worker", "cold-reopen", JSON.stringify(f)], {
      env: process.env, execArgv: process.execArgv, stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    const coldChannel = childChannel(coldChild);
    coldChild.stdout.resume(); coldChild.stderr.resume();
    let coldRestart;
    try {
      coldRestart = await bounded(coldChannel.wait("finished"), "fresh OS process reads persisted rotation");
      assert.ok(results.every(result => result.pid !== coldRestart.pid));
      assert.equal(coldRestart.refreshCalls, 0);
      assert.equal(coldRestart.callerAccess, f.rotated.access);
      assert.equal(await bounded(waitForExit(coldChild), "fresh OS process exits"), 0);
    } finally { if (coldChild.exitCode === null) coldChild.kill(); }
    return { scenario: f.label, successfulRotations: rotations.length, processes: results, coldRestart, ...persistence };
  } catch (error) {
    error.message += `\nChild diagnostics: ${JSON.stringify(diagnostics)}`;
    throw error;
  } finally {
    // Release an owner gate before terminating children, so ordinary failures
    // do not intentionally abandon an auth.json lock held by the fixture.
    children.forEach(child => { if (child.connected) child.send({ type: "release" }); });
    try { await settleStore(f.authPath); }
    finally { children.forEach(child => { if (child.exitCode === null) child.kill(); }); }
  }
}
function syntheticModel(providerId, id) {
  return { id, name: id, provider: providerId, api: "openai-completions", reasoning: false,
    input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 };
}
async function prepareDynamic(f, refresh, refreshModels, getModels, onOffline = () => {}) {
  const { runtime } = await openRuntime(f.authPath);
  const initialOffline = deferred();
  runtime.registerNativeProvider(provider(f.providerId, refresh, {
    getModels,
    async refreshModels(context) {
      if (!context.allowNetwork) { onOffline(context); initialOffline.resolve(); return; }
      return refreshModels(context);
    },
  }));
  // Registration schedules an offline refresh. Let that first phase start,
  // then explicitly settle a later offline generation before the scenario.
  await bounded(initialOffline.promise, "provider registration offline phase");
  await runtime.refresh({ providers: [f.providerId], allowNetwork: false });
  return runtime;
}
async function modelRotation(kind) {
  const f = await fixture(`model-${kind}`);
  const controller = new AbortController();
  const entered = deferred();
  const release = deferred();
  const superseded = deferred();
  let refreshCalls = 0;
  let refreshSignalAborted;
  let latestPhaseSignal;
  let rotatingPhaseSignal;
  let models = [];
  let networkModelCalls = 0;
  const runtime = await prepareDynamic(f, async (current, refreshSignal) => {
    refreshCalls += 1;
    assert.deepEqual(current, f.old);
    assert.equal(refreshSignal.aborted, false);
    rotatingPhaseSignal = latestPhaseSignal;
    assert.ok(rotatingPhaseSignal, "Capture original catalog phase signal before OAuth refresh");
    assert.equal(rotatingPhaseSignal.aborted, false);
    rotatingPhaseSignal.addEventListener("abort", () => superseded.resolve(), { once: true });
    entered.resolve();
    await release.promise;
    if (kind === "cancel") controller.abort();
    assert.equal(rotatingPhaseSignal.aborted, true, "Original catalog phase must still abort");
    refreshSignalAborted = refreshSignal.aborted;
    assert.equal(refreshSignalAborted, false, "OAuth timeout signal must survive catalog cancellation or supersession");
    return f.rotated;
  }, async context => {
    networkModelCalls += 1;
    assert.equal(context.signal.aborted, false);
    assert.deepEqual(context.credential, f.rotated);
    const latest = [syntheticModel(f.providerId, "synthetic-latest-model")];
    assert.equal(await context.publish({ update: () => { models = latest; } }), true);
  }, () => models, context => { latestPhaseSignal = context.signal; });
  try {
    const first = runtime.refresh({ providers: [f.providerId], allowNetwork: true, signal: controller.signal });
    await bounded(entered.promise, "model-list OAuth rotation entered");
    let second;
    if (kind === "supersede") {
      second = runtime.refresh({ providers: [f.providerId], allowNetwork: true });
      await bounded(superseded.promise, "new generation aborts original catalog phase");
      assert.equal(controller.signal.aborted, false, "Supersession must be runtime-owned");
    }
    release.resolve();
    const firstResult = await bounded(first, "cancelled/superseded model-list caller finishes");
    if (kind === "cancel") {
      assert.equal(controller.signal.aborted, true);
      assert.equal(firstResult.aborted, true);
      assert.equal(networkModelCalls, 0, "Cancelled catalog operation must not publish or fetch models");
      await assertPersistence(f);
      second = runtime.refresh({ providers: [f.providerId], allowNetwork: true });
    }
    const secondResult = await bounded(second, "surviving model-list refresh finishes");
    assert.equal(secondResult.aborted, false);
    assert.equal(secondResult.errors.size, 0);
    assert.equal(refreshCalls, 1);
    assert.equal(networkModelCalls, 1);
    assert.deepEqual(runtime.getModels(f.providerId).map(model => model.id), ["synthetic-latest-model"]);
    const persistence = await assertPersistence(f);
    return { scenario: f.label, refreshCalls, callerSignalAborted: controller.signal.aborted,
      modelPhaseSignalAborted: rotatingPhaseSignal.aborted, refreshSignalAborted, networkModelCalls,
      firstAborted: firstResult.aborted, latestModels: runtime.getModels(f.providerId).map(model => model.id), ...persistence };
  } finally {
    release.resolve();
    await settleStore(f.authPath);
  }
}

async function staleCatalogPublication() {
  const f = await fixture("catalog-supersession");
  // This case isolates catalog cancellation from credential rotation.
  await fs.writeFile(f.authPath, JSON.stringify({ [f.providerId]: f.rotated }), { mode: 0o600 });
  const entered = deferred();
  const release = deferred();
  const oldWorkFinished = deferred();
  let oldWorkStarted = false;
  let models = [];
  let networkModelCalls = 0;
  let staleUpdateCalls = 0;
  let stalePublication;
  let originalSignalAborted = false;
  const runtime = await prepareDynamic(f, unexpected, async context => {
    const call = ++networkModelCalls;
    assert.deepEqual(context.credential, f.rotated);
    if (call === 1) {
      oldWorkStarted = true;
      entered.resolve();
      await release.promise;
      originalSignalAborted = context.signal.aborted;
      try {
        stalePublication = await capture(context.publish({ update: () => {
          staleUpdateCalls += 1;
          models = [syntheticModel(f.providerId, "synthetic-stale-model")];
        } }));
      } finally { oldWorkFinished.resolve(); }
      return;
    }
    assert.equal(call, 2);
    assert.equal(context.signal.aborted, false);
    assert.equal(await context.publish({ update: () => {
      models = [syntheticModel(f.providerId, "synthetic-latest-model")];
    } }), true);
  }, () => models);
  try {
    const first = runtime.refresh({ providers: [f.providerId], allowNetwork: true });
    await bounded(entered.promise, "older catalog operation entered");
    const second = await bounded(runtime.refresh({ providers: [f.providerId], allowNetwork: true }), "new catalog generation publishes");
    release.resolve();
    await bounded(Promise.all([first, oldWorkFinished.promise]), "old catalog completion cannot overwrite newer catalog");
    assert.equal(originalSignalAborted, true);
    assert.equal(second.aborted, false);
    assert.equal(second.errors.size, 0);
    assert.equal(staleUpdateCalls, 0);
    assert.ok(stalePublication.value === false || stalePublication.error?.name === "AbortError",
      "A superseded publication must be declined or reject with AbortError");
    assert.deepEqual(runtime.getModels(f.providerId).map(model => model.id), ["synthetic-latest-model"]);
    const persistence = await assertPersistence(f);
    return { scenario: f.label, networkModelCalls, originalSignalAborted, staleUpdateCalls,
      stalePublication: stalePublication.error?.name ?? stalePublication.value,
      latestModels: runtime.getModels(f.providerId).map(model => model.id), ...persistence };
  } finally {
    release.resolve();
    if (oldWorkStarted) await bounded(oldWorkFinished.promise, "released stale catalog work settles");
    await settleStore(f.authPath);
  }
}

if (process.argv[2] === "--worker") {
  const watchdog = setTimeout(() => { console.error("Synthetic worker watchdog expired"); process.exit(1); }, 60_000);
  try { await processWorker(process.argv[3], process.argv[4]); }
  catch (error) {
    process.send?.({ type: "failure", error: error.stack ?? String(error) });
    process.exitCode = 1;
    if (process.connected) process.disconnect();
  } finally { clearTimeout(watchdog); }
} else {
  const observations = [];
  for (const scenario of [concurrentCallers, concurrentProcesses,
    () => modelRotation("cancel"), () => modelRotation("supersede"), staleCatalogPublication]) {
    const watchdog = setTimeout(() => { console.error("Synthetic regression case watchdog expired"); process.exit(1); }, 60_000);
    try {
      const observation = await scenario();
      observations.push(observation);
      console.log(JSON.stringify(observation));
    } finally { clearTimeout(watchdog); }
  }
  assert.equal(networkAttempts, 0);
  const evidence = { purpose: "Repaired-code synthetic concurrency and catalog regression gate", passed: true,
    networkAttempts, syntheticCredentialsOnly: true, observations };
  await fs.mkdir(path.join(root, "evidence"), { recursive: true });
  await fs.writeFile(path.join(root, "evidence", "concurrent-oauth-regression.json"), JSON.stringify(evidence, null, 2) + "\n");
  console.log(JSON.stringify({ passed: true, scenarios: observations.length, networkAttempts }));
}
