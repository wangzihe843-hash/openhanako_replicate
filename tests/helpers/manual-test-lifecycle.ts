// Test-only ownership for asynchronous manual-operation fixtures. Vitest can
// finish its timeout wrapper while the original async test body is still alive.
export class ManualTestScope {
  private closed = false;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly releases = new Set<() => void>();
  private rejectClosed!: (reason: Error) => void;
  private readonly expired = new Promise<never>((_, reject) => { this.rejectClosed = reject; });
  private readonly onAbort = () => this.close();

  constructor(private readonly signal: AbortSignal) {
    void this.expired.catch(() => {});
    signal.addEventListener("abort", this.onAbort, { once: true });
    if (signal.aborted) this.close();
  }

  assertActive() {
    if (this.closed || this.signal.aborted) throw new Error("manual fixture is closed");
  }

  track<T extends Promise<unknown>>(promise: T): T {
    this.pending.add(promise);
    // Keep a rejection handler even when a timed-out caller no longer awaits it.
    void promise.then(() => this.pending.delete(promise), () => this.pending.delete(promise));
    return promise;
  }

  run<T>(body: () => Promise<T>): Promise<T> {
    // Register the whole body before its first continuation, not just operations
    // that happen to reach bounded() before teardown starts.
    return this.track(Promise.resolve().then(() => { this.assertActive(); return body(); }));
  }

  barrier() {
    this.assertActive();
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = () => { this.releases.delete(resolve); done(); };
    });
    this.releases.add(resolve);
    return { promise, resolve };
  }

  bounded<T>(promise: Promise<T>): Promise<T> {
    // The operation may already have started when passed here: always own it,
    // including a late registration during cleanup.
    this.track(promise);
    return this.track((async () => {
      this.assertActive();
      const result = await deadline(Promise.race([promise, this.expired]), "manual operation did not settle");
      this.assertActive();
      return result;
    })());
  }

  private close() {
    if (this.closed) return;
    this.closed = true;
    this.rejectClosed(new Error("manual fixture is closed"));
    for (const release of this.releases) release();
  }

  async finish() {
    this.close();
    try {
      await deadline((async () => {
        // Settling the body can register further operations. Drain to quiescence
        // under one 2 s deadline rather than taking a single pending snapshot.
        while (this.pending.size) await Promise.allSettled([...this.pending]);
      })(), "manual fixture cleanup did not settle");
    } finally {
      this.signal.removeEventListener("abort", this.onAbort);
    }
  }
}

export class ManualTestOwner {
  private active?: ManualTestScope;

  assertReady() {
    if (this.active) throw new Error("previous manual fixture did not finish cleanup");
  }

  create(signal: AbortSignal) {
    this.assertReady();
    return this.active = new ManualTestScope(signal);
  }

  async finish(scope: ManualTestScope) {
    if (scope !== this.active) throw new Error("manual fixture cleanup owner mismatch");
    await scope.finish();
    // A failed drain intentionally leaves the owner occupied. Subsequent setup
    // must fail before clearing shared mocks or creating a new fixture.
    this.active = undefined;
  }
}

async function deadline<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), 2000);
    })]);
  } finally { clearTimeout(timer!); }
}
