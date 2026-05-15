import { describe, expect, it } from 'vitest';
import {
  buildGroupChatReplyPrompt,
  formatGroupChatHistoryForPrompt,
  GROUP_CHAT_REPLY_LIMITS,
  normalizeGroupChatReplyAiResult,
} from './xingye-group-chat-prompts';

const baseAgent = { id: 'agent-a', name: 'Linwu', yuan: 'yuan' } as const;

describe('xingye-group-chat-prompts', () => {
  it('marks the current agent, the user, and other members distinctly in history', () => {
    const text = formatGroupChatHistoryForPrompt({
      agentName: 'Linwu',
      userName: 'liyu',
      messages: [
        { sender: 'liyu', timestamp: '2026-05-15 09:00', body: '今天的占卜如何' },
        { sender: 'agent-b', timestamp: '2026-05-15 09:01', body: '我刚抽到塔。' },
        { sender: 'Linwu', timestamp: '2026-05-15 09:02', body: '塔不一定坏。' },
        { sender: 'system', timestamp: '2026-05-15 09:03', body: '本频道由 admin 管理' },
      ],
    });
    expect(text).toContain('liyu（user 本人）');
    expect(text).toContain('agent-b（其他成员）');
    expect(text).toContain('Linwu（你自己）');
    expect(text).toContain('system（频道系统消息）');
  });

  it('handles an empty history gracefully', () => {
    expect(formatGroupChatHistoryForPrompt({ agentName: 'L', userName: 'u', messages: [] }))
      .toContain('群聊里还没有任何消息');
  });

  it('builds a reply prompt with the channel context, hard rules, and JSON schema', () => {
    const prompt = buildGroupChatReplyPrompt({
      agent: baseAgent,
      profile: null,
      userName: 'liyu',
      channelId: 'ch_crew',
      channelName: 'Crew',
      channelDescription: '只发简短消息',
      channelMembers: ['agent-a', 'agent-b'],
      recentMessages: [
        { sender: 'liyu', timestamp: '2026-05-15 09:00', body: 'Linwu 在吗？' },
      ],
    });
    expect(prompt).toContain('ch_crew');
    expect(prompt).toContain('Crew');
    expect(prompt).toContain('只发简短消息');
    expect(prompt).toContain('reply');
    expect(prompt).toContain('skip');
    expect(prompt).toContain('不要模拟 user 的发言');
    expect(prompt).toContain('不要一次输出多条消息');
    expect(prompt).toContain('MM Chat');
    expect(prompt).toMatch(/JSON/);
  });

  it('normalizes a reply decision and clamps the reply body to the published limit', () => {
    const huge = '一'.repeat(GROUP_CHAT_REPLY_LIMITS.maxReplyChars + 50);
    const result = normalizeGroupChatReplyAiResult({
      decision: 'reply',
      reply: huge,
      reason: '回应了 user 的提问',
    });
    expect(result).not.toBeNull();
    expect(result!.decision).toBe('reply');
    expect(result!.reply.length).toBeLessThanOrEqual(GROUP_CHAT_REPLY_LIMITS.maxReplyChars);
    expect(result!.reason).toBe('回应了 user 的提问');
  });

  it('normalizes a skip decision with an empty reply', () => {
    const result = normalizeGroupChatReplyAiResult({
      decision: 'skip',
      reply: '',
      reason: '最后一条是当前 agent 自己发的',
    });
    expect(result).toMatchObject({ decision: 'skip', reply: '' });
  });

  it('rejects a reply with empty body', () => {
    const result = normalizeGroupChatReplyAiResult({ decision: 'reply', reply: '   ' });
    expect(result).toBeNull();
  });

  it('rejects unknown decision values', () => {
    expect(normalizeGroupChatReplyAiResult({ decision: 'maybe', reply: 'hi' })).toBeNull();
    expect(normalizeGroupChatReplyAiResult(null)).toBeNull();
    expect(normalizeGroupChatReplyAiResult([{ decision: 'reply', reply: 'a' }])).toBeNull();
  });
});
