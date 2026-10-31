import {
  READING_BOOK_CATALOG_PATH, cleanText, normalizeCatalogEntry, prepareReadingBookImports,
  type BookSearchResult, type AgentBookTagContext, type XingyeBookCatalogEntry, type SafeReadingBookContext,
} from '../../../../shared/xingye-reading-book-catalog';
import { createAgentXingyeStorageBackend, type XingyeStorageBackend } from './xingye-storage-backend';
import { postXingyeStorage } from './xingye-storage-api';
import { createXingyeStore, generateXingyeId, nowIso, requireSafeXingyeAgentId } from './xingye-store-utils';
export type { BookSearchQuery, BookSearchResult, AgentBookTagContext, XingyeBookAgentTag,
  XingyeBookCatalogEntry, SafeReadingBookContext } from '../../../../shared/xingye-reading-book-catalog';

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
  deleteBookForAgent(agentId: string, bookId: string): Promise<boolean>;
};

export function readingBookCatalogPath(): string {
  return READING_BOOK_CATALOG_PATH;
}

export function createXingyeBookCatalogStore(
  backend?: XingyeStorageBackend,
  options: XingyeBookCatalogStoreOptions = {},
): XingyeBookCatalogStoreApi {
  const storage = backend ?? createAgentXingyeStorageBackend(postXingyeStorage);
  const store = createXingyeStore(storage);
  const idFactory = options.idFactory ?? (() => generateXingyeId('book'));
  const getNow = options.now ?? nowIso;

  return {
    async importBooksForAgent(agentId, books, tagContext) {
      const aid = requireSafeXingyeAgentId(agentId);
      const entries = prepareReadingBookImports(aid, books, tagContext, idFactory, getNow);
      try {
        if (!storage.mutateReadingBookCatalog) throw new Error('Reading catalog atomic writes are unavailable; upgrade the storage backend');
        const result = await storage.mutateReadingBookCatalog(aid, { type: 'import', entries });
        return result.imported;
      } catch (err) {
        throw new Error(`保存阅读书目失败：${err instanceof Error ? err.message : String(err)}`);
      }
    },

    async listBooksForAgent(agentId) {
      const aid = requireSafeXingyeAgentId(agentId);
      const rows = await store.listJsonl<unknown>(aid, READING_BOOK_CATALOG_PATH);
      return rows
        .map(normalizeCatalogEntry)
        .filter((entry): entry is XingyeBookCatalogEntry => (
          entry !== null && entry.agentTags.some((tag) => tag.agentId === aid)
        ));
    },

    async deleteBookForAgent(agentId, bookId) {
      const aid = requireSafeXingyeAgentId(agentId);
      const targetId = cleanText(bookId, 120);
      if (!targetId) throw new Error('bookId is required');
      if (!storage.mutateReadingBookCatalog) throw new Error('Reading catalog atomic writes are unavailable; upgrade the storage backend');
      const result = await storage.mutateReadingBookCatalog(aid, { type: 'delete', bookId: targetId });
      return result.deleted;
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

export async function deleteBookForAgent(agentId: string, bookId: string): Promise<boolean> {
  return createXingyeBookCatalogStore().deleteBookForAgent(agentId, bookId);
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
