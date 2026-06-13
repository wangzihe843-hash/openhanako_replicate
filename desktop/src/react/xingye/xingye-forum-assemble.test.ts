import { describe, expect, it } from 'vitest';
import {
  assembleAccount,
  assembleDmThreads,
  assemblePosts,
  buildForumDedupeAnchorBlock,
  deriveForumDmPeers,
  type ForumDmPeerCandidate,
} from './xingye-forum-assemble';
import type { ForumAccount, ForumPost, ForumPostSpec } from './xingye-forum-types';

const NOW = Date.parse('2026-06-13T12:00:00.000Z');
const opts = { now: NOW, rand: () => 0.5 };

function account(overrides: Partial<ForumAccount> = {}): ForumAccount {
  return {
    accountId: 'acc1',
    username: '夜行猫',
    bio: '深夜不睡',
    themeLabel: '树洞',
    themeKeywords: ['深夜', '失眠'],
    avatarSeed: '夜行猫',
    joinedAt: new Date(NOW - 100 * 86400000).toISOString(),
    stats: { posts: 0, followers: 10, following: 5 },
    createdAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

describe('assembleAccount', () => {
  it('mirrors username into avatarSeed and stamps times', () => {
    const a = assembleAccount({ username: '夜行猫', bio: 'b', themeLabel: '树洞', themeKeywords: ['x'] }, opts);
    expect(a.username).toBe('夜行猫');
    expect(a.avatarSeed).toBe('夜行猫');
    expect(Date.parse(a.joinedAt)).toBeLessThanOrEqual(NOW);
    expect(a.accountId).toMatch(/^facc-/);
  });
});

describe('assemblePosts', () => {
  const acc = account();
  const specs: ForumPostSpec[] = [
    {
      relation: 'authored',
      board: '深夜',
      title: '又失眠',
      body: '凌晨三点',
      comments: [
        { authorName: '路人甲', authorIsAgent: false, body: '抱抱', replies: [{ authorName: '', authorIsAgent: true, body: '谢谢' }] },
        { authorName: '', authorIsAgent: true, body: '楼主自己冒泡', replies: [] },
      ],
    },
    {
      relation: 'commented',
      board: '影视',
      title: '这部剧好看吗',
      body: 'NPC 写的正文',
      authorName: '影迷老王',
      comments: [{ authorName: '', authorIsAgent: true, body: '我觉得还行', replies: [] }],
    },
  ];

  it('fills authored author from account and marks authorIsAgent', () => {
    const [authored, commented] = assemblePosts(specs, acc, { ...opts, spreadDays: 10 });
    expect(authored.authorName).toBe(acc.username);
    expect(authored.authorIsAgent).toBe(true);
    expect(commented.authorName).toBe('影迷老王');
    expect(commented.authorIsAgent).toBe(false);
  });

  it('overrides agent comment/reply author to the account username', () => {
    const [authored] = assemblePosts(specs, acc, opts);
    const agentComment = authored.comments.find((c) => c.authorIsAgent);
    expect(agentComment?.authorName).toBe(acc.username);
    const npcComment = authored.comments.find((c) => !c.authorIsAgent);
    expect(npcComment?.authorName).toBe('路人甲');
    const agentReply = npcComment?.replies.find((r) => r.authorIsAgent);
    expect(agentReply?.authorName).toBe(acc.username);
  });

  it('keeps all timestamps at or before now and post before its comments', () => {
    const [authored] = assemblePosts(specs, acc, opts);
    expect(Date.parse(authored.postedAt)).toBeLessThanOrEqual(NOW);
    for (const c of authored.comments) {
      expect(Date.parse(c.postedAt)).toBeLessThanOrEqual(NOW);
      expect(Date.parse(c.postedAt)).toBeGreaterThanOrEqual(Date.parse(authored.postedAt));
      for (const r of c.replies) expect(Date.parse(r.postedAt)).toBeLessThanOrEqual(NOW);
    }
  });
});

describe('deriveForumDmPeers', () => {
  const base: Omit<ForumPost, 'relation' | 'authorName' | 'authorIsAgent' | 'comments' | 'postId' | 'title'> = {
    accountId: 'acc1',
    board: 'b',
    body: 'x',
    postedAt: new Date(NOW).toISOString(),
    stats: { views: 1, likes: 1 },
    createdAt: new Date(NOW).toISOString(),
  };
  const posts: ForumPost[] = [
    {
      ...base,
      postId: 'p1',
      title: '别人的帖',
      relation: 'commented',
      authorName: '影迷老王',
      authorIsAgent: false,
      comments: [{ commentId: 'c1', authorName: '夜行猫', authorIsAgent: true, body: 'm', likes: 0, postedAt: base.postedAt, replies: [] }],
    },
    {
      ...base,
      postId: 'p2',
      title: '我的帖',
      relation: 'authored',
      authorName: '夜行猫',
      authorIsAgent: true,
      comments: [
        {
          commentId: 'c2',
          authorName: '热心网友',
          authorIsAgent: false,
          body: 'nice',
          likes: 0,
          postedAt: base.postedAt,
          replies: [{ replyId: 'r1', authorName: '夜行猫', authorIsAgent: true, body: '谢谢', likes: 0, postedAt: base.postedAt }],
        },
        {
          commentId: 'c3',
          authorName: '潜水的人',
          authorIsAgent: false,
          body: 'mark',
          likes: 0,
          postedAt: base.postedAt,
          replies: [], // TA 没回 → 不算 DM 对象
        },
      ],
    },
  ];

  it('derives post authors of commented posts and commenters the agent replied to', () => {
    const peers = deriveForumDmPeers(posts);
    const byName = new Map(peers.map((p) => [p.peerName, p]));
    expect(byName.get('影迷老王')?.originKind).toBe('commented_post_author');
    expect(byName.get('热心网友')?.originKind).toBe('replied_commenter');
    expect(byName.has('潜水的人')).toBe(false); // 没被 TA 回过
  });

  it('dedupes by peer name', () => {
    const dup = [...posts, posts[0]];
    const peers = deriveForumDmPeers(dup);
    expect(peers.filter((p) => p.peerName === '影迷老王').length).toBe(1);
  });
});

describe('assembleDmThreads', () => {
  it('uses peer meta origin and keeps messages ordered and before now', () => {
    const acc = account();
    const meta = new Map<string, ForumDmPeerCandidate>([
      ['影迷老王', { peerName: '影迷老王', originKind: 'commented_post_author', originPostId: 'p1', originPostTitle: '别人的帖' }],
    ]);
    const threads = assembleDmThreads(
      [{ peerName: '影迷老王', messages: [{ sender: 'peer', body: '嗨' }, { sender: 'agent', body: '嗯' }] }],
      acc,
      meta,
      opts,
    );
    expect(threads.length).toBe(1);
    expect(threads[0].originKind).toBe('commented_post_author');
    expect(threads[0].originPostTitle).toBe('别人的帖');
    const times = threads[0].messages.map((m) => Date.parse(m.sentAt));
    expect(times[0]).toBeLessThanOrEqual(times[1]);
    expect(times[1]).toBeLessThanOrEqual(NOW);
    expect(threads[0].lastMessageAt).toBe(threads[0].messages[1].sentAt);
  });
});

describe('buildForumDedupeAnchorBlock', () => {
  it('lists recent titles and existing account labels, no post bodies', () => {
    const acc = account();
    const posts = assemblePosts(
      [{ relation: 'authored', board: '深夜', title: '又失眠', body: '不该出现的正文', comments: [{ authorName: 'x', authorIsAgent: false, body: 'c', replies: [] }] }],
      acc,
      opts,
    );
    const block = buildForumDedupeAnchorBlock(posts, [acc]);
    expect(block).toContain('又失眠');
    expect(block).toContain('@夜行猫');
    expect(block).not.toContain('不该出现的正文');
  });
});
