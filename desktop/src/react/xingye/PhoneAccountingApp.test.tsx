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
  /**
   * 老测试不关心 fx 折算，给个 passthrough：byCurrency 走简单分桶但 unified 留 undefined
   * 也合法（UI 会退化到老的多卡显示）。这里直接返回空 summary，因为测试只断言
   * 草稿区行为，不查 summary。
   */
  summarizeLedger: vi.fn(() => ({ byCurrency: [], missingAmountCount: 0 })),
}));

const fxRatesMock = vi.hoisted(() => ({
  FX_ANCHOR_CURRENCY: '¥',
  FX_CURRENCY_GROUPS: [],
  DEFAULT_FX_RATES: {},
  loadFxConfig: vi.fn().mockResolvedValue({ version: 1, displayCurrency: '', rates: {} }),
  saveFxConfig: vi.fn().mockResolvedValue({ version: 1, displayCurrency: '', rates: {} }),
  resolveFxState: vi.fn(() => ({
    displayCurrency: '¥',
    effectiveRates: { '¥': 1 },
    raw: { version: 1, displayCurrency: '', rates: {} },
  })),
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
vi.mock('./xingye-accounting-fx-rates', () => fxRatesMock);
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

/**
 * 跨角色 reload 竞态：见 PhoneSecondhandApp/PhoneTripsApp 的同款守卫。
 * reloadSeqRef 单调请求号 + effect cleanup 让上一个角色还在飞的 loadLedger
 * 最后才落地时无法 setState 覆盖新角色账本。
 */
describe('PhoneAccountingApp · 跨角色 reload 竞态', () => {
  const agentB: Agent = { ...linwu, id: 'agentB', name: 'B' };

  beforeEach(() => {
    accountingDraftsMock.listAccountingDrafts.mockClear();
    accountingDraftsMock.listAccountingDrafts.mockResolvedValue([]);
    ledgerMock.loadLedger.mockReset();
    fxRatesMock.loadFxConfig.mockResolvedValue({ version: 1, displayCurrency: '', rates: {} });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  function makeLedgerEntry(id: string, title: string) {
    return {
      id,
      source: 'accounting' as const,
      origin: 'native' as const,
      direction: 'expense' as const,
      title,
      amount: 30,
      currency: '¥',
      realized: true,
      occurredAt: '2026-05-26T08:00:00.000Z',
    };
  }

  function makeLedger(id: string, title: string) {
    return {
      entries: [makeLedgerEntry(id, title)],
      summary: { byCurrency: [], missingAmountCount: 0 },
    };
  }

  it('切换角色后，旧角色后落地的 reload 不覆盖新角色账本', async () => {
    // 受控 deferred：让 A 的 loadLedger 一直挂着，切到 B 后再 resolve A，
    // 模拟「旧角色的在飞读取最后才落地」。
    let resolveA: (lg: unknown) => void = () => {};
    const aLedgerPromise = new Promise<unknown>((resolve) => {
      resolveA = resolve;
    });

    ledgerMock.loadLedger.mockImplementation((aid: string) => {
      if (aid === 'linwu') return aLedgerPromise;
      if (aid === 'agentB') return Promise.resolve(makeLedger('b-1', '乙账目样本'));
      return Promise.resolve({ entries: [], summary: { byCurrency: [], missingAmountCount: 0 } });
    });

    const { rerender } = render(
      <PhoneAccountingApp ownerAgent={linwu} ownerProfile={null} displayName="林雾" onBack={vi.fn()} />,
    );
    await waitFor(() => {
      expect(ledgerMock.loadLedger).toHaveBeenCalledWith('linwu');
    });

    // 切到 B：触发新一轮 reload（cleanup 让上一轮失效）。
    rerender(
      <PhoneAccountingApp ownerAgent={agentB} ownerProfile={null} displayName="B" onBack={vi.fn()} />,
    );
    await waitFor(() => {
      expect(screen.getByText('乙账目样本')).toBeInTheDocument();
    });

    // 现在 A 的旧读取才落地——必须被请求号守卫丢弃，不能覆盖 B。
    resolveA(makeLedger('a-1', '甲账目样本'));
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 20));

    expect(screen.getByText('乙账目样本')).toBeInTheDocument();
    expect(screen.queryByText('甲账目样本')).not.toBeInTheDocument();
  });
});

/**
 * 首启自动初始化的安全护栏（回归 2026-06-05「健康/记账历史丢失」排查）：
 *  - 读失败（listError）时绝不拿空账本去触发初始化；
 *  - 二次确认发现已有账目时只补 initializedAt marker、不重灌；
 *  - 真·空账本 + 未初始化时仍正常首灌。
 */
describe('PhoneAccountingApp · 首启初始化护栏', () => {
  const emptyLedger = { entries: [], summary: { byCurrency: [], missingAmountCount: 0 } };

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    ledgerMock.loadLedger.mockReset();
    ledgerMock.loadLedger.mockResolvedValue(emptyLedger);
    accountingDraftsMock.listAccountingDrafts.mockReset();
    accountingDraftsMock.listAccountingDrafts.mockResolvedValue([]);
    accountingAiMock.generateAccountingDraftsWithAI.mockReset();
    accountingAiMock.generateAccountingDraftsWithAI.mockResolvedValue([]);
    historyStateMock.loadHistoryState.mockReset();
    historyStateMock.saveHistoryState.mockReset();
    historyStateMock.saveHistoryState.mockResolvedValue(undefined);
    historyStateMock.planInitialBulkRequest.mockReturnValue({ count: 0, hintText: '' });
    fxRatesMock.loadFxConfig.mockResolvedValue({ version: 1, displayCurrency: '', rates: {} });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  function makeLedgerWithEntry() {
    return {
      entries: [
        {
          id: 'e-1',
          source: 'accounting' as const,
          origin: 'native' as const,
          direction: 'expense' as const,
          title: '已有账目',
          amount: 30,
          currency: '¥',
          realized: true,
          occurredAt: '2026-05-26T08:00:00.000Z',
        },
      ],
      summary: { byCurrency: [], missingAmountCount: 0 },
    };
  }

  it('空账本 + 未初始化 → 触发首灌生成', async () => {
    historyStateMock.loadHistoryState.mockResolvedValue({ version: 1 }); // 无 initializedAt
    renderApp();
    await waitFor(() => {
      expect(accountingAiMock.generateAccountingDraftsWithAI).toHaveBeenCalled();
    });
  });

  it('二次确认发现已有账目 → 只补 marker、不重灌', async () => {
    historyStateMock.loadHistoryState.mockResolvedValue({ version: 1 }); // 无 initializedAt
    // 首挂载 reload 读到空（才会进 bootstrap），二次确认落盘再读到已有账目。
    ledgerMock.loadLedger
      .mockResolvedValueOnce(emptyLedger)
      .mockResolvedValueOnce(makeLedgerWithEntry());
    renderApp();
    await waitFor(() => {
      expect(historyStateMock.saveHistoryState).toHaveBeenCalledWith(
        'linwu',
        'accounting',
        expect.objectContaining({ initializedAt: expect.any(String) }),
      );
    });
    expect(accountingAiMock.generateAccountingDraftsWithAI).not.toHaveBeenCalled();
  });

  it('reload 读失败 → 不初始化、不生成（空账本是读失败不是真空）', async () => {
    historyStateMock.loadHistoryState.mockResolvedValue({ version: 1 }); // 无 initializedAt
    ledgerMock.loadLedger.mockRejectedValue(new Error('backend offline'));
    renderApp();
    await waitFor(() => {
      expect(screen.getByText(/加载失败/)).toBeInTheDocument();
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(accountingAiMock.generateAccountingDraftsWithAI).not.toHaveBeenCalled();
    expect(historyStateMock.saveHistoryState).not.toHaveBeenCalled();
  });
});
