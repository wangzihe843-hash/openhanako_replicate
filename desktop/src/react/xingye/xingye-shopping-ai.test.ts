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
  normalizeShoppingDraftResult,
} from './xingye-shopping-ai';

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
