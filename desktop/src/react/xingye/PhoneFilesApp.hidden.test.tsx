/**
 * @vitest-environment jsdom
 *
 * 覆盖 PhoneFilesApp 的隐藏文件夹流程：
 *   1. 上锁的行可见 + 点击弹出密码框
 *   2. 输错 → 显示反应文案，行仍上锁
 *   3. 输对 → 进入 hidden 视图
 *   4. AI 种子生成路径（mock generateHiddenSeedsWithAI）写入条目
 *
 * 整个 secret-store / passwords / ai / heartbeat 模块都 mock，
 * 这样测试不依赖 storage 后端 / 模型服务。
 */

import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../types';

const filesStoreMock = vi.hoisted(() => ({
  appendFileDraft: vi.fn(),
  appendFileEntry: vi.fn(),
  confirmFileDraft: vi.fn(),
  deleteFileEntry: vi.fn(),
  discardFileDraft: vi.fn(),
  ensureDefaultFileFolders: vi.fn(),
  listFileDrafts: vi.fn(),
  listFileEntries: vi.fn(),
  listFileEntriesByFolder: vi.fn(),
  listFileFolders: vi.fn(),
  resolveFolderIdFromHint: vi.fn(),
  updateFileEntry: vi.fn(),
}));
vi.mock('./xingye-files-store', () => filesStoreMock);

const secretStoreMock = vi.hoisted(() => ({
  appendHiddenEntry: vi.fn(),
  attemptUnlock: vi.fn(),
  deleteHiddenEntry: vi.fn(),
  hashPassword: vi.fn(),
  listHiddenEntries: vi.fn(),
  markHiddenFolderSeedGenerated: vi.fn(),
  maybeRelockOnHeartbeat: vi.fn(),
  readHiddenFolderState: vi.fn(),
  setHiddenFolderPassword: vi.fn(),
}));
vi.mock('./xingye-files-secret-store', () => secretStoreMock);

const secretPasswordsMock = vi.hoisted(() => ({
  collectHiddenPasswordCandidates: vi.fn(() => [
    { value: 'LW', label: '林雾首字母', kind: 'agent_initials' },
  ]),
  findCandidateMatch: vi.fn(),
  pickRandomCandidate: vi.fn(() => ({
    value: 'LW',
    label: '林雾首字母',
    kind: 'agent_initials',
  })),
}));
vi.mock('./xingye-files-secret-passwords', () => secretPasswordsMock);

const secretAiMock = vi.hoisted(() => ({
  generateHiddenSeedsWithAI: vi.fn(),
}));
vi.mock('./xingye-files-secret-ai', () => secretAiMock);

vi.mock('./xingye-lore-store', () => ({ listLoreEntries: vi.fn(() => []) }));
vi.mock('./xingye-phone-store', () => ({ getVirtualContacts: vi.fn(() => []) }));
vi.mock('./xingye-persistence', () => ({ getXingyePersistenceStorage: vi.fn(() => null) }));

const storeMockState = vi.hoisted(() => ({
  userName: 'Margaret',
  stagedChatQuote: null as { text: string; sourceKind: string } | null,
  stageChatQuote: vi.fn(),
}));

vi.mock('../stores', () => ({
  useStore: Object.assign(
    (selector: (s: typeof storeMockState) => unknown) => selector(storeMockState),
    {
      getState: () => storeMockState,
      setState: vi.fn(),
      subscribe: vi.fn(() => () => undefined),
    },
  ),
}));

import { PhoneFilesApp } from './PhoneFilesApp';

const agent: Agent = {
  id: 'linwu',
  name: '林雾',
  yuan: 'hanako',
  isPrimary: false,
  hasAvatar: false,
};

const baseFolders = [
  {
    id: 'f-1',
    agentId: 'linwu',
    name: '世界观整理',
    description: '设定。',
    order: 0,
    createdAt: '2026-05-15T10:00:00.000Z',
    updatedAt: '2026-05-15T10:00:00.000Z',
  },
];

function renderApp() {
  return render(<PhoneFilesApp ownerAgent={agent} displayName="林雾" onBack={vi.fn()} />);
}

beforeEach(() => {
  for (const fn of Object.values(filesStoreMock)) fn.mockReset();
  for (const fn of Object.values(secretStoreMock)) fn.mockReset();
  for (const fn of Object.values(secretPasswordsMock)) fn.mockReset?.();
  secretAiMock.generateHiddenSeedsWithAI.mockReset();
  storeMockState.stageChatQuote.mockReset();
  storeMockState.stagedChatQuote = null;

  filesStoreMock.listFileFolders.mockResolvedValue(baseFolders);
  filesStoreMock.listFileEntries.mockResolvedValue([]);
  filesStoreMock.listFileDrafts.mockResolvedValue([]);

  secretStoreMock.readHiddenFolderState.mockResolvedValue({
    agentId: 'linwu',
    locked: true,
    passwordHash: 'fakehash',
    candidateLabel: '林雾首字母',
    seedGenerated: false,
    updatedAt: '2026-05-15T10:00:00.000Z',
  });
  secretStoreMock.listHiddenEntries.mockResolvedValue([]);
  secretStoreMock.attemptUnlock.mockImplementation(async (_aid: string, attempt: string) => {
    const ok = attempt.trim().toLowerCase() === 'lw';
    return {
      ok,
      state: {
        agentId: 'linwu',
        locked: !ok,
        passwordHash: 'fakehash',
        candidateLabel: '林雾首字母',
        seedGenerated: false,
        updatedAt: '2026-05-15T11:00:00.000Z',
        lastUnlockedAt: ok ? '2026-05-15T11:00:00.000Z' : undefined,
      },
    };
  });
  secretStoreMock.markHiddenFolderSeedGenerated.mockResolvedValue({
    agentId: 'linwu',
    locked: false,
    passwordHash: 'fakehash',
    candidateLabel: '林雾首字母',
    seedGenerated: true,
    updatedAt: '2026-05-15T11:01:00.000Z',
    lastUnlockedAt: '2026-05-15T11:00:00.000Z',
  });
  secretStoreMock.appendHiddenEntry.mockImplementation(async (_aid: string, draft) => ({
    id: `hid-${Math.random().toString(36).slice(2, 8)}`,
    key: 'k',
    agentId: 'linwu',
    kind: draft.kind,
    title: draft.title,
    body: draft.body,
    source: draft.source ?? 'manual',
    createdAt: '2026-05-15T11:02:00.000Z',
    updatedAt: '2026-05-15T11:02:00.000Z',
  }));

  /** vi.mocked default 已经返回上面 secretPasswordsMock 里的 vi.fn(() => ...)；
   *  不需要重新设置实现。 */
});

afterEach(() => {
  cleanup();
});

describe('PhoneFilesApp · hidden folder', () => {
  it('首页显示上锁的隐藏文件夹行', async () => {
    renderApp();
    const row = await screen.findByTestId('phone-files-hidden-folder-row');
    expect(row).toBeInTheDocument();
    expect(row.dataset.locked).toBe('true');
    expect(row).toHaveTextContent('???');
  });

  it('点击上锁行弹出密码框', async () => {
    renderApp();
    fireEvent.click(await screen.findByTestId('phone-files-hidden-folder-row'));
    expect(await screen.findByTestId('phone-files-hidden-modal')).toBeInTheDocument();
  });

  it('输错密码显示 agent 反应、行仍锁定', async () => {
    renderApp();
    fireEvent.click(await screen.findByTestId('phone-files-hidden-folder-row'));
    const input = await screen.findByTestId('phone-files-hidden-password-input');
    fireEvent.change(input, { target: { value: 'WRONG' } });
    fireEvent.click(screen.getByTestId('phone-files-hidden-password-submit'));

    const reaction = await screen.findByTestId('phone-files-hidden-reaction');
    expect(reaction.textContent?.length ?? 0).toBeGreaterThan(0);

    /** 弹窗还在，行仍锁定。 */
    expect(screen.getByTestId('phone-files-hidden-modal')).toBeInTheDocument();
    expect(secretStoreMock.attemptUnlock).toHaveBeenCalledWith('linwu', 'WRONG');
  });

  it('输对密码进入隐藏视图', async () => {
    renderApp();
    fireEvent.click(await screen.findByTestId('phone-files-hidden-folder-row'));
    const input = await screen.findByTestId('phone-files-hidden-password-input');
    fireEvent.change(input, { target: { value: 'LW' } });
    fireEvent.click(screen.getByTestId('phone-files-hidden-password-submit'));

    expect(await screen.findByTestId('phone-files-hidden-view')).toBeInTheDocument();
    /** 应该展示「让 TA 自己写几条」种子按钮（seedGenerated=false, 条目为空）。 */
    expect(screen.getByTestId('phone-files-hidden-seed-button')).toBeInTheDocument();
  });

  it('点击「让 TA 自己写几条」生成种子条目并展示', async () => {
    secretAiMock.generateHiddenSeedsWithAI.mockResolvedValue([
      { kind: 'weakness', title: '生人面前手会抖', body: '只在自己人面前不会抖。' },
      { kind: 'secret_taste', title: '偷偷喜欢甜的', body: '不会告诉任何人。' },
    ]);

    renderApp();
    fireEvent.click(await screen.findByTestId('phone-files-hidden-folder-row'));
    fireEvent.change(await screen.findByTestId('phone-files-hidden-password-input'), {
      target: { value: 'LW' },
    });
    fireEvent.click(screen.getByTestId('phone-files-hidden-password-submit'));

    await screen.findByTestId('phone-files-hidden-view');
    fireEvent.click(screen.getByTestId('phone-files-hidden-seed-button'));

    await waitFor(() => {
      expect(screen.getByText('生人面前手会抖')).toBeInTheDocument();
    });
    expect(screen.getByText('偷偷喜欢甜的')).toBeInTheDocument();
    expect(secretAiMock.generateHiddenSeedsWithAI).toHaveBeenCalled();
    expect(secretStoreMock.markHiddenFolderSeedGenerated).toHaveBeenCalledWith('linwu');
  });

  it('「去和 TA 聊聊」把抽屉 entry 暂存到 stagedChatQuote, sourceKind=secret-drawer', async () => {
    // 直接预置一条 entry，跳过种子生成路径
    secretStoreMock.listHiddenEntries.mockResolvedValue([
      {
        id: 'hid-1',
        key: 'hid-1',
        agentId: 'linwu',
        kind: 'weakness',
        title: '生人面前手会抖',
        body: '只在自己人面前不会抖。一直没人发现……',
        source: 'ai_seed',
        createdAt: '2026-05-15T11:00:00.000Z',
        updatedAt: '2026-05-15T11:00:00.000Z',
      },
    ]);
    // seedGenerated=true 让种子按钮不抢焦点
    secretStoreMock.readHiddenFolderState.mockResolvedValue({
      agentId: 'linwu',
      locked: true,
      passwordHash: 'fakehash',
      candidateLabel: '林雾首字母',
      seedGenerated: true,
      updatedAt: '2026-05-15T10:00:00.000Z',
    });

    renderApp();
    fireEvent.click(await screen.findByTestId('phone-files-hidden-folder-row'));
    fireEvent.change(await screen.findByTestId('phone-files-hidden-password-input'), {
      target: { value: 'LW' },
    });
    fireEvent.click(screen.getByTestId('phone-files-hidden-password-submit'));

    await screen.findByTestId('phone-files-hidden-view');
    fireEvent.click(await screen.findByTestId('phone-files-hidden-entry-share-hid-1'));

    expect(storeMockState.stageChatQuote).toHaveBeenCalledTimes(1);
    const arg = storeMockState.stageChatQuote.mock.calls[0][0] as {
      text: string;
      sourceTitle: string;
      sourceKind: string;
      charCount: number;
    };
    expect(arg.sourceKind).toBe('secret-drawer');
    expect(arg.sourceTitle).toBe('抽屉 · 生人面前手会抖');
    expect(arg.text).toContain('[弱点]');
    expect(arg.text).toContain('《生人面前手会抖》');
    expect(arg.text).toContain('只在自己人面前不会抖。一直没人发现……');
    expect(arg.charCount).toBe(arg.text.length);

    // 反馈行可见
    expect(screen.getByTestId('phone-files-hidden-entry-share-notice-hid-1')).toBeInTheDocument();
  });
});
