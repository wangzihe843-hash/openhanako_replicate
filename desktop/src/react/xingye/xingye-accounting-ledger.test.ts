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

describe('projection 层归一近义词到规范 bucket', () => {
  // 这层兜底防御的具体场景：模型这次回「电器」下次回「家电」，按 raw 字符串聚合
  // 会被算成两条独立 bucket。projection 层调 normalizeCategory 把同概念折回同一
  // 规范词，保证账本聚合不裂。详见 xingye-spending-categories.ts 顶部说明。

  it('购物：「电器」→「家电」、「衣物」→「服饰」', () => {
    const dianqi = projectShoppingEntry(
      appEntry({
        id: 'shop-dianqi',
        appId: 'shopping',
        metadata: { status: 'received', itemName: '吹风机', category: '电器', amount: 200, currency: '¥' },
      }),
    );
    expect(dianqi.category).toBe('家电');

    const yiwu = projectShoppingEntry(
      appEntry({
        id: 'shop-yiwu',
        appId: 'shopping',
        metadata: { status: 'received', itemName: '外套', category: '衣物', amount: 800, currency: '¥' },
      }),
    );
    expect(yiwu.category).toBe('服饰');
  });

  it('二手：「软装」→「家居」、「鞋帽」→「鞋包」', () => {
    const ruanzhuang = projectSecondhandEntry(
      appEntry({
        id: 'resell-ruanzhuang',
        appId: 'secondhand',
        metadata: { status: 'sold', itemName: '旧抱枕', category: '软装', amount: 30, currency: '¥' },
      }),
    );
    expect(ruanzhuang.category).toBe('家居');

    const xiemao = projectSecondhandEntry(
      appEntry({
        id: 'resell-xiemao',
        appId: 'secondhand',
        metadata: { status: 'sold', itemName: '旧靴子', category: '鞋帽', amount: 120, currency: '¥' },
      }),
    );
    expect(xiemao.category).toBe('鞋包');
  });

  it('记账：「打车」「出租车」「吃饭」「通讯费」都收口到规范词', () => {
    for (const [raw, canonical] of [
      ['打车', '交通'],
      ['出租车', '交通'],
      ['吃饭', '餐饮'],
      ['通讯费', '通讯'],
    ]) {
      const row = projectAccountingEntry(
        appEntry({
          id: `ledger-${raw}`,
          appId: 'accounting',
          title: '测试',
          metadata: { direction: 'expense', amount: 10, currency: '¥', category: raw },
        }),
      );
      expect(row.category).toBe(canonical);
    }
  });

  it('世界观自由文本（"俸禄""法术耗材"）原样保留不被归一', () => {
    const fenglu = projectAccountingEntry(
      appEntry({
        id: 'ledger-fenglu',
        appId: 'accounting',
        title: '俸禄',
        metadata: { direction: 'income', amount: 5, currency: '两银子', category: '俸禄' },
      }),
    );
    expect(fenglu.category).toBe('俸禄');
  });

  it('归一后同概念合并到同一 bucket（电器 + 家电 → 单一"家电"）', () => {
    const rows = [
      projectShoppingEntry(
        appEntry({
          id: 'a',
          appId: 'shopping',
          metadata: { status: 'received', category: '电器', amount: 200, currency: '¥' },
        }),
      ),
      projectShoppingEntry(
        appEntry({
          id: 'b',
          appId: 'shopping',
          metadata: { status: 'received', category: '家电', amount: 300, currency: '¥' },
        }),
      ),
    ];
    // 两行都应该是 "家电"——同 bucket
    expect(rows[0].category).toBe('家电');
    expect(rows[1].category).toBe('家电');
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
   summarizeLedger 的折算路径：传入 fxConfig 时聚合到主货币；
   不传 fxConfig 时保持向下兼容（unified === undefined）。
─────────────────────────────────────────────────────────────────────────── */

function makeRealizedEntry(
  id: string,
  direction: 'income' | 'expense',
  amount: number,
  currency: string | null,
): LedgerEntry {
  return {
    id,
    source: 'accounting',
    origin: 'native',
    direction,
    title: id,
    amount,
    currency,
    realized: true,
    occurredAt: '2026-05-01T00:00:00.000Z',
  };
}

describe('summarizeLedger · fx unified', () => {
  it('不传 fxConfig 时 unified 为 undefined，byCurrency 仍按币种分桶', () => {
    const summary = summarizeLedger([
      makeRealizedEntry('a', 'income', 5000, '¥'),
      makeRealizedEntry('b', 'expense', 100, '$'),
    ]);
    expect(summary.unified).toBeUndefined();
    expect(summary.byCurrency).toHaveLength(2);
  });

  it('传 fxConfig 时把 ¥ + $ + 两银子合并到主货币 ¥', () => {
    const summary = summarizeLedger(
      [
        // 收入：¥5000 + $100（按 7.2 折算 = ¥720）= ¥5720
        makeRealizedEntry('a', 'income', 5000, '¥'),
        makeRealizedEntry('b', 'income', 100, '$'),
        // 支出：¥1000 + 2 两银子（×250 = ¥500）= ¥1500
        makeRealizedEntry('c', 'expense', 1000, '¥'),
        makeRealizedEntry('d', 'expense', 2, '两银子'),
      ],
      {
        displayCurrency: '¥',
        rates: { '¥': 1, $: 7.2, '两银子': 250 },
      },
    );
    expect(summary.unified).toBeDefined();
    expect(summary.unified?.displayCurrency).toBe('¥');
    expect(summary.unified?.income).toBeCloseTo(5720, 2);
    expect(summary.unified?.expense).toBeCloseTo(1500, 2);
    expect(summary.unified?.net).toBeCloseTo(4220, 2);
    expect(summary.unified?.realizedCount).toBe(4);
    expect(summary.unified?.unconvertible).toEqual([]);
  });

  it('未知币种落到 unconvertible，不被强行 1:1 蒙混', () => {
    const summary = summarizeLedger(
      [
        makeRealizedEntry('a', 'income', 100, '¥'),
        makeRealizedEntry('b', 'expense', 50, '某怪币'),
      ],
      {
        displayCurrency: '¥',
        rates: { '¥': 1 },
      },
    );
    expect(summary.unified?.income).toBeCloseTo(100, 2);
    expect(summary.unified?.expense).toBe(0); // 怪币没并入
    expect(summary.unified?.realizedCount).toBe(1); // 只有 ¥ 那条计入
    expect(summary.unified?.unconvertible).toHaveLength(1);
    expect(summary.unified?.unconvertible[0].currency).toBe('某怪币');
  });

  it('只有一种币种 且 等于 displayCurrency → unconvertible 为空，原数原样汇总', () => {
    const summary = summarizeLedger(
      [
        makeRealizedEntry('a', 'income', 100, '¥'),
        makeRealizedEntry('b', 'expense', 30, '¥'),
      ],
      { displayCurrency: '¥', rates: { '¥': 1 } },
    );
    expect(summary.unified?.income).toBe(100);
    expect(summary.unified?.expense).toBe(30);
    expect(summary.unified?.net).toBe(70);
    expect(summary.unified?.unconvertible).toEqual([]);
  });

  it('displayCurrency 切到 "两银子" 时把所有币种折算到两银子', () => {
    const summary = summarizeLedger(
      [
        // 收入 ¥500 → 折算到两银子（500 / 250 = 2 两）
        makeRealizedEntry('a', 'income', 500, '¥'),
        // 支出 1 两银子原样
        makeRealizedEntry('b', 'expense', 1, '两银子'),
      ],
      { displayCurrency: '两银子', rates: { '¥': 1, '两银子': 250 } },
    );
    expect(summary.unified?.displayCurrency).toBe('两银子');
    expect(summary.unified?.income).toBeCloseTo(2, 2);
    expect(summary.unified?.expense).toBeCloseTo(1, 2);
    expect(summary.unified?.net).toBeCloseTo(1, 2);
  });

  it('displayCurrency 为空字符串 → 不算 unified（被视作未配置）', () => {
    const summary = summarizeLedger(
      [makeRealizedEntry('a', 'income', 100, '¥')],
      { displayCurrency: '', rates: { '¥': 1 } },
    );
    expect(summary.unified).toBeUndefined();
  });
});
