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
  generateMmChatRoundWithAI,
  normalizeMmChatFollowupAgentQuestion,
  normalizeMmChatFollowupAssistantAnswer,
  normalizeMmChatRoundResult,
} from './xingye-mm-chat-ai';

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

describe('normalizeMmChatFollowup split results', () => {
  it('parses agentFollowupQuestion', () => {
    expect(normalizeMmChatFollowupAgentQuestion({ agentFollowupQuestion: '  好  ' })).toBe('好');
    expect(normalizeMmChatFollowupAgentQuestion({})).toBeNull();
  });
  it('parses assistantAnswer', () => {
    expect(normalizeMmChatFollowupAssistantAnswer({ assistantAnswer: '答' })).toBe('答');
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
    const phoneGenerateCall = vi.mocked(hanaFetch).mock.calls.find((call) => call[0] === '/api/xingye/phone-generate');
    const bodyStr = String(phoneGenerateCall?.[1]?.body ?? '{}');
    const body = JSON.parse(bodyStr) as { kind?: string; prompt?: string; mmChatMode?: string };
    expect(body.kind).toBe('mm_chat');
    expect(body.mmChatMode).toBe('new');
    expect(body.prompt).toContain('MM Chat');
    expect(body.prompt).toContain('通用 AI 助手');
  });

  it('follow-up runs two phone-generate calls with agent question then assistant answer', async () => {
    const agent = { id: 'agent-m', name: 'Lin', yuan: 'y' as const };
    vi.mocked(hanaFetch)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          result: { agentFollowupQuestion: '那如果我还是睡不着，第二步要怎么微调？' },
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          result: { assistantAnswer: '可以把第二步改成只做一件小事，例如只调暗灯光而不强迫立刻睡着。' },
        }),
      } as Response);

    const out = await generateMmChatRoundWithAI({
      agent: agent as never,
      ownerProfile: null,
      mode: 'followup',
      followUp: {
        sessionTitle: '睡眠',
        sessionMessages: [
          { id: 'a', role: 'ta' as const, text: '怎么睡？', createdAt: '2026-01-01T00:00:00.000Z' },
          { id: 'b', role: 'ai' as const, text: '关灯试试。', createdAt: '2026-01-01T00:00:01.000Z' },
        ],
        directionHint: '没理解第二步',
      },
    });

    expect(out.question).toContain('第二步');
    expect(out.answer).toContain('第二步');
    const modes = vi.mocked(hanaFetch).mock.calls
      .filter((c) => c[0] === '/api/xingye/phone-generate')
      .map((c) => JSON.parse(String(c[1]?.body ?? '{}')).mmChatMode as string);
    expect(modes).toEqual(['followup_agent_question', 'followup_assistant_answer']);
    const firstPrompt = JSON.parse(String(vi.mocked(hanaFetch).mock.calls.find((c) => c[0] === '/api/xingye/phone-generate')?.[1]?.body ?? '{}'))
      .prompt as string;
    expect(firstPrompt).toContain('没理解第二步');
    const secondBody = vi.mocked(hanaFetch).mock.calls.filter((c) => c[0] === '/api/xingye/phone-generate')[1];
    const secondPrompt = JSON.parse(String(secondBody?.[1]?.body ?? '{}')).prompt as string;
    expect(secondPrompt).toContain('那如果我还是睡不着');
  });

  it('follow-up works with empty direction hint', async () => {
    const agent = { id: 'agent-m', name: 'Lin', yuan: 'y' as const };
    vi.mocked(hanaFetch)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, result: { agentFollowupQuestion: '自动追问一句' } }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, result: { assistantAnswer: '助手补充说明。' } }),
      } as Response);

    await expect(
      generateMmChatRoundWithAI({
        agent: agent as never,
        ownerProfile: null,
        mode: 'followup',
        followUp: {
          sessionTitle: '睡眠',
          sessionMessages: [
            { id: 'a', role: 'ta' as const, text: 'Q', createdAt: '2026-01-01T00:00:00.000Z' },
            { id: 'b', role: 'ai' as const, text: 'A', createdAt: '2026-01-01T00:00:01.000Z' },
          ],
        },
      }),
    ).resolves.toMatchObject({ question: '自动追问一句', answer: '助手补充说明。' });
  });

  it('follow-up rejects when last message is not assistant', async () => {
    const agent = { id: 'agent-m', name: 'Lin', yuan: 'y' as const };
    await expect(
      generateMmChatRoundWithAI({
        agent: agent as never,
        ownerProfile: null,
        mode: 'followup',
        followUp: {
          sessionTitle: 'T',
          sessionMessages: [{ id: 'a', role: 'ta' as const, text: '仅提问', createdAt: '2026-01-01T00:00:00.000Z' }],
          directionHint: '嗯？',
        },
      }),
    ).rejects.toThrow(/助手回复之后/);
  });
});
