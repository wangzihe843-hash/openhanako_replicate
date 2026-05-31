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
  generateSecondhandBuyerChatWithAI,
  generateSecondhandDraftWithAI,
  generateSecondhandHistoryWithAI,
  normalizeSecondhandDraftResult,
  normalizeSecondhandDraftResults,
} from './xingye-secondhand-ai';
import {
  buildSecondhandDraftPrompt,
  SECONDHAND_AI_STATUSES,
} from './xingye-secondhand-prompts';
import { buildSecondhandBuyerChatPrompt } from './xingye-secondhand-buyer-chat-prompts';
import type { SecondhandBuyerChatMessage } from './xingye-secondhand-buyer-chat-store';

describe('normalizeSecondhandDraftResult', () => {
  it('requires itemName and clamps fields, defaulting status/platform', () => {
    expect(
      normalizeSecondhandDraftResult({
        itemName: '  旧台灯  ',
        content: '用不上了，想出掉。',
      }),
    ).toEqual({
      itemName: '旧台灯',
      status: 'to_sell',
      platformStyle: 'generic',
      content: '用不上了，想出掉。',
    });
    expect(normalizeSecondhandDraftResult({ itemName: '' })).toBeNull();
    expect(normalizeSecondhandDraftResult(null)).toBeNull();
  });

  it('coerces unknown enum values back to safe defaults and slices tags', () => {
    const r = normalizeSecondhandDraftResult({
      itemName: '旧相机',
      status: 'maybe',
      platformStyle: 'jd',
      category: '旧物',
      askingPrice: '小几百',
      delta: '卖不上价',
      buyer: '楼下收旧货的',
      reason: '占地方',
      tags: Array.from({ length: 12 }, (_, i) => `t${i}`),
      content: 'c',
    });
    expect(r?.status).toBe('to_sell');
    expect(r?.platformStyle).toBe('generic');
    expect(r?.category).toBe('旧物');
    expect(r?.askingPrice).toBe('小几百');
    expect(r?.delta).toBe('卖不上价');
    expect(r?.buyer).toBe('楼下收旧货的');
    expect(r?.tags?.length).toBeLessThanOrEqual(8);
    // 「小几百」无法定量，amount + currency 应该留空（fallback 路径）
    expect(r?.amount).toBeUndefined();
    expect(r?.currency).toBeUndefined();
  });

  it('locally parses askingPrice → amount + currency (modern, ancient, fantasy, future)', () => {
    const cases: Array<{ price: string; amount: number; currency: string }> = [
      { price: '¥820', amount: 820, currency: '¥' },
      { price: '$22', amount: 22, currency: '$' },
      { price: '一两银子', amount: 1, currency: '两银子' },
      { price: '三百文', amount: 300, currency: '文' },
      { price: '两个大洋', amount: 2, currency: '大洋' },
      { price: '2 枚金币', amount: 2, currency: '金币' },
      { price: '80 信用点', amount: 80, currency: '信用点' },
    ];
    for (const { price, amount, currency } of cases) {
      const r = normalizeSecondhandDraftResult({
        itemName: '旧物',
        askingPrice: price,
        content: 'x',
      });
      expect(r?.amount, `failed on "${price}"`).toBe(amount);
      expect(r?.currency, `failed on "${price}"`).toBe(currency);
    }
  });

  it('leaves amount + currency undefined for fallback "约/换" writings', () => {
    const r = normalizeSecondhandDraftResult({
      itemName: '旧物',
      askingPrice: '约换一只新壶',
      content: 'x',
    });
    expect(r?.askingPrice).toBe('约换一只新壶');
    expect(r?.amount).toBeUndefined();
    expect(r?.currency).toBeUndefined();
  });
});

describe('generateSecondhandDraftWithAI', () => {
  beforeEach(() => {
    vi.mocked(postXingyeStorage).mockReset();
    vi.mocked(hanaFetch).mockReset();
    vi.mocked(postXingyeStorage).mockResolvedValue({ missing: true } as never);
    vi.mocked(hanaFetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        result: {
          itemName: '旧台灯',
          status: 'to_sell',
          platformStyle: 'generic',
          category: '旧物',
          askingPrice: '一杯奶茶钱',
          delta: '亏一点也认了',
          buyer: '楼下收旧货的',
          reason: '换书桌后用不上了。',
          tags: ['旧物', '断舍离'],
          content: '陪了我两年，但新桌子配不上它。',
        },
      }),
    } as Response);
  });

  it('posts phone-generate with kind secondhand_draft and a first-person agent prompt', async () => {
    const agent = { id: 'agent-s', name: 'Lin', yuan: 'y' as const };
    const result = await generateSecondhandDraftWithAI({
      agent: agent as never,
      ownerProfile: null,
      userIntent: '想出掉旧台灯',
    });
    expect(result.itemName).toBe('旧台灯');
    expect(result.status).toBe('to_sell');
    expect(result.platformStyle).toBe('generic');
    expect(hanaFetch).toHaveBeenCalledWith(
      '/api/xingye/phone-generate',
      expect.objectContaining({ method: 'POST' }),
    );
    const call = vi.mocked(hanaFetch).mock.calls.find((c) => c[0] === '/api/xingye/phone-generate');
    const body = JSON.parse(String(call?.[1]?.body ?? '')) as { kind?: string; prompt?: string };
    expect(body.kind).toBe('secondhand_draft');
    expect(body.prompt).toContain('二手');
    expect(body.prompt).toContain('第一人称');
    expect(body.prompt).toContain('想出掉旧台灯');
    expect(body.prompt).toContain('不会真的挂平台');
  });

  it('gracefully degrades when no recent chat / heartbeat / lore is available', async () => {
    const agent = { id: 'agent-empty', name: 'Lin', yuan: 'y' as const };
    await expect(
      generateSecondhandDraftWithAI({ agent: agent as never, ownerProfile: null, userIntent: '' }),
    ).resolves.toMatchObject({ itemName: '旧台灯' });
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
      generateSecondhandDraftWithAI({ agent: agent as never, ownerProfile: null }),
    ).rejects.toThrow(/model call failed/);
  });
});

describe('normalizeSecondhandDraftResult occurredAtHint', () => {
  it('parses occurredAtHint to ISO when present', () => {
    const r = normalizeSecondhandDraftResult({
      itemName: '旧相机',
      content: 'x',
      occurredAtHint: '3 天前',
    });
    expect(r?.occurredAt).toBeDefined();
  });

  it('leaves occurredAt undefined for unparseable hints', () => {
    const r = normalizeSecondhandDraftResult({
      itemName: '旧相机',
      content: 'x',
      occurredAtHint: '反正最近',
    });
    expect(r?.occurredAtHint).toBe('反正最近');
    expect(r?.occurredAt).toBeUndefined();
  });
});

describe('normalizeSecondhandDraftResults', () => {
  it('accepts { drafts: [...] } envelope and filters invalid items', () => {
    const out = normalizeSecondhandDraftResults({
      drafts: [
        { itemName: '旧相机', content: 'x', occurredAtHint: '2 天前' },
        { itemName: '', content: 'x' },
        { itemName: '旧水壶', content: 'x', occurredAtHint: '昨天' },
      ],
    });
    expect(out).toHaveLength(2);
  });

  it('accepts bare array and returns empty on non-object', () => {
    expect(normalizeSecondhandDraftResults([{ itemName: 'a', content: 'x' }])).toHaveLength(1);
    expect(normalizeSecondhandDraftResults(null)).toEqual([]);
  });
});

describe('generateSecondhandHistoryWithAI', () => {
  beforeEach(() => {
    vi.mocked(postXingyeStorage).mockReset();
    vi.mocked(hanaFetch).mockReset();
    vi.mocked(postXingyeStorage).mockResolvedValue({ missing: true } as never);
  });

  it('returns multiple drafts', async () => {
    vi.mocked(hanaFetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ok: true,
        kind: 'secondhand_draft',
        result: {
          drafts: [
            { itemName: '旧相机', status: 'sold', content: 'x', occurredAtHint: '2 天前' },
            { itemName: '旧水壶', status: 'listed', content: 'x', occurredAtHint: '昨天' },
          ],
        },
      }),
    } as Response);
    const drafts = await generateSecondhandHistoryWithAI({
      agent: { id: 'agent-r', name: 'A', yuan: '' } as never,
      ownerProfile: null,
      historyMode: { kind: 'initial', dayRangeHint: '过去 14 天', startDays: 0, endDays: 14 },
      desiredCount: 2,
    });
    expect(drafts).toHaveLength(2);
    expect(drafts[0].occurredAt).toBeDefined();
  });

  it('throws when no valid drafts return', async () => {
    vi.mocked(hanaFetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, kind: 'secondhand_draft', result: { drafts: [] } }),
    } as Response);
    await expect(
      generateSecondhandHistoryWithAI({
        agent: { id: 'agent-r', name: 'A', yuan: '' } as never,
        ownerProfile: null,
        historyMode: { kind: 'recent', dayRangeHint: '过去 3 天', startDays: 0, endDays: 3 },
        desiredCount: 3,
      }),
    ).rejects.toThrow(/未生成可用的二手记录草稿/);
  });
});

describe('buildSecondhandDraftPrompt', () => {
  it('tells the model all six statuses are valid active generation choices', () => {
    const prompt = buildSecondhandDraftPrompt({
      agent: { id: 'agent-s', name: 'Lin', yuan: 'y' as const },
      profile: null,
      userIntent: '有人问旧相机还能不能出',
      recentSceneBlock: '',
      stableLoreBlock: '',
      keywordLoreBlock: '',
      relationshipBlock: '',
      heartbeatBlock: '',
    });

    for (const status of SECONDHAND_AI_STATUSES) {
      expect(prompt).toContain(`"${status}"`);
    }
    expect(prompt).toContain('所有 6 个 status 都可以主动生成');
    expect(prompt).toContain('不要无脑回退到 "to_sell"');
  });

  it('injects { drafts: [...] } envelope, occurredAtHint, and dayRange hint in history mode', () => {
    const prompt = buildSecondhandDraftPrompt({
      agent: { id: 'agent-r', name: 'Lin', yuan: 'y' as const },
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

describe('buildSecondhandBuyerChatPrompt · mode=append_closing', () => {
  const prior: Array<{ role: 'buyer' | 'seller'; text: string }> = [
    { role: 'buyer', text: '这件还在吗' },
    { role: 'seller', text: '在的，120 出' },
    { role: 'buyer', text: '能不能再松点' },
  ];

  it('builds a closing-only continuation prompt (1-3 msgs), not a full transcript', () => {
    const prompt = buildSecondhandBuyerChatPrompt({
      agent: { id: 'a', name: 'Lin', yuan: 'y' as never },
      profile: null,
      entry: { itemName: '灰色长款风衣', status: 'sold', askingPrice: '¥120', buyer: '巷口收旧衣的' },
      desiredMessageCount: 10,
      stableLoreBlock: '',
      keywordLoreBlock: '',
      relationshipBlock: '',
      mode: 'append_closing',
      priorMessages: prior,
    });
    // 续写指令，而不是「整段 / 第一条必须 buyer / 固定 N 条」那套
    expect(prompt).toContain('已经成交了');
    expect(prompt).toContain('只续写收尾');
    expect(prompt).toContain('1–3 条');
    expect(prompt).not.toContain('第一条 role 必须是 "buyer"');
    // 两种收尾基调都给到：简短成交收尾 + 收到货后不满意
    expect(prompt).toContain('收到货后觉得有点不满意');
    expect(prompt).toContain('成交收尾');
    // 售后不满也不能演变成整单退货（与「已售出」矛盾）
    expect(prompt).toContain('不要**写成整单退货');
    // 收到货后的反馈用 afterDelivery 标记，让本地补一个隔天间隔
    expect(prompt).toContain('afterDelivery');
    // 既有对话作为上下文带入
    expect(prompt).toContain('能不能再松点');
    // 上一条是 buyer → 提示续写第一条应为「卖家」
    expect(prompt).toContain('卖家');
  });
});

describe('generateSecondhandBuyerChatWithAI · mode=append_closing', () => {
  const prior: SecondhandBuyerChatMessage[] = [
    { id: 'm1', role: 'buyer', text: '还在吗', at: '2026-05-20T10:00:00.000Z' },
    { id: 'm2', role: 'seller', text: '在，120', at: '2026-05-20T10:02:00.000Z' },
  ];

  beforeEach(() => {
    vi.mocked(postXingyeStorage).mockReset();
    vi.mocked(hanaFetch).mockReset();
    vi.mocked(postXingyeStorage).mockResolvedValue({ missing: true } as never);
  });

  it('returns only the 1-3 closing messages, timestamped after the last prior message', async () => {
    vi.mocked(hanaFetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        result: { messages: [{ role: 'buyer', text: '那我要了' }, { role: 'seller', text: '好，明天来拿' }] },
      }),
    } as Response);

    const res = await generateSecondhandBuyerChatWithAI({
      agent: { id: 'a', name: 'Lin', yuan: 'y' } as never,
      ownerProfile: null,
      entry: {
        id: 'e1',
        updatedAt: '2026-05-21T09:00:00.000Z',
        metadata: { itemName: '灰色长款风衣', status: 'sold', askingPrice: '¥120' },
      },
      mode: 'append_closing',
      priorMessages: prior,
    });

    expect(res.messages).toHaveLength(2);
    expect(res.messages[0].text).toBe('那我要了');
    // 时间戳排在既有最后一条（10:02）之后
    expect(Date.parse(res.messages[0].at)).toBeGreaterThan(Date.parse('2026-05-20T10:02:00.000Z'));
    // 走的是 buyer_chat kind
    const call = vi.mocked(hanaFetch).mock.calls.find((c) => c[0] === '/api/xingye/phone-generate');
    const body = JSON.parse(String(call?.[1]?.body ?? '')) as { kind?: string };
    expect(body.kind).toBe('secondhand_buyer_chat');
  });

  it('inserts a multi-day gap before an afterDelivery (post-receipt) message', async () => {
    vi.mocked(hanaFetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        result: {
          messages: [
            { role: 'buyer', text: '行那我要了' },
            { role: 'buyer', text: '收到了，成色比想的旧', afterDelivery: true },
          ],
        },
      }),
    } as Response);

    const res = await generateSecondhandBuyerChatWithAI({
      agent: { id: 'a', name: 'Lin', yuan: 'y' } as never,
      ownerProfile: null,
      entry: { id: 'e1', updatedAt: '2026-05-21T09:00:00.000Z', metadata: { itemName: 'X', status: 'sold' } },
      mode: 'append_closing',
      priorMessages: prior,
    });

    expect(res.messages).toHaveLength(2);
    const gapMs = Date.parse(res.messages[1].at) - Date.parse(res.messages[0].at);
    // afterDelivery 那条至少隔了 1 天
    expect(gapMs).toBeGreaterThan(86_400_000);
  });

  it('caps the closing at 3 messages even if the model returns more', async () => {
    vi.mocked(hanaFetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        result: {
          messages: [
            { role: 'buyer', text: '要了' }, { role: 'seller', text: '好' },
            { role: 'buyer', text: '几点' }, { role: 'seller', text: '下午' }, { role: 'buyer', text: '行' },
          ],
        },
      }),
    } as Response);

    const res = await generateSecondhandBuyerChatWithAI({
      agent: { id: 'a', name: 'Lin', yuan: 'y' } as never,
      ownerProfile: null,
      entry: { id: 'e1', updatedAt: '2026-05-21T09:00:00.000Z', metadata: { itemName: 'X', status: 'sold' } },
      mode: 'append_closing',
      priorMessages: prior,
    });
    expect(res.messages.length).toBeLessThanOrEqual(3);
  });
});
