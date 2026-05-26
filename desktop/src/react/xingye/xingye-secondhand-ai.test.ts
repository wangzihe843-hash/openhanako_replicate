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
  generateSecondhandDraftWithAI,
  normalizeSecondhandDraftResult,
} from './xingye-secondhand-ai';
import {
  buildSecondhandDraftPrompt,
  SECONDHAND_AI_STATUSES,
} from './xingye-secondhand-prompts';

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
});
