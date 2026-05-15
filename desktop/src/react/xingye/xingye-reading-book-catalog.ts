import type { XingyeStorageBackend } from './xingye-storage-backend';
import {
  createXingyeStore,
  generateXingyeId,
  nowIso,
  requireSafeXingyeAgentId,
} from './xingye-store-utils';

const READING_BOOK_CATALOG_PATH = 'apps/reading_notes/book-catalog.jsonl';
const MAX_IMPORT_BOOKS = 20;

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

export type XingyeBookCatalogStoreOptions = {
  idFactory?: () => string;
  now?: () => string;
};

export type XingyeBookCatalogStoreApi = {
  importBooksForAgent(
    agentId: string,
    books: BookSearchResult[],
    tagContext: AgentBookTagContext,
  ): Promise<XingyeBookCatalogEntry[]>;
  listBooksForAgent(agentId: string): Promise<XingyeBookCatalogEntry[]>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cleanText(value: unknown, max = 600): string | undefined {
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

function normalizeCatalogEntry(raw: unknown): XingyeBookCatalogEntry | null {
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

export function readingBookCatalogPath(): string {
  return READING_BOOK_CATALOG_PATH;
}

export function createXingyeBookCatalogStore(
  backend?: XingyeStorageBackend,
  options: XingyeBookCatalogStoreOptions = {},
): XingyeBookCatalogStoreApi {
  const store = createXingyeStore(backend);
  const idFactory = options.idFactory ?? (() => generateXingyeId('book'));
  const getNow = options.now ?? nowIso;

  return {
    async importBooksForAgent(agentId, books, tagContext) {
      const aid = requireSafeXingyeAgentId(agentId);
      const normalizedBooks = books
        .slice(0, MAX_IMPORT_BOOKS)
        .map(normalizeBookSearchResult)
        .filter((item): item is BookSearchResult => Boolean(item));
      const existing = (await store.listJsonl<unknown>(aid, READING_BOOK_CATALOG_PATH))
        .map(normalizeCatalogEntry)
        .filter((item): item is XingyeBookCatalogEntry => Boolean(item));
      const byKey = new Map(existing.map((entry) => [entry.dedupeKey, entry]));
      const imported: XingyeBookCatalogEntry[] = [];

      for (const book of normalizedBooks) {
        const timestamp = getNow();
        const dedupeKey = dedupeKeyForBook(book);
        const tag = normalizeTag(aid, tagContext, timestamp);
        const current = byKey.get(dedupeKey);
        if (current) {
          const next: XingyeBookCatalogEntry = {
            ...current,
            title: book.title || current.title,
            authors: book.authors.length ? book.authors : current.authors,
            description: book.description ?? current.description,
            subjects: book.subjects?.length ? book.subjects : current.subjects,
            firstPublishYear: book.firstPublishYear ?? current.firstPublishYear,
            languages: book.languages?.length ? book.languages : current.languages,
            coverId: book.coverId ?? current.coverId,
            isbn: book.isbn?.length ? book.isbn : current.isbn,
            openLibraryUrl: book.openLibraryUrl ?? current.openLibraryUrl,
            agentTags: [...current.agentTags, tag],
            updatedAt: timestamp,
          };
          byKey.set(dedupeKey, next);
          imported.push(next);
        } else {
          const next: XingyeBookCatalogEntry = {
            ...book,
            id: idFactory(),
            dedupeKey,
            agentTags: [tag],
            createdAt: timestamp,
            updatedAt: timestamp,
          };
          byKey.set(dedupeKey, next);
          imported.push(next);
        }
      }

      try {
        await store.writeJsonl<XingyeBookCatalogEntry>(aid, READING_BOOK_CATALOG_PATH, Array.from(byKey.values()));
      } catch (err) {
        throw new Error(`保存阅读书目失败：${err instanceof Error ? err.message : String(err)}`);
      }
      return imported;
    },

    async listBooksForAgent(agentId) {
      const aid = requireSafeXingyeAgentId(agentId);
      const rows = await store.listJsonl<unknown>(aid, READING_BOOK_CATALOG_PATH);
      return rows
        .map(normalizeCatalogEntry)
        .filter((entry): entry is XingyeBookCatalogEntry => (
          Boolean(entry) && entry.agentTags.some((tag) => tag.agentId === aid)
        ));
    },
  };
}

export async function importBooksForAgent(
  agentId: string,
  books: BookSearchResult[],
  tagContext: AgentBookTagContext,
): Promise<XingyeBookCatalogEntry[]> {
  return createXingyeBookCatalogStore().importBooksForAgent(agentId, books, tagContext);
}

export async function listBooksForAgent(agentId: string): Promise<XingyeBookCatalogEntry[]> {
  return createXingyeBookCatalogStore().listBooksForAgent(agentId);
}

export async function safeReadingBookContextForAgent(
  agentId: string,
  store: XingyeBookCatalogStoreApi = createXingyeBookCatalogStore(),
): Promise<SafeReadingBookContext[]> {
  const books = await store.listBooksForAgent(agentId);
  return books.map((book) => ({
    title: book.title,
    authors: book.authors,
    description: book.description,
    subjects: book.subjects,
  }));
}
