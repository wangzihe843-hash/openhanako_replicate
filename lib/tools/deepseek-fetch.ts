import { DeepSeekToolError } from "../../shared/deepseek-tools.ts";
import { isMaskedSecretValue } from "../../shared/secret-custody.ts";
import { createSearchRateLimiter, SearchRateLimitError, retryAfterMsFromHeaders } from "./search-rate-limiter.ts";
import type { SearchRateLimiter } from "./search-rate-limiter.ts";
import { isPrivateFetchHost, validateExternalFetchUrl, withFetchAbort } from "./web-fetch-url.ts";

const FETCH_URL = "https://api.deepseek.com/v1/tools/fetch";
export const MAX_DEEPSEEK_FETCH_BYTES = 2 * 1024 * 1024;
const defaultLimiter = createSearchRateLimiter();
export type FetchRateLimiter = Pick<SearchRateLimiter, "run">;

async function readBoundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (Number(response.headers.get("content-length")) > MAX_DEEPSEEK_FETCH_BYTES) {
    void response.body?.cancel().catch(() => {});
    throw new DeepSeekToolError("response_too_large", "DeepSeek Fetch response exceeded the size limit.");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new DeepSeekToolError("invalid_response", "DeepSeek Fetch returned no JSON body.");
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await withFetchAbort(reader.read(), signal);
      if (done) break;
      size += value.byteLength;
      if (size > MAX_DEEPSEEK_FETCH_BYTES) throw new DeepSeekToolError("response_too_large", "DeepSeek Fetch response exceeded the size limit.");
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new DeepSeekToolError("invalid_response", "DeepSeek Fetch returned invalid JSON."); }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function fetchDeepSeek(url: string, resolveApiKey: () => string, signal: AbortSignal, rateLimiter: FetchRateLimiter = defaultLimiter) {
  try {
    validateExternalFetchUrl(url);
    return await rateLimiter.run("deepseek_fetch", "api", async () => {
      signal.throwIfAborted();
      // Recheck after queueing, before resolving or transmitting any credential.
      if (await withFetchAbort(isPrivateFetchHost(new URL(url).hostname), signal)) {
        throw new DeepSeekToolError("private_or_unresolved_host", "DeepSeek Fetch requires a public, resolvable host.");
      }
      signal.throwIfAborted();
      const apiKey = resolveApiKey()?.trim();
      if (!apiKey || isMaskedSecretValue(apiKey)) throw new DeepSeekToolError("key_missing", "DeepSeek Fetch requires an official provider reference or a separate API key.");
      const response = await withFetchAbort(fetch(FETCH_URL, {
        method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ url }), redirect: "error", signal,
      }), signal);
      if (response.status !== 200) {
        void response.body?.cancel().catch(() => {});
        if (response.status === 429) throw new SearchRateLimitError("DeepSeek Fetch HTTP 429.", { retryAfterMs: retryAfterMsFromHeaders(response.headers) });
        const code = response.status === 401 ? "auth" : response.status === 402 ? "balance"
          : response.status === 403 ? "safety" : response.status === 404 ? "no_content" : "http_error";
        throw new DeepSeekToolError(code, `DeepSeek Fetch HTTP ${response.status}.`);
      }
      if (response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
        void response.body?.cancel().catch(() => {});
        throw new DeepSeekToolError("invalid_response", "DeepSeek Fetch returned an unsupported response type.");
      }
      const data = await readBoundedJson(response, signal);
      signal.throwIfAborted();
      if (!data || typeof data !== "object" || Array.isArray(data)
        || typeof (data as Record<string, unknown>).title !== "string" || typeof (data as Record<string, unknown>).content !== "string") {
        throw new DeepSeekToolError("invalid_response", "DeepSeek Fetch returned an invalid page schema.");
      }
      const page = data as { title: string; content: string };
      if (!page.content.trim()) throw new DeepSeekToolError("empty_body", "DeepSeek Fetch returned no readable content.");
      return page;
    }, signal);
  } catch (error) {
    if (signal.aborted) throw new DeepSeekToolError(signal.reason?.name === "TimeoutError" ? "timeout" : "cancelled", "DeepSeek Fetch timed out or was cancelled.");
    if (error instanceof DeepSeekToolError || error instanceof SearchRateLimitError) throw error;
    throw new DeepSeekToolError("network", "DeepSeek Fetch request failed.");
  }
}
