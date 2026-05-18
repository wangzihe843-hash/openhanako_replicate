/**
 * @vitest-environment jsdom
 *
 * 覆盖「心跳巡检 → 待确认占卜（心象）草稿」的 UI 链路。
 * 心象固定走 oracle_generic method；正式占卜走另一条路径，不在本测试覆盖。
 */

import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../types';

const appEntryStoreMock = vi.hoisted(() => ({
  appendDivinationEntry: vi.fn(),
  deleteDivinationEntry: vi.fn(),
  getDivinationEntryAgentTopic: vi.fn(() => null),
  getDivinationEntryUserThemeHint: vi.fn(() => null),
  loadDivinationEntries: vi.fn().mockResolvedValue([]),
}));

const divinationDraftsMock = vi.hoisted(() => ({
  confirmDivinationDraft: vi.fn(),
  discardDivinationDraft: vi.fn(),
  listDivinationDrafts: vi.fn().mockResolvedValue([]),
}));

const divinationAiMock = vi.hoisted(() => ({
  generateDivinationReadingWithAI: vi.fn(),
}));

const resolverCtxMock = vi.hoisted(() => ({
  buildDivinationResolverContext: vi.fn().mockResolvedValue({
    agentLike: { name: 'Test', backgroundSummary: '占卜测试桩。' },
    contextText: '',
    contextLength: 100,
    contextSources: ['xingye.profile.json'],
    loreSkippedDisabledCount: 0,
    enabledLoreTitlesInCorpus: [],
    profileOnlyNoEnabledLore: true,
  }),
}));

vi.mock('./xingye-app-entry-store', () => appEntryStoreMock);
vi.mock('./xingye-divination-drafts', () => divinationDraftsMock);
vi.mock('./xingye-divination-ai', () => divinationAiMock);
vi.mock('./xingye-divination-resolver-context', () => resolverCtxMock);

import { PhoneDivinationApp } from './PhoneDivinationApp';

const agent: Agent = {
  id: 'linwu',
  name: '林雾',
  yuan: 'hanako',
  isPrimary: false,
  hasAvatar: false,
};

function renderDivinationApp() {
  return render(
    <PhoneDivinationApp
      ownerAgent={agent}
      ownerProfile={null}
      displayName="林雾"
      onBack={vi.fn()}
    />,
  );
}

beforeEach(() => {
  for (const fn of Object.values(appEntryStoreMock)) {
    if (typeof fn === 'function' && 'mockReset' in fn) (fn as ReturnType<typeof vi.fn>).mockReset();
  }
  for (const fn of Object.values(divinationDraftsMock)) {
    if (typeof fn === 'function' && 'mockReset' in fn) (fn as ReturnType<typeof vi.fn>).mockReset();
  }
  appEntryStoreMock.loadDivinationEntries.mockResolvedValue([]);
  appEntryStoreMock.getDivinationEntryAgentTopic.mockReturnValue(null);
  appEntryStoreMock.getDivinationEntryUserThemeHint.mockReturnValue(null);
  divinationDraftsMock.listDivinationDrafts.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
});

describe('PhoneDivinationApp · pending draft section', () => {
  it('does not render the draft section when there are no pending drafts', async () => {
    renderDivinationApp();
    await waitFor(() => {
      expect(divinationDraftsMock.listDivinationDrafts).toHaveBeenCalledWith('linwu');
    });
    expect(screen.queryByTestId('phone-divination-pending-drafts')).not.toBeInTheDocument();
  });

  it('renders draft and confirm forwards fields to confirmDivinationDraft', async () => {
    divinationDraftsMock.listDivinationDrafts.mockResolvedValueOnce([
      {
        id: 'd-dv-1',
        agentQuestion: '今天的我应该听哪一面？',
        content: '风从北方来，桅杆轻轻晃。\n答案在你已经知道的那一面。',
        themeHint: '风',
        reason: '巡检里看到角色今天反复在做选择',
        source: 'xingye-heartbeat-tool',
        createdAt: '2026-05-17T12:00:00.000Z',
      },
    ]);
    divinationDraftsMock.confirmDivinationDraft.mockResolvedValueOnce(undefined);

    renderDivinationApp();

    const draftCard = await screen.findByTestId('phone-divination-draft-d-dv-1');
    expect(within(draftCard).getByText(/巡检里看到角色今天反复在做选择/)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('phone-divination-draft-confirm-d-dv-1'));

    await waitFor(() => {
      expect(divinationDraftsMock.confirmDivinationDraft).toHaveBeenCalledWith(
        'linwu',
        'd-dv-1',
        expect.objectContaining({
          agentQuestion: '今天的我应该听哪一面？',
          content: expect.stringContaining('风从北方来'),
          themeHint: '风',
        }),
      );
    });

    /** confirm 之后 reload，再次 list 调用应返回空数组 → 草稿从 UI 消失。 */
    await waitFor(() => {
      expect(screen.queryByTestId('phone-divination-draft-d-dv-1')).not.toBeInTheDocument();
    });
  });

  it('discard calls discardDivinationDraft and does not call confirm', async () => {
    divinationDraftsMock.listDivinationDrafts.mockResolvedValueOnce([
      {
        id: 'd-dv-2',
        agentQuestion: '草稿问题',
        content: '草稿内容',
        source: 'xingye-heartbeat-tool',
        createdAt: '2026-05-17T12:00:00.000Z',
      },
    ]);
    divinationDraftsMock.discardDivinationDraft.mockResolvedValueOnce(true);
    vi.spyOn(window, 'confirm').mockReturnValueOnce(true);

    renderDivinationApp();
    await screen.findByTestId('phone-divination-draft-d-dv-2');
    fireEvent.click(screen.getByTestId('phone-divination-draft-discard-d-dv-2'));

    await waitFor(() => {
      expect(divinationDraftsMock.discardDivinationDraft).toHaveBeenCalledWith('linwu', 'd-dv-2');
    });
    await waitFor(() => {
      expect(screen.queryByTestId('phone-divination-draft-d-dv-2')).not.toBeInTheDocument();
    });
    expect(divinationDraftsMock.confirmDivinationDraft).not.toHaveBeenCalled();
    expect(appEntryStoreMock.appendDivinationEntry).not.toHaveBeenCalled();
  });

  it('discard aborts when user cancels window.confirm', async () => {
    divinationDraftsMock.listDivinationDrafts.mockResolvedValueOnce([
      {
        id: 'd-dv-3',
        agentQuestion: '保留问',
        content: '保留内容',
        source: 'xingye-heartbeat-tool',
        createdAt: '2026-05-17T12:00:00.000Z',
      },
    ]);
    vi.spyOn(window, 'confirm').mockReturnValueOnce(false);

    renderDivinationApp();
    await screen.findByTestId('phone-divination-draft-d-dv-3');
    fireEvent.click(screen.getByTestId('phone-divination-draft-discard-d-dv-3'));

    expect(divinationDraftsMock.discardDivinationDraft).not.toHaveBeenCalled();
    expect(screen.getByTestId('phone-divination-draft-d-dv-3')).toBeInTheDocument();
  });
});
