/**
 * MiMo provider 兼容层
 *
 * 处理 provider:
 *   - provider === "mimo"
 *   - provider === "xiaomi" / "xiaomi-token" / token-plan variants
 *   - baseUrl hostname 属于 "xiaomimimo.com"
 *
 * 解决的协议问题：
 *   1. V2.6 使用顶层 thinking.type；旧模型保留 chat_template_kwargs.enable_thinking
 *   2. 思考模式工具调用历史需要回传 reasoning_content
 *   3. utility mode 主动关思考，避免短输出被思考链吃掉可见文本预算
 *      官方文档：https://github.com/XiaomiMiMo/MiMo
 *
 * 删除条件：
 *   - MiMo 不再通过 chat_template_kwargs 控制 thinking
 *   - 或 pi-ai 直接原生处理 MiMo 的 reasoning_content replay
 *   - 或 hana 不再支持 MiMo
 *
 * 接口契约：见 ./README.md
 */

import {
  MODEL_AUDIO_TRANSPORTS,
  MODEL_VIDEO_TRANSPORTS,
  getReasoningProfile,
  isOfficialMimoEndpoint,
  resolveModelAudioInputTransport,
  resolveModelVideoInputTransport,
} from "../../shared/model-capabilities.ts";
import {
  ensureAssistantContentForToolCalls,
  stripReasoningContent,
} from "./reasoning-content-replay.ts";
import { normalizeOpenAIInputAudioPayload } from "./input-audio.ts";
import { normalizeOpenAIVideoUrlPayload } from "./openai-video-url.ts";

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

export function matches(model) {
  if (!model || typeof model !== "object") return false;
  return isOfficialMimoEndpoint(model)
    || getReasoningProfile(model) === "mimo-openai";
}

function isThinkingOff(level) {
  return level === "off" || level === "none" || level === "disabled";
}

function shouldUseThinking(payload, model, reasoningLevel) {
  if (payload.thinking?.type === "disabled") return false;
  if (payload.chat_template_kwargs?.enable_thinking === false) return false;
  if (isThinkingOff(reasoningLevel)) return false;
  return Boolean(
    payload.reasoning_effort
    || payload.thinking?.type === "enabled"
    || payload.chat_template_kwargs?.enable_thinking === true
    || model?.reasoning === true
  );
}

function disableThinking(payload) {
  delete payload.reasoning_effort;
  if (hasOwn(payload, "thinking")) {
    delete payload.thinking;
  }
  const kwargs = isPlainObject(payload.chat_template_kwargs)
    ? payload.chat_template_kwargs
    : {};
  payload.chat_template_kwargs = {
    ...kwargs,
    enable_thinking: false,
  };
  delete payload.chat_template_kwargs.preserve_thinking;

  if (Array.isArray(payload.messages)) {
    const stripped = stripReasoningContent(payload.messages);
    if (stripped !== payload.messages) payload.messages = stripped;
  }
}

function enableThinking(payload) {
  delete payload.reasoning_effort;
  const kwargs = isPlainObject(payload.chat_template_kwargs)
    ? payload.chat_template_kwargs
    : {};
  payload.chat_template_kwargs = {
    ...kwargs,
    enable_thinking: true,
    preserve_thinking: true,
  };
}

function usesTopLevelThinking(model) {
  return /^mimo-v2\.6-(pro|flash)(-ultraspeed)?$/i.test(model?.id || "");
}

function setCurrentThinking(payload, enabled) {
  payload.thinking = { type: enabled ? "enabled" : "disabled" };
  delete payload.reasoning_effort;
  if (isPlainObject(payload.chat_template_kwargs)) {
    const kwargs = { ...payload.chat_template_kwargs };
    delete kwargs.enable_thinking;
    delete kwargs.preserve_thinking;
    if (Object.keys(kwargs).length) payload.chat_template_kwargs = kwargs;
    else delete payload.chat_template_kwargs;
  }
  if (hasOwn(payload, "max_tokens")) {
    if (!hasOwn(payload, "max_completion_tokens")) payload.max_completion_tokens = payload.max_tokens;
    delete payload.max_tokens;
  }
  if (!enabled) payload.messages = stripReasoningContent(payload.messages);
}

export function apply(payload, model, options: { mode?: string; reasoningLevel?: string } = {}) {
  if (!Array.isArray(payload.messages)) return payload;
  const mode = options.mode || "chat";
  const reasoningLevel = options.reasoningLevel;

  let base = payload;
  if (resolveModelAudioInputTransport(model) === MODEL_AUDIO_TRANSPORTS.MIMO_INPUT_AUDIO) {
    base = normalizeOpenAIInputAudioPayload(base);
  }
  if (resolveModelVideoInputTransport(model) === MODEL_VIDEO_TRANSPORTS.OPENAI_VIDEO_URL) {
    base = normalizeOpenAIVideoUrlPayload(base);
  }
  let next = base;
  const editable = () => {
    if (next === base) next = { ...base };
    return next;
  };

  if (usesTopLevelThinking(model)) {
    const enabled = mode !== "utility" && shouldUseThinking(next, model, reasoningLevel);
    const p = editable();
    setCurrentThinking(p, enabled);
    if (enabled) p.messages = ensureAssistantContentForToolCalls(p.messages);
    return next;
  }

  if (isThinkingOff(reasoningLevel) || payload.chat_template_kwargs?.enable_thinking === false) {
    disableThinking(editable());
    return next;
  }

  if (mode === "utility") {
    disableThinking(editable());
    return next;
  }

  if (!shouldUseThinking(next, model, reasoningLevel)) return next;

  const p = editable();
  enableThinking(p);

  const contentEnsured = ensureAssistantContentForToolCalls(p.messages);
  if (contentEnsured !== p.messages) {
    p.messages = contentEnsured;
  }

  if (hasOwn(p, "thinking")) {
    delete p.thinking;
  }

  return next;
}
