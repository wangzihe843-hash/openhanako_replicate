import { buildDeferredResultMessage } from "./deferred-result-notification.js";

const DEFAULT_RETRY_INTERVAL_MS = 30_000;

function isDeliverable(task) {
  return task && !task.delivered && (
    task.status === "resolved" ||
    task.status === "failed" ||
    task.status === "aborted"
  );
}

export class DeferredResultCoordinator {
  constructor({
    store,
    sessionCoordinator,
    retryIntervalMs = DEFAULT_RETRY_INTERVAL_MS,
    log = console,
  }) {
    this.store = store;
    this.sessionCoordinator = sessionCoordinator;
    this.retryIntervalMs = retryIntervalMs;
    this.log = log;
    this._unsubs = [];
    this._retryTimer = null;
    this._started = false;
    this._inFlight = new Map();
  }

  start() {
    if (this._started) return;
    this._started = true;
    this._unsubs.push(this.store.onResult((taskId) => {
      this.deliverTask(taskId);
    }));
    this._unsubs.push(this.store.onFail((taskId) => {
      this.deliverTask(taskId);
    }));

    if (this.retryIntervalMs > 0) {
      this._retryTimer = setInterval(() => {
        this.flushUndelivered().catch((err) => {
          this.log.warn?.(`[deferred-result] flush failed: ${err.message}`);
        });
      }, this.retryIntervalMs);
      this._retryTimer.unref?.();
    }
  }

  dispose() {
    for (const unsub of this._unsubs.splice(0)) {
      try { unsub(); } catch {}
    }
    if (this._retryTimer) {
      clearInterval(this._retryTimer);
      this._retryTimer = null;
    }
    this._started = false;
  }

  async flushUndelivered(sessionPath) {
    const tasks = this.store.listUndelivered(sessionPath);
    for (const task of tasks) {
      await this.deliverTask(task.taskId);
    }
  }

  async deliverTask(taskId) {
    const existing = this._inFlight.get(taskId);
    if (existing) return existing;

    const promise = this._deliverTask(taskId).finally(() => {
      this._inFlight.delete(taskId);
    });
    this._inFlight.set(taskId, promise);
    return promise;
  }

  async _deliverTask(taskId) {
    const task = this.store.query(taskId);
    if (!isDeliverable(task)) return false;

    try {
      await this.sessionCoordinator.deliverCustomMessage(
        task.sessionPath,
        buildDeferredResultMessage(taskId, task),
      );
      this.store.markDelivered(taskId);
      return true;
    } catch (err) {
      this.log.warn?.(`[deferred-result] delivery failed for ${taskId}: ${err.message}`);
      return false;
    }
  }
}
