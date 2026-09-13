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
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  getPendingNewContacts: vi.fn(() => []),
  getPhoneContactGenerationState: vi.fn(() => null),
  getPhoneContacts: vi.fn(() => []),
  getVirtualContacts: vi.fn(() => []),
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
  collectRecentContextForAgent: vi.fn(() => ({ messages: [], hasOpenHanakoMessages: false })),
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const raceDraft = (id: string) => ({
  id, targetType: 'agent' as const, targetId: 'peer-1',
  action: 'update' as const, patch: { remark: id },
  source: 'xingye-heartbeat-tool', createdAt: '2026-05-17T12:00:00.000Z',
});

const otherOwner = { ...agent, id: 'owner-b', name: 'B' };
const raceAgents = [agent, otherOwner];
const raceProfiles = {};
const raceBack = () => {};
function raceApp(ownerAgent: Agent | null = agent) {
  return <PhoneContactsApp ownerAgent={ownerAgent} agents={raceAgents} profiles={raceProfiles}
    channels={[]} onOpenSms={raceBack} onBack={raceBack} />;
}

describe('PhoneContactsApp · owner and request lifetimes', () => {
  it('loads after StrictMode effect cleanup and ignores the first request', async () => {
    const old = deferred<ReturnType<typeof raceDraft>[]>();
    contactDraftsMock.listPhoneContactDrafts.mockReturnValueOnce(old.promise).mockResolvedValueOnce([raceDraft('strict-current')]);
    render(<React.StrictMode>{raceApp()}</React.StrictMode>);
    await screen.findByTestId('phone-contact-pending-draft-strict-current');
    expect(contactDraftsMock.listPhoneContactDrafts).toHaveBeenCalledTimes(2);
    await act(async () => old.resolve([raceDraft('strict-stale')]));
    expect(screen.getByTestId('phone-contact-pending-draft-strict-current')).toBeInTheDocument();
    expect(screen.queryByTestId('phone-contact-pending-draft-strict-stale')).not.toBeInTheDocument();
  });

  it.each(['resolve', 'reject'] as const)('ignores an old owner list that settles by %s', async (outcome) => {
    const old = deferred<ReturnType<typeof raceDraft>[]>();
    contactDraftsMock.listPhoneContactDrafts.mockReturnValueOnce(old.promise).mockResolvedValueOnce([raceDraft('b')]);
    const view = render(raceApp());
    view.rerender(raceApp(otherOwner));
    await screen.findByTestId('phone-contact-pending-draft-b');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await act(async () => {
      if (outcome === 'resolve') old.resolve([raceDraft('a')]);
      else old.reject(new Error('old list failure'));
    });
    expect(screen.getByTestId('phone-contact-pending-draft-b')).toBeInTheDocument();
    expect(screen.queryByTestId('phone-contact-pending-draft-a')).not.toBeInTheDocument();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('does not revive the first A request after A → B → A', async () => {
    const old = deferred<ReturnType<typeof raceDraft>[]>();
    contactDraftsMock.listPhoneContactDrafts.mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce([raceDraft('b')]).mockResolvedValueOnce([raceDraft('new-a')]);
    const view = render(raceApp());
    view.rerender(raceApp(otherOwner));
    await screen.findByTestId('phone-contact-pending-draft-b');
    view.rerender(raceApp());
    expect(screen.queryByTestId('phone-contact-pending-draft-b')).not.toBeInTheDocument();
    await screen.findByTestId('phone-contact-pending-draft-new-a');
    await act(async () => old.resolve([raceDraft('old-a')]));
    expect(screen.getByTestId('phone-contact-pending-draft-new-a')).toBeInTheDocument();
    expect(screen.queryByTestId('phone-contact-pending-draft-old-a')).not.toBeInTheDocument();
  });

  it.each(['resolve', 'reject'] as const)('keeps the latest same-owner storage refresh when the older read %s settles', async (outcome) => {
    const old = deferred<ReturnType<typeof raceDraft>[]>();
    contactDraftsMock.listPhoneContactDrafts.mockReturnValueOnce(old.promise).mockResolvedValueOnce([raceDraft('latest')]);
    const view = render(raceApp());
    const contactReads = phoneStoreMock.getPhoneContacts.mock.calls.length;
    const dependentReads = phoneStoreMock.getPendingNewContacts.mock.calls.length;
    phoneStoreMock.useXingyePhoneStorageVersion.mockReturnValue(1);
    view.rerender(raceApp());
    await screen.findByTestId('phone-contact-pending-draft-latest');
    expect(phoneStoreMock.getPhoneContacts.mock.calls.length).toBeGreaterThan(contactReads);
    expect(phoneStoreMock.getPendingNewContacts.mock.calls.length).toBeGreaterThan(dependentReads);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await act(async () => {
      if (outcome === 'resolve') old.resolve([raceDraft('stale')]);
      else old.reject(new Error('stale failure'));
    });
    expect(screen.getByTestId('phone-contact-pending-draft-latest')).toBeInTheDocument();
    expect(screen.queryByTestId('phone-contact-pending-draft-stale')).not.toBeInTheDocument();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it.each([
    ['confirm', 'success'], ['confirm', 'failure'],
    ['discard', 'success'], ['discard', 'missing'], ['discard', 'failure'],
  ] as const)('ignores late %s %s after returning to the same owner', async (action, outcome) => {
    const oldAction = deferred<boolean>();
    const currentAction = deferred<boolean>();
    const actionMock = action === 'confirm' ? contactDraftsMock.confirmPhoneContactDraft : contactDraftsMock.discardPhoneContactDraft;
    actionMock.mockReturnValueOnce(oldAction.promise).mockReturnValueOnce(currentAction.promise);
    contactDraftsMock.listPhoneContactDrafts.mockResolvedValue([raceDraft('shared')]);

    const view = render(raceApp());
    await screen.findByTestId('phone-contact-pending-draft-shared');
    fireEvent.click(screen.getByTestId('phone-contact-pending-draft-' + action + '-shared'));
    view.rerender(raceApp(otherOwner));
    await screen.findByTestId('phone-contact-pending-draft-shared');
    view.rerender(raceApp());
    await screen.findByTestId('phone-contact-pending-draft-shared');
    expect(screen.getByTestId('phone-contact-pending-draft-confirm-shared')).toBeEnabled();
    fireEvent.click(screen.getByTestId('phone-contact-pending-draft-' + action + '-shared'));
    const reads = contactDraftsMock.listPhoneContactDrafts.mock.calls.length;
    const followups = phoneAiMock.generateSmsUpdatesForChangedContactsWithAI.mock.calls.length;
    await act(async () => {
      if (outcome === 'failure') oldAction.reject(new Error('previous owner failed'));
      else oldAction.resolve(outcome === 'success');
    });
    expect(screen.getByTestId('phone-contact-pending-draft-shared')).toBeInTheDocument();
    expect(screen.getByTestId('phone-contact-pending-draft-confirm-shared')).toBeDisabled();
    expect(screen.queryByText('previous owner failed')).not.toBeInTheDocument();
    expect(contactDraftsMock.listPhoneContactDrafts).toHaveBeenCalledTimes(reads);
    expect(phoneAiMock.generateSmsUpdatesForChangedContactsWithAI).toHaveBeenCalledTimes(followups);
    await act(async () => currentAction.resolve(true));
    expect(screen.queryByTestId('phone-contact-pending-draft-shared')).not.toBeInTheDocument();

  });

  it('does not reload or start follow-up actions after unmount', async () => {
    const action = deferred<boolean>();
    contactDraftsMock.listPhoneContactDrafts.mockResolvedValue([raceDraft('unmount')]);
    contactDraftsMock.discardPhoneContactDraft.mockReturnValueOnce(action.promise);

    const view = render(raceApp());
    await screen.findByTestId('phone-contact-pending-draft-unmount');
    fireEvent.click(screen.getByTestId('phone-contact-pending-draft-discard-unmount'));
    view.unmount();
    await act(async () => action.resolve(false));
    expect(contactDraftsMock.listPhoneContactDrafts).toHaveBeenCalledTimes(1);

  });

  it.each([
    ['confirm', 'before'], ['confirm', 'during'],
    ['discard', 'before'], ['discard', 'during'],
  ] as const)('keeps new drafts from a refresh started %s / %s without reviving the handled draft', async (actionName, refreshTiming) => {
    const action = deferred<boolean>();
    const staleRead = deferred<ReturnType<typeof raceDraft>[]>();
    contactDraftsMock.listPhoneContactDrafts.mockResolvedValueOnce([raceDraft('confirmed')]).mockReturnValueOnce(staleRead.promise);
    const actionMock = actionName === 'confirm' ? contactDraftsMock.confirmPhoneContactDraft : contactDraftsMock.discardPhoneContactDraft;
    actionMock.mockReturnValueOnce(action.promise);

    const view = render(raceApp());
    await screen.findByTestId('phone-contact-pending-draft-confirmed');
    const refresh = () => {
      phoneStoreMock.useXingyePhoneStorageVersion.mockReturnValue(1);
      view.rerender(raceApp());
    };
    if (refreshTiming === 'before') refresh();
    fireEvent.click(screen.getByTestId('phone-contact-pending-draft-' + actionName + '-confirmed'));
    if (refreshTiming === 'during') refresh();
    await act(async () => action.resolve(true));
    await act(async () => staleRead.resolve([raceDraft('confirmed'), raceDraft('new-independent')]));
    expect(screen.queryByTestId('phone-contact-pending-draft-confirmed')).not.toBeInTheDocument();
    expect(screen.getByTestId('phone-contact-pending-draft-new-independent')).toBeInTheDocument();
    // A helper may report success even if removing the persisted draft failed.
    // Later reads must still hide that handled ID while accepting fresh drafts.
    contactDraftsMock.listPhoneContactDrafts.mockResolvedValueOnce([raceDraft('confirmed'), raceDraft('another-new')]);
    phoneStoreMock.useXingyePhoneStorageVersion.mockReturnValue(2);
    view.rerender(raceApp());
    await screen.findByTestId('phone-contact-pending-draft-another-new');
    expect(screen.queryByTestId('phone-contact-pending-draft-confirmed')).not.toBeInTheDocument();

  });
});


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
  phoneStoreMock.useXingyePhoneStorageVersion.mockReturnValue(0);
  vi.clearAllMocks();
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
