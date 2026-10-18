import fs from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { getSessionRunInputState, installRunLifecycleAdapter } from "../lib/pi-sdk/run-lifecycle.ts";
import { SessionCoordinator } from "../core/session-coordinator.ts";

// Published 1.2.0 and 1.3.0 methods are byte-identical; guard checks the installed source.
// This is a source-level regression harness, not installed-SDK integration evidence.
const source = fs.readFileSync(new URL("./fixtures/pi-1.2.0-start-run.txt", import.meta.url), "utf8");
const upstream = new Function(`return ({${source}})._startRun;`)();
const deferred = () => Promise.withResolvers<void>();
function fixture(adapt = true) {
  const release = deferred(), entered = deferred(), idle = deferred();
  const branch: Array<{ id: string; type: string; message?: { role: string } }> = [
    { id: "old-user", type: "message", message: { role: "user" } },
  ];
  const order: string[] = [];
  const session = {
    _startRun: upstream, _isAgentRunActive: false, _agentRunAbortRequested: false,
    _pendingToolNames: new Set(["read"]), _runSystemPromptOptions: undefined,
    sessionManager: { getBranch: () => branch, getEntries: () => branch },
    _prepareRun: vi.fn(async trigger => {
      entered.resolve(); await release.promise;
      session._runSystemPromptOptions = { forceSystemPrompt: "run" };
      return [trigger.messageType];
    }),
    _flushPendingBashMessages: vi.fn(), _flushPendingCustomMessages: vi.fn(),
    _resolveIdleWaitIfIdle: vi.fn(() => { if (!session._isAgentRunActive) idle.resolve(); }),
    _recordSelection: vi.fn(() => order.push("selection")),
    _handlePostAgentRun: vi.fn(async () => false), _runBeforeSettleBoundary: vi.fn(async () => false),
    _finishCancelledRetry: vi.fn(),
    _emitAgentSettled: vi.fn(async () => { session._isAgentRunActive = false; idle.resolve(); }),
    agent: { prompt: vi.fn(async messages => {
      order.push("prompt");
      branch.push(messages[0] === "user"
        ? { id: "new-user", type: "message", message: { role: "user" } }
        : { id: "new-custom", type: "custom_message" });
      expect(getSessionRunInputState(session)).toBe(adapt ? "persisted" : undefined);
    }), continue: vi.fn() },
    abort: vi.fn(() => { session._agentRunAbortRequested = true; return idle.promise; }),
    get isStreaming() { return session._isAgentRunActive; },
    dispose: vi.fn(),
  };
  if (adapt) installRunLifecycleAdapter(session, "1.3.0");
  return { session, release, entered, idle, branch, order };
}

describe("source-bound Pi 1.3.0 startup cleanup", () => {
  it("pins the published method and demonstrates the upstream failure", async () => {
    expect(createHash("sha256").update(source).digest("hex"))
      .toBe("39279b7a97daff07835880131a5fdf7340ef5d7de5960639039f8ed791549afa");
    const f = fixture(false), error = new DOMException("cancelled", "AbortError");
    const run = f.session._startRun({ messageType: "user" }, () => { throw error; });
    const rejected = expect(run).rejects.toBe(error);
    f.release.resolve(); await rejected;
    expect(f.session._isAgentRunActive).toBe(true);
    expect(f.session._resolveIdleWaitIfIdle).not.toHaveBeenCalled();
    expect(f.session.agent.prompt).not.toHaveBeenCalled();
  });

  it.each([new DOMException("cancelled", "AbortError"), new Error("preflight failed")])(
    "preserves %s, releases idle and never replays input", async error => {
      const f = fixture(), callback = vi.fn(() => { throw error; });
      const run = f.session._startRun({ messageType: "user" }, callback);
      const rejected = expect(run).rejects.toBe(error);
      await f.entered.promise;
      expect(getSessionRunInputState(f.session)).toBe("pending");
      f.release.resolve(); await rejected; await f.idle.promise;
      expect(callback).toHaveBeenCalledTimes(1);
      expect(f.session._prepareRun).toHaveBeenCalledTimes(1);
      expect(f.session.agent.prompt).not.toHaveBeenCalled();
      expect(f.branch).toHaveLength(1);
      expect(f.session._isAgentRunActive).toBe(false);
      expect(f.session._runSystemPromptOptions).toBeUndefined();
      expect(getSessionRunInputState(f.session)).toBeUndefined();
      await f.session._startRun({ messageType: "user" });
      expect(f.session.agent.prompt).toHaveBeenCalledTimes(1);
    });

  it.each(["user", "custom"])("fences a late %s hook after abort without self-idle deadlock", async messageType => {
    const f = fixture(), callback = vi.fn();
    const run = f.session._startRun({ messageType }, callback);
    const rejected = expect(run).rejects.toMatchObject({ name: "AbortError" });
    await f.entered.promise;
    let stopped = false;
    const aborting = f.session.abort().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false); // A hung hook is not forcibly interrupted.
    expect(getSessionRunInputState(f.session)).toBe("pending");
    f.release.resolve(); await rejected; await aborting;
    expect(callback).not.toHaveBeenCalled();
    expect(f.session.agent.prompt).not.toHaveBeenCalled();
    expect(f.branch).toHaveLength(1);
  });

  it.each(["user", "custom"])("runs successful %s input and selection exactly once", async messageType => {
    const f = fixture(); f.release.resolve();
    await f.session._startRun({ messageType }, () => f.order.push("accepted"));
    expect(f.order).toEqual(["accepted", "selection", "prompt"]);
    expect(f.session._emitAgentSettled).toHaveBeenCalledTimes(1);
    expect(f.session.agent.continue).not.toHaveBeenCalled();
    expect(f.branch).toHaveLength(2);
    expect(f.session._isAgentRunActive).toBe(false);
  });

  it("leaves 1.0.3 unchanged and rejects unknown lifecycle shapes", () => {
    const f = fixture(false);
    expect(installRunLifecycleAdapter(f.session, "1.0.3")).toBe(false);
    expect(f.session._startRun).toBe(upstream);
    expect(() => installRunLifecycleAdapter(f.session, "1.2.1")).toThrow(/Unreviewed/);
    expect(() => installRunLifecycleAdapter({}, "1.2.0")).toThrow(/missing _startRun/);
  });

  it("does not replay queued persistence when a startup flush throws", async () => {
    const f = fixture(), error = new Error("queued persistence failed");
    f.session._flushPendingBashMessages.mockImplementation(() => { throw error; });
    f.release.resolve();
    await expect(f.session._startRun({ messageType: "user" })).rejects.toBe(error);
    await f.idle.promise;
    expect(f.session._flushPendingBashMessages).toHaveBeenCalledTimes(1);
    expect(f.session.agent.prompt).not.toHaveBeenCalled();
  });

  it.each(["user", "custom"])("coordinator stop never binds a pending %s to the previous turn", async kind => {
    const f = fixture(), emitEvent = vi.fn(), file = "/tmp/hana-fixture-pending.jsonl";
    const coordinator = new SessionCoordinator({ memoryPressure: { enabled: false }, emitEvent });
    const owner = new AbortController();
    const entry = { session: f.session, agentId: "fixture", _sdkPromptOwner: owner };
    coordinator._sessions.set(file, entry);
    if (kind === "user") coordinator._prePromptAbortControllers.set(file, owner);
    const running = f.session._startRun({ messageType: kind });
    const rejected = expect(running).rejects.toMatchObject({ name: "AbortError" });
    await f.entered.promise;
    await expect(coordinator.abortSession(file)).resolves.toBe(true);
    expect(emitEvent.mock.calls.some(([event]) => event.type === "turn_end")).toBe(false);
    expect(emitEvent.mock.calls.some(([event]) => event.type === "session_status" && event.aborted)).toBe(true);
    expect(coordinator._sessions.has(file)).toBe(false);
    f.release.resolve(); await rejected; await f.idle.promise;
    expect(f.branch).toHaveLength(1);
  });

  it("coordinator stop still binds a newly persisted input", async () => {
    const f = fixture(), entered = deferred(), release = deferred(), emitEvent = vi.fn();
    const file = "/tmp/hana-fixture-persisted.jsonl";
    const prompt = f.session.agent.prompt;
    f.session.agent.prompt = vi.fn(async messages => { await prompt(messages); entered.resolve(); await release.promise; });
    const coordinator = new SessionCoordinator({ memoryPressure: { enabled: false }, emitEvent });
    coordinator._sessions.set(file, { session: f.session, agentId: "fixture" });
    f.release.resolve();
    const running = f.session._startRun({ messageType: "user" });
    await entered.promise;
    await coordinator.abortSession(file);
    expect(emitEvent.mock.calls.filter(([event]) => event.type === "turn_end")).toHaveLength(1);
    release.resolve(); await running;
  });
});
