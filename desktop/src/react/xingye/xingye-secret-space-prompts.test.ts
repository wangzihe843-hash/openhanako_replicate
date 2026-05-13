import { describe, expect, it } from 'vitest';
import { buildSecretSpaceGenerationPrompt } from './xingye-secret-space-prompts';
import { getSecretSpaceLorePurpose } from './xingye-secret-space-ai-context';

describe('buildSecretSpaceGenerationPrompt', () => {
  const agent = { id: 'a1', name: 'Role', yuan: 'y' };

  const categories = ['draft_reply', 'dream', 'saved_item', 'unsent_moment'] as const;

  it.each(categories)('maps category %s to matching lore purpose', (category) => {
    expect(getSecretSpaceLorePurpose(category)).toBe(`secret_space_${category}`);
  });

  it('constructs prompt without recent chat (empty cache degraded block)', () => {
    const emptyRecent =
      '最近 OpenHanako 聊天上下文：（无）\n说明：当前角色尚无 OpenHanako 会话记录，本次仅根据角色资料与通讯录更新。';
    const prompt = buildSecretSpaceGenerationPrompt({
      category: 'dream',
      agent,
      profile: null,
      recentChatBlock: emptyRecent,
      loreContextText: '',
    });
    expect(prompt).toContain(emptyRecent);
    expect(prompt).toContain('"profile": null');
    expect(prompt).toContain('"title": "string"');
    expect(prompt).toContain('"content": "string"');
    expect(prompt).toContain('梦境');
  });

  it('draft_reply prompt mentions reply draft task', () => {
    const prompt = buildSecretSpaceGenerationPrompt({
      category: 'draft_reply',
      agent,
      profile: { agentId: agent.id, updatedAt: new Date().toISOString() },
      recentChatBlock: '最近 OpenHanako 聊天上下文：（无）',
      loreContextText: '',
    });
    expect(prompt).toContain('尚未发送');
    expect(prompt).not.toContain('收藏线索');
  });

  it('saved_item includes optional seed section', () => {
    const prompt = buildSecretSpaceGenerationPrompt({
      category: 'saved_item',
      agent,
      profile: null,
      recentChatBlock: '最近 OpenHanako 聊天上下文：（无）',
      loreContextText: '',
      seedText: '  一条  线索  ',
    });
    expect(prompt).toContain('收藏线索');
    expect(prompt).toContain('一条 线索');
  });

  it('unsent_moment prompt mentions 朋友圈', () => {
    const prompt = buildSecretSpaceGenerationPrompt({
      category: 'unsent_moment',
      agent,
      profile: null,
      recentChatBlock: '最近 OpenHanako 聊天上下文：（无）',
      loreContextText: '',
    });
    expect(prompt).toContain('朋友圈');
  });
});
