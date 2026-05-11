import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  XINGYE_MOMENTS_STORAGE_KEY,
  addXingyeMomentComment,
  createXingyeMomentPost,
  deleteXingyeMomentPost,
  listXingyeMomentPosts,
  toggleXingyeMomentLike,
} from './xingye-moments-store';

class MemoryStorage implements Storage {
  private values = new Map<string, string>();

  get length() {
    return this.values.size;
  }

  clear() {
    this.values.clear();
  }

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  key(index: number) {
    return Array.from(this.values.keys())[index] ?? null;
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

describe('xingye-moments-store', () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
  });

  it('creates text-only posts, stores imageUrls, and lists newest first', () => {
    vi.setSystemTime(new Date('2026-05-11T02:00:00.000Z'));
    const first = createXingyeMomentPost('agent-1', '第一条动态', storage);

    vi.setSystemTime(new Date('2026-05-11T03:00:00.000Z'));
    const second = createXingyeMomentPost('agent-2', '第二条动态', storage);

    expect(first).toMatchObject({
      authorAgentId: 'agent-1',
      content: '第一条动态',
      imageUrls: [],
      likes: [],
      comments: [],
      createdAt: '2026-05-11T02:00:00.000Z',
    });
    expect(second.createdAt).toBe('2026-05-11T03:00:00.000Z');
    expect(listXingyeMomentPosts(storage).map(post => post.id)).toEqual([second.id, first.id]);
    expect(storage.getItem(XINGYE_MOMENTS_STORAGE_KEY)).toContain('第一条动态');

    vi.useRealTimers();
  });

  it('toggles likes, adds comments, and deletes posts', () => {
    const post = createXingyeMomentPost('agent-1', '可以互动的动态', storage);

    expect(toggleXingyeMomentLike(post.id, 'agent-2', storage)?.likes).toEqual(['agent-2']);
    expect(toggleXingyeMomentLike(post.id, 'agent-2', storage)?.likes).toEqual([]);

    const commented = addXingyeMomentComment(post.id, 'agent-2', '写一条评论', storage);
    expect(commented?.comments).toMatchObject([
      {
        authorId: 'agent-2',
        content: '写一条评论',
      },
    ]);

    expect(deleteXingyeMomentPost(post.id, storage)).toBe(true);
    expect(listXingyeMomentPosts(storage)).toEqual([]);
  });

  it('ignores empty content and normalizes malformed stored posts', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(createXingyeMomentPost('agent-1', '   ', storage)).toBeNull();

    storage.setItem(XINGYE_MOMENTS_STORAGE_KEY, JSON.stringify({
      bad: { id: 'bad', content: 'missing author' },
      good: {
        id: 'good',
        authorAgentId: 'agent-1',
        content: '保留下来的动态',
        imageUrls: ['https://example.com/a.png', 123],
        likes: ['agent-2', '', 'agent-2'],
        comments: [
          {
            id: 'comment-1',
            authorId: 'agent-3',
            content: '评论',
            createdAt: '2026-05-11T00:00:00.000Z',
          },
          { id: 'bad-comment', authorId: '', content: 'bad' },
        ],
        createdAt: '2026-05-11T00:00:00.000Z',
      },
    }));

    expect(listXingyeMomentPosts(storage)).toMatchObject([
      {
        id: 'good',
        authorAgentId: 'agent-1',
        content: '保留下来的动态',
        imageUrls: ['https://example.com/a.png'],
        likes: ['agent-2'],
        comments: [
          {
            id: 'comment-1',
            authorId: 'agent-3',
            content: '评论',
          },
        ],
      },
    ]);
  });
});
