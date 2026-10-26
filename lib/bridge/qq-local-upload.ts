import crypto from "crypto";
import fs from "fs";
import path from "path";
import type { FileHandle } from "node:fs/promises";
import { BridgeHttpRedirectError, type BridgeOutboundRequestOptions } from "./outbound-http.ts";

export const QQ_FILE_TYPE = Object.freeze({
  IMAGE: 1,
  VIDEO: 2,
  VOICE: 3,
  FILE: 4,
});

export const QQ_UPLOAD_SIZE_LIMITS = Object.freeze({
  [QQ_FILE_TYPE.IMAGE]: 30 * 1024 * 1024,
  [QQ_FILE_TYPE.VIDEO]: 100 * 1024 * 1024,
  [QQ_FILE_TYPE.VOICE]: 20 * 1024 * 1024,
  [QQ_FILE_TYPE.FILE]: 100 * 1024 * 1024,
});

const MD5_10M_SIZE = 10_002_432;
const MAX_CONCURRENT_PARTS = 10;
const PART_UPLOAD_TIMEOUT_MS = 300_000;
const PART_UPLOAD_MAX_RETRIES = 2;
const PART_FINISH_RETRYABLE_CODE = 40093001;
const MAX_PART_FINISH_RETRY_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_PART_FINISH_RETRY_DELAY_MS = 30_000;

interface UploadOptions {
  apiRequest: (method: string, endpoint: string, body: Record<string, unknown>, options: { stage: string; signal?: AbortSignal }) => Promise<unknown>;
  outboundHttp: { request: (options: BridgeOutboundRequestOptions) => Promise<{ ok: boolean; status: number; body?: { cancel(): Promise<void> } }> };
  chatId: string;
  filePath: string;
  fileType: number;
  metadata?: { isGroup?: boolean; filename?: string };
  signal?: AbortSignal;
}

export class QQApiError extends Error {
  declare status: any;
  declare path: any;
  declare bizCode: any;

  constructor(message: any, { status, path: requestPath, bizCode }: any = {}) {
    super(message);
    this.name = "QQApiError";
    this.status = status;
    this.path = requestPath;
    this.bizCode = bizCode;
  }
}

/** The optional signal is upload-scoped; adapter stop wiring is a separate concern. */
export async function uploadQQLocalFile({ apiRequest, outboundHttp, chatId, filePath, fileType, metadata = {}, signal }: UploadOptions) {
  if (typeof outboundHttp?.request !== "function" || typeof apiRequest !== "function") {
    throw new Error("uploadQQLocalFile 需要注入 apiRequest 和 outboundHttp");
  }
  signal?.throwIfAborted();
  if (!(Object.values(QQ_FILE_TYPE) as number[]).includes(fileType)) throw new Error("QQ 无效文件类型");
  if (metadata.isGroup === true && fileType === QQ_FILE_TYPE.FILE) {
    throw new Error("QQ 群聊暂不开放文件类型发送，请改用单聊或发送图片/视频/语音");
  }
  // A failed/unknown upload must not start a second upload in another scope.
  const base = metadata.isGroup === true ? `/v2/groups/${chatId}` : `/v2/users/${chatId}`;
  if (!(await fs.promises.stat(filePath)).isFile()) throw new Error("QQ 只能上传普通文件");
  signal?.throwIfAborted();
  const file = await fs.promises.open(filePath, "r");
  try {
    signal?.throwIfAborted();
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error("QQ 只能上传普通文件");
    if (stat.size === 0) throw new Error("QQ 不能发送空文件");
    const maxBytes = QQ_UPLOAD_SIZE_LIMITS[fileType];
    if (!Number.isSafeInteger(stat.size) || stat.size > maxBytes) {
      throw new Error(`QQ ${qqTypeName(fileType)}过大，超过 ${formatBytes(maxBytes)} 限制`);
    }

    const fileName = sanitizeUploadFileName(metadata.filename || path.basename(filePath));
    const hashes = await computeLocalFileHashes(file, stat.size, signal);
    const prepared = await uploadRequest(apiRequest, `${base}/upload_prepare`, {
      file_type: fileType, file_name: fileName, file_size: String(stat.size), ...hashes,
    }, "upload_prepare", signal);
    const { uploadId, parts, concurrency, retryTimeoutMs, retryDelayMs } = parsePrepare(prepared, stat.size);

    // Validate every part before any PUT; on failure abort siblings and drain them.
    const controller = new AbortController();
    const uploadSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    await runWithConcurrency(parts.map(part => async () => {
      uploadSignal.throwIfAborted();
      const chunk = await readFileChunk(file, part.offset, part.length, uploadSignal);
      const md5 = crypto.createHash("md5").update(chunk).digest("hex");
      await putToPresignedUrl(outboundHttp, part.url, chunk, uploadSignal);
      await finishUploadPart(apiRequest, `${base}/upload_part_finish`, {
        upload_id: uploadId, part_index: part.index, block_size: String(chunk.length), md5,
      }, retryTimeoutMs, retryDelayMs, uploadSignal);
    }), concurrency, controller);

    signal?.throwIfAborted();
    const finalStat = await file.stat();
    if (finalStat.size !== stat.size || finalStat.mtimeMs !== stat.mtimeMs || finalStat.ctimeMs !== stat.ctimeMs) {
      throw new Error("QQ 上传期间文件发生变化");
    }
    // A lost merge response is an unknown outcome, not permission to repeat it.
    const result = await uploadRequest(apiRequest, `${base}/files`, {
      upload_id: uploadId, file_type: fileType, file_name: fileName, srv_send_msg: false,
    }, "upload_complete", signal);
    if (typeof result?.file_info !== "string" || !result.file_info.trim()) {
      throw new Error("QQ 本地文件上传未返回有效 file_info");
    }
    return result;
  } finally {
    await file.close();
  }
}

function qqTypeName(fileType: number) {
  if (fileType === QQ_FILE_TYPE.IMAGE) return "图片";
  if (fileType === QQ_FILE_TYPE.VIDEO) return "视频";
  if (fileType === QQ_FILE_TYPE.VOICE) return "语音";
  return "文件";
}

function formatBytes(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function sanitizeUploadFileName(value: unknown) {
  const base = path.basename(String(value || "file"));
  const cleaned = Array.from(base, char => {
    const code = char.charCodeAt(0);
    return code <= 0x1F || code === 0x7F ? "_" : char;
  }).join("").trim();
  return cleaned.slice(0, 128) || "file";
}

function invalidPrepare(): never {
  throw new Error("QQ upload_prepare 返回了无效分片或上传配置");
}

function positiveByteString(value: unknown): number {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return invalidPrepare();
  const number = Number(value);
  if (!Number.isSafeInteger(number)) return invalidPrepare();
  return number;
}

function configInteger(value: unknown, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return invalidPrepare();
  return Math.min(value, max);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parsePrepare(response: unknown, fileSize: number) {
  // APIv2 upload_prepare: zero-based index, decimal byte strings, nested config.
  // https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_id_upload_prepare.post.html
  if (!isRecord(response) || typeof response.upload_id !== "string" || !response.upload_id.trim()) return invalidPrepare();
  const block = positiveByteString(response.block_size);
  const count = Math.ceil(fileSize / block);
  if (!Array.isArray(response.parts) || response.parts.length !== count) return invalidPrepare();
  const config = response.upload_config ?? {};
  if (!isRecord(config) || response.upload_config === null) return invalidPrepare();
  const concurrency = configInteger(config.concurrency, 1, MAX_CONCURRENT_PARTS);
  const retryTimeoutMs = configInteger(config.retry_timeout, 300, MAX_PART_FINISH_RETRY_TIMEOUT_MS / 1000) * 1000;
  const retryDelayMs = configInteger(config.retry_delay, 1, MAX_PART_FINISH_RETRY_DELAY_MS / 1000) * 1000;
  const seen = new Set<number>();
  const parts = response.parts.map((part: unknown) => {
    if (!isRecord(part) || typeof part.index !== "number" || !Number.isSafeInteger(part.index) || part.index < 0 || part.index >= count || seen.has(part.index)) return invalidPrepare();
    seen.add(part.index);
    const offset = part.index * block;
    const length = Math.min(block, fileSize - offset);
    if (positiveByteString(part.block_size) !== length) return invalidPrepare();
    let url: URL;
    if (typeof part.presigned_url !== "string") return invalidPrepare();
    try { url = new URL(part.presigned_url); } catch { return invalidPrepare(); }
    if (url.protocol !== "https:" || url.username || url.password || url.hash) return invalidPrepare();
    return { index: part.index, offset, length, url: part.presigned_url };
  });
  return { uploadId: response.upload_id, parts, concurrency, retryTimeoutMs, retryDelayMs };
}

async function computeLocalFileHashes(file: FileHandle, fileSize: number, signal?: AbortSignal) {
  const md5 = crypto.createHash("md5");
  const sha1 = crypto.createHash("sha1");
  const md5First10m = crypto.createHash("md5");
  let bytesRead = 0;
  // One descriptor throughout: replacing the path cannot change later part bytes.
  for (let offset = 0; offset < fileSize; offset += 64 * 1024) {
    const buffer = await readFileChunk(file, offset, Math.min(64 * 1024, fileSize - offset), signal);
    md5.update(buffer);
    sha1.update(buffer);
    const remaining = MD5_10M_SIZE - bytesRead;
    if (remaining > 0) md5First10m.update(buffer.subarray(0, remaining));
    bytesRead += buffer.length;
  }
  return { md5: md5.digest("hex"), sha1: sha1.digest("hex"), md5_10m: md5First10m.digest("hex") };
}

async function readFileChunk(file: FileHandle, offset: number, length: number, signal?: AbortSignal) {
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    signal?.throwIfAborted();
    const { bytesRead } = await file.read(buffer, read, length - read, offset + read);
    if (!bytesRead) throw new Error("QQ 上传期间文件被截断");
    read += bytesRead;
  }
  signal?.throwIfAborted();
  return buffer;
}

async function putToPresignedUrl(outboundHttp: UploadOptions["outboundHttp"], url: string, buffer: Buffer, signal: AbortSignal) {
  const body = new Blob([buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer]);
  const res = await outboundHttp.request({
    stage: "upload_part_put", url, method: "PUT", body, signal,
    headers: { "Content-Length": String(buffer.length) },
    timeoutMs: PART_UPLOAD_TIMEOUT_MS, idempotent: true, maxRetries: PART_UPLOAD_MAX_RETRIES,
  });
  // COS PUT has no consumed body. Discard both success and error bodies, which may
  // echo signatures/secrets or never finish; header status decides PUT success.
  try { await res.body?.cancel?.(); } catch { /* failure still cannot advance */ }
  signal.throwIfAborted();
  if (!res.ok) throw new Error(`QQ part upload failed (HTTP ${res.status})`);
}

async function uploadRequest(apiRequest: UploadOptions["apiRequest"], endpoint: string, body: Record<string, unknown>, stage: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  let result;
  try {
    result = await apiRequest("POST", endpoint, body, { stage, signal });
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof BridgeHttpRedirectError) throw error;
    if (error instanceof QQApiError) {
      // Keep structured codes for retry decisions; never repeat remote error text.
      const bizCode = numericCode(error.bizCode);
      throw new QQApiError(`QQ ${stage} failed (HTTP ${error.status}, code ${bizCode ?? "unknown"})`, {
        status: error.status, path: endpoint, bizCode,
      });
    }
    throw error;
  }
  signal?.throwIfAborted();
  if (!isRecord(result)) throw new Error(`QQ ${stage} 返回格式异常`);
  for (const value of [result.code, result.err_code]) {
    if (value === undefined || value === 0 || value === "0") continue;
    const bizCode = numericCode(value);
    throw new QQApiError(`QQ ${stage} failed (code ${bizCode ?? "unknown"})`, { path: endpoint, bizCode });
  }
  return result;
}

function numericCode(value: unknown) {
  return (typeof value === "number" || (typeof value === "string" && /^\d+$/.test(value))) && Number.isSafeInteger(Number(value))
    ? Number(value) : undefined;
}

async function finishUploadPart(apiRequest: UploadOptions["apiRequest"], endpoint: string, body: Record<string, unknown>, retryTimeoutMs: number, retryDelayMs: number, signal: AbortSignal) {
  const controller = new AbortController();
  const finishSignal = AbortSignal.any([signal, controller.signal]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    while (true) {
      try {
        await uploadRequest(apiRequest, endpoint, body, "upload_part_finish", finishSignal);
        return;
      } catch (error) {
        finishSignal.throwIfAborted();
        if (!(error instanceof QQApiError) || error.bizCode !== PART_FINISH_RETRYABLE_CODE) throw error;
        // Only the documented BDH-not-ready business error authorizes polling.
        timer ??= setTimeout(() => controller.abort(new Error("QQ upload_part_finish 重试超时")), retryTimeoutMs);
        await waitForRetry(retryDelayMs, finishSignal);
      }
    }
  } finally { clearTimeout(timer); }
}

function waitForRetry(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); cleanup(); reject(signal.reason); };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

async function runWithConcurrency(tasks: Array<() => Promise<void>>, concurrency: number, controller: AbortController) {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    try {
      while (next < tasks.length) {
        controller.signal.throwIfAborted();
        await tasks[next++]();
      }
    } catch (error) {
      if (!controller.signal.aborted) controller.abort(error);
      throw error;
    }
  });
  await Promise.allSettled(workers);
  controller.signal.throwIfAborted();
}
