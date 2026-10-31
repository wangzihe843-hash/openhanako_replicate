import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { createFeishuAdapter } from "./feishu-adapter.ts";
import { normalizeNetworkProxyConfig } from "../../shared/network-proxy.ts";
import {
  FEISHU_WORKER_PROTOCOL, FEISHU_MAX_PENDING, FEISHU_MAX_PENDING_BYTES, FEISHU_MAX_STREAMS,
  FEISHU_METHODS, isFeishuStreamStart, isFeishuStreamUpdate, prepareFeishuArguments,
  serializeFeishuError, feishuDiagnostic, feishuProxySecrets, feishuWorkerError,
} from "./feishu-worker-protocol.ts";
import type { FeishuMethod, FeishuStreamState, FeishuDiagnosticLevel, FeishuCallFrame, FeishuParentFrame } from "./feishu-worker-protocol.ts";

// This module is safe to import when Feishu is disabled; only a dedicated,
// correctly initialized worker may construct the SDK clients.
if (!isMainThread && parentPort && workerData?.v === FEISHU_WORKER_PROTOCOL) {
  const port = parentPort;
  const { generation, appId, appSecret, region, agentId } = workerData;
  let sequence = 0;
  let stopped = false;
  let proxyVersion = workerData.proxySnapshot.version;
  let proxyConfig = normalizeNetworkProxyConfig(workerData.proxySnapshot.config, { strict: true });
  const secrets = new Set<string>([appSecret, ...feishuProxySecrets(proxyConfig)]);
  let adapter: ReturnType<typeof createFeishuAdapter> | undefined;
  const streams = new Map<number, FeishuStreamState>();
  const streamQueues = new Map<number, Promise<void>>();
  const releasingStreams = new Set<number>();
  const requests = new Set<number>();
  let nextStreamId = 0;
  let pendingBytes = 0;
  let startingStreams = 0;
  let lastRequestId = 0;

  function event(type: string, fields: Record<string, unknown> = {}) {
    if (!stopped) port.postMessage({ v: FEISHU_WORKER_PROTOCOL, generation, type, seq: ++sequence, ...fields });
  }
  function safeError(error: unknown) { return serializeFeishuError(error, [...secrets]); }
  function stop() {
    if (stopped) return;
    stopped = true;
    try { adapter?.stop(); } finally {
      streams.clear(); streamQueues.clear(); releasingStreams.clear(); requests.clear();
      port.removeAllListeners("message");
      port.close();
    }
  }
  function fatal(error: Error) {
    event("fatal", { error: safeError(error) });
    stop();
  }
  function snapshot(state: unknown): FeishuStreamState | undefined {
    if (!state || typeof state !== "object") return undefined;
    const source = state as Record<string, unknown>;
    const result: FeishuStreamState = {};
    for (const key of ["messageId", "previousMessageId", "renderKind", "missingMessageId", "cardId", "elementId", "sequence"]) {
      const value = source[key];
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") result[key] = value;
      else if (value === null) result[key] = null;
    }
    return result;
  }
  function result(id: number, fields: Record<string, unknown>) {
    if (!stopped) port.postMessage({ v: FEISHU_WORKER_PROTOCOL, generation, type: "result", id, ...fields });
  }
  async function execute(frame: FeishuCallFrame, args: unknown[], bytes: number, stream?: FeishuStreamState) {
    try {
      if (stopped) return;
      const method = frame.method as FeishuMethod;
      if (stream && streams.get(frame.streamId) !== stream) throw feishuWorkerError("Feishu stream is finished", "FEISHU_STREAM_INVALID");
      // The method whitelist is checked before this call. Keep `this` bound:
      // finish methods invoke their corresponding update method internally.
      const handler = adapter[method] as (...values: unknown[]) => Promise<unknown>;
      const value = await handler.apply(adapter, args);
      if (stopped) return;
      let streamId: number | undefined;
      if (isFeishuStreamStart(method)) {
        streamId = ++nextStreamId;
        streams.set(streamId, value as FeishuStreamState);
      }
      result(frame.id, { value: isFeishuStreamStart(method) ? snapshot(value) : value, streamId, state: snapshot(stream) });
      if (method === "finishStreamReply" || method === "finishRichStreamReply") streams.delete(frame.streamId);
    } catch (error) {
      result(frame.id, { error: safeError(error), state: snapshot(stream) });
    } finally {
      requests.delete(frame.id);
      pendingBytes -= bytes;
      if (isFeishuStreamStart(frame.method)) startingStreams--;
    }
  }

  port.on("message", (frame: FeishuParentFrame) => {
    if (stopped || frame?.v !== FEISHU_WORKER_PROTOCOL || frame.generation !== generation) return;
    if (frame.type === "stop") { stop(); return; }
    if (frame.type === "config") {
      if (!Number.isSafeInteger(frame.snapshot?.version) || frame.snapshot.version <= proxyVersion) return;
      try {
        proxyConfig = normalizeNetworkProxyConfig(frame.snapshot.config, { strict: true });
        proxyVersion = frame.snapshot.version;
        for (const secret of feishuProxySecrets(proxyConfig)) secrets.add(secret);
      } catch { fatal(feishuWorkerError("Invalid Feishu proxy configuration")); }
      return;
    }
    if (frame.type === "release") {
      const id = frame.streamId;
      if (!Number.isSafeInteger(id) || !streams.has(id) || releasingStreams.has(id)) return;
      releasingStreams.add(id);
      // Let accepted updates settle before dropping their mutable SDK state.
      // New calls for a released handle are rejected, including on failure.
      const previous = streamQueues.get(id) || Promise.resolve();
      const next = previous.then(() => { streams.delete(id); releasingStreams.delete(id); });
      streamQueues.set(id, next);
      void next.finally(() => { if (streamQueues.get(id) === next) streamQueues.delete(id); });
      return;
    }
    if (frame.type !== "call" || !Number.isSafeInteger(frame.id) || frame.id <= lastRequestId) return;
    lastRequestId = frame.id;
    try {
      if (!FEISHU_METHODS.includes(frame.method)) throw new Error("Invalid Feishu RPC method");
      const method = frame.method as FeishuMethod;
      const { args, bytes } = prepareFeishuArguments(method, frame.args);
      if (requests.size >= FEISHU_MAX_PENDING || pendingBytes + bytes > FEISHU_MAX_PENDING_BYTES) throw feishuWorkerError("Feishu pending request budget exceeded", "FEISHU_QUEUE_FULL");
      if (isFeishuStreamStart(method) && streams.size + startingStreams >= FEISHU_MAX_STREAMS) throw feishuWorkerError("Feishu active stream budget exceeded", "FEISHU_STREAM_LIMIT");
      const stream = isFeishuStreamUpdate(method) ? streams.get(frame.streamId) : undefined;
      if (isFeishuStreamUpdate(method)) {
        if (!stream || releasingStreams.has(frame.streamId)) throw feishuWorkerError("Unknown Feishu stream", "FEISHU_STREAM_INVALID");
        args[1] = stream;
      }
      requests.add(frame.id);
      pendingBytes += bytes;
      if (isFeishuStreamStart(method)) startingStreams++;
      if (stream) {
        const previous = streamQueues.get(frame.streamId) || Promise.resolve();
        const next = previous.then(() => execute(frame, args, bytes, stream));
        streamQueues.set(frame.streamId, next);
        void next.finally(() => { if (streamQueues.get(frame.streamId) === next) streamQueues.delete(frame.streamId); });
      } else void execute(frame, args, bytes);
    } catch (error) { result(frame.id, { error: safeError(error) }); }
  });
  port.on("messageerror", () => fatal(feishuWorkerError("Feishu parent message could not be decoded")));
  try {
    adapter = createFeishuAdapter({ appId, appSecret, region, agentId,
      getProxyConfig: () => proxyConfig,
      onMessage: message => event("message", { message }),
      onStatus: (status: string, error?: string) => event("status", { status, error: error === undefined ? undefined : feishuDiagnostic(error, [...secrets]) }),
      onDiagnostic: (level: FeishuDiagnosticLevel, message: string) => event("log", { level, message: feishuDiagnostic(message, [...secrets]) }),
      onFatal: fatal,
    });
    event("ready");
  } catch (error) { fatal(error); }
}
