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
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const raceDraft = (id: string) => ({
  id, targetType: 'agent' as const, targetId: 'peer-1',
  content: id,
  source: 'xingye-heartbeat-tool', createdAt: '2026-05-17T12:00:00.000Z',
});

const otherOwner = { ...agent, id: 'owner-b', name: 'B' };
const raceAgents = [agent, otherOwner];
const raceProfiles = {};
const raceBack = () => {};
function raceApp(ownerAgent: Agent | null = agent) {
  return <PhoneSmsApp ownerAgent={ownerAgent} agents={raceAgents} profiles={raceProfiles}
     onBack={raceBack} />;
}

describe('PhoneSmsApp · owner and request lifetimes', () => {
  it('drops edits immediately on owner change even when draft ids are reused', async () => {
    const nextList = deferred<ReturnType<typeof raceDraft>[]>();
    smsDraftsMock.listSmsDrafts.mockResolvedValueOnce([raceDraft('shared')]).mockReturnValueOnce(nextList.promise);
    const view = render(raceApp());
    const content = await screen.findByTestId('phone-sms-pending-draft-content-shared');
    fireEvent.change(content, { target: { value: 'private A edit' } });
    view.rerender(raceApp(otherOwner));
    expect(screen.queryByTestId('phone-sms-pending-drafts')).not.toBeInTheDocument();
    await act(async () => nextList.resolve([{ ...raceDraft('shared'), content: 'B original' }]));
    expect(screen.getByTestId('phone-sms-pending-draft-content-shared')).toHaveValue('B original');
  });

  it('loads after StrictMode effect cleanup and ignores the first request', async () => {
    const old = deferred<ReturnType<typeof raceDraft>[]>();
    smsDraftsMock.listSmsDrafts.mockReturnValueOnce(old.promise).mockResolvedValueOnce([raceDraft('strict-current')]);
    render(<React.StrictMode>{raceApp()}</React.StrictMode>);
    await screen.findByTestId('phone-sms-pending-draft-strict-current');
    expect(smsDraftsMock.listSmsDrafts).toHaveBeenCalledTimes(2);
    await act(async () => old.resolve([raceDraft('strict-stale')]));
    expect(screen.getByTestId('phone-sms-pending-draft-strict-current')).toBeInTheDocument();
    expect(screen.queryByTestId('phone-sms-pending-draft-strict-stale')).not.toBeInTheDocument();
  });

  it.each(['resolve', 'reject'] as const)('ignores an old owner list that settles by %s', async (outcome) => {
    const old = deferred<ReturnType<typeof raceDraft>[]>();
    smsDraftsMock.listSmsDrafts.mockReturnValueOnce(old.promise).mockResolvedValueOnce([raceDraft('b')]);
    const view = render(raceApp());
    view.rerender(raceApp(otherOwner));
    await screen.findByTestId('phone-sms-pending-draft-b');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await act(async () => {
      if (outcome === 'resolve') old.resolve([raceDraft('a')]);
      else old.reject(new Error('old list failure'));
    });
    expect(screen.getByTestId('phone-sms-pending-draft-b')).toBeInTheDocument();
    expect(screen.queryByTestId('phone-sms-pending-draft-a')).not.toBeInTheDocument();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('does not revive the first A request after A → B → A', async () => {
    const old = deferred<ReturnType<typeof raceDraft>[]>();
    smsDraftsMock.listSmsDrafts.mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce([raceDraft('b')]).mockResolvedValueOnce([raceDraft('new-a')]);
    const view = render(raceApp());
    view.rerender(raceApp(otherOwner));
    await screen.findByTestId('phone-sms-pending-draft-b');
    view.rerender(raceApp());
    expect(screen.queryByTestId('phone-sms-pending-draft-b')).not.toBeInTheDocument();
    await screen.findByTestId('phone-sms-pending-draft-new-a');
    await act(async () => old.resolve([raceDraft('old-a')]));
    expect(screen.getByTestId('phone-sms-pending-draft-new-a')).toBeInTheDocument();
    expect(screen.queryByTestId('phone-sms-pending-draft-old-a')).not.toBeInTheDocument();
  });

  it.each(['resolve', 'reject'] as const)('keeps the latest same-owner storage refresh when the older read %s settles', async (outcome) => {
    const old = deferred<ReturnType<typeof raceDraft>[]>();
    smsDraftsMock.listSmsDrafts.mockReturnValueOnce(old.promise).mockResolvedValueOnce([raceDraft('latest')]);
    const view = render(raceApp());
    const contactReads = phoneStoreMock.getPhoneContacts.mock.calls.length;
    const dependentReads = phoneStoreMock.getSmsThreads.mock.calls.length;
    phoneStoreMock.useXingyePhoneStorageVersion.mockReturnValue(1);
    view.rerender(raceApp());
    await screen.findByTestId('phone-sms-pending-draft-latest');
    expect(phoneStoreMock.getPhoneContacts.mock.calls.length).toBeGreaterThan(contactReads);
    expect(phoneStoreMock.getSmsThreads.mock.calls.length).toBeGreaterThan(dependentReads);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await act(async () => {
      if (outcome === 'resolve') old.resolve([raceDraft('stale')]);
      else old.reject(new Error('stale failure'));
    });
    expect(screen.getByTestId('phone-sms-pending-draft-latest')).toBeInTheDocument();
    expect(screen.queryByTestId('phone-sms-pending-draft-stale')).not.toBeInTheDocument();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it.each([
    ['confirm', 'success'], ['confirm', 'failure'],
    ['discard', 'success'], ['discard', 'missing'], ['discard', 'failure'],
  ] as const)('ignores late %s %s after returning to the same owner', async (action, outcome) => {
    const oldAction = deferred<boolean>();
    const currentAction = deferred<boolean>();
    const actionMock = action === 'confirm' ? smsDraftsMock.confirmSmsDraft : smsDraftsMock.discardSmsDraft;
    actionMock.mockReturnValueOnce(oldAction.promise).mockReturnValueOnce(currentAction.promise);
    smsDraftsMock.listSmsDrafts.mockResolvedValue([raceDraft('shared')]);
    const confirmDialog = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const view = render(raceApp());
    await screen.findByTestId('phone-sms-pending-draft-shared');
    fireEvent.click(screen.getByTestId('phone-sms-pending-draft-' + action + '-shared'));
    view.rerender(raceApp(otherOwner));
    await screen.findByTestId('phone-sms-pending-draft-shared');
    view.rerender(raceApp());
    await screen.findByTestId('phone-sms-pending-draft-shared');
    expect(screen.getByTestId('phone-sms-pending-draft-confirm-shared')).toBeEnabled();
    fireEvent.click(screen.getByTestId('phone-sms-pending-draft-' + action + '-shared'));
    const reads = smsDraftsMock.listSmsDrafts.mock.calls.length;
    const followups = phoneAiMock.generateSmsUpdatesForChangedContactsWithAI.mock.calls.length;
    await act(async () => {
      if (outcome === 'failure') oldAction.reject(new Error('previous owner failed'));
      else oldAction.resolve(outcome === 'success');
    });
    expect(screen.getByTestId('phone-sms-pending-draft-shared')).toBeInTheDocument();
    expect(screen.getByTestId('phone-sms-pending-draft-confirm-shared')).toBeDisabled();
    expect(screen.queryByText('previous owner failed')).not.toBeInTheDocument();
    expect(smsDraftsMock.listSmsDrafts).toHaveBeenCalledTimes(reads);
    expect(phoneAiMock.generateSmsUpdatesForChangedContactsWithAI).toHaveBeenCalledTimes(followups);
    await act(async () => currentAction.resolve(true));
    expect(screen.queryByTestId('phone-sms-pending-draft-shared')).not.toBeInTheDocument();
    confirmDialog.mockRestore();
  });

  it('does not reload or start follow-up actions after unmount', async () => {
    const action = deferred<boolean>();
    smsDraftsMock.listSmsDrafts.mockResolvedValue([raceDraft('unmount')]);
    smsDraftsMock.discardSmsDraft.mockReturnValueOnce(action.promise);
    const confirmDialog = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const view = render(raceApp());
    await screen.findByTestId('phone-sms-pending-draft-unmount');
    fireEvent.click(screen.getByTestId('phone-sms-pending-draft-discard-unmount'));
    view.unmount();
    await act(async () => action.resolve(false));
    expect(smsDraftsMock.listSmsDrafts).toHaveBeenCalledTimes(1);
    confirmDialog.mockRestore();
  });

  it.each([
    ['confirm', 'before'], ['confirm', 'during'],
    ['discard', 'before'], ['discard', 'during'],
  ] as const)('keeps new drafts from a refresh started %s / %s without reviving the handled draft', async (actionName, refreshTiming) => {
    const action = deferred<boolean>();
    const staleRead = deferred<ReturnType<typeof raceDraft>[]>();
    smsDraftsMock.listSmsDrafts.mockResolvedValueOnce([raceDraft('confirmed')]).mockReturnValueOnce(staleRead.promise);
    const actionMock = actionName === 'confirm' ? smsDraftsMock.confirmSmsDraft : smsDraftsMock.discardSmsDraft;
    actionMock.mockReturnValueOnce(action.promise);
    const confirmDialog = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const view = render(raceApp());
    await screen.findByTestId('phone-sms-pending-draft-confirmed');
    const refresh = () => {
      phoneStoreMock.useXingyePhoneStorageVersion.mockReturnValue(1);
      view.rerender(raceApp());
    };
    if (refreshTiming === 'before') refresh();
    fireEvent.click(screen.getByTestId('phone-sms-pending-draft-' + actionName + '-confirmed'));
    if (refreshTiming === 'during') refresh();
    await act(async () => action.resolve(true));
    await act(async () => staleRead.resolve([raceDraft('confirmed'), raceDraft('new-independent')]));
    expect(screen.queryByTestId('phone-sms-pending-draft-confirmed')).not.toBeInTheDocument();
    expect(screen.getByTestId('phone-sms-pending-draft-new-independent')).toBeInTheDocument();
    // A helper may report success even if removing the persisted draft failed.
    // Later reads must still hide that handled ID while accepting fresh drafts.
    smsDraftsMock.listSmsDrafts.mockResolvedValueOnce([raceDraft('confirmed'), raceDraft('another-new')]);
    phoneStoreMock.useXingyePhoneStorageVersion.mockReturnValue(2);
    view.rerender(raceApp());
    await screen.findByTestId('phone-sms-pending-draft-another-new');
    expect(screen.queryByTestId('phone-sms-pending-draft-confirmed')).not.toBeInTheDocument();
    confirmDialog.mockRestore();
  });
});


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
  phoneStoreMock.useXingyePhoneStorageVersion.mockReturnValue(0);
  vi.clearAllMocks();
  smsDraftsMock.confirmSmsDraft.mockReset();
  smsDraftsMock.discardSmsDraft.mockReset();
  smsDraftsMock.listSmsDrafts.mockReset();
  smsDraftsMock.listSmsDrafts.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
});

describe('PhoneSmsApp · pending draft section', () => {
  it('X6 failed generation stays stopped across rerenders and retries only on request', async () => {
    phoneStoreMock.getSmsHistoryGenerationState.mockReturnValue(null as any);
    phoneStoreMock.getPhoneAiGenerationState.mockReturnValue({ status: 'failed', error: 'AI unavailable' } as any);
    phoneAiMock.generateSmsHistoryWithAI.mockResolvedValue(undefined);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    try {
      const view = renderSmsApp();
      await screen.findByText(/生成失败，可重试/);
      view.rerender(raceApp());
      expect(phoneAiMock.generateSmsHistoryWithAI).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: '重试' }));
      expect(phoneAiMock.generateSmsHistoryWithAI).toHaveBeenCalledTimes(1);
    } finally {
      phoneStoreMock.getSmsHistoryGenerationState.mockReturnValue({ generatedAt: '2026-05-17T00:00:00.000Z' });
      phoneStoreMock.getPhoneAiGenerationState.mockReturnValue(null);
      vi.restoreAllMocks();
    }
  });
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
