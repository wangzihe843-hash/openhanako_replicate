/**
 * @vitest-environment jsdom
 */

import { describe, expect, it } from 'vitest';
import {
  buildMmChatFollowupAgentQuestionPrompt,
  buildMmChatFollowupAssistantAnswerPrompt,
  buildMmChatGenerationPrompt,
  buildMmChatInitialBacklogPrompt,
  buildMmChatMultiRoundFollowupPrompt,
  buildMmChatMultiRoundNewPrompt,
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
    // 发问语体约束：禁掉「你那边有没有…」这类把助手当熟人/同行的句式
    expect(p).toContain('发问语体');
    expect(p).toContain('你那边有没有');
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
    expect(p).toContain('发问语体');
    expect(p).toContain('你那边有没有');
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

describe('multi-round prompts', () => {
  it('new prompt embeds target round count and rounds schema + continuity anchor', () => {
    const p = buildMmChatMultiRoundNewPrompt({
      agent: linwu,
      userName: '莫子',
      profile: null,
      recentSceneBlock: '',
      stableLoreBlock: '',
      keywordLoreBlock: '',
      relationshipBlock: '',
      heartbeatBlock: '',
      continuityAnchorBlock: '  · 《入睡步骤》— 怎么入睡更轻松',
      roundCount: 4,
    });
    expect(p).toContain('MM Chat');
    expect(p).toContain('rounds');
    expect(p).toContain('恰好 4 轮');
    expect(p).toContain('跨会话反重复锚点');
    expect(p).toContain('《入睡步骤》');
    // 风格约束 inline 进来：
    expect(p).toContain('角色式判断点');
    expect(p).toContain('禁止强行加戏');
    expect(p).toContain('发问语体');
    expect(p).toContain('你那边有没有');
    // 不再走 2-step 拆分时的旧 schema 不应出现：
    expect(p).not.toContain('agentFollowupQuestion');
    expect(p).not.toContain('assistantAnswer');
  });

  it('new prompt renders the no-prior-session fallback for empty continuity anchor', () => {
    const p = buildMmChatMultiRoundNewPrompt({
      agent: linwu,
      userName: '莫子',
      profile: null,
      recentSceneBlock: '',
      stableLoreBlock: '',
      keywordLoreBlock: '',
      relationshipBlock: '',
      heartbeatBlock: '',
      continuityAnchorBlock: '',
      roundCount: 3,
    });
    expect(p).toContain('这是 TA 第一次咨询通用助手');
    expect(p).toContain('恰好 3 轮');
  });

  it('followup prompt scopes direction hint to first round only', () => {
    const p = buildMmChatMultiRoundFollowupPrompt({
      agent: linwu,
      userName: '莫子',
      profile: null,
      recentSceneBlock: '',
      stableLoreBlock: '',
      keywordLoreBlock: '',
      relationshipBlock: '',
      heartbeatBlock: '',
      sessionTitle: '入睡步骤',
      sessionHistoryBlock: 'H',
      previousAiAnswer: 'A_prev',
      firstRoundDirectionHint: '想要更具体的话术',
      roundCount: 5,
    });
    expect(p).toContain('恰好 5 轮');
    expect(p).toContain('想要更具体的话术');
    expect(p).toContain('rounds[0].question');
    // 风格约束 inline：
    expect(p).toContain('角色式判断点');
    expect(p).toContain('禁止强行加戏');
    expect(p).toContain('发问语体');
    expect(p).toContain('你那边有没有');
    // 多轮 schema：
    expect(p).toContain('rounds');
    expect(p).not.toContain('agentFollowupQuestion');
    expect(p).not.toContain('assistantAnswer');
  });

  it('initial-backlog prompt embeds sessionCount + multi-tier round rules + importanceTag schema', () => {
    const p = buildMmChatInitialBacklogPrompt({
      agent: linwu,
      userName: '莫子',
      profile: null,
      recentSceneBlock: '',
      stableLoreBlock: '',
      keywordLoreBlock: '',
      relationshipBlock: '',
      heartbeatBlock: '',
      sessionCount: 4,
    });
    // session 数硬约束：
    expect(p).toContain('恰好 4 条');
    // 多档轮数规则：
    expect(p).toContain('高重要');
    expect(p).toContain('3-5 轮');
    expect(p).toContain('2-3 轮');
    expect(p).toContain('1-2 轮');
    // session 之间差异化要求：
    expect(p).toContain('独立、不重叠');
    // schema：
    expect(p).toContain('sessions');
    expect(p).toContain('importanceTag');
    expect(p).toContain('rounds');
    // 复用既有约束块：
    expect(p).toContain('发问语体');
    expect(p).toContain('你那边有没有');
    expect(p).toContain('角色式判断点');
    // 防"全部往感情写"：
    expect(p).toContain('不要把所有 session 都堆成最高档');
  });

  it('followup prompt without hint renders 无 placeholder', () => {
    const p = buildMmChatMultiRoundFollowupPrompt({
      agent: linwu,
      userName: '莫子',
      profile: null,
      recentSceneBlock: '',
      stableLoreBlock: '',
      keywordLoreBlock: '',
      relationshipBlock: '',
      heartbeatBlock: '',
      sessionTitle: '入睡步骤',
      sessionHistoryBlock: 'H',
      previousAiAnswer: 'A_prev',
      firstRoundDirectionHint: '',
      roundCount: 3,
    });
    // 「（无）」既出现在 hint 段，也可能出现在其它空字段的 fallback，所以只断本段标题与轮数。
    expect(p).toContain('追问方向提示');
    expect(p).toContain('恰好 3 轮');
  });
});
