/** Shared configuration rules for DeepSeek's standalone tools (not model APIs). */
export const DEEPSEEK_SEARCH_PROVIDER = "deepseek";

export function isOfficialDeepSeekBaseUrl(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && url.hostname === "api.deepseek.com"
      && !url.port && !url.username && !url.password && !url.search && !url.hash
      && ["/", "/v1", "/v1/"].includes(url.pathname);
  } catch {
    return false;
  }
}

export function normalizeCredentialProvider(value: unknown): string {
  if (value == null) return "";
  if (typeof value !== "string") {
    throw new DeepSeekToolError("invalid_reference", "DeepSeek credential_provider must be a provider ID.");
  }
  return value.trim();
}

/** Messages are local constants: never include response bodies, keys or resolver errors. */
export class DeepSeekToolError extends Error {
  declare code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "DeepSeekToolError";
  }
}

export function deepSeekAbortError(): DeepSeekToolError {
  return new DeepSeekToolError("cancelled", "Search cancelled.");
}
