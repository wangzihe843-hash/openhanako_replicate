import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getSessionRunInputState, installRunLifecycleAdapter } from "../lib/pi-sdk/run-lifecycle.ts";
import { AuthStorage, FileAuthStorageBackend } from "../lib/pi-sdk/model-runtime.ts";
import { getPiCodingAgentVersion } from "../lib/pi-sdk/session-options.ts";

const source = fs.readFileSync(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js", import.meta.url), "utf8");
const start = source.indexOf("    async _startRun(trigger, onStarted) {");
const end = source.indexOf("    /**", start);
const method = source.slice(start, end);
// Source-level control from the installed release. Real AgentSession integration
// remains in pi-sdk-runtime-integration.test.ts, with no provider network calls.
const originalStartRun = new Function(`return ({${method}})._startRun;`)();
const piRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const lockFs: typeof fs = createRequire(piRequire.resolve("proper-lockfile"))("graceful-fs");
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  Object.defineProperty(process, "platform", platform);
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function lifecycleFixture(adapt = true) {
  const release = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>(), idle = Promise.withResolvers<void>();
  const entries = [{ id: "previous-user", type: "message", message: { role: "user" } }];
  const session = {
    _startRun: originalStartRun, _isAgentRunActive: false, _agentRunAbortRequested: false,
    _runSystemPromptOptions: undefined, _pendingToolNames: new Set(["read"]),
    sessionManager: { getEntries: () => entries, getBranch: () => entries },
    _prepareRun: vi.fn(async () => {
      entered.resolve(); await release.promise;
      session._runSystemPromptOptions = { forceSystemPrompt: "temporary" };
      return [];
    }),
    _flushPendingBashMessages: vi.fn(), _flushPendingCustomMessages: vi.fn(),
    _resolveIdleWaitIfIdle: vi.fn(() => { if (!session._isAgentRunActive) idle.resolve(); }),
    _recordSelection: vi.fn(), _handlePostAgentRun: vi.fn(async () => false),
    _runBeforeSettleBoundary: vi.fn(async () => false), _finishCancelledRetry: vi.fn(),
    _emitAgentSettled: vi.fn(async () => { session._isAgentRunActive = false; idle.resolve(); }),
    agent: { prompt: vi.fn(async () => {}), continue: vi.fn(async () => {}) },
    abort: vi.fn(() => { session._agentRunAbortRequested = true; return idle.promise; }),
  };
  if (adapt) installRunLifecycleAdapter(session, "1.4.0");
  return { session, release, entered, idle, entries };
}

function authFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-pi14-auth-")); dirs.push(dir);
  const file = path.join(dir, "auth.json");
  fs.writeFileSync(file, '{"fixture":{"type":"api_key","key":"public-fixture"}}');
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  const error = Object.assign(new Error("synthetic acquisition failure"), {
    code: "EPERM", syscall: "mkdir", path: file + ".lock",
  });
  const backend = new FileAuthStorageBackend(file);
  return { file, error, backend, storage: AuthStorage.fromStorage(backend) };
}

function denyMkdir(error: Error) {
  return vi.spyOn(lockFs, "mkdir").mockImplementation((...args: Parameters<typeof fs.mkdir>) => {
    queueMicrotask(() => (args.at(-1) as fs.NoParamCallback)(error));
  });
}

describe("formal Pi 1.4.0 lifecycle and auth boundaries", () => {
  it("requires the formal installed release and reviewed lifecycle bytes", () => {
    expect(getPiCodingAgentVersion()).toBe("1.4.0");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(createHash("sha256").update(method).digest("hex"))
      .toBe("39279b7a97daff07835880131a5fdf7340ef5d7de5960639039f8ed791549afa");
  });

  it("reproduces the formal upstream callback failure leaving the session busy", async () => {
    const f = lifecycleFixture(false), error = new Error("onStarted failure");
    const running = f.session._startRun({ messageType: "user" }, () => { throw error; });
    const rejected = expect(running).rejects.toBe(error);
    f.release.resolve(); await rejected;
    expect(f.session._isAgentRunActive).toBe(true);
    expect(f.session._resolveIdleWaitIfIdle).not.toHaveBeenCalled();
    expect(f.session.agent.prompt).not.toHaveBeenCalled();
  });

  it.each(["callback", "selection"])("cleans a %s failure once and permits the next input", async stage => {
    const f = lifecycleFixture(), error = new Error(`${stage} failure`);
    const callback = vi.fn(() => { if (stage === "callback") throw error; });
    if (stage === "selection") f.session._recordSelection.mockImplementationOnce(() => { throw error; });
    const running = f.session._startRun({ messageType: "user" }, callback);
    const rejected = expect(running).rejects.toBe(error);
    f.release.resolve(); await rejected; await f.idle.promise;
    expect(callback).toHaveBeenCalledTimes(1);
    expect(f.session._prepareRun).toHaveBeenCalledTimes(1);
    expect(f.session.agent.prompt).not.toHaveBeenCalled();
    expect(f.session._isAgentRunActive).toBe(false);
    expect(f.session._runSystemPromptOptions).toBeUndefined();
    expect(f.entries).toHaveLength(1);
    expect(getSessionRunInputState(f.session)).toBeUndefined();
    await f.session._startRun({ messageType: "user" });
    expect(f.session.agent.prompt).toHaveBeenCalledTimes(1);
  });

  it.each(["user", "custom"])("does not persist late %s input after a suspended hook abort", async kind => {
    const f = lifecycleFixture(), callback = vi.fn();
    const running = f.session._startRun({ messageType: kind }, callback);
    const rejected = expect(running).rejects.toMatchObject({ name: "AbortError" });
    await f.entered.promise;
    let idle = false;
    const aborted = f.session.abort().then(() => { idle = true; });
    await Promise.resolve();
    expect(idle).toBe(false);
    expect(getSessionRunInputState(f.session)).toBe("pending");
    f.release.resolve(); await rejected; await aborted;
    expect(callback).not.toHaveBeenCalled();
    expect(f.session.agent.prompt).not.toHaveBeenCalled();
    expect(f.entries).toHaveLength(1);
  });

  it("fences abort requested synchronously by onStarted before recording selection or prompting", async () => {
    const f = lifecycleFixture();
    const running = f.session._startRun({ messageType: "user" }, () => { void f.session.abort(); });
    const rejected = expect(running).rejects.toMatchObject({ name: "AbortError" });
    f.release.resolve(); await rejected; await f.idle.promise;
    expect(f.session._recordSelection).not.toHaveBeenCalled();
    expect(f.session.agent.prompt).not.toHaveBeenCalled();
    expect(f.session._isAgentRunActive).toBe(false);
  });

  it("rejects a concurrent startup without releasing or replacing the first busy run", async () => {
    const f = lifecycleFixture();
    const running = f.session._startRun({ messageType: "user" });
    await f.entered.promise;
    await expect(f.session._startRun({ messageType: "custom" })).rejects.toThrow("already active");
    expect(f.session._isAgentRunActive).toBe(true);
    expect(getSessionRunInputState(f.session)).toBe("pending");
    expect(f.session._prepareRun).toHaveBeenCalledTimes(1);
    f.release.resolve(); await running;
    expect(f.session.agent.prompt).toHaveBeenCalledTimes(1);
    expect(getSessionRunInputState(f.session)).toBeUndefined();
  });

  it("retains ten native synchronous and six native asynchronous acquisition attempts without 6x6", async () => {
    const f = authFixture(), callback = vi.fn();
    const sync = vi.spyOn(lockFs, "mkdirSync").mockImplementation(() => { throw f.error; });
    expect(() => f.backend.withLock(callback)).toThrow(f.error);
    expect(sync).toHaveBeenCalledTimes(10);
    expect(callback).not.toHaveBeenCalled();
    sync.mockRestore();
    const mkdir = denyMkdir(f.error), lock = vi.spyOn(f.backend, "withLockAsync");
    await expect(f.storage.get("fixture")).rejects.toBe(f.error);
    expect(lock).toHaveBeenCalledTimes(1);
    expect(mkdir).toHaveBeenCalledTimes(6);
    expect(JSON.parse(fs.readFileSync(f.file, "utf8")).fixture.key).toBe("public-fixture");
  });

  it.each(["EACCES", "EIO"])("does not retry native non-EPERM %s acquisition failures", async code => {
    const f = authFixture(); f.error.code = code;
    const mkdir = denyMkdir(f.error), lock = vi.spyOn(f.backend, "withLockAsync");
    await expect(f.storage.get("fixture")).rejects.toBe(f.error);
    expect(lock).toHaveBeenCalledTimes(1);
    expect(mkdir).toHaveBeenCalledTimes(1);
  });

  it("does not replay a post-acquisition callback error even if it resembles lock EPERM", async () => {
    const f = authFixture(), withLock = f.backend.withLockAsync.bind(f.backend);
    const lock = vi.spyOn(f.backend, "withLockAsync").mockImplementation((fn, options) => withLock(async current => {
      await fn(current); throw f.error;
    }, options));
    await expect(f.storage.get("fixture")).rejects.toBe(f.error);
    expect(lock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fs.readFileSync(f.file, "utf8")).fixture.key).toBe("public-fixture");
  });
});
