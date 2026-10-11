import { AsyncLocalStorage } from "node:async_hooks";

// A timed-out test still owns setup and every operation it started. Closing
// releases fixture barriers, waits for producers as well as their children, and
// only then removes files. Errors stay observable on the original promises.
export class AuthFixtureLifetime {
  private closing = false;
  private readonly closedError = new Error("Auth fixture is closing");
  private readonly children = new Set<Promise<unknown>>();
  private readonly context = new AsyncLocalStorage<symbol>();
  private readonly active = new Set<symbol>();
  private readonly releases: (() => void)[] = [];
  private readonly removals: (() => void)[] = [];
  private setupPromise?: Promise<unknown>;
  private rotationPromise?: Promise<unknown>;
  private disposal?: Promise<void>;

  checkOpen() {
    if (this.closing) throw this.closedError;
  }

  setup<T>(operation: () => Promise<T>): Promise<T> {
    const setup = this.start(operation, false);
    this.setupPromise = setup;
    // Keep rejection visible to callers, but observe it from the first turn.
    void setup.catch(() => {});
    return setup;
  }

  track<T>(operation: Promise<T>): Promise<T> {
    this.children.add(operation);
    void operation.then(() => this.children.delete(operation), () => this.children.delete(operation));
    return operation;
  }

  run<T>(operation: () => T | Promise<T>): Promise<T> {
    return this.track(this.start(operation, false));
  }

  child<T>(operation: () => T | Promise<T>): Promise<T> {
    return this.track(this.start(operation, true));
  }

  private start<T>(operation: () => T | Promise<T>, continuation: boolean): Promise<T> {
    const parent = this.context.getStore();
    const owned = parent !== undefined && this.active.has(parent);
    const scope = Symbol("auth fixture operation");
    const result = Promise.resolve().then(() => {
      // Only an already-owned continuation may start storage work while
      // closing (e.g. getAuth finishing read -> modify -> durable rotation).
      if (this.closing && !(continuation && owned)) throw this.closedError;
      this.active.add(scope);
      return this.context.run(scope, operation);
    });
    void result.then(() => this.active.delete(scope), () => this.active.delete(scope));
    return result;
  }

  rotate<T>(operation: () => Promise<T>): Promise<T> {
    this.checkOpen();
    const rotation = this.run(operation);
    this.rotationPromise = rotation;
    return rotation;
  }

  releaseOnClose(release: () => void) { this.releases.push(release); }
  removeOnClose(remove: () => void) { this.removals.push(remove); }

  async drain() {
    // Producers may add children while a previous batch is settling.
    while (this.children.size) await Promise.allSettled([...this.children]);
  }

  dispose(): Promise<void> {
    this.closing = true;
    for (const release of this.releases) release();
    this.disposal ??= this.finish();
    void this.disposal.catch(() => {});
    return this.disposal;
  }

  private async finish() {
    const errors = new Set<unknown>();
    // Setup owns the creation of rotation, so read rotationPromise only AFTER
    // setup terminates. A snapshot of today's child set is not sufficient.
    for (const result of await Promise.allSettled([this.setupPromise])) {
      if (result.status === "rejected" && result.reason !== this.closedError) errors.add(result.reason);
    }
    for (const result of await Promise.allSettled([this.rotationPromise])) {
      if (result.status === "rejected" && result.reason !== this.closedError) errors.add(result.reason);
    }
    await this.drain();
    for (const remove of this.removals) {
      try { remove(); } catch (error) { errors.add(error); }
    }
    if (errors.size === 1) throw [...errors][0];
    if (errors.size > 1) throw new AggregateError(errors, "Auth fixture cleanup failed");
  }
}
