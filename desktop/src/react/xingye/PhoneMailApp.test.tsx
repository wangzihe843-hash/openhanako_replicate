/**
 * @vitest-environment jsdom
 *
 * 覆盖「心跳巡检 → 待确认邮件草稿」的 UI 链路：
 *   1. listMailDrafts 返回的草稿渲染在 phone-mail-pending-drafts 段
 *   2. 行内编辑 → 点确认 → confirmMailDraft 收到改后的字段，草稿从 UI 移除
 *   3. 点丢弃（window.confirm=true）→ discardMailDraft 被调，草稿移除且不调 confirm
 */

import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../types';

const mailStoreMock = vi.hoisted(() => ({
  appendMailMessage: vi.fn(),
  appendMailMessages: vi.fn(),
  confirmMailDraft: vi.fn(),
  deleteMailMessage: vi.fn(),
  discardMailDraft: vi.fn(),
  ensureMailProfile: vi.fn(),
  getMailProfile: vi.fn(),
  listMailDrafts: vi.fn(),
  listMailMessages: vi.fn(),
  setMailMessageStar: vi.fn(),
  updateMailMessage: vi.fn(),
  XINGYE_MAIL_DOMAIN: 'xingye.mail',
  XINGYE_MAIL_MAILBOXES: ['inbox', 'sent', 'drafts', 'promotions', 'spam'] as const,
}));

const mailAiMock = vi.hoisted(() => ({
  buildFallbackMailDrafts: vi.fn((): unknown[] => []),
  generateMailInitDraftsWithAI: vi.fn(),
  toMailMessageDrafts: vi.fn((): unknown[] => []),
}));

const historyStateMock = vi.hoisted(() => ({
  loadHistoryState: vi.fn(),
  saveHistoryState: vi.fn(),
}));

vi.mock('./xingye-mail-store', () => mailStoreMock);
vi.mock('./xingye-mail-ai', () => mailAiMock);
vi.mock('./xingye-app-history-state', () => historyStateMock);

import { PhoneMailApp } from './PhoneMailApp';

const agent: Agent = {
  id: 'linwu',
  name: '林雾',
  yuan: 'hanako',
  isPrimary: false,
  hasAvatar: false,
};

const mailProfile = {
  agentId: 'linwu',
  address: 'linwu@xingye.mail',
  displayName: '林雾',
  createdAt: '2026-05-15T10:00:00.000Z',
  updatedAt: '2026-05-15T10:00:00.000Z',
};

function renderMailApp() {
  return render(
    <PhoneMailApp ownerAgent={agent} displayName="林雾" onBack={vi.fn()} />,
  );
}

beforeEach(() => {
  for (const fn of Object.values(mailStoreMock)) {
    if (typeof fn === 'function' && 'mockReset' in fn) (fn as ReturnType<typeof vi.fn>).mockReset();
  }
  for (const fn of Object.values(mailAiMock)) {
    if (typeof fn === 'function' && 'mockReset' in fn) (fn as ReturnType<typeof vi.fn>).mockReset();
  }
  historyStateMock.loadHistoryState.mockReset();
  historyStateMock.saveHistoryState.mockReset();
  mailStoreMock.getMailProfile.mockResolvedValue(mailProfile);
  mailStoreMock.listMailMessages.mockResolvedValue([]);
  mailStoreMock.listMailDrafts.mockResolvedValue([]);
  // 默认「已初始化过」，让首次打开自动 bootstrap 对绝大多数已有用例保持沉默；
  // 需要测 bootstrap 的用例自己改成未初始化。
  historyStateMock.loadHistoryState.mockResolvedValue({
    version: 1,
    initializedAt: '2026-05-15T10:00:00.000Z',
  });
  historyStateMock.saveHistoryState.mockResolvedValue({ version: 1 });
  // mailAiMock 被 mockReset 清掉了默认实现，这里补回（fallback 默认返回空，避免误触发）。
  mailAiMock.buildFallbackMailDrafts.mockReturnValue([]);
  mailAiMock.toMailMessageDrafts.mockReturnValue([]);
});

afterEach(() => {
  cleanup();
});

describe('PhoneMailApp · pending draft section', () => {
  it('does not render the draft section when there are no pending drafts', async () => {
    renderMailApp();
    await waitFor(() => {
      expect(mailStoreMock.listMailDrafts).toHaveBeenCalledWith('linwu');
    });
    expect(screen.queryByTestId('phone-mail-pending-drafts')).not.toBeInTheDocument();
  });

  it('renders a draft and confirm forwards inline-edited fields to confirmMailDraft', async () => {
    mailStoreMock.listMailDrafts.mockResolvedValueOnce([
      {
        id: 'd-1',
        subject: '原主题',
        body: '原正文',
        toAddress: 'someone@xingye.mail',
        reason: '巡检里反复提起这件事',
        source: 'xingye-heartbeat-tool',
        createdAt: '2026-05-17T12:00:00.000Z',
      },
    ]);
    mailStoreMock.confirmMailDraft.mockResolvedValueOnce({
      id: 'msg-1',
      mailbox: 'drafts',
      subject: '改过的主题',
      body: '改过的正文',
      createdAt: '2026-05-17T12:30:00.000Z',
      isRead: true,
      isStarred: false,
    });

    renderMailApp();

    const draftCard = await screen.findByTestId('phone-mail-pending-draft-d-1');
    expect(within(draftCard).getByText(/巡检里反复提起这件事/)).toBeInTheDocument();

    fireEvent.change(screen.getByTestId('phone-mail-pending-draft-subject-d-1'), {
      target: { value: '改过的主题' },
    });
    fireEvent.change(screen.getByTestId('phone-mail-pending-draft-body-d-1'), {
      target: { value: '改过的正文' },
    });

    fireEvent.click(screen.getByTestId('phone-mail-pending-draft-confirm-d-1'));

    await waitFor(() => {
      expect(mailStoreMock.confirmMailDraft).toHaveBeenCalledWith(
        'linwu',
        'd-1',
        mailProfile,
        expect.objectContaining({
          subject: '改过的主题',
          body: '改过的正文',
          toAddress: 'someone@xingye.mail',
        }),
      );
    });

    await waitFor(() => {
      expect(screen.queryByTestId('phone-mail-pending-draft-d-1')).not.toBeInTheDocument();
    });
  });

  it('discard calls discardMailDraft and removes the draft without calling confirm', async () => {
    mailStoreMock.listMailDrafts.mockResolvedValueOnce([
      {
        id: 'd-2',
        subject: 'maybe',
        body: 'not sure',
        source: 'xingye-heartbeat-tool',
        createdAt: '2026-05-17T12:00:00.000Z',
      },
    ]);
    mailStoreMock.discardMailDraft.mockResolvedValueOnce(true);
    const originalConfirm = window.confirm;
    window.confirm = vi.fn(() => true);

    try {
      renderMailApp();
      await screen.findByTestId('phone-mail-pending-draft-d-2');
      fireEvent.click(screen.getByTestId('phone-mail-pending-draft-discard-d-2'));

      await waitFor(() => {
        expect(mailStoreMock.discardMailDraft).toHaveBeenCalledWith('linwu', 'd-2');
      });
      await waitFor(() => {
        expect(screen.queryByTestId('phone-mail-pending-draft-d-2')).not.toBeInTheDocument();
      });
      /** discard 路径不能误调 confirm（防止草稿"假丢弃但又落库"）。 */
      expect(mailStoreMock.confirmMailDraft).not.toHaveBeenCalled();
    } finally {
      window.confirm = originalConfirm;
    }
  });

  it('discard aborts when user cancels the window.confirm dialog', async () => {
    mailStoreMock.listMailDrafts.mockResolvedValueOnce([
      {
        id: 'd-3',
        subject: 'still here',
        body: 'still here',
        source: 'xingye-heartbeat-tool',
        createdAt: '2026-05-17T12:00:00.000Z',
      },
    ]);
    const originalConfirm = window.confirm;
    window.confirm = vi.fn(() => false);

    try {
      renderMailApp();
      await screen.findByTestId('phone-mail-pending-draft-d-3');
      fireEvent.click(screen.getByTestId('phone-mail-pending-draft-discard-d-3'));

      /** Dialog cancelled → store untouched, draft still visible. */
      expect(mailStoreMock.discardMailDraft).not.toHaveBeenCalled();
      expect(screen.getByTestId('phone-mail-pending-draft-d-3')).toBeInTheDocument();
    } finally {
      window.confirm = originalConfirm;
    }
  });
});

describe('PhoneMailApp · 首次打开自动初始化', () => {
  const aiDrafts = [
    {
      mailbox: 'inbox',
      from: { name: '爱丽丝', address: 'alice@hana.mail', kind: 'virtual_contact' },
      subject: '周末喝茶',
      body: '想约你周末喝茶。',
      isRead: false,
      isStarred: false,
      autoStarred: false,
      labels: [],
    },
  ];
  const messageDrafts = [
    {
      mailbox: 'inbox',
      from: { name: '爱丽丝', address: 'alice@hana.mail', kind: 'virtual_contact' },
      to: [],
      subject: '周末喝茶',
      body: '想约你周末喝茶。',
    },
  ];
  const stored = [
    {
      id: 'm1',
      key: 'm1',
      agentId: 'linwu',
      mailbox: 'inbox',
      from: { name: '爱丽丝', address: 'alice@hana.mail', kind: 'virtual_contact' },
      to: [],
      subject: '周末喝茶',
      body: '想约你周末喝茶。',
      isRead: false,
      isStarred: false,
      labels: [],
      createdAt: '2026-05-20T00:00:00.000Z',
      updatedAt: '2026-05-20T00:00:00.000Z',
    },
  ];

  it('未初始化 + 邮箱空 → 自动生成历史邮件并写 initializedAt', async () => {
    historyStateMock.loadHistoryState.mockResolvedValue({ version: 1 }); // 无 initializedAt
    mailStoreMock.ensureMailProfile.mockResolvedValue(mailProfile);
    mailAiMock.generateMailInitDraftsWithAI.mockResolvedValue(aiDrafts);
    mailAiMock.toMailMessageDrafts.mockReturnValue(messageDrafts);
    mailStoreMock.appendMailMessages.mockResolvedValue(stored);

    renderMailApp();

    await waitFor(() => {
      expect(mailAiMock.generateMailInitDraftsWithAI).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(mailStoreMock.appendMailMessages).toHaveBeenCalledWith('linwu', messageDrafts);
    });
    await waitFor(() => {
      expect(historyStateMock.saveHistoryState).toHaveBeenCalledWith(
        'linwu',
        'mail',
        expect.objectContaining({ initializedAt: expect.any(String) }),
      );
    });
  });

  it('已初始化（initializedAt 存在）→ 不自动生成', async () => {
    historyStateMock.loadHistoryState.mockResolvedValue({
      version: 1,
      initializedAt: '2026-05-15T10:00:00.000Z',
    });
    mailAiMock.generateMailInitDraftsWithAI.mockResolvedValue(aiDrafts);

    renderMailApp();

    await waitFor(() => {
      expect(historyStateMock.loadHistoryState).toHaveBeenCalledWith('linwu', 'mail');
    });
    // loadHistoryState 已结算；若要触发生成会在下一拍发生，给微任务一点时间后断言「未触发」。
    await Promise.resolve();
    await Promise.resolve();
    expect(mailAiMock.generateMailInitDraftsWithAI).not.toHaveBeenCalled();
  });

  it('邮箱已有邮件 → 不自动生成（即便未写 initializedAt）', async () => {
    historyStateMock.loadHistoryState.mockResolvedValue({ version: 1 });
    mailStoreMock.listMailMessages.mockResolvedValue(stored);
    mailAiMock.generateMailInitDraftsWithAI.mockResolvedValue(aiDrafts);

    renderMailApp();

    await waitFor(() => {
      expect(mailStoreMock.listMailMessages).toHaveBeenCalledWith('linwu');
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(mailAiMock.generateMailInitDraftsWithAI).not.toHaveBeenCalled();
  });
});
