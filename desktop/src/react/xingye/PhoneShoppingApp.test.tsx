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

const shoppingDraftsMock = vi.hoisted(() => ({
  confirmShoppingDraft: vi.fn(),
  discardShoppingDraft: vi.fn(),
  listShoppingDrafts: vi.fn().mockResolvedValue([]),
}));

const shoppingAiMock = vi.hoisted(() => ({
  generateShoppingDraftWithAI: vi.fn(),
}));

vi.mock('./xingye-app-entry-store', () => appEntryStoreMock);
vi.mock('./xingye-shopping-drafts', () => shoppingDraftsMock);
vi.mock('./xingye-shopping-ai', () => shoppingAiMock);

import { PhoneShoppingApp } from './PhoneShoppingApp';

const linwu: Agent = {
  id: 'linwu',
  name: '林雾',
  yuan: 'hanako',
  isPrimary: false,
  hasAvatar: false,
};

function renderShoppingApp(agent: Agent | null = linwu) {
  return render(
    <PhoneShoppingApp
      ownerAgent={agent}
      displayName={agent?.name ?? 'TA'}
      onBack={vi.fn()}
    />,
  );
}

describe('PhoneShoppingApp', () => {
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

  it('loads only the selected agent shopping entries and saves a manual shopping record', async () => {
    renderShoppingApp();

    await waitFor(() => {
      expect(appEntryStoreMock.listAppEntries).toHaveBeenCalledWith('linwu', 'shopping');
    });
    expect(screen.getByText('还没有购物记录。')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '新增购物记录' }));
    fireEvent.change(screen.getByLabelText('物品名'), { target: { value: '灰蓝色围巾' } });
    fireEvent.change(screen.getByLabelText('状态'), { target: { value: 'wanted' } });
    fireEvent.change(screen.getByLabelText('类别'), { target: { value: '衣物' } });
    fireEvent.change(screen.getByLabelText('价格感'), { target: { value: '像是要攒一阵子的小贵' } });
    fireEvent.change(screen.getByLabelText('记账金额'), { target: { value: '¥99' } });
    fireEvent.change(screen.getByLabelText('货币单位'), { target: { value: '¥' } });
    fireEvent.change(screen.getByLabelText('记录原因'), { target: { value: '觉得适合冬天出门时戴。' } });
    fireEvent.change(screen.getByLabelText('标签'), { target: { value: '冬天, 软' } });
    fireEvent.change(screen.getByLabelText('备注'), { target: { value: '先放在想买清单里。' } });
    fireEvent.click(screen.getByRole('button', { name: '保存记录' }));

    /**
     * 注意：input 不再硬写 source: 'manual'，让 appendAppEntry 走自有 fallback、
     * updateAppEntry 看到 undefined 保留原 entry.source（不再洗掉 heartbeat 溯源）。
     * `¥99` 被 parseAmountText 解析为 99（兼容币种前缀）。
     */
    await waitFor(() => {
      expect(appEntryStoreMock.appendAppEntry).toHaveBeenCalledWith('linwu', 'shopping', {
        title: '灰蓝色围巾',
        content: '先放在想买清单里。',
        metadata: {
          status: 'wanted',
          platformStyle: 'generic',
          itemName: '灰蓝色围巾',
          category: '衣物',
          imaginedPrice: '像是要攒一阵子的小贵',
          amount: 99,
          currency: '¥',
          reason: '觉得适合冬天出门时戴。',
          tags: ['冬天', '软'],
        },
      });
    });
  });

  it('edit save does not overwrite the entry source (preserves heartbeat-confirmed origin)', async () => {
    appEntryStoreMock.listAppEntries.mockResolvedValueOnce([
      {
        id: 'from-draft-x',
        agentId: 'linwu',
        appId: 'shopping',
        title: '通勤保温杯',
        content: '想喝热的。',
        metadata: {
          status: 'wanted',
          platformStyle: 'generic',
          itemName: '通勤保温杯',
        },
        source: 'xingye-heartbeat-confirmed',
        createdAt: '2026-05-15T10:00:00.000Z',
        updatedAt: '2026-05-15T10:00:00.000Z',
      },
    ]);

    renderShoppingApp();
    fireEvent.click(await screen.findByRole('button', { name: /通勤保温杯/ }));
    fireEvent.click(screen.getByRole('button', { name: '编辑记录' }));
    fireEvent.change(screen.getByLabelText('记录原因'), { target: { value: '改一下原因' } });
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));

    await waitFor(() => {
      expect(appEntryStoreMock.updateAppEntry).toHaveBeenCalled();
    });
    const patch = appEntryStoreMock.updateAppEntry.mock.calls[0][3];
    expect(patch).not.toHaveProperty('source');
  });

  it('filters, opens details, edits, and deletes one shopping record without purchase actions', async () => {
    appEntryStoreMock.listAppEntries.mockResolvedValueOnce([
      {
        id: 'wanted-1',
        agentId: 'linwu',
        appId: 'shopping',
        title: '灰蓝色围巾',
        content: '先放在想买清单里。',
        metadata: {
          status: 'wanted',
          platformStyle: 'generic',
          itemName: '灰蓝色围巾',
          category: '衣物',
          imaginedPrice: '像是要攒一阵子的小贵',
          reason: '觉得适合冬天出门时戴。',
          tags: ['冬天'],
        },
        source: 'manual',
        createdAt: '2026-05-15T10:00:00.000Z',
        updatedAt: '2026-05-15T10:00:00.000Z',
      },
      {
        id: 'received-1',
        agentId: 'linwu',
        appId: 'shopping',
        title: '小夜灯',
        content: '已经收到，光很柔。',
        metadata: {
          status: 'received',
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

    renderShoppingApp();

    expect(await screen.findByRole('button', { name: /灰蓝色围巾/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '想买' }));
    expect(screen.getByText('灰蓝色围巾')).toBeInTheDocument();
    expect(screen.queryByText('小夜灯')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /灰蓝色围巾/ }));
    expect(screen.getByText('觉得适合冬天出门时戴。')).toBeInTheDocument();
    expect(screen.getByText('这只是 TA 自己的小手机购物记录，不连接真实平台。')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /支付|下单|购买|购物车|登录/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '编辑记录' }));
    fireEvent.change(screen.getByLabelText('状态'), { target: { value: 'hesitating' } });
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
    await waitFor(() => {
      expect(appEntryStoreMock.updateAppEntry).toHaveBeenCalledWith(
        'linwu',
        'shopping',
        'wanted-1',
        expect.objectContaining({
          title: '灰蓝色围巾',
          metadata: expect.objectContaining({ status: 'hesitating' }),
        }),
      );
    });

    fireEvent.click(screen.getByRole('button', { name: '删除这条记录' }));
    await waitFor(() => {
      expect(appEntryStoreMock.deleteAppEntry).toHaveBeenCalledWith('linwu', 'shopping', 'wanted-1');
    });
  });
});

/**
 * 覆盖「心跳巡检 → 待确认购物草稿」的 UI 链路。
 * mustPropose ≥50 chat turns 阈值（lib/desk/heartbeat.js）下，agent 会通过
 * `xingye_propose_draft` 向 shopping 模块投递草稿；用户在小手机里确认或丢弃。
 */
describe('PhoneShoppingApp · pending draft section', () => {
  beforeEach(() => {
    shoppingDraftsMock.confirmShoppingDraft.mockReset();
    shoppingDraftsMock.discardShoppingDraft.mockReset();
    shoppingDraftsMock.listShoppingDrafts.mockReset();
    shoppingDraftsMock.listShoppingDrafts.mockResolvedValue([]);
  });

  it('renders draft from listShoppingDrafts and confirm forwards fields (incl. amount/currency) to confirmShoppingDraft', async () => {
    shoppingDraftsMock.listShoppingDrafts.mockResolvedValueOnce([
      {
        id: 'd-1',
        itemName: '便携咖啡杯',
        status: 'wanted',
        platformStyle: 'taobao',
        category: '日用',
        imaginedPrice: '￥99',
        content: '想买个保温杯',
        reason: '巡检里看到角色反复提通勤',
        source: 'xingye-heartbeat-tool',
        createdAt: '2026-05-17T12:00:00.000Z',
      },
    ]);
    shoppingDraftsMock.confirmShoppingDraft.mockResolvedValueOnce({
      id: 'e-1',
      agentId: 'linwu',
      appId: 'shopping',
      title: '便携咖啡杯',
      content: '想买个保温杯',
      source: 'manual',
      metadata: {
        status: 'wanted',
        platformStyle: 'taobao',
        itemName: '便携咖啡杯',
        category: '日用',
        imaginedPrice: '￥99',
        amount: 120,
        currency: '¥',
      },
      createdAt: '2026-05-17T12:30:00.000Z',
      updatedAt: '2026-05-17T12:30:00.000Z',
    });

    renderShoppingApp();

    const draftCard = await screen.findByTestId('phone-shopping-draft-d-1');
    expect(within(draftCard).getByText(/巡检里看到角色反复提通勤/)).toBeInTheDocument();

    /** 在草稿卡上补金额，confirm 时一并落到 confirmShoppingDraft 入参。 */
    fireEvent.change(screen.getByTestId('phone-shopping-draft-amount-d-1'), { target: { value: '120' } });
    fireEvent.change(screen.getByTestId('phone-shopping-draft-currency-d-1'), { target: { value: '¥' } });

    fireEvent.click(screen.getByTestId('phone-shopping-draft-confirm-d-1'));

    await waitFor(() => {
      expect(shoppingDraftsMock.confirmShoppingDraft).toHaveBeenCalledWith(
        'linwu',
        'd-1',
        expect.objectContaining({
          itemName: '便携咖啡杯',
          status: 'wanted',
          category: '日用',
          imaginedPrice: '￥99',
          amount: 120,
          currency: '¥',
        }),
      );
    });

    await waitFor(() => {
      expect(screen.queryByTestId('phone-shopping-draft-d-1')).not.toBeInTheDocument();
    });
  });

  it('list and detail render amount as main price using western prefix (¥120)', async () => {
    /**
     * 注意：标题用独特字符串「记账显示样本-shop」，因为这个 describe 块没有 afterEach
     * cleanup，前一个 confirm 测试残留的 entry 会和新测试在同一 DOM 里——若同名会让
     * getByRole 撞到多个。共用 entry 的测试用 testid 隔离即可。
     */
    appEntryStoreMock.listAppEntries.mockResolvedValueOnce([
      {
        id: 'amt-1',
        agentId: 'linwu',
        appId: 'shopping',
        title: '记账显示样本-shop',
        content: '',
        metadata: {
          status: 'received',
          platformStyle: 'generic',
          itemName: '记账显示样本-shop',
          amount: 120,
          currency: '¥',
        },
        source: 'manual',
        createdAt: '2026-05-15T10:00:00.000Z',
        updatedAt: '2026-05-15T10:00:00.000Z',
      },
    ]);

    renderShoppingApp();
    /** 单符号 ¥ 走前缀化（formatAmountWithCurrency 检测西方货币），不是「120 ¥」。 */
    expect(await screen.findByTestId('phone-shopping-row-amount-amt-1')).toHaveTextContent('¥120');

    fireEvent.click(screen.getByRole('button', { name: /记账显示样本-shop/ }));
    expect(await screen.findByTestId('phone-shopping-detail-amount-amt-1')).toHaveTextContent('¥120');
  });

  it('amount/currency wins the main price slot over imaginedPrice when both present', async () => {
    appEntryStoreMock.listAppEntries.mockResolvedValueOnce([
      {
        id: 'both-1',
        agentId: 'linwu',
        appId: 'shopping',
        title: '价位优先样本-shop',
        content: '',
        metadata: {
          status: 'received',
          platformStyle: 'generic',
          itemName: '价位优先样本-shop',
          imaginedPrice: '约一杯奶茶钱',
          amount: 25,
          currency: '¥',
        },
        source: 'manual',
        createdAt: '2026-05-15T10:00:00.000Z',
        updatedAt: '2026-05-15T10:00:00.000Z',
      },
    ]);

    renderShoppingApp();
    /** amount 优先：主价位显示 ¥25，氛围文本「约一杯奶茶钱」不再出现在主槽。 */
    expect(await screen.findByTestId('phone-shopping-row-amount-both-1')).toHaveTextContent('¥25');
    expect(screen.queryByText('约一杯奶茶钱')).not.toBeInTheDocument();
  });

  it('falls back to imaginedPrice when amount is absent ("约一杯奶茶钱" 这类推不出价格的氛围)', async () => {
    appEntryStoreMock.listAppEntries.mockResolvedValueOnce([
      {
        id: 'imp-1',
        agentId: 'linwu',
        appId: 'shopping',
        title: '氛围价样本-shop',
        content: '',
        metadata: {
          status: 'wanted',
          platformStyle: 'generic',
          itemName: '氛围价样本-shop',
          imaginedPrice: '约一杯奶茶钱',
        },
        source: 'manual',
        createdAt: '2026-05-15T10:00:00.000Z',
        updatedAt: '2026-05-15T10:00:00.000Z',
      },
    ]);

    renderShoppingApp();
    /** 无 amount → 主价位降级显示 imaginedPrice 原文。 */
    expect(await screen.findByText('约一杯奶茶钱')).toBeInTheDocument();
    /** 没有 amount，行金额 testid 不会渲染。 */
    expect(screen.queryByTestId('phone-shopping-row-amount-imp-1')).not.toBeInTheDocument();
  });

  it('discard calls discardShoppingDraft and never leaks into appendAppEntry / confirm', async () => {
    shoppingDraftsMock.listShoppingDrafts.mockResolvedValueOnce([
      {
        id: 'd-2',
        itemName: '随便',
        status: 'hesitating',
        platformStyle: 'generic',
        source: 'xingye-heartbeat-tool',
        createdAt: '2026-05-17T12:00:00.000Z',
      },
    ]);
    shoppingDraftsMock.discardShoppingDraft.mockResolvedValueOnce(true);
    vi.spyOn(window, 'confirm').mockReturnValueOnce(true);

    renderShoppingApp();
    await screen.findByTestId('phone-shopping-draft-d-2');
    fireEvent.click(screen.getByTestId('phone-shopping-draft-discard-d-2'));

    await waitFor(() => {
      expect(shoppingDraftsMock.discardShoppingDraft).toHaveBeenCalledWith('linwu', 'd-2');
    });
    await waitFor(() => {
      expect(screen.queryByTestId('phone-shopping-draft-d-2')).not.toBeInTheDocument();
    });
    /** discard 决不能误调 confirm 或 append（防止"假丢弃但又落库"）。 */
    expect(shoppingDraftsMock.confirmShoppingDraft).not.toHaveBeenCalled();
    expect(appEntryStoreMock.appendAppEntry).not.toHaveBeenCalled();
  });

  it('discard aborts when user cancels window.confirm', async () => {
    shoppingDraftsMock.listShoppingDrafts.mockResolvedValueOnce([
      {
        id: 'd-3',
        itemName: '保留',
        status: 'wanted',
        platformStyle: 'generic',
        source: 'xingye-heartbeat-tool',
        createdAt: '2026-05-17T12:00:00.000Z',
      },
    ]);
    vi.spyOn(window, 'confirm').mockReturnValueOnce(false);

    renderShoppingApp();
    await screen.findByTestId('phone-shopping-draft-d-3');
    fireEvent.click(screen.getByTestId('phone-shopping-draft-discard-d-3'));

    expect(shoppingDraftsMock.discardShoppingDraft).not.toHaveBeenCalled();
    expect(screen.getByTestId('phone-shopping-draft-d-3')).toBeInTheDocument();
  });
});

/**
 * 跨角色 reload 竞态：见 PhoneSecondhandApp/PhoneTripsApp 的同款守卫。
 * reloadSeqRef 单调请求号 + effect cleanup 让上一个角色还在飞的 listAppEntries
 * 最后才落地时无法 setState 覆盖新角色数据。
 */
describe('PhoneShoppingApp · 跨角色 reload 竞态', () => {
  const agentB: Agent = { ...linwu, id: 'agentB', name: 'B' };

  beforeEach(() => {
    appEntryStoreMock.appendAppEntry.mockReset();
    appEntryStoreMock.deleteAppEntry.mockReset();
    appEntryStoreMock.listAppEntries.mockReset();
    appEntryStoreMock.updateAppEntry.mockReset();
    appEntryStoreMock.listAppEntries.mockResolvedValue([]);
    shoppingDraftsMock.listShoppingDrafts.mockReset();
    shoppingDraftsMock.listShoppingDrafts.mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  function makeShoppingEntry(id: string, itemName: string) {
    return {
      id,
      agentId: id,
      appId: 'shopping',
      title: itemName,
      content: '',
      metadata: {
        status: 'wanted',
        platformStyle: 'generic',
        itemName,
      },
      source: 'manual',
      createdAt: '2026-05-15T10:00:00.000Z',
      updatedAt: '2026-05-15T10:00:00.000Z',
    };
  }

  it('切换角色后，旧角色后落地的 reload 不覆盖新角色数据', async () => {
    // 受控 deferred：让 A 的 listAppEntries 一直挂着，切到 B 后再 resolve A，
    // 模拟「旧角色的在飞读取最后才落地」。
    let resolveA: (rows: unknown[]) => void = () => {};
    const aEntriesPromise = new Promise<unknown[]>((resolve) => {
      resolveA = resolve;
    });

    appEntryStoreMock.listAppEntries.mockImplementation((aid: string) => {
      if (aid === 'linwu') return aEntriesPromise;
      if (aid === 'agentB') return Promise.resolve([makeShoppingEntry('b-1', '乙物品')]);
      return Promise.resolve([]);
    });

    const { rerender } = render(
      <PhoneShoppingApp ownerAgent={linwu} displayName="林雾" onBack={vi.fn()} />,
    );
    await waitFor(() => {
      expect(appEntryStoreMock.listAppEntries).toHaveBeenCalledWith('linwu', 'shopping');
    });

    // 切到 B：触发新一轮 reload（cleanup 让上一轮失效）。
    rerender(
      <PhoneShoppingApp ownerAgent={agentB} displayName="B" onBack={vi.fn()} />,
    );
    await waitFor(() => {
      expect(screen.getByText('乙物品')).toBeInTheDocument();
    });

    // 现在 A 的旧读取才落地——必须被请求号守卫丢弃，不能覆盖 B。
    resolveA([makeShoppingEntry('a-1', '甲物品')]);
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 20));

    expect(screen.getByText('乙物品')).toBeInTheDocument();
    expect(screen.queryByText('甲物品')).not.toBeInTheDocument();
  });
});
