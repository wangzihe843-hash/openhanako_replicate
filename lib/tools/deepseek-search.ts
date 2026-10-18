import { DeepSeekToolError, deepSeekAbortError } from "../../shared/deepseek-tools.ts";
import { SearchRateLimitError, retryAfterMsFromHeaders } from "./search-rate-limiter.ts";

const SEARCH_URL = "https://api.deepseek.com/v1/tools/search";

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
      throw new SearchRateLimitError("DeepSeek Search HTTP 429", { retryAfterMs: retryAfterMsFromHeaders(response.headers) });
    }
    if (!response.ok) {
      const code = response.status === 402 ? "balance" : response.status === 401 || response.status === 403 ? "auth" : "http_error";
      throw new DeepSeekToolError(code, `DeepSeek Search HTTP ${response.status}.`);
    }
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new DeepSeekToolError("invalid_response", "DeepSeek Search returned invalid JSON.");
    }
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
