import { describe, expect, it } from 'vitest';
import { createMemoryXingyeStorageBackend } from './xingye-storage-backend';
import {
  createXingyeBookCatalogStore,
  readingBookCatalogPath,
  safeReadingBookContextForAgent,
  type BookSearchResult,
} from './xingye-reading-book-catalog';

const book = (patch: Partial<BookSearchResult> = {}): BookSearchResult => ({
  key: '/works/OL1W',
  title: 'The Left Hand of Darkness',
  authors: ['Ursula K. Le Guin'],
  description: 'A metadata-only description.',
  subjects: ['science fiction', 'anthropology'],
  openLibraryUrl: 'https://openlibrary.org/works/OL1W',
  ...patch,
});

describe('xingye-reading-book-catalog', () => {
  it('stores imported books under the reading_notes catalog path', async () => {
    const backend = createMemoryXingyeStorageBackend();
    const store = createXingyeBookCatalogStore(backend, {
      idFactory: () => 'book-1',
      now: () => '2026-05-16T01:00:00.000Z',
    });

    const imported = await store.importBooksForAgent('test01', [book()], {
      reason: '林雾偏好冷峻科幻和异文化关系。',
      interests: ['science fiction', 'anthropology'],
    });

    expect(readingBookCatalogPath()).toBe('apps/reading_notes/book-catalog.jsonl');
    expect(imported).toEqual([
      expect.objectContaining({
        id: 'book-1',
        title: 'The Left Hand of Darkness',
        authors: ['Ursula K. Le Guin'],
        agentTags: [{
          agentId: 'test01',
          reason: '林雾偏好冷峻科幻和异文化关系。',
          interests: ['science fiction', 'anthropology'],
          createdAt: '2026-05-16T01:00:00.000Z',
        }],
      }),
    ]);
    await expect(backend.listJsonl('test01', 'apps/reading_notes/book-catalog.jsonl')).resolves.toEqual(imported);
  });

  it('imports at most 20 books and lists only the current agent tagged books', async () => {
    const backend = createMemoryXingyeStorageBackend();
    const store = createXingyeBookCatalogStore(backend, {
      idFactory: (() => {
        let n = 0;
        return () => `book-${++n}`;
      })(),
      now: () => '2026-05-16T01:00:00.000Z',
    });
    const many = Array.from({ length: 25 }, (_, i) => book({ key: `/works/OL${i}W`, title: `Book ${i}` }));

    await expect(store.importBooksForAgent('test01', many, {
      reason: 'topic import',
      interests: ['history'],
    })).resolves.toHaveLength(20);
    await store.importBooksForAgent('hanako', [book({ key: '/works/OL0W', title: 'Book 0' })], {
      reason: 'Hanako also tagged it',
      interests: ['history'],
    });

    const linwu = await store.listBooksForAgent('test01');
    const hanako = await store.listBooksForAgent('hanako');
    expect(linwu).toHaveLength(20);
    expect(linwu[0].agentTags.map((tag) => tag.agentId)).toEqual(['test01']);
    expect(hanako).toHaveLength(1);
    expect(hanako[0].agentTags.map((tag) => tag.agentId)).toEqual(['hanako']);
  });

  it('dedupes the same book and supplements agentTags without duplicating entries', async () => {
    const backend = createMemoryXingyeStorageBackend();
    const store = createXingyeBookCatalogStore(backend, {
      idFactory: (() => {
        const ids = ['book-1', 'book-2'];
        return () => ids.shift() ?? 'book-x';
      })(),
      now: (() => {
        const times = ['2026-05-16T01:00:00.000Z', '2026-05-16T02:00:00.000Z'];
        return () => times.shift() ?? '2026-05-16T03:00:00.000Z';
      })(),
    });

    await store.importBooksForAgent('test01', [book()], {
      reason: 'first reason',
      interests: ['science fiction'],
    });
    await store.importBooksForAgent('test01', [book({ title: 'The Left Hand of Darkness ' })], {
      reason: 'second reason',
      interests: ['winter'],
    });

    const listed = await store.listBooksForAgent('test01');
    expect(listed).toHaveLength(1);
    expect(listed[0].agentTags).toEqual([
      {
        agentId: 'test01',
        reason: 'first reason',
        interests: ['science fiction'],
        createdAt: '2026-05-16T01:00:00.000Z',
      },
      {
        agentId: 'test01',
        reason: 'second reason',
        interests: ['winter'],
        createdAt: '2026-05-16T02:00:00.000Z',
      },
    ]);
  });

  it('keeps local catalog unchanged when an import write fails', async () => {
    const backend = createMemoryXingyeStorageBackend();
    const store = createXingyeBookCatalogStore({
      ...backend,
      writeJsonl: async () => {
        throw new Error('disk unavailable');
      },
    });

    await expect(store.importBooksForAgent('test01', [book()], {
      reason: 'will fail',
      interests: ['x'],
    })).rejects.toThrow(/保存阅读书目失败：disk unavailable/);
    await expect(backend.listJsonl('test01', 'apps/reading_notes/book-catalog.jsonl')).resolves.toEqual([]);
  });

  it('exposes only metadata fields for later reading-note generation context', async () => {
    const store = createXingyeBookCatalogStore(createMemoryXingyeStorageBackend(), {
      idFactory: () => 'book-1',
      now: () => '2026-05-16T01:00:00.000Z',
    });
    await store.importBooksForAgent('test01', [book({
      firstSentence: 'Do not use as a real quote.',
      excerpt: 'Do not use either.',
    } as BookSearchResult)], {
      reason: 'metadata only',
      interests: ['questions'],
    });

    await expect(safeReadingBookContextForAgent('test01', store)).resolves.toEqual([
      {
        title: 'The Left Hand of Darkness',
        authors: ['Ursula K. Le Guin'],
        description: 'A metadata-only description.',
        subjects: ['science fiction', 'anthropology'],
      },
    ]);
  });

  it('deletes only the selected local book from the current agent catalog', async () => {
    const store = createXingyeBookCatalogStore(createMemoryXingyeStorageBackend(), {
      idFactory: (() => {
        const ids = ['book-1', 'book-2'];
        return () => ids.shift() ?? 'book-x';
      })(),
      now: () => '2026-05-16T01:00:00.000Z',
    });
    await store.importBooksForAgent('test01', [
      book({ key: 'manual:one', title: 'Manual One' }),
      book({ key: 'manual:two', title: 'Manual Two' }),
    ], {
      reason: 'manual',
      interests: ['local'],
    });

    await expect(store.deleteBookForAgent('test01', 'book-1')).resolves.toBe(true);
    await expect(store.listBooksForAgent('test01')).resolves.toEqual([
      expect.objectContaining({ id: 'book-2', title: 'Manual Two' }),
    ]);
  });
});
