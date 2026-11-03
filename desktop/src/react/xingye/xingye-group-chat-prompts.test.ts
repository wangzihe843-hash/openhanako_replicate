import { describe, expect, it } from 'vitest';
import {
  buildGroupChatReplyPrompt,
  formatGroupChatHistoryForPrompt,
  GROUP_CHAT_REPLY_LIMITS,
  normalizeGroupChatReplyAiResult,
} from './xingye-group-chat-prompts';

const baseAgent = { id: 'agent-a', name: 'Linwu', yuan: 'yuan' } as const;

describe('xingye-group-chat-prompts', () => {
  it('attributes stored sender IDs while keeping a same-name user and quoted speech distinct', () => {
    const recentMessages = [
      { sender: '小岑', timestamp: 't1', body: '我转述阿陶的话：「我把吉他借给你，你们别告诉他们或他人。」' },
      { sender: 'agent-a', timestamp: 't2', body: '我听到的是阿陶的原话。' },
      { sender: 'agent-b', timestamp: 't3', body: '我才是被引述的人。' },
    ];
    const before = structuredClone(recentMessages);
    const prompt = buildGroupChatReplyPrompt({
      agent: { ...baseAgent, name: '小岑' },
      profile: { agentId: 'agent-a', displayName: '新展示名', updatedAt: '2026-01-01' },
      userName: '小岑', channelId: 'quoted', channelName: '合成群聊',
      channelMembers: ['agent-a', 'agent-b'], recentMessages,
    });
    expect(prompt).toContain(`[小岑（user 本人） · t1]\n${recentMessages[0].body}`);
    expect(prompt).toContain(`[agent-a（你自己） · t2]\n${recentMessages[1].body}`);
    expect(prompt).toContain(`[agent-b（其他成员） · t3]\n${recentMessages[2].body}`);
    expect(recentMessages).toEqual(before);
  });

  it('does not promote another member whose ID equals the current display name to self', () => {
    const prompt = buildGroupChatReplyPrompt({
      agent: { ...baseAgent, name: 'agent-b' }, userName: 'human',
      channelId: 'same-name', channelName: '同名群', channelMembers: ['agent-a', 'agent-b'],
      recentMessages: [{ sender: 'agent-b', timestamp: 't', body: '我说的是我自己的经历。' }],
    });
    expect(prompt).toContain('[agent-b（其他成员） · t]');
    expect(prompt).not.toContain('[agent-b（你自己）');
  });

  it('keeps ambiguous legacy sender text unclaimed when a user name equals an agent ID', () => {
    const prompt = buildGroupChatReplyPrompt({
      agent: baseAgent, userName: 'agent-a', channelId: 'collision', channelName: '同名群',
      channelMembers: ['agent-a', 'agent-b'],
      recentMessages: [{ sender: 'agent-a', timestamp: 't', body: '我是谁不能从这一字段断定。' }],
    });
    expect(prompt).toContain('[agent-a（身份不明） · t]');
    expect(prompt).not.toContain('[agent-a（你自己）');
    expect(prompt).not.toContain('[agent-a（user 本人）');
  });

  it.each([0, 80, 6000])('keeps attribution labels inside a %i-character history budget', (maxChars) => {
    const messages = [{ sender: 'other', timestamp: 't', body: '原文'.repeat(3500) }];
    const original = messages[0].body;
    const history = formatGroupChatHistoryForPrompt({ agentName: 'A', userName: 'U', messages, maxChars });
    expect(history.length).toBeLessThanOrEqual(maxChars);
    expect(messages[0].body).toBe(original);
  });

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

  it('renders ownReplyAnchorBlock into the prompt with the no-repeat instruction', () => {
    const prompt = buildGroupChatReplyPrompt({
      agent: baseAgent,
      profile: null,
      userName: 'liyu',
      channelId: 'ch_crew',
      channelName: 'Crew',
      channelMembers: ['agent-a', 'agent-b'],
      recentMessages: [
        { sender: 'liyu', timestamp: '2026-05-15 09:00', body: '?' },
      ],
      ownReplyAnchorBlock: '- 你（Linwu）在这条群聊里最近已经说过的几句:\n  · [2026-05-15 09:01] 体力还撑得住',
    });
    expect(prompt).toContain('流式反重复锚点');
    expect(prompt).toContain('体力还撑得住');
    expect(prompt).toContain('请避免再写几乎相同的话');
  });

  it('renders placeholder when ownReplyAnchorBlock is empty', () => {
    const prompt = buildGroupChatReplyPrompt({
      agent: baseAgent,
      profile: null,
      userName: 'liyu',
      channelId: 'ch_crew',
      channelName: 'Crew',
      channelMembers: ['agent-a', 'agent-b'],
      recentMessages: [],
      ownReplyAnchorBlock: '',
    });
    expect(prompt).toContain('TA 在本群第一次发言');
  });
});


describe('group history keeps UTF-16 budgets at complete grapheme boundaries', () => {
  const header = '[peer（其他成员） · t]\n';
  it.each(['😀', '👩🏽‍💻', '👨‍👩‍👧‍👦', '🇨🇳', 'e\u0301', '1\uFE0F\u20E3', '🏴\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}'])('preserves whole %s clusters before, on, and after each budget edge', cluster => {
    const messages = [{ sender: 'peer', timestamp: 't', body: cluster.repeat(7000) }];
    const before = structuredClone(messages);
    for (const extra of [0, 1, cluster.length, cluster.length + 1, cluster.length + 2, cluster.length * 2, 6000 - header.length]) {
      const maxChars = header.length + extra;
      const text = formatGroupChatHistoryForPrompt({ agentId: 'self', agentName: 'Name', userName: 'user', messages, maxChars });
      expect(text.length).toBeLessThanOrEqual(maxChars);
      expect(text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
      if (extra >= 1) expect(text).toBe(header + cluster.repeat(Math.floor((extra - 1) / cluster.length)) + '…');
    }
    expect(messages).toEqual(before);
    const exact = [{ ...messages[0], body: cluster.repeat(2) }];
    const full = header + exact[0].body;
    for (const maxChars of [full.length, full.length + 1]) {
      expect(formatGroupChatHistoryForPrompt({ agentName: 'Name', userName: 'user', messages: exact, maxChars })).toBe(full);
    }
  });

  it('does not expand the budget to fit an oversized combining grapheme', () => {
    const body = 'a' + '\u0301'.repeat(9000);
    const text = formatGroupChatHistoryForPrompt({ agentName: 'Name', userName: 'user', messages: [{ sender: 'peer', timestamp: 't', body }], maxChars: 6000 });
    expect(text).toBe(header + '…');
    expect(text.length).toBeLessThanOrEqual(6000);
  });
});


describe('group reply and reason Unicode limits', () => {
  it('applies the existing 600/280 UTF-16 caps without splitting compound emoji', () => {
    const cluster = '👩🏽‍💻';
    const raw = { decision: 'reply', reply: 'x' + cluster.repeat(200), reason: 'x' + cluster.repeat(200) };
    const before = structuredClone(raw);
    const result = normalizeGroupChatReplyAiResult(raw)!;
    expect(result.reply).toBe('x' + cluster.repeat(Math.floor(598 / cluster.length)) + '…');
    expect(result.reason).toBe('x' + cluster.repeat(Math.floor(278 / cluster.length)) + '…');
    expect(result.reply.length).toBeLessThanOrEqual(600);
    expect(result.reason!.length).toBeLessThanOrEqual(280);
    expect(raw).toEqual(before);
  });
});
