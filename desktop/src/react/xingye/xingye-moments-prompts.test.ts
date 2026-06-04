import { describe, expect, it } from 'vitest';
import { buildMomentDraftPrompt, type XingyeMomentVirtualContactHint } from './xingye-moments-prompts';

function baseArgs() {
  return {
    agent: { id: 'agent-x', name: 'Hoshino', yuan: '本时空' as const },
    userName: '用户',
    profile: null,
    recentSceneBlock: '',
    stableLoreBlock: '',
    keywordLoreBlock: '',
    relationshipBlock: '',
    heartbeatBlock: '',
  };
}

describe('buildMomentDraftPrompt · 通讯录 loreAliases 身份对齐', () => {
  it('互动者带 loreAliases 时，渲染进候选池 JSON 且附带「同一个人」说明', () => {
    const virtualContacts: XingyeMomentVirtualContactHint[] = [
      { id: 'vc-1', displayName: '老周', kind: 'friend', impression: '靠谱', loreAliases: ['周律师'] },
    ];
    const prompt = buildMomentDraftPrompt({ ...baseArgs(), virtualContacts });
    expect(prompt).toContain('loreAliases');
    expect(prompt).toContain('周律师');
    // 池描述里点明「带 loreAliases = 同一个人」。
    expect(prompt).toContain('按同一人处理');
  });

  it('互动者无 loreAliases 时，JSON 里不出现该字段', () => {
    const virtualContacts: XingyeMomentVirtualContactHint[] = [
      { id: 'vc-1', displayName: '夜班搭子', kind: 'friend' },
    ];
    const prompt = buildMomentDraftPrompt({ ...baseArgs(), virtualContacts });
    expect(prompt).toContain('夜班搭子');
    expect(prompt).not.toContain('"loreAliases"');
  });
});
