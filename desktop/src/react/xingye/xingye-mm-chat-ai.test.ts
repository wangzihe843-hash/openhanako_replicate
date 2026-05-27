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
  buildMmChatContinuityAnchorBlockFromSessions,
  generateMmChatRoundWithAI,
  normalizeMmChatFollowupAgentQuestion,
  normalizeMmChatFollowupAssistantAnswer,
  normalizeMmChatRoundResult,
} from './xingye-mm-chat-ai';

describe('buildMmChatContinuityAnchorBlockFromSessions', () => {
  it('no sessions → empty string', () => {
    expect(buildMmChatContinuityAnchorBlockFromSessions([])).toBe('');
  });

  it('renders title + first ta question snippet for recent sessions', () => {
    const block = buildMmChatContinuityAnchorBlockFromSessions([
      {
        id: 's1',
        title: '入睡步骤',
        preview: '',
        messages: [
          { id: 'm1', role: 'ta', text: '怎么入睡更轻松？这是一个相当长的问题' },
          { id: 'm2', role: 'ai', text: '关灯' },
        ],
      },
      {
        id: 's2',
        title: '与老李措辞',
        preview: '',
        messages: [{ id: 'm1', role: 'ta', text: '我该如何不冒犯地拒绝？' }],
      },
    ]);
    expect(block).toContain('请换不同切口');
    expect(block).toContain('《入睡步骤》');
    expect(block).toContain('《与老李措辞》');
    expect(block).toContain('怎么入睡更轻松');
  });

  it('only keeps the most recent N sessions', () => {
    const many = [];
    for (let i = 0; i < 12; i += 1) {
      many.push({
        id: `s${i}`,
        title: `主题${i}`,
        preview: '',
        messages: [{ id: `m${i}`, role: 'ta' as const, text: `Q${i}` }],
      });
    }
    const block = buildMmChatContinuityAnchorBlockFromSessions(many);
    expect(block).toContain('《主题0》');
    expect(block).toContain('《主题5》');
    expect(block).not.toContain('《主题9》');
    expect(block).not.toContain('《主题11》');
  });

  it('cross-session isolation: agent A list does not leak agent B titles', () => {
    // 函数纯函数；调用方传 agent A 的 sessions，结果只含 A 的；不与 B 混淆。
    const a = buildMmChatContinuityAnchorBlockFromSessions([
      { id: 's-a', title: 'A 的咨询', preview: '', messages: [{ id: 'x', role: 'ta', text: 'qA' }] },
    ]);
    const b = buildMmChatContinuityAnchorBlockFromSessions([
      { id: 's-b', title: 'B 的咨询', preview: '', messages: [{ id: 'x', role: 'ta', text: 'qB' }] },
    ]);
    expect(a).toContain('A 的咨询');
    expect(a).not.toContain('B 的咨询');
    expect(b).toContain('B 的咨询');
    expect(b).not.toContain('A 的咨询');
  });
});

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

  it('renders mm-chat continuity anchor when sessions exist (mode=new)', async () => {
    const agent = { id: 'agent-m', name: 'Lin', yuan: 'y' as const };
    // 让 readMmChatPersistence 命中：返回一份带 2 个 session 的 persisted v1。
    vi.mocked(postXingyeStorage).mockReset();
    vi.mocked(postXingyeStorage).mockImplementation(async (input) => {
      const arg = input as { action?: string; relativePath?: string };
      if (arg?.action === 'readJson' && arg?.relativePath === 'mm-chat/sessions.json') {
        return {
          data: {
            version: 1,
            activeSessionId: '',
            sessions: [
              {
                id: 's1',
                title: '入睡步骤',
                preview: '',
                createdAt: '2026-05-01T00:00:00.000Z',
                updatedAt: '2026-05-26T00:00:00.000Z',
                messages: [
                  { id: 'm1', role: 'ta', text: '怎么入睡更轻松？', createdAt: '2026-05-26T00:00:00.000Z' },
                  { id: 'm2', role: 'ai', text: '关灯。', createdAt: '2026-05-26T00:00:01.000Z' },
                ],
              },
              {
                id: 's2',
                title: '与老李对话措辞',
                preview: '',
                createdAt: '2026-05-25T00:00:00.000Z',
                updatedAt: '2026-05-25T00:00:00.000Z',
                messages: [
                  { id: 'm1', role: 'ta', text: '我该如何不冒犯地拒绝老李？', createdAt: '2026-05-25T00:00:00.000Z' },
                  { id: 'm2', role: 'ai', text: '直接说。', createdAt: '2026-05-25T00:00:01.000Z' },
                ],
              },
            ],
          },
        } as never;
      }
      return { missing: true } as never;
    });
    await generateMmChatRoundWithAI({ agent: agent as never, ownerProfile: null });
    const phoneGenerateCall = vi
      .mocked(hanaFetch)
      .mock.calls.find((call) => call[0] === '/api/xingye/phone-generate');
    const body = JSON.parse(String(phoneGenerateCall?.[1]?.body ?? '{}')) as { prompt?: string };
    expect(body.prompt).toContain('跨会话反重复锚点');
    expect(body.prompt).toContain('《入睡步骤》');
    expect(body.prompt).toContain('《与老李对话措辞》');
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
