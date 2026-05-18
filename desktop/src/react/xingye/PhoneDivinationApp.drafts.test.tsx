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

  it('renders draft and raw-confirm forwards fields to confirmDivinationDraft without fortune fields', async () => {
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
    /** 原样保存路径：不应该调 AI，也不应该携带运势相关字段。 */
    expect(divinationAiMock.generateDivinationReadingWithAI).not.toHaveBeenCalled();
    const rawArgs = divinationDraftsMock.confirmDivinationDraft.mock.calls[0]![2] as Record<string, unknown>;
    expect(rawArgs.fortuneScore).toBeUndefined();
    expect(rawArgs.omens).toBeUndefined();
    expect(rawArgs.method).toBeUndefined();

    /** confirm 之后 reload，再次 list 调用应返回空数组 → 草稿从 UI 消失。 */
    await waitFor(() => {
      expect(screen.queryByTestId('phone-divination-draft-d-dv-1')).not.toBeInTheDocument();
    });
  });

  it('polish path calls AI with seedNarrative and forwards reading + fortune fields to confirm', async () => {
    divinationDraftsMock.listDivinationDrafts.mockResolvedValueOnce([
      {
        id: 'd-dv-polish',
        agentQuestion: '我是不是该听那阵风？',
        content: '风从北边来，桅杆轻轻晃。',
        themeHint: '风',
        source: 'xingye-heartbeat-tool',
        createdAt: '2026-05-17T12:00:00.000Z',
      },
    ]);
    divinationAiMock.generateDivinationReadingWithAI.mockResolvedValueOnce({
      title: '北风之约',
      agentQuestion: '我究竟该不该听那阵风？',
      content: [
        '【标题】', '北风之约',
        '【行动签象】', '风从北边来，桅杆很稳。',
        '【正文】', '我看着桅杆的影子，决定再等一刻。',
        '【行动签】', '先把船头转向风。',
      ].join('\n'),
      fortuneScore: { overall: 73, career: 77, love: 82, wealth: 62 },
      omens: { good: '靠近自己确认过的事', bad: '在路口反复折返' },
      luckyDirection: '东南',
      luckyColor: '晨雾的灰蓝色',
    });
    divinationDraftsMock.confirmDivinationDraft.mockResolvedValueOnce(undefined);

    renderDivinationApp();
    await screen.findByTestId('phone-divination-draft-d-dv-polish');
    fireEvent.click(screen.getByTestId('phone-divination-draft-polish-d-dv-polish'));

    await waitFor(() => {
      expect(divinationAiMock.generateDivinationReadingWithAI).toHaveBeenCalled();
    });
    const aiArgs = divinationAiMock.generateDivinationReadingWithAI.mock.calls[0]![0] as Record<string, unknown>;
    expect((aiArgs.seedNarrative as { agentQuestion?: string }).agentQuestion).toBe('我是不是该听那阵风？');
    expect((aiArgs.seedNarrative as { content?: string }).content).toContain('风从北边来');

    await waitFor(() => {
      expect(divinationDraftsMock.confirmDivinationDraft).toHaveBeenCalled();
    });
    const confirmArgs = divinationDraftsMock.confirmDivinationDraft.mock.calls[0]![2] as Record<string, unknown>;
    /** AI 产物覆盖了 agentQuestion / content，并带上运势字段。 */
    expect(confirmArgs.agentQuestion).toBe('我究竟该不该听那阵风？');
    expect(String(confirmArgs.content)).toMatch(/【正文】/);
    expect(confirmArgs.title).toBe('北风之约');
    expect(confirmArgs.method).toBeTruthy();
    expect(confirmArgs.fortuneScore).toEqual({ overall: 73, career: 77, love: 82, wealth: 62 });
    expect(confirmArgs.omens).toEqual({ good: '靠近自己确认过的事', bad: '在路口反复折返' });
    expect(confirmArgs.luckyDirection).toBe('东南');
    expect(confirmArgs.luckyColor).toBe('晨雾的灰蓝色');

    await waitFor(() => {
      expect(screen.queryByTestId('phone-divination-draft-d-dv-polish')).not.toBeInTheDocument();
    });
  });

  it('polish surfaces AI errors and keeps the draft visible', async () => {
    divinationDraftsMock.listDivinationDrafts.mockResolvedValueOnce([
      {
        id: 'd-dv-pe',
        agentQuestion: '我该不该等？',
        content: '心里浮出一片空地。',
        source: 'xingye-heartbeat-tool',
        createdAt: '2026-05-17T12:00:00.000Z',
      },
    ]);
    divinationAiMock.generateDivinationReadingWithAI.mockRejectedValueOnce(new Error('占卜生成失败：utility boom'));

    renderDivinationApp();
    await screen.findByTestId('phone-divination-draft-d-dv-pe');
    fireEvent.click(screen.getByTestId('phone-divination-draft-polish-d-dv-pe'));

    await waitFor(() => {
      expect(screen.getByText(/占卜生成失败：utility boom/)).toBeInTheDocument();
    });
    /** 失败后草稿仍在；不应该调 confirm。 */
    expect(screen.getByTestId('phone-divination-draft-d-dv-pe')).toBeInTheDocument();
    expect(divinationDraftsMock.confirmDivinationDraft).not.toHaveBeenCalled();
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
