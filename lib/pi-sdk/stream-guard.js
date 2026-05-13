import { AssistantMessageEventStream } from "@mariozechner/pi-ai";

const STREAM_GUARD_FLAG = Symbol.for("hana.piSdk.streamGuardInstalled");

export function installAssistantStreamGuard(session) {
  const agent = session?.agent;
  if (!agent || typeof agent.streamFn !== "function" || agent[STREAM_GUARD_FLAG]) return;
  const originalStreamFn = agent.streamFn;
  agent.streamFn = async (model, context, options) => {
    const inner = await originalStreamFn(model, context, options);
    return guardAssistantMessageStream(inner);
  };
  agent[STREAM_GUARD_FLAG] = true;
}

export function guardAssistantMessageStream(inner) {
  const outer = new AssistantMessageEventStream();

  void (async () => {
    try {
      for await (const event of inner) {
        for (const guarded of guardStreamEvent(event)) {
          outer.push(guarded);
        }
      }
    } catch (error) {
      outer.push({
        type: "error",
        reason: "error",
        error: createErrorMessage(error),
      });
    }
    outer.end();
  })();

  return outer;
}

function guardStreamEvent(event) {
  if (!event || typeof event !== "object") return [];
  if (event.type === "toolcall_start" || event.type === "toolcall_delta") {
    const toolCall = toolCallFromEvent(event);
    if (isEmptyNameToolCall(toolCall)) return [];
    return [{ ...event, partial: sanitizeAssistantMessage(event.partial) }];
  }
  if (event.type === "toolcall_end") {
    const toolCall = toolCallFromEvent(event);
    if (isEmptyNameToolCall(toolCall)) {
      const text = recoverInvalidToolCallText(toolCall);
      if (!text) return [];
      const partial = sanitizeAssistantMessage(event.partial);
      const contentIndex = Math.max(0, partial.content.length - 1);
      return [
        { type: "text_start", contentIndex, partial },
        { type: "text_delta", contentIndex, delta: text, partial },
        { type: "text_end", contentIndex, content: text, partial },
      ];
    }
    return [{ ...event, partial: sanitizeAssistantMessage(event.partial) }];
  }
  if (event.type === "done") {
    return [{ ...event, message: sanitizeAssistantMessage(event.message) }];
  }
  if (event.type === "error") {
    return [{ ...event, error: sanitizeAssistantMessage(event.error) }];
  }
  if ("partial" in event) {
    return [{ ...event, partial: sanitizeAssistantMessage(event.partial) }];
  }
  return [event];
}

function toolCallFromEvent(event) {
  if (event.toolCall?.type === "toolCall") return event.toolCall;
  const content = event.partial?.content;
  if (Array.isArray(content) && typeof event.contentIndex === "number") {
    return content[event.contentIndex];
  }
  return null;
}

function isEmptyNameToolCall(block) {
  return block?.type === "toolCall" && String(block.name || "").trim().length === 0;
}

export function sanitizeAssistantMessage(message) {
  if (!message || !Array.isArray(message.content)) return message;
  const content = [];
  for (const block of message.content) {
    if (isEmptyNameToolCall(block)) {
      appendTextBlock(content, recoverInvalidToolCallText(block));
      continue;
    }
    content.push(block);
  }
  return { ...message, content };
}

function appendTextBlock(content, text) {
  if (!text) return;
  const last = content[content.length - 1];
  if (last?.type === "text") {
    last.text += text;
    return;
  }
  content.push({ type: "text", text });
}

function recoverInvalidToolCallText(block) {
  const raw = typeof block?.partialArgs === "string" ? block.partialArgs : "";
  const parsed = parseJsonLike(raw);
  const fromParsed = recoverTextFromValue(parsed ?? block?.arguments);
  if (fromParsed) return fromParsed;

  const text = raw.trim();
  if (!text) return "";
  if (text.startsWith("{") || text.startsWith("[")) return "";
  return raw;
}

function recoverTextFromValue(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  for (const key of ["text", "content", "message", "body", "input"]) {
    if (typeof value[key] === "string") return value[key];
  }
  return "";
}

function parseJsonLike(raw) {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text || (!text.startsWith("{") && !text.startsWith("[") && !text.startsWith("\""))) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function createErrorMessage(error) {
  return {
    role: "assistant",
    content: [],
    api: "unknown",
    provider: "unknown",
    model: "unknown",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage: error instanceof Error ? error.message : String(error),
    timestamp: Date.now(),
  };
}
