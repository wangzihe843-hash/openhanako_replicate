import { describe, expect, it } from 'vitest';
import { buildXingyeStableLoreMemoryContext } from './xingye-lore-context.js';

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
