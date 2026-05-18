/**
 * @vitest-environment jsdom
 *
 * 覆盖「心跳巡检 → 待确认通讯录草稿」的 UI 链路（仅 pending-draft section）：
 *   1. 无 pending drafts → 不渲染 section
 *   2. listPhoneContactDrafts 返回的 update 草稿渲染 → 点采纳 → confirmPhoneContactDraft
 *      被调，草稿从 UI 移除
 *   3. 点丢弃 → discardPhoneContactDraft 被调，草稿移除且不调 confirm
 *   4. 多个 action（add/update/block/delete/restore）各自渲染对应按钮文案
 *
 * 通讯录 App 依赖很广（useStore + 整个 phone-store + 多个 PhoneContacts*View 子组件），
 * 这里把 store / AI / 子组件都桩成 noop，只保留 pending-draft 段的真实 DOM。
 */

import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../types';

const contactDraftsMock = vi.hoisted(() => ({
  confirmPhoneContactDraft: vi.fn(),
  discardPhoneContactDraft: vi.fn(),
  listPhoneContactDrafts: vi.fn(),
}));

const phoneStoreMock = vi.hoisted(() => ({
  blockPhoneContact: vi.fn(),
  deletePhoneContact: vi.fn(),
  getContactAiUpdateState: vi.fn(() => null),
  getPhoneContactGenerationState: vi.fn(() => null),
  getPhoneContacts: vi.fn(() => []),
  getPhoneAiGenerationState: vi.fn(() => null),
  getPhoneProfileFingerprint: vi.fn(() => 'fp-1'),
  linkVirtualContactToAgent: vi.fn(),
  restorePhoneContact: vi.fn(),
  savePhoneContactMeta: vi.fn(),
  computePhoneContactGenerationInputHash: vi.fn(() => 'h-1'),
  shouldAutoSkipVirtualContactGeneration: vi.fn(() => false),
  unlinkVirtualContactFromAgent: vi.fn(),
  useXingyePhoneStorageVersion: vi.fn(() => 0),
}));

/**
 * 桩 AI helpers——PhoneContactsApp 在 mount 时若 virtualContacts 为空会主动调
 * generateVirtualContactsWithAI(...)，需要返回真实 Promise 否则 `.then` 报错。
 */
const phoneAiMock = vi.hoisted(() => ({
  enrichContactsWithAI: vi.fn(async () => ({ generatedBy: 'ai', notice: null })),
  generateSmsUpdatesForChangedContactsWithAI: vi.fn(async () => undefined),
  generateVirtualContactsWithAI: vi.fn(async () => ({ generatedBy: 'ai', notice: null })),
  regenerateAllContactsWithAI: vi.fn(async () => ({ generatedBy: 'ai', notice: null })),
  rollbackAndUpdateContactsWithAI: vi.fn(async () => ({ generatedBy: 'ai', notice: null })),
  updateContactsFromRecentContextWithAI: vi.fn(async () => ({ generatedBy: 'ai', notice: null })),
}));

const profileMock = vi.hoisted(() => ({
  useXingyeRoleProfile: vi.fn(() => null),
}));

const recentContextMock = vi.hoisted(() => ({
  collectRecentContextForAgent: vi.fn(() => ({ items: [], lastEventAt: null })),
}));

const storesMock = vi.hoisted(() => ({
  useStore: vi.fn(() => 0),
}));

vi.mock('./xingye-phone-contact-drafts', () => contactDraftsMock);
vi.mock('./xingye-phone-store', () => phoneStoreMock);
vi.mock('./xingye-phone-ai', () => phoneAiMock);
vi.mock('./xingye-profile-store', () => profileMock);
vi.mock('./xingye-recent-context', () => recentContextMock);
vi.mock('../stores', () => storesMock);
/** 子视图都桩成 noop——pending-draft 段在 home view 直接渲染。 */
vi.mock('./PhoneContactsSectionView', () => ({
  PhoneContactsBlockedView: () => null,
  PhoneContactsDeletedView: () => null,
  PhoneContactsFactionsHomeView: () => null,
  PhoneContactsFactionDetailView: () => null,
  PhoneContactsGroupsView: () => null,
  PhoneContactsNewFriendsView: () => null,
  PhoneContactsTagDetailView: () => null,
  PhoneContactsTagsHomeView: () => null,
}));
vi.mock('./PhoneContactDetail', () => ({ PhoneContactDetail: () => null }));
vi.mock('./PhoneContactSections', () => ({ PhoneContactSections: () => null }));

import { PhoneContactsApp } from './PhoneContactsApp';

const agent: Agent = {
  id: 'linwu',
  name: '林雾',
  yuan: 'hanako',
  isPrimary: false,
  hasAvatar: false,
};

function renderContactsApp() {
  return render(
    <PhoneContactsApp
      ownerAgent={agent}
      agents={[agent]}
      profiles={{}}
      channels={[]}
      onBack={vi.fn()}
      onOpenSms={vi.fn()}
    />,
  );
}

beforeEach(() => {
  contactDraftsMock.confirmPhoneContactDraft.mockReset();
  contactDraftsMock.discardPhoneContactDraft.mockReset();
  contactDraftsMock.listPhoneContactDrafts.mockReset();
  contactDraftsMock.listPhoneContactDrafts.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
});

describe('PhoneContactsApp · pending draft section', () => {
  it('does not render the draft section when there are no pending drafts', async () => {
    renderContactsApp();
    await waitFor(() => {
      expect(contactDraftsMock.listPhoneContactDrafts).toHaveBeenCalledWith('linwu');
    });
    expect(screen.queryByTestId('phone-contact-pending-drafts')).not.toBeInTheDocument();
  });

  it('confirm for an update draft calls confirmPhoneContactDraft and removes the card', async () => {
    contactDraftsMock.listPhoneContactDrafts.mockResolvedValueOnce([
      {
        id: 'd-pc-1',
        action: 'update' as const,
        targetType: 'agent' as const,
        targetId: 'peer-1',
        displayName: '同事 A',
        patch: { remark: '同事 A · 老朋友' },
        reason: '巡检看到最近几次聊天对方主动联系',
        source: 'xingye-heartbeat-tool',
        createdAt: '2026-05-17T12:00:00.000Z',
      },
    ]);
    contactDraftsMock.confirmPhoneContactDraft.mockResolvedValueOnce(undefined);

    renderContactsApp();
    await screen.findByTestId('phone-contact-pending-draft-d-pc-1');

    fireEvent.click(screen.getByTestId('phone-contact-pending-draft-confirm-d-pc-1'));

    await waitFor(() => {
      expect(contactDraftsMock.confirmPhoneContactDraft).toHaveBeenCalledWith('linwu', 'd-pc-1');
    });
    await waitFor(() => {
      expect(screen.queryByTestId('phone-contact-pending-draft-d-pc-1')).not.toBeInTheDocument();
    });
    expect(contactDraftsMock.discardPhoneContactDraft).not.toHaveBeenCalled();
  });

  it('discard calls discardPhoneContactDraft and does not call confirm', async () => {
    contactDraftsMock.listPhoneContactDrafts.mockResolvedValueOnce([
      {
        id: 'd-pc-2',
        action: 'block' as const,
        targetType: 'virtual_contact' as const,
        targetId: 'vc-7',
        displayName: '陌生联系人',
        reason: '反复骚扰',
        source: 'xingye-heartbeat-tool',
        createdAt: '2026-05-17T12:00:00.000Z',
      },
    ]);
    contactDraftsMock.discardPhoneContactDraft.mockResolvedValueOnce(true);

    renderContactsApp();
    await screen.findByTestId('phone-contact-pending-draft-d-pc-2');

    fireEvent.click(screen.getByTestId('phone-contact-pending-draft-discard-d-pc-2'));

    await waitFor(() => {
      expect(contactDraftsMock.discardPhoneContactDraft).toHaveBeenCalledWith('linwu', 'd-pc-2');
    });
    await waitFor(() => {
      expect(screen.queryByTestId('phone-contact-pending-draft-d-pc-2')).not.toBeInTheDocument();
    });
    expect(contactDraftsMock.confirmPhoneContactDraft).not.toHaveBeenCalled();
  });

  it('renders action-specific button labels (add / block / delete / restore / update)', async () => {
    contactDraftsMock.listPhoneContactDrafts.mockResolvedValueOnce([
      {
        id: 'd-pc-add',  action: 'add'    as const, targetType: 'virtual_contact' as const,
        contact: { kind: 'virtual_contact', displayName: '新邻居' },
        source: 'xingye-heartbeat-tool', createdAt: '2026-05-17T12:00:00.000Z',
      },
      {
        id: 'd-pc-up',   action: 'update'  as const, targetType: 'agent' as const, targetId: 'peer-1',
        patch: { remark: 'new remark' },
        source: 'xingye-heartbeat-tool', createdAt: '2026-05-17T12:00:00.000Z',
      },
      {
        id: 'd-pc-bl',   action: 'block'   as const, targetType: 'virtual_contact' as const, targetId: 'vc-3',
        source: 'xingye-heartbeat-tool', createdAt: '2026-05-17T12:00:00.000Z',
      },
      {
        id: 'd-pc-del',  action: 'delete'  as const, targetType: 'virtual_contact' as const, targetId: 'vc-4',
        source: 'xingye-heartbeat-tool', createdAt: '2026-05-17T12:00:00.000Z',
      },
      {
        id: 'd-pc-res',  action: 'restore' as const, targetType: 'virtual_contact' as const, targetId: 'vc-5',
        source: 'xingye-heartbeat-tool', createdAt: '2026-05-17T12:00:00.000Z',
      },
    ]);

    renderContactsApp();
    await screen.findByTestId('phone-contact-pending-draft-d-pc-add');

    /** 5 个 action 对应 5 种采纳按钮文案——验证 draftConfirmButtonLabel 走通了。 */
    expect(screen.getByTestId('phone-contact-pending-draft-confirm-d-pc-add')).toHaveTextContent('采纳新增');
    expect(screen.getByTestId('phone-contact-pending-draft-confirm-d-pc-up')).toHaveTextContent('采纳建议');
    expect(screen.getByTestId('phone-contact-pending-draft-confirm-d-pc-bl')).toHaveTextContent('采纳拉黑');
    expect(screen.getByTestId('phone-contact-pending-draft-confirm-d-pc-del')).toHaveTextContent('采纳删除');
    expect(screen.getByTestId('phone-contact-pending-draft-confirm-d-pc-res')).toHaveTextContent('采纳恢复');
  });
});
