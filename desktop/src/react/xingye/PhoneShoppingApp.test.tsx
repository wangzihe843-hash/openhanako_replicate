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
    fireEvent.change(screen.getByLabelText('记录原因'), { target: { value: '觉得适合冬天出门时戴。' } });
    fireEvent.change(screen.getByLabelText('标签'), { target: { value: '冬天, 软' } });
    fireEvent.change(screen.getByLabelText('备注'), { target: { value: '先放在想买清单里。' } });
    fireEvent.click(screen.getByRole('button', { name: '保存记录' }));

    await waitFor(() => {
      expect(appEntryStoreMock.appendAppEntry).toHaveBeenCalledWith('linwu', 'shopping', {
        title: '灰蓝色围巾',
        content: '先放在想买清单里。',
        source: 'manual',
        metadata: {
          status: 'wanted',
          platformStyle: 'generic',
          itemName: '灰蓝色围巾',
          category: '衣物',
          imaginedPrice: '像是要攒一阵子的小贵',
          reason: '觉得适合冬天出门时戴。',
          tags: ['冬天', '软'],
        },
      });
    });
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

  it('renders draft from listShoppingDrafts and confirm forwards fields to confirmShoppingDraft', async () => {
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
      },
      createdAt: '2026-05-17T12:30:00.000Z',
      updatedAt: '2026-05-17T12:30:00.000Z',
    });

    renderShoppingApp();

    const draftCard = await screen.findByTestId('phone-shopping-draft-d-1');
    expect(within(draftCard).getByText(/巡检里看到角色反复提通勤/)).toBeInTheDocument();

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
        }),
      );
    });

    await waitFor(() => {
      expect(screen.queryByTestId('phone-shopping-draft-d-1')).not.toBeInTheDocument();
    });
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
