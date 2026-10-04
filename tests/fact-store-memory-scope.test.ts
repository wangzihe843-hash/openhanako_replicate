import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FactStore } from '../lib/memory/fact-store.ts';
import { createMemorySearchTool } from '../lib/memory/memory-search.ts';

const story = { version: 1, agentId: 'hana', realm: 'story', worldId: 'world-a', branchId: 'branch-a', knowledge: 'shared' };
const alice = { ...story, knowledge: 'character', characterId: 'alice' };
const author = { ...story, viewpoint: 'author' };
const fact = (text: string, memoryScope?: unknown, extras = {}) => ({ fact: text, tags: ['marker'], memoryScope, ...extras });

describe('L1 scope-filtered durable FactStore', () => {
  let store: FactStore;
  beforeEach(() => { store = new FactStore(':memory:', { agentId: 'hana' }); });
  afterEach(() => { store.close(); });

  it('filters realms, worlds, branches, agents and knowledge in every content getter', () => {
    const legacyId = store.add(fact('legacy marker')).id;
    store.add(fact('reality marker', { agentId: 'hana', realm: 'reality' }));
    const sharedId = store.add(fact('shared marker', story, { session_id: 's1' })).id;
    store.add(fact('alice marker', alice, { session_id: 's1' }));
    store.add(fact('bob marker', { ...alice, characterId: 'bob' }));
    store.add(fact('author marker', { ...story, knowledge: 'author' }));
    store.add(fact('other world marker', { ...story, worldId: 'world-b' }));
    store.add(fact('other branch marker', { ...story, branchId: 'branch-b' }));
    store.add(fact('other agent marker', { ...story, agentId: 'other' }));
    expect(store.getAll().map(r => r.fact)).toEqual(['legacy marker']);
    expect(store.getAll(alice).map(r => r.fact)).toEqual(['shared marker', 'alice marker']);
    expect(store.getBySession('s1', alice)).toHaveLength(2);
    expect(store.getBySession('s1')).toEqual([]);
    expect(store.getById(sharedId)).toBeNull();
    expect(store.getById(legacyId, story)).toBeNull();
    expect(store.getById(sharedId, story)?.fact).toBe('shared marker');
    expect(store.getAll(author).map(r => r.fact)).toEqual(['shared marker', 'alice marker', 'bob marker', 'author marker']);
    expect(store.exportAll()).toHaveLength(9);
  });

  it('applies runtime scope before tag and FTS limits, and composes channel filtering', () => {
    for (let n = 0; n < 40; n++) {
      store.add(fact('marker hidden', { ...story, branchId: 'hidden' }, { time: '2026-10-01' }));
      store.add(fact('marker other channel', story, { session_id: 'channel-beta', time: '2026-10-01' }));
    }
    store.add(fact('marker allowed', story, { session_id: 'channel-alpha', time: '2020-01-01' }));
    const channel = { kind: 'channel' as const, channelId: 'alpha' };
    expect(store.searchByTags(['marker'], undefined, 1, channel, story).map(r => r.fact)).toEqual(['marker allowed']);
    expect(store.searchFullText('marker', 1, { scope: channel, memoryScope: story }).map(r => r.fact)).toEqual(['marker allowed']);
    expect(store.searchByTags(['marker'], undefined, 1)).toEqual([]);
    expect(store.searchFullText('marker', 1)).toEqual([]);
  });

  it('enforces the same scope and source filters in LIKE fallback before LIMIT', () => {
    for (let n = 0; n < 30; n++) store.add(fact('茉莉花茶 hidden', { ...story, branchId: 'other' }, { time: '2026-10-01' }));
    store.add(fact('茉莉花茶 stale', story, { time: '2026-10-01', session_id: 'stale-source' }));
    store.invalidateSource('stale-source');
    store.add(fact('茉莉花茶 allowed', story, { time: '2020-01-01' }));
    store.db.exec('DROP TABLE facts_fts'); // force the FTS error fallback
    expect(store.searchFullText('茉莉花茶', 1, { memoryScope: story }).map(r => r.fact)).toEqual(['茉莉花茶 allowed']);
    expect(store.searchFullText('茉莉花茶', 1)).toEqual([]);
  });

  it('never downgrades malformed runtime or stored metadata into legacy', () => {
    const { id } = store.add(fact('legacy marker'));
    store.db.prepare('UPDATE facts SET memory_scope = ? WHERE id = ?').run('{"realm":"story"}', id);
    expect(store.getAll()).toEqual([]);
    expect(store.searchFullText('marker')).toEqual([]);
    expect(() => store.exportAll()).toThrow();
    expect(() => store.commitSessionRevision('s1', 'r1', [], { memoryScope: {} })).toThrow();
    expect(() => store.replaceBySession('s1', [], { memoryScope: {} })).toThrow();
    expect(() => store.searchFullText('marker', 1, { memoryScope: {} })).toThrow();
    expect(() => store.searchByTags(['marker'], undefined, 1, null, {})).toThrow();
    expect(() => store.add(fact('bad marker', {}))).toThrow();
    store.db.prepare('UPDATE facts SET memory_scope = ? WHERE id = ?').run('null', id);
    expect(store.getAll()).toEqual([]);
    expect(() => store.exportAll()).toThrow();
    store.db.prepare('UPDATE facts SET memory_scope = NULL WHERE id = ?').run(id);
    expect(store.getAll().map(row => row.fact)).toEqual(['legacy marker']);
  });

  it('keeps tool authority in runtime scope, even with cross_channel and forged model fields', async () => {
    store.add(fact('allowed marker', story, { session_id: 'channel-beta' }));
    store.add(fact('secret marker', { ...story, knowledge: 'author' }));
    store.add(fact('other branch marker', { ...story, branchId: 'hidden' }));
    const tool = createMemorySearchTool(store, { memoryScope: story, conversationScope: { kind: 'channel', channelId: 'alpha' } });
    const text = (await tool.execute('call', {
      query: 'marker', tags: ['marker'], cross_channel: true,
      memoryScope: author, realm: 'reality', viewpoint: 'author', branchId: 'hidden',
    })).content[0].text;
    expect(text).toContain('allowed marker');
    expect(text).not.toContain('secret marker');
    expect(text).not.toContain('other branch marker');
    expect(JSON.stringify(tool.parameters)).not.toContain('memoryScope');
    expect(JSON.stringify(tool.parameters)).not.toContain('viewpoint');
  });

  it('snapshots dynamic runtime context per call and lets runtime override extracted scopes', async () => {
    store.add(fact('runtime marker', { ...story, branchId: 'wrong' }), { memoryScope: story });
    store.commitSessionRevision('source', 'rev1', [fact('committed marker', { ...story, agentId: 'wrong' })], { memoryScope: story });
    let current: unknown = story;
    const tool = createMemorySearchTool(store, { getMemoryScope: () => current });
    expect((await tool.execute('call', { query: 'marker' })).content[0].text).toContain('runtime marker');
    current = { ...story, branchId: 'wrong' };
    expect((await tool.execute('call', { query: 'marker' })).content[0].text).not.toContain('runtime marker');
    expect(store.getBySession('source', story)[0].sourceRevision).toBe('rev1');
  });

  it('invalidates source-revision dependents without erasing history or unrelated revisions', () => {
    store.commitSessionRevision('source', 'rev1', [fact('source marker', story)], { memoryScope: story });
    store.add(fact('derived old marker', story, { sourceDependencies: [{ sessionId: 'source', revision: 'rev1' }], session_id: 'derived' }));
    store.add(fact('derived unknown marker', story, { sourceDependencies: [{ sessionId: 'source' }] }));
    store.add(fact('derived new marker', story, { sourceDependencies: [{ sessionId: 'source', revision: 'rev2' }] }));
    expect(store.invalidateSource('source', { revision: 'rev1', reason: 'branch changed' })).toBe(3);
    expect(store.getSessionCommitRevision('source')).toBeNull();
    expect(store.searchByTags(['marker'], undefined, 1, null, story).map(r => r.fact)).toEqual(['derived new marker']);
    expect(store.searchFullText('marker', 1, { memoryScope: story }).map(r => r.fact)).toEqual(['derived new marker']);
    expect(store.exportAll().filter(r => r.sourceStatus === 'stale')).toHaveLength(3);
    expect(store.exportAll().find(r => r.fact === 'source marker')?.sourceInvalidatedReason).toBe('branch changed');
    expect(store.invalidateSource('source')).toBe(1);
    expect(store.getAll(story)).toEqual([]);
  });

  it('invalidates composite facts when any dependency is deleted or replaced, atomically', () => {
    store.add(fact('source marker', story, { session_id: 's1' }));
    store.add(fact('combined marker', story, { session_id: 's3', sourceDependencies: [{ sessionId: 's1' }, { sessionId: 's2' }] }));
    expect(() => store.replaceBySession('s1', [{ fact: null, tags: [] }])).toThrow();
    expect(store.getBySession('s3', story)).toHaveLength(1);
    expect(store.deleteBySession('s1')).toBe(1);
    expect(store.getBySession('s3', story)).toEqual([]);
    expect(store.exportAll()[0].sourceStatus).toBe('stale');
  });

  it('invalidates changed entry A while preserving unchanged B and an unchanged receipt', () => {
    const aggregate = { type: 'source', sessionId: 's1', revision: 'aggregate-v1', hash: 'a'.repeat(64), generation: 1 };
    const a = { ...aggregate, entryId: 'A', revision: 'entry-A-v1', hash: 'b'.repeat(64) };
    const b = { ...aggregate, entryId: 'B', revision: 'entry-B-v1', hash: 'c'.repeat(64) };
    store.commitSessionRevision('s1', 'summary-v1', [
      fact('fact A marker', story, { sourceDependencies: [a] }),
      fact('fact B marker', story, { sourceDependencies: [b] }),
    ], { memoryScope: story });
    store.add(fact('combined marker', story, { session_id: 's2', sourceDependencies: [a, b] }));
    store.add(fact('independent B marker', story, { session_id: 's2', sourceDependencies: [b] }));
    store.add(fact('session-wide marker', story, { sourceDependencies: [aggregate] }));
    expect(store.invalidateSourceEntries('s1', [aggregate, a, b])).toBe(0);
    expect(store.invalidateSourceEntries('s1', [aggregate, { ...a, writeFence: 8 }, { ...b, writeFence: 8 }])).toBe(0);
    expect(store.getSessionCommitRevision('s1')).toBe('summary-v1');
    const nextAggregate = { ...aggregate, revision: 'aggregate-v2', hash: 'd'.repeat(64), generation: 2 };
    const nextA = { ...a, revision: 'entry-A-v2', hash: 'e'.repeat(64), generation: 2 };
    expect(store.invalidateSourceEntries('s1', [nextAggregate, nextA, b])).toBe(3);
    expect(store.getAll(story).map(row => row.fact)).toEqual(['fact B marker', 'independent B marker']);
    expect(store.getSessionCommitRevision('s1')).toBeNull();
    expect(store.exportAll().find(row => row.fact === 'fact B marker')?.sourceDependencies[0]).toEqual(b);
    expect(store.invalidateSourceEntries('s1', [nextAggregate, nextA])).toBe(2);
    expect(store.getAll(story)).toEqual([]);
  });

  it('validates full source snapshots larger than the per-fact dependency limit', () => {
    const active = Array.from({ length: 150 }, (_, index) => ({
      sessionId: 's1', entryId: `entry-${index}`, revision: `revision-${index}`, hash: 'a'.repeat(64), generation: 1,
    }));
    store.add(fact('last entry marker', story, { session_id: 's2', sourceDependencies: [active[149]] }));
    expect(store.invalidateSourceEntries('s1', active)).toBe(0);
    expect(store.getAll(story)).toHaveLength(1);
  });

  it('scoped replacement does not broadly stale external facts supported by unchanged B', () => {
    const aggregate = { type: 'source', sessionId: 's1', revision: 'aggregate-v1', hash: 'a'.repeat(64), generation: 1 };
    const b = { ...aggregate, entryId: 'B', revision: 'entry-B-v1', hash: 'b'.repeat(64) };
    store.commitSessionRevision('s1', 'summary-v1', [fact('old B marker', story, { sourceDependencies: [b] })], { memoryScope: story });
    store.add(fact('external B marker', story, { session_id: 's2', sourceDependencies: [b] }));
    const nextAggregate = { ...aggregate, revision: 'aggregate-v2', hash: 'c'.repeat(64), generation: 2 };
    store.commitSessionRevision('s1', 'summary-v2', [fact('replacement B marker', story, { sourceDependencies: [b] })], {
      memoryScope: story, replace: true, currentSourceDependencies: [nextAggregate, b],
    });
    expect(store.getAll(story).map(row => row.fact)).toEqual(['external B marker', 'replacement B marker']);
    expect(store.getBySession('s1', story)[0].sourceDependencies).toEqual([b]);
    expect(store.getSessionCommitRevision('s1')).toBe('summary-v2');
  });

  it('rolls dependent invalidation back when deletion of the source fails', () => {
    store.add(fact('source marker', story, { session_id: 's1' }));
    store.add(fact('dependent marker', story, { sourceDependencies: [{ sessionId: 's1' }] }));
    store.db.exec("CREATE TRIGGER reject_delete BEFORE DELETE ON facts BEGIN SELECT RAISE(ABORT, 'delete failed'); END;");
    expect(() => store.deleteBySession('s1')).toThrow('delete failed');
    expect(store.getAll(story)).toHaveLength(2);
    expect(store.exportAll().every(row => row.sourceStatus === 'active')).toBe(true);
  });

  it('persists scope and provenance through restart and administrative round trip', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hana-scope-v4-'));
    const filename = path.join(dir, 'facts.db');
    let persistent = new FactStore(filename, { agentId: 'hana' });
    try {
      const provenance = [{ sessionId: 's1', revision: 'r1', type: 'source', hash: 'a'.repeat(64), generation: 2, writeFence: 7,
        sourceRefs: [{ entryId: 'message-1', hash: 'b'.repeat(64), role: 'user' }] }];
      persistent.add(fact('saved marker', alice, { sourceDependencies: provenance }));
      persistent.close();
      persistent = new FactStore(filename, { agentId: 'hana' });
      expect(persistent.getAll()).toEqual([]);
      expect(persistent.getAll(alice)[0].sourceDependencies).toEqual(provenance);
      store.importAll(persistent.exportAll());
      expect(store.getAll(alice)[0].memoryScope).toEqual(alice);
      expect(store.getAll(alice)[0].sourceDependencies).toEqual(provenance);
      store.invalidateSource('s1');
      expect(store.getAll(alice)).toEqual([]);
    } finally {
      persistent.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
