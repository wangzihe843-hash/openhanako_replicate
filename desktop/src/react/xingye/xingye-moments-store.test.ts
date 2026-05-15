import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryXingyeStorageBackend } from './xingye-storage-backend';
import {
  XINGYE_MOMENTS_POSTS_JSONL,
  createXingyeMomentStore,
  resolveMomentsPostsScopedPath,
  type XingyeMomentPost,
} from './xingye-moments-store';

function requireMomentPost(post: XingyeMomentPost | null | undefined): XingyeMomentPost {
  if (!post) throw new Error('expected moment post');
  return post;
}

describe('xingye-moments-store', () => {
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
          '2026-05-11T02:00:00.000Z',
          '2026-05-11T03:00:00.000Z',
          '2026-05-11T04:00:00.000Z',
        ];
        return () => times.shift() ?? '2026-05-11T05:00:00.000Z';
      })(),
    });
  });

  it('creates posts under apps/moments/posts.jsonl and lists newest first', async () => {
    const first = requireMomentPost(await store.createPost('linwu', 'first post'));
    const second = requireMomentPost(await store.createPost('linwu', 'second post'));

    expect(resolveMomentsPostsScopedPath('linwu')).toEqual({
      agentId: 'linwu',
      relativePath: XINGYE_MOMENTS_POSTS_JSONL,
      scopedPath: 'HANA_HOME/agents/linwu/xingye/apps/moments/posts.jsonl',
    });
    expect(first).toMatchObject({
      id: 'moment-1',
      authorAgentId: 'linwu',
      content: 'first post',
      imageUrls: [],
      likes: [],
      comments: [],
      createdAt: '2026-05-11T02:00:00.000Z',
    });
    await expect(backend.listJsonl<XingyeMomentPost>('linwu', XINGYE_MOMENTS_POSTS_JSONL)).resolves.toEqual([
      first,
      second,
    ]);
    await expect(store.listPosts('linwu')).resolves.toEqual([second, first]);
  });

  it('keeps agent moment paths isolated', async () => {
    await store.createPost('linwu', 'linwu private post');

    await expect(store.listPosts('linwu')).resolves.toHaveLength(1);
    await expect(store.listPosts('hanako')).resolves.toEqual([]);
  });

  it('toggles likes and adds comments durably', async () => {
    const post = requireMomentPost(await store.createPost('linwu', 'interactive post'));

    await expect(store.toggleLike('linwu', post.id, 'hanako')).resolves.toMatchObject({
      likes: ['hanako'],
    });
    await expect(store.toggleLike('linwu', post.id, 'hanako')).resolves.toMatchObject({
      likes: [],
    });

    await expect(store.addComment('linwu', post.id, 'hanako', 'hello')).resolves.toMatchObject({
      comments: [
        {
          id: 'comment-1',
          authorId: 'hanako',
          content: 'hello',
          createdAt: '2026-05-11T03:00:00.000Z',
        },
      ],
    });
    await expect(store.listPosts('linwu')).resolves.toEqual([
      expect.objectContaining({
        id: post.id,
        comments: [expect.objectContaining({ content: 'hello' })],
      }),
    ]);
  });

  it('deletes only the selected post', async () => {
    const first = requireMomentPost(await store.createPost('linwu', 'keep?'));
    const second = requireMomentPost(await store.createPost('linwu', 'keep'));

    await expect(store.deletePost('linwu', first.id)).resolves.toBe(true);
    await expect(store.listPosts('linwu')).resolves.toEqual([
      expect.objectContaining({ id: second.id, content: 'keep' }),
    ]);
  });

  it('ignores empty content and normalizes malformed JSONL rows', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(store.createPost('linwu', '   ')).resolves.toBeNull();
    await backend.appendJsonl('linwu', XINGYE_MOMENTS_POSTS_JSONL, { id: 'bad', content: 'missing author' });
    await backend.appendJsonl('linwu', XINGYE_MOMENTS_POSTS_JSONL, {
      id: 'good',
      authorAgentId: 'linwu',
      content: 'kept post',
      imageUrls: ['https://example.com/a.png', 123, 'https://example.com/a.png'],
      likes: ['hanako', '', 'hanako'],
      comments: [
        {
          id: 'comment-1',
          authorId: 'hanako',
          content: 'nice',
          createdAt: '2026-05-11T00:00:00.000Z',
        },
        { id: 'bad-comment', authorId: '', content: 'bad' },
      ],
      createdAt: '2026-05-11T00:00:00.000Z',
    });

    await expect(store.listPosts('linwu')).resolves.toMatchObject([
      {
        id: 'good',
        authorAgentId: 'linwu',
        content: 'kept post',
        imageUrls: ['https://example.com/a.png'],
        likes: ['hanako'],
        comments: [
          {
            id: 'comment-1',
            authorId: 'hanako',
            content: 'nice',
          },
        ],
      },
    ]);
  });

  it('rejects unsafe implicit or malformed agent scope', async () => {
    await expect(store.listPosts('bad agent')).rejects.toThrow(/agentId/);
    await expect(store.createPost('', 'missing agent')).rejects.toThrow(/agentId/);
    await expect(store.toggleLike('linwu/other', 'post-1', 'hanako')).rejects.toThrow(/agentId/);
  });
});
