/**
 * Zhipu GLM OpenAI-compatible provider compatibility.
 *
 * Zhipu uses the OpenAI chat-completions shape but rejects several OpenAI-only
 * request fields. Keep the provider contract explicit instead of relying on
 * server-side defaults or silent provider fallback.
 */

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

function lower(value) {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function isThinkingOff(value) {
  if (value === false || value == null) return value === false;
  const normalized = lower(value);
  return normalized === "" || normalized === "none" || normalized === "off" || normalized === "disabled";
}

export function matches(model) {
  if (!model || typeof model !== "object") return false;
  const provider = lower(model.provider);
  const baseUrl = lower(model.baseUrl || model.base_url);
  return provider === "zhipu" || baseUrl.includes("open.bigmodel.cn");
}

function normalizeMaxTokenField(payload) {
  if (!hasOwn(payload, "max_completion_tokens")) return payload;
  const next = { ...payload };
  if (!hasOwn(next, "max_tokens")) {
    next.max_tokens = next.max_completion_tokens;
  }
  delete next.max_completion_tokens;
  return next;
}

function normalizeTools(tools) {
  if (!Array.isArray(tools)) return { value: tools, changed: false };

  let changed = false;
  const value = tools.map((tool) => {
    if (!tool || typeof tool !== "object") return tool;
    let next = tool;
    if (hasOwn(next, "strict")) {
      next = { ...next };
      delete next.strict;
      changed = true;
    }
    if (next.function && typeof next.function === "object" && hasOwn(next.function, "strict")) {
      if (next === tool) next = { ...next };
      next.function = { ...next.function };
      delete next.function.strict;
      changed = true;
    }
    return next;
  });

  return { value, changed };
}

function normalizeThinking(payload, model, options) {
  const off = options?.mode === "utility"
    || isThinkingOff(options?.reasoningLevel)
    || payload.thinking?.type === "disabled";
  const wantsThinking = !off && (
    hasOwn(payload, "reasoning_effort")
    || model?.reasoning === true
    || payload.thinking?.type === "enabled"
  );
  if (!off && !wantsThinking && !hasOwn(payload, "reasoning_effort")) return payload;

  const next = { ...payload };
  delete next.reasoning_effort;
  next.thinking = { type: off ? "disabled" : "enabled" };
  return next;
}

export function apply(payload, model, options = {}) {
  let next = normalizeMaxTokenField(payload);

  if (hasOwn(next, "store")) {
    if (next === payload) next = { ...next };
    delete next.store;
  }
  if (hasOwn(next, "stream_options")) {
    if (next === payload) next = { ...next };
    delete next.stream_options;
  }

  const tools = normalizeTools(next.tools);
  if (tools.changed) {
    if (next === payload) next = { ...next };
    next.tools = tools.value;
  }

  next = normalizeThinking(next, model, options);
  return next;
}
