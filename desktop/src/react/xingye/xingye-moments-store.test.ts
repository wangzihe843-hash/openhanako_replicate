import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryXingyeStorageBackend } from './xingye-storage-backend';
import {
  XINGYE_MOMENTS_POSTS_JSONL,
  createXingyeMomentStore,
  resolveMomentsPostsScopedPath,
  type XingyeMomentActor,
  type XingyeMomentPost,
} from './xingye-moments-store';

function requireMomentPost(post: XingyeMomentPost | null | undefined): XingyeMomentPost {
  if (!post) throw new Error('expected moment post');
  return post;
}

const userActor: XingyeMomentActor = {
  actorType: 'user',
  actorId: 'user',
  actorName: '莉莉丝',
};

const hanakoActor: XingyeMomentActor = {
  actorType: 'agent',
  actorId: 'hanako',
  actorName: 'Hanako',
};

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
          '2026-05-11T05:00:00.000Z',
          '2026-05-11T06:00:00.000Z',
        ];
        return () => times.shift() ?? '2026-05-11T07:00:00.000Z';
      })(),
    });
  });

  it('creates posts under apps/moments/posts.jsonl and lists newest first', async () => {
    const first = requireMomentPost(
      await store.createPost({ authorAgentId: 'linwu', authorName: '林雾', content: 'first post' }),
    );
    const second = requireMomentPost(
      await store.createPost({ authorAgentId: 'linwu', authorName: '林雾', content: 'second post' }),
    );

    expect(resolveMomentsPostsScopedPath('linwu')).toEqual({
      agentId: 'linwu',
      relativePath: XINGYE_MOMENTS_POSTS_JSONL,
      scopedPath: 'HANA_HOME/agents/linwu/xingye/apps/moments/posts.jsonl',
    });
    expect(first).toMatchObject({
      id: 'moment-1',
      authorAgentId: 'linwu',
      authorName: '林雾',
      content: 'first post',
      imageUrls: [],
      likes: [],
      comments: [],
      createdAt: '2026-05-11T02:00:00.000Z',
      updatedAt: '2026-05-11T02:00:00.000Z',
    });
    await expect(backend.listJsonl<XingyeMomentPost>('linwu', XINGYE_MOMENTS_POSTS_JSONL)).resolves.toEqual([
      first,
      second,
    ]);
    await expect(store.listPosts('linwu')).resolves.toEqual([second, first]);
  });

  it('keeps agent moment paths isolated', async () => {
    await store.createPost({
      authorAgentId: 'linwu',
      authorName: '林雾',
      content: 'linwu private post',
    });

    await expect(store.listPosts('linwu')).resolves.toHaveLength(1);
    await expect(store.listPosts('hanako')).resolves.toEqual([]);
  });

  it('records user likes/comments with actor identity and bumps updatedAt', async () => {
    const post = requireMomentPost(
      await store.createPost({ authorAgentId: 'linwu', authorName: '林雾', content: 'interactive post' }),
    );

    const liked = requireMomentPost(await store.toggleLike('linwu', post.id, userActor));
    expect(liked.likes).toEqual([
      {
        id: 'like-1',
        actorType: 'user',
        actorId: 'user',
        actorName: '莉莉丝',
        createdAt: '2026-05-11T03:00:00.000Z',
      },
    ]);
    expect(liked.updatedAt).toBe('2026-05-11T03:00:00.000Z');

    const unliked = requireMomentPost(await store.toggleLike('linwu', post.id, userActor));
    expect(unliked.likes).toEqual([]);
    expect(unliked.updatedAt).toBe('2026-05-11T04:00:00.000Z');

    const commented = requireMomentPost(
      await store.addComment('linwu', post.id, userActor, 'hello'),
    );
    expect(commented.comments).toEqual([
      {
        id: 'comment-1',
        actorType: 'user',
        actorId: 'user',
        actorName: '莉莉丝',
        body: 'hello',
        createdAt: '2026-05-11T05:00:00.000Z',
      },
    ]);

    await expect(store.listPosts('linwu')).resolves.toEqual([
      expect.objectContaining({
        id: post.id,
        authorAgentId: 'linwu',
        authorName: '林雾',
        comments: [expect.objectContaining({ body: 'hello', actorType: 'user', actorName: '莉莉丝' })],
      }),
    ]);
  });

  it('does not let user actor overwrite authorAgentId or duplicate likes', async () => {
    const post = requireMomentPost(
      await store.createPost({ authorAgentId: 'linwu', authorName: '林雾', content: 'mine' }),
    );

    await store.toggleLike('linwu', post.id, userActor);
    // Same actor pressing like twice toggles off, not duplicate.
    const afterToggleOff = requireMomentPost(await store.toggleLike('linwu', post.id, userActor));
    expect(afterToggleOff.likes).toEqual([]);

    // A user actor and an agent actor with the same id-string should coexist.
    const userLiked = requireMomentPost(await store.toggleLike('linwu', post.id, userActor));
    const bothLiked = requireMomentPost(await store.toggleLike('linwu', post.id, hanakoActor));
    expect(bothLiked.likes).toHaveLength(2);
    expect(bothLiked.likes.map((l) => `${l.actorType}:${l.actorId}`)).toEqual([
      'user:user',
      'agent:hanako',
    ]);

    expect(userLiked.authorAgentId).toBe('linwu');
    expect(bothLiked.authorAgentId).toBe('linwu');
  });

  it('deletes only the selected post', async () => {
    const first = requireMomentPost(
      await store.createPost({ authorAgentId: 'linwu', authorName: '林雾', content: 'keep?' }),
    );
    const second = requireMomentPost(
      await store.createPost({ authorAgentId: 'linwu', authorName: '林雾', content: 'keep' }),
    );

    await expect(store.deletePost('linwu', first.id)).resolves.toBe(true);
    await expect(store.listPosts('linwu')).resolves.toEqual([
      expect.objectContaining({ id: second.id, content: 'keep' }),
    ]);
  });

  it('ignores empty content and normalizes malformed JSONL rows', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(
      store.createPost({ authorAgentId: 'linwu', authorName: '林雾', content: '   ' }),
    ).resolves.toBeNull();
    await backend.appendJsonl('linwu', XINGYE_MOMENTS_POSTS_JSONL, { id: 'bad', content: 'missing author' });
    await backend.appendJsonl('linwu', XINGYE_MOMENTS_POSTS_JSONL, {
      id: 'good',
      authorAgentId: 'linwu',
      authorName: '林雾',
      content: 'kept post',
      imageUrls: ['https://example.com/a.png', 123, 'https://example.com/a.png'],
      likes: [
        'hanako',
        '',
        'hanako',
        { actorType: 'user', actorId: 'user', actorName: '莉莉丝', createdAt: '2026-05-11T00:30:00.000Z' },
      ],
      comments: [
        {
          id: 'comment-legacy',
          authorId: 'hanako',
          content: 'nice',
          createdAt: '2026-05-11T00:00:00.000Z',
        },
        {
          id: 'comment-user',
          actorType: 'user',
          actorId: 'user',
          actorName: '莉莉丝',
          body: '一起呀',
          createdAt: '2026-05-11T00:10:00.000Z',
        },
        { id: 'bad-comment', authorId: '', content: 'bad' },
      ],
      createdAt: '2026-05-11T00:00:00.000Z',
    });

    const posts = await store.listPosts('linwu');
    expect(posts).toHaveLength(1);
    const [post] = posts;
    expect(post).toMatchObject({
      id: 'good',
      authorAgentId: 'linwu',
      authorName: '林雾',
      content: 'kept post',
      imageUrls: ['https://example.com/a.png'],
    });

    // Legacy string like "hanako" is migrated to an agent-typed like; explicit
    // user like is preserved; duplicates and empties are dropped.
    expect(post.likes.map((l) => `${l.actorType}:${l.actorId}`)).toEqual([
      'agent:hanako',
      'user:user',
    ]);
    expect(post.likes[1].actorName).toBe('莉莉丝');

    // Legacy comment shape (authorId/content) migrates to agent-typed comment with body;
    // a comment with body field intact remains user-typed.
    expect(post.comments).toEqual([
      expect.objectContaining({
        id: 'comment-legacy',
        actorType: 'agent',
        actorId: 'hanako',
        body: 'nice',
      }),
      expect.objectContaining({
        id: 'comment-user',
        actorType: 'user',
        actorId: 'user',
        actorName: '莉莉丝',
        body: '一起呀',
      }),
    ]);
  });

  it('rejects unsafe implicit or malformed agent scope', async () => {
    await expect(store.listPosts('bad agent')).rejects.toThrow(/agentId/);
    await expect(
      store.createPost({ authorAgentId: '', authorName: '', content: 'missing agent' }),
    ).rejects.toThrow(/agentId/);
    await expect(store.toggleLike('linwu/other', 'post-1', userActor)).rejects.toThrow(/agentId/);
  });
});
