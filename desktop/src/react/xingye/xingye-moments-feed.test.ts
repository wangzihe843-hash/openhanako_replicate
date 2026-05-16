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

  it('hides virtual_contact likes/comments from viewers that are not the post author', async () => {
    await store.createPost({
      authorAgentId: 'linwu',
      authorName: '林雾',
      content: 'linwu private contacts',
      seedLikes: [
        { actorType: 'virtual_contact', actorId: 'linwu:vc-1', actorName: '北门旧巷' },
        { actorType: 'agent', actorId: 'hanako', actorName: 'Hanako' },
      ],
      seedComments: [
        {
          actorType: 'virtual_contact',
          actorId: 'linwu:vc-1',
          actorName: '北门旧巷',
          body: '保重',
        },
        { actorType: 'agent', actorId: 'hanako', actorName: 'Hanako', body: '听见了' },
      ],
    });

    // viewer = author（林雾本人）→ 看得到 virtual_contact 互动
    const asAuthor = await listAggregatedXingyeMoments(['linwu', 'hanako'], {
      listForAgent: store.listPosts,
      viewerAgentId: 'linwu',
    });
    expect(asAuthor[0].likes.map((l) => l.actorType).sort()).toEqual(['agent', 'virtual_contact']);
    expect(asAuthor[0].comments.map((c) => c.actorType).sort()).toEqual([
      'agent',
      'virtual_contact',
    ]);

    // viewer = 其他 agent（Hanako）→ 看不到 virtual_contact 互动，但仍看到 agent 互动
    const asOther = await listAggregatedXingyeMoments(['linwu', 'hanako'], {
      listForAgent: store.listPosts,
      viewerAgentId: 'hanako',
    });
    expect(asOther[0].likes.map((l) => l.actorType)).toEqual(['agent']);
    expect(asOther[0].comments.map((c) => c.actorType)).toEqual(['agent']);
    expect(asOther[0].likes[0]).toMatchObject({ actorId: 'hanako' });

    // viewer 未指定 → 等同于无视角，virtual_contact 一律不可见
    const asNoViewer = await listAggregatedXingyeMoments(['linwu', 'hanako'], {
      listForAgent: store.listPosts,
    });
    expect(asNoViewer[0].likes.every((l) => l.actorType !== 'virtual_contact')).toBe(true);
    expect(asNoViewer[0].comments.every((c) => c.actorType !== 'virtual_contact')).toBe(true);
  });

  it('keeps user likes/comments visible regardless of viewer', async () => {
    const post = await store.createPost({
      authorAgentId: 'linwu',
      authorName: '林雾',
      content: 'with user interaction',
      seedLikes: [
        { actorType: 'virtual_contact', actorId: 'linwu:vc-1', actorName: '北门旧巷' },
      ],
    });
    if (!post) throw new Error('expected post');
    await store.toggleLike('linwu', post.id, {
      actorType: 'user',
      actorId: 'user',
      actorName: '莉莉丝',
    });
    await store.addComment(
      'linwu',
      post.id,
      { actorType: 'user', actorId: 'user', actorName: '莉莉丝' },
      'oi',
    );

    for (const viewerAgentId of ['linwu', 'hanako', null] as const) {
      const feed = await listAggregatedXingyeMoments(['linwu'], {
        listForAgent: store.listPosts,
        viewerAgentId,
      });
      // user actor 始终保留
      expect(feed[0].likes.some((l) => l.actorType === 'user' && l.actorId === 'user')).toBe(true);
      expect(feed[0].comments.some((c) => c.actorType === 'user' && c.actorId === 'user')).toBe(
        true,
      );
    }
  });
});
