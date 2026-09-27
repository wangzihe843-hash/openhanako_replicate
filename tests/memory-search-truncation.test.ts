import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FactStore } from '../lib/memory/fact-store.ts';
import { createMemorySearchTool } from '../lib/memory/memory-search.ts';

describe('M6 bounded, scoped SQLite retrieval', () => {
  let store: FactStore;
  beforeEach(() => { store = new FactStore(':memory:'); });
  afterEach(() => { store.close(); });
  function add(fact: string, sessionId: string | null, day: number, tags = ['sample']) {
    return store.add({ fact, tags, session_id: sessionId, time: `2026-09-${String(day).padStart(2, '0')}T12:00` });
  }
  async function search(params: { query: string; tags?: string[]; cross_channel?: boolean }) {
    const start = performance.now();
    const result = await createMemorySearchTool(store, { conversationScope: { kind: 'channel', channelId: 'alpha' } }).execute('sample', params);
    const elapsed = performance.now() - start;
    console.info(`[S4 sample] total=${store.size}, returned=${result.details.resultCount ?? 0}, elapsedMs=${elapsed.toFixed(2)}`);
    expect(Number.isFinite(elapsed)).toBe(true);
    return result;
  }

  it('filters hidden tag candidates before applying the limit', async () => {
    add('visible-old', 'channel-alpha', 1);
    for (let day = 2; day <= 16; day++) add(`hidden-${day}`, 'channel-beta', day);
    expect(store.searchByTags(['sample'], undefined, 15)).toHaveLength(15);
    expect(store.searchByTags(['sample'], undefined, 16).some((row) => row.fact === 'visible-old')).toBe(true);
    const result = await search({ query: '', tags: ['sample'] });
    expect(result.details.resultCount ?? 0).toBe(1);
    expect(result.content[0].text).not.toContain('hidden-');
    expect(result.content[0].text).toContain('visible-old');
  });

  it('fills available slots with general and current-channel tag rows', async () => {
    add('visible-below-cutoff', 'channel-alpha', 1);
    for (let day = 2; day <= 16; day++) {
      add(day === 10 ? 'general-visible' : day === 14 ? 'channel-visible' : `hidden-${day}`,
        day === 10 ? null : day === 14 ? 'channel-alpha' : 'channel-beta', day);
    }
    const result = await search({ query: '', tags: ['sample'] });
    expect(result.details.resultCount).toBe(3);
    expect(result.content[0].text).toContain('general-visible');
    expect(result.content[0].text).toContain('channel-visible');
    expect(result.content[0].text).toContain('visible-below-cutoff');
    expect(result.content[0].text).not.toContain('hidden-');
    const crossChannel = await search({ query: '', tags: ['sample'], cross_channel: true });
    expect(crossChannel.details.resultCount).toBe(12);
    expect(crossChannel.content[0].text).toContain('hidden-');
  });

  it('filters hidden FTS candidates before applying the limit', async () => {
    for (let day = 1; day <= 10; day++) add(`lighthouse hidden${day}`, 'channel-beta', day, []);
    add(`lighthouse visible ${'background '.repeat(100)}`, 'channel-alpha', 11, []);
    const top = store.searchFullText('lighthouse', 10);
    expect(top).toHaveLength(10);
    expect(top.every((row) => row.session_id === 'channel-beta')).toBe(true);
    expect(store.searchFullText('lighthouse', 11).some((row) => row.session_id === 'channel-alpha')).toBe(true);
    const result = await search({ query: 'lighthouse' });
    expect(result.details.resultCount ?? 0).toBe(1);
    expect(result.content[0].text).not.toContain('hidden');
    expect(result.content[0].text).toContain('visible');
  });

  it('reserves exact-query FTS results despite broad tag matches', async () => {
    for (let day = 1; day <= 3; day++) add(`unrelated broad topic ${day}`, 'channel-alpha', day);
    add('lighthouse exact answer', null, 4, ['precise']);
    expect(store.searchFullText('lighthouse', 10).map((row) => row.fact)).toEqual(['lighthouse exact answer']);
    const fts = vi.spyOn(store, 'searchFullText');
    const result = await search({ query: 'lighthouse', tags: ['sample'] });
    expect(result.details.resultCount).toBe(4);
    expect(result.content[0].text).toContain('exact answer');
    expect(fts).toHaveBeenCalled();
    fts.mockRestore();
  });

  it('applies the date range to FTS and CJK LIKE before truncation', async () => {
    for (let day = 1; day <= 15; day++) add(`灯塔 old${day}`, 'channel-beta', day, []);
    add('灯塔 current', 'channel-alpha', 16, []);
    const result = await createMemorySearchTool(store, { conversationScope: { kind: 'channel', channelId: 'alpha' } })
      .execute('sample', { query: '灯塔', date_from: '2026-09-16' });
    expect(result.details.resultCount).toBe(1);
    expect(result.content[0].text).toContain('灯塔 current');
    expect(result.content[0].text).not.toContain('old');
  });

  it('keeps output bounded when matched facts are large', async () => {
    for (let day = 1; day <= 16; day++) add(`large-${day} ${'x'.repeat(2000)}`, 'channel-alpha', day);
    const result = await search({ query: '', tags: ['sample'] });
    expect(result.content[0].text.length).toBeLessThanOrEqual(12000);
    expect(result.details.resultCount).toBeGreaterThan(0);
  });

  it('keeps an exact FTS hit visible even after long broad tag matches', async () => {
    for (let day = 1; day <= 12; day++) add(`broad-${day} ${'x'.repeat(4000)}`, 'channel-alpha', day);
    add(`${'y'.repeat(3000)} lighthouse exact answer ${'z'.repeat(3000)}`, 'channel-alpha', 13, ['precise']);
    const result = await search({ query: 'lighthouse', tags: ['sample'] });
    expect(result.content[0].text).toContain('lighthouse exact answer');
    expect(result.content[0].text.length).toBeLessThanOrEqual(12000);
  });

  it('centers the excerpt on a query hit when the same long fact matches tags and FTS', async () => {
    add(`${'x'.repeat(2500)} lighthouse shared fact ${'y'.repeat(2500)}`, 'channel-alpha', 1);
    const result = await search({ query: 'lighthouse', tags: ['sample'] });
    expect(result.details.resultCount).toBe(1);
    expect(result.content[0].text).toContain('lighthouse shared fact');
  });
});
