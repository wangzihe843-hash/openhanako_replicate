import { redactLogText } from "../../shared/log-redactor.ts";

export const FEISHU_WORKER_PROTOCOL = 1;
export const FEISHU_RPC_TIMEOUT_MS = 35_000;
export const FEISHU_EXIT_TIMEOUT_MS = 5_000;
export const FEISHU_MAX_PENDING = 64;
export const FEISHU_MAX_PENDING_BYTES = 64 * 1024 * 1024;
export const FEISHU_MAX_STREAMS = 128;
export const FEISHU_METHODS = [
  "sendReply", "sendBlockReply", "startStreamReply", "updateStreamReply", "finishStreamReply",
  "startRichStreamReply", "updateRichStreamReply", "finishRichStreamReply",
  "downloadImage", "downloadFile", "sendMedia", "sendMediaBuffer",
] as const;
export type FeishuMethod = typeof FEISHU_METHODS[number];
export type FeishuDiagnosticLevel = "info" | "warn" | "error";
export type FeishuStreamState = Record<string, string | number | boolean | null>;
export type FeishuCallFrame = { v: number; generation: string; type: "call"; id: number; method: FeishuMethod; args: unknown[]; streamId?: number };
export type FeishuProxySnapshot = { version: number; config: Record<string, unknown> };
export type FeishuParentFrame = FeishuCallFrame
  | { v: number; generation: string; type: "config"; snapshot: FeishuProxySnapshot }
  | { v: number; generation: string; type: "release"; streamId: number }
  | { v: number; generation: string; type: "stop" };
export type FeishuWorkerFrame = {
  v: number; generation: string; type: string; seq?: number; id?: number;
  value?: unknown; streamId?: number; state?: FeishuStreamState; error?: FeishuWireError;
  status?: string; message?: unknown; level?: FeishuDiagnosticLevel;
};
export type FeishuWireError = {
  name: string; message: string; code?: string | number; status?: number;
  log_id?: string; operation?: string; actualBytes?: number; maxBytes?: number;
  phase?: string; deliveryUnknown?: boolean;
};

export function isFeishuWrite(method: FeishuMethod) {
  return method !== "downloadImage" && method !== "downloadFile";
}
export function isFeishuStreamUpdate(method: FeishuMethod) {
  return /^(?:update|finish)(?:Rich)?StreamReply$/.test(method);
}
export function isFeishuStreamStart(method: FeishuMethod) {
  return method === "startStreamReply" || method === "startRichStreamReply";
}

export function feishuDiagnostic(value: unknown, secrets: readonly string[] = []) {
  let text = value instanceof Error ? value.message : typeof value === "string" ? value : "Feishu worker error";
  // Bare app/URL credentials are not always labelled by third-party errors.
  for (const secret of secrets) if (secret) text = text.split(secret).join("[redacted]");
  return redactLogText(text).slice(0, 4096);
}

export function serializeFeishuError(error: unknown, secrets: readonly string[] = []): FeishuWireError {
  const source = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const result: FeishuWireError = {
    name: feishuDiagnostic(source.name || "Error", secrets),
    message: feishuDiagnostic(source.message ?? error, secrets),
  };
  for (const key of ["log_id", "operation", "phase"] as const) {
    const value = source[key];
    if (typeof value === "string") result[key] = feishuDiagnostic(value, secrets);
  }
  for (const key of ["status", "actualBytes", "maxBytes"] as const) if (typeof source[key] === "number" && Number.isFinite(source[key])) result[key] = source[key];
  if (typeof source.code === "string") result.code = feishuDiagnostic(source.code, secrets);
  else if (typeof source.code === "number" && Number.isFinite(source.code)) result.code = source.code;
  if (source.deliveryUnknown === true) result.deliveryUnknown = true;
  return result;
}

export function deserializeFeishuError(value: FeishuWireError, secrets: readonly string[] = []) {
  // Re-apply the allowlist even though the sender is an application Worker.
  const clean = serializeFeishuError(value, secrets);
  return Object.assign(new Error(clean.message), clean);
}

export function feishuWorkerError(message: string, code = "FEISHU_WORKER_CLOSED", deliveryUnknown = false) {
  return Object.assign(new Error(message), { code, deliveryUnknown });
}

export function feishuProxySecrets(config: Record<string, unknown>) {
  const values: string[] = [];
  for (const key of ["httpProxy", "httpsProxy", "wsProxy", "wssProxy"]) {
    try {
      if (typeof config?.[key] !== "string") continue;
      const url = new URL(config[key]);
      for (const value of [url.username, url.password]) {
        if (value) { values.push(value); try { values.push(decodeURIComponent(value)); } catch { /* Keep the encoded credential too. */ } }
      }
    } catch { /* An absent proxy has no additional credential. */ }
  }
  return values;
}

// Check only plain bounded arguments; no SDK objects, streams, functions, or
// transferable backing stores cross this protocol. Buffer views are copied.
export function prepareFeishuArguments(method: FeishuMethod, args: unknown[]) {
  if (!FEISHU_METHODS.includes(method) || !Array.isArray(args)) throw new Error("Invalid Feishu method");
  let bytes = 0;
  const clone = (value: unknown, depth = 0): unknown => {
    if (depth > 4) throw new Error("Invalid Feishu argument nesting");
    if (value === undefined || value === null || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") { bytes += Buffer.byteLength(value); return value; }
    if (value instanceof Uint8Array) {
      bytes += value.byteLength;
      if (value.byteLength > 30 * 1024 * 1024) throw new Error("Feishu media exceeds 30 MiB");
      return Buffer.from(value);
    }
    if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
      const result: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        if (["__proto__", "constructor", "prototype"].includes(key)) throw new Error("Invalid Feishu argument key");
        bytes += Buffer.byteLength(key);
        result[key] = clone(item, depth + 1);
      }
      return result;
    }
    throw new Error("Invalid Feishu argument type");
  };
  if (typeof args[0] !== "string" || !args[0]) throw new Error("Feishu target is required");
  if (method === "sendMediaBuffer") {
    if (!(args[1] instanceof Uint8Array)) throw new Error("Feishu media must be bytes");
    if (!args[1].byteLength) throw new Error("Feishu media is empty");
    const metadata = args[2] as Record<string, unknown> | undefined;
    if (String(metadata?.mime || "").startsWith("image/") && args[1].byteLength > 10 * 1024 * 1024) throw new Error("Feishu image exceeds 10 MiB");
  } else if (isFeishuStreamUpdate(method)) {
    if (typeof args[2] !== "string") throw new Error("Feishu stream text is required");
  } else if (method !== "downloadImage" && typeof args[1] !== "string") throw new Error("Feishu argument must be text");
  const result = args.map(value => clone(value));
  // Reserve the existing media cap for responses/downloads too; small request
  // arguments must not allow many simultaneous 50 MiB resource buffers.
  if (method === "downloadFile" || method === "downloadImage") bytes = Math.max(bytes, 50 * 1024 * 1024);
  if (method === "sendMedia") bytes = Math.max(bytes, 30 * 1024 * 1024);
  if (bytes > FEISHU_MAX_PENDING_BYTES) throw new Error("Feishu RPC byte budget exceeded");
  return { args: result, bytes };
}
