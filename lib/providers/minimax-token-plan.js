/**
 * MiniMax Token Plan provider plugin (API key)
 *
 * This entry keeps the OpenAI-compatible Token Plan API separate from the
 * Anthropic-compatible MiniMax provider so callers choose the wire protocol
 * explicitly.
 */

/** @type {import('../../core/provider-registry.js').ProviderPlugin} */
export const minimaxTokenPlanPlugin = {
  id: "minimax-token-plan",
  displayName: "MiniMax Token Plan",
  authType: "api-key",
  defaultBaseUrl: "https://api.minimax.io/v1",
  defaultApi: "openai-completions",
};
