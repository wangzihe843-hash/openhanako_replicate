/**
 * @vitest-environment jsdom
 *
 * 主要验「待确认草稿」分组与 confirmAccountingDraft / discardAccountingDraft 双路径——
 * tests/xingye-propose-draft-coverage.test.js 的 UI fixtures 检查会断言本文件存在
 * 且引用这两个 verb，所以这里特意把它们走通。
 */

import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../types';

const appEntryStoreMock = vi.hoisted(() => ({
  appendAppEntry: vi.fn(),
  deleteAppEntry: vi.fn(),
}));

const accountingDraftsMock = vi.hoisted(() => ({
  appendAccountingDraft: vi.fn(),
  confirmAccountingDraft: vi.fn(),
  discardAccountingDraft: vi.fn(),
  listAccountingDrafts: vi.fn().mockResolvedValue([]),
}));

const accountingAiMock = vi.hoisted(() => ({
  generateAccountingDraftsWithAI: vi.fn().mockResolvedValue([]),
}));

const ledgerMock = vi.hoisted(() => ({
  loadLedger: vi.fn().mockResolvedValue({
    entries: [],
    summary: { byCurrency: [], missingAmountCount: 0 },
  }),
}));

const historyStateMock = vi.hoisted(() => ({
  distributeOccurredAtFallback: vi.fn((drafts: unknown[]) => drafts),
  loadHistoryState: vi.fn().mockResolvedValue({
    initializedAt: '2026-05-01T00:00:00.000Z',
    lastBulkAt: null,
    lastCoveredDate: null,
  }),
  saveHistoryState: vi.fn().mockResolvedValue(undefined),
  planBulkRequest: vi.fn(() => ({ count: 0, hintText: '' })),
  planInitialBulkRequest: vi.fn(() => ({ count: 0, hintText: '' })),
  toYmd: vi.fn(() => '2026-05-26'),
}));

vi.mock('./xingye-app-entry-store', () => appEntryStoreMock);
vi.mock('./xingye-accounting-drafts', () => accountingDraftsMock);
vi.mock('./xingye-accounting-ai', () => accountingAiMock);
vi.mock('./xingye-accounting-ledger', () => ledgerMock);
vi.mock('./xingye-app-history-state', () => historyStateMock);

import { PhoneAccountingApp } from './PhoneAccountingApp';

const linwu: Agent = {
  id: 'linwu',
  name: '林雾',
  yuan: 'hanako',
  isPrimary: false,
  hasAvatar: false,
};

function renderApp(agent: Agent | null = linwu) {
  return render(
    <PhoneAccountingApp
      ownerAgent={agent}
      ownerProfile={null}
      displayName={agent?.name ?? 'TA'}
      onBack={vi.fn()}
    />,
  );
}

const draftFixture = {
  id: 'ledger-draft-1',
  title: '五月薪俸',
  direction: 'income' as const,
  amount: 5000,
  currency: '¥',
  imaginedAmount: '¥5000（足额）',
  category: '工资',
  counterparty: '东家',
  occurredAt: '2026-05-26T00:00:00.000Z',
  reason: '她在厨房说今天工资发下来了',
  content: '比上个月多 200。',
  source: 'xingye-heartbeat-tool',
  createdAt: '2026-05-26T08:00:00.000Z',
};

describe('PhoneAccountingApp · 待确认草稿', () => {
  beforeEach(() => {
    accountingDraftsMock.confirmAccountingDraft.mockReset();
    accountingDraftsMock.discardAccountingDraft.mockReset();
    // 不要直接 mockReset listAccountingDrafts —— 那会把默认的
    // mockResolvedValue([]) 清掉，组件 reload 时拿到 undefined 进而把
    // pendingDrafts setState 成 undefined，下次渲染 .length 崩。
    accountingDraftsMock.listAccountingDrafts.mockClear();
    accountingDraftsMock.listAccountingDrafts.mockResolvedValue([]);
    appEntryStoreMock.appendAppEntry.mockReset();
    appEntryStoreMock.deleteAppEntry.mockReset();
    ledgerMock.loadLedger.mockResolvedValue({
      entries: [],
      summary: { byCurrency: [], missingAmountCount: 0 },
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the draft confirm + discard buttons and calls confirmAccountingDraft on confirm', async () => {
    accountingDraftsMock.listAccountingDrafts.mockResolvedValueOnce([draftFixture]);
    accountingDraftsMock.confirmAccountingDraft.mockResolvedValueOnce({
      id: 'from-draft-ledger-draft-1',
      appId: 'accounting',
      title: '五月薪俸',
      content: '比上个月多 200。',
      metadata: { direction: 'income', amount: 5000, currency: '¥' },
      source: 'xingye-heartbeat-confirmed',
      createdAt: '2026-05-26T00:00:00.000Z',
      updatedAt: '2026-05-26T00:00:00.000Z',
    });

    renderApp();
    const confirmBtn = await screen.findByTestId(`phone-accounting-draft-confirm-${draftFixture.id}`);
    expect(screen.getByTestId(`phone-accounting-draft-discard-${draftFixture.id}`)).toBeInTheDocument();
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(accountingDraftsMock.confirmAccountingDraft).toHaveBeenCalledTimes(1);
    });
    const [aid, did, payload] = accountingDraftsMock.confirmAccountingDraft.mock.calls[0];
    expect(aid).toBe('linwu');
    expect(did).toBe(draftFixture.id);
    expect(payload).toMatchObject({
      title: '五月薪俸',
      direction: 'income',
      amount: 5000,
      currency: '¥',
      category: '工资',
      counterparty: '东家',
    });
  });

  it('calls discardAccountingDraft when discard is clicked and confirmed', async () => {
    accountingDraftsMock.listAccountingDrafts.mockResolvedValueOnce([draftFixture]);
    accountingDraftsMock.discardAccountingDraft.mockResolvedValueOnce(true);
    vi.spyOn(window, 'confirm').mockReturnValueOnce(true);

    renderApp();
    const discardBtn = await screen.findByTestId(`phone-accounting-draft-discard-${draftFixture.id}`);
    fireEvent.click(discardBtn);

    await waitFor(() => {
      expect(accountingDraftsMock.discardAccountingDraft).toHaveBeenCalledTimes(1);
    });
    expect(accountingDraftsMock.discardAccountingDraft).toHaveBeenCalledWith('linwu', draftFixture.id);
    expect(accountingDraftsMock.confirmAccountingDraft).not.toHaveBeenCalled();
  });

  it('does NOT call discardAccountingDraft if user cancels the window.confirm', async () => {
    accountingDraftsMock.listAccountingDrafts.mockResolvedValueOnce([draftFixture]);
    vi.spyOn(window, 'confirm').mockReturnValueOnce(false);

    renderApp();
    const discardBtn = await screen.findByTestId(`phone-accounting-draft-discard-${draftFixture.id}`);
    fireEvent.click(discardBtn);

    // 让一次 microtask 跑完，确认没有意外调用
    await Promise.resolve();
    expect(accountingDraftsMock.discardAccountingDraft).not.toHaveBeenCalled();
  });
});
