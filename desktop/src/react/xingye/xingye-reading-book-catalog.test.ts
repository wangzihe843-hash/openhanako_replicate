import { describe, expect, it } from 'vitest';
import { createMemoryXingyeStorageBackend } from './xingye-storage-backend';
import {
  createXingyeBookCatalogStore,
  readingBookCatalogPath,
  safeReadingBookContextForAgent,
  type BookSearchResult,
} from './xingye-reading-book-catalog';

const book = (
  patch: Partial<BookSearchResult> & Record<string, unknown> = {},
): BookSearchResult => ({
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

  it('does not duplicate agentTags when the same agent re-imports with identical reason and interests', async () => {
    const backend = createMemoryXingyeStorageBackend();
    const store = createXingyeBookCatalogStore(backend, {
      idFactory: () => 'book-1',
      now: (() => {
        const times = ['2026-05-16T01:00:00.000Z', '2026-05-16T02:00:00.000Z', '2026-05-16T03:00:00.000Z'];
        return () => times.shift() ?? '2026-05-16T04:00:00.000Z';
      })(),
    });

    await store.importBooksForAgent('test01', [book()], {
      reason: 'manual',
      interests: ['anthropology', 'science fiction'],
    });
    await store.importBooksForAgent('test01', [book()], {
      reason: 'manual',
      interests: ['science fiction', 'anthropology'],
    });
    await store.importBooksForAgent('test01', [book()], {
      reason: 'manual',
      interests: ['science fiction', 'winter'],
    });

    const listed = await store.listBooksForAgent('test01');
    expect(listed).toHaveLength(1);
    expect(listed[0].agentTags).toEqual([
      {
        agentId: 'test01',
        reason: 'manual',
        interests: ['anthropology', 'science fiction'],
        createdAt: '2026-05-16T01:00:00.000Z',
      },
      {
        agentId: 'test01',
        reason: 'manual',
        interests: ['science fiction', 'winter'],
        createdAt: '2026-05-16T03:00:00.000Z',
      },
    ]);
  });

  it('keeps each agent catalog isolated when two agents tag the same book', async () => {
    const backend = createMemoryXingyeStorageBackend();
    const store = createXingyeBookCatalogStore(backend, {
      idFactory: (() => {
        let n = 0;
        return () => `book-${++n}`;
      })(),
      now: (() => {
        const times = ['2026-05-16T01:00:00.000Z', '2026-05-16T02:00:00.000Z'];
        return () => times.shift() ?? '2026-05-16T03:00:00.000Z';
      })(),
    });

    await store.importBooksForAgent('test01', [book()], {
      reason: '林雾偏好',
      interests: ['science fiction'],
    });
    await store.importBooksForAgent('hanako', [book()], {
      reason: 'Hanako 也读',
      interests: ['anthropology'],
    });

    const linwu = await store.listBooksForAgent('test01');
    const hanako = await store.listBooksForAgent('hanako');
    expect(linwu).toHaveLength(1);
    expect(hanako).toHaveLength(1);
    expect(linwu[0].agentTags).toEqual([{
      agentId: 'test01',
      reason: '林雾偏好',
      interests: ['science fiction'],
      createdAt: '2026-05-16T01:00:00.000Z',
    }]);
    expect(hanako[0].agentTags).toEqual([{
      agentId: 'hanako',
      reason: 'Hanako 也读',
      interests: ['anthropology'],
      createdAt: '2026-05-16T02:00:00.000Z',
    }]);

    const linwuStored = await backend.listJsonl<{ agentTags: Array<{ agentId: string }> }>(
      'test01',
      'apps/reading_notes/book-catalog.jsonl',
    );
    const hanakoStored = await backend.listJsonl<{ agentTags: Array<{ agentId: string }> }>(
      'hanako',
      'apps/reading_notes/book-catalog.jsonl',
    );
    expect(linwuStored).toHaveLength(1);
    expect(hanakoStored).toHaveLength(1);
    expect(linwuStored[0].agentTags.map((tag) => tag.agentId)).toEqual(['test01']);
    expect(hanakoStored[0].agentTags.map((tag) => tag.agentId)).toEqual(['hanako']);
  });

  it('never stores a quote field even when the input shape tries to inject one', async () => {
    const store = createXingyeBookCatalogStore(createMemoryXingyeStorageBackend(), {
      idFactory: () => 'book-1',
      now: () => '2026-05-16T01:00:00.000Z',
    });

    const imported = await store.importBooksForAgent('test01', [book({
      quote: { text: '伪造的摘录', source: 'generated' },
      firstSentence: '不可作为引用。',
      excerpts: [{ text: '同样不可作为引用。' }],
    })], {
      reason: 'manual',
      interests: ['no quote'],
    });

    expect(imported[0]).not.toHaveProperty('quote');
    expect(imported[0]).not.toHaveProperty('firstSentence');
    expect(imported[0]).not.toHaveProperty('excerpts');
    const listed = await store.listBooksForAgent('test01');
    expect(listed[0]).not.toHaveProperty('quote');
    const safe = await safeReadingBookContextForAgent('test01', store);
    expect(safe[0]).not.toHaveProperty('quote');
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
    })], {
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
