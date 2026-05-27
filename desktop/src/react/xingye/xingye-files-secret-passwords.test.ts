/**
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import {
  collectHiddenPasswordCandidates,
  findCandidateMatch,
  pickRandomCandidate,
} from './xingye-files-secret-passwords';

describe('collectHiddenPasswordCandidates', () => {
  it('从 agent.name / yuan / userName 派生候选并去重', () => {
    const candidates = collectHiddenPasswordCandidates({
      agent: { id: 'a', name: 'Lin Wu', yuan: 'hanako' },
      profile: null,
      userName: 'Margaret',
      loreEntries: null,
      virtualContacts: null,
    });
    const values = candidates.map((c) => c.value);
    expect(values).toContain('Lin Wu');
    expect(values).toContain('LinWu'); // 去空格
    expect(values).toContain('LW'); // 首字母
    expect(values).toContain('hanako');
    expect(values).toContain('Margaret');
    // 不应该有 1 字符候选
    expect(values.every((v) => v.length >= 2)).toBe(true);
  });

  it('displayName 覆盖 agent.name 用作 label 主名', () => {
    const candidates = collectHiddenPasswordCandidates({
      agent: { id: 'a', name: 'fallback', yuan: 'hanako' },
      profile: {
        agentId: 'a',
        displayName: '林雾',
        updatedAt: '2026-01-01T00:00:00Z',
      },
      userName: '',
      loreEntries: null,
      virtualContacts: null,
    });
    expect(candidates.some((c) => c.value === '林雾')).toBe(true);
    /** 中文名拿不到拉丁首字母 → 不应该出现 ascii 首字母候选。 */
    expect(candidates.find((c) => c.kind === 'agent_initials')).toBeUndefined();
  });

  it('lore 里的 character 条目（enabled）会进入候选池', () => {
    const candidates = collectHiddenPasswordCandidates({
      agent: { id: 'a', name: 'Lin', yuan: '' },
      profile: null,
      userName: '',
      loreEntries: [
        {
          id: 'l1',
          agentId: 'a',
          title: 'Aiko Sato',
          content: '',
          category: 'character',
          keywords: [],
          enabled: true,
          priority: 0,
          insertionMode: 'always',
          visibility: 'canonical',
          createdAt: '',
          updatedAt: '',
        },
        {
          id: 'l2',
          agentId: 'a',
          title: 'Disabled NPC',
          content: '',
          category: 'character',
          keywords: [],
          enabled: false,
          priority: 0,
          insertionMode: 'always',
          visibility: 'canonical',
          createdAt: '',
          updatedAt: '',
        },
        {
          id: 'l3',
          agentId: 'a',
          title: 'World Lore Not Character',
          content: '',
          category: 'worldview',
          keywords: [],
          enabled: true,
          priority: 0,
          insertionMode: 'always',
          visibility: 'canonical',
          createdAt: '',
          updatedAt: '',
        },
      ],
      virtualContacts: null,
    });
    const values = candidates.map((c) => c.value);
    expect(values).toContain('Aiko Sato');
    expect(values).toContain('AS'); // 首字母
    expect(values).not.toContain('Disabled NPC');
    expect(values).not.toContain('World Lore Not Character');
  });

  it('被删除 / 拉黑 的虚拟联系人不进候选池', () => {
    const candidates = collectHiddenPasswordCandidates({
      agent: { id: 'a', name: 'Lin', yuan: '' },
      profile: null,
      userName: '',
      loreEntries: null,
      virtualContacts: [
        {
          ownerAgentId: 'a',
          id: 'c1',
          displayName: 'Active Friend',
          kind: 'friend',
          status: 'active',
          createdAt: '',
          updatedAt: '',
        },
        {
          ownerAgentId: 'a',
          id: 'c2',
          displayName: 'Deleted Friend',
          kind: 'friend',
          status: 'deleted',
          createdAt: '',
          updatedAt: '',
        },
      ],
    });
    const values = candidates.map((c) => c.value);
    expect(values).toContain('Active Friend');
    expect(values).not.toContain('Deleted Friend');
  });

  it('空上下文返回空数组（不抛）', () => {
    const candidates = collectHiddenPasswordCandidates({
      agent: null,
      profile: null,
      userName: null,
      loreEntries: null,
      virtualContacts: null,
    });
    expect(candidates).toEqual([]);
  });
});

describe('findCandidateMatch', () => {
  const pool = [
    { value: 'LW', label: 'agent initials', kind: 'agent_initials' as const },
    { value: 'hanako', label: 'agent yuan', kind: 'agent_yuan' as const },
  ];

  it('大小写不敏感匹配', () => {
    expect(findCandidateMatch(pool, 'lw')?.value).toBe('LW');
    expect(findCandidateMatch(pool, 'HANAKO')?.value).toBe('hanako');
  });

  it('不匹配返回 null', () => {
    expect(findCandidateMatch(pool, 'something else')).toBeNull();
  });

  it('空输入返回 null', () => {
    expect(findCandidateMatch(pool, '   ')).toBeNull();
  });
});

describe('pickRandomCandidate', () => {
  const pool = [
    { value: 'AA', label: 'a', kind: 'agent_name' as const },
    { value: 'BB', label: 'b', kind: 'agent_yuan' as const },
    { value: 'CC', label: 'c', kind: 'user_name' as const },
  ];

  it('用 randomSource 注入确定性挑选', () => {
    expect(pickRandomCandidate(pool, { randomSource: () => 0 })?.value).toBe('AA');
    expect(pickRandomCandidate(pool, { randomSource: () => 0.99 })?.value).toBe('CC');
  });

  it('excludeValue 把上次的候选排掉', () => {
    /** 不在排除池里 → 池中只剩 BB / CC，随机源 0 → BB。 */
    const picked = pickRandomCandidate(pool, {
      excludeValue: 'AA',
      randomSource: () => 0,
    });
    expect(picked?.value).toBe('BB');
  });

  it('exclude 后池为空时回退到全集（不返回 null）', () => {
    const single = [{ value: 'XX', label: 'x', kind: 'agent_name' as const }];
    const picked = pickRandomCandidate(single, {
      excludeValue: 'XX',
      randomSource: () => 0,
    });
    expect(picked?.value).toBe('XX');
  });

  it('空池返回 null', () => {
    expect(pickRandomCandidate([], { randomSource: () => 0 })).toBeNull();
  });
});
