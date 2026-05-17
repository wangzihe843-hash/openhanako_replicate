/**
 * @vitest-environment jsdom
 *
 * 主要覆盖「待确认草稿区」的两条 confirm 路径：
 *   - plain 「确认发表」：只写正文，不带 seeds
 *   - combined 「确认并生成互动」：先 AI 拉 seeds → 再连同正文一起发表（一步完成）
 * 不覆盖整个朋友圈 feed 的渲染（那块由 MomentCard / useAggregatedXingyeMoments 各自的测试覆盖）。
 */

import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../types';

const momentsStoreMock = vi.hoisted(() => ({
  addXingyeMomentComment: vi.fn(),
  confirmMomentDraft: vi.fn(),
  createXingyeMomentPost: vi.fn(),
  deleteXingyeMomentPost: vi.fn(),
  discardMomentDraft: vi.fn(),
  listMomentDrafts: vi.fn(),
  toggleXingyeMomentLike: vi.fn(),
}));

const momentsFeedMock = vi.hoisted(() => ({
  useAggregatedXingyeMoments: vi.fn(),
}));

const momentsAiMock = vi.hoisted(() => ({
  generateXingyeMomentDraftWithAI: vi.fn(),
}));

const profileMock = vi.hoisted(() => ({
  getXingyeRoleProfileDisplay: vi.fn(() => ({
    displayName: '林雾',
    relationshipLabel: 'friend',
    speakingStyle: 'calm',
    chatBackgroundDataUrl: undefined,
  })),
  useXingyeRoleProfiles: vi.fn(() => ({})),
}));

const storesMock = vi.hoisted(() => ({
  useStore: vi.fn((selector?: (state: unknown) => unknown) => {
    const state = { userName: '我' };
    return selector ? selector(state) : state;
  }),
}));

vi.mock('./xingye-moments-store', () => ({
  ...momentsStoreMock,
  XINGYE_MOMENTS_CHANGED_EVENT: 'xingye-moments-changed',
}));
vi.mock('./xingye-moments-feed', () => momentsFeedMock);
vi.mock('./xingye-moments-ai', () => momentsAiMock);
vi.mock('./xingye-profile-store', () => profileMock);
vi.mock('../stores', () => storesMock);
vi.mock('./XingyeAgentAvatar', () => ({
  XingyeAgentAvatar: ({ alt }: { alt: string }) => <div>{alt}</div>,
}));
vi.mock('./MomentCard', () => ({
  MomentCard: ({ post }: { post: { id: string } }) => <div data-testid={`moment-card-${post.id}`} />,
}));
vi.mock('./MomentComposer', () => ({
  MomentComposer: () => <div data-testid="moment-composer-stub" />,
}));

import { MomentsPanel } from './MomentsPanel';

const agent: Agent = {
  id: 'linwu',
  name: '林雾',
  yuan: 'hanako',
  isPrimary: false,
  hasAvatar: false,
};

function renderPanel() {
  return render(
    <MomentsPanel
      agents={[agent]}
      currentAgentId="linwu"
      selectedXingyeAgentId="linwu"
    />,
  );
}

beforeEach(() => {
  for (const fn of Object.values(momentsStoreMock)) fn.mockReset();
  momentsAiMock.generateXingyeMomentDraftWithAI.mockReset();
  momentsFeedMock.useAggregatedXingyeMoments.mockReturnValue({
    posts: [],
    loading: false,
    error: null,
    retry: vi.fn(),
  });
  momentsStoreMock.listMomentDrafts.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
});

describe('MomentsPanel · pending drafts section', () => {
  it('shows nothing when listMomentDrafts returns empty', async () => {
    renderPanel();
    await waitFor(() => {
      expect(momentsStoreMock.listMomentDrafts).toHaveBeenCalledWith('linwu');
    });
    expect(screen.queryByTestId('moments-pending-drafts')).not.toBeInTheDocument();
  });

  it('plain "确认发表" path calls confirmMomentDraft WITHOUT seeds and does NOT call AI', async () => {
    momentsStoreMock.listMomentDrafts.mockResolvedValueOnce([
      {
        id: 'd-plain',
        content: '海风把灯影吹得有点歪。',
        createdAt: '2026-05-17T12:00:00.000Z',
        source: 'xingye-heartbeat-tool',
      },
    ]);
    momentsStoreMock.confirmMomentDraft.mockResolvedValueOnce({ id: 'post-1' });

    renderPanel();
    await screen.findByTestId('moments-draft-d-plain');
    fireEvent.click(screen.getByTestId('moments-draft-confirm-d-plain'));

    await waitFor(() => {
      expect(momentsStoreMock.confirmMomentDraft).toHaveBeenCalledWith(
        'linwu',
        'd-plain',
        expect.objectContaining({ content: '海风把灯影吹得有点歪。' }),
      );
    });
    /** Plain path: no seeds in the call object. */
    const callArgs = momentsStoreMock.confirmMomentDraft.mock.calls[0][2];
    expect(callArgs).not.toHaveProperty('seedLikes');
    expect(callArgs).not.toHaveProperty('seedComments');
    /** Plain path: no AI call. */
    expect(momentsAiMock.generateXingyeMomentDraftWithAI).not.toHaveBeenCalled();
    /** Draft removed from UI after success. */
    await waitFor(() => {
      expect(screen.queryByTestId('moments-draft-d-plain')).not.toBeInTheDocument();
    });
  });

  it('combined "确认并生成互动" path: AI first, then confirm with seeds', async () => {
    momentsStoreMock.listMomentDrafts.mockResolvedValueOnce([
      {
        id: 'd-combo',
        content: '晚风把灯影吹得有点歪。',
        createdAt: '2026-05-17T12:00:00.000Z',
        source: 'xingye-heartbeat-tool',
      },
    ]);
    momentsAiMock.generateXingyeMomentDraftWithAI.mockResolvedValueOnce({
      content: '晚风把灯影吹得有点歪。',
      seedLikes: [
        { actorType: 'agent', actorId: 'hanako', actorName: 'Hanako' },
      ],
      seedComments: [
        {
          actorType: 'virtual_contact',
          actorId: 'linwu:vc-1',
          actorName: '夜班搭子',
          body: '又熬夜？',
        },
      ],
    });
    momentsStoreMock.confirmMomentDraft.mockResolvedValueOnce({ id: 'post-2' });

    renderPanel();
    await screen.findByTestId('moments-draft-d-combo');
    fireEvent.click(screen.getByTestId('moments-draft-confirm-with-interactions-d-combo'));

    /** Step 1: AI generation invoked with existingContent === user's draft content. */
    await waitFor(() => {
      expect(momentsAiMock.generateXingyeMomentDraftWithAI).toHaveBeenCalledTimes(1);
    });
    const aiCall = momentsAiMock.generateXingyeMomentDraftWithAI.mock.calls[0][0];
    expect(aiCall.existingContent).toBe('晚风把灯影吹得有点歪。');
    expect(aiCall.agent).toMatchObject({ id: 'linwu' });

    /** Step 2: confirm with the seeds returned from AI. */
    await waitFor(() => {
      expect(momentsStoreMock.confirmMomentDraft).toHaveBeenCalledWith(
        'linwu',
        'd-combo',
        expect.objectContaining({
          content: '晚风把灯影吹得有点歪。',
          seedLikes: expect.arrayContaining([
            expect.objectContaining({ actorId: 'hanako' }),
          ]),
          seedComments: expect.arrayContaining([
            expect.objectContaining({ body: '又熬夜？' }),
          ]),
        }),
      );
    });

    /** Draft removed from UI after success. */
    await waitFor(() => {
      expect(screen.queryByTestId('moments-draft-d-combo')).not.toBeInTheDocument();
    });
  });

  it('combined path: if AI fails, draft stays + confirm is NOT called', async () => {
    momentsStoreMock.listMomentDrafts.mockResolvedValueOnce([
      {
        id: 'd-fail',
        content: '内容',
        createdAt: '2026-05-17T12:00:00.000Z',
        source: 'xingye-heartbeat-tool',
      },
    ]);
    momentsAiMock.generateXingyeMomentDraftWithAI.mockRejectedValueOnce(new Error('AI rate limit'));

    renderPanel();
    await screen.findByTestId('moments-draft-d-fail');
    fireEvent.click(screen.getByTestId('moments-draft-confirm-with-interactions-d-fail'));

    /** AI was tried — and failed. */
    await waitFor(() => {
      expect(momentsAiMock.generateXingyeMomentDraftWithAI).toHaveBeenCalled();
    });
    /** confirm must NOT be called when AI fails first. */
    expect(momentsStoreMock.confirmMomentDraft).not.toHaveBeenCalled();
    /** Draft stays visible — user can retry or fall back to plain "确认发表". */
    expect(screen.queryByTestId('moments-draft-d-fail')).toBeInTheDocument();
    /** Error surfaced (best-effort: at least the error text shows up somewhere in the section). */
    expect(await screen.findByText(/AI rate limit/)).toBeInTheDocument();
  });
});
