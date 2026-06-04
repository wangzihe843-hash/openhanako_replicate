import { describe, expect, it } from 'vitest';
import { buildMailInitPrompt } from './xingye-mail-prompts';

const BASE = {
  agent: { id: 'agent-m', name: 'Lin', yuan: 'y' as const },
  userName: '阿野',
  profile: null,
  ownerAddress: 'lin@mail.fictional',
  virtualContacts: [
    { id: 'vc-1', displayName: '联系人甲', kind: '同事', relationshipHint: '老同事', impression: '聊得来的老同事' },
  ],
  recentSceneBlock: '最近聊到换季',
  stableLoreBlock: '稳定设定SENTINEL',
  keywordLoreBlock: '关键词设定SENTINEL',
  relationshipBlock: '关系状态SENTINEL',
  heartbeatBlock: '巡检SENTINEL',
  continuityAnchorBlock: '',
};

describe('buildMailInitPrompt — scope gating', () => {
  it('personal scope: 私人三邮箱 + 注入关系状态 / 通讯录，禁止 promotions / spam', () => {
    const prompt = buildMailInitPrompt({ ...BASE, scope: 'personal' });
    expect(prompt).toContain('只用 inbox / sent / drafts');
    expect(prompt).toContain('禁止生成 promotions / spam');
    // 私人段注入关系状态 / 通讯录。
    expect(prompt).toContain('关系状态SENTINEL');
    expect(prompt).toContain('可参考的虚拟联系人');
    expect(prompt).toContain('联系人甲');
    // 印象随候选池一并注入，发件语气才贴关系质感。
    expect(prompt).toContain('印象：聊得来的老同事');
    // 私人段不含 bulk 的世界观融入指令。
    expect(prompt).not.toContain('世界观融入');
  });

  it('bulk scope: 推广/垃圾两邮箱 + 世界观融入，硬隔离掉关系状态 / 通讯录', () => {
    const prompt = buildMailInitPrompt({ ...BASE, scope: 'bulk' });
    expect(prompt).toContain('只用 promotions / spam');
    expect(prompt).toContain('禁止生成 inbox / sent / drafts');
    expect(prompt).toContain('世界观融入');
    // 即便传入了 relationshipBlock / virtualContacts，bulk 段也刻意不渲染——硬隔离。
    expect(prompt).not.toContain('关系状态SENTINEL');
    expect(prompt).not.toContain('可参考的虚拟联系人');
    expect(prompt).not.toContain('联系人甲');
    // 世界观素材来源：stable / keyword lore 仍在。
    expect(prompt).toContain('稳定设定SENTINEL');
    expect(prompt).toContain('关键词设定SENTINEL');
  });

  it('both scopes keep the shared schema + 跨期防重复锚点', () => {
    for (const scope of ['personal', 'bulk'] as const) {
      const prompt = buildMailInitPrompt({ ...BASE, scope });
      expect(prompt).toContain('输出 JSON schema');
      expect(prompt).toContain('已有邮箱里的最近邮件');
    }
  });
});
