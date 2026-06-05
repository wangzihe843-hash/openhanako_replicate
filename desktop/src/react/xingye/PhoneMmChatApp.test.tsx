/**
 * @vitest-environment jsdom
 *
 * MM Chat（TA 咨询 AI 助手）冒烟测试：无角色守卫 + 有角色挂载读盘并渲染空列表。
 * I/O（读/写盘、AI 生成）被替换；纯 helper（createEmptyMmChatPersisted 等）保留真实。
 */
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../types';

const mmStoreMock = vi.hoisted(() => ({
  readMmChatPersistence: vi.fn(),
  saveMmChatPersistence: vi.fn(),
}));
const mmAiMock = vi.hoisted(() => ({
  generateMmChatInitialBacklogWithAI: vi.fn(),
  generateMmChatRoundsWithAI: vi.fn(),
}));

vi.mock('./xingye-mm-chat-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./xingye-mm-chat-store')>();
  return { ...actual, ...mmStoreMock };
});
vi.mock('./xingye-mm-chat-ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./xingye-mm-chat-ai')>();
  return { ...actual, ...mmAiMock };
});

import { PhoneMmChatApp } from './PhoneMmChatApp';
import { createEmptyMmChatPersisted } from './xingye-mm-chat-store';

const linwu: Agent = { id: 'linwu', name: '林雾', yuan: 'hanako', isPrimary: false, hasAvatar: false };

beforeEach(() => {
  mmStoreMock.readMmChatPersistence.mockReset();
  // 返回「已初始化但无会话」→ 跳过首启铺历史，停在空列表稳定态。
  mmStoreMock.readMmChatPersistence.mockResolvedValue({
    ...createEmptyMmChatPersisted(),
    initializedAt: '2026-01-01T00:00:00.000Z',
  });
  mmStoreMock.saveMmChatPersistence.mockReset();
  mmStoreMock.saveMmChatPersistence.mockResolvedValue(undefined);
  mmAiMock.generateMmChatInitialBacklogWithAI.mockReset();
  mmAiMock.generateMmChatInitialBacklogWithAI.mockResolvedValue([]);
  mmAiMock.generateMmChatRoundsWithAI.mockReset();
  mmAiMock.generateMmChatRoundsWithAI.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('PhoneMmChatApp', () => {
  it('无角色：显示「未选择角色」且不读盘', () => {
    render(<PhoneMmChatApp ownerAgent={null} ownerProfile={null} displayName="TA" onBack={vi.fn()} />);
    expect(screen.getByText(/未选择角色/)).toBeInTheDocument();
    expect(screen.getByTestId('mm-chat-list-empty')).toBeInTheDocument();
    expect(mmStoreMock.readMmChatPersistence).not.toHaveBeenCalled();
  });

  it('有角色：挂载时读盘，已初始化的空记录渲染空列表', async () => {
    render(<PhoneMmChatApp ownerAgent={linwu} ownerProfile={null} displayName="林雾" onBack={vi.fn()} />);
    await waitFor(() => {
      expect(mmStoreMock.readMmChatPersistence).toHaveBeenCalledWith('linwu');
    });
    expect(await screen.findByTestId('mm-chat-list-empty')).toBeInTheDocument();
    // 已 initialized → 不触发首启铺历史生成。
    expect(mmAiMock.generateMmChatInitialBacklogWithAI).not.toHaveBeenCalled();
  });
});
