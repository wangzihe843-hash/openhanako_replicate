/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../hooks/use-hana-fetch', () => ({ hanaFetch: vi.fn() }));
vi.mock('./xingye-storage-api', () => ({ postXingyeStorage: vi.fn() }));
vi.mock('./xingye-secondhand-buyer-chat-store', () => ({
  readSecondhandBuyerChat: vi.fn(),
  saveSecondhandBuyerChat: vi.fn(),
}));

import { hanaFetch } from '../hooks/use-hana-fetch';
import { postXingyeStorage } from './xingye-storage-api';
import {
  readSecondhandBuyerChat,
  saveSecondhandBuyerChat,
} from './xingye-secondhand-buyer-chat-store';
import { ensureSecondhandBuyerChat } from './xingye-secondhand-ai';

const agent = { id: 'agent-x', name: 'Lin', yuan: 'y' } as never;

/** 8 条交替（buyer 先开口），满足 normalize 的 minCount（≤6）。 */
function fullMessages() {
  return Array.from({ length: 8 }, (_, i) => ({
    role: i % 2 === 0 ? 'buyer' : 'seller',
    text: i % 2 === 0 ? `买家说${i}` : `卖家说${i}`,
  }));
}

function entryWith(status: 'sold' | 'negotiating') {
  return {
    id: 'e1',
    updatedAt: '2026-05-21T09:00:00.000Z',
    content: '占地方了',
    metadata: { itemName: '旧相机', status, buyer: '巷口的旧书客', askingPrice: '¥120' },
  };
}

beforeEach(() => {
  vi.mocked(postXingyeStorage).mockReset().mockResolvedValue({ missing: true } as never);
  vi.mocked(hanaFetch).mockReset();
  vi.mocked(readSecondhandBuyerChat).mockReset();
  vi.mocked(saveSecondhandBuyerChat).mockReset().mockResolvedValue(undefined as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ensureSecondhandBuyerChat', () => {
  it('generates and saves a full chat when none is cached', async () => {
    vi.mocked(readSecondhandBuyerChat).mockResolvedValue(null);
    vi.mocked(hanaFetch).mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { messages: fullMessages() } }),
    } as Response);

    const rec = await ensureSecondhandBuyerChat({
      agent,
      ownerProfile: null,
      agentId: 'agent-x',
      entry: entryWith('sold'),
    });

    expect(rec.entryId).toBe('e1');
    expect(rec.itemStatus).toBe('sold');
    expect(rec.messages.length).toBeGreaterThanOrEqual(6);
    expect(vi.mocked(saveSecondhandBuyerChat)).toHaveBeenCalledTimes(1);
    const call = vi.mocked(hanaFetch).mock.calls.find((c) => c[0] === '/api/xingye/phone-generate');
    expect(JSON.parse(String(call?.[1]?.body ?? '')).kind).toBe('secondhand_buyer_chat');
  });

  it('returns the cached chat untouched when it is already sold (no model call, no save)', async () => {
    const cached = {
      entryId: 'e1',
      buyerName: '巷口的旧书客',
      itemName: '旧相机',
      itemStatus: 'sold',
      messages: [{ id: 'm1', role: 'buyer', text: '要了', at: '2026-05-20T10:00:00.000Z' }],
      generatedAt: '2026-05-20T10:00:00.000Z',
    };
    vi.mocked(readSecondhandBuyerChat).mockResolvedValue(cached as never);

    const rec = await ensureSecondhandBuyerChat({
      agent,
      ownerProfile: null,
      agentId: 'agent-x',
      entry: entryWith('sold'),
    });

    expect(rec).toBe(cached);
    expect(vi.mocked(hanaFetch)).not.toHaveBeenCalled();
    expect(vi.mocked(saveSecondhandBuyerChat)).not.toHaveBeenCalled();
  });

  it('migrates a negotiating chat to sold and appends a closing (non-silent branch)', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.9); // ≥ 0.5 → 非沉默 → 续写成交收尾
    const cached = {
      entryId: 'e1',
      buyerName: '巷口的旧书客',
      itemName: '旧相机',
      itemStatus: 'negotiating',
      messages: [
        { id: 'm1', role: 'buyer', text: '还在吗', at: '2026-05-20T10:00:00.000Z' },
        { id: 'm2', role: 'seller', text: '在的', at: '2026-05-20T10:02:00.000Z' },
      ],
      generatedAt: '2026-05-20T10:02:00.000Z',
    };
    vi.mocked(readSecondhandBuyerChat).mockResolvedValue(cached as never);
    vi.mocked(hanaFetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        result: { messages: [{ role: 'buyer', text: '那我要了' }, { role: 'seller', text: '好，明天来拿' }] },
      }),
    } as Response);

    const rec = await ensureSecondhandBuyerChat({
      agent,
      ownerProfile: null,
      agentId: 'agent-x',
      entry: entryWith('sold'),
    });

    expect(rec.itemStatus).toBe('sold');
    expect(rec.messages).toHaveLength(4); // 2 prior + 2 closing
    expect(rec.messages[0].text).toBe('还在吗'); // 旧「在谈」段原样保留
    expect(rec.messages[3].text).toBe('好，明天来拿');
    expect(vi.mocked(saveSecondhandBuyerChat)).toHaveBeenCalledTimes(1);
  });

  it('migrates silently — no append, no model call — when the silent branch hits', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.1); // < 0.5 → 沉默成交
    const cached = {
      entryId: 'e1',
      buyerName: 'x',
      itemName: '旧相机',
      itemStatus: 'negotiating',
      messages: [{ id: 'm1', role: 'buyer', text: '还在吗', at: '2026-05-20T10:00:00.000Z' }],
      generatedAt: '2026-05-20T10:00:00.000Z',
    };
    vi.mocked(readSecondhandBuyerChat).mockResolvedValue(cached as never);

    const rec = await ensureSecondhandBuyerChat({
      agent,
      ownerProfile: null,
      agentId: 'agent-x',
      entry: entryWith('sold'),
    });

    expect(rec.itemStatus).toBe('sold');
    expect(rec.messages).toHaveLength(1); // 原样
    expect(vi.mocked(hanaFetch)).not.toHaveBeenCalled();
    expect(vi.mocked(saveSecondhandBuyerChat)).toHaveBeenCalledTimes(1);
  });

  it('falls back to silent migration when the closing generation fails', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.9); // 非沉默 → 尝试续写，但模型失败
    const cached = {
      entryId: 'e1',
      buyerName: 'x',
      itemName: '旧相机',
      itemStatus: 'negotiating',
      messages: [{ id: 'm1', role: 'buyer', text: '还在吗', at: '2026-05-20T10:00:00.000Z' }],
      generatedAt: '2026-05-20T10:00:00.000Z',
    };
    vi.mocked(readSecondhandBuyerChat).mockResolvedValue(cached as never);
    vi.mocked(hanaFetch).mockResolvedValue({
      ok: false,
      json: async () => ({ ok: false, error: 'boom' }),
    } as Response);

    const rec = await ensureSecondhandBuyerChat({
      agent,
      ownerProfile: null,
      agentId: 'agent-x',
      entry: entryWith('sold'),
    });

    expect(rec.itemStatus).toBe('sold'); // 仍升到 sold
    expect(rec.messages).toHaveLength(1); // 续写失败 → 当沉默，原样保留
    expect(vi.mocked(saveSecondhandBuyerChat)).toHaveBeenCalledTimes(1);
  });
});
