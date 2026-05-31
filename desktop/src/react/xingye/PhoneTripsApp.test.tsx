/**
 * @vitest-environment jsdom
 */

import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../types';

/**
 * 只替换 I/O / mutation 函数，保留 normalizeTripModeKey 等纯工具的真实实现
 * （PhoneTripsApp 的 modeIcon 会调用它）。
 */
const tripsStoreMock = vi.hoisted(() => ({
  listTripEntries: vi.fn(),
  listTripDrafts: vi.fn(),
  appendTripEntry: vi.fn(),
  appendTripDraft: vi.fn(),
  deleteTripEntry: vi.fn(),
  confirmTripDraft: vi.fn(),
  discardTripDraft: vi.fn(),
}));

const tripsAiMock = vi.hoisted(() => ({
  generateTripsHistoryWithAI: vi.fn(),
  generateTripsUpdateWithAI: vi.fn(),
}));

const historyStateMock = vi.hoisted(() => ({
  loadHistoryState: vi.fn(),
  saveHistoryState: vi.fn(),
}));

vi.mock('./xingye-trips-store', async (importActual) => {
  const actual = await importActual<typeof import('./xingye-trips-store')>();
  return { ...actual, ...tripsStoreMock };
});
vi.mock('./xingye-trips-ai', () => tripsAiMock);
vi.mock('./xingye-app-history-state', () => historyStateMock);

import { PhoneTripsApp } from './PhoneTripsApp';

const agent: Agent = {
  id: 'linwu',
  name: '林雾',
  yuan: 'hanako',
  isPrimary: false,
  hasAvatar: false,
};

function renderTripsApp() {
  return render(
    <PhoneTripsApp
      ownerAgent={agent}
      ownerProfile={null}
      displayName="林雾"
      onBack={vi.fn()}
    />,
  );
}

function makeDraft(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'd-1',
    serial: '北门 · 丙申 0003',
    when: '停电夜',
    chapter: '童年 · 北门',
    mode: 'walk',
    modeLabel: '徒步 · 岑姨背着',
    cls: '徒步',
    from: { name: '北门诊所', meta: '后院 · 第三阶' },
    to: { name: '岑姨家', meta: '西厢' },
    duration: '一时辰',
    distance: '一里',
    pass: '—',
    stampText: '到家',
    noteFrom: '第三阶的青苔没人铲。',
    noteTo: '黄铜纽扣收在铁皮盒里。',
    mood: '岑姨把我背回来的。',
    moodTags: ['停电'],
    route: [],
    source: 'xingye-heartbeat-tool',
    reason: '巡检里看到最近聊天反复提那条山道',
    createdAt: '2026-05-17T12:00:00.000Z',
    ...over,
  };
}

beforeEach(() => {
  for (const fn of Object.values(tripsStoreMock)) fn.mockReset();
  tripsStoreMock.listTripEntries.mockResolvedValue([]);
  tripsStoreMock.listTripDrafts.mockResolvedValue([]);
  tripsAiMock.generateTripsHistoryWithAI.mockReset();
  tripsAiMock.generateTripsUpdateWithAI.mockReset();
  historyStateMock.loadHistoryState.mockReset();
  historyStateMock.saveHistoryState.mockReset();
  /** 默认「已初始化过」，让 init bootstrap 不干扰草稿区用例。 */
  historyStateMock.loadHistoryState.mockResolvedValue({
    version: 1,
    initializedAt: '2026-05-01T00:00:00.000Z',
  });
  historyStateMock.saveHistoryState.mockResolvedValue({ version: 1 });
});

afterEach(() => {
  cleanup();
});

describe('PhoneTripsApp · 待确认草稿区', () => {
  it('没有待确认草稿时不渲染草稿区', async () => {
    renderTripsApp();
    await waitFor(() => {
      expect(tripsStoreMock.listTripDrafts).toHaveBeenCalledWith('linwu');
    });
    expect(screen.queryByTestId('phone-trips-pending-drafts')).not.toBeInTheDocument();
    expect(await screen.findByTestId('phone-trips-empty')).toBeInTheDocument();
  });

  it('渲染 listTripDrafts 的草稿；确认调用 confirmTripDraft 并把草稿移出待确认区', async () => {
    tripsStoreMock.listTripDrafts.mockResolvedValueOnce([makeDraft()]);
    tripsStoreMock.confirmTripDraft.mockResolvedValueOnce({
      id: 'from-draft-d-1',
      serial: '北门 · 丙申 0003',
      when: '停电夜',
      chapter: '童年 · 北门',
      mode: 'walk',
      modeLabel: '徒步 · 岑姨背着',
      cls: '徒步',
      from: { name: '北门诊所' },
      to: { name: '岑姨家' },
      duration: '一时辰',
      distance: '一里',
      pass: '—',
      stampText: '到家',
      noteFrom: '',
      noteTo: '',
      mood: '',
      moodTags: [],
      route: [],
      createdAt: '2026-05-17T12:30:00.000Z',
    });

    renderTripsApp();

    const draftCard = await screen.findByTestId('phone-trips-draft-d-1');
    /** reason 可见——用户能看到为什么提议这条草稿。 */
    expect(within(draftCard).getByText(/反复提那条山道/)).toBeInTheDocument();
    expect(within(draftCard).getByText('北门诊所')).toBeInTheDocument();
    expect(within(draftCard).getByText('岑姨家')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('phone-trips-draft-confirm-d-1'));

    await waitFor(() => {
      expect(tripsStoreMock.confirmTripDraft).toHaveBeenCalledWith('linwu', 'd-1');
    });
    await waitFor(() => {
      expect(screen.queryByTestId('phone-trips-draft-d-1')).not.toBeInTheDocument();
    });
  });

  it('丢弃调用 discardTripDraft 并把草稿移出待确认区（不写 entries）', async () => {
    tripsStoreMock.listTripDrafts.mockResolvedValueOnce([makeDraft({ id: 'd-2' })]);
    tripsStoreMock.discardTripDraft.mockResolvedValueOnce(true);
    const originalConfirm = window.confirm;
    window.confirm = vi.fn(() => true);

    try {
      renderTripsApp();
      await screen.findByTestId('phone-trips-draft-d-2');
      fireEvent.click(screen.getByTestId('phone-trips-draft-discard-d-2'));

      await waitFor(() => {
        expect(tripsStoreMock.discardTripDraft).toHaveBeenCalledWith('linwu', 'd-2');
      });
      await waitFor(() => {
        expect(screen.queryByTestId('phone-trips-draft-d-2')).not.toBeInTheDocument();
      });
      /** 丢弃绝不能落 entries。 */
      expect(tripsStoreMock.appendTripEntry).not.toHaveBeenCalled();
      expect(tripsStoreMock.confirmTripDraft).not.toHaveBeenCalled();
    } finally {
      window.confirm = originalConfirm;
    }
  });

  it('有待确认草稿时跳过首次打开初始化（不调 generateTripsHistoryWithAI）', async () => {
    historyStateMock.loadHistoryState.mockResolvedValue({ version: 1 });
    tripsStoreMock.listTripDrafts.mockResolvedValue([makeDraft({ id: 'd-x' })]);

    renderTripsApp();

    await screen.findByTestId('phone-trips-draft-d-x');
    await new Promise((r) => setTimeout(r, 20));
    expect(tripsAiMock.generateTripsHistoryWithAI).not.toHaveBeenCalled();
  });
});

describe('PhoneTripsApp · 手动 AI 更新（整理新行程）', () => {
  it('点「整理新行程」→ 调 generateTripsUpdateWithAI → 把结果写成待确认草稿', async () => {
    const generated = {
      from: { name: '红盐码头' },
      to: { name: '城西医馆' },
      chapter: '行医 · 山道',
      mode: 'boat',
      modeLabel: '旧摆渡',
      cls: '摆渡',
      serial: '',
      when: '',
      duration: '',
      distance: '',
      pass: '—',
      stampText: '',
      noteFrom: '',
      noteTo: '',
      mood: '',
      moodTags: [],
      route: [],
    };
    tripsAiMock.generateTripsUpdateWithAI.mockResolvedValueOnce([generated]);
    tripsStoreMock.appendTripDraft.mockResolvedValueOnce({
      id: 'nd-1',
      ...generated,
      source: 'xingye-trips-manual',
      createdAt: '2026-05-31T00:00:00.000Z',
    });

    renderTripsApp();
    const btn = await screen.findByTestId('phone-trips-manual-update');
    fireEvent.click(btn);

    await waitFor(() => {
      expect(tripsAiMock.generateTripsUpdateWithAI).toHaveBeenCalledWith(
        expect.objectContaining({ agent: expect.objectContaining({ id: 'linwu' }) }),
      );
    });
    await waitFor(() => {
      expect(tripsStoreMock.appendTripDraft).toHaveBeenCalledWith(
        'linwu',
        expect.objectContaining({ source: 'xingye-trips-manual', from: { name: '红盐码头' } }),
      );
    });
    /** 不能直接落「已走过的路」——manual 走草稿区。 */
    expect(tripsStoreMock.appendTripEntry).not.toHaveBeenCalled();
    expect(await screen.findByText(/已整理 1 段新行程草稿/)).toBeInTheDocument();
  });

  it('整理失败时显示错误、不写任何草稿', async () => {
    tripsAiMock.generateTripsUpdateWithAI.mockRejectedValueOnce(new Error('模型调用失败'));

    renderTripsApp();
    fireEvent.click(await screen.findByTestId('phone-trips-manual-update'));

    expect(await screen.findByText(/整理失败：模型调用失败/)).toBeInTheDocument();
    expect(tripsStoreMock.appendTripDraft).not.toHaveBeenCalled();
  });
});
