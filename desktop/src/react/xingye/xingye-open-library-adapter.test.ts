import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildBookSearchTopics,
  searchOpenLibraryBooks,
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
