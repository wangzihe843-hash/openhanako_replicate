/**
 * @vitest-environment jsdom
 */

import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../types';

const appEntryStoreMock = vi.hoisted(() => ({
  appendAppEntry: vi.fn(),
  deleteAppEntry: vi.fn(),
  listAppEntries: vi.fn(),
  updateAppEntry: vi.fn(),
}));

vi.mock('./xingye-app-entry-store', () => appEntryStoreMock);

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
