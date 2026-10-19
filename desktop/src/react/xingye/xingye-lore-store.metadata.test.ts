import { describe, expect, it } from 'vitest';
import { selectXingyeLoreEntries, type XingyeLoreDecision } from '../../../../shared/xingye-lore-context.js';
import {
  createLoreEntry, deleteLoreEntry, listLoreEntries, loreEntriesFromAgentLoreJsonBody,
  toggleLoreEntry, updateLoreEntry, XINGYE_LORE_ENTRIES_STORAGE_KEY,
} from './xingye-lore-store';

const agentId = 'agent-a';
const legacy = { version: 1, agentId, realm: 'legacy', knowledge: 'shared' };
const story = { ...legacy, realm: 'story', worldId: 'world-a', branchId: 'branch-a' };
function row(id: string, metadata: Record<string, unknown> = {}) {
  return {
    id, agentId, title: id, content: `synthetic ${id}`, category: 'background',
    keywords: ['synthetic'], priority: 50, enabled: true, visibility: 'canonical', insertionMode: 'always',
    createdAt: '2026-10-01', updatedAt: '2026-10-01', ...metadata,
  };
}
function memoryStore(entries: Record<string, unknown>) {
  let raw = JSON.stringify(entries);
  return {
    getItem: (key: string) => key === XINGYE_LORE_ENTRIES_STORAGE_KEY ? raw : null,
    setItem: (key: string, value: string) => {
      expect(key).toBe(XINGYE_LORE_ENTRIES_STORAGE_KEY);
      raw = value;
    },
    data: () => JSON.parse(raw),
  };
}

describe('Lore metadata guard preservation', () => {
  it.each(['create', 'update', 'toggle', 'delete'])('%s preserves guards on untouched rows and keeps the schema closed', (operation) => {
    const metadata = { memoryScope: story, sourceStatus: 'stale', origin: 'derived' };
    const storage = memoryStore({
      target: row('target'),
      untouched: row('untouched', { ...metadata, unrecognizedMetadata: { trusted: true } }),
      foreign: row('foreign', { ...metadata, agentId: 'agent-b', memoryScope: { ...story, agentId: 'agent-b' } }),
    });
    if (operation === 'create') createLoreEntry(agentId, { title: 'new', content: 'new' }, storage);
    if (operation === 'update') updateLoreEntry('target', { content: 'edited' }, storage);
    if (operation === 'toggle') toggleLoreEntry('target', storage);
    if (operation === 'delete') deleteLoreEntry('target', storage);
    expect(storage.data().untouched).toMatchObject(metadata);
    expect(storage.data().untouched).not.toHaveProperty('unrecognizedMetadata');
    expect(storage.data().foreign).toMatchObject({ ...metadata, memoryScope: { ...story, agentId: 'agent-b' } });
    expect(listLoreEntries(agentId, storage).some(entry => entry.id === 'foreign')).toBe(false);
  });

  it('does not let an ordinary create/update patch provide, clear or promote stored guards', () => {
    const original = row('guarded', { memoryScope: story, origin: 'derived', sourceStatus: 'unknown' });
    const storage = memoryStore({ guarded: original, old: row('old') });
    const forged = { content: 'edited', memoryScope: legacy, origin: 'manual', sourceStatus: 'active',
      id: 'forged', agentId: 'agent-b', createdAt: 'forged', unrelated: true };
    updateLoreEntry('guarded', forged, storage);
    expect(storage.data().guarded).toMatchObject({ ...original, content: 'edited', updatedAt: expect.any(String) });
    const cleared = { ...forged, memoryScope: null, origin: undefined, sourceStatus: undefined };
    updateLoreEntry('guarded', cleared, storage);
    toggleLoreEntry('guarded', storage);
    expect(storage.data().guarded).toMatchObject({ memoryScope: story, origin: 'derived', sourceStatus: 'unknown', enabled: false });
    updateLoreEntry('old', forged, storage);
    const created = createLoreEntry(agentId, { ...forged, title: 'created' }, storage);
    for (const entry of [storage.data().old, created]) {
      for (const key of ['memoryScope', 'origin', 'sourceStatus', 'unrelated']) expect(entry).not.toHaveProperty(key);
    }
  });

  const cases: Array<[string, Record<string, unknown>, unknown, string]> = [
    ['old missing metadata', {}, undefined, 'selected'],
    ['old null scope', { memoryScope: null }, undefined, 'selected'],
    ['explicit legacy derived', { memoryScope: legacy, origin: 'derived' }, undefined, 'selected'],
    ['missing derived scope', { origin: 'derived' }, undefined, 'unconfirmed-derived-source'],
    ['null derived scope', { memoryScope: null, origin: 'derived' }, undefined, 'unconfirmed-derived-source'],
    ['stale source', { sourceStatus: 'stale' }, undefined, 'stale-source'],
    ['active scoped derived', { memoryScope: story, origin: 'derived', sourceStatus: 'active' }, story, 'selected'],
    ['unknown scoped derived', { memoryScope: story, origin: 'derived', sourceStatus: 'unknown' }, story, 'unconfirmed-derived-source'],
    ['future source status', { memoryScope: story, origin: 'derived', sourceStatus: 'pending' }, story, 'unconfirmed-derived-source'],
    ['object source status', { memoryScope: story, origin: 'derived', sourceStatus: { value: 'active' } }, story, 'unconfirmed-derived-source'],
    ['padded source status', { memoryScope: story, origin: 'derived', sourceStatus: ' active ' }, story, 'unconfirmed-derived-source'],
    ['corrupt scope scalar', { memoryScope: false }, undefined, 'scope-unreadable'],
    ['corrupt scope array', { memoryScope: [] }, undefined, 'scope-unreadable'],
    ['corrupt scope object', { memoryScope: {} }, undefined, 'scope-unreadable'],
    ['unsupported scope version', { memoryScope: { ...story, version: 2 } }, story, 'scope-unreadable'],
    ['invalid knowledge', { memoryScope: { ...story, knowledge: 'omniscient' } }, story, 'scope-unreadable'],
    ['other scope owner', { memoryScope: { ...story, agentId: 'agent-b' } }, story, 'scope-unreadable'],
    ['other world', { memoryScope: { ...story, worldId: 'world-b' } }, story, 'scope-unreadable'],
    ['other branch', { memoryScope: { ...story, branchId: 'branch-b' } }, story, 'scope-unreadable'],
    ['stored viewpoint cannot grant author access', { memoryScope: { ...story, knowledge: 'author', viewpoint: 'author' } }, story, 'scope-unreadable'],
    ['trusted runtime author access', { memoryScope: { ...story, knowledge: 'author' } }, { ...story, viewpoint: 'author' }, 'selected'],
    ['other character', { memoryScope: { ...story, knowledge: 'character', characterId: 'alice' } }, { ...story, characterId: 'bob' }, 'scope-unreadable'],
    ['same character', { memoryScope: { ...story, knowledge: 'character', characterId: 'alice' } }, { ...story, characterId: 'alice' }, 'selected'],
  ];
  it.each(cases)('matches the existing shared guard for %s before and after saving', (_name, metadata, context, expected) => {
    const persisted = row('guarded', metadata);
    const storage = memoryStore({ guarded: persisted, edit: row('edit') });
    const before = storage.getItem(XINGYE_LORE_ENTRIES_STORAGE_KEY);
    const decide = (entries: ReturnType<typeof listLoreEntries>) => {
      const decisions: XingyeLoreDecision[] = [];
      selectXingyeLoreEntries({ entries, agentId, memoryScope: context, mode: 'always', onDecision: value => decisions.push(value) });
      const result = decisions.find(value => value.id === 'guarded')!;
      expect(result.reasonDetail ?? result.reason).toBe(expected);
      expect(result).not.toHaveProperty('content');
      expect(result).not.toHaveProperty('memoryScope');
      return result;
    };
    // Both entry points must preserve the existing guard's decision, including malformed scope.
    const rawDecision = decide([persisted as ReturnType<typeof listLoreEntries>[number]]);
    expect(decide(listLoreEntries(agentId, storage))).toEqual(rawDecision);
    expect(decide(loreEntriesFromAgentLoreJsonBody({ guarded: persisted }, agentId))).toEqual(rawDecision);
    expect(storage.getItem(XINGYE_LORE_ENTRIES_STORAGE_KEY)).toBe(before);
    updateLoreEntry('edit', { content: 'ordinary edit' }, storage);
    expect(decide(listLoreEntries(agentId, storage))).toEqual(rawDecision);
    if (Object.hasOwn(metadata, 'memoryScope')) expect(storage.data().guarded.memoryScope).toEqual(metadata.memoryScope);
    else expect(storage.data().guarded).not.toHaveProperty('memoryScope');
  });

  it('takes only own guard fields, preserves string tokens exactly, and defaults only the adapter owner', () => {
    const inherited = Object.assign(Object.create({ memoryScope: story, sourceStatus: 'active', origin: 'manual' }), row('inherited'));
    const [entry] = loreEntriesFromAgentLoreJsonBody({ inherited }, agentId);
    for (const key of ['memoryScope', 'sourceStatus', 'origin']) expect(entry).not.toHaveProperty(key);
    const input = row('ownerless', { agentId: undefined, memoryScope: { realm: 'reality' }, origin: 'future-origin', sourceStatus: 'pending', ignored: true });
    const [normalized] = loreEntriesFromAgentLoreJsonBody({ ownerless: input }, agentId);
    expect(normalized).toMatchObject({ agentId, memoryScope: { realm: 'reality' }, origin: 'future-origin', sourceStatus: 'pending' });
    expect(normalized).not.toHaveProperty('ignored');
    const [malformed] = loreEntriesFromAgentLoreJsonBody({ malformed: row('malformed', { sourceStatus: ['active'], origin: { value: 'manual' } }) }, agentId);
    expect(malformed).not.toHaveProperty('sourceStatus');
    expect(malformed).not.toHaveProperty('origin');
  });
});
