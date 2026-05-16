import { describe, expect, it, vi } from 'vitest';

vi.mock('../hooks/use-hana-fetch', () => ({
  hanaFetchAllowingErrors: vi.fn(),
}));

import {
  fetchWikiquoteSuggestions,
  type WikiquoteSuggestion,
} from './xingye-wikiquote-adapter';

describe('fetchWikiquoteSuggestions', () => {
  it('POSTs the query to the local proxy and returns only well-shaped suggestions', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        source: 'wikiquote',
        lang: 'en',
        quotes: [
          {
            text: 'When a man is denied the right to live the life he believes in, he has no choice but to become an outlaw.',
            sourceCitation: { provider: 'wikiquote', lang: 'en', pageTitle: 'Nelson Mandela', pageUrl: 'https://en.wikiquote.org/wiki/Nelson_Mandela' },
          },
          { text: 'malformed without citation' }, // should be dropped
          { text: 'bad provider', sourceCitation: { provider: 'goodreads', lang: 'en', pageTitle: 'x', pageUrl: 'x' } }, // dropped
          { text: '', sourceCitation: { provider: 'wikiquote', lang: 'en', pageTitle: 'x', pageUrl: 'x' } }, // empty text dropped
        ],
      }),
    } as Response);

    const out = await fetchWikiquoteSuggestions({ title: 'Long Walk to Freedom', authors: ['Nelson Mandela'] }, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('/api/xingye/quotes/search');
    expect(init?.method).toBe('POST');
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({ title: 'Long Walk to Freedom', authors: ['Nelson Mandela'], lang: 'en' });
    expect(out).toHaveLength(1);
    const [first] = out;
    expect(first.sourceCitation.provider).toBe('wikiquote');
    expect(first.sourceCitation.pageUrl).toContain('en.wikiquote.org');
  });

  it('throws a server-restart hint when the proxy route returns 404', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      json: async () => { throw new Error('no body'); },
    } as unknown as Response);
    await expect(fetchWikiquoteSuggestions({ title: 'X' }, fetchImpl))
      .rejects.toThrow(/Wikiquote 代理路由未就绪.*重启 Hana 服务/);
  });

  it('surfaces the server-side error envelope when the proxy reports failure', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => ({ ok: false, error: 'Wikiquote 请求失败：upstream timeout' }),
    } as Response);
    await expect(fetchWikiquoteSuggestions({ title: 'X' }, fetchImpl))
      .rejects.toThrow(/Wikiquote 请求失败：upstream timeout/);
  });

  it('rejects when no query field is provided and does not POST', async () => {
    const fetchImpl = vi.fn();
    await expect(fetchWikiquoteSuggestions({ title: '' } as { title: string; authors?: string[]; lang?: 'en' | 'zh' }, fetchImpl))
      .rejects.toThrow(/至少提供 title 或 authors/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('defaults lang to "en" and respects an explicit "zh"', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, quotes: [] }) } as Response);
    await fetchWikiquoteSuggestions({ title: '生命的意义', lang: 'zh' }, fetchImpl);
    const body = JSON.parse(String(fetchImpl.mock.calls[0][1].body));
    expect(body.lang).toBe('zh');

    fetchImpl.mockClear();
    await fetchWikiquoteSuggestions({ title: 'Anything' }, fetchImpl);
    const body2 = JSON.parse(String(fetchImpl.mock.calls[0][1].body));
    expect(body2.lang).toBe('en');
  });

  it('never returns more than 10 suggestions', async () => {
    const many: WikiquoteSuggestion[] = Array.from({ length: 25 }, (_, i) => ({
      text: `Quote ${i} should be long enough to be valid for normalization rules`,
      sourceCitation: { provider: 'wikiquote', lang: 'en', pageTitle: 'Pg', pageUrl: `https://en.wikiquote.org/wiki/${i}` },
    }));
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, quotes: many }),
    } as Response);
    const out = await fetchWikiquoteSuggestions({ title: 'X' }, fetchImpl);
    expect(out.length).toBeLessThanOrEqual(10);
  });
});
