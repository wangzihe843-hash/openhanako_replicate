/**
 * @vitest-environment jsdom
 *
 * 覆盖「心跳巡检 → 待确认短信草稿」的 UI 链路（仅 pending-draft section）：
 *   1. 无 pending drafts → 不渲染 section
 *   2. listSmsDrafts 返回的草稿渲染 → 点确认 → confirmSmsDraft 拿到 (targetType,
 *      targetId, content)，草稿从 UI 移除
 *   3. 点丢弃（window.confirm=true）→ discardSmsDraft 被调，草稿移除且不调 confirm
 *   4. 取消 window.confirm → 草稿保留，不调 discardSmsDraft
 *
 * 与 PhoneMailApp.test.tsx 同款 mock 策略，但 SMS app 依赖更多（phone-store / phone-ai
 * 都得桩）；这里只覆盖 pending-draft section 必需的最小集合。
 */

import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../types';

const smsDraftsMock = vi.hoisted(() => ({
  confirmSmsDraft: vi.fn(),
  discardSmsDraft: vi.fn(),
  listSmsDrafts: vi.fn(),
  SMS_DRAFT_ALLOWED_TARGET_TYPES: ['agent', 'virtual_contact'] as const,
}));

/**
 * xingye-phone-store 被 PhoneSmsApp 大面积使用——我们只关心草稿区，所以这里把它整个
 * 桩成"什么都没有"的形态：联系人 1 个、threads 空、fingerprint 字符串、状态 null。
 */
const phoneStoreMock = vi.hoisted(() => ({
  addMockSmsMessage: vi.fn(),
  clearAiSmsHistory: vi.fn(),
  getPhoneContacts: vi.fn(() => [
    {
      targetType: 'agent' as const,
      targetId: 'peer-1',
      displayName: '同事 A',
      remark: '同事 A',
      status: 'active' as const,
    },
  ]),
  getPhoneAiGenerationState: vi.fn(() => null),
  getPhoneProfileFingerprint: vi.fn(() => 'fp-1'),
  getSmsHistoryGenerationState: vi.fn(() => ({ generatedAt: '2026-05-17T00:00:00.000Z' })),
  getSmsThread: vi.fn(() => null),
  getSmsThreads: vi.fn(() => []),
  useXingyePhoneStorageVersion: vi.fn(() => 0),
}));

const phoneAiMock = vi.hoisted(() => ({
  generateSmsHistoryWithAI: vi.fn(),
  generateSmsUpdatesForChangedContactsWithAI: vi.fn(),
}));

const profileMock = vi.hoisted(() => ({
  useXingyeRoleProfile: vi.fn(() => null),
}));

vi.mock('./xingye-sms-drafts', () => smsDraftsMock);
vi.mock('./xingye-phone-store', () => phoneStoreMock);
vi.mock('./xingye-phone-ai', () => phoneAiMock);
vi.mock('./xingye-profile-store', () => profileMock);
vi.mock('./XingyeAgentAvatar', () => ({
  XingyeAgentAvatar: () => null,
}));

import { PhoneSmsApp } from './PhoneSmsApp';

const agent: Agent = {
  id: 'linwu',
  name: '林雾',
  yuan: 'hanako',
  isPrimary: false,
  hasAvatar: false,
};

function renderSmsApp() {
  return render(
    <PhoneSmsApp
      ownerAgent={agent}
      agents={[agent]}
      profiles={{}}
      onBack={vi.fn()}
    />,
  );
}

beforeEach(() => {
  smsDraftsMock.confirmSmsDraft.mockReset();
  smsDraftsMock.discardSmsDraft.mockReset();
  smsDraftsMock.listSmsDrafts.mockReset();
  smsDraftsMock.listSmsDrafts.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
});

describe('PhoneSmsApp · pending draft section', () => {
  it('does not render the draft section when there are no pending drafts', async () => {
    renderSmsApp();
    await waitFor(() => {
      expect(smsDraftsMock.listSmsDrafts).toHaveBeenCalledWith('linwu');
    });
    expect(screen.queryByTestId('phone-sms-pending-drafts')).not.toBeInTheDocument();
  });

  it('confirm forwards (targetType, targetId, content) to confirmSmsDraft and removes the draft', async () => {
    smsDraftsMock.listSmsDrafts.mockResolvedValueOnce([
      {
        id: 'd-sms-1',
        targetType: 'agent' as const,
        targetId: 'peer-1',
        displayName: '同事 A',
        content: '今晚还来吗？',
        reason: '巡检看到上次聊天 TA 提到今晚见面但还没确认',
        source: 'xingye-heartbeat-tool',
        createdAt: '2026-05-17T12:00:00.000Z',
      },
    ]);
    smsDraftsMock.confirmSmsDraft.mockResolvedValueOnce(undefined);

    renderSmsApp();
    await screen.findByTestId('phone-sms-pending-draft-d-sms-1');

    fireEvent.click(screen.getByTestId('phone-sms-pending-draft-confirm-d-sms-1'));

    await waitFor(() => {
      expect(smsDraftsMock.confirmSmsDraft).toHaveBeenCalledWith(
        'linwu',
        'd-sms-1',
        expect.objectContaining({
          targetType: 'agent',
          targetId: 'peer-1',
          content: '今晚还来吗？',
        }),
      );
    });
    await waitFor(() => {
      expect(screen.queryByTestId('phone-sms-pending-draft-d-sms-1')).not.toBeInTheDocument();
    });
    expect(smsDraftsMock.discardSmsDraft).not.toHaveBeenCalled();
  });

  it('discard calls discardSmsDraft and removes the draft (window.confirm=true)', async () => {
    smsDraftsMock.listSmsDrafts.mockResolvedValueOnce([
      {
        id: 'd-sms-2',
        targetType: 'agent' as const,
        targetId: 'peer-1',
        displayName: '同事 A',
        content: '可能改约。',
        source: 'xingye-heartbeat-tool',
        createdAt: '2026-05-17T12:00:00.000Z',
      },
    ]);
    smsDraftsMock.discardSmsDraft.mockResolvedValueOnce(true);
    vi.spyOn(window, 'confirm').mockReturnValueOnce(true);

    renderSmsApp();
    await screen.findByTestId('phone-sms-pending-draft-d-sms-2');

    fireEvent.click(screen.getByTestId('phone-sms-pending-draft-discard-d-sms-2'));

    await waitFor(() => {
      expect(smsDraftsMock.discardSmsDraft).toHaveBeenCalledWith('linwu', 'd-sms-2');
    });
    await waitFor(() => {
      expect(screen.queryByTestId('phone-sms-pending-draft-d-sms-2')).not.toBeInTheDocument();
    });
    expect(smsDraftsMock.confirmSmsDraft).not.toHaveBeenCalled();
  });

  it('discard aborts when user cancels window.confirm', async () => {
    smsDraftsMock.listSmsDrafts.mockResolvedValueOnce([
      {
        id: 'd-sms-3',
        targetType: 'agent' as const,
        targetId: 'peer-1',
        displayName: '同事 A',
        content: '别管这条。',
        source: 'xingye-heartbeat-tool',
        createdAt: '2026-05-17T12:00:00.000Z',
      },
    ]);
    vi.spyOn(window, 'confirm').mockReturnValueOnce(false);

    renderSmsApp();
    await screen.findByTestId('phone-sms-pending-draft-d-sms-3');

    fireEvent.click(screen.getByTestId('phone-sms-pending-draft-discard-d-sms-3'));

    expect(smsDraftsMock.discardSmsDraft).not.toHaveBeenCalled();
    expect(screen.getByTestId('phone-sms-pending-draft-d-sms-3')).toBeInTheDocument();
  });
});
