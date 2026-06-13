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
  partitionShoppingRecentItems,
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

  it('renders the recent-items anti-repeat anchor when provided, fallback when absent', () => {
    const base = {
      agent: { id: 'agent-s', name: 'Lin', yuan: 'y' as const },
      profile: null,
      userIntent: '',
      recentSceneBlock: '',
      stableLoreBlock: '',
      keywordLoreBlock: '',
      relationshipBlock: '',
      heartbeatBlock: '',
    };
    const withItems = buildShoppingDraftPrompt({
      ...base,
      recentItemsBlock: '「深色台灯」、「保温杯」、「帆布袋」',
    });
    expect(withItems).toContain('【近期已记录的物品 · 不要重复】');
    expect(withItems).toContain('「深色台灯」、「保温杯」、「帆布袋」');
    expect(withItems).toContain('不是把同一件再记一遍');

    const withoutItems = buildShoppingDraftPrompt(base);
    expect(withoutItems).toContain('【近期已记录的物品 · 不要重复】');
    expect(withoutItems).toContain('（无；TA 还没记过购物，放手写）');
  });

  it('renders the periodic-restock block + seller rules when provided, fallback when absent', () => {
    const base = {
      agent: { id: 'agent-s', name: 'Lin', yuan: 'y' as const },
      profile: null,
      userIntent: '',
      recentSceneBlock: '',
      stableLoreBlock: '',
      keywordLoreBlock: '',
      relationshipBlock: '',
      heartbeatBlock: '',
    };
    const withPeriodic = buildShoppingDraftPrompt({
      ...base,
      periodicRestockBlock: '「牙膏」· 上次卖家：光阴杂货 · 上次评价：好评',
    });
    expect(withPeriodic).toContain('【周期性补货品 · 到补货周期，可以再次购买（但要按上次体验挑卖家）】');
    expect(withPeriodic).toContain('「牙膏」· 上次卖家：光阴杂货 · 上次评价：好评');
    // 卖家规则两条都在
    expect(withPeriodic).toContain('换一家卖家');
    expect(withPeriodic).toContain('通常还在原来那家买');

    const withoutPeriodic = buildShoppingDraftPrompt(base);
    expect(withoutPeriodic).toContain('【周期性补货品 · 到补货周期，可以再次购买（但要按上次体验挑卖家）】');
    expect(withoutPeriodic).toContain('（无；TA 目前没有到补货周期的消耗品');
  });

  it('renders the returned-rebuy block + another-store rule when provided, fallback when absent', () => {
    const base = {
      agent: { id: 'agent-s', name: 'Lin', yuan: 'y' as const },
      profile: null,
      userIntent: '',
      recentSceneBlock: '',
      stableLoreBlock: '',
      keywordLoreBlock: '',
      relationshipBlock: '',
      heartbeatBlock: '',
    };
    const withRebuy = buildShoppingDraftPrompt({
      ...base,
      returnedRebuyBlock: '「咖啡豆」· 上次退货那家：巷尾烘焙',
    });
    expect(withRebuy).toContain('【上次退掉的商品 · 这次可以从别家再买类似的】');
    expect(withRebuy).toContain('「咖啡豆」· 上次退货那家：巷尾烘焙');
    expect(withRebuy).toContain('一定要换一家卖家');

    const withoutRebuy = buildShoppingDraftPrompt(base);
    expect(withoutRebuy).toContain('【上次退掉的商品 · 这次可以从别家再买类似的】');
    expect(withoutRebuy).toContain('（无；TA 最近没有要从别家重买的退货商品');
  });
});

describe('partitionShoppingRecentItems', () => {
  // 固定 now，用相对天数构造 occurredAt，避免 Date.now() 漂移让窗口判定不稳。
  const NOW = Date.parse('2026-06-11T00:00:00.000Z');
  const daysAgoIso = (n: number) => new Date(NOW - n * 86_400_000).toISOString();
  type Row = Parameters<typeof partitionShoppingRecentItems>[0]['rows'][number];
  const row = (
    id: string,
    itemName: string,
    extra: { category?: string; tags?: string[]; seller?: string; status?: string; daysAgo?: number } = {},
  ): Row => ({
    id,
    title: itemName,
    createdAt: daysAgoIso(extra.daysAgo ?? 0),
    metadata: {
      itemName,
      ...(extra.category ? { category: extra.category } : {}),
      ...(extra.tags ? { tags: extra.tags } : {}),
      ...(extra.seller ? { seller: extra.seller } : {}),
      ...(extra.status ? { status: extra.status } : {}),
      occurredAt: daysAgoIso(extra.daysAgo ?? 0),
    },
  });

  it('puts durables and in-window consumables into avoid, beyond-window consumables into periodic', () => {
    const out = partitionShoppingRecentItems({
      nowMs: NOW,
      rows: [
        row('d1', '实木书架', { category: '家具', daysAgo: 3 }), // 耐用品 → avoid
        row('c1', '抽纸', { category: '日用', daysAgo: 5 }), // 消耗品窗口内 → avoid
        row('c2', '牙膏', { category: '日用', seller: '光阴杂货', daysAgo: 60 }), // 超窗口 → periodic
      ],
    });
    expect(out.avoidNames).toContain('实木书架');
    expect(out.avoidNames).toContain('抽纸');
    expect(out.avoidNames).not.toContain('牙膏');
    expect(out.periodicItems).toEqual([
      { name: '牙膏', seller: '光阴杂货', reviewNote: '未评价' },
    ]);
    expect(out.returnedRebuyItems).toHaveLength(0);
  });

  it('derives periodic reviewNote from review sentiment map; returned items leave periodic for the rebuy bucket', () => {
    const out = partitionShoppingRecentItems({
      nowMs: NOW,
      rng: () => 0, // 退货品必中签 → 落「退货重买」桶
      reviewSentimentByEntryId: new Map([
        ['good1', 'good'],
        ['bad1', 'bad'],
      ]),
      rows: [
        row('good1', '猫粮', { category: '日用', seller: '街口宠物铺', daysAgo: 45 }),
        row('bad1', '洗发水', { category: '日用', seller: '楼下超市', daysAgo: 50 }),
        row('ret1', '咖啡豆', { category: '咖啡', seller: '巷尾烘焙', status: 'returned', daysAgo: 40 }),
      ],
    });
    const byName = Object.fromEntries(out.periodicItems.map((it) => [it.name, it.reviewNote]));
    expect(byName['猫粮']).toBe('好评');
    expect(byName['洗发水']).toBe('差评');
    // 退货品不再进 periodic，而是进「退货重买」桶（带上次退货那家卖家供避开）。
    expect(byName['咖啡豆']).toBeUndefined();
    expect(out.returnedRebuyItems).toContainEqual({ name: '咖啡豆', seller: '巷尾烘焙', consumable: true });
  });

  it('returned items roll the dice: consumables re-bought more often than durables', () => {
    const rows = [
      row('rc', '牙膏', { category: '日用', seller: '光阴杂货', status: 'returned', daysAgo: 5 }),
      row('rd', '书桌', { category: '家具', seller: '老周木作', status: 'returned', daysAgo: 5 }),
    ];
    // rng=0（恒中）：消耗品 + 耐用品都进「退货重买」。
    const all = partitionShoppingRecentItems({ nowMs: NOW, rng: () => 0, rows });
    expect(all.returnedRebuyItems.map((it) => it.name).sort()).toEqual(['书桌', '牙膏']);
    expect(all.avoidNames).toHaveLength(0);

    // rng=0.95（恒不中）：都落选 → 进「不要重复」，这一轮不重买。
    const none = partitionShoppingRecentItems({ nowMs: NOW, rng: () => 0.95, rows });
    expect(none.returnedRebuyItems).toHaveLength(0);
    expect(none.avoidNames.sort()).toEqual(['书桌', '牙膏']);

    // rng=0.5：落在耐用品阈值(0.3)与消耗品阈值(0.7)之间 → 仅消耗品中签（验证消耗品概率 > 耐用品）。
    const mid = partitionShoppingRecentItems({ nowMs: NOW, rng: () => 0.5, rows });
    expect(mid.returnedRebuyItems.map((it) => it.name)).toEqual(['牙膏']);
    expect(mid.returnedRebuyItems[0]).toMatchObject({ seller: '光阴杂货', consumable: true });
    expect(mid.avoidNames).toEqual(['书桌']);
  });

  it('returned items ignore the restock window (recently-returned still eligible to re-buy)', () => {
    // 退货品不看 30 天窗口：3 天前刚退的消耗品也能中签从别家再买。
    const out = partitionShoppingRecentItems({
      nowMs: NOW,
      rng: () => 0,
      rows: [row('r', '洗面奶', { category: '日用', seller: '楼下超市', status: 'returned', daysAgo: 3 })],
    });
    expect(out.returnedRebuyItems).toContainEqual({ name: '洗面奶', seller: '楼下超市', consumable: true });
    expect(out.avoidNames).toHaveLength(0);
    expect(out.periodicItems).toHaveLength(0);
  });

  it('folds variants by core type and keeps the most recent purchase as representative', () => {
    const out = partitionShoppingRecentItems({
      nowMs: NOW,
      rows: [
        row('old', '黑色牙膏', { category: '日用', seller: '老店', daysAgo: 90 }),
        row('new', '白色牙膏', { category: '日用', seller: '新店', daysAgo: 40 }),
      ],
    });
    // 同核心品类「牙膏」只出现一次，且取最近一次（新店）。
    expect(out.periodicItems).toHaveLength(1);
    expect(out.periodicItems[0]).toMatchObject({ seller: '新店' });
  });

  it('excludes collection items from both buckets', () => {
    const out = partitionShoppingRecentItems({
      nowMs: NOW,
      collectionKeywords: ['手办'],
      rows: [
        row('h1', '限量手办', { category: '玩具', daysAgo: 80 }),
        row('h2', '新款手办', { category: '玩具', daysAgo: 2 }),
      ],
    });
    expect(out.avoidNames).toHaveLength(0);
    expect(out.periodicItems).toHaveLength(0);
  });
});
