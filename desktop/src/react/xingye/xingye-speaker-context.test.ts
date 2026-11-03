import { describe, expect, it } from 'vitest';
import type { Agent } from '../types';
import { buildJournalDraftPrompt } from './xingye-journal-prompts';
import { buildMmChatGenerationPrompt } from './xingye-mm-chat-prompts';
import { buildVirtualContactGenerationPrompt } from './xingye-phone-prompts';
import { buildRelationshipStatePrompt } from './xingye-state-prompts';
import {
  buildXingyeRecentChatExcerpts,
  formatXingyeRecentChatExcerptsForPrompt,
  formatXingyeSpeakerContextForPrompt,
  resolveXingyeLoreTemplateUserNameSync,
} from './xingye-speaker-context';
import type { XingyeRelationshipState } from './xingye-state-store';
import { getXingyeRoleProfileDisplay } from './xingye-profile-store';
import { buildCharacterCardContext } from '../../../../shared/xingye-character-card';

const linwu = { id: 'linwu', name: '林雾', yuan: 'hanako', isPrimary: true } as Agent;

describe('xingye speaker context', () => {
  it('retains quote text and speaker roles even when the user and role share a display name', () => {
    const quote = '阿陶说：「我把吉他借给你，你们别告诉他们或他人。」';
    const context = {
      agentId: 'linwu', hasOpenHanakoMessages: true, sourceNotes: [], summaryText: '',
      messages: [
        { role: 'user' as const, source: 'openhanako_chat' as const, content: quote, createdAt: 't1' },
        { role: 'assistant' as const, source: 'openhanako_chat' as const, content: '我只是听到了转述。', createdAt: 't2' },
      ],
    };
    const before = structuredClone(context);
    const excerpts = buildXingyeRecentChatExcerpts({ context, userName: '小岑', agentName: '小岑' });
    expect(excerpts).toEqual([
      { speaker: 'user', speakerLabel: '用户 小岑', text: quote, createdAt: 't1' },
      { speaker: 'currentAgent', speakerLabel: '当前角色 小岑', text: '我只是听到了转述。', createdAt: 't2' },
    ]);
    expect(formatXingyeRecentChatExcerptsForPrompt(excerpts)).toContain(`[用户 小岑 t1] ${quote}`);
    const rules = formatXingyeSpeakerContextForPrompt({ userName: '小岑', agentName: '小岑' });
    // This checks the prompt contract, not whether a model follows it.
    expect(rules).toContain('引述中的“我/你”');
    expect(rules).toContain('不把被引述者的经历当成当前角色的亲历或记忆');
    expect(context).toEqual(before);
  });

  it('keeps editable card fields intact and resolves only explicit role/user placeholders for prompts', () => {
    const literal = '你们和他们请他人弹吉他；阿陶说「我知道你是谁」。';
    const profile = {
      agentId: 'linwu', updatedAt: '2026-01-01', displayName: '林雾',
      relationshipMode: `用户小岑与角色林雾保持朋友关系。${literal}`,
      scenario: `{{char}}与{{user}}在合成场景见面。${literal}`,
      messageExample: `{{user}}：${literal}\n{{char}}：这是对话示例。{{eval:inert}}`,
    };
    const before = structuredClone(profile);
    const display = getXingyeRoleProfileDisplay(linwu, profile);
    expect(display.scenario).toBe(profile.scenario);
    expect(display.messageExample).toBe(profile.messageExample);
    expect(display.relationshipMode).toBe(profile.relationshipMode);
    const card = buildCharacterCardContext({ profile, character: '林雾', user: '小岑' });
    expect(card).toContain(`林雾与小岑在合成场景见面。${literal}`);
    expect(card).toContain(`小岑：${literal}\n林雾：这是对话示例。{{eval:inert}}`);
    expect(card).toContain('Dialogue style examples (not events or conversation history)');
    expect(card).toContain('Do not treat example dialogue as real memories.');
    expect(profile).toEqual(before);
  });

  it('resolveXingyeLoreTemplateUserNameSync prefers OpenHanako config user.name over store', () => {
    expect(resolveXingyeLoreTemplateUserNameSync({ user: { name: 'Cfg' } }, 'Store')).toBe('Cfg');
    expect(resolveXingyeLoreTemplateUserNameSync(null, 'StoreNick')).toBe('StoreNick');
    expect(resolveXingyeLoreTemplateUserNameSync({ user: { name: 'User' } }, null)).toBe('用户');
  });

  it('builds dynamic user/agent pronoun rules without hard-coding one user name', () => {
    const lilithBlock = formatXingyeSpeakerContextForPrompt({ userName: '莉莉丝', agentName: '林雾' });
    const moziBlock = formatXingyeSpeakerContextForPrompt({ userName: '莫子', agentName: '林雾' });

    expect(lilithBlock).toContain('currentUserName=莉莉丝');
    expect(lilithBlock).toContain('user 消息中的“我”指 currentUserName=莉莉丝');
    expect(lilithBlock).toContain('agent 消息中的“你”指 currentUserName=莉莉丝');
    expect(lilithBlock).toContain('companion=user');
    expect(lilithBlock).toContain('counterparty/mentionedPerson');

    expect(moziBlock).toContain('currentUserName=莫子');
    expect(moziBlock).toContain('和莫子一起验收该 NPC 送来的物品');
    expect(moziBlock).not.toContain('莉莉丝');
  });

  it('formats recent chat excerpts with concrete speaker labels', () => {
    const excerpts = buildXingyeRecentChatExcerpts({
      userName: '莫子',
      agentName: '林雾',
      context: {
        agentId: 'linwu',
        hasOpenHanakoMessages: true,
        sourceNotes: [],
        summaryText: '[用户] 我陪你一起验货。',
        messages: [
          {
            role: 'user',
            source: 'openhanako_chat',
            content: '下次他送货，我们不直接收。我陪你一起验货。',
          },
          {
            role: 'assistant',
            source: 'openhanako_chat',
            content: '我知道了。',
          },
        ],
      },
    });

    const promptBlock = formatXingyeRecentChatExcerptsForPrompt(excerpts);
    expect(promptBlock).toContain('[用户 莫子]');
    expect(promptBlock).toContain('[当前角色 林雾]');
    expect(promptBlock).toContain('我陪你一起验货');
  });

  it('injects speaker context into phone, state, journal, and mm-chat prompts', () => {
    const journalPrompt = buildJournalDraftPrompt({
      agent: linwu,
      userName: '莫子',
      profile: null,
      recentSceneBlock: '[用户 莫子] 我陪你一起验货。',
      stableLoreBlock: '',
      keywordLoreBlock: '',
      relationshipBlock: '',
      heartbeatBlock: '',
    });
    const mmPrompt = buildMmChatGenerationPrompt({
      agent: linwu,
      userName: '莫子',
      profile: null,
      recentSceneBlock: '[用户 莫子] 我陪你一起验货。',
      stableLoreBlock: '',
      keywordLoreBlock: '',
      relationshipBlock: '',
      heartbeatBlock: '',
    });
    const phonePrompt = buildVirtualContactGenerationPrompt({
      ownerAgent: linwu,
      ownerProfile: null,
      contacts: [],
      userName: '莫子',
      recentContext: null,
    });
    const state: XingyeRelationshipState = {
      agentId: 'linwu',
      targetType: 'user',
      targetId: '__user__',
      mood: '平静',
      relationshipKey: 'friend',
      relationshipLabel: '互相信任',
      stateSummary: '稳定',
      lastReason: '',
      affection: 0,
      trust: 0,
      loyalty: 0,
      jealousy: 0,
      corruption: 0,
      updatedAt: '2026-05-13T00:00:00.000Z',
    };
    const statePrompt = buildRelationshipStatePrompt({
      agent: linwu,
      userName: '莫子',
      profile: null,
      state,
      trigger: 'manual_refresh',
      recentChatSummary: '[用户 莫子] 我陪你一起验货。',
    });

    for (const prompt of [journalPrompt, mmPrompt, phonePrompt, statePrompt]) {
      expect(prompt).toContain('speaker context / 实体归因规则');
      expect(prompt).toContain('currentUserName=莫子');
      expect(prompt).toContain('currentAgentName=林雾');
      expect(prompt).toContain('user 消息中的“我”指 currentUserName=莫子');
      expect(prompt).toContain('agent 消息中的“我”指 currentAgentName=林雾');
      expect(prompt).not.toContain('currentUserName=莉莉丝');
    }
  });

  describe('gender pronoun rules', () => {
    it('gender=undefined / unspecified → 不输出代词约束段', () => {
      const block = formatXingyeSpeakerContextForPrompt({ userName: '莫子', agentName: '林雾' });
      const blockUnspec = formatXingyeSpeakerContextForPrompt({ userName: '莫子', agentName: '林雾', gender: 'unspecified' });
      expect(block).not.toContain('pronoun');
      expect(block).not.toContain('性别与代词约束');
      expect(blockUnspec).not.toContain('pronoun');
      expect(blockUnspec).not.toContain('性别与代词约束');
    });

    it('gender=female → 强制使用「她」+ 女性称谓 + 禁用男性指代', () => {
      const block = formatXingyeSpeakerContextForPrompt({ userName: '莫子', agentName: '林雾', gender: 'female' });
      expect(block).toContain('pronoun / 性别与代词约束');
      expect(block).toContain('林雾 的性别为「女性」');
      expect(block).toMatch(/必须.*使用「她」/);
      expect(block).toContain('姐姐');
      // 必须明禁男性代词
      expect(block).toMatch(/禁用.*他/);
    });

    it('gender=male → 强制使用「他」+ 男性称谓 + 禁用女性指代', () => {
      const block = formatXingyeSpeakerContextForPrompt({ userName: '莫子', agentName: '林雾', gender: 'male' });
      expect(block).toContain('林雾 的性别为「男性」');
      expect(block).toMatch(/必须.*使用「他」/);
      expect(block).toContain('哥哥');
      expect(block).toMatch(/禁用.*她/);
    });

    it('gender=nonbinary → 强制使用「TA」+ 中性称谓 + 禁二元代词', () => {
      const block = formatXingyeSpeakerContextForPrompt({ userName: '莫子', agentName: '林雾', gender: 'nonbinary' });
      expect(block).toContain('非二元');
      expect(block).toMatch(/必须.*使用「TA」/);
      expect(block).toMatch(/禁用.{0,30}他.{0,10}她/);
    });

    it('gender 代词约束段在 实体归因 段之后（保证显眼且不被其它规则干扰）', () => {
      const block = formatXingyeSpeakerContextForPrompt({ userName: '莫子', agentName: '林雾', gender: 'female' });
      const entityIdx = block.indexOf('speaker context / 实体归因规则');
      const genderIdx = block.indexOf('pronoun / 性别与代词约束');
      expect(entityIdx).toBeGreaterThanOrEqual(0);
      expect(genderIdx).toBeGreaterThan(entityIdx);
    });
  });
});
