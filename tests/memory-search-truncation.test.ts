import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FactStore } from '../lib/memory/fact-store.ts';
import { createMemorySearchTool } from '../lib/memory/memory-search.ts';

// Characterization, not a new retrieval policy: preserve the known S4 gaps until M6.
describe('S4 real SQLite retrieval truncation samples', () => {
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

  it('15 hidden tag candidates can make an existing visible fact look absent', async () => {
    add('visible-old', 'channel-alpha', 1);
    for (let day = 2; day <= 16; day++) add(`hidden-${day}`, 'channel-beta', day);
    expect(store.searchByTags(['sample'], undefined, 15)).toHaveLength(15);
    expect(store.searchByTags(['sample'], undefined, 16).some((row) => row.fact === 'visible-old')).toBe(true);
    const result = await search({ query: '', tags: ['sample'] });
    expect(result.details.resultCount ?? 0).toBe(0);
    expect(result.content[0].text).not.toContain('hidden-');
    expect(result.content[0].text).not.toContain('visible-old');
  });

  it('interleaved hidden/visible tag rows preserve general facts but underfill visible recall', async () => {
    add('visible-below-cutoff', 'channel-alpha', 1);
    for (let day = 2; day <= 16; day++) {
      add(day === 10 ? 'general-visible' : day === 14 ? 'channel-visible' : `hidden-${day}`,
        day === 10 ? null : day === 14 ? 'channel-alpha' : 'channel-beta', day);
    }
    const result = await search({ query: '', tags: ['sample'] });
    expect(result.details.resultCount).toBe(2);
    expect(result.content[0].text).toContain('general-visible');
    expect(result.content[0].text).toContain('channel-visible');
    expect(result.content[0].text).not.toContain('visible-below-cutoff');
    expect(result.content[0].text).not.toContain('hidden-');
    const crossChannel = await search({ query: '', tags: ['sample'], cross_channel: true });
    expect(crossChannel.details.resultCount).toBe(15);
    expect(crossChannel.content[0].text).toContain('hidden-');
  });

  it('10 hidden FTS candidates can exclude the lower ranked current-channel hit', async () => {
    for (let day = 1; day <= 10; day++) add(`lighthouse hidden${day}`, 'channel-beta', day, []);
    add(`lighthouse visible ${'background '.repeat(100)}`, 'channel-alpha', 11, []);
    const top = store.searchFullText('lighthouse', 10);
    expect(top).toHaveLength(10);
    expect(top.every((row) => row.session_id === 'channel-beta')).toBe(true);
    expect(store.searchFullText('lighthouse', 11).some((row) => row.session_id === 'channel-alpha')).toBe(true);
    const result = await search({ query: 'lighthouse' });
    expect(result.details.resultCount ?? 0).toBe(0);
    expect(result.content[0].text).not.toContain('hidden');
  });

  it('three visible broad tag matches suppress the exact-query FTS path', async () => {
    for (let day = 1; day <= 3; day++) add(`unrelated broad topic ${day}`, 'channel-alpha', day);
    add('lighthouse exact answer', null, 4, ['precise']);
    expect(store.searchFullText('lighthouse', 10).map((row) => row.fact)).toEqual(['lighthouse exact answer']);
    const fts = vi.spyOn(store, 'searchFullText');
    const result = await search({ query: 'lighthouse', tags: ['sample'] });
    expect(result.details.resultCount).toBe(3);
    expect(result.content[0].text).not.toContain('exact answer');
    expect(fts).not.toHaveBeenCalled();
    fts.mockRestore();
  });
});
