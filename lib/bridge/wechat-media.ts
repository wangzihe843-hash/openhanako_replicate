import dns from "node:dns";
import { BlockList, isIP } from "node:net";
import { isUint8Array } from "node:util/types";
import { Agent } from "undici";

// Local application budgets, not Tencent service limits. Allow one AES padding
// block on the wire; the adapter also checks the decrypted plaintext size.
export const WECHAT_MEDIA_MAX_BYTES = 50 * 1024 * 1024;
export const WECHAT_MEDIA_TIMEOUT_MS = 30_000;
export const WECHAT_BODY_TIMEOUT_MS = 10_000;
export const WECHAT_API_MAX_BYTES = 1024 * 1024;
const CDN_BASE = "https://novac2c.cdn.weixin.qq.com/c2c";
// The fixed Tencent 2.4.10 protocol documents this production CDN host only:
// https://github.com/Tencent/openclaw-weixin/blob/c6643f6f0ac03574eb126f2d69569ea4267cc3c6/docs/protocol_zh_CN.md
// Do not infer additional trusted hosts from a server-provided URL or a suffix.
const CDN_HOST = new URL(CDN_BASE).hostname;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export class WechatTransferError extends Error {
  readonly code: string;
  constructor(code: string) {
    // Never include URL, query, transport cause, response body or abort reason.
    super(`WeChat transfer: ${code}`);
    this.code = code;
    this.name = code === "cancelled" || code === "timeout" ? "AbortError" : "WechatTransferError";
  }
}

export function cancelWechatBody(body: { cancel(reason?: unknown): Promise<void> } | null | undefined) {
  try { void body?.cancel().catch(() => {}); } catch { /* Cleanup must not replace the original failure. */ }
}

export async function awaitWechatAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try { return await Promise.race([operation, aborted]); }
  finally { signal.removeEventListener("abort", onAbort!); }
}

export async function withWechatDeadline<T>(parent: AbortSignal | undefined, timeoutMs: number, action: (signal: AbortSignal, deadline: number) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort(new WechatTransferError("cancelled"));
  parent?.addEventListener("abort", cancel, { once: true });
  if (parent?.aborted) cancel();
  const timer = setTimeout(() => controller.abort(new WechatTransferError("timeout")), timeoutMs);
  try {
    controller.signal.throwIfAborted();
    return await action(controller.signal, Date.now() + timeoutMs);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", cancel);
  }
}

/** A single streaming read, with a byte cap and absolute (not idle) deadline. */
export async function readWechatBody(response: Response, maxBytes: number, parent?: AbortSignal): Promise<Buffer> {
  return withWechatDeadline(parent, WECHAT_BODY_TIMEOUT_MS, async (signal, deadline) => {
    const length = Number(response.headers.get("content-length"));
    if (Number.isFinite(length) && length > maxBytes) {
      cancelWechatBody(response.body);
      throw new WechatTransferError("body_too_large");
    }
    if (response.bodyUsed || response.body?.locked) throw new WechatTransferError("body_unavailable");
    if (!response.body) return Buffer.alloc(0);
    const reader = response.body.getReader();
    let complete = false;
    let cancelled = false;
    const cancel = () => { if (!cancelled) { cancelled = true; cancelWechatBody(reader); } };
    signal.addEventListener("abort", cancel, { once: true });
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        signal.throwIfAborted();
        if (Date.now() >= deadline) throw new WechatTransferError("timeout");
        const { done, value } = await awaitWechatAbort(reader.read(), signal);
        signal.throwIfAborted();
        if (Date.now() >= deadline) throw new WechatTransferError("timeout");
        if (done) { complete = true; return Buffer.concat(chunks, size); }
        if (!isUint8Array(value)) throw new WechatTransferError("invalid_body");
        size += value.byteLength;
        if (size > maxBytes) throw new WechatTransferError("body_too_large");
        if (value.byteLength) chunks.push(value);
      }
    } catch (error) {
      if (error instanceof WechatTransferError) throw error;
      throw new WechatTransferError("body_read_failed");
    } finally {
      signal.removeEventListener("abort", cancel);
      if (!complete) cancel();
      reader.releaseLock();
    }
  });
}

// Resolve at connection time and pass only checked addresses to the socket:
// there is no check-then-resolve DNS gap. IP literals need the same check below.
const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
  ["::", 96], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
  ["2001::", 32], ["2002::", 16], ["64:ff9b::", 96], ["64:ff9b:1::", 48],
] as const) blocked.addSubnet(address, prefix, "ipv6");

function blockedAddress(address: string) {
  const family = isIP(address);
  return !family || blocked.check(address, family === 6 ? "ipv6" : "ipv4");
}

export function assertWechatMediaUrl(value: unknown, cdn: boolean): URL {
  if (typeof value !== "string" || value.length > 16_384 || Array.from(value).some(char => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127 || char === "\\")) throw new WechatTransferError("invalid_url");
  let url: URL;
  try { url = new URL(value); } catch { throw new WechatTransferError("invalid_url"); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.hash) throw new WechatTransferError("invalid_url");
  if (cdn && (url.protocol !== "https:" || url.hostname !== CDN_HOST || url.port)) throw new WechatTransferError("untrusted_cdn_url");
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (isIP(host) ? blockedAddress(host) : !host.includes(".") || /(^|\.)(localhost|local|internal|lan|home|test|invalid)$/.test(host)) {
    throw new WechatTransferError("private_url");
  }
  return url;
}

/** Missing/blank full URL permits fallback; a present bad URL never does. */
export function selectWechatMediaUrl(full: unknown, param: unknown, filekey?: string): string {
  if (full !== undefined && full !== null && typeof full !== "string") throw new WechatTransferError("invalid_url");
  const value = typeof full === "string" ? full.trim() : "";
  if (value) return assertWechatMediaUrl(value, true).href;
  if (typeof param !== "string" || !param.trim()) throw new WechatTransferError("missing_url");
  return filekey === undefined
    ? `${CDN_BASE}/download?encrypted_query_param=${encodeURIComponent(param)}`
    : `${CDN_BASE}/upload?encrypted_query_param=${encodeURIComponent(param)}&filekey=${encodeURIComponent(filekey)}`;
}

export async function fetchWechatMedia(input: string, { signal: parent, cdn = true, body, maxBytes = WECHAT_MEDIA_MAX_BYTES }: {
  signal: AbortSignal; cdn?: boolean; body?: Uint8Array; maxBytes?: number;
}) {
  return withWechatDeadline(parent, WECHAT_MEDIA_TIMEOUT_MS, async signal => {
    let url = assertWechatMediaUrl(input, cdn);
    const dispatcher = new Agent({ connect: {
      lookup(hostname, options, callback) {
        dns.lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
          if (signal.aborted || error || !addresses?.length || addresses.some(row => blockedAddress(row.address))) {
            callback(new WechatTransferError("private_or_unresolved_host"), [], 4);
          } else if (options.all) callback(null, addresses, addresses[0].family);
          else callback(null, addresses[0].address, addresses[0].family);
        });
      },
    } });
    try {
      for (let hop = 0; hop <= 3; hop++) {
        signal.throwIfAborted();
        let response: Response | undefined;
        try {
          const request = fetch(url.href, {
            method: body ? "POST" : "GET",
            // API headers/cookies/referrer never enter this request lane.
            headers: body ? { "Content-Type": "application/octet-stream" } : {},
            body, redirect: "manual", credentials: "omit", referrerPolicy: "no-referrer", signal,
            dispatcher,
          } as RequestInit);
          void request.then(late => { if (signal.aborted) cancelWechatBody(late.body); }, () => {});
          response = await awaitWechatAbort(request, signal);
          signal.throwIfAborted();
          if (REDIRECTS.has(response.status)) {
            if (hop === 3 || (body && response.status !== 307 && response.status !== 308)) throw new WechatTransferError("redirect_rejected");
            const location = response.headers.get("location");
            if (!location) throw new WechatTransferError("redirect_missing_location");
            let next: URL;
            try { next = assertWechatMediaUrl(new URL(location, url).href, cdn); }
            catch { throw new WechatTransferError("untrusted_redirect"); }
            if (url.protocol === "https:" && next.protocol !== "https:") throw new WechatTransferError("untrusted_redirect");
            url = next;
            continue;
          }
          if (!response.ok) throw new WechatTransferError(`http_${response.status}`);
          const buffer = await readWechatBody(response, maxBytes, signal);
          signal.throwIfAborted();
          return { buffer, headers: response.headers };
        } finally {
          if (response && !response.bodyUsed && !response.body?.locked) cancelWechatBody(response.body);
        }
      }
      throw new WechatTransferError("redirect_rejected");
    } catch (error) {
      if (error instanceof WechatTransferError) throw error;
      throw new WechatTransferError("request_failed");
    } finally {
      // No connection pool or pending DNS/socket survives this transfer.
      void dispatcher.destroy().catch(() => {});
    }
  });
}
