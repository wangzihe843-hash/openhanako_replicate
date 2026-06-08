/**
 * 桌面 session 的统一提交入口。
 * 本地输入与 bridge /rc 接管都应通过这一层提交消息到桌面 session。
 */

/**
 * @param {object} engine
 * @param {object} opts
 * @param {string} opts.sessionPath
 * @param {string} opts.text
 * @param {Array<{type:'image', data:string, mimeType:string}>} [opts.images]
 * @param {string[]} [opts.imageAttachmentPaths]
 * @param {Array<{type:'video', data:string, mimeType:string}>} [opts.videos]
 * @param {string[]} [opts.videoAttachmentPaths]
 * @param {Array<{type:'audio', data:string, mimeType:string}>} [opts.audios]
 * @param {string[]} [opts.audioAttachmentPaths]
 * @param {Array<{type:string, filename?:string, mimeType?:string, buffer:Buffer|Uint8Array|string}>} [opts.inboundFiles]
 * @param {(delta: string, accumulated: string) => void} [opts.onDelta]
 * @param {object} [opts.displayMessage]
 * @param {Array<{fileId?:string, sessionPath?:string, label?:string, kind?:string}>} [opts.sessionFileRefs]
 * @param {object|null|undefined} [opts.uiContext]
 * @param {object|null|undefined} [opts.context]
 * @returns {Promise<{ text: string | null, toolMedia: string[] }>}
 */
import path from "path";
import { createHash } from "crypto";
import { extOfName, inferFileKind } from "../lib/file-metadata.ts";
import { collectMediaItems } from "../lib/tools/media-details.ts";
import { formatSettingsUpdateText } from "../lib/tools/settings-update-result.ts";
import { materializeBridgeInboundFiles } from "../lib/session-files/bridge-inbound-files.ts";
import { serializeSessionFile } from "../lib/session-files/session-file-response.ts";
import { appendXingyeEventOnce } from "../lib/xingye/events.js";
import { scrubPII } from "../lib/pii-guard.ts";

const pendingDesktopSessionSubmissions = new Set();

export async function submitDesktopSessionMessage(engine: any, opts: {
  sessionPath?: string;
  text?: string;
  images?: Array<{ type: string; data: string; mimeType: string }>;
  imageAttachmentPaths?: string[];
  videos?: Array<{ type: string; data: string; mimeType: string }>;
  videoAttachmentPaths?: string[];
  audios?: Array<{ type: string; data: string; mimeType: string }>;
  audioAttachmentPaths?: string[];
  inboundFiles?: Array<{ type: string; filename?: string; mimeType?: string; buffer: any }>;
  onDelta?: (delta: string, accumulated: string) => void;
  displayMessage?: any;
  sessionFileRefs?: Array<{ fileId?: string; sessionPath?: string; label?: string; kind?: string }>;
  uiContext?: any;
  context?: any;
} = {}) {
  const {
    sessionPath,
    text,
    images,
    imageAttachmentPaths,
    videos,
    videoAttachmentPaths,
    audios,
    audioAttachmentPaths,
    inboundFiles,
    onDelta,
    displayMessage,
    sessionFileRefs,
    uiContext,
    context,
  } = opts;

  if (!engine || typeof engine.ensureSessionLoaded !== "function" || typeof engine.promptSession !== "function") {
    throw new Error("desktop-session-submit: engine session API unavailable");
  }
  if (!sessionPath) throw new Error("desktop-session-submit: sessionPath is required");
  if (!text && !images?.length && !videos?.length && !audios?.length) throw new Error("desktop-session-submit: text, images, videos, or audios required");
  if (pendingDesktopSessionSubmissions.has(sessionPath)) {
    throw new Error("session_busy");
  }
  if (typeof engine.isSessionStreaming === "function" && engine.isSessionStreaming(sessionPath)) {
    throw new Error("session_busy");
  }

  pendingDesktopSessionSubmissions.add(sessionPath);
  try {
    const session = await engine.ensureSessionLoaded(sessionPath);
    if (!session) throw new Error(`desktop-session-submit: failed to load session ${sessionPath}`);

    if (uiContext !== undefined) {
      engine.setUiContext?.(sessionPath, uiContext ?? null);
    }

    let promptImageAttachmentPaths = imageAttachmentPaths || [];
    let promptVideoAttachmentPaths = videoAttachmentPaths || [];
    let promptAudioAttachmentPaths = audioAttachmentPaths || [];
    let displayAttachments = displayMessage?.attachments;
    let promptText = text || "";
    let promptSessionFileRefs = normalizeSessionFileRefs(sessionFileRefs, sessionPath);

    if (displayAttachments?.length) {
      const registeredDisplay = registerDisplayAttachments({
        hanakoHome: engine.hanakoHome,
        sessionPath,
        attachments: displayAttachments,
        registerSessionFile: engine.registerSessionFile?.bind(engine),
      });
      displayAttachments = registeredDisplay.attachments;
      promptImageAttachmentPaths = uniquePaths([
        ...promptImageAttachmentPaths,
        ...registeredDisplay.imageAttachmentPaths,
      ]);
      promptVideoAttachmentPaths = uniquePaths([
        ...promptVideoAttachmentPaths,
        ...registeredDisplay.videoAttachmentPaths,
      ]);
      if (audios?.length || promptAudioAttachmentPaths.length) {
        promptAudioAttachmentPaths = uniquePaths([
          ...promptAudioAttachmentPaths,
          ...registeredDisplay.audioAttachmentPaths,
        ]);
      }
      promptSessionFileRefs = mergeSessionFileRefs(
        promptSessionFileRefs,
        sessionFileRefsFromAttachments(displayAttachments, sessionPath),
      );
    }

    if (inboundFiles?.length) {
      const materialized = await materializeBridgeInboundFiles({
        hanakoHome: engine.hanakoHome,
        sessionPath,
        files: inboundFiles,
        registerSessionFile: engine.registerSessionFile?.bind(engine),
      });
      promptImageAttachmentPaths = [
        ...promptImageAttachmentPaths,
        ...materialized.imageAttachmentPaths,
      ];
      promptImageAttachmentPaths = uniquePaths(promptImageAttachmentPaths);
      displayAttachments = [
        ...(displayAttachments || []),
        ...materialized.displayAttachments,
      ];
      promptSessionFileRefs = mergeSessionFileRefs(
        promptSessionFileRefs,
        sessionFileRefsFromAttachments(materialized.displayAttachments, sessionPath),
      );
    }

    const turnStartedAt = Date.now();
    engine.emitEvent?.({ type: "session_status", isStreaming: true }, sessionPath);
    engine.emitEvent?.({
      type: "session_user_message",
      message: {
        text: displayMessage?.text ?? text ?? "",
        timestamp: Date.now(),
        attachments: displayAttachments,
        quotedText: displayMessage?.quotedText,
        skills: displayMessage?.skills,
        deskContext: displayMessage?.deskContext ?? null,
        source: displayMessage?.source || "desktop",
        bridgeSessionKey: displayMessage?.bridgeSessionKey || null,
      },
    }, sessionPath);
    queueVoiceInputTranscriptions({
      speechRecognition: engine.speechRecognition,
      sessionPath,
      attachments: displayAttachments,
    });

    promptText = addAttachedImageMarkers(promptText, promptImageAttachmentPaths);
    promptText = addAttachedVideoMarkers(promptText, promptVideoAttachmentPaths);
    promptText = addAttachedAudioMarkers(promptText, promptAudioAttachmentPaths);
    promptText = addSessionFileRefMarkers(promptText, promptSessionFileRefs);

    let captured = "";
    const toolMedia = [];
    const unsub = session.subscribe?.((event) => {
      if (event.type === "message_update") {
        const sub = event.assistantMessageEvent;
        if (sub?.type === "text_delta") {
          const delta = sub.delta || "";
          captured += delta;
          try { onDelta?.(delta, captured); } catch {}
        }
      } else if (event.type === "tool_execution_end" && !event.isError) {
        toolMedia.push(...collectMediaItems(event.result?.details?.media));
        const card = event.result?.details?.card;
        if (card?.description) {
          captured += (captured ? "\n\n" : "") + card.description;
        }
        const settingsUpdateText = formatSettingsUpdateText(event.result?.details?.settingsUpdate);
        if (settingsUpdateText) {
          captured += (captured ? "\n\n" : "") + settingsUpdateText;
        }
      }
    });

    let promptSucceeded = false;
    try {
      const promptOpts = buildPromptOptions({
        images,
        videos,
        audios,
        promptImageAttachmentPaths,
        promptVideoAttachmentPaths,
        promptAudioAttachmentPaths,
        context,
      });
      await engine.promptSession(sessionPath, promptText, promptOpts);
      promptSucceeded = true;
    } finally {
      try { unsub?.(); } catch {}
      engine.emitEvent?.({ type: "session_status", isStreaming: false }, sessionPath);
      // 一轮用户↔agent 对话流式成功结束才打 recent_chat.observed。
      // 失败的 turn 不入事件流：patrol consumer 把它聚合成「最近对话×N」只是噪声，
      // 还会污染 agent 的事件感知。streaming:false 仍然在 finally 里照常发，保证 UI 状态收敛。
      // 用 (agentId, sessionPath, turnStartedAt) 作 dedupeKey，重连/重复触发不会刷出新事件。
      if (promptSucceeded) {
        try {
          const agentId = engine.agentIdFromSessionPath?.(sessionPath) || null;
          const agent = agentId ? engine.getAgent?.(agentId) : null;
          const agentDir = agent?.agentDir || null;
          if (agentId && agentDir) {
            // userPreview 会被持久化到 events/log.json，跟 pinned-memory 一样过一遍 scrubPII，
            // 避免 API key / 身份证 / 信用卡号等敏感串原样落盘。
            const previewSource = (displayMessage?.text ?? text ?? "").trim();
            const scrubbed = previewSource ? scrubPII(previewSource).cleaned : "";
            const userPreview = scrubbed ? scrubbed.slice(0, 200) : "";
            // dedupeKey 加 8 字符的 content hash：
            //  - 同 (agentId, sessionPath, turnStartedAt) 重复触发（桥接重连重发）→ text 相同 → 同 key → 不重复
            //  - 不同 turn 恰好同毫秒撞车 → text 不同 → 不同 key → 都被记录（修复同毫秒丢事件）
            // 用 cleaned text 哈希，避免重发时因 PII 脱敏前后差异破坏 dedupe。
            const contentHash = createHash("md5")
              .update(scrubbed || previewSource || "")
              .digest("hex")
              .slice(0, 8);
            await appendXingyeEventOnce({
              agentDir,
              agentId,
              input: {
                type: "recent_chat.observed",
                source: "desktop-session-submit",
                subjectId: sessionPath,
                payload: {
                  sessionPath,
                  turnStartedAt: new Date(turnStartedAt).toISOString(),
                  hasReply: Boolean(captured.trim()),
                  userPreview,
                },
              },
              dedupeKey: `recent_chat.observed:${agentId}:${sessionPath}:${turnStartedAt}:${contentHash}`,
            });
          }
        } catch (err) {
          console.warn(`[desktop-session-submit] recent_chat.observed append failed: ${err?.message || err}`);
        }
      }
    }

    return {
      text: captured.trim() || null,
      toolMedia,
    };
  } finally {
    pendingDesktopSessionSubmissions.delete(sessionPath);
  }
}

function buildPromptOptions({
  images,
  videos,
  audios,
  promptImageAttachmentPaths,
  promptVideoAttachmentPaths,
  promptAudioAttachmentPaths,
  context,
}: any = {}) {
  const opts: any = {};
  if (images?.length) opts.images = images;
  if (videos?.length) opts.videos = videos;
  if (audios?.length) opts.audios = audios;
  if (promptImageAttachmentPaths?.length) opts.imageAttachmentPaths = promptImageAttachmentPaths;
  if (promptVideoAttachmentPaths?.length) opts.videoAttachmentPaths = promptVideoAttachmentPaths;
  if (promptAudioAttachmentPaths?.length) opts.audioAttachmentPaths = promptAudioAttachmentPaths;
  if (context !== undefined && context !== null) opts.context = context;
  return Object.keys(opts).length ? opts : undefined;
}

function queueVoiceInputTranscriptions({ speechRecognition, sessionPath, attachments }) {
  if (!speechRecognition || typeof speechRecognition.queueVoiceTranscription !== "function") return;
  for (const attachment of attachments || []) {
    if (attachment?.presentation !== "voice-input" || !attachment.fileId) continue;
    speechRecognition.queueVoiceTranscription({
      sessionPath,
      fileId: attachment.fileId,
    });
  }
}

function registerDisplayAttachments({ hanakoHome, sessionPath, attachments, registerSessionFile }) {
  const nextAttachments = [];
  const imageAttachmentPaths = [];
  const videoAttachmentPaths = [];
  const audioAttachmentPaths = [];

  for (const attachment of attachments || []) {
    let next = { ...attachment };
    let sessionFile = null;

    if (!next.fileId && next.path && path.isAbsolute(next.path) && typeof registerSessionFile === "function") {
      sessionFile = serializeSessionFile(registerSessionFile({
        sessionPath,
        filePath: next.path,
        label: next.name || path.basename(next.path),
        origin: originForDisplayAttachment(next),
        storageKind: displayAttachmentStorageKind(hanakoHome, next.path),
        presentation: displayAttachmentPresentation(next),
        listed: listedForDisplayAttachment(next),
        waveform: next.waveform,
      }));
      if (sessionFile) {
        next = {
          ...next,
          fileId: sessionFile.fileId || sessionFile.id,
          name: next.name || sessionFile.displayName || sessionFile.filename || path.basename(next.path),
          mimeType: next.mimeType || sessionFile.mime,
          isDir: next.isDir || !!sessionFile.isDirectory,
          presentation: sessionFile.presentation || displayAttachmentPresentation(next),
          listed: sessionFile.listed !== undefined ? sessionFile.listed !== false : listedForDisplayAttachment(next),
          status: sessionFile.status,
          missingAt: sessionFile.missingAt,
          waveform: sessionFile.waveform || next.waveform,
        };
      }
    }

    if (next.path && path.isAbsolute(next.path) && next.base64Data) {
      const { base64Data, ...withoutInlineBytes } = next;
      next = withoutInlineBytes;
    }

    const kind = sessionFile?.kind || inferFileKind({
      mime: next.mimeType,
      ext: extOfName(next.name || next.path),
      isDirectory: !!next.isDir,
    } as any);
    if (!next.isDir && next.path && kind === "image") {
      imageAttachmentPaths.push(next.path);
    } else if (!next.isDir && next.path && kind === "video") {
      videoAttachmentPaths.push(next.path);
    } else if (!next.isDir && next.path && kind === "audio") {
      audioAttachmentPaths.push(next.path);
    }
    nextAttachments.push(next);
  }

  return {
    attachments: nextAttachments,
    imageAttachmentPaths: uniquePaths(imageAttachmentPaths),
    videoAttachmentPaths: uniquePaths(videoAttachmentPaths),
    audioAttachmentPaths: uniquePaths(audioAttachmentPaths),
  };
}

function displayAttachmentPresentation(attachment) {
  return attachment?.presentation === "voice-input" ? "voice-input" : "attachment";
}

function listedForDisplayAttachment(attachment) {
  return displayAttachmentPresentation(attachment) !== "voice-input";
}

function originForDisplayAttachment(attachment) {
  return displayAttachmentPresentation(attachment) === "voice-input" ? "voice_input" : "user_attachment";
}

function displayAttachmentStorageKind(hanakoHome, filePath) {
  if (!hanakoHome) return "external";
  const root = path.resolve(hanakoHome, "session-files");
  const target = path.resolve(filePath);
  const rel = path.relative(root, target);
  if (rel === "" || (rel && !rel.startsWith("..") && !path.isAbsolute(rel))) {
    return "managed_cache";
  }
  return "external";
}

function addAttachedImageMarkers(text, imageAttachmentPaths) {
  let promptText = text || "";
  const missing = uniquePaths(imageAttachmentPaths)
    .filter((filePath) => filePath && !promptText.includes(`[attached_image: ${filePath}]`));
  if (!missing.length) return promptText;
  const markerText = missing.map((filePath) => `[attached_image: ${filePath}]`).join("\n");
  return promptText ? `${markerText}\n${promptText}` : markerText;
}

function addAttachedVideoMarkers(text, videoAttachmentPaths) {
  let promptText = text || "";
  const missing = uniquePaths(videoAttachmentPaths)
    .filter((filePath) => filePath && !promptText.includes(`[attached_video: ${filePath}]`));
  if (!missing.length) return promptText;
  const markerText = missing.map((filePath) => `[attached_video: ${filePath}]`).join("\n");
  return promptText ? `${markerText}\n${promptText}` : markerText;
}

function addAttachedAudioMarkers(text, audioAttachmentPaths) {
  let promptText = text || "";
  const missing = uniquePaths(audioAttachmentPaths)
    .filter((filePath) => filePath && !promptText.includes(`[attached_audio: ${filePath}]`));
  if (!missing.length) return promptText;
  const markerText = missing.map((filePath) => `[attached_audio: ${filePath}]`).join("\n");
  return promptText ? `${markerText}\n${promptText}` : markerText;
}

function uniquePaths(paths: string[]): string[] {
  return Array.from(new Set((paths || []).filter(Boolean)));
}

function normalizeSessionFileRefs(refs, fallbackSessionPath) {
  if (!Array.isArray(refs)) return [];
  const normalized = [];
  for (const ref of refs) {
    if (!ref || typeof ref !== "object") continue;
    const fileId = typeof ref.fileId === "string" && ref.fileId.trim() ? ref.fileId.trim() : null;
    if (!fileId) continue;
    normalized.push({
      fileId,
      sessionPath: typeof ref.sessionPath === "string" && ref.sessionPath ? ref.sessionPath : fallbackSessionPath,
      label: typeof ref.label === "string" && ref.label ? ref.label : fileId,
      kind: typeof ref.kind === "string" && ref.kind ? ref.kind : "attachment",
    });
  }
  return normalized;
}

function sessionFileRefsFromAttachments(attachments, sessionPath) {
  return normalizeSessionFileRefs((attachments || []).map((attachment) => ({
    fileId: attachment?.fileId,
    sessionPath,
    label: attachment?.name || attachment?.label || attachment?.path,
    kind: attachment?.isDir ? "directory" : "attachment",
  })), sessionPath);
}

function mergeSessionFileRefs(primary, secondary) {
  const out = [];
  const seen = new Set();
  for (const ref of [...(primary || []), ...(secondary || [])]) {
    if (!ref?.fileId) continue;
    const key = `${ref.sessionPath || ""}:${ref.fileId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

function addSessionFileRefMarkers(text, refs) {
  const items = normalizeSessionFileRefs(refs, null);
  if (!items.length) return text || "";
  const markerText = items
    .map((ref) => `[SessionFile] ${JSON.stringify({
      fileId: ref.fileId,
      sessionPath: ref.sessionPath || null,
      label: ref.label,
      kind: ref.kind,
    })}`)
    .join("\n");
  const promptText = text || "";
  return promptText ? `${markerText}\n${promptText}` : markerText;
}
