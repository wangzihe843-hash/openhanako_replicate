import { describe, expect, it } from 'vitest';
import { peerNameEquals, peerNameMatches, scanPeerUpgradeCandidates, type PeerScanLoreEntry } from './lore-studio-peer';

function entry(partial: Partial<PeerScanLoreEntry>): PeerScanLoreEntry {
  return { title: 'X', category: 'relationship', keywords: [], ...partial };
}

describe('peerNameMatches', () => {
  it('matches exact and containment (len>=2)', () => {
    expect(peerNameMatches('小满', '妹妹·小满')).toBe(true);
    expect(peerNameMatches('北境守将 凛', '凛')).toBe(false); // 单字不配
    expect(peerNameMatches('凛冬', '凛冬之主')).toBe(true);
    expect(peerNameMatches('A', 'B')).toBe(false);
  });
});

describe('peerNameEquals', () => {
  it('精确归一化相等，不做子串包含（用于写入定位防串味）', () => {
    expect(peerNameEquals('寒鸦', '寒鸦')).toBe(true);
    expect(peerNameEquals('寒 鸦', '寒鸦')).toBe(true); // 空白被归一
    expect(peerNameEquals('寒鸦', '寒鸦影')).toBe(false); // 子串不算相等
    expect(peerNameEquals('', '')).toBe(false);
  });
});

describe('scanPeerUpgradeCandidates', () => {
  it('returns non-user entities from relationship/character lore that have no agent', () => {
    const res = scanPeerUpgradeCandidates({
      loreEntries: [
        entry({ title: '青梅·阿离', category: 'relationship' }),
        entry({ title: '北境军师 寒鸦', category: 'character' }),
        entry({ title: '世界观：两族', category: 'worldview' }), // 非关系/人物 → 忽略
      ],
      agentNames: [],
    });
    expect(res.hasExistingPeerAgent).toBe(false);
    expect(res.candidates.map((c) => c.name).sort()).toEqual(['北境军师 寒鸦', '青梅·阿离']);
  });

  it('excludes entities that already correspond to an existing agent and flags peer presence', () => {
    const res = scanPeerUpgradeCandidates({
      loreEntries: [
        entry({ title: '阿离', category: 'relationship' }),
        entry({ title: '寒鸦', category: 'character' }),
      ],
      agentNames: ['阿离'], // 已是 agent
    });
    expect(res.hasExistingPeerAgent).toBe(true);
    expect(res.candidates.map((c) => c.name)).toEqual(['寒鸦']);
  });

  it('matches agents via keywords aliases', () => {
    const res = scanPeerUpgradeCandidates({
      loreEntries: [entry({ title: '神秘剑客', category: 'character', keywords: ['夜行', '寒鸦'] })],
      agentNames: ['寒鸦'],
    });
    expect(res.hasExistingPeerAgent).toBe(true);
    expect(res.candidates).toHaveLength(0);
  });

  it('excludes contacts already linked to an agent', () => {
    const res = scanPeerUpgradeCandidates({
      loreEntries: [entry({ title: '阿离', category: 'relationship' })],
      agentNames: [],
      linkedContactNames: ['阿离'],
    });
    expect(res.candidates).toHaveLength(0);
    expect(res.hasExistingPeerAgent).toBe(false);
  });

  it('dedupes candidates by normalized title', () => {
    const res = scanPeerUpgradeCandidates({
      loreEntries: [
        entry({ title: '阿离', category: 'relationship' }),
        entry({ title: '阿离', category: 'character' }),
      ],
      agentNames: [],
    });
    expect(res.candidates).toHaveLength(1);
  });
});
