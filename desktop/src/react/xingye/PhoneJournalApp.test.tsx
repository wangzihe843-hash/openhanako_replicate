/**
 * @vitest-environment jsdom
 */

import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
const imageMock = vi.hoisted(() => ({
  renderJournalImagePages: vi.fn(),
  downloadJournalImagePage: vi.fn(),
}));

vi.mock('./xingye-journal-store', () => journalStoreMock);
vi.mock('./xingye-journal-ai', () => journalAiMock);
vi.mock('./xingye-profile-store', () => profileMock);
vi.mock('./xingye-app-history-state', () => historyStateMock);
vi.mock('./xingye-journal-image', () => imageMock);

import { PhoneJournalApp } from './PhoneJournalApp';
import { useStore } from '../stores';

const originalCreateObjectURL = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
const originalRevokeObjectURL = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');

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
  imageMock.renderJournalImagePages.mockReset();
  imageMock.downloadJournalImagePage.mockReset();
  imageMock.renderJournalImagePages.mockResolvedValue([new Blob(['png'], { type: 'image/png' })]);
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:journal-preview') });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
});

describe('PhoneJournalApp · confirmed export', () => {
  it('keeps the selected journal visible and reports a failed delete', async () => {
    journalStoreMock.listJournalEntries.mockResolvedValue([{
      id: 'entry-delete', dayKey: '2026-05-17', title: '保留的日记', body: '不能丢失',
      createdAt: '2026-05-17T12:30:00.000Z',
    }]);
    journalStoreMock.deleteJournalEntry.mockRejectedValue(new Error('storage denied'));
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    try {
      renderJournalApp();
      fireEvent.click(await screen.findByText('保留的日记'));
      fireEvent.click(screen.getByRole('button', { name: '删除这条日记' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('删除失败：storage denied');
      expect(screen.getByText('不能丢失')).toBeInTheDocument();
    } finally { confirm.mockRestore(); }
  });

  it('releases already-created image URLs if a later page URL fails', async () => {
    journalStoreMock.listJournalEntries.mockResolvedValue([{
      id: 'from-draft-png', dayKey: '2026-05-17', title: 'PNG 日记', body: '原文',
      createdAt: '2026-05-17T12:30:00.000Z',
    }]);
    imageMock.renderJournalImagePages.mockResolvedValue([
      new Blob(['one'], { type: 'image/png' }), new Blob(['two'], { type: 'image/png' }),
    ]);
    const createUrl = vi.fn().mockReturnValueOnce('blob:first').mockImplementationOnce(() => { throw new Error('URL allocation failed'); });
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createUrl });
    renderJournalApp();
    fireEvent.click(await screen.findByText('PNG 日记'));
    fireEvent.click(screen.getByTestId('phone-journal-export-preview-from-draft-png'));
    fireEvent.click(screen.getByTestId('phone-journal-export-png-preview'));
    expect(await screen.findByRole('alert')).toHaveTextContent('URL allocation failed');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:first');
    expect(screen.queryByTestId('phone-journal-image-preview')).not.toBeInTheDocument();
  });

  it('does not allocate preview URLs after the journal closes during rendering', async () => {
    journalStoreMock.listJournalEntries.mockResolvedValue([{
      id: 'from-draft-png', dayKey: '2026-05-17', title: 'PNG 日记', body: '原文',
      createdAt: '2026-05-17T12:30:00.000Z',
    }]);
    let finishRender!: (blobs: Blob[]) => void;
    imageMock.renderJournalImagePages.mockImplementation(() => new Promise(resolve => { finishRender = resolve; }));
    const view = renderJournalApp();
    fireEvent.click(await screen.findByText('PNG 日记'));
    fireEvent.click(screen.getByTestId('phone-journal-export-preview-from-draft-png'));
    fireEvent.click(screen.getByTestId('phone-journal-export-png-preview'));
    expect(imageMock.renderJournalImagePages).toHaveBeenCalled();
    view.unmount();
    await act(async () => { finishRender([new Blob(['png'], { type: 'image/png' })]); });
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('shows a PNG save error without dismissing the preview', async () => {
    journalStoreMock.listJournalEntries.mockResolvedValue([{
      id: 'from-draft-png', dayKey: '2026-05-17', title: 'PNG 日记', body: '原文',
      createdAt: '2026-05-17T12:30:00.000Z',
    }]);
    imageMock.downloadJournalImagePage.mockImplementation(() => { throw new Error('Download blocked'); });
    renderJournalApp();
    fireEvent.click(await screen.findByText('PNG 日记'));
    fireEvent.click(screen.getByTestId('phone-journal-export-preview-from-draft-png'));
    fireEvent.click(screen.getByTestId('phone-journal-export-png-preview'));
    await screen.findByAltText('日记长图第 1 页，共 1 页');
    fireEvent.click(screen.getByRole('button', { name: '保存 PNG 第 1 页' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Download blocked');
    expect(screen.getByTestId('phone-journal-image-preview')).toBeInTheDocument();
  });

  it('previews and saves PNG pages from the same confirmed snapshot without editing or publishing', async () => {
    journalStoreMock.listJournalEntries.mockResolvedValue([{
      id: 'from-draft-png', dayKey: '2026-05-17', title: 'PNG 日记', body: '原文和 ![图](missing.png)',
      createdAt: '2026-05-17T12:30:00.000Z',
    }]);
    renderJournalApp();
    fireEvent.click(await screen.findByText('PNG 日记'));
    fireEvent.click(screen.getByTestId('phone-journal-export-preview-from-draft-png'));
    fireEvent.click(screen.getByTestId('phone-journal-export-png-preview'));
    const image = await screen.findByAltText('日记长图第 1 页，共 1 页');
    expect(image).toHaveAttribute('src', 'blob:journal-preview');
    const snapshot = imageMock.renderJournalImagePages.mock.calls[0][0];
    expect(snapshot.entry.body).toBe('原文和 ![图](missing.png)');
    fireEvent.click(screen.getByRole('button', { name: '保存 PNG 第 1 页' }));
    expect(imageMock.downloadJournalImagePage).toHaveBeenCalledWith(expect.any(Blob), snapshot, 0, 1);
    expect(journalStoreMock.appendJournalEntry).not.toHaveBeenCalled();
    expect(journalStoreMock.confirmJournalDraft).not.toHaveBeenCalled();
  });

  it('offers preview only for a confirmed journal entry, never an initialized entry', async () => {
    journalStoreMock.listJournalEntries.mockResolvedValue([
      {
        id: 'from-draft-d-1', dayKey: '2026-05-17', title: '确认页', body: '原样正文。',
        createdAt: '2026-05-17T12:30:00.000Z',
      },
      {
        id: 'journal-init-1', dayKey: '2026-05-16', title: '初始化页', body: '未逐篇确认。',
        createdAt: '2026-05-16T12:30:00.000Z',
      },
    ]);

    renderJournalApp();
    fireEvent.click(await screen.findByText('初始化页'));
    expect(screen.queryByText('预览并导出')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '返回列表' }));

    fireEvent.click(screen.getByText('确认页'));
    fireEvent.click(screen.getByTestId('phone-journal-export-preview-from-draft-d-1'));
    const preview = screen.getByTestId('phone-journal-export-preview');
    expect(preview).toHaveTextContent('原样正文。');
    expect(screen.getByTestId('phone-journal-export-json')).toBeInTheDocument();
    expect(screen.getByTestId('phone-journal-export-html')).toBeInTheDocument();
    expect(journalStoreMock.appendJournalEntry).not.toHaveBeenCalled();
    expect(journalStoreMock.confirmJournalDraft).not.toHaveBeenCalled();
    expect(journalAiMock.generateJournalDraftWithAI).not.toHaveBeenCalled();
  });

  it('does not expose the previous owner journal while the next owner is loading', async () => {
    const oldEntry = {
      id: 'from-draft-old', dayKey: '2026-05-17', title: '旧角色日记', body: '旧角色私有正文。',
      createdAt: '2026-05-17T12:30:00.000Z',
    };
    journalStoreMock.listJournalEntries.mockImplementation((id: string) =>
      id === 'linwu' ? Promise.resolve([oldEntry]) : new Promise(() => {}),
    );
    const view = renderJournalApp();
    fireEvent.click(await screen.findByText('旧角色日记'));
    const nextAgent = { ...agent, id: 'new-agent', name: '新角色' };
    view.rerender(<PhoneJournalApp ownerAgent={nextAgent} displayName="新角色" onBack={vi.fn()} />);
    expect(screen.queryByTestId('phone-journal-export-preview-from-draft-old')).not.toBeInTheDocument();
    expect(screen.queryByText('旧角色私有正文。')).not.toBeInTheDocument();
    expect(screen.queryByText('旧角色日记')).not.toBeInTheDocument();
  });
});

afterEach(() => {
  cleanup();
  if (originalCreateObjectURL) Object.defineProperty(URL, 'createObjectURL', originalCreateObjectURL);
  else Reflect.deleteProperty(URL, 'createObjectURL');
  if (originalRevokeObjectURL) Object.defineProperty(URL, 'revokeObjectURL', originalRevokeObjectURL);
  else Reflect.deleteProperty(URL, 'revokeObjectURL');
});

describe('PhoneJournalApp · pending draft section', () => {
  it('does not write a previous owner confirmation into the next owner journal', async () => {
    const oldDraft = {
      id: 'old-draft', dayKey: '2026-05-17', title: 'A 草稿', body: 'A 正文',
      createdAt: '2026-05-17T12:00:00.000Z', source: 'xingye-heartbeat-tool',
    };
    const nextEntry = {
      id: 'next-entry', dayKey: '2026-05-18', title: 'B 已有日记', body: 'B 正文',
      createdAt: '2026-05-18T12:00:00.000Z',
    };
    let finishConfirm!: (entry: typeof nextEntry) => void;
    journalStoreMock.listJournalEntries.mockImplementation((id: string) => Promise.resolve(id === 'linwu' ? [] : [nextEntry]));
    journalStoreMock.listJournalDrafts.mockImplementation((id: string) => Promise.resolve(id === 'linwu' ? [oldDraft] : []));
    journalStoreMock.confirmJournalDraft.mockImplementation(() => new Promise(resolve => { finishConfirm = resolve; }));
    const view = renderJournalApp();
    fireEvent.click(await screen.findByTestId('phone-journal-draft-confirm-old-draft'));
    const nextAgent = { ...agent, id: 'next-agent', name: '新角色' };
    view.rerender(<PhoneJournalApp ownerAgent={nextAgent} displayName="新角色" onBack={vi.fn()} />);
    await screen.findByText('B 已有日记');
    await act(async () => {
      finishConfirm({ ...nextEntry, id: 'old-confirmed', title: 'A 已确认日记' });
    });
    expect(journalStoreMock.confirmJournalDraft).toHaveBeenCalledWith('linwu', 'old-draft', expect.any(Object));
    expect(screen.getByText('B 已有日记')).toBeInTheDocument();
    expect(screen.queryByText('A 已确认日记')).not.toBeInTheDocument();
  });

  it('rejects an old confirmation even after switching A to B and back to A', async () => {
    const oldDraft = {
      id: 'old-draft', dayKey: '2026-05-17', title: 'A 草稿', body: 'A 正文',
      createdAt: '2026-05-17T12:00:00.000Z', source: 'xingye-heartbeat-tool',
    };
    const freshA = {
      id: 'fresh-a', dayKey: '2026-05-18', title: 'A 新列表', body: '新正文',
      createdAt: '2026-05-18T12:00:00.000Z',
    };
    let oldLoads = 0;
    journalStoreMock.listJournalEntries.mockImplementation((id: string) => Promise.resolve(
      id === 'linwu' && ++oldLoads > 1 ? [freshA] : [],
    ));
    let oldDraftLoads = 0;
    journalStoreMock.listJournalDrafts.mockImplementation((id: string) => Promise.resolve(
      id === 'linwu' && ++oldDraftLoads === 1 ? [oldDraft] : [],
    ));
    let finishConfirm!: (entry: typeof freshA) => void;
    journalStoreMock.confirmJournalDraft.mockImplementation(() => new Promise(resolve => { finishConfirm = resolve; }));
    const view = renderJournalApp();
    fireEvent.click(await screen.findByTestId('phone-journal-draft-confirm-old-draft'));
    const nextAgent = { ...agent, id: 'next-agent', name: '新角色' };
    view.rerender(<PhoneJournalApp ownerAgent={nextAgent} displayName="新角色" onBack={vi.fn()} />);
    view.rerender(<PhoneJournalApp ownerAgent={agent} displayName="林雾" onBack={vi.fn()} />);
    await screen.findByText('A 新列表');
    await act(async () => {
      finishConfirm({ ...freshA, id: 'old-confirmed', title: 'A 旧确认' });
    });
    expect(screen.getByText('A 新列表')).toBeInTheDocument();
    expect(screen.queryByText('A 旧确认')).not.toBeInTheDocument();
  });

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
