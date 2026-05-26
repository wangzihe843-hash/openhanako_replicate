/**
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../hooks/use-hana-fetch', () => ({
  hanaFetch: vi.fn(),
}));

vi.mock('./xingye-storage-api', () => ({
  postXingyeStorage: vi.fn(),
}));

import { hanaFetch } from '../hooks/use-hana-fetch';
import { postXingyeStorage } from './xingye-storage-api';
import {
  generateAccountingDraftsWithAI,
  normalizeAccountingDraftResult,
  normalizeAccountingDraftResults,
} from './xingye-accounting-ai';
import {
  ACCOUNTING_AI_DIRECTIONS,
  buildAccountingDraftPrompt,
} from './xingye-accounting-prompts';

describe('normalizeAccountingDraftResult', () => {
  it('requires title and parses imaginedAmount → amount + currency', () => {
    const r = normalizeAccountingDraftResult({
      title: '  五月薪俸  ',
      direction: 'income',
      imaginedAmount: '¥3,500',
      category: '工资',
      counterparty: '东家',
      content: '月初到账。',
    });
    expect(r).toMatchObject({
      title: '五月薪俸',
      direction: 'income',
      amount: 3500,
      currency: '¥',
      category: '工资',
      counterparty: '东家',
    });
  });

  it('rejects drafts where amount/currency cannot be parsed (fallback 写法)', () => {
    expect(
      normalizeAccountingDraftResult({
        title: '吃饭',
        direction: 'expense',
        imaginedAmount: '约一杯奶茶钱',
        content: 'x',
      }),
    ).toBeNull();
    // no imaginedAmount at all
    expect(
      normalizeAccountingDraftResult({
        title: '吃饭',
        direction: 'expense',
        content: 'x',
      }),
    ).toBeNull();
  });

  it('rejects drafts with empty title', () => {
    expect(
      normalizeAccountingDraftResult({
        title: '',
        direction: 'expense',
        imaginedAmount: '¥10',
        content: 'x',
      }),
    ).toBeNull();
  });

  it('defaults unknown direction to "expense"', () => {
    const r = normalizeAccountingDraftResult({
      title: '不知道',
      direction: 'whatever',
      imaginedAmount: '¥10',
      content: 'x',
    });
    expect(r?.direction).toBe('expense');
  });

  it('parses imaginedAmount across world-views (modern, ancient, dynastic, fantasy, future)', () => {
    const cases: Array<{ amt: string; amount: number; currency: string }> = [
      { amt: '¥1,280', amount: 1280, currency: '¥' },
      { amt: '$35', amount: 35, currency: '$' },
      { amt: '二两银子', amount: 2, currency: '两银子' },
      { amt: '八百文', amount: 800, currency: '文' },
      { amt: '三个大洋', amount: 3, currency: '大洋' },
      { amt: '5 枚金币', amount: 5, currency: '金币' },
      { amt: '120 信用点', amount: 120, currency: '信用点' },
    ];
    for (const { amt, amount, currency } of cases) {
      const r = normalizeAccountingDraftResult({
        title: '某笔',
        direction: 'income',
        imaginedAmount: amt,
        content: 'x',
      });
      expect(r, `failed on "${amt}"`).not.toBeNull();
      expect(r?.amount, `amount failed on "${amt}"`).toBe(amount);
      expect(r?.currency, `currency failed on "${amt}"`).toBe(currency);
    }
  });

  it('parses occurredAtHint natural-language tokens to ISO', () => {
    const r1 = normalizeAccountingDraftResult({
      title: 't',
      direction: 'expense',
      imaginedAmount: '¥10',
      occurredAtHint: '今天',
      content: 'x',
    });
    expect(r1?.occurredAt).toBeDefined();
    expect(new Date(r1!.occurredAt!).getTime()).toBeLessThanOrEqual(Date.now());

    const r2 = normalizeAccountingDraftResult({
      title: 't',
      direction: 'expense',
      imaginedAmount: '¥10',
      occurredAtHint: '3 天前',
      content: 'x',
    });
    expect(r2?.occurredAt).toBeDefined();
    const diff = Date.now() - new Date(r2!.occurredAt!).getTime();
    // 在 3 天到 4 天的范围内（看时区可能略偏，但量级要对）
    expect(diff).toBeGreaterThanOrEqual(2 * 24 * 3600 * 1000);
    expect(diff).toBeLessThanOrEqual(5 * 24 * 3600 * 1000);
  });

  it('leaves occurredAt undefined for unparseable hints', () => {
    const r = normalizeAccountingDraftResult({
      title: 't',
      direction: 'expense',
      imaginedAmount: '¥10',
      occurredAtHint: '反正最近',
      content: 'x',
    });
    expect(r?.occurredAtHint).toBe('反正最近');
    expect(r?.occurredAt).toBeUndefined();
  });
});

describe('normalizeAccountingDraftResults', () => {
  it('accepts { drafts: [...] } envelope and filters invalid items', () => {
    const out = normalizeAccountingDraftResults({
      drafts: [
        { title: '五月薪俸', direction: 'income', imaginedAmount: '¥3500', content: 'x' },
        { title: '', direction: 'expense', imaginedAmount: '¥10', content: 'x' }, // dropped: empty title
        { title: '吃饭', direction: 'expense', imaginedAmount: '约一杯', content: 'x' }, // dropped: unparseable
        { title: '房租', direction: 'expense', imaginedAmount: '¥3500', content: 'x' },
      ],
    });
    expect(out).toHaveLength(2);
    expect(out[0].title).toBe('五月薪俸');
    expect(out[1].title).toBe('房租');
  });

  it('accepts bare array as fallback', () => {
    const out = normalizeAccountingDraftResults([
      { title: 't', direction: 'income', imaginedAmount: '¥10', content: 'x' },
    ]);
    expect(out).toHaveLength(1);
  });

  it('returns empty array for non-object / empty', () => {
    expect(normalizeAccountingDraftResults(null)).toEqual([]);
    expect(normalizeAccountingDraftResults('string')).toEqual([]);
    expect(normalizeAccountingDraftResults({ drafts: [] })).toEqual([]);
    expect(normalizeAccountingDraftResults({ drafts: 'nope' })).toEqual([]);
  });
});

describe('generateAccountingDraftsWithAI', () => {
  beforeEach(() => {
    vi.mocked(postXingyeStorage).mockReset();
    vi.mocked(hanaFetch).mockReset();
    vi.mocked(postXingyeStorage).mockResolvedValue({ missing: true } as never);
  });

  it('throws when all drafts are unparseable', async () => {
    vi.mocked(hanaFetch).mockImplementation(async () => ({
      ok: true,
      json: async () => ({
        ok: true,
        kind: 'accounting_draft',
        result: {
          drafts: [
            { title: 't', direction: 'expense', imaginedAmount: '约一杯', content: 'x' },
          ],
        },
      }),
    } as Response));

    await expect(
      generateAccountingDraftsWithAI({
        agent: { id: 'agent-1', name: 'A', yuan: '' } as never,
        ownerProfile: null,
      }),
    ).rejects.toThrow(/未生成可用的记账草稿|金额或货币解析失败/);
  });

  it('returns parsed drafts when model returns valid envelope', async () => {
    vi.mocked(hanaFetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ok: true,
        kind: 'accounting_draft',
        result: {
          drafts: [
            { title: '五月薪俸', direction: 'income', imaginedAmount: '¥3500', category: '工资', content: 'x' },
            { title: '房租', direction: 'expense', imaginedAmount: '¥1800', category: '房租', counterparty: '房东', content: 'x' },
          ],
        },
      }),
    } as Response);

    const drafts = await generateAccountingDraftsWithAI({
      agent: { id: 'agent-1', name: 'A', yuan: '' } as never,
      ownerProfile: null,
    });

    expect(drafts).toHaveLength(2);
    expect(drafts[0]).toMatchObject({
      title: '五月薪俸',
      direction: 'income',
      amount: 3500,
      currency: '¥',
      category: '工资',
    });
    expect(drafts[1]).toMatchObject({
      title: '房租',
      direction: 'expense',
      amount: 1800,
      currency: '¥',
      counterparty: '房东',
    });
  });

  it('propagates server-side errors', async () => {
    vi.mocked(hanaFetch).mockResolvedValueOnce({
      ok: false,
      json: async () => ({ ok: false, error: 'model timeout' }),
    } as Response);

    await expect(
      generateAccountingDraftsWithAI({
        agent: { id: 'agent-1', name: 'A', yuan: '' } as never,
        ownerProfile: null,
      }),
    ).rejects.toThrow(/model timeout/);
  });
});

describe('ACCOUNTING_AI_DIRECTIONS', () => {
  it('keeps income/expense alignment with AccountingDirection enum', () => {
    expect(ACCOUNTING_AI_DIRECTIONS).toEqual(['income', 'expense']);
  });
});

describe('buildAccountingDraftPrompt historyMode', () => {
  it('injects dayRangeHint and raises count up to 12 in history mode', () => {
    const prompt = buildAccountingDraftPrompt({
      agent: { id: 'a', name: 'Lin', yuan: 'y' as const },
      profile: null,
      userIntent: '',
      recentSceneBlock: '',
      stableLoreBlock: '',
      keywordLoreBlock: '',
      relationshipBlock: '',
      heartbeatBlock: '',
      desiredCount: 8,
      historyMode: { kind: 'initial', dayRangeHint: '过去 14 天', startDays: 0, endDays: 14 },
    });
    expect(prompt).toContain('过去 14 天');
    expect(prompt).toContain('drafts 长度 = 8');
    expect(prompt).toContain('occurredAtHint');
    expect(prompt).toContain('历史批量');
  });

  it('keeps single-draft behavior unchanged without historyMode', () => {
    const prompt = buildAccountingDraftPrompt({
      agent: { id: 'a', name: 'Lin', yuan: 'y' as const },
      profile: null,
      userIntent: '',
      recentSceneBlock: '',
      stableLoreBlock: '',
      keywordLoreBlock: '',
      relationshipBlock: '',
      heartbeatBlock: '',
      desiredCount: 3,
    });
    expect(prompt).toContain('drafts 长度 = 3');
    expect(prompt).not.toContain('历史批量');
  });
});
