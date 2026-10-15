/** Apply endpoint-specific reference defaults, never user or discovered budgets. */
export function applyModelContextDefault<T extends { context?: number }>(
  metadata: T,
  provider: string,
  modelId: string,
  baseUrl?: string,
): T {
  if (!metadata || provider !== "kimi-coding" || modelId !== "kimi-for-coding"
    || typeof baseUrl !== "string") return metadata;

  // Check the original configured URL as well as the parsed URL. URL parsing
  // alone accepts userinfo, empty query/hash delimiters and normalized paths.
  const endpoint = /^https:\/\/api\.kimi\.(?:com|ai)(?::443)?(\/[^?#\\\s]*)$/i.exec(baseUrl);
  if (!endpoint) return metadata;
  try {
    const url = new URL(baseUrl);
    const pathname = endpoint[1].replace(/\/+$/, "");
    if (url.protocol !== "https:" || url.username || url.password || url.port
      || (url.hostname !== "api.kimi.com" && url.hostname !== "api.kimi.ai")
      || url.search || url.hash
      || (pathname !== "/coding" && pathname !== "/coding/v1")) return metadata;
  } catch {
    return metadata;
  }

  return metadata.context === 1048576 ? metadata : { ...metadata, context: 1048576 };
}

/** Read-only budget projection for the exact K2.8 entry, not its wire API. */
export function resolveKimiContextBudget({
  provider, modelId, baseUrl, providerApi, providerKnownApi, model,
  builtinContext = 1048576,
}: {
  provider?: string;
  modelId: string;
  baseUrl?: string;
  providerApi?: string;
  providerKnownApi?: unknown;
  model?: { api?: unknown; context?: unknown; contextWindow?: unknown; [key: string]: unknown } | null;
  // Pi 1.2's exact kimi-coding/kimi-for-coding builtin; backend callers pass
  // the installed SDK value, renderer callers are locked by runtime tests.
  builtinContext?: number;
}): { context: number; source: 'explicit' | 'builtin' | 'reference'; projection: 'builtin' | 'ordinary' } | undefined {
  if (provider !== 'kimi-coding' || modelId !== 'kimi-for-coding') return undefined;

  let projectionApi = providerApi || 'openai-completions';
  // Mirror model-sync's existing provider API selection. This intentionally
  // uses the legacy URL rule, separately from the strict reference promotion.
  // A model-level Anthropic override can select builtin budgets even on .com,
  // where a later transport stage changes the final API back to OpenAI.
  try {
    const url = new URL(baseUrl || '');
    const pathname = url.pathname.replace(/\/+$/, '');
    if (url.hostname === 'api.kimi.com' && (pathname === '/coding' || pathname === '/coding/v1')) {
      projectionApi = 'openai-completions';
    }
  } catch { /* An invalid/missing endpoint cannot select the .com branch. */ }
  projectionApi = (typeof model?.api === 'string' && model.api)
    || (typeof providerKnownApi === 'string' && providerKnownApi)
    || projectionApi;
  const projection = projectionApi === 'anthropic-messages' ? 'builtin' : 'ordinary';
  const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  const context = number(model?.context);
  const window = number(model?.contextWindow);
  const explicit = projection === 'builtin' ? window ?? context : context ?? window;
  if (explicit !== undefined) return { context: explicit, source: 'explicit', projection };
  if (projection === 'builtin') return { context: builtinContext, source: 'builtin', projection };
  return {
    context: applyModelContextDefault({ context: 262144 }, provider, modelId, baseUrl).context,
    source: 'reference', projection,
  };
}
