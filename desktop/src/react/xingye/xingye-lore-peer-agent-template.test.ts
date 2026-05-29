import { describe, it, expect } from 'vitest';
import { buildXingyePeerAgentLoreTemplateContent } from './xingye-lore-peer-agent-template';

describe('buildXingyePeerAgentLoreTemplateContent', () => {
  it('fills agentName / userName and uses 「对方」 placeholder when peerName omitted', () => {
    const out = buildXingyePeerAgentLoreTemplateContent({ userName: '阿星', agentName: '花子' });
    expect(out).toContain('「花子」');
    expect(out).toContain('「阿星」');
    expect(out).toContain('对方'); // 占位
    expect(out).toContain('【适用范围】');
    expect(out).toContain('【实体区分（重要）】');
    expect(out).toContain('【联系方式】');
  });

  it('bakes in a concrete peerName when provided', () => {
    const out = buildXingyePeerAgentLoreTemplateContent({ userName: '阿星', agentName: '花子', peerName: '明' });
    expect(out).toContain('「明」');
    expect(out).toContain('【明 是谁】');
    expect(out).toContain('你与 明 的关系');
  });

  it('makes the peer-vs-user distinction explicit (anti-confusion)', () => {
    const out = buildXingyePeerAgentLoreTemplateContent({ userName: '阿星', agentName: '花子', peerName: '明' });
    // 明确：对方是 AI agent，不是用户、不是自己
    expect(out).toContain('AI agent');
    expect(out).toMatch(/不是\s*阿星（用户）|不是 阿星（用户）/);
    expect(out).toContain('团队');
  });

  it('falls back to sane defaults on empty names', () => {
    const out = buildXingyePeerAgentLoreTemplateContent({ userName: '  ', agentName: '' });
    expect(out).toContain('「当前角色」');
    expect(out).toContain('「用户」');
  });

  it('mentions dm + agent id as the contact channel', () => {
    const out = buildXingyePeerAgentLoreTemplateContent({ userName: 'U', agentName: 'A', peerName: 'B' });
    expect(out).toContain('dm');
    expect(out).toContain('agent id');
  });

  it('bakes the concrete peer id into 实体区分 + 联系方式 when peerId provided', () => {
    const out = buildXingyePeerAgentLoreTemplateContent({
      userName: '阿星',
      agentName: '花子',
      peerName: '明',
      peerId: 'ming',
    });
    expect(out).toContain('id：ming');           // 实体区分里带 id
    expect(out).toContain('对方 id：ming');        // 联系方式里带 id
  });

  it('omits the concrete id wording when peerId absent', () => {
    const out = buildXingyePeerAgentLoreTemplateContent({ userName: 'U', agentName: 'A', peerName: 'B' });
    expect(out).not.toContain('id：');
    expect(out).toContain('按对方的 agent id'); // 回退到泛指
  });
});
