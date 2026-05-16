import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryXingyeStorageBackend } from './xingye-storage-backend';
import { createXingyeMomentStore } from './xingye-moments-store';
import { listAggregatedXingyeMoments } from './xingye-moments-feed';

describe('listAggregatedXingyeMoments', () => {
  let backend: ReturnType<typeof createMemoryXingyeStorageBackend>;
  let store: ReturnType<typeof createXingyeMomentStore>;

  beforeEach(() => {
    backend = createMemoryXingyeStorageBackend();
    store = createXingyeMomentStore(backend, {
      idFactory: (() => {
        const counts = new Map<string, number>();
        return (prefix: string) => {
          const next = (counts.get(prefix) ?? 0) + 1;
          counts.set(prefix, next);
          return `${prefix}-${next}`;
        };
      })(),
      now: (() => {
        const times = [
          '2026-05-11T01:00:00.000Z',
          '2026-05-11T02:00:00.000Z',
          '2026-05-11T03:00:00.000Z',
        ];
        return () => times.shift() ?? '2026-05-11T04:00:00.000Z';
      })(),
    });
  });

  it('returns empty array when no agent ids are provided', async () => {
    await expect(listAggregatedXingyeMoments([], { listForAgent: store.listPosts })).resolves.toEqual([]);
  });

  it('merges posts from multiple agents in newest-first order, preserving authorAgentId', async () => {
    await store.createPost({ authorAgentId: 'linwu', authorName: '林雾', content: 'linwu 1' });
    await store.createPost({ authorAgentId: 'hanako', authorName: 'Hanako', content: 'hanako 1' });
    await store.createPost({ authorAgentId: 'linwu', authorName: '林雾', content: 'linwu 2' });

    const feed = await listAggregatedXingyeMoments(['linwu', 'hanako'], {
      listForAgent: store.listPosts,
    });

    expect(feed.map((p) => p.content)).toEqual(['linwu 2', 'hanako 1', 'linwu 1']);
    expect(feed.map((p) => p.authorAgentId)).toEqual(['linwu', 'hanako', 'linwu']);
  });

  it('isolates per-agent failures so other agents still appear', async () => {
    await store.createPost({ authorAgentId: 'linwu', authorName: '林雾', content: 'linwu only' });
    await store.createPost({ authorAgentId: 'hanako', authorName: 'Hanako', content: 'hanako only' });

    const failingList = vi.fn(async (agentId: string) => {
      if (agentId === 'broken') throw new Error('corrupt posts.jsonl');
      return store.listPosts(agentId);
    });
    const onAgentError = vi.fn();

    const feed = await listAggregatedXingyeMoments(['broken', 'linwu', 'hanako'], {
      listForAgent: failingList,
      onAgentError,
    });

    expect(feed.map((p) => p.authorAgentId).sort()).toEqual(['hanako', 'linwu']);
    expect(onAgentError).toHaveBeenCalledTimes(1);
    expect(onAgentError.mock.calls[0][0]).toBe('broken');
  });

  it('deduplicates and trims agent ids before aggregating', async () => {
    const listForAgent = vi.fn(async (_agentId: string) => []);
    await listAggregatedXingyeMoments(['  linwu  ', 'linwu', '', 'hanako'], { listForAgent });

    const calledWith = listForAgent.mock.calls.map((args) => args[0]);
    expect(calledWith).toEqual(['linwu', 'hanako']);
  });
});
