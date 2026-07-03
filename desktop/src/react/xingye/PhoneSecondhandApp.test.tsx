/**
 * @vitest-environment jsdom
 */

import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../types';

const appEntryStoreMock = vi.hoisted(() => ({
  appendAppEntry: vi.fn(),
  deleteAppEntry: vi.fn(),
  listAppEntries: vi.fn(),
  updateAppEntry: vi.fn(),
}));

const secondhandDraftsMock = vi.hoisted(() => ({
  confirmSecondhandDraft: vi.fn(),
  discardSecondhandDraft: vi.fn(),
  listSecondhandDrafts: vi.fn().mockResolvedValue([]),
}));

const secondhandAiMock = vi.hoisted(() => ({
  generateSecondhandDraftWithAI: vi.fn(),
  generateSecondhandPolishWithAI: vi.fn(),
}));

vi.mock('./xingye-app-entry-store', () => appEntryStoreMock);
vi.mock('./xingye-secondhand-drafts', () => secondhandDraftsMock);
vi.mock('./xingye-secondhand-ai', () => secondhandAiMock);

import { PhoneSecondhandApp } from './PhoneSecondhandApp';

const linwu: Agent = {
  id: 'linwu',
  name: '林雾',
  yuan: 'hanako',
  isPrimary: false,
  hasAvatar: false,
};

function renderSecondhandApp(agent: Agent | null = linwu) {
  return render(
    <PhoneSecondhandApp
      ownerAgent={agent}
      displayName={agent?.name ?? 'TA'}
      onBack={vi.fn()}
    />,
  );
}

describe('PhoneSecondhandApp', () => {
  beforeEach(() => {
    appEntryStoreMock.appendAppEntry.mockReset();
    appEntryStoreMock.deleteAppEntry.mockReset();
    appEntryStoreMock.listAppEntries.mockReset();
    appEntryStoreMock.updateAppEntry.mockReset();
    appEntryStoreMock.listAppEntries.mockResolvedValue([]);
    appEntryStoreMock.appendAppEntry.mockImplementation(async (agentId, appId, input) => ({
      id: 'created-1',
      agentId,
      appId,
      title: input.title,
      content: input.content,
      metadata: input.metadata,
      source: input.source ?? 'manual',
      createdAt: '2026-05-15T10:00:00.000Z',
      updatedAt: '2026-05-15T10:00:00.000Z',
    }));
    appEntryStoreMock.updateAppEntry.mockImplementation(async (agentId, appId, entryId, patch) => ({
      id: entryId,
      agentId,
      appId,
      title: patch.title,
      content: patch.content,
      metadata: patch.metadata,
      source: patch.source ?? 'manual',
      createdAt: '2026-05-15T10:00:00.000Z',
      updatedAt: '2026-05-15T11:00:00.000Z',
    }));
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('loads only the selected agent secondhand entries and saves a manual resale record', async () => {
    renderSecondhandApp();

    await waitFor(() => {
      expect(appEntryStoreMock.listAppEntries).toHaveBeenCalledWith('linwu', 'secondhand');
    });
    expect(await screen.findByText('还没有二手记录。')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '新增二手记录' }));
    fireEvent.change(screen.getByLabelText('物品名'), { target: { value: '灰蓝色围巾' } });
    fireEvent.change(screen.getByLabelText('状态'), { target: { value: 'to_sell' } });
    fireEvent.change(screen.getByLabelText('类别'), { target: { value: '衣物' } });
    fireEvent.change(screen.getByLabelText('期望卖价'), { target: { value: '¥40' } });
    fireEvent.change(screen.getByLabelText('记账金额'), { target: { value: '40' } });
    fireEvent.change(screen.getByLabelText('货币单位'), { target: { value: '¥' } });
    fireEvent.change(screen.getByLabelText('记录原因'), { target: { value: '戴过两次就闲置了。' } });
    fireEvent.change(screen.getByLabelText('标签'), { target: { value: '冬天, 软' } });
    fireEvent.change(screen.getByLabelText('备注'), { target: { value: '想出给用得上的人。' } });
    fireEvent.click(screen.getByRole('button', { name: '保存记录' }));

    /**
     * 注意：input 不再硬写 source: 'manual'，让 appendAppEntry 走自有 fallback、
     * updateAppEntry 看到 undefined 保留原 entry.source（不再洗掉 heartbeat 溯源）。
     */
    await waitFor(() => {
      expect(appEntryStoreMock.appendAppEntry).toHaveBeenCalledWith('linwu', 'secondhand', {
        title: '灰蓝色围巾',
        content: '想出给用得上的人。',
        metadata: {
          status: 'to_sell',
          platformStyle: 'generic',
          itemName: '灰蓝色围巾',
          category: '衣物',
          askingPrice: '¥40',
          amount: 40,
          currency: '¥',
          reason: '戴过两次就闲置了。',
          tags: ['冬天', '软'],
        },
      });
    });
  });

  it('edit save does not overwrite the entry source (preserves heartbeat-confirmed origin)', async () => {
    appEntryStoreMock.listAppEntries.mockResolvedValueOnce([
      {
        id: 'from-draft-y',
        agentId: 'linwu',
        appId: 'secondhand',
        title: '旧胶片相机',
        content: '想卖。',
        metadata: {
          status: 'to_sell',
          platformStyle: 'generic',
          itemName: '旧胶片相机',
        },
        source: 'xingye-heartbeat-confirmed',
        createdAt: '2026-05-15T10:00:00.000Z',
        updatedAt: '2026-05-15T10:00:00.000Z',
      },
    ]);

    renderSecondhandApp();
    fireEvent.click(await screen.findByRole('button', { name: /旧胶片相机/ }));
    fireEvent.click(screen.getByRole('button', { name: '编辑记录' }));
    fireEvent.change(screen.getByLabelText('记录原因'), { target: { value: '换了数码不再用。' } });
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));

    await waitFor(() => {
      expect(appEntryStoreMock.updateAppEntry).toHaveBeenCalled();
    });
    const patch = appEntryStoreMock.updateAppEntry.mock.calls[0][3];
    expect(patch).not.toHaveProperty('source');
  });

  it('filters, opens details, edits, and deletes one secondhand record without trade actions', async () => {
    appEntryStoreMock.listAppEntries.mockResolvedValueOnce([
      {
        id: 'tosell-1',
        agentId: 'linwu',
        appId: 'secondhand',
        title: '灰蓝色围巾',
        content: '想出给用得上的人。',
        metadata: {
          status: 'to_sell',
          platformStyle: 'generic',
          itemName: '灰蓝色围巾',
          category: '衣物',
          askingPrice: '¥40',
          reason: '戴过两次就闲置了。',
          tags: ['冬天'],
        },
        source: 'manual',
        createdAt: '2026-05-15T10:00:00.000Z',
        updatedAt: '2026-05-15T10:00:00.000Z',
      },
      {
        id: 'sold-1',
        agentId: 'linwu',
        appId: 'secondhand',
        title: '小夜灯',
        content: '被楼下收旧货的收走了。',
        metadata: {
          status: 'sold',
          platformStyle: 'generic',
          itemName: '小夜灯',
        },
        source: 'manual',
        createdAt: '2026-05-15T09:00:00.000Z',
        updatedAt: '2026-05-15T09:00:00.000Z',
      },
    ]);
    appEntryStoreMock.deleteAppEntry.mockResolvedValueOnce(true);
    vi.spyOn(window, 'confirm').mockReturnValueOnce(true);

    renderSecondhandApp();

    expect(await screen.findByRole('button', { name: /灰蓝色围巾/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '想卖' }));
    expect(screen.getByText('灰蓝色围巾')).toBeInTheDocument();
    expect(screen.queryByText('小夜灯')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /灰蓝色围巾/ }));
    expect(screen.getByText('戴过两次就闲置了。')).toBeInTheDocument();
    expect(screen.getByText('这只是 TA 自己的小手机二手记录，不连接真实平台。')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /支付|下单|购买|购物车|登录/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '编辑记录' }));
    fireEvent.change(screen.getByLabelText('状态'), { target: { value: 'negotiating' } });
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
    await waitFor(() => {
      expect(appEntryStoreMock.updateAppEntry).toHaveBeenCalledWith(
        'linwu',
        'secondhand',
        'tosell-1',
        expect.objectContaining({
          title: '灰蓝色围巾',
          metadata: expect.objectContaining({ status: 'negotiating' }),
        }),
      );
    });

    fireEvent.click(screen.getByRole('button', { name: '删除这条记录' }));
    await waitFor(() => {
      expect(appEntryStoreMock.deleteAppEntry).toHaveBeenCalledWith('linwu', 'secondhand', 'tosell-1');
    });
  });
});

/**
 * 覆盖「心跳巡检 → 待确认二手草稿」的 UI 链路。
 * mustPropose ≥50 chat turns 阈值（lib/desk/heartbeat.js）下，agent 会通过
 * `xingye_propose_draft` 向 secondhand 模块投递草稿；用户在小手机里确认或丢弃。
 */
describe('PhoneSecondhandApp · pending draft section', () => {
  beforeEach(() => {
    secondhandDraftsMock.confirmSecondhandDraft.mockReset();
    secondhandDraftsMock.discardSecondhandDraft.mockReset();
    secondhandDraftsMock.listSecondhandDrafts.mockReset();
    secondhandDraftsMock.listSecondhandDrafts.mockResolvedValue([]);
  });

  it('renders draft from listSecondhandDrafts and confirm forwards fields (incl. amount/currency) to confirmSecondhandDraft', async () => {
    secondhandDraftsMock.listSecondhandDrafts.mockResolvedValueOnce([
      {
        id: 'd-1',
        itemName: '旧胶片相机',
        status: 'to_sell',
        platformStyle: 'xianyu',
        category: '旧物',
        askingPrice: '¥800',
        content: '换了数码后一直闲置',
        reason: '巡检里看到角色反复说用不上了',
        source: 'xingye-heartbeat-tool',
        createdAt: '2026-05-17T12:00:00.000Z',
      },
    ]);
    secondhandDraftsMock.confirmSecondhandDraft.mockResolvedValueOnce({
      id: 'e-1',
      agentId: 'linwu',
      appId: 'secondhand',
      title: '旧胶片相机',
      content: '换了数码后一直闲置',
      source: 'manual',
      metadata: {
        status: 'to_sell',
        platformStyle: 'xianyu',
        itemName: '旧胶片相机',
        category: '旧物',
        askingPrice: '¥800',
        amount: 800,
        currency: '¥',
      },
      createdAt: '2026-05-17T12:30:00.000Z',
      updatedAt: '2026-05-17T12:30:00.000Z',
    });

    renderSecondhandApp();

    const draftCard = await screen.findByTestId('phone-secondhand-draft-d-1');
    expect(within(draftCard).getByText(/巡检里看到角色反复说用不上了/)).toBeInTheDocument();

    /** 在草稿卡上补金额，confirm 时一并落到 confirmSecondhandDraft 入参。 */
    fireEvent.change(screen.getByTestId('phone-secondhand-draft-amount-d-1'), { target: { value: '800' } });
    fireEvent.change(screen.getByTestId('phone-secondhand-draft-currency-d-1'), { target: { value: '¥' } });

    fireEvent.click(screen.getByTestId('phone-secondhand-draft-confirm-d-1'));

    await waitFor(() => {
      expect(secondhandDraftsMock.confirmSecondhandDraft).toHaveBeenCalledWith(
        'linwu',
        'd-1',
        expect.objectContaining({
          itemName: '旧胶片相机',
          status: 'to_sell',
          category: '旧物',
          askingPrice: '¥800',
          amount: 800,
          currency: '¥',
        }),
      );
    });

    await waitFor(() => {
      expect(screen.queryByTestId('phone-secondhand-draft-d-1')).not.toBeInTheDocument();
    });
  });

  it('list and detail render amount as main price using western prefix (¥800)', async () => {
    /**
     * 注意：标题用独特字符串「记账显示样本-resell」，因为这个 describe 块没有
     * afterEach cleanup，前一个 confirm 测试残留的 entry 会和新测试在同一 DOM 里——
     * 若同名会让 getByRole 撞到多个。共用 entry 的测试用 testid 隔离即可。
     */
    appEntryStoreMock.listAppEntries.mockResolvedValueOnce([
      {
        id: 'amt-1',
        agentId: 'linwu',
        appId: 'secondhand',
        title: '记账显示样本-resell',
        content: '',
        metadata: {
          status: 'sold',
          platformStyle: 'generic',
          itemName: '记账显示样本-resell',
          amount: 800,
          currency: '¥',
        },
        source: 'manual',
        createdAt: '2026-05-15T10:00:00.000Z',
        updatedAt: '2026-05-15T10:00:00.000Z',
      },
    ]);

    renderSecondhandApp();
    /** 单符号 ¥ 走前缀化（formatAmountWithCurrency 检测西方货币），不是「800 ¥」。 */
    expect(await screen.findByTestId('phone-secondhand-row-amount-amt-1')).toHaveTextContent('¥800');

    fireEvent.click(screen.getByRole('button', { name: /记账显示样本-resell/ }));
    expect(await screen.findByTestId('phone-secondhand-detail-amount-amt-1')).toHaveTextContent('¥800');
  });

  it('amount/currency wins the main price slot over askingPrice when both present', async () => {
    appEntryStoreMock.listAppEntries.mockResolvedValueOnce([
      {
        id: 'both-1',
        agentId: 'linwu',
        appId: 'secondhand',
        title: '价位优先样本-resell',
        content: '',
        metadata: {
          status: 'sold',
          platformStyle: 'generic',
          itemName: '价位优先样本-resell',
          askingPrice: '够换一壶酒',
          amount: 50,
          currency: '¥',
        },
        source: 'manual',
        createdAt: '2026-05-15T10:00:00.000Z',
        updatedAt: '2026-05-15T10:00:00.000Z',
      },
    ]);

    renderSecondhandApp();
    /** amount 优先：主价位显示 ¥50，氛围文本「够换一壶酒」不再出现在主槽。 */
    expect(await screen.findByTestId('phone-secondhand-row-amount-both-1')).toHaveTextContent('¥50');
    expect(screen.queryByText('够换一壶酒')).not.toBeInTheDocument();
  });

  it('falls back to askingPrice when amount is absent ("够换一壶酒" 这类推不出价格的氛围)', async () => {
    appEntryStoreMock.listAppEntries.mockResolvedValueOnce([
      {
        id: 'ask-1',
        agentId: 'linwu',
        appId: 'secondhand',
        title: '氛围价样本-resell',
        content: '',
        metadata: {
          status: 'to_sell',
          platformStyle: 'generic',
          itemName: '氛围价样本-resell',
          askingPrice: '够换一壶酒',
        },
        source: 'manual',
        createdAt: '2026-05-15T10:00:00.000Z',
        updatedAt: '2026-05-15T10:00:00.000Z',
      },
    ]);

    renderSecondhandApp();
    /** 无 amount → 主价位降级显示 askingPrice 原文。 */
    expect(await screen.findByText('够换一壶酒')).toBeInTheDocument();
    expect(screen.queryByTestId('phone-secondhand-row-amount-ask-1')).not.toBeInTheDocument();
  });

  it('discard calls discardSecondhandDraft and never leaks into appendAppEntry / confirm', async () => {
    secondhandDraftsMock.listSecondhandDrafts.mockResolvedValueOnce([
      {
        id: 'd-2',
        itemName: '随便',
        status: 'negotiating',
        platformStyle: 'generic',
        source: 'xingye-heartbeat-tool',
        createdAt: '2026-05-17T12:00:00.000Z',
      },
    ]);
    secondhandDraftsMock.discardSecondhandDraft.mockResolvedValueOnce(true);
    vi.spyOn(window, 'confirm').mockReturnValueOnce(true);

    renderSecondhandApp();
    await screen.findByTestId('phone-secondhand-draft-d-2');
    fireEvent.click(screen.getByTestId('phone-secondhand-draft-discard-d-2'));

    await waitFor(() => {
      expect(secondhandDraftsMock.discardSecondhandDraft).toHaveBeenCalledWith('linwu', 'd-2');
    });
    await waitFor(() => {
      expect(screen.queryByTestId('phone-secondhand-draft-d-2')).not.toBeInTheDocument();
    });
    /** discard 决不能误调 confirm 或 append（防止"假丢弃但又落库"）。 */
    expect(secondhandDraftsMock.confirmSecondhandDraft).not.toHaveBeenCalled();
    expect(appEntryStoreMock.appendAppEntry).not.toHaveBeenCalled();
  });

  it('discard aborts when user cancels window.confirm', async () => {
    secondhandDraftsMock.listSecondhandDrafts.mockResolvedValueOnce([
      {
        id: 'd-3',
        itemName: '保留',
        status: 'to_sell',
        platformStyle: 'generic',
        source: 'xingye-heartbeat-tool',
        createdAt: '2026-05-17T12:00:00.000Z',
      },
    ]);
    vi.spyOn(window, 'confirm').mockReturnValueOnce(false);

    renderSecondhandApp();
    await screen.findByTestId('phone-secondhand-draft-d-3');
    fireEvent.click(screen.getByTestId('phone-secondhand-draft-discard-d-3'));

    expect(secondhandDraftsMock.discardSecondhandDraft).not.toHaveBeenCalled();
    expect(screen.getByTestId('phone-secondhand-draft-d-3')).toBeInTheDocument();
  });
});
