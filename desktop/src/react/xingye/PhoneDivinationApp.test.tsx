/**
 * @vitest-environment jsdom
 *
 * 占卜 App 冒烟测试：无角色守卫 + 有角色挂载读取条目并渲染起卦面板。
 * I/O（条目读写、草稿、resolver 上下文、AI 生成）被替换；纯 helper（占法推荐 /
 * 主题 / 叙事归一化）保留真实，以真实渲染路径捕获 import/render 回归。
 */
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../types';

const appEntryMock = vi.hoisted(() => ({
  loadDivinationEntries: vi.fn(),
  appendDivinationEntry: vi.fn(),
  deleteDivinationEntry: vi.fn(),
}));
const draftsMock = vi.hoisted(() => ({
  listDivinationDrafts: vi.fn(),
  confirmDivinationDraft: vi.fn(),
  discardDivinationDraft: vi.fn(),
}));
const resolverCtxMock = vi.hoisted(() => ({ buildDivinationResolverContext: vi.fn() }));
const aiMock = vi.hoisted(() => ({ generateDivinationReadingWithAI: vi.fn() }));

vi.mock('./xingye-divination-fonts', () => ({})); // side-effect-only 字体注入，测试里短路
vi.mock('./xingye-app-entry-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./xingye-app-entry-store')>();
  return { ...actual, ...appEntryMock };
});
vi.mock('./xingye-divination-drafts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./xingye-divination-drafts')>();
  return { ...actual, ...draftsMock };
});
vi.mock('./xingye-divination-resolver-context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./xingye-divination-resolver-context')>();
  return { ...actual, ...resolverCtxMock };
});
vi.mock('./xingye-divination-ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./xingye-divination-ai')>();
  return { ...actual, ...aiMock };
});

import { PhoneDivinationApp } from './PhoneDivinationApp';

const linwu: Agent = { id: 'linwu', name: '林雾', yuan: 'hanako', isPrimary: false, hasAvatar: false };

beforeEach(() => {
  appEntryMock.loadDivinationEntries.mockReset();
  appEntryMock.loadDivinationEntries.mockResolvedValue([]);
  draftsMock.listDivinationDrafts.mockReset();
  draftsMock.listDivinationDrafts.mockResolvedValue([]);
  resolverCtxMock.buildDivinationResolverContext.mockReset();
  resolverCtxMock.buildDivinationResolverContext.mockResolvedValue(null);
  aiMock.generateDivinationReadingWithAI.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('PhoneDivinationApp', () => {
  it('无角色：显示「占卜不可用」且不读取条目', () => {
    render(
      <PhoneDivinationApp ownerAgent={null} ownerProfile={null} displayName="TA" onBack={vi.fn()} />,
    );
    expect(screen.getByText('占卜不可用')).toBeInTheDocument();
    expect(screen.getByText(/未选择角色/)).toBeInTheDocument();
    expect(appEntryMock.loadDivinationEntries).not.toHaveBeenCalled();
  });

  it('有角色：挂载时读取条目并渲染起卦面板', async () => {
    render(
      <PhoneDivinationApp ownerAgent={linwu} ownerProfile={null} displayName="林雾" onBack={vi.fn()} />,
    );
    await waitFor(() => {
      expect(appEntryMock.loadDivinationEntries).toHaveBeenCalledWith('linwu');
    });
    expect(await screen.findByTestId('phone-divination-generate')).toBeInTheDocument();
  });
});
