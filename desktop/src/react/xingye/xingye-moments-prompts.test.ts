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
  it('keeps each same-name commenter’s directional fields separate from the user and author', () => {
    const args = {
      ...baseArgs(), userName: '小岑',
      virtualContacts: [{ id: 'peer', displayName: '小岑', impression: '作者对联系人：谨慎', signature: '联系人自述：我喜欢吉他' }],
      peerAgents: [{ id: 'peer', displayName: '小岑', relationshipLabel: '真实角色与用户：旧识', impressionOfAuthor: '真实角色对作者：信任' }],
    };
    const before = structuredClone(args);
    const prompt = buildMomentDraftPrompt(args);
    const contactBlock = prompt.slice(prompt.indexOf('【可选互动者池 · 当前角色的虚拟联系人'), prompt.indexOf('【可选互动者池 · 其他星野角色'));
    const peerBlock = prompt.slice(prompt.indexOf('【可选互动者池 · 其他星野角色'));
    expect(contactBlock).toContain('"ref": "vc:peer"');
    expect(contactBlock).toContain('作者对联系人：谨慎');
    expect(contactBlock).not.toContain('真实角色对作者：信任');
    expect(peerBlock).toContain('"ref": "agent:peer"');
    expect(peerBlock).toContain('真实角色对作者：信任');
    expect(peerBlock).not.toContain('作者对联系人：谨慎');
    expect(args).toEqual(before);
  });

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
