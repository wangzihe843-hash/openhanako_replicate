/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../types';

const mocks = vi.hoisted(() => ({
  getItem: vi.fn(), setItem: vi.fn(), read: vi.fn(),
  like: vi.fn(), comment: vi.fn(), list: vi.fn(),
}));
vi.mock('./xingye-persistence', () => ({ getXingyePersistenceStorage: () => ({ getItem: mocks.getItem, setItem: mocks.setItem }) }));
vi.mock('./xingye-storage-api', () => ({ postXingyeStorage: mocks.read }));
vi.mock('./xingye-moments-store', () => ({
  XINGYE_MOMENT_USER_AUTHOR_ID: '__user__',
  toggleXingyeMomentLike: mocks.like, addXingyeMomentComment: mocks.comment, listXingyeMomentPosts: mocks.list,
}));
vi.mock('./xingye-moments-ai', () => ({ generateXingyeMomentCommentForUserPostWithAI: vi.fn() }));

import { fanOutAgentReactionsToUserPost } from './xingye-moments-user-fanout';

describe('user moment reactions with per-agent persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The selected role cache deliberately contains no data for the rival.
    mocks.getItem.mockReturnValue(JSON.stringify({ selected: { agentId: 'selected', affection: 80 } }));
    mocks.read.mockResolvedValue({ data: { rival: { agentId: 'rival', affection: -90 } } });
    mocks.list.mockResolvedValue([{ id: 'post', content: 'I got promoted', comments: [] }]);
  });

  it('uses an unselected rival role’s persisted relationship instead of the default friend reaction', async () => {
    const generateComment = vi.fn().mockResolvedValue('A sarcastic response');
    await fanOutAgentReactionsToUserPost({
      postId: 'post', rand: () => 0,
      agents: [{ agent: { id: 'rival', name: 'Rival' } as Agent, profile: null, displayName: 'Rival' }],
      generateComment,
    });
    expect(mocks.like).not.toHaveBeenCalled();
    expect(generateComment).toHaveBeenCalledWith(expect.objectContaining({ tone: 'sarcastic' }));
    expect(mocks.read).toHaveBeenCalledWith({ action: 'readJson', agentId: 'rival', relativePath: 'relationship-state.json' });
    expect(mocks.setItem).not.toHaveBeenCalled();
  });

  it('keeps the selected role’s latest in-memory relationship without replacing it with an older file', async () => {
    mocks.getItem.mockReturnValue(JSON.stringify({ rival: { agentId: 'rival', affection: 80 } }));
    const generateComment = vi.fn().mockResolvedValue('A friendly response');
    await fanOutAgentReactionsToUserPost({
      postId: 'post', rand: () => 0,
      agents: [{ agent: { id: 'rival', name: 'Rival' } as Agent, profile: null, displayName: 'Rival' }],
      generateComment,
    });
    expect(mocks.like).toHaveBeenCalledTimes(1);
    expect(generateComment).toHaveBeenCalledWith(expect.objectContaining({ tone: 'friendly' }));
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.setItem).not.toHaveBeenCalled();
  });
});
