import { describe, expect, it } from 'vitest';
import type { AppEntry } from './xingye-app-entry-store';
import {
  projectAccountingEntry,
  projectSecondhandEntry,
  projectShoppingEntry,
  summarizeLedger,
  type LedgerEntry,
} from './xingye-accounting-ledger';

function appEntry(
  partial: Partial<AppEntry> & { id: string; appId: AppEntry['appId'] },
): AppEntry {
  return {
    agentId: 'agent-a',
    title: '',
    content: '',
    metadata: {},
    source: 'manual',
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
    ...partial,
  };
}

describe('projectShoppingEntry', () => {
  it('projects a bought item as a realized expense row', () => {
    const row = projectShoppingEntry(
      appEntry({
        id: 'shop-1',
        appId: 'shopping',
        title: '相机',
        content: '街角二手店',
        metadata: {
          status: 'received',
          itemName: '旁轴相机',
          amount: 2000,
          currency: '¥',
          category: '摄影',
          seller: '光阴二手店',
        },
        updatedAt: '2026-05-10T00:00:00.000Z',
      }),
    );
    expect(row).toMatchObject({
      id: 'shop-1',
      source: 'shopping',
      origin: 'derived',
      direction: 'expense',
      title: '旁轴相机',
      amount: 2000,
      currency: '¥',
      category: '摄影',
      counterparty: '光阴二手店',
      realized: true,
      occurredAt: '2026-05-10T00:00:00.000Z',
      note: '街角二手店',
    });
  });

  it('treats wishlist / hesitating / returned shopping rows as not realized', () => {
    for (const status of ['wanted', 'hesitating', 'favorite', 'returned']) {
      const row = projectShoppingEntry(
        appEntry({ id: `shop-${status}`, appId: 'shopping', metadata: { status, amount: 50 } }),
      );
      expect(row.realized).toBe(false);
    }
  });

  it('leaves amount null when no numeric amount was filled', () => {
    const row = projectShoppingEntry(
      appEntry({
        id: 'shop-noamt',
        appId: 'shopping',
        title: '茶叶',
        metadata: { status: 'ordered', imaginedPrice: '约二两银子' },
      }),
    );
    expect(row.realized).toBe(true);
    expect(row.amount).toBeNull();
    expect(row.currency).toBeNull();
  });
});

describe('projectSecondhandEntry', () => {
  it('projects a sold item as a realized income row', () => {
    const row = projectSecondhandEntry(
      appEntry({
        id: 'resell-1',
        appId: 'secondhand',
        title: '旧书',
        metadata: {
          status: 'sold',
          itemName: '一摞旧书',
          amount: 120,
          currency: '¥',
          buyer: '巷口的旧书客',
        },
        updatedAt: '2026-05-12T00:00:00.000Z',
      }),
    );
    expect(row).toMatchObject({
      source: 'secondhand',
      direction: 'income',
      amount: 120,
      currency: '¥',
      counterparty: '巷口的旧书客',
      realized: true,
    });
  });

  it('treats not-yet-sold secondhand rows as not realized', () => {
    for (const status of ['to_sell', 'listed', 'negotiating', 'kept', 'delisted']) {
      const row = projectSecondhandEntry(
        appEntry({ id: `resell-${status}`, appId: 'secondhand', metadata: { status, amount: 30 } }),
      );
      expect(row.realized).toBe(false);
    }
  });
});

describe('projectAccountingEntry', () => {
  it('projects a native income row and prefers occurredAt over createdAt', () => {
    const row = projectAccountingEntry(
      appEntry({
        id: 'ledger-1',
        appId: 'accounting',
        title: '五月薪俸',
        content: '东家结的月钱',
        metadata: {
          direction: 'income',
          amount: 8000,
          currency: '¥',
          category: '工资',
          counterparty: '东家',
          occurredAt: '2026-05-05T00:00:00.000Z',
          title: '五月薪俸',
        },
        createdAt: '2026-05-20T00:00:00.000Z',
      }),
    );
    expect(row).toMatchObject({
      source: 'accounting',
      origin: 'native',
      direction: 'income',
      amount: 8000,
      realized: true,
      occurredAt: '2026-05-05T00:00:00.000Z',
    });
  });

  it('falls back to createdAt when occurredAt is absent and defaults direction to expense', () => {
    const row = projectAccountingEntry(
      appEntry({
        id: 'ledger-2',
        appId: 'accounting',
        title: '房租',
        metadata: { amount: 1500, currency: '¥' },
        createdAt: '2026-05-02T00:00:00.000Z',
      }),
    );
    expect(row.direction).toBe('expense');
    expect(row.occurredAt).toBe('2026-05-02T00:00:00.000Z');
  });
});

describe('summarizeLedger', () => {
  const realized = (
    over: Partial<LedgerEntry> & Pick<LedgerEntry, 'id' | 'direction' | 'amount'>,
  ): LedgerEntry => ({
    source: 'accounting',
    origin: 'native',
    title: '',
    currency: '¥',
    realized: true,
    occurredAt: '2026-05-01T00:00:00.000Z',
    ...over,
  });

  it('sums income and expense per currency and computes net', () => {
    const summary = summarizeLedger([
      realized({ id: 'a', direction: 'income', amount: 8000 }),
      realized({ id: 'b', direction: 'expense', amount: 1500 }),
      realized({ id: 'c', direction: 'expense', amount: 500 }),
    ]);
    expect(summary.byCurrency).toHaveLength(1);
    expect(summary.byCurrency[0]).toEqual({
      currency: '¥',
      income: 8000,
      expense: 2000,
      net: 6000,
      realizedCount: 3,
    });
    expect(summary.missingAmountCount).toBe(0);
  });

  it('keeps different worldview currencies in separate buckets', () => {
    const summary = summarizeLedger([
      realized({ id: 'a', direction: 'income', amount: 100, currency: '¥' }),
      realized({ id: 'b', direction: 'income', amount: 3, currency: '两银子' }),
    ]);
    const currencies = summary.byCurrency.map((b) => b.currency).sort();
    expect(currencies).toEqual(['¥', '两银子'].sort());
  });

  it('excludes non-realized rows and counts realized rows missing an amount', () => {
    const summary = summarizeLedger([
      realized({ id: 'a', direction: 'expense', amount: 200 }),
      realized({ id: 'b', direction: 'expense', amount: null }),
      { ...realized({ id: 'c', direction: 'income', amount: 9999 }), realized: false },
    ]);
    expect(summary.missingAmountCount).toBe(1);
    expect(summary.byCurrency[0]).toMatchObject({ expense: 200, realizedCount: 1 });
  });

  it('buckets rows with no currency under an empty-string key', () => {
    const summary = summarizeLedger([
      realized({ id: 'a', direction: 'expense', amount: 50, currency: null }),
    ]);
    expect(summary.byCurrency[0].currency).toBe('');
  });
});
