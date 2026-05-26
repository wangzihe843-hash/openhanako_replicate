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
  generateShoppingDraftWithAI,
  generateShoppingHistoryWithAI,
  normalizeShoppingDraftResult,
  normalizeShoppingDraftResults,
} from './xingye-shopping-ai';
import {
  buildShoppingDraftPrompt,
  SHOPPING_AI_STATUSES,
} from './xingye-shopping-prompts';

describe('normalizeShoppingDraftResult', () => {
  it('requires itemName and clamps fields, defaulting status/platform', () => {
    expect(
      normalizeShoppingDraftResult({
        itemName: '  深色台灯  ',
        content: '今晚刷到的，挺合我口味。',
      }),
    ).toEqual({
      itemName: '深色台灯',
      status: 'wanted',
      platformStyle: 'generic',
      content: '今晚刷到的，挺合我口味。',
    });
    expect(normalizeShoppingDraftResult({ itemName: '' })).toBeNull();
    expect(normalizeShoppingDraftResult(null)).toBeNull();
  });

  it('coerces unknown enum values back to safe defaults and slices tags', () => {
    const r = normalizeShoppingDraftResult({
      itemName: '保温杯',
      status: 'maybe',
      platformStyle: 'jd',
      category: '日用',
      imaginedPrice: '小几百',
      reason: '冬天上班用',
      tags: Array.from({ length: 12 }, (_, i) => `t${i}`),
      content: 'c',
    });
    expect(r?.status).toBe('wanted');
    expect(r?.platformStyle).toBe('generic');
    expect(r?.category).toBe('日用');
    expect(r?.imaginedPrice).toBe('小几百');
    expect(r?.tags?.length).toBeLessThanOrEqual(8);
    // 「小几百」无法定量，amount + currency 应该留空（fallback 路径）
    expect(r?.amount).toBeUndefined();
    expect(r?.currency).toBeUndefined();
  });

  it('locally parses imaginedPrice → amount + currency (modern, ancient, fantasy, future)', () => {
    const cases: Array<{ price: string; amount: number; currency: string }> = [
      { price: '¥1,280', amount: 1280, currency: '¥' },
      { price: '$35', amount: 35, currency: '$' },
      { price: '二两银子', amount: 2, currency: '两银子' },
      { price: '八百文', amount: 800, currency: '文' },
      { price: '三个大洋', amount: 3, currency: '大洋' },
      { price: '5 枚金币', amount: 5, currency: '金币' },
      { price: '120 信用点', amount: 120, currency: '信用点' },
    ];
    for (const { price, amount, currency } of cases) {
      const r = normalizeShoppingDraftResult({
        itemName: '物件',
        imaginedPrice: price,
        content: 'x',
      });
      expect(r?.amount, `failed on "${price}"`).toBe(amount);
      expect(r?.currency, `failed on "${price}"`).toBe(currency);
    }
  });

  it('leaves amount + currency undefined for fallback "约/换" writings', () => {
    const r = normalizeShoppingDraftResult({
      itemName: '小物件',
      imaginedPrice: '约一杯奶茶钱',
      content: 'x',
    });
    expect(r?.imaginedPrice).toBe('约一杯奶茶钱');
    expect(r?.amount).toBeUndefined();
    expect(r?.currency).toBeUndefined();
  });
});

describe('generateShoppingDraftWithAI', () => {
  beforeEach(() => {
    vi.mocked(postXingyeStorage).mockReset();
    vi.mocked(hanaFetch).mockReset();
    vi.mocked(postXingyeStorage).mockResolvedValue({ missing: true } as never);
    vi.mocked(hanaFetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        result: {
          itemName: '深色台灯',
          status: 'wanted',
          platformStyle: 'generic',
          category: '日用',
          imaginedPrice: '一杯奶茶钱',
          reason: '夜里写字眼睛会舒服点。',
          tags: ['日用', '夜里'],
          content: '今天看到挺顺眼的，先记下，回头再决定。',
        },
      }),
    } as Response);
  });

  it('posts phone-generate with kind shopping_draft and a first-person agent prompt', async () => {
    const agent = { id: 'agent-s', name: 'Lin', yuan: 'y' as const };
    const result = await generateShoppingDraftWithAI({
      agent: agent as never,
      ownerProfile: null,
      userIntent: '想买个台灯',
    });
    expect(result.itemName).toBe('深色台灯');
    expect(result.status).toBe('wanted');
    expect(result.platformStyle).toBe('generic');
    expect(hanaFetch).toHaveBeenCalledWith(
      '/api/xingye/phone-generate',
      expect.objectContaining({ method: 'POST' }),
    );
    const call = vi.mocked(hanaFetch).mock.calls.find((c) => c[0] === '/api/xingye/phone-generate');
    const body = JSON.parse(String(call?.[1]?.body ?? '')) as { kind?: string; prompt?: string };
    expect(body.kind).toBe('shopping_draft');
    expect(body.prompt).toContain('购物');
    expect(body.prompt).toContain('第一人称');
    expect(body.prompt).toContain('想买个台灯');
    expect(body.prompt).toContain('不会真的下单');
  });

  it('gracefully degrades when no recent chat / heartbeat / lore is available', async () => {
    const agent = { id: 'agent-empty', name: 'Lin', yuan: 'y' as const };
    await expect(
      generateShoppingDraftWithAI({ agent: agent as never, ownerProfile: null, userIntent: '' }),
    ).resolves.toMatchObject({ itemName: '深色台灯' });
    const call = vi.mocked(hanaFetch).mock.calls.find((c) => c[0] === '/api/xingye/phone-generate');
    const body = JSON.parse(String(call?.[1]?.body ?? '')) as { prompt?: string };
    expect(body.prompt).toContain('（无）');
  });

  it('throws when server returns ok:false', async () => {
    vi.mocked(hanaFetch).mockResolvedValueOnce({
      ok: false,
      json: async () => ({ ok: false, error: 'model call failed' }),
    } as Response);
    const agent = { id: 'agent-err', name: 'Lin', yuan: 'y' as const };
    await expect(
      generateShoppingDraftWithAI({ agent: agent as never, ownerProfile: null }),
    ).rejects.toThrow(/model call failed/);
  });
});

describe('normalizeShoppingDraftResult occurredAtHint', () => {
  it('parses occurredAtHint to ISO when present (历史批量场景)', () => {
    const r = normalizeShoppingDraftResult({
      itemName: '旧台灯',
      content: 'x',
      occurredAtHint: '3 天前',
    });
    expect(r?.occurredAtHint).toBe('3 天前');
    expect(r?.occurredAt).toBeDefined();
    const diff = Date.now() - new Date(r!.occurredAt!).getTime();
    expect(diff).toBeGreaterThanOrEqual(2 * 24 * 3600 * 1000);
    expect(diff).toBeLessThanOrEqual(5 * 24 * 3600 * 1000);
  });

  it('leaves occurredAt undefined when hint is unparseable', () => {
    const r = normalizeShoppingDraftResult({
      itemName: '旧台灯',
      content: 'x',
      occurredAtHint: '反正最近',
    });
    expect(r?.occurredAtHint).toBe('反正最近');
    expect(r?.occurredAt).toBeUndefined();
  });
});

describe('normalizeShoppingDraftResults', () => {
  it('accepts { drafts: [...] } envelope and filters invalid items', () => {
    const out = normalizeShoppingDraftResults({
      drafts: [
        { itemName: '台灯', content: 'x', occurredAtHint: '2 天前' },
        { itemName: '', content: 'x' }, // dropped
        { itemName: '收纳盒', content: 'x', occurredAtHint: '昨天' },
      ],
    });
    expect(out).toHaveLength(2);
    expect(out[0].itemName).toBe('台灯');
    expect(out[1].occurredAt).toBeDefined();
  });

  it('accepts bare array as fallback and returns empty on non-object', () => {
    expect(normalizeShoppingDraftResults([{ itemName: 'a', content: 'x' }])).toHaveLength(1);
    expect(normalizeShoppingDraftResults(null)).toEqual([]);
    expect(normalizeShoppingDraftResults({ drafts: [] })).toEqual([]);
    expect(normalizeShoppingDraftResults({ drafts: 'nope' })).toEqual([]);
  });
});

describe('generateShoppingHistoryWithAI', () => {
  beforeEach(() => {
    vi.mocked(postXingyeStorage).mockReset();
    vi.mocked(hanaFetch).mockReset();
    vi.mocked(postXingyeStorage).mockResolvedValue({ missing: true } as never);
  });

  it('returns multiple drafts and propagates occurredAt', async () => {
    vi.mocked(hanaFetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ok: true,
        kind: 'shopping_draft',
        result: {
          drafts: [
            { itemName: '旧台灯', status: 'wanted', content: 'x', occurredAtHint: '2 天前' },
            { itemName: '日用伞', status: 'received', content: 'x', occurredAtHint: '昨天' },
            { itemName: '帆布袋', status: 'favorite', content: 'x', occurredAtHint: '5 天前' },
          ],
        },
      }),
    } as Response);

    const drafts = await generateShoppingHistoryWithAI({
      agent: { id: 'agent-s', name: 'A', yuan: '' } as never,
      ownerProfile: null,
      historyMode: { kind: 'initial', dayRangeHint: '过去 14 天', startDays: 0, endDays: 14 },
      desiredCount: 3,
    });

    expect(drafts).toHaveLength(3);
    expect(drafts[0].itemName).toBe('旧台灯');
    expect(drafts[0].occurredAt).toBeDefined();
    expect(drafts[1].occurredAt).toBeDefined();
  });

  it('throws when no valid drafts return', async () => {
    vi.mocked(hanaFetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, kind: 'shopping_draft', result: { drafts: [] } }),
    } as Response);

    await expect(
      generateShoppingHistoryWithAI({
        agent: { id: 'agent-s', name: 'A', yuan: '' } as never,
        ownerProfile: null,
        historyMode: { kind: 'recent', dayRangeHint: '过去 3 天', startDays: 0, endDays: 3 },
        desiredCount: 3,
      }),
    ).rejects.toThrow(/未生成可用的购物记录草稿/);
  });
});

describe('buildShoppingDraftPrompt', () => {
  it('tells the model all six statuses are valid active generation choices', () => {
    const prompt = buildShoppingDraftPrompt({
      agent: { id: 'agent-s', name: 'Lin', yuan: 'y' as const },
      profile: null,
      userIntent: '刚下单了台灯，等到货',
      recentSceneBlock: '',
      stableLoreBlock: '',
      keywordLoreBlock: '',
      relationshipBlock: '',
      heartbeatBlock: '',
    });

    for (const status of SHOPPING_AI_STATUSES) {
      expect(prompt).toContain(`"${status}"`);
    }
    expect(prompt).toContain('所有 6 个 status 都可以主动生成');
    expect(prompt).toContain('不要无脑回退到 "wanted"');
  });

  it('injects { drafts: [...] } envelope, occurredAtHint, and dayRange hint in history mode', () => {
    const prompt = buildShoppingDraftPrompt({
      agent: { id: 'agent-s', name: 'Lin', yuan: 'y' as const },
      profile: null,
      userIntent: '',
      recentSceneBlock: '',
      stableLoreBlock: '',
      keywordLoreBlock: '',
      relationshipBlock: '',
      heartbeatBlock: '',
      historyMode: { kind: 'initial', dayRangeHint: '过去 14 天', startDays: 0, endDays: 14 },
      desiredCount: 5,
    });
    expect(prompt).toContain('drafts');
    expect(prompt).toContain('occurredAtHint');
    expect(prompt).toContain('过去 14 天');
    expect(prompt).toContain('drafts 长度 = 5');
  });
});
