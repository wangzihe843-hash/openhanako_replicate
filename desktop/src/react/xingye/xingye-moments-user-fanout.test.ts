/**
 * @vitest-environment jsdom
 *
 * 覆盖用户朋友圈「角色围观扇出」：
 *   - decideXingyeUserPostReaction：按关系档位确定性决策点赞 / 评论 / 语气
 *   - fanOutAgentReactionsToUserPost：串行编排——点赞、生成评论、写回评论区
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../types';

const storeMock = vi.hoisted(() => ({
  toggleXingyeMomentLike: vi.fn(),
  addXingyeMomentComment: vi.fn(),
  listXingyeMomentPosts: vi.fn(),
}));
const stateMock = vi.hoisted(() => ({
  getRelationshipState: vi.fn(),
}));

vi.mock('./xingye-moments-store', () => ({
  ...storeMock,
  XINGYE_MOMENT_USER_AUTHOR_ID: '__user__',
}));
vi.mock('./xingye-state-store', () => ({
  getRelationshipState: stateMock.getRelationshipState,
}));
vi.mock('./xingye-persistence', () => ({
  getXingyePersistenceStorage: () => null,
}));
vi.mock('./xingye-moments-ai', () => ({
  generateXingyeMomentCommentForUserPostWithAI: vi.fn(),
}));

import {
  decideXingyeUserPostReaction,
  fanOutAgentReactionsToUserPost,
} from './xingye-moments-user-fanout';

/** 返回一个按给定序列循环吐数的伪随机源——用于确定性测试。 */
function seqRand(values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length];
}

function makeAgent(id: string): Agent {
  return { id, name: id, yuan: 'hanako', isPrimary: false, hasAvatar: false };
}

beforeEach(() => {
  storeMock.toggleXingyeMomentLike.mockReset().mockResolvedValue(undefined);
  storeMock.addXingyeMomentComment.mockReset().mockResolvedValue(undefined);
  storeMock.listXingyeMomentPosts.mockReset();
  stateMock.getRelationshipState.mockReset();
});

describe('decideXingyeUserPostReaction', () => {
  it('enemy: 绝不点赞，大概率冷嘲热讽', () => {
    // rand 序列：第 1 个用于 like，第 2 个用于 comment。
    const sarcastic = decideXingyeUserPostReaction('enemy', seqRand([0.0, 0.0]));
    expect(sarcastic).toEqual({ like: false, comment: 'sarcastic' });

    // comment 抽到 0.99 > 0.85 → 不评论；like 永远 false（likeProb 0）。
    const silent = decideXingyeUserPostReaction('enemy', seqRand([0.0, 0.99]));
    expect(silent).toEqual({ like: false, comment: 'none' });
  });

  it('estranged: 关系有点不好——多数情况点赞评论都不做', () => {
    const decision = decideXingyeUserPostReaction('estranged', seqRand([0.5, 0.5]));
    expect(decision).toEqual({ like: false, comment: 'none' });
  });

  it('close_friend: 大概率友善点赞 + 评论', () => {
    const decision = decideXingyeUserPostReaction('close_friend', seqRand([0.1, 0.1]));
    expect(decision).toEqual({ like: true, comment: 'friendly' });
  });

  it('无关系记录时回退到默认（friend）档位', () => {
    const decision = decideXingyeUserPostReaction(null, seqRand([0.0, 0.0]));
    expect(decision).toEqual({ like: true, comment: 'friendly' });
  });
});

describe('fanOutAgentReactionsToUserPost', () => {
  it('enemy 角色：不点赞，但写一条 sarcastic 评论', async () => {
    stateMock.getRelationshipState.mockReturnValue({ relationshipKey: 'enemy' });
    storeMock.listXingyeMomentPosts.mockResolvedValue([
      { id: 'p1', content: '今天升职了', comments: [] },
    ]);
    const generateComment = vi.fn().mockResolvedValue('哦，升职了不起哦。');

    await fanOutAgentReactionsToUserPost({
      postId: 'p1',
      agents: [{ agent: makeAgent('rival'), profile: null, displayName: '宿敌' }],
      rand: seqRand([0.0, 0.0]),
      generateComment,
    });

    expect(storeMock.toggleXingyeMomentLike).not.toHaveBeenCalled();
    expect(generateComment).toHaveBeenCalledWith(
      expect.objectContaining({ tone: 'sarcastic', postContent: '今天升职了' }),
    );
    expect(storeMock.addXingyeMomentComment).toHaveBeenCalledWith(
      '__user__',
      'p1',
      expect.objectContaining({ actorType: 'agent', actorId: 'rival' }),
      '哦，升职了不起哦。',
    );
  });

  it('estranged 角色：点赞评论都不做', async () => {
    stateMock.getRelationshipState.mockReturnValue({ relationshipKey: 'estranged' });
    const generateComment = vi.fn();

    await fanOutAgentReactionsToUserPost({
      postId: 'p1',
      agents: [{ agent: makeAgent('coldone'), profile: null, displayName: '冷淡的人' }],
      rand: seqRand([0.9, 0.9]),
      generateComment,
    });

    expect(storeMock.toggleXingyeMomentLike).not.toHaveBeenCalled();
    expect(generateComment).not.toHaveBeenCalled();
    expect(storeMock.addXingyeMomentComment).not.toHaveBeenCalled();
  });

  it('close_friend 角色：点赞并写一条 friendly 评论', async () => {
    stateMock.getRelationshipState.mockReturnValue({ relationshipKey: 'close_friend' });
    storeMock.listXingyeMomentPosts.mockResolvedValue([
      { id: 'p1', content: '今天升职了', comments: [] },
    ]);
    const generateComment = vi.fn().mockResolvedValue('太棒了，请客！');

    await fanOutAgentReactionsToUserPost({
      postId: 'p1',
      agents: [{ agent: makeAgent('bestie'), profile: null, displayName: '好友' }],
      rand: seqRand([0.0, 0.0]),
      generateComment,
    });

    expect(storeMock.toggleXingyeMomentLike).toHaveBeenCalledWith(
      '__user__',
      'p1',
      expect.objectContaining({ actorType: 'agent', actorId: 'bestie' }),
    );
    expect(generateComment).toHaveBeenCalledWith(
      expect.objectContaining({ tone: 'friendly' }),
    );
    expect(storeMock.addXingyeMomentComment).toHaveBeenCalledWith(
      '__user__',
      'p1',
      expect.objectContaining({ actorType: 'agent', actorId: 'bestie' }),
      '太棒了，请客！',
    );
  });

  it('单个角色评论失败被隔离，不影响其余角色', async () => {
    stateMock.getRelationshipState.mockReturnValue({ relationshipKey: 'close_friend' });
    storeMock.listXingyeMomentPosts.mockResolvedValue([
      { id: 'p1', content: '今天升职了', comments: [] },
    ]);
    const generateComment = vi
      .fn()
      .mockRejectedValueOnce(new Error('模型超时'))
      .mockResolvedValueOnce('恭喜恭喜！');

    await fanOutAgentReactionsToUserPost({
      postId: 'p1',
      agents: [
        { agent: makeAgent('a1'), profile: null, displayName: '甲' },
        { agent: makeAgent('a2'), profile: null, displayName: '乙' },
      ],
      rand: seqRand([0.0, 0.0]),
      generateComment,
    });

    // 两个角色都点了赞；第一个评论失败，第二个仍成功写入。
    expect(storeMock.toggleXingyeMomentLike).toHaveBeenCalledTimes(2);
    expect(storeMock.addXingyeMomentComment).toHaveBeenCalledTimes(1);
    expect(storeMock.addXingyeMomentComment).toHaveBeenCalledWith(
      '__user__',
      'p1',
      expect.objectContaining({ actorId: 'a2' }),
      '恭喜恭喜！',
    );
  });

  it('postId 为空时直接返回，不做任何写入', async () => {
    await fanOutAgentReactionsToUserPost({
      postId: '   ',
      agents: [{ agent: makeAgent('a1'), profile: null, displayName: '甲' }],
      rand: seqRand([0.0, 0.0]),
      generateComment: vi.fn(),
    });
    expect(storeMock.toggleXingyeMomentLike).not.toHaveBeenCalled();
    expect(storeMock.addXingyeMomentComment).not.toHaveBeenCalled();
  });
});
