/**
 * @vitest-environment jsdom
 *
 * 覆盖「心跳巡检 → 待确认报纸意图草稿」的 UI 链路：
 * 草稿只带 angle/reason，确认时 UI 现跑 generateNewsDraftWithAI 生成整期报纸，
 * 再调 confirmNewsDraftWithEntry 幂等落地。
 */

import React from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Agent } from '../types';

const appEntryStoreMock = vi.hoisted(() => ({
  appendAppEntry: vi.fn(),
  deleteAppEntry: vi.fn(),
  listAppEntries: vi.fn(),
  updateAppEntry: vi.fn(),
}));

const newsAiMock = vi.hoisted(() => ({
  generateNewsCommentWithAI: vi.fn(),
  generateNewsDraftWithAI: vi.fn(),
}));

const newsDraftsMock = vi.hoisted(() => ({
  confirmNewsDraftWithEntry: vi.fn(),
  discardNewsDraft: vi.fn(),
  listNewsDrafts: vi.fn().mockResolvedValue([]),
}));

vi.mock('./xingye-app-entry-store', () => appEntryStoreMock);
vi.mock('./xingye-news-ai', () => newsAiMock);
vi.mock('./xingye-news-drafts', () => newsDraftsMock);

import { PhoneNewsApp } from './PhoneNewsApp';
import type { XingyeRoleProfile } from './xingye-profile-store';

const linwu: Agent = {
  id: 'test01',
  name: '林雾',
  yuan: 'hanako',
  isPrimary: false,
  hasAvatar: false,
};

const linwuProfile: XingyeRoleProfile = {
  agentId: 'test01',
  displayName: '林雾',
  shortBio: '战地医生，喜欢冬天。',
  updatedAt: '2026-05-16T00:00:00.000Z',
};

/** 一份能通过 normalizeNewsEntryMetadata 的最小报纸：masthead + 2 个合法板块。 */
const SAMPLE_META = {
  issueDate: '2026-05-21T00:00:00.000Z',
  masthead: '《边境暮报》',
  sections: [
    {
      kind: 'headline_world',
      title: '今日要闻',
      body: '边境的清晨照常落了一层薄霜，城里没有大事，只有运货的车队比往日早了一刻。',
    },
    { kind: 'weather', title: '今日天气', body: '晴。' },
  ],
};

function renderNews(agent: Agent | null = linwu, profile: XingyeRoleProfile | null = linwuProfile) {
  return render(
    <PhoneNewsApp
      ownerAgent={agent}
      ownerProfile={profile}
      displayName={agent?.name ?? 'TA'}
      onBack={vi.fn()}
    />,
  );
}

describe('PhoneNewsApp · pending draft section', () => {
  beforeEach(() => {
    appEntryStoreMock.appendAppEntry.mockReset();
    appEntryStoreMock.deleteAppEntry.mockReset();
    appEntryStoreMock.listAppEntries.mockReset();
    appEntryStoreMock.updateAppEntry.mockReset();
    appEntryStoreMock.listAppEntries.mockResolvedValue([]);
    newsAiMock.generateNewsCommentWithAI.mockReset();
    newsAiMock.generateNewsDraftWithAI.mockReset();
    newsDraftsMock.confirmNewsDraftWithEntry.mockReset();
    newsDraftsMock.discardNewsDraft.mockReset();
    newsDraftsMock.listNewsDrafts.mockReset();
    newsDraftsMock.listNewsDrafts.mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders a pending news draft and confirm runs generation then confirmNewsDraftWithEntry', async () => {
    newsDraftsMock.listNewsDrafts.mockResolvedValueOnce([
      {
        id: 'd-news-1',
        angle: '想看看城里最近的世态',
        reason: '巡检里 TA 一直在惦记边境的事',
        source: 'xingye-heartbeat-tool',
        createdAt: '2026-05-21T12:00:00.000Z',
      },
    ]);
    newsAiMock.generateNewsDraftWithAI.mockResolvedValueOnce(SAMPLE_META);
    newsDraftsMock.confirmNewsDraftWithEntry.mockResolvedValueOnce({
      id: 'from-draft-d-news-1',
      agentId: 'test01',
      appId: 'news',
      title: SAMPLE_META.masthead,
      content: '《边境暮报》',
      metadata: SAMPLE_META,
      source: 'xingye-heartbeat-confirmed',
      createdAt: '2026-05-21T12:30:00.000Z',
      updatedAt: '2026-05-21T12:30:00.000Z',
    });

    renderNews();

    const draftCard = await screen.findByTestId('phone-news-draft-d-news-1');
    expect(within(draftCard).getByText(/想看看城里最近的世态/)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('phone-news-draft-confirm-d-news-1'));

    await waitFor(() => {
      expect(newsAiMock.generateNewsDraftWithAI).toHaveBeenCalledWith(
        expect.objectContaining({ agent: linwu, userIntent: '想看看城里最近的世态' }),
      );
    });
    await waitFor(() => {
      expect(newsDraftsMock.confirmNewsDraftWithEntry).toHaveBeenCalledWith('test01', 'd-news-1', SAMPLE_META);
    });
    await waitFor(() => {
      expect(screen.queryByTestId('phone-news-draft-d-news-1')).not.toBeInTheDocument();
    });
  });

  it('discard calls discardNewsDraft and does not run generation', async () => {
    newsDraftsMock.listNewsDrafts.mockResolvedValueOnce([
      {
        id: 'd-news-2',
        source: 'xingye-heartbeat-tool',
        createdAt: '2026-05-21T12:00:00.000Z',
      },
    ]);
    newsDraftsMock.discardNewsDraft.mockResolvedValueOnce(true);

    renderNews();
    await screen.findByTestId('phone-news-draft-d-news-2');
    fireEvent.click(screen.getByTestId('phone-news-draft-discard-d-news-2'));

    await waitFor(() => {
      expect(newsDraftsMock.discardNewsDraft).toHaveBeenCalledWith('test01', 'd-news-2');
    });
    await waitFor(() => {
      expect(screen.queryByTestId('phone-news-draft-d-news-2')).not.toBeInTheDocument();
    });
    expect(newsAiMock.generateNewsDraftWithAI).not.toHaveBeenCalled();
    expect(newsDraftsMock.confirmNewsDraftWithEntry).not.toHaveBeenCalled();
  });
});
