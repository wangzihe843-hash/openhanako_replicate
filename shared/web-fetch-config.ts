import { DeepSeekToolError, normalizeCredentialProvider } from "./deepseek-tools.ts";
import { isMaskedSecretValue } from "./secret-custody.ts";

export type WebFetchConfig = {
  provider?: string;
  api_key?: string | null;
  credential_provider?: string;
};

/** A separate opt-in: possessing Search/model credentials never enables Fetch. */
export function normalizeWebFetchPatch(value: unknown): WebFetchConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DeepSeekToolError("invalid_config", "Web Fetch configuration must be an object.");
  }
  const raw = value as Record<string, unknown>;
  const patch: WebFetchConfig = {};
  if (raw.provider !== undefined) {
    if (raw.provider !== "direct" && raw.provider !== "deepseek") {
      throw new DeepSeekToolError("invalid_config", "Web Fetch provider must be direct or deepseek.");
    }
    patch.provider = raw.provider;
  }
  if (raw.credential_provider !== undefined) patch.credential_provider = normalizeCredentialProvider(raw.credential_provider);
  if (raw.api_key !== undefined) {
    if (raw.api_key !== null && typeof raw.api_key !== "string") {
      throw new DeepSeekToolError("invalid_config", "Web Fetch API key must be a string.");
    }
    // Masked values are placeholders, never credentials or a request to clear.
    if (!isMaskedSecretValue(raw.api_key)) patch.api_key = (raw.api_key as string | null)?.trim() || "";
  }
  return patch;
}
