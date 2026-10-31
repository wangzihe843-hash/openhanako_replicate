export const READING_BOOK_CATALOG_PATH = 'apps/reading_notes/book-catalog.jsonl';
export const MAX_IMPORT_BOOKS = 20;

export type BookSearchQuery = {
  q?: string;
  subject?: string;
  title?: string;
  author?: string;
  limit?: number;
};

export type BookSearchResult = {
  key: string;
  title: string;
  authors: string[];
  description?: string;
  subjects?: string[];
  firstPublishYear?: number;
  languages?: string[];
  coverId?: number;
  isbn?: string[];
  openLibraryUrl?: string;
};

export type AgentBookTagContext = {
  reason: string;
  interests: string[];
  createdAt?: string;
};

export type XingyeBookAgentTag = {
  agentId: string;
  reason: string;
  interests: string[];
  createdAt: string;
};

export type XingyeBookCatalogEntry = BookSearchResult & {
  id: string;
  dedupeKey: string;
  agentTags: XingyeBookAgentTag[];
  createdAt: string;
  updatedAt: string;
};

export type SafeReadingBookContext = Pick<BookSearchResult, 'title' | 'authors' | 'description' | 'subjects'>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function cleanText(value: unknown, max = 600): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim().replace(/\s+/g, ' ');
  if (!text) return undefined;
  return text.length > max ? text.slice(0, max) : text;
}

function cleanTextList(value: unknown, maxItems: number, maxChars: number): string[] {
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

function cleanYear(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const year = Math.trunc(value);
  return year > 0 ? year : undefined;
}

function cleanCoverId(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const coverId = Math.trunc(value);
  return coverId > 0 ? coverId : undefined;
}

function normalizeBookSearchResult(raw: unknown): BookSearchResult | null {
  if (!isRecord(raw)) return null;
  const title = cleanText(raw.title, 240);
  if (!title) return null;
  const key = cleanText(raw.key, 240) ?? '';
  const authors = cleanTextList(raw.authors, 8, 120);
  return {
    key,
    title,
    authors,
    description: cleanText(raw.description, 1200),
    subjects: cleanTextList(raw.subjects, 20, 80),
    firstPublishYear: cleanYear(raw.firstPublishYear),
    languages: cleanTextList(raw.languages, 12, 16),
    coverId: cleanCoverId(raw.coverId),
    isbn: cleanTextList(raw.isbn, 10, 32),
    openLibraryUrl: cleanText(raw.openLibraryUrl, 300),
  };
}

export function normalizeCatalogEntry(raw: unknown): XingyeBookCatalogEntry | null {
  if (!isRecord(raw)) return null;
  const book = normalizeBookSearchResult(raw);
  const id = cleanText(raw.id, 120);
  const dedupeKey = cleanText(raw.dedupeKey, 300);
  if (!book || !id || !dedupeKey) return null;
  const tags = Array.isArray(raw.agentTags)
    ? raw.agentTags
      .map((tag): XingyeBookAgentTag | null => {
        if (!isRecord(tag)) return null;
        const agentId = cleanText(tag.agentId, 120);
        const reason = cleanText(tag.reason, 500);
        const createdAt = cleanText(tag.createdAt, 80);
        if (!agentId || !reason || !createdAt) return null;
        return {
          agentId,
          reason,
          interests: cleanTextList(tag.interests, 12, 80),
          createdAt,
        };
      })
      .filter((tag): tag is XingyeBookAgentTag => Boolean(tag))
    : [];
  return {
    ...book,
    id,
    dedupeKey,
    agentTags: tags,
    createdAt: cleanText(raw.createdAt, 80) ?? new Date(0).toISOString(),
    updatedAt: cleanText(raw.updatedAt, 80) ?? new Date(0).toISOString(),
  };
}

function normalizeDedupePart(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function dedupeKeyForBook(book: BookSearchResult): string {
  const key = cleanText(book.key, 240);
  if (key) return `ol:${normalizeDedupePart(key)}`;
  const isbn = book.isbn?.map((item) => item.trim()).find(Boolean);
  if (isbn) return `isbn:${normalizeDedupePart(isbn)}`;
  return `title:${normalizeDedupePart(book.title)}::authors:${book.authors.map(normalizeDedupePart).join('|')}`;
}

function normalizeTag(agentId: string, tagContext: AgentBookTagContext, createdAt: string): XingyeBookAgentTag {
  return {
    agentId,
    reason: cleanText(tagContext.reason, 500) ?? 'manual import',
    interests: cleanTextList(tagContext.interests, 12, 80),
    createdAt: cleanText(tagContext.createdAt, 80) ?? createdAt,
  };
}

function tagIdentityKey(tag: XingyeBookAgentTag): string {
  const interests = [...tag.interests].sort().join('|');
  return `${tag.agentId}::${tag.reason}::${interests}`;
}

export type ReadingBookCatalogMutation =
  | { type: 'import'; entries: XingyeBookCatalogEntry[] }
  | { type: 'delete'; bookId: string };

export type ReadingBookCatalogResult = { imported: XingyeBookCatalogEntry[]; deleted: boolean };

export function prepareReadingBookImports(
  agentId: string, books: BookSearchResult[], tagContext: AgentBookTagContext,
  idFactory: () => string, now: () => string,
): XingyeBookCatalogEntry[] {
  return books.slice(0, MAX_IMPORT_BOOKS).map(normalizeBookSearchResult)
    .filter((book): book is BookSearchResult => book !== null)
    .map((book) => {
      const timestamp = now();
      return { ...book, id: idFactory(), dedupeKey: dedupeKeyForBook(book),
        agentTags: [normalizeTag(agentId, tagContext, timestamp)], createdAt: timestamp, updatedAt: timestamp };
    });
}

/** Validate again at the server boundary; callers cannot set another owner's tags. */
export function normalizeReadingBookCatalogMutation(agentId: string, raw: unknown): ReadingBookCatalogMutation {
  if (isRecord(raw) && raw.type === 'delete') {
    const bookId = cleanText(raw.bookId, 120);
    if (bookId) return { type: 'delete', bookId };
  }
  if (isRecord(raw) && raw.type === 'import' && Array.isArray(raw.entries) && raw.entries.length <= MAX_IMPORT_BOOKS) {
    const entries = raw.entries.map((entry) => {
      const book = normalizeCatalogEntry(entry);
      if (!book || book.agentTags.length !== 1 || book.agentTags[0].agentId !== agentId) {
        throw new Error('Invalid reading book import');
      }
      return { ...book, dedupeKey: dedupeKeyForBook(book) };
    });
    return { type: 'import', entries };
  }
  throw new Error('Invalid reading catalog mutation');
}

/** Plan changes against the latest rows without discarding unknown or malformed rows.
 * Undefined rows represent unparseable lines. Null replacements delete only targeted rows.
 */
export function planReadingBookCatalogMutation(records: unknown[], mutation: ReadingBookCatalogMutation) {
  const replacements = new Map<number, Record<string, unknown> | null>();
  const appended: Record<string, unknown>[] = [];
  const result: ReadingBookCatalogResult = { imported: [], deleted: false };
  const byKey = new Map<string, { row: Record<string, unknown>; index: number }>();
  const ids = new Set<string>();
  records.forEach((row, index) => {
    const book = normalizeCatalogEntry(row);
    if (isRecord(row) && typeof row.id === 'string') ids.add(row.id);
    if (book && isRecord(row)) {
      ids.add(book.id);
      if (mutation.type === 'delete' && book.id === mutation.bookId) {
        replacements.set(index, null);
        result.deleted = true;
      }
      byKey.set(book.dedupeKey, { row, index });
    }
  });
  if (mutation.type === 'delete') return { replacements, appended, result };
  for (const book of mutation.entries) {
    const found = byKey.get(book.dedupeKey);
    let next: Record<string, unknown>;
    if (found) {
      const current = normalizeCatalogEntry(found.row)!;
      const tag = book.agentTags[0];
      const tags = Array.isArray(found.row.agentTags) ? found.row.agentTags : [];
      next = {
        ...found.row,
        title: book.title || current.title,
        authors: book.authors.length ? book.authors : current.authors,
        description: book.description ?? current.description,
        subjects: book.subjects?.length ? book.subjects : current.subjects,
        firstPublishYear: book.firstPublishYear ?? current.firstPublishYear,
        languages: book.languages?.length ? book.languages : current.languages,
        coverId: book.coverId ?? current.coverId,
        isbn: book.isbn?.length ? book.isbn : current.isbn,
        openLibraryUrl: book.openLibraryUrl ?? current.openLibraryUrl,
        agentTags: current.agentTags.some((item) => tagIdentityKey(item) === tagIdentityKey(tag)) ? tags : [...tags, tag],
        updatedAt: book.updatedAt,
      };
      if (found.index < records.length) replacements.set(found.index, next);
      else appended[found.index - records.length] = next;
      byKey.set(book.dedupeKey, { row: next, index: found.index });
    } else {
      if (ids.has(book.id)) throw new Error('Reading book ID already exists');
      ids.add(book.id);
      next = { ...book };
      byKey.set(book.dedupeKey, { row: next, index: records.length + appended.length });
      appended.push(next);
    }
    result.imported.push(normalizeCatalogEntry(next)!);
  }
  return { replacements, appended, result };
}

/** Synchronous development transaction. Production preserves bytes with the same plan. */
export function mutateReadingBookCatalogText(content: string, agentId: string, raw: ReadingBookCatalogMutation) {
  const mutation = normalizeReadingBookCatalogMutation(agentId, raw);
  const lines = content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const records = lines.map((line) => { try { return JSON.parse(line); } catch { return undefined; } });
  const plan = planReadingBookCatalogMutation(records, mutation);
  let next = lines.map((line, index) => {
    if (!plan.replacements.has(index)) return line;
    const row = plan.replacements.get(index);
    return row === null ? '' : JSON.stringify(row) + (line.endsWith('\r\n') ? '\r\n' : line.endsWith('\n') ? '\n' : '');
  }).join('');
  if (plan.appended.length) {
    if (next && !next.endsWith('\n')) next += '\n';
    next += plan.appended.map((row) => JSON.stringify(row) + '\n').join('');
  }
  return { content: next, result: plan.result };
}
