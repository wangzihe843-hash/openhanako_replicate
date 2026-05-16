import { hanaFetchAllowingErrors } from '../hooks/use-hana-fetch';

export type WikiquoteSourceCitation = {
  provider: 'wikiquote';
  lang: 'en' | 'zh';
  pageTitle: string;
  pageUrl: string;
};

export type WikiquoteSuggestion = {
  text: string;
  sourceCitation: WikiquoteSourceCitation;
};

export type FetchWikiquoteParams = {
  title: string;
  authors?: string[];
  lang?: 'en' | 'zh';
};

type ProxyFetchLike = (input: string, init?: RequestInit & { timeout?: number }) => Promise<Response>;

const MAX_SUGGESTIONS = 10;

function isWikiquoteSuggestion(value: unknown): value is WikiquoteSuggestion {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (typeof record.text !== 'string' || !record.text.trim()) return false;
  const sc = record.sourceCitation as Record<string, unknown> | undefined;
  if (!sc || sc.provider !== 'wikiquote') return false;
  if (sc.lang !== 'en' && sc.lang !== 'zh') return false;
  if (typeof sc.pageTitle !== 'string' || typeof sc.pageUrl !== 'string') return false;
  return true;
}

/**
 * 通过本地服务端代理 `POST /api/xingye/quotes/search` 拉 Wikiquote 候选引文。
 * Wikiquote 是 CC BY-SA 公开站点，本路由只返回 `* "..."` 形式的原话条目，不抓全文。
 *
 * 返回的 suggestion 仅作 UI chip 展示——用户必须点选才会落盘，落盘时 `quote.source = user_provided`，
 * `sourceCitation` 一并保存以便回溯出处。
 */
export async function fetchWikiquoteSuggestions(
  params: FetchWikiquoteParams,
  fetchImpl: ProxyFetchLike = hanaFetchAllowingErrors,
): Promise<WikiquoteSuggestion[]> {
  const title = params.title?.trim();
  const authors = (params.authors ?? []).map((a) => a?.trim()).filter(Boolean).slice(0, 4);
  const lang = params.lang === 'zh' ? 'zh' : 'en';
  if (!title && authors.length === 0) {
    throw new Error('至少提供 title 或 authors 之一。');
  }

  let response: Response;
  try {
    response = await fetchImpl('/api/xingye/quotes/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      timeout: 12_000,
      body: JSON.stringify({ title, authors, lang }),
    });
  } catch (err) {
    throw new Error(`Wikiquote 查询失败：${err instanceof Error ? err.message : String(err)}`);
  }
  if (response.status === 404) {
    throw new Error('Wikiquote 代理路由未就绪（HTTP 404）。请重启 Hana 服务让 /api/xingye/quotes/search 路由生效。');
  }
  let payload: { ok?: boolean; error?: string; quotes?: unknown } | null = null;
  try {
    payload = await response.json();
  } catch (err) {
    if (!response.ok) {
      throw new Error(`Wikiquote 查询失败：HTTP ${response.status} ${response.statusText || ''}`.trim());
    }
    throw new Error(`Wikiquote 查询失败：响应不是 JSON（${err instanceof Error ? err.message : String(err)}）`);
  }
  if (!response.ok || payload?.ok === false || payload?.error) {
    throw new Error(payload?.error || `Wikiquote 查询失败：HTTP ${response.status}`);
  }
  const raw = Array.isArray(payload?.quotes) ? payload.quotes : [];
  return raw.filter(isWikiquoteSuggestion).slice(0, MAX_SUGGESTIONS);
}
