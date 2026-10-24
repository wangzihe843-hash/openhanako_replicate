/**
 * Pi 1.2.0/1.3.0/1.4.0 _startRun compatibility boundary.
 * Reviewed 1.4.0 tag: 4a080252f06caf63a525d7873c5d94d3c23887e0; same method digest.
 * Keep the reviewed run loop, but include onStarted/selection in its existing
 * startup failure path. Upstream calls onStarted outside both cleanup regions.
 * No package files are changed; no input or callback is retried.
 *
 * The startup resets below are the ones owned by Pi's _startRun catch and run
 * finally, not an attempt to repair an arbitrary busy session from outside.
 * tests/fixtures/pi-1.2.0-start-run.txt pins the original method for review.
 */
type RunState = { preparing: boolean; kind: "user" | "custom"; priorIds: Set<string> };
type RunTrigger = { messageType: "user" | "custom" };
type Entry = { id: string; type: string; message?: { role?: string } };
type LifecycleSession = {
  sessionManager: { getEntries(): Entry[]; getBranch(): Entry[] };
  _startRun(trigger: RunTrigger, onStarted?: () => void): Promise<void>;
  _prepareRun(trigger: RunTrigger): Promise<unknown[]>;
  _isAgentRunActive: boolean; _agentRunAbortRequested: boolean;
  _runSystemPromptOptions?: unknown; _failedResponse?: unknown;
  _pendingToolNames: Set<string>;
  _flushPendingBashMessages(): void; _flushPendingCustomMessages(): void;
  _resolveIdleWaitIfIdle(): void; _recordSelection(): void;
  _handlePostAgentRun(): Promise<boolean>; _runBeforeSettleBoundary(): Promise<boolean>;
  _finishCancelledRetry(): void; _emitAgentSettled(): Promise<void>;
  agent: { prompt(messages: unknown[]): Promise<void>; continue(): Promise<void> };
};
const runs = new WeakMap<object, RunState>();

/** Busy in 1.2 includes hooks. Only a new persisted input can own turn_end. */
export function getSessionRunInputState(value: object | undefined): "pending" | "persisted" | undefined {
  const session = value as LifecycleSession;
  const run = session && runs.get(session);
  if (!run) return undefined;
  if (run.preparing) return "pending";
  const entries = session.sessionManager.getBranch();
  return entries.some(entry => !run.priorIds.has(entry.id) && (run.kind === "user"
    ? entry.type === "message" && entry.message?.role === "user"
    : entry.type === "custom_message")) ? "persisted" : "pending";
}

export function installRunLifecycleAdapter(value: object, version: string): boolean {
  const session = value as LifecycleSession;
  if (version === "1.0.3") return false;
  if (version !== "1.2.0" && version !== "1.3.0" && version !== "1.4.0") throw new Error(`Unreviewed Pi run lifecycle: ${version}`);
  for (const name of ["_startRun", "_prepareRun", "_flushPendingBashMessages", "_flushPendingCustomMessages",
    "_resolveIdleWaitIfIdle", "_recordSelection", "_handlePostAgentRun", "_runBeforeSettleBoundary",
    "_finishCancelledRetry", "_emitAgentSettled"]) {
    if (typeof session?.[name] !== "function") throw new Error(`Pi ${version} lifecycle missing ${name}`);
  }
  if (typeof session.sessionManager?.getBranch !== "function" || typeof session.sessionManager?.getEntries !== "function") {
    throw new Error("Pi lifecycle requires session entries and branch");
  }
  session._startRun = async function (this: LifecycleSession, trigger, onStarted) {
    if (runs.has(this)) throw new Error("Pi run startup is already active");
    const run: RunState = { preparing: true, kind: trigger.messageType, priorIds: new Set() };
    runs.set(this, run);
    this._isAgentRunActive = true;
    this._agentRunAbortRequested = false;
    try {
      let messages;
      let prepared = false;
      try {
        messages = await this._prepareRun(trigger);
        prepared = true;
        this._flushPendingBashMessages();
        this._flushPendingCustomMessages();
        // abort() cannot interrupt a suspended extension. Fence its late result
        // here without awaiting abort()/waitForIdle() from inside this same run.
        if (this._agentRunAbortRequested) throw new DOMException("Run cancelled before input", "AbortError");
        onStarted?.();
        if (this._agentRunAbortRequested) throw new DOMException("Run cancelled before input", "AbortError");
        this._failedResponse = undefined;
        this._recordSelection();
        this._pendingToolNames.clear();
        // Snapshot after branch edits and queued context flushes. Neither an
        // older branch's input nor unrelated custom context accepts this run.
        run.priorIds = new Set(this.sessionManager.getEntries().map(entry => entry.id));
        run.preparing = false;
      } catch (error) {
        this._isAgentRunActive = false;
        this._runSystemPromptOptions = undefined;
        try {
          // Match Pi's preparation-error drain, but never replay a flush that
          // already failed while persisting queued messages after preparation.
          if (!prepared) {
            this._flushPendingBashMessages();
            this._flushPendingCustomMessages();
          }
        } finally {
          this._resolveIdleWaitIfIdle();
        }
        throw error;
      }
      try {
        await this.agent.prompt(messages);
        while (!this._agentRunAbortRequested) {
          if (await this._handlePostAgentRun()) {
            if (this._agentRunAbortRequested) break;
            await this.agent.continue();
            continue;
          }
          if (this._agentRunAbortRequested || !(await this._runBeforeSettleBoundary())) break;
          if (this._agentRunAbortRequested) break;
          await this.agent.continue();
        }
      } finally {
        if (this._agentRunAbortRequested) this._finishCancelledRetry();
        this._failedResponse = undefined;
        this._runSystemPromptOptions = undefined;
        this._flushPendingBashMessages();
        this._flushPendingCustomMessages();
        // Settled handlers may start a deferred new run after Pi releases busy.
        runs.delete(this);
        await this._emitAgentSettled();
      }
    } finally {
      if (runs.get(this) === run) runs.delete(this);
    }
  };
  return true;
}
