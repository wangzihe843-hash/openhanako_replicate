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
  buildFallbackMailDrafts: vi.fn(() => []),
  generateMailInitDraftsWithAI: vi.fn(),
  toMailMessageDrafts: vi.fn(() => []),
}));

vi.mock('./xingye-mail-store', () => mailStoreMock);
vi.mock('./xingye-mail-ai', () => mailAiMock);

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
  mailStoreMock.getMailProfile.mockResolvedValue(mailProfile);
  mailStoreMock.listMailMessages.mockResolvedValue([]);
  mailStoreMock.listMailDrafts.mockResolvedValue([]);
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
