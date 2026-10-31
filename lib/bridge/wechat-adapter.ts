/*!
 * wechat-adapter.js — 微信 iLink Bridge Adapter
 *
 * 基于腾讯 iLink 协议（ilinkai.weixin.qq.com）实现。
 * 参考 @tencent-weixin/openclaw-weixin v1.0.2 源码（MIT 协议）。
 * Media URL field compatibility: Tencent v2.4.10, commit
 * c6643f6f0ac03574eb126f2d69569ea4267cc3c6 (docs/protocol_zh_CN.md).
 *
 * Copyright (C) 2026 Tencent. All rights reserved.
 * Permission is hereby granted, free of charge, to any person obtaining
 * a copy of this software and associated documentation files (the
 * "Software"), to deal in the Software without restriction, including
 * without limitation the rights to use, copy, modify, merge, publish,
 * distribute, sublicense, and/or sell copies of the Software, and to
 * permit persons to whom the Software is furnished to do so, subject to
 * the following conditions:
 * The above copyright notice and this permission notice shall be
 * included in all copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
 * EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
 * MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
 * IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
 * CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
 * TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
 * SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { atomicWriteSync } from "../../shared/safe-fs.ts";
import { debugLog } from "../debug-log.ts";
import { createMediaCapabilities } from "./media-capabilities.ts";
import { createReceiptCapabilities } from "./receipt-capabilities.ts";
import {
  createIlinkMediaAesKey,
  decodeIlinkMediaAesKey,
  encodeIlinkMediaAesKey,
} from "./wechat-ilink-media-crypto.ts";
import { createModuleLogger } from "../debug-log.ts";
import { redactLogText } from "../../shared/log-redactor.ts";
import { normalizeWechatBaseUrl } from "../../shared/wechat-endpoint.ts";
import { readWechatApiResponse, WechatApiError } from "./wechat-api.ts";
import {
  awaitWechatAbort, cancelWechatBody, fetchWechatMedia, selectWechatMediaUrl,
  WECHAT_MEDIA_MAX_BYTES, WechatTransferError, withWechatDeadline,
} from "./wechat-media.ts";

const log = createModuleLogger("wechat");

export const WECHAT_ILINK_MEDIA_CAPABILITIES = createMediaCapabilities({
  platform: "wechat",
  productSurface: "ilink",
  inputModes: ["buffer", "remote_url", "public_url"],
  supportedKinds: ["image", "video", "audio", "document"],
  requiresReplyContext: true,
  deliveryByKind: {
    image: "native_image",
    video: "native_file",
    audio: "native_file",
    document: "native_file",
  },
  source: "lib/bridge/wechat-adapter.ts#WECHAT_ILINK_MEDIA_CAPABILITIES",
});

export const WECHAT_ILINK_RECEIPT_CAPABILITIES = createReceiptCapabilities({
  platform: "wechat",
  mode: "native_typing",
  scopes: ["dm"],
  cancellable: true,
  source: "https://github.com/Tencent/openclaw-weixin#getconfig",
});

const LONG_POLL_TIMEOUT_MS = 40_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_DELAYS = [2000, 5000, 30_000];
const CONTEXT_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const MSG_CHUNK_LIMIT = 4000;

// ── iLink 消息类型常量 ──

const MessageItemType = { TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 };
const MessageType = { USER: 1, BOT: 2 };
const MessageState = { FINISH: 2 };
const UploadMediaType = { IMAGE: 1, VIDEO: 2, FILE: 3 };

// ── AES-128-ECB 加解密 ──

function encryptAesEcb(plaintext, key) {
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

function decryptAesEcb(ciphertext, key) {
  const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function aesEcbPaddedSize(plaintextSize) {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

// ── iLink HTTP API ──

function randomWechatUin() {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

function buildHeaders(token) {
  return {
    "Content-Type": "application/json",
    "AuthorizationType": "ilink_bot_token",
    "X-WECHAT-UIN": randomWechatUin(),
    ...(token ? { "Authorization": `Bearer ${token}` } : {}),
  };
}

/**
 * @param {AbortSignal} [parentSignal] - 外部 signal（adapter 级别），用于 stop() 中断所有请求
 */
async function apiPost(baseUrl, endpoint, body, token, timeoutMs, parentSignal) {
  const url = new URL(endpoint, baseUrl.endsWith("/") ? baseUrl : baseUrl + "/");
  return withWechatDeadline(parentSignal, timeoutMs || 15_000, async signal => {
    let res: Response | undefined;
    const init = { method: "POST", headers: buildHeaders(token), body: JSON.stringify(body), signal, redirect: "manual" as const };
    signal.throwIfAborted();
    try {
      const request = fetch(url.toString(), init);
      void request.then(late => { if (signal.aborted) cancelWechatBody(late.body); }, () => {});
      res = await awaitWechatAbort(request, signal);
      signal.throwIfAborted();
      if (res.status >= 300 && res.status < 400) throw new WechatTransferError("api_redirect_rejected");
      return await readWechatApiResponse(endpoint, res, signal);
    } catch (err) {
      const rejected = (res?.status >= 400 && res?.status < 500)
        || (res?.ok && err instanceof WechatApiError && err.code !== "WECHAT_PROTOCOL_ERROR")
        || (err instanceof WechatTransferError && err.code === "api_redirect_rejected");
      if (endpoint === "ilink/bot/sendmessage" && !rejected) {
        // No request body, context token, transport cause or arbitrary server
        // response may escape in the diagnostic for an uncertain persistent send.
        throw Object.assign(new Error("WeChat delivery outcome unknown; not automatically resent."), {
          deliveryUnknown: true, retryable: false,
        });
      }
      if (err instanceof WechatApiError || err instanceof WechatTransferError) throw err;
      const safeError = new Error(redactLogText(err?.message || String(err)));
      if (err?.name === "AbortError") safeError.name = "AbortError";
      throw safeError;
    } finally {
      if (res && !res.bodyUsed && !res.body?.locked) cancelWechatBody(res.body);
    }
  });
}

// ── Cursor 持久化 ──

function hash8(str) {
  return crypto.createHash("sha256").update(str).digest("hex").slice(0, 8);
}

function resolveSyncBufPath(hanaHome, botToken) {
  const dir = path.join(hanaHome, "bridge", "wechat");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `sync-${hash8(botToken)}.json`);
}

function resolveContextCachePath(hanaHome, botToken) {
  const dir = path.join(hanaHome, "bridge", "wechat");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `context-${hash8(botToken)}.json`);
}

function loadSyncBuf(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      return data.get_updates_buf || "";
    }
  } catch { /* ignore */ }
  return "";
}

function saveSyncBuf(filePath, buf) {
  try {
    atomicWriteSync(filePath, JSON.stringify({ get_updates_buf: buf }));
  } catch { /* ignore */ }
}

function loadContextCache(filePath, now = Date.now()) {
  const cache = new Map();
  if (!filePath) return cache;
  try {
    if (!fs.existsSync(filePath)) return cache;
    const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    const entries = data?.entries && typeof data.entries === "object" ? data.entries : {};
    for (const [chatId, raw] of Object.entries(entries) as [string, any][]) {
      const token = typeof raw?.token === "string" ? raw.token : "";
      const ts = Number(raw?.ts);
      const expiresAt = Number(raw?.expiresAt || (Number.isFinite(ts) ? ts + CONTEXT_TOKEN_TTL_MS : 0));
      if (!chatId || !token || !Number.isFinite(ts) || !Number.isFinite(expiresAt)) continue;
      if (expiresAt <= now) continue;
      cache.set(chatId, { token, ts });
    }
  } catch { /* ignore */ }
  return cache;
}

function saveContextCache(filePath, cache, now = Date.now()) {
  if (!filePath) return;
  try {
    const entries = {};
    for (const [chatId, entry] of cache.entries()) {
      if (!entry?.token || !Number.isFinite(entry.ts)) continue;
      const expiresAt = entry.ts + CONTEXT_TOKEN_TTL_MS;
      if (expiresAt <= now) continue;
      entries[chatId] = { token: entry.token, ts: entry.ts, expiresAt };
    }
    atomicWriteSync(filePath, JSON.stringify({
      version: 1,
      updatedAt: new Date(now).toISOString(),
      entries,
    }));
  } catch { /* ignore */ }
}

// ── 消息文本提取 ──

function extractText(itemList) {
  if (!itemList?.length) return "";
  for (const item of itemList) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text != null) {
      const text = String(item.text_item.text);
      const ref = item.ref_msg;
      if (!ref) return text;
      if (ref.message_item && isMediaItem(ref.message_item)) return text;
      const parts = [];
      if (ref.title) parts.push(ref.title);
      if (ref.message_item) {
        const refBody = extractText([ref.message_item]);
        if (refBody) parts.push(refBody);
      }
      if (!parts.length) return text;
      return `[引用: ${parts.join(" | ")}]\n${text}`;
    }
    if (item.type === MessageItemType.VOICE && item.voice_item?.text) {
      return item.voice_item.text;
    }
  }
  return "";
}

function isMediaItem(item) {
  return [MessageItemType.IMAGE, MessageItemType.VIDEO, MessageItemType.FILE, MessageItemType.VOICE].includes(item.type);
}

// ── Adapter 主函数 ──

/**
 * @param {object} opts
 * @param {string} opts.botToken
 * @param {string} [opts.baseUrl] - verified iLink endpoint; omitted legacy configs keep the default
 * @param {string} [opts.hanaHome] - hanaHome 路径，用于 cursor 持久化
 * @param {(msg: object) => void} opts.onMessage
 * @param {(status: string, error?: string) => void} [opts.onStatus]
 */
export function createWechatAdapter({ botToken, baseUrl: configuredBaseUrl = undefined, hanaHome, agentId, onMessage, onStatus }) {
  const baseUrl = normalizeWechatBaseUrl(configuredBaseUrl);
  let generation = 0;
  const abortController = new AbortController();
  let state: "active" | "expired" | "stopped" = "active";
  const timers = new Map<ReturnType<typeof setTimeout>, (alive: boolean) => void>();
  let lastStatus = null;
  let lastError = null;

  const syncBufPath = hanaHome ? resolveSyncBufPath(hanaHome, botToken) : null;
  const contextCachePath = hanaHome ? resolveContextCachePath(hanaHome, botToken) : null;
  let getUpdatesBuf = syncBufPath ? loadSyncBuf(syncBufPath) : "";
  const contextCache = loadContextCache(contextCachePath); // chatId → { token, ts }
  const typingTicketCache = new Map(); // chatId → { contextToken, ticket }
  // Bridge prefetch and attachment resolution can overlap. Share only in-flight
  // work within this adapter; never retain signed references or completed bytes.
  const mediaDownloads = new Map<string, Promise<Buffer>>();

  /** apiPost 带上当前 abortController.signal，stop() 时自动中断所有请求 */
  function assertActive(myGen = generation) {
    if (state === "expired") throw new WechatApiError("微信 session expired", -14);
    if (state !== "active" || myGen !== generation) throw new Error("微信: adapter stopped");
  }

  function clearPending() {
    abortController.abort();
    for (const [timer, resolve] of timers) { clearTimeout(timer); resolve(false); }
    timers.clear();
    typingTicketCache.clear();
    mediaDownloads.clear();
  }

  async function api(endpoint, body, timeoutMs?, myGen = generation) {
    assertActive(myGen);
    try {
      const response = await apiPost(baseUrl, endpoint, body, botToken, timeoutMs, abortController.signal);
      if (endpoint !== "ilink/bot/sendmessage") assertActive(myGen);
      return response;
    } catch (err) {
      // Preserve the send outcome before the stale-generation fence can replace
      // it with an ordinary stopped/expired error and enable another delivery.
      if (err?.deliveryUnknown) throw err;
      // A response from a stopped/expired generation cannot change its state.
      assertActive(myGen);
      if (err instanceof WechatApiError && err.sessionExpired) {
        state = "expired";
        generation++;
        clearPending();
        reportStatus("error", "session expired");
      }
      throw err;
    }
  }

  // ── 定时器管理 ──

  function guardedSleep(ms, myGen) {
    if (state !== "active" || myGen !== generation) return Promise.resolve(false);
    return new Promise((resolve) => {
      const id = setTimeout(() => { timers.delete(id); resolve(myGen === generation); }, ms);
      timers.set(id, resolve);
    });
  }

  // ── context_token 管理 ──

  function setContextToken(chatId, token) {
    const prev = contextCache.get(chatId)?.token;
    contextCache.set(chatId, { token, ts: Date.now() });
    if (prev !== token) typingTicketCache.delete(chatId);
    saveContextCache(contextCachePath, contextCache);
  }

  function getContextToken(chatId) {
    const entry = contextCache.get(chatId);
    if (!entry) return null;
    if (Date.now() - entry.ts > CONTEXT_TOKEN_TTL_MS) {
      contextCache.delete(chatId);
      saveContextCache(contextCachePath, contextCache);
      return null;
    }
    return entry.token;
  }

  function reportStatus(status, error?) {
    const normalizedError = error ? redactLogText(error) : null;
    if (lastStatus === status && lastError === normalizedError) return;
    lastStatus = status;
    lastError = normalizedError;
    if (normalizedError === null) {
      onStatus?.(status);
      return;
    }
    onStatus?.(status, normalizedError);
  }

  function downloadEncryptedMedia(platformRef: string) {
    assertActive();
    const pending = mediaDownloads.get(platformRef);
    if (pending) return pending;
    const request = readEncryptedMedia(platformRef);
    mediaDownloads.set(platformRef, request);
    void request.finally(() => {
      if (mediaDownloads.get(platformRef) === request) mediaDownloads.delete(platformRef);
    }).catch(() => {});
    return request;
  }

  async function readEncryptedMedia(platformRef) {
    const myGen = generation;
    assertActive(myGen);
    let ref;
    try { ref = JSON.parse(platformRef); } catch { throw new WechatTransferError("invalid_media_ref"); }
    if (!ref || typeof ref !== "object" || Array.isArray(ref)) throw new WechatTransferError("invalid_media_ref");
    const cdnUrl = selectWechatMediaUrl(ref.full_url, ref.encrypt_query_param);
    let key: Buffer | undefined;
    try { if (ref.aes_key) key = decodeIlinkMediaAesKey(ref.aes_key); }
    catch { throw new WechatTransferError("invalid_aes_key"); }
    const { buffer } = await fetchWechatMedia(cdnUrl, {
      signal: abortController.signal, maxBytes: WECHAT_MEDIA_MAX_BYTES + (key ? 16 : 0),
    });
    assertActive(myGen);
    let plaintext: Buffer;
    try { plaintext = key ? decryptAesEcb(buffer, key) : buffer; }
    catch { throw new WechatTransferError("decrypt_failed"); }
    if (plaintext.length > WECHAT_MEDIA_MAX_BYTES) throw new WechatTransferError("body_too_large");
    return plaintext;
  }

  // ── 发送消息 ──

  async function sendText(chatId, text, contextToken, myGen) {
    if (!contextToken) throw new Error("微信: 需要对方最近发过消息才能回复");
    await api("ilink/bot/sendmessage", {
      msg: {
        from_user_id: "",
        to_user_id: chatId,
        client_id: crypto.randomUUID(),
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        item_list: text ? [{ type: MessageItemType.TEXT, text_item: { text } }] : undefined,
        context_token: contextToken,
      },
      base_info: { channel_version: "1.0.0" },
    }, undefined, myGen);
  }

  async function getTypingTicket(chatId, myGen) {
    assertActive(myGen);
    const contextToken = getContextToken(chatId);
    if (!contextToken) throw new Error("微信: 需要对方最近发过消息才能发送正在输入状态");
    const cached = typingTicketCache.get(chatId);
    if (cached?.contextToken === contextToken && cached.ticket) return cached.ticket;
    const resp = await api("ilink/bot/getconfig", {
      ilink_user_id: chatId,
      context_token: contextToken,
      base_info: { channel_version: "1.0.0" },
    }, 10_000, myGen);
    assertActive(myGen);
    const ticket = resp?.typing_ticket;
    if (!ticket) throw new Error("微信: getconfig 未返回 typing_ticket");
    typingTicketCache.set(chatId, { contextToken, ticket });
    return ticket;
  }

  async function sendTypingStatus(chatId, status) {
    const myGen = generation;
    assertActive(myGen);
    const typingTicket = await getTypingTicket(chatId, myGen);
    await api("ilink/bot/sendtyping", {
      ilink_user_id: chatId,
      typing_ticket: typingTicket,
      status,
      base_info: { channel_version: "1.0.0" },
    }, 10_000, myGen);
  }

  // ── CDN 媒体上传 ──

  async function uploadMedia(buffer, toUserId, mediaType, myGen) {
    assertActive(myGen);
    const rawsize = buffer.length;
    if (rawsize > WECHAT_MEDIA_MAX_BYTES) throw new WechatTransferError("body_too_large");
    const rawfilemd5 = crypto.createHash("md5").update(buffer).digest("hex");
    const filesize = aesEcbPaddedSize(rawsize);
    const filekey = crypto.randomBytes(16).toString("hex");
    const { rawKey, aesKeyHex } = createIlinkMediaAesKey();

    const uploadResp = await api("ilink/bot/getuploadurl", {
      filekey, media_type: mediaType, to_user_id: toUserId,
      rawsize, rawfilemd5, filesize,
      no_need_thumb: true,
      aeskey: aesKeyHex,
      base_info: { channel_version: "1.0.0" },
    }, undefined, myGen);

    assertActive(myGen);
    const cdnUrl = selectWechatMediaUrl(uploadResp.upload_full_url, uploadResp.upload_param, filekey);
    const ciphertext = encryptAesEcb(buffer, rawKey);
    const cdnRes = await fetchWechatMedia(cdnUrl, {
      signal: abortController.signal, body: new Uint8Array(ciphertext), maxBytes: 64 * 1024,
    });
    assertActive(myGen);
    const downloadParam = cdnRes.headers.get("x-encrypted-param");
    if (!downloadParam) throw new Error("CDN 未返回 x-encrypted-param");

    return { filekey, downloadParam, aesKeyHex, fileSize: rawsize, fileSizeCiphertext: filesize };
  }

  async function sendImageMessage(chatId, uploaded, contextToken, caption, myGen) {
    const items = [];
    if (caption) items.push({ type: MessageItemType.TEXT, text_item: { text: caption } });
    items.push({
      type: MessageItemType.IMAGE,
      image_item: {
        media: {
          encrypt_query_param: uploaded.downloadParam,
          aes_key: encodeIlinkMediaAesKey(uploaded.aesKeyHex),
          encrypt_type: 1,
        },
        mid_size: uploaded.fileSizeCiphertext,
      },
    });
    for (const item of items) {
      await api("ilink/bot/sendmessage", {
        msg: {
          from_user_id: "", to_user_id: chatId,
          client_id: crypto.randomUUID(),
          message_type: MessageType.BOT, message_state: MessageState.FINISH,
          item_list: [item], context_token: contextToken,
        },
        base_info: { channel_version: "1.0.0" },
      }, undefined, myGen);
    }
  }

  async function sendFileMessage(chatId, uploaded, contextToken, filename, myGen) {
    await api("ilink/bot/sendmessage", {
      msg: {
        from_user_id: "", to_user_id: chatId,
        client_id: crypto.randomUUID(),
        message_type: MessageType.BOT, message_state: MessageState.FINISH,
        item_list: [{
          type: MessageItemType.FILE,
          file_item: {
            media: {
              encrypt_query_param: uploaded.downloadParam,
              aes_key: encodeIlinkMediaAesKey(uploaded.aesKeyHex),
              encrypt_type: 1,
            },
            file_name: filename,
            len: String(uploaded.fileSize),
          },
        }],
        context_token: contextToken,
      },
      base_info: { channel_version: "1.0.0" },
    }, undefined, myGen);
  }

  // ── 入站消息处理 ──

  function handleInbound(msg) {
    const fromUserId = msg.from_user_id || "";
    if (!fromUserId || fromUserId.endsWith("@im.bot")) return;

    if (msg.context_token) {
      setContextToken(fromUserId, msg.context_token);
    }

    const text = extractText(msg.item_list);
    const attachments = [];

    for (const item of msg.item_list || []) {
      if (item.type === MessageItemType.IMAGE && (item.image_item?.media?.full_url || item.image_item?.media?.encrypt_query_param)) {
        const aesKey = item.image_item.aeskey
          ? encodeIlinkMediaAesKey(item.image_item.aeskey)
          : item.image_item.media.aes_key;
        attachments.push({
          type: "image",
          platformRef: JSON.stringify({
            full_url: item.image_item.media.full_url,
            encrypt_query_param: item.image_item.media.encrypt_query_param,
            aes_key: aesKey,
          }),
          mimeType: "image/jpeg",
        });
      } else if (item.type === MessageItemType.FILE && (item.file_item?.media?.full_url || item.file_item?.media?.encrypt_query_param)) {
        attachments.push({
          type: "file",
          platformRef: JSON.stringify({
            full_url: item.file_item.media.full_url,
            encrypt_query_param: item.file_item.media.encrypt_query_param,
            aes_key: item.file_item.media.aes_key,
          }),
          filename: item.file_item.file_name,
          size: Number.isFinite(Number(item.file_item.len)) ? Number(item.file_item.len) : undefined,
          mimeType: "application/octet-stream",
        });
      } else if (item.type === MessageItemType.VIDEO && (item.video_item?.media?.full_url || item.video_item?.media?.encrypt_query_param)) {
        attachments.push({
          type: "video",
          platformRef: JSON.stringify({
            full_url: item.video_item.media.full_url,
            encrypt_query_param: item.video_item.media.encrypt_query_param,
            aes_key: item.video_item.media.aes_key,
          }),
          mimeType: "video/mp4",
        });
      }
      // 语音有转文字，已通过 extractText 处理，不单独附件
    }

    // 引用消息里的媒体
    if (!attachments.length) {
      for (const item of msg.item_list || []) {
        if (item.type === MessageItemType.TEXT && item.ref_msg?.message_item) {
          const ref = item.ref_msg.message_item;
          if (ref.type === MessageItemType.IMAGE && (ref.image_item?.media?.full_url || ref.image_item?.media?.encrypt_query_param)) {
            const aesKey = ref.image_item.aeskey
              ? encodeIlinkMediaAesKey(ref.image_item.aeskey)
              : ref.image_item.media.aes_key;
            attachments.push({
              type: "image",
              platformRef: JSON.stringify({
                full_url: ref.image_item.media.full_url,
                encrypt_query_param: ref.image_item.media.encrypt_query_param,
                aes_key: aesKey,
              }),
              mimeType: "image/jpeg",
            });
          }
        }
      }
    }

    if (!text && !attachments.length) return;

    onMessage({
      platform: "wechat",
      agentId,
      chatId: fromUserId,
      userId: fromUserId,
      sessionKey: `wx_dm_${fromUserId}@${agentId}`,
      text,
      senderName: fromUserId.split("@")[0] || "微信用户",
      isGroup: false,
      attachments: attachments.length ? attachments : undefined,
    });
  }

  // ── 长轮询主循环 ──

  async function pollLoop() {
    const myGen = generation;
    let consecutiveFailures = 0;

    while (myGen === generation) {
      try {
        const resp = await api("ilink/bot/getupdates", {
          get_updates_buf: getUpdatesBuf,
          base_info: { channel_version: "1.0.0" },
        }, LONG_POLL_TIMEOUT_MS, myGen);

        if (myGen !== generation) return;

        consecutiveFailures = 0;
        reportStatus("connected");
        if (myGen !== generation) return;

        if (resp.get_updates_buf) {
          getUpdatesBuf = resp.get_updates_buf;
          if (syncBufPath) saveSyncBuf(syncBufPath, getUpdatesBuf);
        }

        for (const msg of resp.msgs || []) {
          if (myGen !== generation) return;
          try { handleInbound(msg); } catch (err) {
            log.error(`handleInbound error: ${err.message}`);
          }
        }
      } catch (err) {
        if (myGen !== generation) return;
        if (err.name === "AbortError") continue; // 长轮询超时，正常
        consecutiveFailures++;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          reportStatus("error", err.message);
        }
        const delay = BACKOFF_DELAYS[Math.min(consecutiveFailures - 1, BACKOFF_DELAYS.length - 1)];
        const alive = await guardedSleep(delay, myGen);
        if (!alive) return;
      }
    }
  }

  // 启动轮询
  const pollGeneration = generation;
  pollLoop().catch((err) => {
    if (pollGeneration !== generation) return;
    log.error(`pollLoop crashed: ${err.message}`);
    reportStatus("error", err.message);
  });

  // ── 返回 adapter 对象 ──

  return {
    capabilities: { proactive: false },
    mediaCapabilities: WECHAT_ILINK_MEDIA_CAPABILITIES,
    receiptCapabilities: WECHAT_ILINK_RECEIPT_CAPABILITIES,

    canReply(chatId) {
      return state === "active" && !!getContextToken(chatId);
    },

    async sendReply(chatId, text) {
      const myGen = generation;
      assertActive(myGen);
      const ctx = getContextToken(chatId);
      if (!ctx) throw new Error("微信: 需要对方最近发过消息才能回复");
      // 长文本分段
      let sent = false;
      try {
        for (let i = 0; i < text.length; i += MSG_CHUNK_LIMIT) {
          await sendText(chatId, text.slice(i, i + MSG_CHUNK_LIMIT), ctx, myGen);
          sent = true;
        }
      } catch (error) {
        if (sent && !error?.deliveryUnknown) {
          throw Object.assign(new Error("WeChat delivery incomplete after an acknowledged chunk; not automatically resent."), {
            deliveryUnknown: true, retryable: false,
          });
        }
        throw error;
      }
    },

    async sendTypingIndicator(chatId) {
      await sendTypingStatus(chatId, 1);
    },

    async cancelTypingIndicator(chatId) {
      await sendTypingStatus(chatId, 2);
    },

    // 不提供 sendBlockReply：iLink API 对连续发消息有速率限制，
    // block streaming 模式下后续消息会被丢弃。走 batch 模式一次性发完更稳。

    async sendMedia(chatId, url) {
      const myGen = generation;
      assertActive(myGen);
      const ctx = getContextToken(chatId);
      if (!ctx) throw new Error("微信: 需要对方最近发过消息才能回复");
      // 下载远程文件
      const { buffer, headers } = await fetchWechatMedia(url, { signal: abortController.signal, cdn: false });
      assertActive(myGen);
      const contentType = headers.get("content-type") || "";
      const isImage = contentType.startsWith("image/") || /\.(jpe?g|png|gif|webp|bmp)$/i.test(url);
      const uploaded = await uploadMedia(buffer, chatId, isImage ? UploadMediaType.IMAGE : UploadMediaType.FILE, myGen);
      if (isImage) {
        await sendImageMessage(chatId, uploaded, ctx, "", myGen);
      } else {
        const filename = path.basename(new URL(url).pathname) || "file";
        await sendFileMessage(chatId, uploaded, ctx, filename, myGen);
      }
    },

    async sendMediaBuffer(chatId, buffer, { mime, filename }) {
      const myGen = generation;
      assertActive(myGen);
      const ctx = getContextToken(chatId);
      if (!ctx) throw new Error("微信: 需要对方最近发过消息才能回复");
      const isImage = mime?.startsWith("image/");
      const mediaType = isImage ? UploadMediaType.IMAGE : UploadMediaType.FILE;
      debugLog()?.log("bridge", `[wechat] sendMediaBuffer: mime=${mime}, filename=${filename}, size=${buffer.length}, mediaType=${mediaType}, isImage=${isImage}`);
      const uploaded = await uploadMedia(buffer, chatId, mediaType, myGen);
      debugLog()?.log("bridge", `[wechat] uploaded: filekey=${uploaded.filekey}, downloadParam=${!!uploaded.downloadParam}`);
      if (isImage) {
        await sendImageMessage(chatId, uploaded, ctx, "", myGen);
      } else {
        await sendFileMessage(chatId, uploaded, ctx, filename || "file", myGen);
      }
      debugLog()?.log("bridge", `[wechat] sendMediaBuffer done: ${filename}`);
    },

    async downloadImage(platformRef) {
      return downloadEncryptedMedia(platformRef);
    },

    async downloadFileByRef(platformRef) {
      return downloadEncryptedMedia(platformRef);
    },

    stop() {
      if (state === "stopped") return;
      state = "stopped";
      generation++;
      clearPending();
      reportStatus("disconnected");
    },

    async getMe() {
      // 用 getconfig 验证 token（不污染 cursor）
      try {
        await api("ilink/bot/getconfig", {
          base_info: { channel_version: "1.0.0" },
        }, 10_000);
        return { ok: true, platform: "wechat" };
      } catch (err) {
        throw new Error(`微信 token 验证失败: ${err.message}`);
      }
    },
  };
}
