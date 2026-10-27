/**
 * telegram-adapter.js — Telegram Bot 长轮询适配器
 *
 * 使用 node-telegram-bot-api 监听消息，
 * 通过 onMessage 回调将标准化消息交给 BridgeManager。
 */

import type { File as TelegramFile, User, UserProfilePhotos } from "node-telegram-bot-api";
import { loadTelegramSdk } from "./optional-sdks.ts";
import { debugLog } from "../debug-log.ts";
import { telegramApiOptions, telegramFetch } from "../net/telegram-fetch.ts";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { detectMime } from "../file-metadata.ts";
import { redactSecretsFromText } from "../secret-fingerprint.ts";
import { createMediaCapabilities } from "./media-capabilities.ts";
import { createStreamingCapabilities } from "./streaming-capabilities.ts";
import { createReceiptCapabilities } from "./receipt-capabilities.ts";
import { renderTelegramRichMessage } from "./bridge-presentation.ts";
import { formatTelegramMessageChunks } from "./telegram-format.ts";
import { createModuleLogger } from "../debug-log.ts";

const log = createModuleLogger("telegram");

const MAX_MSG_SIZE = 100_000; // 100KB

export const TELEGRAM_MEDIA_CAPABILITIES = createMediaCapabilities({
  platform: "telegram",
  inputModes: ["buffer", "remote_url", "public_url"],
  supportedKinds: ["image", "video", "audio", "document"],
  requiresReplyContext: false,
  deliveryByKind: {
    image: "native_image",
    video: "native_video",
    audio: "native_audio",
    document: "native_document",
  },
  maxBytes: {
    buffer: {
      image: 10 * 1024 * 1024,
      video: 50 * 1024 * 1024,
      audio: 50 * 1024 * 1024,
      document: 50 * 1024 * 1024,
    },
    remote_url: {
      image: 5 * 1024 * 1024,
      video: 20 * 1024 * 1024,
      audio: 20 * 1024 * 1024,
      document: 20 * 1024 * 1024,
    },
  },
  source: "lib/bridge/telegram-adapter.ts#TELEGRAM_MEDIA_CAPABILITIES",
});

export const TELEGRAM_STREAMING_CAPABILITIES = createStreamingCapabilities({
  platform: "telegram",
  mode: "draft",
  scopes: ["dm"],
  minIntervalMs: 500,
  maxChars: 4096,
  source: "https://core.telegram.org/bots/api#sendmessagedraft",
});

export const TELEGRAM_RICH_STREAMING_CAPABILITIES = createStreamingCapabilities({
  platform: "telegram",
  mode: "rich_draft",
  scopes: ["dm"],
  minIntervalMs: 500,
  maxChars: 32768,
  renderer: "telegram_rich_markdown",
  requiresRichStreaming: true,
  source: "https://core.telegram.org/bots/api#sendrichmessagedraft",
});

export const TELEGRAM_RECEIPT_CAPABILITIES = createReceiptCapabilities({
  platform: "telegram",
  mode: "native_typing",
  scopes: ["dm", "group"],
  refreshIntervalMs: 4000,
  source: "https://core.telegram.org/bots/api#sendchataction",
});

/** 从 URL 安全提取扩展名（小写，无点号） */
function safeExtFromUrl(url) {
  try { return new URL(url).pathname.split(".").pop()?.toLowerCase() || ""; }
  catch { return ""; }
}

interface TelegramSendOptions {
  messageThreadId?: string | number;
  replyContext?: { messageThreadId?: string | number };
  draftId?: string | number;
  includeThinkingPlaceholder?: boolean;
  thinkingText?: string;
  mime?: string;
  filename?: string;
}

function telegramMessageOptions(options: TelegramSendOptions = {}, format = "plain") {
  const messageThreadId = options.messageThreadId ?? options.replyContext?.messageThreadId;
  const result: { parse_mode?: string; message_thread_id?: string | number } = {};
  if (format === "html") result.parse_mode = "HTML";
  if (messageThreadId != null && messageThreadId !== "") result.message_thread_id = messageThreadId;
  return Object.keys(result).length ? result : undefined;
}

function cleanTelegramString(value) {
  const text = value == null ? "" : String(value).trim();
  return text || null;
}

function telegramDisplayName(user: Partial<User> = {}) {
  const fullName = [cleanTelegramString(user.first_name), cleanTelegramString(user.last_name)]
    .filter(Boolean)
    .join(" ");
  return fullName || (cleanTelegramString(user.username) ? `@${cleanTelegramString(user.username)}` : null);
}

// Keep a process-local accepted-update cursor across same-key restarts. No
// persisted queue or exactly-once claim: a process crash can replay updates.
type PollingRun = { done: Promise<void>; stop: () => void; tokenHash: string; nextOffset?: number };
const pollingRuns = new Map<string, PollingRun>();
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
const MAX_AVATAR_BYTES = 1024 * 1024;

export function createTelegramAdapter({ token, agentId, onMessage, onStatus, fetch: fetchImpl = telegramFetch }: {
  token: string;
  agentId: string;
  onMessage: (message: Record<string, unknown>) => unknown;
  onStatus?: (status: string, error?: string) => void;
  fetch?: typeof fetch;
}) {
  const { Bot, InputFile } = loadTelegramSdk();
  const bot = new Bot(token, telegramApiOptions(fetchImpl));
  const lifetime = new AbortController();
  const key = agentId;
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const previous = pollingRuns.get(key);
  previous?.stop();
  let stopped = false;
  let lastBlockTs = 0;
  const userProfileCache = new Map();
  const inFlight = new Set<Promise<unknown>>();
  const run: PollingRun = { done: Promise.resolve(), stop: stopNow, tokenHash };
  pollingRuns.set(key, run);

  function stopNow() {
    stopped = true;
    lifetime.abort();
    bot.stop();
  }
  function assertActive() {
    lifetime.signal.throwIfAborted();
  }
  function safeError(error: unknown) {
    const fields = (error && typeof error === "object" ? error : {}) as {
      message?: string; code?: string; errorCode?: number; retryAfter?: number;
    };
    const code = fields.errorCode;
    const descriptions = { 401: "unauthorized token", 403: "access forbidden", 409: "polling conflict; check the other poller or webhook" };
    const detail = descriptions[code] || redactSecretsFromText(fields.message || String(error), [token]);
    const retryAfter = Number.isFinite(fields.retryAfter) ? fields.retryAfter : undefined;
    return Object.assign(new Error(`Telegram ${code || fields.code || "request"}: ${detail}${retryAfter === undefined ? "" : ` (retry_after=${retryAfter}s)`}`), {
      code: fields.code, errorCode: code, retryAfter,
    });
  }
  function track<T>(work: Promise<T>): Promise<T> {
    inFlight.add(work);
    void work.finally(() => inFlight.delete(work)).catch(() => {});
    return work;
  }
  async function call(method: string, params?: Record<string, unknown>): Promise<unknown> {
    assertActive();
    try {
      const args = params === undefined ? [lifetime.signal] : [params, lifetime.signal];
      const result = await track(bot.api[method](...args));
      assertActive();
      return result;
    } catch (error) {
      if (lifetime.signal.aborted) throw lifetime.signal.reason;
      const safe = safeError(error);
      if (["sendMessage", "sendRichMessage", "sendPhoto", "sendVideo", "sendAudio", "sendDocument"].includes(method)
        && (["EFETCH", "ETIMEOUT", "EPARSE"].includes(safe.code) || safe.errorCode >= 500)) {
        safe.message = `Telegram delivery outcome unknown; not automatically resent. ${safe.message}`;
        throw Object.assign(safe, { deliveryUnknown: true });
      }
      throw safe;
    }
  }
  // The SDK waits for middleware. Abort the local wait if stop occurs after
  // handoff; the Manager synchronously invalidates the binding on its side.
  async function waitForHandler(work: unknown) {
    let abort: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(lifetime.signal.reason);
      if (lifetime.signal.aborted) abort();
      else lifetime.signal.addEventListener("abort", abort, { once: true });
    });
    try { await Promise.race([Promise.resolve(work), cancelled]); }
    finally { lifetime.signal.removeEventListener("abort", abort); }
  }
  function accept(updateId: number) {
    run.nextOffset = Math.max(run.nextOffset || 0, updateId + 1);
  }

  async function downloadFile(fileId: string, maxBytes = MAX_DOWNLOAD_BYTES) {
    try {
      const file = await call("getFile", { file_id: fileId }) as TelegramFile;
      if (file.file_size > maxBytes) throw new Error("file exceeds Telegram download budget");
      const segments = typeof file.file_path === "string" ? file.file_path.split("/") : [];
      if (!segments.length || segments.some(part => !/^[A-Za-z0-9_.-]+$/.test(part) || part === "." || part === "..")) {
        throw new Error("invalid Telegram file path");
      }
      // This URL never escapes the Telegram download boundary or enters a
      // Bridge attachment, profile, resource record, log or frontend payload.
      const url = `https://api.telegram.org/file/bot${token}/${segments.join("/")}`;
      const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(30_000)]);
      const work = (async () => {
        const response = await fetchImpl(url, { signal, redirect: "error" });
        if (!response.ok) { await response.body?.cancel(); throw new Error(`file download HTTP ${response.status}`); }
        if (Number(response.headers.get("content-length")) > maxBytes) {
          await response.body?.cancel(); throw new Error("file exceeds Telegram download budget");
        }
        const reader = response.body?.getReader();
        if (!reader) throw new Error("empty Telegram file body");
        const chunks: Uint8Array[] = [];
        let size = 0;
        const abort = () => { void reader.cancel(signal.reason).catch(() => {}); };
        signal.addEventListener("abort", abort, { once: true });
        try {
          for (;;) {
            signal.throwIfAborted();
            const { value, done } = await reader.read();
            signal.throwIfAborted();
            if (done) break;
            size += value.byteLength;
            if (size > maxBytes) throw new Error("file exceeds Telegram download budget");
            chunks.push(value);
          }
          return Buffer.concat(chunks, size);
        } finally {
          signal.removeEventListener("abort", abort);
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      })();
      const buffer = await track(work);
      assertActive();
      return buffer;
    } catch (error) {
      if (lifetime.signal.aborted) throw lifetime.signal.reason;
      throw safeError(error);
    }
  }

  async function resolveUserProfile(user: Partial<User> = {}) {
    const userId = cleanTelegramString(user.id);
    const cached = userId ? userProfileCache.get(userId) : null;
    const displayName = telegramDisplayName(user) || cached?.displayName || "User";
    let avatarUrl = cached?.avatarUrl || null;
    if (userId && !cached) {
      try {
        const photos = await call("getUserProfilePhotos", { user_id: user.id, limit: 1 }) as UserProfilePhotos;
        const sizes = photos?.photos?.[0] || [];
        const best = sizes[sizes.length - 1];
        if (best?.file_id) {
          const buffer = await downloadFile(best.file_id, MAX_AVATAR_BYTES);
          const mime = detectMime(buffer, "application/octet-stream");
          if (["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mime)) {
            avatarUrl = `data:${mime};base64,${buffer.toString("base64")}`;
          }
        }
      } catch (error) {
        assertActive();
        debugLog()?.warn("bridge", safeError(error).message);
      }
    }
    assertActive();
    const profile = { principalId: userId, displayName, avatarUrl };
    if (userId) {
      if (userProfileCache.size >= 200) userProfileCache.delete(userProfileCache.keys().next().value);
      userProfileCache.set(userId, profile);
    }
    return profile;
  }

  bot.use(async (ctx, next) => {
    assertActive();
    // Servers may repeat an already accepted update. Never deliver it twice in
    // this process; only advance after normalization or deliberate filtering.
    if (run.nextOffset !== undefined && ctx.update.update_id < run.nextOffset) return;
    await next();
    if (!stopped) accept(ctx.update.update_id);
  });
  bot.on("message", async (ctx) => {
    const msg = ctx.message;
    if (!msg) return;
    const text = msg.text || msg.caption || "";
    const attachments = [];
    const best = msg.photo?.[msg.photo.length - 1];
    if (best) attachments.push({ type: "image", mimeType: "image/jpeg", width: best.width, height: best.height, size: best.file_size, platformRef: best.file_id });
    if (msg.document) attachments.push({ type: "file", filename: msg.document.file_name, mimeType: msg.document.mime_type, size: msg.document.file_size, platformRef: msg.document.file_id });
    if (msg.voice) attachments.push({ type: "audio", mimeType: msg.voice.mime_type, size: msg.voice.file_size, duration: msg.voice.duration, platformRef: msg.voice.file_id });
    if (msg.video) attachments.push({ type: "video", filename: msg.video.file_name, mimeType: msg.video.mime_type, size: msg.video.file_size, duration: msg.video.duration, platformRef: msg.video.file_id });
    if (!text && !attachments.length) return;
    const profile = await resolveUserProfile(msg.from || {});
    assertActive();
    const chatId = String(msg.chat.id);
    const userId = profile.principalId || String(msg.from?.id || msg.chat.id);
    const isGroup = msg.chat.type !== "private";
    // Acceptance means handed to the current Manager binding, not persisted or
    // delivered externally. Handler failures are consumed (SDK's v2 default).
    accept(ctx.update.update_id);
    await waitForHandler(onMessage({
      platform: "telegram", agentId, chatId, userId,
      sessionKey: isGroup ? `tg_group_${chatId}@${agentId}` : `tg_dm_${userId}@${agentId}`,
      text: text.slice(0, MAX_MSG_SIZE), senderName: profile.displayName, displayName: profile.displayName,
      avatarUrl: profile.avatarUrl || undefined, principalId: profile.principalId || userId,
      isGroup, messageThreadId: msg.message_thread_id,
      attachments: attachments.length ? attachments : undefined,
    }));
  });
  bot.catch((error, ctx) => {
    if (stopped) return;
    accept(ctx.update.update_id);
    log.error(safeError(error).message);
  });
  const getUpdates = bot.api.getUpdates.bind(bot.api);
  bot.api.getUpdates = async (params, signal) => {
    const updates = await getUpdates(params, signal);
    assertActive();
    onStatus?.("connected");
    return updates;
  };
  run.done = Promise.resolve().then(async () => {
    await previous?.done;
    run.nextOffset = previous?.tokenHash === tokenHash ? previous.nextOffset : undefined;
    if (stopped) return;
    await call("getMe");
    assertActive();
    onStatus?.("connected");
    await bot.startPolling(undefined, {
      offset: run.nextOffset, allowedUpdates: ["message"],
      onError(error) {
        if (!stopped) onStatus?.("connecting", safeError(error).message);
      },
    });
  }).catch(error => {
    if (!stopped) {
      const message = safeError(error).message;
      log.error(message);
      onStatus?.("error", message);
      stopNow();
    }
  }).finally(async () => { await Promise.allSettled([...inFlight]); });

  async function sendMediaValue(chatId, value, kind: string, metadata = {}) {
    const methods = { image: ["sendPhoto", "photo"], video: ["sendVideo", "video"], audio: ["sendAudio", "audio"], document: ["sendDocument", "document"] };
    const [method, field] = methods[kind];
    return call(method, { chat_id: chatId, [field]: value, ...telegramMessageOptions(metadata) });
  }
  return {
    mediaCapabilities: TELEGRAM_MEDIA_CAPABILITIES,
    richStreamingCapabilities: TELEGRAM_RICH_STREAMING_CAPABILITIES,
    streamingCapabilities: TELEGRAM_STREAMING_CAPABILITIES,
    receiptCapabilities: TELEGRAM_RECEIPT_CAPABILITIES,
    async sendTypingIndicator(chatId, options = {}) {
      try { await call("sendChatAction", { chat_id: chatId, action: "typing", ...telegramMessageOptions(options) }); }
      catch { /* Typing is best-effort; never retry it or fail the reply. */ }
    },
    async sendReply(chatId, text, options = {}) {
      for (const chunk of formatTelegramMessageChunks(text)) {
        await call("sendMessage", { chat_id: chatId, text: chunk, ...telegramMessageOptions(options, "html") });
      }
    },
    async sendBlockReply(chatId, text, options = {}) {
      assertActive();
      const remaining = 800 + Math.random() * 1200 - (Date.now() - lastBlockTs);
      if (lastBlockTs && remaining > 0) await delay(remaining, undefined, { signal: lifetime.signal });
      await this.sendReply(chatId, text, options);
      lastBlockTs = Date.now();
    },
    async sendDraft(chatId, text, options: TelegramSendOptions = {}) {
      const draftId = Number(options.draftId);
      if (!Number.isInteger(draftId) || draftId === 0) throw new Error("Telegram sendDraft requires a non-zero integer draftId");
      return call("sendMessageDraft", { chat_id: chatId, draft_id: draftId, text, ...telegramMessageOptions(options) });
    },
    async sendRichDraft(chatId, text, options: TelegramSendOptions = {}) {
      const draftId = Number(options.draftId);
      if (!Number.isInteger(draftId) || draftId === 0) throw new Error("Telegram sendRichDraft requires a non-zero integer draftId");
      return call("sendRichMessageDraft", {
        chat_id: chatId, draft_id: draftId, ...telegramMessageOptions(options),
        rich_message: renderTelegramRichMessage(text, { includeThinkingPlaceholder: options.includeThinkingPlaceholder, thinkingText: options.thinkingText }),
      });
    },
    async sendRichReply(chatId, text, options = {}) {
      return call("sendRichMessage", { chat_id: chatId, rich_message: renderTelegramRichMessage(text), ...telegramMessageOptions(options) });
    },
    async sendMedia(chatId, url, metadata = {}) {
      const ext = safeExtFromUrl(url);
      const kind = ["jpg", "jpeg", "png", "gif", "webp"].includes(ext) ? "image"
        : ["mp4", "mov", "avi", "mkv"].includes(ext) ? "video"
        : ["mp3", "ogg", "wav", "m4a", "opus"].includes(ext) ? "audio" : "document";
      return sendMediaValue(chatId, url, kind, metadata);
    },
    async sendMediaBuffer(chatId, buffer, metadata: TelegramSendOptions = {}) {
      const mime = metadata.mime || "application/octet-stream";
      const kind = mime.startsWith("image/") ? "image" : mime.startsWith("video/") ? "video" : mime.startsWith("audio/") ? "audio" : "document";
      return sendMediaValue(chatId, new InputFile(buffer, { filename: metadata.filename, contentType: mime }), kind, metadata);
    },
    downloadImage: (fileId: string) => downloadFile(fileId),
    downloadFileByRef: (fileId: string) => downloadFile(fileId),
    stop() { stopNow(); return run.done; },
    getMe: () => call("getMe") as Promise<User>,
  };
}
