export interface McpRequestOptions {
  signal?: AbortSignal;
  timeout?: number;
}

export function isAbortSignal(value): value is AbortSignal {
  return value && typeof value.aborted === "boolean"
    && typeof value.addEventListener === "function"
    && typeof value.removeEventListener === "function";
}

export function isAbortError(error) {
  return error?.name === "AbortError";
}

export function cancellationError(signal: AbortSignal) {
  const reason = signal.reason;
  if (isAbortError(reason) || reason?.name === "TimeoutError") return reason;
  const error = new Error("MCP request aborted", { cause: reason });
  error.name = "AbortError";
  return error;
}

export function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw cancellationError(signal);
}

// Stop waiting without cancelling shared work (token refresh or connector
// startup). Keep observing its settlement even after this waiter has left.
export async function waitWithSignal<T>(promise: PromiseLike<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  let onAbort: () => void;
  try {
    return await new Promise<T>((resolve, reject) => {
      onAbort = () => reject(cancellationError(signal));
      signal.addEventListener("abort", onAbort, { once: true });
      Promise.resolve(promise).then(
        (value) => signal.aborted ? onAbort() : resolve(value),
        (error) => signal.aborted ? onAbort() : reject(error),
      );
      if (signal.aborted) onAbort();
    });
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

// Own the deadline and listeners for one request, including auth and response
// body waits. Caller cancellation never aborts a connector's shared controller.
export async function withRequestDeadline<T>(
  signal: AbortSignal | undefined,
  timeout: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  throwIfAborted(signal);
  const controller = new AbortController();
  const onAbort = () => controller.abort(cancellationError(signal));
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    controller.abort(new DOMException("MCP request timed out", "TimeoutError"));
  }, timeout);
  try {
    return await waitWithSignal(run(controller.signal), controller.signal);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
