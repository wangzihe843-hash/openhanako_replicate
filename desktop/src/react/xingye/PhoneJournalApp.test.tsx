/**
 * @vitest-environment jsdom
 */

import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../types';

const journalStoreMock = vi.hoisted(() => ({
  appendJournalEntry: vi.fn(),
  confirmJournalDraft: vi.fn(),
  deleteJournalEntry: vi.fn(),
  discardJournalDraft: vi.fn(),
  listJournalDrafts: vi.fn(),
  listJournalEntries: vi.fn(),
}));

const journalAiMock = vi.hoisted(() => ({
  generateJournalDraftWithAI: vi.fn(),
  generateJournalHistoryWithAI: vi.fn(),
}));

const profileMock = vi.hoisted(() => ({
  useXingyeRoleProfile: vi.fn(() => null),
}));

const historyStateMock = vi.hoisted(() => ({
  loadHistoryState: vi.fn(),
  saveHistoryState: vi.fn(),
}));

vi.mock('./xingye-journal-store', () => journalStoreMock);
vi.mock('./xingye-journal-ai', () => journalAiMock);
vi.mock('./xingye-profile-store', () => profileMock);
vi.mock('./xingye-app-history-state', () => historyStateMock);

import { PhoneJournalApp } from './PhoneJournalApp';
import { useStore } from '../stores';

const agent: Agent = {
  id: 'linwu',
  name: '林雾',
  yuan: 'hanako',
  isPrimary: false,
  hasAvatar: false,
};

function renderJournalApp() {
  return render(
    <PhoneJournalApp
      ownerAgent={agent}
      displayName="林雾"
      onBack={vi.fn()}
    />,
  );
}

beforeEach(() => {
  for (const fn of Object.values(journalStoreMock)) fn.mockReset();
  journalStoreMock.listJournalEntries.mockResolvedValue([]);
  journalStoreMock.listJournalDrafts.mockResolvedValue([]);
  journalStoreMock.appendJournalEntry.mockResolvedValue({
    id: 'entry-1',
    dayKey: '2026-05-17',
    title: 'manual',
    body: 'manual body',
    createdAt: '2026-05-17T10:00:00.000Z',
  });
  journalAiMock.generateJournalDraftWithAI.mockReset();
  journalAiMock.generateJournalHistoryWithAI.mockReset();
  /**
   * 默认让历史初始化跑不起来——绝大多数已有用例（pending draft / share-to-chat 等）
   * 都不依赖 init，pretending "已初始化过"最简单。需要测 init 的用例自己改 mock。
   */
  historyStateMock.loadHistoryState.mockReset();
  historyStateMock.saveHistoryState.mockReset();
  historyStateMock.loadHistoryState.mockResolvedValue({
    version: 1,
    initializedAt: '2026-05-01T00:00:00.000Z',
  });
  historyStateMock.saveHistoryState.mockResolvedValue({ version: 1 });
});

afterEach(() => {
  cleanup();
});

describe('PhoneJournalApp · pending draft section', () => {
  it('does not render the draft section when there are no pending drafts', async () => {
    renderJournalApp();
    await waitFor(() => {
      expect(journalStoreMock.listJournalDrafts).toHaveBeenCalledWith('linwu');
    });
    expect(screen.queryByTestId('phone-journal-pending-drafts')).not.toBeInTheDocument();
    /** Empty state shows because BOTH lists are empty. */
    expect(await screen.findByTestId('phone-journal-empty')).toBeInTheDocument();
  });

  it('renders a draft from listJournalDrafts and confirm moves it into entries', async () => {
    journalStoreMock.listJournalDrafts.mockResolvedValueOnce([
      {
        id: 'd-1',
        dayKey: '2026-05-17',
        title: '小灯塔',
        body: '海风把灯影吹得有点歪。',
        createdAt: '2026-05-17T12:00:00.000Z',
        source: 'xingye-heartbeat-tool',
        reason: '巡检里看到最近聊天反复提灯塔',
      },
    ]);
    journalStoreMock.confirmJournalDraft.mockResolvedValueOnce({
      id: 'entry-confirmed',
      dayKey: '2026-05-17',
      title: '小灯塔',
      body: '海风把灯影吹得有点歪，但我想留下这一句。',
      createdAt: '2026-05-17T12:30:00.000Z',
    });

    renderJournalApp();

    const draftCard = await screen.findByTestId('phone-journal-draft-d-1');
    /** Reason is visible — user can see WHY this draft was proposed. */
    expect(within(draftCard).getByText(/巡检里看到最近聊天反复提灯塔/)).toBeInTheDocument();

    /** User edits body in place before confirming. */
    const bodyField = screen.getByTestId('phone-journal-draft-body-d-1');
    fireEvent.change(bodyField, {
      target: { value: '海风把灯影吹得有点歪，但我想留下这一句。' },
    });

    fireEvent.click(screen.getByTestId('phone-journal-draft-confirm-d-1'));

    await waitFor(() => {
      expect(journalStoreMock.confirmJournalDraft).toHaveBeenCalledWith(
        'linwu',
        'd-1',
        expect.objectContaining({
          body: '海风把灯影吹得有点歪，但我想留下这一句。',
          dayKey: '2026-05-17',
          title: '小灯塔',
        }),
      );
    });

    /** Draft is removed from the pending list after confirm; confirmed entry appears in the entry list. */
    await waitFor(() => {
      expect(screen.queryByTestId('phone-journal-draft-d-1')).not.toBeInTheDocument();
    });
    expect(screen.getByText('小灯塔')).toBeInTheDocument();
  });

  it('discard calls discardJournalDraft and removes the draft from the section', async () => {
    journalStoreMock.listJournalDrafts.mockResolvedValueOnce([
      {
        id: 'd-2',
        dayKey: '2026-05-17',
        title: 'maybe',
        body: 'not sure if i want this in my journal',
        createdAt: '2026-05-17T12:00:00.000Z',
        source: 'xingye-heartbeat-tool',
      },
    ]);
    journalStoreMock.discardJournalDraft.mockResolvedValueOnce(true);
    const originalConfirm = window.confirm;
    window.confirm = vi.fn(() => true);

    try {
      renderJournalApp();
      await screen.findByTestId('phone-journal-draft-d-2');
      fireEvent.click(screen.getByTestId('phone-journal-draft-discard-d-2'));

      await waitFor(() => {
        expect(journalStoreMock.discardJournalDraft).toHaveBeenCalledWith('linwu', 'd-2');
      });
      await waitFor(() => {
        expect(screen.queryByTestId('phone-journal-draft-d-2')).not.toBeInTheDocument();
      });
      /** Importantly, discard MUST NOT call appendJournalEntry (no leakage to "已生成" list). */
      expect(journalStoreMock.appendJournalEntry).not.toHaveBeenCalled();
    } finally {
      window.confirm = originalConfirm;
    }
  });

  it('inline edits to a draft persist within the page (do not call store until confirm)', async () => {
    journalStoreMock.listJournalDrafts.mockResolvedValueOnce([
      {
        id: 'd-3',
        dayKey: '2026-05-17',
        title: 'first pass',
        body: 'first body',
        createdAt: '2026-05-17T12:00:00.000Z',
        source: 'xingye-heartbeat-tool',
      },
    ]);

    renderJournalApp();
    const titleField = await screen.findByTestId('phone-journal-draft-title-d-3');
    fireEvent.change(titleField, { target: { value: '改过的标题' } });
    /** The edit lives in component state; no store call happens yet. */
    expect(journalStoreMock.confirmJournalDraft).not.toHaveBeenCalled();
    /** Reading the input back, it reflects the user's edit (lives in state, not lost). */
    expect((titleField as HTMLInputElement).value).toBe('改过的标题');
  });
});

describe('PhoneJournalApp · 去和 TA 聊聊', () => {
  beforeEach(() => {
    useStore.setState({ stagedChatQuote: null });
  });

  it('stages the selected entry into stagedChatQuote and shows the notice', async () => {
    journalStoreMock.listJournalEntries.mockResolvedValueOnce([
      {
        id: 'entry-share-1',
        dayKey: '2026-05-14',
        title: '雨夜的小灯',
        body: '海风吹得灯影歪斜。',
        mood: '安静',
        createdAt: '2026-05-14T22:00:00.000Z',
      },
    ]);

    renderJournalApp();

    fireEvent.click(await screen.findByText('雨夜的小灯'));

    const shareBtn = await screen.findByTestId(
      'phone-journal-share-to-chat-entry-share-1',
    );
    expect(useStore.getState().stagedChatQuote).toBeNull();
    fireEvent.click(shareBtn);

    const staged = useStore.getState().stagedChatQuote;
    expect(staged).toMatchObject({
      sourceKind: 'journal',
      sourceTitle: '日记 · 雨夜的小灯',
    });
    expect(staged?.text).toContain('《雨夜的小灯》');
    expect(staged?.text).toContain('心情：「安静」');
    expect(staged?.text).toContain('海风吹得灯影歪斜。');

    expect(
      screen.getByTestId('phone-journal-share-to-chat-notice-entry-share-1'),
    ).toBeInTheDocument();
  });
});

describe('PhoneJournalApp · 首次打开初始化', () => {
  it('首次打开（entries/drafts 空 + initializedAt 缺失）→ 调 generateJournalHistoryWithAI 并 append 每一条', async () => {
    historyStateMock.loadHistoryState.mockResolvedValue({ version: 1 });
    journalAiMock.generateJournalHistoryWithAI.mockResolvedValueOnce([
      { title: '雨夜', body: '一段。', mood: '安静', dayKey: '2025-03-10' },
      { title: '搬家', body: '又一段。', dayKey: '2024-11-02' },
      { title: '生日', body: '再一段。', dayKey: '2023-08-15' },
    ]);
    journalStoreMock.appendJournalEntry.mockImplementation(async (_aid, input) => ({
      id: `entry-${input.dayKey}`,
      dayKey: input.dayKey ?? '2026-05-28',
      title: input.title,
      body: input.body,
      createdAt: '2026-05-28T00:00:00.000Z',
      mood: input.mood,
    }));

    renderJournalApp();

    await waitFor(() => {
      expect(journalAiMock.generateJournalHistoryWithAI).toHaveBeenCalledTimes(1);
    });
    const callArgs = journalAiMock.generateJournalHistoryWithAI.mock.calls[0][0];
    expect(callArgs.agent.id).toBe('linwu');
    expect(callArgs.desiredCount).toBeGreaterThanOrEqual(3);
    expect(callArgs.desiredCount).toBeLessThanOrEqual(5);

    await waitFor(() => {
      expect(journalStoreMock.appendJournalEntry).toHaveBeenCalledTimes(3);
    });
    // appended in ascending dayKey order
    const appendedDayKeys = journalStoreMock.appendJournalEntry.mock.calls.map(
      (c) => c[1].dayKey,
    );
    expect(appendedDayKeys).toEqual(['2023-08-15', '2024-11-02', '2025-03-10']);

    expect(historyStateMock.saveHistoryState).toHaveBeenCalledWith(
      'linwu',
      'journal',
      expect.objectContaining({ initializedAt: expect.any(String) }),
    );
  });

  it('init 时把 dateSmudged 透传给 appendJournalEntry', async () => {
    historyStateMock.loadHistoryState.mockResolvedValue({ version: 1 });
    journalAiMock.generateJournalHistoryWithAI.mockResolvedValueOnce([
      { title: '清楚', body: '正常一条', dayKey: '2025-03-10' },
      { title: '糊了', body: '不可考的一条', dayKey: '0001-01-01', dateSmudged: true },
    ]);
    journalStoreMock.appendJournalEntry.mockImplementation(async (_aid, input) => ({
      id: `entry-${input.title}`,
      dayKey: input.dayKey ?? '2026-05-28',
      title: input.title,
      body: input.body,
      createdAt: '2026-05-28T00:00:00.000Z',
      mood: input.mood,
      dateSmudged: input.dateSmudged,
    }));

    renderJournalApp();

    await waitFor(() => {
      expect(journalStoreMock.appendJournalEntry).toHaveBeenCalledTimes(2);
    });
    const calls = journalStoreMock.appendJournalEntry.mock.calls;
    // sorted ascending → 0001 first, then 2025
    expect(calls[0][1]).toMatchObject({ title: '糊了', dateSmudged: true });
    expect(calls[1][1].title).toBe('清楚');
    expect(calls[1][1].dateSmudged).toBeUndefined();
  });
});

describe('PhoneJournalApp · dateSmudged 渲染', () => {
  it('污损条目以"墨迹模糊"分组渲染，并带 data-smudged 标记', async () => {
    journalStoreMock.listJournalEntries.mockResolvedValueOnce([
      {
        id: 'normal-1',
        dayKey: '2025-03-10',
        title: '清楚',
        body: '一段。',
        createdAt: '2025-03-10T10:00:00.000Z',
      },
      {
        id: 'smudge-1',
        dayKey: '0001-01-01',
        title: '糊了',
        body: '另一段。',
        createdAt: '2026-05-28T10:00:00.000Z',
        dateSmudged: true,
      },
    ]);

    renderJournalApp();

    const smudgedGroup = await screen.findByTestId('phone-journal-smudged-group');
    expect(within(smudgedGroup).getByText('墨迹模糊 · 年代不可考')).toBeInTheDocument();
    expect(screen.getByTestId('phone-journal-smudged-card-smudge-1')).toBeInTheDocument();

    // 正常条目不带污损标签
    expect(screen.getByText('清楚')).toBeInTheDocument();
    expect(screen.queryByTestId('phone-journal-smudged-card-normal-1')).not.toBeInTheDocument();
  });

  it('污损条目的详情页 meta 行渲染"墨迹模糊"代替日期', async () => {
    journalStoreMock.listJournalEntries.mockResolvedValueOnce([
      {
        id: 'smudge-detail',
        dayKey: '0001-01-01',
        title: '不可考',
        body: '正文。',
        createdAt: '2026-05-28T10:00:00.000Z',
        dateSmudged: true,
      },
    ]);

    renderJournalApp();

    fireEvent.click(await screen.findByText('不可考'));
    const meta = await screen.findByTestId('phone-journal-detail-smudged');
    expect(meta.textContent).toContain('墨迹模糊');
  });

  it('已经有 entries（老用户没 initializedAt marker）→ 不生成、补写 marker', async () => {
    historyStateMock.loadHistoryState.mockResolvedValue({ version: 1 });
    journalStoreMock.listJournalEntries.mockResolvedValue([
      {
        id: 'e1',
        dayKey: '2026-05-14',
        title: '先有这条',
        body: '已经有内容了，不该再 bootstrap。',
        createdAt: '2026-05-14T12:00:00.000Z',
      },
    ]);

    renderJournalApp();

    await screen.findByText('先有这条');
    await new Promise((r) => setTimeout(r, 20));
    expect(journalAiMock.generateJournalHistoryWithAI).not.toHaveBeenCalled();
    // 老用户场景：发现有内容但没 marker → 补写 marker，防止下次再误触发。
    expect(historyStateMock.saveHistoryState).toHaveBeenCalledWith(
      'linwu',
      'journal',
      expect.objectContaining({ initializedAt: expect.any(String) }),
    );
  });

  it('已经初始化过（state.initializedAt 存在）→ 跳过', async () => {
    // 默认 mock 就是 initializedAt 存在
    renderJournalApp();

    await waitFor(() => {
      expect(journalStoreMock.listJournalEntries).toHaveBeenCalledWith('linwu');
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(journalAiMock.generateJournalHistoryWithAI).not.toHaveBeenCalled();
  });

  it('已经有 pending drafts（agent 心跳已经写了） → 跳过', async () => {
    historyStateMock.loadHistoryState.mockResolvedValue({ version: 1 });
    journalStoreMock.listJournalDrafts.mockResolvedValue([
      {
        id: 'd-x',
        dayKey: '2026-05-17',
        title: '心跳已经垫了一条',
        body: '某条内容',
        createdAt: '2026-05-17T12:00:00.000Z',
        source: 'xingye-heartbeat-tool',
      },
    ]);

    renderJournalApp();

    await screen.findByTestId('phone-journal-draft-d-x');
    await new Promise((r) => setTimeout(r, 20));
    expect(journalAiMock.generateJournalHistoryWithAI).not.toHaveBeenCalled();
  });

  it('AI 抛错时显示 init-error，且不写 initializedAt（下次重试）', async () => {
    historyStateMock.loadHistoryState.mockResolvedValue({ version: 1 });
    journalAiMock.generateJournalHistoryWithAI.mockRejectedValueOnce(new Error('模型调用失败'));

    renderJournalApp();

    const errorNode = await screen.findByTestId('phone-journal-init-error');
    expect(errorNode.textContent).toContain('模型调用失败');
    expect(journalStoreMock.appendJournalEntry).not.toHaveBeenCalled();
    expect(historyStateMock.saveHistoryState).not.toHaveBeenCalled();
  });
});
