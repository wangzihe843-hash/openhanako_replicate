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
 * @param {object|null|undefined} [opts.uiContext]
 * @returns {Promise<{ text: string | null, toolMedia: string[] }>}
 */
import path from "path";
import { extOfName, inferFileKind } from "../lib/file-metadata.js";
import { collectMediaItems } from "../lib/tools/media-details.js";
import { formatSettingsUpdateText } from "../lib/tools/settings-update-result.js";
import { materializeBridgeInboundFiles } from "../lib/session-files/bridge-inbound-files.js";
import { serializeSessionFile } from "../lib/session-files/session-file-response.js";

const pendingDesktopSessionSubmissions = new Set();

export async function submitDesktopSessionMessage(engine, opts = {}) {
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
    uiContext,
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
    }

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

    try {
      const promptOpts = images?.length || videos?.length || audios?.length
        ? {
          ...(images?.length ? { images } : {}),
          ...(videos?.length ? { videos } : {}),
          ...(audios?.length ? { audios } : {}),
          ...(promptImageAttachmentPaths.length ? { imageAttachmentPaths: promptImageAttachmentPaths } : {}),
          ...(promptVideoAttachmentPaths.length ? { videoAttachmentPaths: promptVideoAttachmentPaths } : {}),
          ...(promptAudioAttachmentPaths.length ? { audioAttachmentPaths: promptAudioAttachmentPaths } : {}),
        }
        : undefined;
      await engine.promptSession(sessionPath, promptText, promptOpts);
    } finally {
      try { unsub?.(); } catch {}
      engine.emitEvent?.({ type: "session_status", isStreaming: false }, sessionPath);
    }

    return {
      text: captured.trim() || null,
      toolMedia,
    };
  } finally {
    pendingDesktopSessionSubmissions.delete(sessionPath);
  }
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
    });
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

function uniquePaths(paths) {
  return Array.from(new Set((paths || []).filter(Boolean)));
}
