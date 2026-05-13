import { describe, expect, it } from 'vitest';
import { buildXingyeRelationshipLoreTemplateContent } from './xingye-lore-relationship-template';

describe('buildXingyeRelationshipLoreTemplateContent', () => {
  it('interpolates user and agent names and includes scope / pronoun / NPC rules', () => {
    const text = buildXingyeRelationshipLoreTemplateContent({
      userName: '  莫子  ',
      agentName: '  林雾 ',
    });
    expect(text).toContain('莫子');
    expect(text).toContain('林雾');
    expect(text).toContain('不是同一个人');
    expect(text).toContain('pinned.md');
    expect(text).toContain('identity.md');
    expect(text).toContain('同行者');
  });

  it('falls back when names are blank', () => {
    const text = buildXingyeRelationshipLoreTemplateContent({ userName: '   ', agentName: '' });
    expect(text).toContain('用户');
    expect(text).toContain('当前角色');
  });
});
