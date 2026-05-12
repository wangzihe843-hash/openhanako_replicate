import { describe, expect, it } from 'vitest';
import {
  buildXingyeRuntimeLoreContext,
  buildXingyeStableLoreMemoryContext,
} from './xingye-lore-context.js';

const baseEntry = (overrides = {}) => ({
  id: overrides.id ?? 'lore-1',
  agentId: overrides.agentId ?? 'agent-a',
  title: overrides.title ?? 'Childhood',
  content: overrides.content ?? 'Raised beside the old observatory.',
  category: overrides.category ?? 'background',
  keywords: overrides.keywords ?? [],
  enabled: overrides.enabled ?? true,
  priority: overrides.priority ?? 50,
  insertionMode: overrides.insertionMode ?? 'always',
  visibility: overrides.visibility ?? 'canonical',
  createdAt: overrides.createdAt ?? '2026-01-01T00:00:00.000Z',
  updatedAt: overrides.updatedAt ?? '2026-01-02T00:00:00.000Z',
});

describe('buildXingyeStableLoreMemoryContext', () => {
  it('includes enabled canonical always background lore in the stable block', () => {
    const result = buildXingyeStableLoreMemoryContext({
      entries: [baseEntry()],
      agentId: 'agent-a',
    });

    expect(result.text).toContain('【星野核心设定】');
    expect(result.text).toContain('以下是角色长期背景、核心关系或核心人物设定');
    expect(result.text).toContain('Childhood');
    expect(result.text).toContain('Raised beside the old observatory.');
    expect(result.entries).toEqual([
      {
        id: 'lore-1',
        title: 'Childhood',
        category: 'background',
        priority: 50,
        insertionMode: 'always',
      },
    ]);
  });

  it('includes relationship and character lore', () => {
    const result = buildXingyeStableLoreMemoryContext({
      entries: [
        baseEntry({ id: 'rel', title: 'Bond', category: 'relationship' }),
        baseEntry({ id: 'char', title: 'Mentor', category: 'character' }),
      ],
      agentId: 'agent-a',
    });

    expect(result.entries.map((entry) => entry.category)).toEqual(['relationship', 'character']);
  });

  it('excludes non-stable categories even when they are canonical always lore', () => {
    const excludedCategories = ['worldview', 'location', 'organization', 'rule', 'event'];
    const result = buildXingyeStableLoreMemoryContext({
      entries: excludedCategories.map((category) => baseEntry({ id: category, category })),
      agentId: 'agent-a',
    });

    expect(result.text).toBe('');
    expect(result.entries).toEqual([]);
  });

  it('excludes disabled lore, draft/private lore, keyword/manual lore, other agents, and empty content', () => {
    const result = buildXingyeStableLoreMemoryContext({
      entries: [
        baseEntry({ id: 'disabled', enabled: false }),
        baseEntry({ id: 'draft', visibility: 'draft' }),
        baseEntry({ id: 'private', visibility: 'private' }),
        baseEntry({ id: 'keyword', insertionMode: 'keyword' }),
        baseEntry({ id: 'manual', insertionMode: 'manual' }),
        baseEntry({ id: 'other-agent', agentId: 'agent-b' }),
        baseEntry({ id: 'empty', content: '   ' }),
      ],
      agentId: 'agent-a',
    });

    expect(result.text).toBe('');
    expect(result.entries).toEqual([]);
  });

  it('returns an empty context for an empty agentId or no matching entries', () => {
    expect(buildXingyeStableLoreMemoryContext({ entries: [baseEntry()], agentId: '' })).toEqual({
      text: '',
      entries: [],
    });
    expect(buildXingyeStableLoreMemoryContext({ entries: [], agentId: 'agent-a' })).toEqual({
      text: '',
      entries: [],
    });
  });

  it('accepts entry maps as input', () => {
    const result = buildXingyeStableLoreMemoryContext({
      entries: {
        first: baseEntry({ id: 'first', title: 'First' }),
      },
      agentId: 'agent-a',
    });

    expect(result.entries.map((entry) => entry.id)).toEqual(['first']);
  });

  it('sorts by priority desc, updatedAt desc, then title/id for stable ordering', () => {
    const result = buildXingyeStableLoreMemoryContext({
      entries: [
        baseEntry({ id: 'old', title: 'Old', priority: 80, updatedAt: '2026-01-01T00:00:00.000Z' }),
        baseEntry({ id: 'low', title: 'Low', priority: 20, updatedAt: '2026-01-05T00:00:00.000Z' }),
        baseEntry({ id: 'new', title: 'New', priority: 80, updatedAt: '2026-01-03T00:00:00.000Z' }),
        baseEntry({ id: 'a', title: 'Alpha', priority: 80, updatedAt: '2026-01-03T00:00:00.000Z' }),
      ],
      agentId: 'agent-a',
    });

    expect(result.entries.map((entry) => entry.id)).toEqual(['a', 'new', 'old', 'low']);
  });

  it('honors maxChars without adding lower-priority overflowing entries', () => {
    const entries = [
      baseEntry({ id: 'high', title: 'High', content: 'A'.repeat(40), priority: 100 }),
      baseEntry({ id: 'low', title: 'Low', content: 'B'.repeat(500), priority: 10 }),
    ];
    const oneEntryLength = buildXingyeStableLoreMemoryContext({ entries: [entries[0]], agentId: 'agent-a' }).text.length;
    const result = buildXingyeStableLoreMemoryContext({
      entries,
      agentId: 'agent-a',
      maxChars: oneEntryLength + 10,
    });

    expect(result.entries.map((entry) => entry.id)).toEqual(['high']);
    expect(result.text.length).toBeLessThanOrEqual(oneEntryLength + 10);
  });

  it('truncates an oversized single entry stably with an omission marker', () => {
    const result = buildXingyeStableLoreMemoryContext({
      entries: [baseEntry({ id: 'long', title: 'Long', content: 'C'.repeat(500), priority: 100 })],
      agentId: 'agent-a',
      maxChars: 180,
    });

    expect(result.entries.map((entry) => entry.id)).toEqual(['long']);
    expect(result.text.length).toBeLessThanOrEqual(180);
    expect(result.text).toContain('...');
  });

  it('does not emit undefined, null, or object string fragments', () => {
    const result = buildXingyeStableLoreMemoryContext({
      entries: [baseEntry({ title: undefined, content: { unexpected: true } })],
      agentId: 'agent-a',
    });

    expect(result.text).not.toContain('undefined');
    expect(result.text).not.toContain('null');
    expect(result.text).not.toContain('[object Object]');
  });
});

describe('buildXingyeRuntimeLoreContext', () => {
  const keywordEntry = (overrides = {}) =>
    baseEntry({
      category: 'worldview',
      insertionMode: 'keyword',
      keywords: ['observatory'],
      ...overrides,
    });

  it('includes keyword lore when userText matches and reports matched keywords', () => {
    const result = buildXingyeRuntimeLoreContext({
      entries: [keywordEntry({ id: 'runtime-1', title: 'Old Observatory' })],
      agentId: 'agent-a',
      userText: 'Can we visit the observatory tonight?',
    });

    expect(result.text).toContain('# 星野设定参考');
    expect(result.text).toContain('以下内容是本轮相关世界观、地点、组织、规则、事件或人物关系参考');
    expect(result.text).toContain('只作为当前回复的背景约束');
    expect(result.text).toContain('不要写入长期记忆');
    expect(result.text).toContain('不要机械复述原文');
    expect(result.text).toContain('以当前对话事实为准');
    expect(result.text).toContain('Old Observatory');
    expect(result.text).toContain('observatory');
    expect(result.text).toContain('Raised beside the old observatory.');
    expect(result.entries).toEqual([
      {
        id: 'runtime-1',
        title: 'Old Observatory',
        category: 'worldview',
        priority: 50,
        insertionMode: 'keyword',
        matchedKeywords: ['observatory'],
      },
    ]);
  });

  it('includes keyword lore when recentMessages match strings or readable object fields', () => {
    const result = buildXingyeRuntimeLoreContext({
      entries: [
        keywordEntry({ id: 'string-hit', title: 'Gate', keywords: ['north gate'] }),
        keywordEntry({ id: 'object-hit', title: 'Guild', keywords: ['guild'] }),
      ],
      agentId: 'agent-a',
      recentMessages: [
        'We stopped near the north gate.',
        { text: 'The guild sent a courier.' },
        { ignored: 'observatory' },
      ],
    });

    expect(result.entries.map((entry) => entry.id)).toEqual(['string-hit', 'object-hit']);
    expect(result.entries[0].matchedKeywords).toEqual(['north gate']);
    expect(result.entries[1].matchedKeywords).toEqual(['guild']);
  });

  it('matches Chinese keywords with substring checks', () => {
    const result = buildXingyeRuntimeLoreContext({
      entries: [keywordEntry({ id: 'cn', title: '旧城区', keywords: ['旧城区'] })],
      agentId: 'agent-a',
      userText: '我们去旧城区看看。',
    });

    expect(result.entries.map((entry) => entry.id)).toEqual(['cn']);
    expect(result.entries[0].matchedKeywords).toEqual(['旧城区']);
  });

  it('matches English keywords case-insensitively', () => {
    const result = buildXingyeRuntimeLoreContext({
      entries: [keywordEntry({ id: 'case', title: 'Library', keywords: ['Moon Library'] })],
      agentId: 'agent-a',
      userText: 'MOON library',
    });

    expect(result.entries.map((entry) => entry.id)).toEqual(['case']);
    expect(result.entries[0].matchedKeywords).toEqual(['Moon Library']);
  });

  it('excludes disabled, non-canonical, manual, always, other-agent, empty-content, and no-keyword lore', () => {
    const result = buildXingyeRuntimeLoreContext({
      entries: [
        keywordEntry({ id: 'disabled', enabled: false }),
        keywordEntry({ id: 'draft', visibility: 'draft' }),
        keywordEntry({ id: 'private', visibility: 'private' }),
        keywordEntry({ id: 'manual', insertionMode: 'manual' }),
        keywordEntry({ id: 'always', insertionMode: 'always', category: 'background' }),
        keywordEntry({ id: 'other-agent', agentId: 'agent-b' }),
        keywordEntry({ id: 'empty-content', content: '   ' }),
        keywordEntry({ id: 'empty-keywords', keywords: [] }),
        keywordEntry({ id: 'blank-keywords', keywords: [' ', '\n'] }),
      ],
      agentId: 'agent-a',
      userText: 'observatory',
    });

    expect(result).toEqual({ text: '', entries: [] });
  });

  it('returns an empty context for empty agentId or no keyword match without throwing', () => {
    expect(
      buildXingyeRuntimeLoreContext({
        entries: [keywordEntry()],
        agentId: '',
        userText: 'observatory',
      }),
    ).toEqual({ text: '', entries: [] });

    expect(
      buildXingyeRuntimeLoreContext({
        entries: [keywordEntry()],
        agentId: 'agent-a',
        userText: 'nothing relevant',
      }),
    ).toEqual({ text: '', entries: [] });
  });

  it('accepts entry maps as input', () => {
    const result = buildXingyeRuntimeLoreContext({
      entries: {
        first: keywordEntry({ id: 'first', title: 'First' }),
      },
      agentId: 'agent-a',
      userText: 'observatory',
    });

    expect(result.entries.map((entry) => entry.id)).toEqual(['first']);
  });

  it('sorts by priority desc, updatedAt desc, then title/id for stable ordering', () => {
    const result = buildXingyeRuntimeLoreContext({
      entries: [
        keywordEntry({ id: 'old', title: 'Old', priority: 80, updatedAt: '2026-01-01T00:00:00.000Z' }),
        keywordEntry({ id: 'low', title: 'Low', priority: 20, updatedAt: '2026-01-05T00:00:00.000Z' }),
        keywordEntry({ id: 'new', title: 'New', priority: 80, updatedAt: '2026-01-03T00:00:00.000Z' }),
        keywordEntry({ id: 'a', title: 'Alpha', priority: 80, updatedAt: '2026-01-03T00:00:00.000Z' }),
      ],
      agentId: 'agent-a',
      userText: 'observatory',
    });

    expect(result.entries.map((entry) => entry.id)).toEqual(['a', 'new', 'old', 'low']);
  });

  it('honors maxChars by keeping higher-priority entries and truncating an oversized selected entry', () => {
    const high = keywordEntry({
      id: 'high',
      title: 'High',
      content: 'A'.repeat(500),
      priority: 100,
    });
    const low = keywordEntry({
      id: 'low',
      title: 'Low',
      content: 'B'.repeat(500),
      priority: 10,
    });
    const result = buildXingyeRuntimeLoreContext({
      entries: [low, high],
      agentId: 'agent-a',
      userText: 'observatory',
      maxChars: 260,
    });

    expect(result.entries.map((entry) => entry.id)).toEqual(['high']);
    expect(result.text.length).toBeLessThanOrEqual(260);
    expect(result.text).toContain('...');
  });

  it('does not emit undefined, null, object fragments, or empty title blocks', () => {
    const result = buildXingyeRuntimeLoreContext({
      entries: [
        keywordEntry({
          id: 'safe-title',
          title: '',
          content: 'Clean lore content.',
          keywords: ['safe'],
        }),
        keywordEntry({
          id: 'bad-content',
          title: 'Bad Content',
          content: { unexpected: true },
          keywords: ['safe'],
        }),
      ],
      agentId: 'agent-a',
      userText: 'safe',
    });

    expect(result.text).toContain('safe-title');
    expect(result.text).not.toContain('undefined');
    expect(result.text).not.toContain('null');
    expect(result.text).not.toContain('[object Object]');
    expect(result.text).not.toContain('标题：\n');
  });

  it('reports every matched trimmed keyword in entry order', () => {
    const result = buildXingyeRuntimeLoreContext({
      entries: [
        keywordEntry({
          id: 'multi',
          title: 'Multi',
          keywords: [' observatory ', 'Moon Library', 'missing'],
        }),
      ],
      agentId: 'agent-a',
      userText: 'The OBSERVATORY and moon library are connected.',
    });

    expect(result.entries[0].matchedKeywords).toEqual(['observatory', 'Moon Library']);
    expect(result.text).toContain('匹配关键词：observatory, Moon Library');
  });
});
