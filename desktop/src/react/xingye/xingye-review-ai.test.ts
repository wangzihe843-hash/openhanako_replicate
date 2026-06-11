/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../hooks/use-hana-fetch', () => ({
  hanaFetch: vi.fn(),
}));

vi.mock('./xingye-storage-api', () => ({
  postXingyeStorage: vi.fn(),
}));

import { hanaFetch } from '../hooks/use-hana-fetch';
import { postXingyeStorage } from './xingye-storage-api';
import {
  computeShoppingPurchaseContext,
  generateSecondhandReviewWithAI,
  generateShoppingReviewWithAI,
  normalizeReviewSide,
  normalizeSecondhandReviewResult,
  normalizeShoppingReviewResult,
  starsFromSentiment,
} from './xingye-review-ai';
import {
  buildSecondhandReviewPrompt,
  buildShoppingReviewPrompt,
} from './xingye-review-prompts';

describe('starsFromSentiment', () => {
  it('maps sentiment to the right star band (1-2 bad / 3 neutral / 4-5 good)', () => {
    for (let i = 0; i < 30; i += 1) {
      expect([1, 2]).toContain(starsFromSentiment('bad'));
      expect(starsFromSentiment('neutral')).toBe(3);
      expect([4, 5]).toContain(starsFromSentiment('good'));
    }
  });
});

describe('normalizeReviewSide', () => {
  it('keeps a reviewed side and derives stars from sentiment', () => {
    const bad = normalizeReviewSide('agent', { reviewed: true, sentiment: 'bad', text: '  货不对板  ' });
    expect(bad.reviewed).toBe(true);
    expect(bad.text).toBe('货不对板');
    expect(bad.stars).toBeLessThanOrEqual(2);

    const neutral = normalizeReviewSide('counterparty', { reviewed: true, sentiment: 'neutral', text: '凑合' });
    expect(neutral.stars).toBe(3);

    const good = normalizeReviewSide('agent', { reviewed: true, sentiment: 'good', text: '很满意' });
    expect(good.stars).toBeGreaterThanOrEqual(4);
  });

  it('falls back to a fixed 5-star default review when not reviewed', () => {
    expect(normalizeReviewSide('agent', { reviewed: false, sentiment: 'bad', text: '' })).toEqual({
      by: 'agent',
      reviewed: false,
      stars: 5,
      text: '',
    });
    // reviewed=true but empty text → treated as not reviewed (default 5★)
    expect(normalizeReviewSide('counterparty', { reviewed: true, sentiment: 'good', text: '   ' })).toEqual({
      by: 'counterparty',
      reviewed: false,
      stars: 5,
      text: '',
    });
    // missing reviewed flag → not reviewed
    expect(normalizeReviewSide('agent', { sentiment: 'good', text: '很好' }).reviewed).toBe(false);
    expect(normalizeReviewSide('agent', null)).toEqual({ by: 'agent', reviewed: false, stars: 5, text: '' });
  });
});

describe('normalizeShoppingReviewResult', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits a seller reply on a bad review when the 70% reply gate passes', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5); // 0.5 < 0.7 → 回复；0.5 ≥ 0.2 → 用模板
    const bad = normalizeShoppingReviewResult({
      agent: { reviewed: true, sentiment: 'bad', text: '和图片差太多' },
      sellerReply: '非常抱歉给您带来不好的体验。',
    });
    expect(bad.sides).toHaveLength(1);
    expect(bad.sides[0].by).toBe('agent');
    expect(bad.sides[0].stars).toBeLessThanOrEqual(2);
    expect((bad.sellerReply ?? '').length).toBeGreaterThan(0);
  });

  it('skips the seller reply on a bad review when the 30% no-reply branch hits', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.9); // 0.9 ≥ 0.7 → 店家不回复
    const bad = normalizeShoppingReviewResult({
      agent: { reviewed: true, sentiment: 'bad', text: '差' },
      sellerReply: '抱歉。',
    });
    expect(bad.sides[0].stars).toBeLessThanOrEqual(2);
    expect(bad.sellerReply).toBeNull();
  });

  it('never emits a seller reply for good or skipped reviews', () => {
    const good = normalizeShoppingReviewResult({
      agent: { reviewed: true, sentiment: 'good', text: '很喜欢' },
      sellerReply: '谢谢支持。',
    });
    expect(good.sellerReply).toBeNull();

    const skipped = normalizeShoppingReviewResult({ agent: { reviewed: false }, sellerReply: '...' });
    expect(skipped.sides[0].reviewed).toBe(false);
    expect(skipped.sides[0].stars).toBe(5);
    expect(skipped.sellerReply).toBeNull();
  });
});

describe('normalizeSecondhandReviewResult', () => {
  it('maps seller→agent and buyer→counterparty into two sides', () => {
    const out = normalizeSecondhandReviewResult({
      seller: { reviewed: true, sentiment: 'good', text: '感谢收物，爽快' },
      buyer: { reviewed: true, sentiment: 'bad', text: '成色比想的旧' },
    });
    expect(out.sides).toHaveLength(2);
    const agent = out.sides.find((s) => s.by === 'agent');
    const counterparty = out.sides.find((s) => s.by === 'counterparty');
    expect(agent?.text).toBe('感谢收物，爽快');
    expect(agent?.stars).toBeGreaterThanOrEqual(4);
    expect(counterparty?.text).toBe('成色比想的旧');
    expect(counterparty?.stars).toBeLessThanOrEqual(2);
  });
});

describe('generateShoppingReviewWithAI', () => {
  beforeEach(() => {
    vi.mocked(postXingyeStorage).mockReset();
    vi.mocked(hanaFetch).mockReset();
    vi.mocked(postXingyeStorage).mockResolvedValue({ missing: true } as never);
    vi.mocked(hanaFetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        result: {
          agent: { reviewed: true, sentiment: 'bad', text: '和描述不符，有点失望' },
          sellerReply: '非常抱歉给您带来不好的购物体验，我们会改进。',
        },
      }),
    } as Response);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('posts phone-generate with kind shopping_review and returns a normalized review', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.3); // 差评 → 0.3 < 0.7 触发店家回复（确定性）
    const agent = { id: 'agent-shop', name: 'Lin', yuan: 'y' as const };
    const res = await generateShoppingReviewWithAI({
      agent: agent as never,
      ownerProfile: null,
      entry: { itemName: '帆布包', status: 'received', seller: '光阴杂货', reason: '想换个新包' },
    });
    expect(res.sides[0].by).toBe('agent');
    expect(res.sides[0].stars).toBeLessThanOrEqual(2);
    expect((res.sellerReply ?? '').length).toBeGreaterThan(0);

    const call = vi.mocked(hanaFetch).mock.calls.find((c) => c[0] === '/api/xingye/phone-generate');
    const body = JSON.parse(String(call?.[1]?.body ?? '')) as { kind?: string; prompt?: string };
    expect(body.kind).toBe('shopping_review');
    expect(body.prompt).toContain('购物评价');
    expect(body.prompt).toContain('帆布包');
  });

  it('throws when the server returns ok:false', async () => {
    vi.mocked(hanaFetch).mockResolvedValueOnce({
      ok: false,
      json: async () => ({ ok: false, error: 'model call failed' }),
    } as Response);
    await expect(
      generateShoppingReviewWithAI({
        agent: { id: 'a', name: 'L', yuan: 'y' } as never,
        ownerProfile: null,
        entry: { itemName: 'x', status: 'received' },
      }),
    ).rejects.toThrow(/model call failed/);
  });
});

describe('generateSecondhandReviewWithAI', () => {
  beforeEach(() => {
    vi.mocked(postXingyeStorage).mockReset();
    vi.mocked(hanaFetch).mockReset();
    vi.mocked(postXingyeStorage).mockResolvedValue({ missing: true } as never);
    vi.mocked(hanaFetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        result: {
          seller: { reviewed: true, sentiment: 'good', text: '感谢收物，爽快人' },
          buyer: { reviewed: true, sentiment: 'good', text: '成色和描述一致，卖家很细心' },
        },
      }),
    } as Response);
  });

  it('posts kind secondhand_review and feeds the buyer chat transcript into the prompt', async () => {
    const res = await generateSecondhandReviewWithAI({
      agent: { id: 'agent-sh', name: 'Lin', yuan: 'y' } as never,
      ownerProfile: null,
      entry: { itemName: '旧相机', status: 'sold', buyer: '巷口的旧书客' },
      buyerChatMessages: [
        { role: 'buyer', text: '这个还在吗' },
        { role: 'seller', text: '在的，120 出' },
      ],
    });
    expect(res.sides).toHaveLength(2);
    expect(res.sides.find((s) => s.by === 'agent')?.text).toBe('感谢收物，爽快人');
    expect(res.sides.find((s) => s.by === 'counterparty')?.text).toContain('卖家很细心');

    const call = vi.mocked(hanaFetch).mock.calls.find((c) => c[0] === '/api/xingye/phone-generate');
    const body = JSON.parse(String(call?.[1]?.body ?? '')) as { kind?: string; prompt?: string };
    expect(body.kind).toBe('secondhand_review');
    expect(body.prompt).toContain('在的，120 出');
    expect(body.prompt).toContain('互评');
  });
});

describe('buildShoppingReviewPrompt', () => {
  it('embeds the shared review rules and seller-reply behavior', () => {
    const prompt = buildShoppingReviewPrompt({
      agent: { id: 'a', name: 'Lin', yuan: 'y' as const },
      profile: null,
      entry: { itemName: '帆布包', status: 'returned', seller: '光阴杂货' },
      stableLoreBlock: '',
      keywordLoreBlock: '',
      recentSceneBlock: '',
      relationshipBlock: '',
    });
    expect(prompt).toContain('评价生成通用规则');
    expect(prompt).toContain('sellerReply');
    expect(prompt).toContain('已退掉');
    // 默认好评：reviewed=false 留空 text 的约定要写进 prompt
    expect(prompt).toContain('reviewed:false');
  });

  it('injects the repeat-purchase down-nudge for a received consumable, but not for returns', () => {
    const received = buildShoppingReviewPrompt({
      agent: { id: 'a', name: 'Lin', yuan: 'y' as const },
      profile: null,
      entry: { itemName: '牙膏', status: 'received', seller: '光阴杂货', category: '日用' },
      repeatPurchase: { purchaseCount: 3, priorDissatisfied: false },
      stableLoreBlock: '',
      keywordLoreBlock: '',
      recentSceneBlock: '',
      relationshipBlock: '',
    });
    expect(received).toContain('复购信号');
    expect(received).toContain('第 3 次');
    expect(received).toContain('reviewed 更倾向 false');

    // returned 的不注入复购下调（退货评价语境不同）
    const returned = buildShoppingReviewPrompt({
      agent: { id: 'a', name: 'Lin', yuan: 'y' as const },
      profile: null,
      entry: { itemName: '牙膏', status: 'returned', seller: '光阴杂货', category: '日用' },
      repeatPurchase: { purchaseCount: 3, priorDissatisfied: false },
      stableLoreBlock: '',
      keywordLoreBlock: '',
      recentSceneBlock: '',
      relationshipBlock: '',
    });
    expect(returned).not.toContain('复购信号');
  });
});

describe('computeShoppingPurchaseContext', () => {
  const NOW = Date.parse('2026-06-11T00:00:00.000Z');
  const daysAgoIso = (n: number) => new Date(NOW - n * 86_400_000).toISOString();
  type Row = Parameters<typeof computeShoppingPurchaseContext>[0]['rows'][number];
  const row = (
    id: string,
    itemName: string,
    extra: { category?: string; status?: string; daysAgo?: number } = {},
  ): Row => ({
    id,
    title: itemName,
    createdAt: daysAgoIso(extra.daysAgo ?? 0),
    metadata: {
      itemName,
      ...(extra.category ? { category: extra.category } : {}),
      ...(extra.status ? { status: extra.status } : {}),
      occurredAt: daysAgoIso(extra.daysAgo ?? 0),
    },
  });

  it('counts same-core purchases and flags a clean repeat (prior not dissatisfied)', () => {
    const rows = [
      row('p1', '黑色牙膏', { category: '日用', daysAgo: 90 }),
      row('p2', '白色牙膏', { category: '日用', daysAgo: 40 }),
      row('p3', '牙膏', { category: '日用', daysAgo: 1 }),
    ];
    const ctx = computeShoppingPurchaseContext({
      rows,
      entryId: 'p3',
      itemName: '牙膏',
      category: '日用',
      status: 'received',
    });
    expect(ctx.purchaseCount).toBe(3);
    expect(ctx.repeatPurchase).toEqual({ purchaseCount: 3, priorDissatisfied: false });
  });

  it('marks priorDissatisfied when an earlier same-core purchase was returned or badly reviewed', () => {
    const rows = [
      row('p1', '洗发水', { category: '日用', status: 'returned', daysAgo: 70 }),
      row('p2', '洗发水', { category: '日用', daysAgo: 1 }),
    ];
    const ctx = computeShoppingPurchaseContext({
      rows,
      reviewBadByEntryId: new Set<string>(),
      entryId: 'p2',
      itemName: '洗发水',
      category: '日用',
      status: 'received',
    });
    expect(ctx.repeatPurchase?.priorDissatisfied).toBe(true);

    const ctxBad = computeShoppingPurchaseContext({
      rows: [
        row('b1', '猫粮', { category: '日用', daysAgo: 60 }),
        row('b2', '猫粮', { category: '日用', daysAgo: 1 }),
      ],
      reviewBadByEntryId: new Set<string>(['b1']),
      entryId: 'b2',
      itemName: '猫粮',
      category: '日用',
      status: 'received',
    });
    expect(ctxBad.repeatPurchase?.priorDissatisfied).toBe(true);
  });

  it('does not flag repeat for durables, first purchases, or returns (but still counts)', () => {
    // 耐用品：多次同款仍计数，但不下调评价
    const durable = computeShoppingPurchaseContext({
      rows: [
        row('d1', '台灯', { category: '家具', daysAgo: 30 }),
        row('d2', '台灯', { category: '家具', daysAgo: 1 }),
      ],
      entryId: 'd2',
      itemName: '台灯',
      category: '家具',
      status: 'received',
    });
    expect(durable.purchaseCount).toBe(2);
    expect(durable.repeatPurchase).toBeUndefined();

    // 首购消耗品：无更早同款 → 不下调
    const first = computeShoppingPurchaseContext({
      rows: [row('f1', '牙膏', { category: '日用', daysAgo: 1 })],
      entryId: 'f1',
      itemName: '牙膏',
      category: '日用',
      status: 'received',
    });
    expect(first.purchaseCount).toBe(1);
    expect(first.repeatPurchase).toBeUndefined();

    // 本条是退货：不下调（退货评价语境不同）
    const ret = computeShoppingPurchaseContext({
      rows: [
        row('r1', '牙膏', { category: '日用', daysAgo: 60 }),
        row('r2', '牙膏', { category: '日用', status: 'returned', daysAgo: 1 }),
      ],
      entryId: 'r2',
      itemName: '牙膏',
      category: '日用',
      status: 'returned',
    });
    expect(ret.purchaseCount).toBe(2);
    expect(ret.repeatPurchase).toBeUndefined();
  });
});

describe('buildSecondhandReviewPrompt', () => {
  it('includes the buyer chat transcript and mutual-review framing', () => {
    const prompt = buildSecondhandReviewPrompt({
      agent: { id: 'a', name: 'Lin', yuan: 'y' as const },
      profile: null,
      entry: { itemName: '旧相机', status: 'sold', buyer: '巷口的旧书客' },
      buyerChatMessages: [
        { role: 'buyer', text: '能便宜点吗' },
        { role: 'seller', text: '到价了' },
      ],
      stableLoreBlock: '',
      keywordLoreBlock: '',
      recentSceneBlock: '',
      relationshipBlock: '',
    });
    expect(prompt).toContain('互评');
    expect(prompt).toContain('能便宜点吗');
    expect(prompt).toContain('巷口的旧书客');
    expect(prompt).toContain('买家聊天是最高优先');
  });
});
