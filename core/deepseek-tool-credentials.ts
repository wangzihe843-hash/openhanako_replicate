import {
  DeepSeekToolError,
  isOfficialDeepSeekBaseUrl,
  normalizeCredentialProvider,
} from "../shared/deepseek-tools.ts";
import { isMaskedSecretValue } from "../shared/secret-custody.ts";

type CredentialSource = {
  providerRegistry: {
    getAllProvidersRaw(): Record<string, unknown>;
    get(id: string): { id: string; baseUrl?: string; authType?: string } | null;
  };
  resolveProviderCredentials(id: string): { api_key?: string; base_url?: string };
};

/** Resolve a pinned catalog ID at use time. Nothing here stores or projects a key. */
export function resolveDeepSeekToolApiKey(providerId: unknown, source: CredentialSource): string {
  const id = normalizeCredentialProvider(providerId);
  if (!id) {
    throw new DeepSeekToolError("reference_required", "Select an official DeepSeek model provider or enter a separate Search API key. Multiple accounts require an explicit selection.");
  }
  try {
    const raw = source.providerRegistry.getAllProvidersRaw();
    const entry = source.providerRegistry.get(id);
    if (!Object.prototype.hasOwnProperty.call(raw, id) || !entry || entry.id !== id) {
      throw new DeepSeekToolError("reference_missing", "The referenced DeepSeek provider was removed or renamed. Select it again.");
    }
    const saved = raw[id] as { auth_type?: unknown; base_url?: unknown } | null;
    if (entry.authType !== "api-key" || (saved?.auth_type && saved.auth_type !== "api-key")
      || !isOfficialDeepSeekBaseUrl(saved?.base_url || entry.baseUrl)) {
      throw new DeepSeekToolError("reference_not_official", "The referenced provider must use an API key and the official DeepSeek HTTPS endpoint.");
    }
    // The existing credential resolver owns catalog access; never read credential files here.
    const credentials = source.resolveProviderCredentials(id);
    if (!isOfficialDeepSeekBaseUrl(credentials.base_url)) {
      throw new DeepSeekToolError("reference_not_official", "The referenced provider must use the official DeepSeek HTTPS endpoint.");
    }
    const key = credentials.api_key?.trim();
    if (!key || isMaskedSecretValue(key)) {
      throw new DeepSeekToolError("key_missing", "The referenced DeepSeek provider has no API key.");
    }
    return key;
  } catch (error) {
    if (error instanceof DeepSeekToolError) throw error;
    throw new DeepSeekToolError("credentials_unavailable", "DeepSeek credentials could not be resolved.");
  }
}
