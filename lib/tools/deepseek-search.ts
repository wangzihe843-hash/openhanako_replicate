import { DeepSeekToolError, deepSeekAbortError } from "../../shared/deepseek-tools.ts";
import { SearchRateLimitError, retryAfterMsFromHeaders } from "./search-rate-limiter.ts";
import { withFetchAbort } from "./web-fetch-url.ts";

const SEARCH_URL = "https://api.deepseek.com/v1/tools/search";
// Search requests omit page content. Allow 50 summary/snippet records, including
// multibyte text and JSON escaping, without accepting unbounded response bodies.
export const MAX_DEEPSEEK_SEARCH_BYTES = 1024 * 1024;

type DeepSeekResult = {
  title: string; url: string; snippet: string; summary: string; content: string;
  rerank_score: number; authority: number;
  site_name: string | null; site_icon: string | null; date: string | null;
};

export function validateDeepSeekQuery(query: string): void {
  const length = Array.from(query).length;
  if (!query.trim() || length > 128) {
    throw new DeepSeekToolError("invalid_query", "DeepSeek Search query must contain 1–128 Unicode characters and cannot be blank.");
  }
}

function validResult(value: unknown): value is DeepSeekResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return ["title", "url", "snippet", "summary", "content"].every(key => typeof row[key] === "string")
    && ["site_name", "site_icon", "date"].every(key => row[key] === null || typeof row[key] === "string")
    && typeof row.rerank_score === "number" && Number.isFinite(row.rerank_score)
    && row.rerank_score >= 0 && row.rerank_score <= 3
    && Number.isInteger(row.authority) && Number(row.authority) >= -1 && Number(row.authority) <= 4;
}

// Keep the Fetch reader's byte accounting and abort/cancel discipline, with a
// Search-specific budget. Fetch exposes the decoded body even for gzip/br.
async function readBoundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const tooLarge = () => new DeepSeekToolError("response_too_large", "DeepSeek Search response exceeded the size limit. Try a narrower query or fewer results.");
  const declaredLength = response.headers.get("content-length");
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > MAX_DEEPSEEK_SEARCH_BYTES) {
    void response.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  const reader = response.body?.getReader();
  if (!reader) throw new DeepSeekToolError("invalid_response", "DeepSeek Search returned no JSON body.");
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await withFetchAbort(reader.read(), signal);
      if (done) break;
      size += value.byteLength;
      if (size > MAX_DEEPSEEK_SEARCH_BYTES) throw tooLarge();
      if (value.byteLength) chunks.push(value);
    }
    // Decode once so a multibyte character split across chunks stays intact.
    return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
  } catch (error) {
    if (error instanceof DeepSeekToolError) throw error;
    throw new DeepSeekToolError("invalid_response", "DeepSeek Search returned invalid JSON.");
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function searchDeepSeek(query: string, count: number, apiKey: string, _provider?: string, signal?: AbortSignal) {
  validateDeepSeekQuery(query);
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 30_000);
  try {
    if (signal?.aborted) throw deepSeekAbortError();
    const response = await fetch(SEARCH_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, count, need_content: false }),
      redirect: "error",
      signal: controller.signal,
    });
    if (response.status === 429) {
      void response.body?.cancel().catch(() => {});
      throw new SearchRateLimitError("DeepSeek Search HTTP 429", { retryAfterMs: retryAfterMsFromHeaders(response.headers) });
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      const code = response.status === 402 ? "balance" : response.status === 401 || response.status === 403 ? "auth" : "http_error";
      throw new DeepSeekToolError(code, `DeepSeek Search HTTP ${response.status}.`);
    }
    const data = await readBoundedJson(response, controller.signal);
    if (signal?.aborted) throw deepSeekAbortError();
    if (timedOut) throw new DeepSeekToolError("timeout", "DeepSeek Search timed out after 30 seconds.");
    const results = (data as { results?: unknown } | null)?.results;
    if (!Array.isArray(results) || !results.every(validResult)) {
      throw new DeepSeekToolError("invalid_response", "DeepSeek Search returned an invalid results schema.");
    }
    return results.slice(0, count).map((row, index) => ({
      title: row.title,
      url: row.url,
      content: row.summary || row.snippet,
      rank: index + 1,
      score: row.rerank_score,
      metadata: { snippet: row.snippet, site_name: row.site_name, site_icon: row.site_icon, date: row.date, authority: row.authority },
    }));
  } catch (error) {
    if (signal?.aborted) throw deepSeekAbortError();
    if (timedOut) throw new DeepSeekToolError("timeout", "DeepSeek Search timed out after 30 seconds.");
    if (error instanceof DeepSeekToolError || error instanceof SearchRateLimitError) throw error;
    throw new DeepSeekToolError("network", "DeepSeek Search request failed.");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
