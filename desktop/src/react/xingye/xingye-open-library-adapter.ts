import type { BookSearchQuery, BookSearchResult } from './xingye-reading-book-catalog';

export type { BookSearchQuery, BookSearchResult } from './xingye-reading-book-catalog';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const OPEN_LIBRARY_BASE = 'https://openlibrary.org';
const MAX_SEARCH_LIMIT = 20;
const DEFAULT_SEARCH_LIMIT = 10;

export type BookSearchTopicSource = {
  topics?: string[];
  profile?: Record<string, unknown> | null;
  loreText?: string | null;
  limit?: number;
};

function cleanText(value: unknown, max = 600): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim().replace(/\s+/g, ' ');
  if (!text) return undefined;
  return text.length > max ? text.slice(0, max) : text;
}

function cleanList(value: unknown, maxItems: number, maxChars: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const text = cleanText(item, maxChars);
    if (!text) continue;
    if (!out.includes(text)) out.push(text);
    if (out.length >= maxItems) break;
  }
  return out;
}

function clampLimit(limit: unknown): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return DEFAULT_SEARCH_LIMIT;
  return Math.min(MAX_SEARCH_LIMIT, Math.max(1, Math.trunc(limit)));
}

function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : undefined;
}

function subjectSlug(subject: string): string {
  return encodeURIComponent(subject.trim().toLowerCase().replace(/\s+/g, '_'));
}

function openLibraryUrlForKey(key: string): string | undefined {
  const clean = key.trim();
  if (!clean) return undefined;
  return `${OPEN_LIBRARY_BASE}${clean.startsWith('/') ? clean : `/${clean}`}`;
}

function normalizeSearchDoc(raw: unknown): BookSearchResult | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const doc = raw as Record<string, unknown>;
  const title = cleanText(doc.title, 240);
  if (!title) return null;
  const key = cleanText(doc.key, 240) ?? '';
  const subjects = cleanList(doc.subject, 20, 80);
  const isbn = cleanList(doc.isbn, 10, 32);
  const result: BookSearchResult = {
    key,
    title,
    authors: cleanList(doc.author_name, 8, 120),
    firstPublishYear: numberField(doc.first_publish_year),
    subjects,
    languages: cleanList(doc.language, 12, 16),
    coverId: numberField(doc.cover_i),
    openLibraryUrl: openLibraryUrlForKey(key),
  };
  if (isbn.length) result.isbn = isbn;
  return result;
}

function normalizeSubjectWork(raw: unknown): BookSearchResult | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const work = raw as Record<string, unknown>;
  const title = cleanText(work.title, 240);
  if (!title) return null;
  const key = cleanText(work.key, 240) ?? '';
  const authors = Array.isArray(work.authors)
    ? work.authors
      .map((author) => (author && typeof author === 'object' && !Array.isArray(author)
        ? cleanText((author as Record<string, unknown>).name, 120)
        : cleanText(author, 120)))
      .filter((name): name is string => Boolean(name))
      .slice(0, 8)
    : [];
  return {
    key,
    title,
    authors,
    firstPublishYear: numberField(work.first_publish_year),
    subjects: cleanList(work.subject, 20, 80),
    coverId: numberField(work.cover_id),
    openLibraryUrl: openLibraryUrlForKey(key),
  };
}

function buildSearchUrl(query: BookSearchQuery): string {
  const limit = clampLimit(query.limit);
  const subject = cleanText(query.subject, 120);
  if (subject && !cleanText(query.q) && !cleanText(query.title) && !cleanText(query.author)) {
    const url = new URL(`${OPEN_LIBRARY_BASE}/subjects/${subjectSlug(subject)}.json`);
    url.searchParams.set('limit', String(limit));
    return url.href;
  }

  const url = new URL(`${OPEN_LIBRARY_BASE}/search.json`);
  const q = cleanText(query.q, 240);
  const title = cleanText(query.title, 240);
  const author = cleanText(query.author, 240);
  if (q) url.searchParams.set('q', q);
  if (title) url.searchParams.set('title', title);
  if (author) url.searchParams.set('author', author);
  if (subject) url.searchParams.set('subject', subject);
  url.searchParams.set('limit', String(limit));
  return url.href;
}

function hasQueryTerm(query: BookSearchQuery): boolean {
  return Boolean(cleanText(query.q) || cleanText(query.subject) || cleanText(query.title) || cleanText(query.author));
}

export async function searchOpenLibraryBooks(
  query: BookSearchQuery,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
): Promise<BookSearchResult[]> {
  if (!hasQueryTerm(query)) {
    throw new Error('至少提供 q、subject、title 或 author 之一。');
  }
  const url = buildSearchUrl(query);
  let response: Response;
  try {
    response = await fetchImpl(url, { headers: { Accept: 'application/json' } });
  } catch (err) {
    throw new Error(`Open Library 查询失败：${err instanceof Error ? err.message : String(err)}`);
  }
  if (!response.ok) {
    throw new Error(`Open Library 查询失败：HTTP ${response.status}`);
  }
  let data: unknown;
  try {
    data = await response.json();
  } catch (err) {
    throw new Error(`Open Library 查询失败：响应不是 JSON（${err instanceof Error ? err.message : String(err)}）`);
  }
  const record = data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : {};
  const rawItems = Array.isArray(record.works) ? record.works : Array.isArray(record.docs) ? record.docs : [];
  const normalizer = Array.isArray(record.works) ? normalizeSubjectWork : normalizeSearchDoc;
  return rawItems
    .map(normalizer)
    .filter((item): item is BookSearchResult => Boolean(item))
    .slice(0, clampLimit(query.limit));
}

function topicFromChunk(chunk: string): string | null {
  let text = chunk.trim();
  if (!text || text.length < 3) return null;
  text = text.replace(/^(常在|经常在|关注|偏好|关于|会读|也会读)/, '').trim();
  text = text.replace(/[。.!?！？；;，,、]+$/g, '').trim();
  if (!text || text.length < 3) return null;
  return text.length > 40 ? text.slice(0, 40) : text;
}

function pushTopic(out: string[], raw: unknown, limit: number): void {
  const text = cleanText(raw, 120);
  if (!text) return;
  for (const chunk of text.split(/[\n\r。.!?！？；;，,、]+/g)) {
    const topic = topicFromChunk(chunk);
    if (!topic || out.includes(topic)) continue;
    out.push(topic);
    if (out.length >= limit) return;
  }
}

export function buildBookSearchTopics(source: BookSearchTopicSource): string[] {
  const limit = clampLimit(source.limit ?? 7);
  const out: string[] = [];
  for (const topic of source.topics ?? []) {
    pushTopic(out, topic, limit);
    if (out.length >= limit) return out;
  }
  const profile = source.profile ?? {};
  for (const key of [
    'shortBio',
    'identitySummary',
    'backgroundSummary',
    'personalitySummary',
    'values',
    'relationshipLabel',
  ]) {
    pushTopic(out, profile[key], limit);
    if (out.length >= limit) return out;
  }
  pushTopic(out, source.loreText, limit);
  return out;
}
