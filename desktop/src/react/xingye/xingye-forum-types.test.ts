import { describe, expect, it } from 'vitest';
import {
  COMMENTS_PER_POST,
  POSTS_PER_BATCH_MAX,
  REPLIES_PER_COMMENT_MAX,
  normalizeForumAccountSpec,
  normalizeForumBatchResult,
  normalizeForumBootstrapResult,
  normalizeForumDmResult,
  normalizeForumPostSpec,
} from './xingye-forum-types';

function makeComments(n: number, opts: { withAgent?: boolean } = {}) {
  const comments = Array.from({ length: n }, (_, i) => ({
    authorName: `网友${i}`,
    isAgent: false,
    body: `第 ${i} 条评论`,
    replies: [],
  }));
  if (opts.withAgent && comments.length) {
    comments[0] = { authorName: '', isAgent: true, body: '我来冒个泡', replies: [] } as never;
  }
  return comments;
}

describe('normalizeForumAccountSpec', () => {
  it('parses a valid account and defaults bio/themeLabel', () => {
    const a = normalizeForumAccountSpec({ username: '夜行的猫', themeKeywords: ['深夜', '深夜', '猫'] });
    expect(a).not.toBeNull();
    expect(a!.username).toBe('夜行的猫');
    expect(a!.bio).toBeTruthy();
    expect(a!.themeLabel).toBeTruthy();
    // 关键词去重（大小写无关）
    expect(a!.themeKeywords).toEqual(['深夜', '猫']);
  });

  it('returns null without a username', () => {
    expect(normalizeForumAccountSpec({ bio: '只有签名' })).toBeNull();
  });
});

describe('normalizeForumPostSpec', () => {
  it('keeps an authored post and caps comments at max', () => {
    const post = normalizeForumPostSpec({
      relation: 'authored',
      board: '深夜',
      title: '今天又失眠了',
      body: '凌晨三点还睡不着',
      comments: makeComments(COMMENTS_PER_POST.max + 3),
    });
    expect(post).not.toBeNull();
    expect(post!.relation).toBe('authored');
    expect(post!.comments.length).toBe(COMMENTS_PER_POST.max);
  });

  it('drops a post without title or body', () => {
    expect(normalizeForumPostSpec({ relation: 'authored', title: '', body: 'x', comments: [] })).toBeNull();
    expect(normalizeForumPostSpec({ relation: 'authored', title: 'x', body: '', comments: [] })).toBeNull();
  });

  it('drops a commented post without an NPC author', () => {
    const post = normalizeForumPostSpec({
      relation: 'commented',
      title: '别人的帖',
      body: 'NPC 写的正文',
      comments: makeComments(3, { withAgent: true }),
      // authorName 缺失
    });
    expect(post).toBeNull();
  });

  it('drops a commented post that has no agent comment', () => {
    const post = normalizeForumPostSpec({
      relation: 'commented',
      authorName: '楼主A',
      title: '别人的帖',
      body: 'NPC 写的正文',
      comments: makeComments(3, { withAgent: false }),
    });
    expect(post).toBeNull();
  });

  it('keeps a commented post with an NPC author and at least one agent comment', () => {
    const post = normalizeForumPostSpec({
      relation: 'commented',
      authorName: '楼主A',
      title: '别人的帖',
      body: 'NPC 写的正文',
      comments: makeComments(4, { withAgent: true }),
    });
    expect(post).not.toBeNull();
    expect(post!.authorName).toBe('楼主A');
    expect(post!.comments.some((c) => c.authorIsAgent)).toBe(true);
  });

  it('caps nested replies per comment', () => {
    const post = normalizeForumPostSpec({
      relation: 'authored',
      title: 't',
      body: 'b',
      comments: [
        {
          authorName: '网友',
          isAgent: false,
          body: 'c',
          replies: Array.from({ length: REPLIES_PER_COMMENT_MAX + 2 }, (_, i) => ({
            authorName: `r${i}`,
            isAgent: false,
            body: `reply ${i}`,
          })),
        },
      ],
    });
    expect(post!.comments[0].replies.length).toBe(REPLIES_PER_COMMENT_MAX);
  });
});

describe('normalizeForumBootstrapResult', () => {
  it('requires a valid account and at least one post', () => {
    expect(normalizeForumBootstrapResult({ posts: [] })).toBeNull();
    const ok = normalizeForumBootstrapResult({
      account: { username: 'u', themeKeywords: [] },
      posts: [{ relation: 'authored', title: 't', body: 'b', comments: makeComments(3) }],
    });
    expect(ok).not.toBeNull();
    expect(ok!.posts.length).toBe(1);
  });

  it('returns null when account is missing', () => {
    expect(
      normalizeForumBootstrapResult({ posts: [{ relation: 'authored', title: 't', body: 'b', comments: [] }] }),
    ).toBeNull();
  });
});

describe('normalizeForumBatchResult', () => {
  it('caps posts and parses optional newAccount', () => {
    const r = normalizeForumBatchResult({
      posts: Array.from({ length: POSTS_PER_BATCH_MAX + 2 }, (_, i) => ({
        relation: 'authored',
        title: `帖 ${i}`,
        body: 'b',
        comments: makeComments(3),
      })),
      newAccount: { username: '新号', themeKeywords: [] },
    });
    expect(r.posts.length).toBe(POSTS_PER_BATCH_MAX);
    expect(r.newAccount?.username).toBe('新号');
  });

  it('newAccount is null when absent', () => {
    expect(normalizeForumBatchResult({ posts: [] }).newAccount).toBeNull();
  });
});

describe('normalizeForumDmResult', () => {
  it('parses threads and accepts both sender and from aliases', () => {
    const threads = normalizeForumDmResult({
      threads: [
        {
          peerName: '楼主A',
          messages: [
            { sender: 'peer', body: '在吗' },
            { from: 'agent', body: '在' },
            { sender: 'me', body: '怎么了' },
          ],
        },
      ],
    });
    expect(threads.length).toBe(1);
    expect(threads[0].messages.map((m) => m.sender)).toEqual(['peer', 'agent', 'agent']);
  });

  it('drops a thread without a peerName or messages', () => {
    expect(normalizeForumDmResult({ threads: [{ messages: [{ sender: 'peer', body: 'x' }] }] })).toEqual([]);
    expect(normalizeForumDmResult({ threads: [{ peerName: 'A', messages: [] }] })).toEqual([]);
  });
});
