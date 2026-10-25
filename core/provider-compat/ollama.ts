/**
 * Ollama OpenAI Chat Completions transport (provider: ollama).
 *
 * Ollama 0.40.11 reads max_tokens, not Pi's default max_completion_tokens;
 * reasoning_effort: none explicitly disables thinking. Protocol source:
 * https://github.com/ollama/ollama/blob/v0.40.11/openai/openai.go
 *
 * Keep Hana's explicit outputCapField and thinkingLevelMap.off authoritative.
 * Delete when Pi and Hana's shared cleanup preserve this transport contract
 * for both SDK chat requests and buffered callText utility requests.
 */

const OUTPUT_CAP_FIELDS = ["max_tokens", "max_completion_tokens", "max_output_tokens", "maxOutputTokens"];

export function matches(model) {
  return typeof model?.provider === "string"
    && model.provider.trim().toLowerCase() === "ollama"
    && model.api === "openai-completions";
}

function normalizeOutputCap(payload, model) {
  const fields = OUTPUT_CAP_FIELDS.filter(field => Object.prototype.hasOwnProperty.call(payload, field));
  const caps = fields.map(field => Number(payload[field])).filter(value => Number.isFinite(value) && value >= 1);
  if (caps.length === 0) return payload;
  const explicit = model?.compat?.outputCapField;
  const field = OUTPUT_CAP_FIELDS.includes(explicit) ? explicit : "max_tokens";
  // Shared budget policy has already bounded each cap. Alias collisions must
  // never raise a smaller SDK/context/user budget or leave an ignored alias.
  const cap = Math.floor(Math.min(...caps));
  if (fields.length === 1 && fields[0] === field && payload[field] === cap) return payload;
  const result = { ...payload };
  for (const key of fields) delete result[key];
  result[field] = cap;
  return result;
}

export function apply(payload, model, options: { mode?: string; reasoningLevel?: string } = {}) {
  const result = normalizeOutputCap(payload, model);
  const mode = options.mode || "chat";
  const disable = mode === "utility"
    || model?.reasoning === false
    || (mode === "chat" && options.reasoningLevel === "off");
  if (!disable) return result;
  const mapped = model?.thinkingLevelMap?.off;
  // null means off is unsupported: retain the SDK's clamped effort instead.
  if (mapped === null) return result;
  const effort = typeof mapped === "string" && mapped.length > 0 ? mapped : "none";
  return result.reasoning_effort === effort ? result : { ...result, reasoning_effort: effort };
}
