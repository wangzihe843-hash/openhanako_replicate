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
import { generateMmChatRoundWithAI, normalizeMmChatRoundResult } from './xingye-mm-chat-ai';

describe('normalizeMmChatRoundResult', () => {
  it('requires question and answer', () => {
    expect(normalizeMmChatRoundResult({ title: 'A', question: '', answer: 'b' })).toBeNull();
    expect(normalizeMmChatRoundResult({ title: 'A', question: 'q', answer: 'a' })).toEqual({
      title: 'A',
      question: 'q',
      answer: 'a',
    });
  });

  it('derives title from question when missing', () => {
    expect(normalizeMmChatRoundResult({ question: '一二三四五六七八九十十一十二十三十四十五', answer: 'ok' })?.title.length).toBeLessThanOrEqual(48);
  });
});

describe('generateMmChatRoundWithAI', () => {
  beforeEach(() => {
    vi.mocked(postXingyeStorage).mockReset();
    vi.mocked(hanaFetch).mockReset();
    vi.mocked(postXingyeStorage).mockResolvedValue({ missing: true } as never);
    vi.mocked(hanaFetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        result: {
          title: '睡眠',
          question: '我最近很难入睡，有什么温和的入睡步骤？',
          answer: '可以试试固定起床时间、睡前一小时调暗灯光，并把手机放到另一个房间。',
        },
      }),
    } as Response);
  });

  it('posts phone-generate with kind mm_chat', async () => {
    const agent = { id: 'agent-m', name: 'Lin', yuan: 'y' as const };
    await expect(generateMmChatRoundWithAI({ agent: agent as never, ownerProfile: null })).resolves.toMatchObject({
      title: '睡眠',
      question: expect.stringContaining('入睡'),
    });
    const bodyStr = String(vi.mocked(hanaFetch).mock.calls[0]?.[1]?.body ?? '');
    const body = JSON.parse(bodyStr) as { kind?: string; prompt?: string };
    expect(body.kind).toBe('mm_chat');
    expect(body.prompt).toContain('MM Chat');
    expect(body.prompt).toContain('通用 AI 助手');
  });
});
