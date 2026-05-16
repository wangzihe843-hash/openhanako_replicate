import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../hooks/use-hana-fetch', () => ({
  hanaFetch: vi.fn(),
  hanaFetchAllowingErrors: vi.fn(),
}));

import {
  buildBookSearchTopics,
  searchOpenLibraryBooks,
  searchOpenLibraryBooksViaProxy,
  type BookSearchQuery,
} from './xingye-open-library-adapter';

describe('xingye-open-library-adapter', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('searches Open Library by query and normalizes metadata only', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        docs: [{
          key: '/works/OL1W',
          title: 'The Dispossessed',
          author_name: ['Ursula K. Le Guin'],
          first_publish_year: 1974,
          subject: ['science fiction', 'anarchism'],
          language: ['eng'],
          cover_i: 123,
          first_sentence: ['This must not become a quote source.'],
        }],
      }),
    } as Response);

    const results = await searchOpenLibraryBooks({ q: 'anarchism science fiction', limit: 10 }, fetchMock);

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('https://openlibrary.org/search.json?'),
      expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/json' }) }),
    );
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.searchParams.get('q')).toBe('anarchism science fiction');
    expect(url.searchParams.get('limit')).toBe('10');
    expect(results).toEqual([{
      key: '/works/OL1W',
      title: 'The Dispossessed',
      authors: ['Ursula K. Le Guin'],
      firstPublishYear: 1974,
      subjects: ['science fiction', 'anarchism'],
      languages: ['eng'],
      coverId: 123,
      openLibraryUrl: 'https://openlibrary.org/works/OL1W',
    }]);
  });

  it('searches Open Library subjects and caps requested limit at 20', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        works: [{
          key: '/works/OL2W',
          title: 'Kindred',
          authors: [{ name: 'Octavia E. Butler' }],
          first_publish_year: 1979,
          subject: ['time travel'],
          cover_id: 456,
        }],
      }),
    } as Response);

    const results = await searchOpenLibraryBooks({ subject: 'time travel', limit: 99 }, fetchMock);

    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.href).toContain('/subjects/time_travel.json');
    expect(url.searchParams.get('limit')).toBe('20');
    expect(results[0]).toMatchObject({
      key: '/works/OL2W',
      title: 'Kindred',
      authors: ['Octavia E. Butler'],
    });
  });

  it('throws a clear error when the network request fails', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));

    await expect(searchOpenLibraryBooks({ q: 'poetry' }, fetchMock)).rejects.toThrow(
      /Open Library 查询失败：getaddrinfo ENOTFOUND/,
    );
  });

  it('requires at least one manual query field', async () => {
    await expect(searchOpenLibraryBooks({} as BookSearchQuery, vi.fn())).rejects.toThrow(/至少提供/);
  });

  it('throws with the HTTP status when Open Library responds non-OK', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({}),
    } as Response);

    await expect(searchOpenLibraryBooks({ q: 'history' }, fetchMock)).rejects.toThrow(
      /Open Library 查询失败：HTTP 503/,
    );
  });

  it('throws when the Open Library response body is not JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => {
        throw new Error('Unexpected token < in JSON at position 0');
      },
    } as unknown as Response);

    await expect(searchOpenLibraryBooks({ q: 'history' }, fetchMock)).rejects.toThrow(
      /Open Library 查询失败：响应不是 JSON/,
    );
  });

  it('drops any quote-source fields (first_sentence, excerpts, description) from search documents', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        docs: [{
          key: '/works/OL9W',
          title: 'Quote Trap',
          author_name: ['Test Author'],
          subject: ['fiction'],
          first_sentence: ['Never use this as a real quote.'],
          excerpts: [{ text: 'Also forbidden.' }],
          description: 'Adapter must not surface a description from search results.',
        }],
      }),
    } as Response);

    const [result] = await searchOpenLibraryBooks({ q: 'quote trap' }, fetchMock);
    expect(result).toBeDefined();
    expect(result).not.toHaveProperty('first_sentence');
    expect(result).not.toHaveProperty('firstSentence');
    expect(result).not.toHaveProperty('excerpts');
    expect(result).not.toHaveProperty('description');
    expect(result).not.toHaveProperty('quote');
  });

  it('drops any quote-source fields from subject-mode works as well', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        works: [{
          key: '/works/OL10W',
          title: 'Subject Trap',
          authors: [{ name: 'Subject Author' }],
          first_sentence: 'Even subject mode must drop this.',
          excerpts: [{ text: 'And this.' }],
          description: 'Not allowed either.',
        }],
      }),
    } as Response);

    const [result] = await searchOpenLibraryBooks({ subject: 'subject trap' }, fetchMock);
    expect(result).toBeDefined();
    expect(result).not.toHaveProperty('first_sentence');
    expect(result).not.toHaveProperty('firstSentence');
    expect(result).not.toHaveProperty('excerpts');
    expect(result).not.toHaveProperty('description');
    expect(result).not.toHaveProperty('quote');
  });

  it('can build search topics from profile and lore without network access', () => {
    expect(buildBookSearchTopics({
      profile: {
        displayName: '林雾',
        shortBio: '战地医生，喜欢冬天、医疗伦理、废墟城市。',
        personalitySummary: '克制，关注创伤恢复。',
      },
      loreText: '常在雪线附近行动，也会读旧城历史。',
      topics: ['field medicine'],
    })).toEqual(['field medicine', '战地医生', '喜欢冬天', '医疗伦理', '废墟城市', '创伤恢复', '雪线附近行动']);
  });
});

describe('searchOpenLibraryBooksViaProxy', () => {
  it('POSTs the query to the local proxy and normalizes the returned OL JSON', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        source: 'openlibrary',
        url: 'https://openlibrary.org/subjects/war_memoir.json',
        data: {
          works: [{
            key: '/works/OL99W',
            title: 'A Soldier\'s Diary',
            authors: [{ name: 'Some Author' }],
            cover_id: 7,
            first_sentence: 'must be dropped',
          }],
        },
      }),
    } as Response);

    const results = await searchOpenLibraryBooksViaProxy({ subject: 'war memoir', limit: 5 }, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('/api/xingye/open-library/search');
    expect(init?.method).toBe('POST');
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({
      q: undefined,
      subject: 'war memoir',
      title: undefined,
      author: undefined,
      limit: 5,
    });
    expect(results).toEqual([{
      key: '/works/OL99W',
      title: 'A Soldier\'s Diary',
      authors: ['Some Author'],
      firstPublishYear: undefined,
      subjects: [],
      coverId: 7,
      openLibraryUrl: 'https://openlibrary.org/works/OL99W',
    }]);
    expect(results[0]).not.toHaveProperty('first_sentence');
  });

  it('throws the proxy error envelope message when the local route reports failure', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => ({ ok: false, error: 'Open Library 请求失败：请求超时' }),
    } as Response);

    await expect(searchOpenLibraryBooksViaProxy({ subject: 'history' }, fetchImpl))
      .rejects.toThrow(/Open Library 请求失败：请求超时/);
  });

  it('surfaces a server-restart hint when the proxy route returns 404 (stale server build)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      json: async () => { throw new Error('no body'); },
    } as unknown as Response);

    await expect(searchOpenLibraryBooksViaProxy({ subject: 'history' }, fetchImpl))
      .rejects.toThrow(/Open Library 代理路由未就绪.*重启.*Hana 服务/);
  });

  it('throws with the network error message when the proxy itself is unreachable', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(searchOpenLibraryBooksViaProxy({ subject: 'history' }, fetchImpl))
      .rejects.toThrow(/Open Library 查询失败：ECONNREFUSED/);
  });

  it('requires at least one manual query field', async () => {
    const fetchImpl = vi.fn();
    await expect(searchOpenLibraryBooksViaProxy({} as BookSearchQuery, fetchImpl))
      .rejects.toThrow(/至少提供/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
