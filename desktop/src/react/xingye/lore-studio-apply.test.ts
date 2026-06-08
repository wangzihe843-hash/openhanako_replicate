import { describe, expect, it } from 'vitest';
import { applyLoreEntries, flattenProfilePatch } from './lore-studio-apply';
import { createLoreEntry, listLoreEntries, XINGYE_LORE_ENTRIES_STORAGE_KEY } from './xingye-lore-store';
import type { StudioPlanLoreEntry } from './lore-studio-types';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function makeStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
  };
}

const AGENT = 'agent-x';

function entry(partial: Partial<StudioPlanLoreEntry>): StudioPlanLoreEntry {
  return {
    title: 'T',
    content: 'C',
    category: 'background',
    insertionMode: 'always',
    keywords: [],
    ...partial,
  };
}

describe('applyLoreEntries', () => {
  it('creates new lore entries', () => {
    const storage = makeStorage();
    const res = applyLoreEntries(
      AGENT,
      [
        entry({ title: '出身', content: '边境长大', category: 'background' }),
        entry({ title: '禁忌', content: '不碰火', category: 'rule', insertionMode: 'manual' }),
      ],
      storage,
    );
    expect(res.created).toHaveLength(2);
    expect(res.updated).toHaveLength(0);
    const stored = listLoreEntries(AGENT, storage);
    expect(stored.map((e) => e.title).sort()).toEqual(['出身', '禁忌']);
    expect(stored.find((e) => e.title === '禁忌')?.category).toBe('rule');
    expect(stored.find((e) => e.title === '禁忌')?.insertionMode).toBe('manual');
  });

  it('updates an existing entry with the same title instead of duplicating', () => {
    const storage = makeStorage();
    const existing = createLoreEntry(
      AGENT,
      { title: '出身', content: '旧内容', category: 'background' },
      storage,
    );
    const res = applyLoreEntries(
      AGENT,
      [entry({ title: '出身', content: '新内容（更详细）', category: 'background' })],
      storage,
    );
    expect(res.created).toHaveLength(0);
    expect(res.updated).toHaveLength(1);
    const stored = listLoreEntries(AGENT, storage);
    expect(stored).toHaveLength(1);
    expect(stored[0].id).toBe(existing.id);
    expect(stored[0].content).toBe('新内容（更详细）');
  });

  it('matches title case-insensitively across categories', () => {
    const storage = makeStorage();
    createLoreEntry(AGENT, { title: 'Eldhaven', content: 'a city', category: 'location' }, storage);
    const res = applyLoreEntries(
      AGENT,
      [entry({ title: 'eldhaven', content: 'a fortified city', category: 'worldview' })],
      storage,
    );
    expect(res.updated).toHaveLength(1);
    expect(listLoreEntries(AGENT, storage)).toHaveLength(1);
  });

  it('dedupes within a single batch (later same-title entry updates the earlier)', () => {
    const storage = makeStorage();
    const res = applyLoreEntries(
      AGENT,
      [
        entry({ title: '盟约', content: '第一版', category: 'event' }),
        entry({ title: '盟约', content: '第二版', category: 'event' }),
      ],
      storage,
    );
    expect(res.created).toHaveLength(1);
    expect(res.updated).toHaveLength(1);
    const stored = listLoreEntries(AGENT, storage);
    expect(stored).toHaveLength(1);
    expect(stored[0].content).toBe('第二版');
  });

  it('skips entries missing title or content', () => {
    const storage = makeStorage();
    const res = applyLoreEntries(
      AGENT,
      [entry({ title: '', content: 'x' }), entry({ title: 'ok', content: '' })],
      storage,
    );
    expect(res.created).toHaveLength(0);
    expect(res.skipped).toHaveLength(2);
    expect(storage.getItem(XINGYE_LORE_ENTRIES_STORAGE_KEY)).toBeFalsy();
  });
});

describe('flattenProfilePatch', () => {
  it('keeps only allowed fields with non-empty trimmed values', () => {
    const out = flattenProfilePatch([
      { field: 'behaviorLogic', value: '  先观察再行动  ' },
      { field: 'values', value: '' },
      // @ts-expect-error invalid field is filtered
      { field: 'notARealField', value: 'x' },
      { field: 'taboos', value: '不说谎' },
    ]);
    expect(out).toEqual({ behaviorLogic: '先观察再行动', taboos: '不说谎' });
  });

  it('returns empty object for undefined patch', () => {
    expect(flattenProfilePatch(undefined)).toEqual({});
  });
});
