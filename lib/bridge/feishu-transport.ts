import type { ClientRequest, RequestOptions } from "node:http";
import type { Socket } from "node:net";
import type { Readable } from "node:stream";
import { ProxyAgent } from "proxy-agent";
import type { HttpInstance, HttpRequestOptions } from "@larksuiteoapi/node-sdk";
import { getOutboundProxyConfig } from "../net/outbound-proxy.ts";
import { resolveProxyForUrl } from "../../shared/network-proxy.ts";
import { loadFeishuSdk } from "./optional-sdks.ts";

export const FEISHU_REQUEST_TIMEOUT_MS = 30_000;
export const FEISHU_HANDSHAKE_TIMEOUT_MS = 30_000;

function stoppedError() {
  return Object.assign(new Error("Feishu adapter stopped"), { name: "AbortError", code: "ABORT_ERR" });
}

export type FeishuTransportOptions = {
  getProxyConfig?: typeof getOutboundProxyConfig;
  onFatal?: (error: Error) => void;
};

function requestFailure(error: unknown, deliveryUnknown: boolean) {
  const source = (error && typeof error === "object" ? error : {}) as Record<string, unknown>;
  const failure = new Error(typeof source.message === "string" ? source.message : "Feishu request failed");
  for (const key of ["name", "code", "status", "log_id", "logId"]) {
    if (typeof source[key] === "string" || typeof source[key] === "number") Object.assign(failure, { [key]: source[key] });
  }
  // Axios response/config/cause objects never leave this boundary. Preserve
  // only the platform's safe diagnostic identifiers on an HTTP rejection.
  const response = source.response as { status?: number; data?: { code?: unknown; log_id?: unknown; error?: { log_id?: unknown } } };
  if (typeof response?.status === "number") Object.assign(failure, { status: response.status });
  const code = response?.data?.code;
  if (typeof code === "number" || typeof code === "string") Object.assign(failure, { code });
  const logId = response?.data?.error?.log_id ?? response?.data?.log_id;
  if (typeof logId === "string") Object.assign(failure, { log_id: logId });
  if (deliveryUnknown) Object.assign(failure, { deliveryUnknown: true });
  return failure;
}

// Each request owns its proxy agents. The Worker is the final cancellation
// boundary for hidden SOCKS negotiation sockets/timers, which these public
// agents cannot always destroy. Never destroy a shared application agent.
class FeishuAgent extends ProxyAgent {
  private closed = false;
  private readonly pending = new Set<() => void>();

  private readonly getProxyConfig: typeof getOutboundProxyConfig;
  private readonly onFatal: (error: Error) => void;

  constructor(getProxyConfig: typeof getOutboundProxyConfig, onFatal: (error: Error) => void) {
    super();
    this.getProxyConfig = getProxyConfig;
    this.onFatal = onFatal;
  }

  addRequest(request: ClientRequest, options: RequestOptions) {
    if (this.closed) {
      request.destroy(stoppedError());
      return;
    }
    const controller = new AbortController();
    const agent = new ProxyAgent({
      keepAlive: false,
      signal: controller.signal,
      timeout: FEISHU_HANDSHAKE_TIMEOUT_MS,
      getProxyForUrl: url => {
        controller.signal.throwIfAborted();
        return resolveProxyForUrl(url, this.getProxyConfig());
      },
    });
    const sockets = new Set<Socket>();
    let upgraded = false;
    let disposed = false;
    const timer = setTimeout(() => {
      const error = Object.assign(new Error("Feishu connection timed out"), { code: "ETIMEDOUT" });
      dispose(error);
      this.onFatal(error);
    }, FEISHU_HANDSHAKE_TIMEOUT_MS);
    timer.unref?.();
    const dispose = (error?: Error) => {
      if (disposed) return;
      disposed = true;
      clearTimeout(timer);
      this.pending.delete(cancel);
      controller.abort(error || stoppedError());
      request.removeListener("socket", onSocket);
      request.removeListener("upgrade", onUpgrade);
      request.removeListener("close", onClose);
      request.removeListener("error", onError);
      if (error) request.destroy(error);
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      agent.destroy();
      agent.httpAgent.destroy();
      agent.httpsAgent.destroy();
    };
    const cancel = () => dispose(stoppedError());
    const onSocket = (socket: Socket) => {
      if (disposed) { socket.destroy(); return; }
      sockets.add(socket);
      socket.once("close", () => { sockets.delete(socket); if (upgraded) dispose(); });
    };
    const onUpgrade = () => { upgraded = true; clearTimeout(timer); };
    const onClose = () => { if (!upgraded) dispose(); };
    const onError = (error: Error & { code?: string }) => {
      if (error.code === "ETIMEDOUT" || error.code === "ECONNABORTED" || /timed out/i.test(error.message)) {
        this.onFatal(error);
      }
    };
    this.pending.add(cancel);
    request.on("socket", onSocket);
    request.once("upgrade", onUpgrade);
    request.once("close", onClose);
    request.once("error", onError);
    // Node's agent.addRequest is the request/agent integration point. @types/node
    // omits it, though proxy-agent also implements and delegates this method.
    (agent as unknown as { addRequest(req: ClientRequest, opts: RequestOptions): void }).addRequest(request, options);
  }

  destroy() {
    this.closed = true;
    for (const cancel of [...this.pending]) cancel();
    super.destroy();
    this.httpAgent.destroy();
    this.httpsAgent.destroy();
  }
}

export function createFeishuTransport({ getProxyConfig = getOutboundProxyConfig, onFatal }: FeishuTransportOptions = {}) {
  const lifetime = new AbortController();
  let failed = false;
  function fatal(error: Error) {
    if (failed || lifetime.signal.aborted) return;
    failed = true;
    try { close(error); } finally { onFatal?.(error); }
  }
  const agent = new FeishuAgent(getProxyConfig, fatal);
  const pending = new Set<() => void>();
  const assertActive = () => lifetime.signal.throwIfAborted();

  async function request<T = unknown, R = T, D = unknown>(options: HttpRequestOptions<D> & { signal?: AbortSignal }): Promise<R> {
    assertActive();
    options.signal?.throwIfAborted();
    const controller = new AbortController();
    const timeoutMs = Math.min(options.timeout > 0 ? options.timeout : FEISHU_REQUEST_TIMEOUT_MS, FEISHU_REQUEST_TIMEOUT_MS);
    const timeout = setTimeout(() => {
      const error = Object.assign(new Error("Feishu request timed out"), { code: "ETIMEDOUT" });
      controller.abort(error);
      fatal(error);
    }, timeoutMs);
    timeout.unref?.();
    const abort = () => controller.abort(lifetime.signal.reason || stoppedError());
    const callerAbort = () => {
      const error = options.signal?.reason || stoppedError();
      controller.abort(error);
      fatal(error);
    };
    pending.add(abort);
    options.signal?.addEventListener("abort", callerAbort, { once: true });
    if (options.signal?.aborted) callerAbort();
    let stream: Readable | undefined;
    let dispatched = false;
    const cleanup = () => {
      clearTimeout(timeout);
      pending.delete(abort);
      options.signal?.removeEventListener("abort", callerAbort);
      controller.signal.removeEventListener("abort", destroyStream);
      stream?.removeListener("end", cleanup);
      stream?.removeListener("close", cleanup);
      stream?.removeListener("error", cleanup);
    };
    const destroyStream = () => stream?.destroy(controller.signal.reason);
    try {
      // Retain the SDK's Axios serializer and response/header conventions, with
      // per-call options only. No global defaults or interceptors are changed.
      controller.signal.throwIfAborted();
      dispatched = true;
      const response = await loadFeishuSdk().defaultHttpInstance.request<unknown, unknown>({
        ...options, proxy: false, httpAgent: agent, httpsAgent: agent,
        timeout: timeoutMs, signal: controller.signal,
      });
      controller.signal.throwIfAborted();
      assertActive();
      if (options.responseType === "stream") {
        stream = (options.$return_headers ? (response as { data: Readable })?.data : response) as Readable;
        if (stream?.once && !stream.destroyed && !stream.readableEnded) {
          stream.once("end", cleanup); stream.once("close", cleanup); stream.once("error", cleanup);
          controller.signal.addEventListener("abort", destroyStream, { once: true });
          return response as R;
        }
      }
      cleanup();
      return response as R;
    } catch (error) {
      cleanup();
      const failure = controller.signal.aborted ? controller.signal.reason : error;
      // A response with an explicit 4xx rejection is known. A dropped response
      // after a write, including a timeout/stop, must never cause a second send.
      const method = String(options.method || "GET").toUpperCase();
      const platformWrite = !["GET", "HEAD", "OPTIONS"].includes(method)
        && /\/open-apis\/(im|cardkit)\//.test(String(options.url));
      const knownBeforeWrite = ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ERR_INVALID_URL"].includes(failure?.code);
      const status = (error as { response?: { status?: number } })?.response?.status;
      const unknown = dispatched && platformWrite && !knownBeforeWrite && !(status >= 400 && status < 500);
      if (failure?.code === "ETIMEDOUT" || failure?.code === "ECONNABORTED") fatal(failure);
      throw requestFailure(failure, unknown);
    }
  }
  const httpInstance = { request } as unknown as HttpInstance;
  for (const method of ["get", "delete", "head", "options"] as const) {
    httpInstance[method] = <T, R = T, D = unknown>(url: string, options?: HttpRequestOptions<D>) => request<T, R, D>({ ...options, method, url });
  }
  for (const method of ["post", "put", "patch"] as const) {
    httpInstance[method] = <T, R = T, D = unknown>(url: string, data?: D, options?: HttpRequestOptions<D>) => request<T, R, D>({ ...options, method, url, data });
  }
  function close(reason: Error = stoppedError()) {
    if (lifetime.signal.aborted) return;
    lifetime.abort(reason);
    for (const abort of [...pending]) abort();
    agent.destroy();
  }
  return { httpInstance, agent, signal: lifetime.signal, assertActive, close };
}
