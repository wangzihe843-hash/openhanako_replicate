import { Worker } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import {
  FEISHU_MEDIA_CAPABILITIES, FEISHU_STREAMING_CAPABILITIES,
  FEISHU_CARDKIT_STREAMING_CAPABILITIES, resolveFeishuDomain,
} from "./feishu-adapter.ts";
import type { createFeishuAdapter } from "./feishu-adapter.ts";
import { createModuleLogger } from "../debug-log.ts";
import { downloadMedia, detectMime } from "./media-utils.ts";
import { getOutboundProxySnapshot, subscribeOutboundProxyConfig } from "../net/outbound-proxy.ts";
import {
  FEISHU_WORKER_PROTOCOL, FEISHU_RPC_TIMEOUT_MS, FEISHU_EXIT_TIMEOUT_MS,
  FEISHU_MAX_PENDING, FEISHU_MAX_PENDING_BYTES, FEISHU_METHODS,
  isFeishuWrite, isFeishuStreamUpdate, prepareFeishuArguments,
  deserializeFeishuError, feishuWorkerError, feishuDiagnostic, feishuProxySecrets,
} from "./feishu-worker-protocol.ts";
import type { FeishuMethod, FeishuStreamState, FeishuDiagnosticLevel, FeishuWorkerFrame } from "./feishu-worker-protocol.ts";

const log = createModuleLogger("feishu");

// Both bundle/index.js and bundle/cli.js resolve the separately built sibling.
// This is an application-owned fixed entry, never a configurable script path.
export function resolveFeishuWorkerUrl() {
  return new URL(import.meta.url.endsWith(".ts") ? "./feishu-worker.ts" : "./feishu-worker.js", import.meta.url);
}

type Pending = {
  method: FeishuMethod; args: unknown[]; bytes: number; sent: boolean; state?: FeishuStreamState;
  streamId?: number; timer: ReturnType<typeof setTimeout>;
  resolve: (value: unknown) => void; reject: (error: Error) => void;
};

type FeishuWorkerOptions = {
  appId: string; appSecret: string; region?: string; agentId?: string;
  onMessage?: (message: unknown) => unknown; onStatus?: (status: string, error?: string) => unknown;
  waitForPreviousExit?: Promise<unknown>;
};
type WorkerAdapter = Omit<ReturnType<typeof createFeishuAdapter>, "stop"> & {
  stop: () => Promise<void>;
  releaseStreamReply: (state: FeishuStreamState) => void;
};

export function createFeishuWorkerAdapter({ appId, appSecret, region, agentId, onMessage, onStatus, waitForPreviousExit }: FeishuWorkerOptions): WorkerAdapter {
  const domain = resolveFeishuDomain(region);
  const generation = randomUUID();
  let worker: Worker | undefined;
  let ready = false;
  let stopped = false;
  let exited = false;
  let nextId = 0;
  let lastEvent = 0;
  let queuedBytes = 0;
  let stopPromise: Promise<void> | undefined;
  let exitResolve: (() => void) | undefined;
  let exitReject: ((error: Error) => void) | undefined;
  let exitTimer: ReturnType<typeof setTimeout> | undefined;
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe = () => {};
  let proxySnapshot = getOutboundProxySnapshot();
  const secrets = new Set([appSecret, ...feishuProxySecrets(proxySnapshot.config)]);
  const pending = new Map<number, Pending>();
  const streamIds = new WeakMap<object, number>();

  const diagnostic = (value: unknown) => feishuDiagnostic(value, [...secrets]);
  function record(level: FeishuDiagnosticLevel, message: unknown) {
    log[level === "info" ? "log" : level](diagnostic(message));
  }
  function status(value: string, error?: unknown) {
    try { onStatus?.(value, error === undefined ? undefined : diagnostic(error)); }
    catch { record("error", "Feishu status callback failed"); }
  }
  function settle(id: number, error?: Error, value?: unknown) {
    const call = pending.get(id);
    if (!call) return;
    pending.delete(id);
    queuedBytes -= call.bytes;
    clearTimeout(call.timer);
    if (error) call.reject(error); else call.resolve(value);
  }
  function rejectPending(reason: string, code: string) {
    for (const [id, call] of pending) settle(id, feishuWorkerError(reason, code, call.sent && isFeishuWrite(call.method)));
  }
  function detachConfig() {
    unsubscribe();
    clearTimeout(startupTimer);
    startupTimer = undefined;
  }
  function stop(): Promise<void> {
    if (stopPromise) return stopPromise;
    stopped = true;
    ready = false;
    detachConfig();
    rejectPending("Feishu binding stopped", "FEISHU_WORKER_CLOSED");
    if (!worker || exited) return stopPromise = Promise.resolve();
    const owned = worker;
    stopPromise = new Promise<void>((resolve, reject) => {
      exitResolve = resolve;
      exitReject = reject;
      exitTimer = setTimeout(() => {
        const error = feishuWorkerError("Feishu worker did not exit before the teardown deadline", "FEISHU_WORKER_EXIT_TIMEOUT");
        status("error", error);
        reject(error);
        // Keep the exit listener. A failed barrier must never claim cleanup.
      }, FEISHU_EXIT_TIMEOUT_MS);
      try { owned.postMessage({ v: FEISHU_WORKER_PROTOCOL, generation, type: "stop" }); } catch { /* terminate remains authoritative. */ }
      // Public termination owns sockets and even third-party unref timers.
      // A graceful stop acknowledgement alone is not a resource boundary.
      owned.terminate().catch(() => {
        clearTimeout(exitTimer);
        const error = feishuWorkerError("Feishu worker termination failed", "FEISHU_WORKER_TERMINATE_FAILED");
        status("error", error);
        reject(error);
      });
    });
    // Observing is not swallowing: callers receive the original rejection.
    void stopPromise.catch(() => {});
    return stopPromise;
  }
  function fail(message: string, code = "FEISHU_WORKER_FAILED") {
    if (stopped) return;
    status("error", message);
    rejectPending(message, code);
    void stop();
  }
  function dispatch(id: number, call: Pending) {
    if (!ready || stopped || !worker || call.sent) return;
    try {
      worker.postMessage({ v: FEISHU_WORKER_PROTOCOL, generation, type: "call", id,
        method: call.method, args: call.args, streamId: call.streamId });
      call.sent = true;
      // postMessage clones synchronously; keep only the caller's visible state.
      call.args = [];
    } catch { settle(id, feishuWorkerError("Feishu request could not be dispatched", "FEISHU_WORKER_DISPATCH_FAILED")); }
  }
  function call(method: FeishuMethod, input: unknown[]) {
    if (stopped) return Promise.reject(feishuWorkerError("Feishu binding stopped"));
    let prepared: ReturnType<typeof prepareFeishuArguments>;
    let state: FeishuStreamState | undefined;
    let streamId: number | undefined;
    try {
      if (isFeishuStreamUpdate(method)) {
        state = input[1] as FeishuStreamState;
        streamId = state && streamIds.get(state);
        if (!streamId) throw feishuWorkerError("Feishu stream belongs to another or expired binding", "FEISHU_STREAM_INVALID");
      }
      prepared = prepareFeishuArguments(method, isFeishuStreamUpdate(method) ? [input[0], null, input[2]] : input);
      if (pending.size >= FEISHU_MAX_PENDING || queuedBytes + prepared.bytes > FEISHU_MAX_PENDING_BYTES) {
        throw feishuWorkerError("Feishu pending request budget exceeded", "FEISHU_QUEUE_FULL");
      }
    } catch (error) { return Promise.reject(error); }
    const id = ++nextId;
    return new Promise<unknown>((resolve, reject) => {
      const entry: Pending = { method, args: prepared.args, bytes: prepared.bytes, sent: false, state, streamId, resolve, reject,
        timer: setTimeout(() => fail("Feishu request deadline exceeded", "FEISHU_WORKER_TIMEOUT"), FEISHU_RPC_TIMEOUT_MS) };
      pending.set(id, entry);
      queuedBytes += entry.bytes;
      dispatch(id, entry);
    });
  }
  function releaseStreamReply(state: FeishuStreamState) {
    if (!state || typeof state !== "object") return;
    const streamId = streamIds.get(state);
    if (streamId === undefined) return;
    streamIds.delete(state);
    if (stopped) return;
    // This is local lifecycle cleanup, not a platform write or retry. FIFO
    // delivery places it after all calls already dispatched for this handle.
    try { worker?.postMessage({ v: FEISHU_WORKER_PROTOCOL, generation, type: "release", streamId }); }
    catch { fail("Feishu worker stream release failed"); }
  }

  // Yield until the Manager has registered the binding. A replacement must
  // also wait for the preceding physical exit, including failed exit barriers.
  void Promise.resolve(waitForPreviousExit).then(() => {
    if (stopped) return;
    proxySnapshot = getOutboundProxySnapshot();
    for (const secret of feishuProxySecrets(proxySnapshot.config)) secrets.add(secret);
    worker = new Worker(resolveFeishuWorkerUrl(), {
      workerData: { v: FEISHU_WORKER_PROTOCOL, generation, appId, appSecret, region: domain.region, agentId, proxySnapshot },
      stdout: true, stderr: true,
    });
    // Unstructured output cannot reliably distinguish a split/unknown secret.
    // Consume without buffering it and emit only one constant marker per stream.
    for (const stream of [worker.stdout, worker.stderr]) {
      let reported = false;
      stream?.on("data", () => { if (!reported && !stopped) { reported = true; record("warn", "Feishu worker unstructured output discarded"); } });
      stream?.on("error", () => { if (!stopped) record("warn", "Feishu worker output stream failed"); });
    }
    worker.on("message", (frame: FeishuWorkerFrame) => {
      if (stopped || frame?.v !== FEISHU_WORKER_PROTOCOL || frame.generation !== generation) return;
      if (frame.type === "result") {
        const entry = pending.get(frame.id);
        if (!entry) return;
        if (entry.state && frame.state) Object.assign(entry.state, frame.state);
        if (frame.error) { settle(frame.id, deserializeFeishuError(frame.error, [...secrets])); return; }
        let value = frame.value;
        if (frame.streamId && value && typeof value === "object") streamIds.set(value, frame.streamId);
        if (value instanceof Uint8Array) value = Buffer.from(value);
        settle(frame.id, undefined, value);
        return;
      }
      if (!Number.isSafeInteger(frame.seq) || frame.seq <= lastEvent) return;
      lastEvent = frame.seq;
      if (frame.type === "ready") {
        ready = true; clearTimeout(startupTimer); startupTimer = undefined;
        for (const [id, entry] of pending) dispatch(id, entry);
      } else if (frame.type === "status") {
        if (["connected", "connecting", "disconnected", "error"].includes(frame.status)) status(frame.status, frame.error);
      } else if (frame.type === "message") {
        try { Promise.resolve(onMessage?.(frame.message)).catch(() => record("error", "Feishu message callback failed")); }
        catch { record("error", "Feishu message callback failed"); }
      } else if (frame.type === "log") {
        if (["info", "warn", "error"].includes(frame.level)) record(frame.level, frame.message);
      } else if (frame.type === "fatal") fail(diagnostic(frame.error?.message || "Feishu worker failed"));
    });
    worker.on("error", error => fail(diagnostic(error)));
    worker.on("messageerror", () => fail("Feishu worker message could not be decoded", "FEISHU_WORKER_MESSAGE_ERROR"));
    worker.once("exit", code => {
      exited = true;
      detachConfig();
      clearTimeout(exitTimer);
      if (!stopped) fail(`Feishu worker exited unexpectedly (code ${code})`);
      worker?.removeAllListeners("message");
      worker?.removeAllListeners("messageerror");
      worker?.removeAllListeners("error");
      exitResolve?.();
      exitResolve = undefined; exitReject = undefined;
    });
    unsubscribe = subscribeOutboundProxyConfig(snapshot => {
      if (stopped || snapshot.version <= proxySnapshot.version) return;
      proxySnapshot = snapshot;
      for (const secret of feishuProxySecrets(snapshot.config)) secrets.add(secret);
      try { worker?.postMessage({ v: FEISHU_WORKER_PROTOCOL, generation, type: "config", snapshot }); }
      catch { fail("Feishu worker proxy update failed"); }
    });
    startupTimer = setTimeout(() => fail("Feishu worker initialization deadline exceeded"), FEISHU_RPC_TIMEOUT_MS);
  }).catch(error => { fail(diagnostic(error)); exitReject?.(error); });

  const methods = Object.fromEntries(FEISHU_METHODS.map(method => [method, (...args: unknown[]) => call(method, args)]));
  return {
    ...methods,
    region: domain.region, domain: domain.domain,
    mediaCapabilities: FEISHU_MEDIA_CAPABILITIES,
    richStreamingCapabilities: FEISHU_CARDKIT_STREAMING_CAPABILITIES,
    streamingCapabilities: FEISHU_STREAMING_CAPABILITIES,
    async sendMedia(chatId: string, url: string, metadata: Record<string, unknown> = {}) {
      if (stopped) throw feishuWorkerError("Feishu binding stopped");
      // Local permissions live in the Manager's isolate. Resolve those bytes
      // there using the existing whitelist; all network I/O stays in Worker.
      if (!/^(?:https?:)?\/\//.test(url)) {
        const buffer = await downloadMedia(url);
        if (stopped) throw feishuWorkerError("Feishu binding stopped");
        const filename = metadata.filename || (() => { try { return new URL(url).pathname.split("/").pop() || "file"; } catch { return "file"; } })();
        return call("sendMediaBuffer", [chatId, buffer, { ...metadata, filename, mime: metadata.mime || detectMime(buffer, "application/octet-stream", filename) }]);
      }
      return call("sendMedia", [chatId, url, metadata]);
    },
    releaseStreamReply,
    stop,
  } as WorkerAdapter;
}
