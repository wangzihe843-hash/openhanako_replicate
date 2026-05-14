/**
 * @vitest-environment jsdom
 */

import { describe, expect, it } from 'vitest';
import {
  buildMmChatFollowupAgentQuestionPrompt,
  buildMmChatFollowupAssistantAnswerPrompt,
  buildMmChatGenerationPrompt,
  formatMmChatSessionHistoryForPrompt,
} from './xingye-mm-chat-prompts';

const linwu = { id: 'linwu', name: '林雾', yuan: 'y' as const };

describe('formatMmChatSessionHistoryForPrompt', () => {
  it('labels turns and drops oldest blocks when over maxChars', () => {
    const long = 'x'.repeat(5000);
    const out = formatMmChatSessionHistoryForPrompt({
      taMoniker: '林雾',
      lines: [
        { role: 'ta', text: long },
        { role: 'ai', text: '尾段助手话' },
      ],
      maxChars: 200,
    });
    expect(out).toContain('更早内容已省略');
    expect(out).toContain('尾段助手话');
    expect(out.length).toBeLessThanOrEqual(220);
  });
});

describe('buildMmChatGenerationPrompt', () => {
  it('includes MM Chat new-session framing', () => {
    const p = buildMmChatGenerationPrompt({
      agent: linwu,
      userName: '莫子',
      profile: null,
      recentSceneBlock: '',
      stableLoreBlock: '',
      keywordLoreBlock: '',
      relationshipBlock: '',
      heartbeatBlock: '',
    });
    expect(p).toContain('MM Chat');
    expect(p).toContain('title');
    expect(p).toContain('question');
    expect(p).toContain('answer');
  });
});

describe('follow-up prompts', () => {
  it('agent-question prompt includes hint block and forbids verbatim copy instruction', () => {
    const p = buildMmChatFollowupAgentQuestionPrompt({
      agent: linwu,
      userName: '莫子',
      profile: null,
      recentSceneBlock: '',
      stableLoreBlock: '',
      keywordLoreBlock: '',
      relationshipBlock: '',
      heartbeatBlock: '',
      sessionTitle: '测试',
      sessionHistoryBlock: 'H',
      previousAiAnswer: 'A1',
      followUpDirectionHint: '想要更委婉',
    });
    expect(p).toContain('agentFollowupQuestion');
    expect(p).toContain('想要更委婉');
    expect(p).toContain('禁止把「追问方向提示」');
    expect(p).toContain('角色式判断点');
    expect(p).toContain('禁止强行加戏');
  });

  it('assistant prompt binds character question', () => {
    const p = buildMmChatFollowupAssistantAnswerPrompt({
      agent: linwu,
      userName: '莫子',
      profile: null,
      recentSceneBlock: '',
      stableLoreBlock: '',
      keywordLoreBlock: '',
      relationshipBlock: '',
      heartbeatBlock: '',
      sessionHistoryBlock: 'hist',
      agentFollowupQuestion: '那我具体该怎么开口？',
    });
    expect(p).toContain('assistantAnswer');
    expect(p).toContain('那我具体该怎么开口？');
  });
});
