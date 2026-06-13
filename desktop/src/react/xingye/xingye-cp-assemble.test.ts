import { describe, expect, it } from 'vitest';
import {
  assembleAgentPostFromDraft,
  assembleCpAltFromForumAccount,
  assembleCpAltFromSpec,
  assembleCpDrafts,
  assembleCpPosts,
  buildAgentCommentFromDraft,
  buildCpDedupeAnchorBlock,
  cpChatSignature,
} from './xingye-cp-assemble';
import type { CpAltAccount, CpDraftSpec, CpPostSpec } from './xingye-cp-types';

const NOW = Date.parse('2026-06-13T12:00:00.000Z');
const opts = { now: NOW, rand: () => 0.5 };

const ALT: CpAltAccount = {
  accountId: 'calt1',
  username: '蹲墙根潜水',
  bio: '只是路过磕一口',
  themeLabel: '潜水',
  avatarSeed: '蹲墙根潜水',
  fromForum: false,
};

const postSpecs: CpPostSpec[] = [
  {
    genre: 'fic',
    board: 'CP·糖',
    title: '无人知晓的午后',
    body: 'NPC 写的同人节选',
    authorName: '嗑学家本家',
    comments: [
      { authorName: '路人甲', authorIsAgent: false, body: '磕到了', replies: [{ authorName: '', authorIsAgent: true, body: '别瞎磕' }] },
      { authorName: '', authorIsAgent: true, body: 'TA 冷冷冒泡', replies: [] },
    ],
  },
  {
    genre: 'analysis',
    board: '考据组',
    title: '从那个动作看郎情妾意',
    body: '证据流',
    authorName: '考据组组长',
    comments: [{ authorName: '吃瓜', authorIsAgent: false, body: '有道理', replies: [] }],
  },
];

describe('assembleCpPosts', () => {
  it('marks NPC origin and overrides agent comment/reply author to the alt username', () => {
    const [first] = assembleCpPosts(postSpecs, ALT.username, opts);
    expect(first.origin).toBe('npc');
    expect(first.authorIsAgent).toBe(false);
    expect(first.authorName).toBe('嗑学家本家');
    const agentComment = first.comments.find((c) => c.authorIsAgent);
    expect(agentComment?.authorName).toBe(ALT.username);
    const npcComment = first.comments.find((c) => !c.authorIsAgent);
    expect(npcComment?.authorName).toBe('路人甲');
    const agentReply = npcComment?.replies.find((r) => r.authorIsAgent);
    expect(agentReply?.authorName).toBe(ALT.username);
  });

  it('keeps timestamps at or before now and post before its comments', () => {
    const [first] = assembleCpPosts(postSpecs, ALT.username, opts);
    expect(Date.parse(first.postedAt)).toBeLessThanOrEqual(NOW);
    for (const c of first.comments) {
      expect(Date.parse(c.postedAt)).toBeLessThanOrEqual(NOW);
      expect(Date.parse(c.postedAt)).toBeGreaterThanOrEqual(Date.parse(first.postedAt));
    }
  });
});

describe('assembleCpDrafts', () => {
  it('binds a reply draft to a post by title and drops unbindable replies', () => {
    const posts = assembleCpPosts(postSpecs, ALT.username, opts);
    const specs: CpDraftSpec[] = [
      { kind: 'reply', body: '别瞎磕（其实在意）', targetPostTitle: '无人知晓的午后', sendReaction: '哎你', hesitation: '怂了' },
      { kind: 'reply', body: '没有目标', targetPostTitle: '根本不存在的帖', sendReaction: 'r', hesitation: 'h' },
      { kind: 'post', genre: 'squee', board: 'CP·糖', title: '想匿名发疯', body: '啊啊啊', sendReaction: 'r', hesitation: 'h' },
    ];
    const drafts = assembleCpDrafts(specs, posts, opts);
    expect(drafts.length).toBe(2); // 不存在的目标被丢弃
    const reply = drafts.find((d) => d.kind === 'reply');
    expect(reply?.targetPostId).toBe(posts[0].postId);
    expect(reply?.targetPostTitle).toBe('无人知晓的午后');
    expect(drafts.some((d) => d.kind === 'post')).toBe(true);
  });
});

describe('send-draft materializers', () => {
  it('assembleAgentPostFromDraft yields an agent-origin post', () => {
    const post = assembleAgentPostFromDraft(
      { draftId: 'd1', kind: 'post', genre: 'fic', board: 'CP·糖', title: '我也写一篇', body: '正文', sendReaction: 'r', hesitation: 'h', createdAt: new Date(NOW).toISOString() },
      ALT,
      opts,
    );
    expect(post.origin).toBe('agent');
    expect(post.authorIsAgent).toBe(true);
    expect(post.authorName).toBe(ALT.username);
    expect(post.comments).toEqual([]);
    expect(Date.parse(post.postedAt)).toBeLessThanOrEqual(NOW);
  });

  it('buildAgentCommentFromDraft yields an agent comment', () => {
    const comment = buildAgentCommentFromDraft(
      { draftId: 'd2', kind: 'reply', body: '澄清一句', targetPostId: 'p', targetPostTitle: 't', sendReaction: 'r', hesitation: 'h', createdAt: new Date(NOW).toISOString() },
      ALT,
      opts,
    );
    expect(comment.authorIsAgent).toBe(true);
    expect(comment.authorName).toBe(ALT.username);
    expect(comment.body).toBe('澄清一句');
  });
});

describe('alt builders', () => {
  it('assembleCpAltFromSpec is not from forum', () => {
    const alt = assembleCpAltFromSpec({ username: 'u', bio: 'b', themeLabel: 't' }, opts);
    expect(alt.fromForum).toBe(false);
    expect(alt.avatarSeed).toBe('u');
  });

  it('assembleCpAltFromForumAccount is from forum', () => {
    const alt = assembleCpAltFromForumAccount({ accountId: 'a', username: '夜行猫', bio: 'b', themeLabel: '树洞', avatarSeed: '夜行猫' });
    expect(alt.fromForum).toBe(true);
    expect(alt.accountId).toBe('a');
  });
});

describe('buildCpDedupeAnchorBlock', () => {
  it('lists titles and genres but not post bodies', () => {
    const posts = assembleCpPosts(postSpecs, ALT.username, opts);
    const block = buildCpDedupeAnchorBlock(posts);
    expect(block).toContain('无人知晓的午后');
    expect(block).toContain('考据');
    expect(block).not.toContain('NPC 写的同人节选');
  });

  it('handles empty input', () => {
    expect(buildCpDedupeAnchorBlock([])).toContain('暂无');
  });
});

describe('cpChatSignature', () => {
  it('is stable for identical input and changes when chat changes', () => {
    const a = cpChatSignature({ messageCount: 3, lastCreatedAt: '2026-06-13T11:00:00.000Z', summaryText: 'hi there' });
    const b = cpChatSignature({ messageCount: 3, lastCreatedAt: '2026-06-13T11:00:00.000Z', summaryText: 'hi there' });
    const c = cpChatSignature({ messageCount: 4, lastCreatedAt: '2026-06-13T11:30:00.000Z', summaryText: 'hi there now' });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
