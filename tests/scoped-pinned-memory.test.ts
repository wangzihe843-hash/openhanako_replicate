import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSettingsSnapshotRoute } from '../server/routes/settings-snapshot.ts';
import { createAgentsRoute } from '../server/routes/agents.ts';
import { addPinnedMemoryItem, invalidatePinnedMemoryBySession, readPinnedMemoryForContext, readPinnedMemoryItems, replacePinnedMemoryItems } from '../lib/memory/pinned-memory-store.ts';
import { createPinnedMemoryTools } from '../lib/tools/pinned-memory.ts';
import { hashScopedSourceMessage } from '../lib/memory/scoped-derivation-store.ts';
import { normalizeMemoryScope, sameMemoryScope } from '../shared/memory-scope.ts';

const roots: string[] = [];
const scope = (branchId = 'a', extra = {}) => normalizeMemoryScope({ agentId: 'hana', realm: 'story', worldId: 'world', branchId, knowledge: 'shared', ...extra });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scoped-pins-'));
  roots.push(root);
  const agentDir = path.join(root, 'hana');
  fs.mkdirSync(agentDir);
  fs.writeFileSync(path.join(agentDir, 'config.yaml'), 'agent:\n  name: Hana\n');
  return { root, agentDir };
}
function pinnedRouteFixture(memoryScope?: unknown) {
  const { root, agentDir } = fixture();
  const engine = {
    agentsDir: root, updateConfig: vi.fn(), emitEvent: vi.fn(),
    getSessionManifest: () => ({ ownerAgentId: 'hana', lifecycle: 'active',
      currentLocator: { path: path.join(agentDir, 'sessions', 'session.jsonl') } }),
    getSessionMemoryScope: () => memoryScope,
  };
  const app = new Hono();
  app.route('/api', createAgentsRoute(engine));
  return { agentDir, engine, app };
}
const legacyPrivateScopes = [
  normalizeMemoryScope({ realm: 'legacy', knowledge: 'author' }, 'hana'),
  normalizeMemoryScope({ realm: 'legacy', knowledge: 'character', characterId: 'alice' }, 'hana'),
];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));

describe('scoped pinned memory', () => {
  it('isolates worlds, branches, agents, author knowledge and legacy during actual prompt rendering', () => {
    const { agentDir } = fixture();
    addPinnedMemoryItem(agentDir, 'legacy');
    addPinnedMemoryItem(agentDir, 'A shared', { memoryScope: scope() });
    addPinnedMemoryItem(agentDir, 'unverifiable derived', { memoryScope: scope(), origin: 'derived', sourceStatus: 'active' });
    addPinnedMemoryItem(agentDir, 'B event', { memoryScope: scope('b') });
    addPinnedMemoryItem(agentDir, 'other world', { memoryScope: scope('a', { worldId: 'other' }) });
    addPinnedMemoryItem(agentDir, 'character secret', { memoryScope: scope('a', { knowledge: 'character', characterId: 'alice' }) });
    addPinnedMemoryItem(agentDir, 'author only', { memoryScope: scope('a', { knowledge: 'author' }) });
    expect(readPinnedMemoryForContext(agentDir, scope())).toBe('- A shared\n');
    expect(readPinnedMemoryForContext(agentDir, { ...scope(), characterId: 'alice' })).toContain('character secret');
    expect(readPinnedMemoryForContext(agentDir, { ...scope(), viewpoint: 'author' })).toContain('author only');
    expect(readPinnedMemoryForContext(agentDir, { ...scope(), agentId: 'other' })).toBe('');
    expect(fs.readFileSync(path.join(agentDir, 'pinned.md'), 'utf8')).toBe('- legacy\n');
  });

  it('invalidates only source-derived story pins, preserving manual and real-world history after reload', () => {
    const { agentDir } = fixture();
    const provenance = { sourceDependencies: [{ sessionId: 'session-a', revision: 'r1', hash: 'a'.repeat(64), type: 'source', generation: 1 }], sourceStatus: 'active' };
    addPinnedMemoryItem(agentDir, 'derived A', { ...provenance, origin: 'derived', memoryScope: scope() });
    addPinnedMemoryItem(agentDir, 'manual A', { ...provenance, origin: 'manual', memoryScope: scope() });
    addPinnedMemoryItem(agentDir, 'derived B', { ...provenance, sourceDependencies: [{ sessionId: 'session-b' }], origin: 'derived', memoryScope: scope() });
    const reality = normalizeMemoryScope({ agentId: 'hana', realm: 'reality' });
    addPinnedMemoryItem(agentDir, 'real result', { ...provenance, origin: 'derived', memoryScope: reality });
    expect(invalidatePinnedMemoryBySession(agentDir, 'session-a')).toBe(1);
    expect(readPinnedMemoryForContext(agentDir, scope())).toBe('- manual A\n- derived B\n');
    expect(readPinnedMemoryForContext(agentDir, reality)).toBe('- real result\n');
    expect(readPinnedMemoryItems(agentDir).find(item => item.content === 'derived A')).toMatchObject({ sourceStatus: 'stale', sourceDependencies: provenance.sourceDependencies });
  });

  it('retains independent B from the same session while retracting A by original-message hash', () => {
    const { agentDir } = fixture();
    const a = { entryId: 'a', role: 'assistant', content: 'A happened', timestamp: null };
    const b = { entryId: 'b', role: 'user', content: 'B happened', timestamp: null };
    const aHash = hashScopedSourceMessage(a), bHash = hashScopedSourceMessage(b);
    addPinnedMemoryItem(agentDir, 'derived A', { memoryScope: scope(), origin: 'derived', sourceStatus: 'active', sourceDependencies: [{ sessionId: 's1', entryId: 'a', hash: aHash, revision: aHash }] });
    addPinnedMemoryItem(agentDir, 'derived B', { memoryScope: scope(), origin: 'derived', sourceStatus: 'active', sourceDependencies: [{ sessionId: 's1', sourceRefs: [{ entryId: 'b', hash: bHash }] }] });
    expect(invalidatePinnedMemoryBySession(agentDir, 's1', { sourceMessages: [b] })).toBe(1);
    expect(readPinnedMemoryForContext(agentDir, scope())).toBe('- derived B\n');
    expect(invalidatePinnedMemoryBySession(agentDir, 's1', { sourceMessages: [{ ...b, content: 'B was edited' }] })).toBe(1);
    expect(readPinnedMemoryForContext(agentDir, scope())).toBe('');
  });

  it('keeps identical content in independent scopes and preserves scoped metadata on legacy settings and markdown edits', () => {
    const { agentDir } = fixture();
    addPinnedMemoryItem(agentDir, 'same');
    const added = addPinnedMemoryItem(agentDir, 'same', { memoryScope: scope() }).item;
    expect(addPinnedMemoryItem(agentDir, 'same', { memoryScope: scope() }).alreadyExists).toBe(true);
    replacePinnedMemoryItems(agentDir, ['legacy edit']);
    expect(readPinnedMemoryItems(agentDir).find(item => item.id === added.id)?.memoryScope).toEqual(scope());
    fs.writeFileSync(path.join(agentDir, 'pinned.md'), '- external edit\n');
    const future = new Date(Date.now() + 2000);
    fs.utimesSync(path.join(agentDir, 'pinned.md'), future, future);
    expect(readPinnedMemoryItems(agentDir).map(item => item.content)).toEqual(['external edit', 'same']);
  });

  it('legacy replacement keeps identical content and metadata separate across knowledge scopes', () => {
    const { agentDir } = fixture();
    const author = addPinnedMemoryItem(agentDir, 'same', { memoryScope: { realm: 'legacy', knowledge: 'author' } }).item;
    const legacy = addPinnedMemoryItem(agentDir, 'same').item;
    replacePinnedMemoryItems(agentDir, ['same', 'new legacy']);
    const items = readPinnedMemoryItems(agentDir);
    expect(items).toHaveLength(3);
    expect(items.find(item => item.id === author.id)).toEqual(author);
    expect(items.find(item => item.id === legacy.id)).toEqual(legacy);
    expect(items.filter(item => sameMemoryScope(item.memoryScope, normalizeMemoryScope(undefined, 'hana'))).map(item => item.content))
      .toEqual(['same', 'new legacy']);
  });

  it('explicit manual confirmation upgrades an identical derived pin without losing provenance', () => {
    const { agentDir } = fixture();
    const provenance = { memoryScope: scope(), origin: 'derived' as const, sourceDependencies: [{ sessionId: 's1' }], sourceStatus: 'active' };
    const original = addPinnedMemoryItem(agentDir, 'remember', provenance).item;
    expect(addPinnedMemoryItem(agentDir, 'remember', { memoryScope: scope(), origin: 'manual' }).alreadyExists).toBe(true);
    expect(invalidatePinnedMemoryBySession(agentDir, 's1')).toBe(0);
    expect(readPinnedMemoryItems(agentDir)).toMatchObject([{ id: original.id, origin: 'manual', sourceDependencies: provenance.sourceDependencies }]);
  });

  it('runtime pin/unpin cannot change another branch by id or substring', async () => {
    const { agentDir } = fixture();
    let current = scope();
    const [pin, unpin] = createPinnedMemoryTools(agentDir, 'hana', { getMemoryScope: () => current });
    const result = await pin.execute('pin-a', { content: 'shared phrase' });
    current = scope('b');
    await pin.execute('pin-b', { content: 'shared phrase' });
    await unpin.execute('unpin-a-from-b', { id: (result.details as { item: { id: string } }).item.id });
    expect(readPinnedMemoryItems(agentDir)).toHaveLength(2);
    await unpin.execute('unpin-b', { keyword: 'shared phrase' });
    expect(readPinnedMemoryItems(agentDir)).toHaveLength(1);
    expect(readPinnedMemoryForContext(agentDir, scope())).toBe('- shared phrase\n');
  });

  it('saves pins from the settings snapshot without conflicting with or rewriting scoped pins', async () => {
    const { root, agentDir } = fixture();
    addPinnedMemoryItem(agentDir, 'legacy');
    addPinnedMemoryItem(agentDir, 'story author secret', { memoryScope: scope('a', { knowledge: 'author' }), origin: 'derived', sourceDependencies: [{ sessionId: 's1' }], sourceStatus: 'active' });
    addPinnedMemoryItem(agentDir, 'reality pin', { memoryScope: { realm: 'reality' } });
    addPinnedMemoryItem(agentDir, 'legacy author secret', { memoryScope: { realm: 'legacy', knowledge: 'author' } });
    addPinnedMemoryItem(agentDir, 'legacy character secret', { memoryScope: { realm: 'legacy', knowledge: 'character', characterId: 'alice' } });
    const defaultScope = normalizeMemoryScope(undefined, 'hana');
    const protectedBefore = readPinnedMemoryItems(agentDir).filter(item => !sameMemoryScope(item.memoryScope, defaultScope));
    const engine = { agentsDir: root, userDir: root, productDir: root, updateConfig: vi.fn(), emitEvent: vi.fn() };
    const app = new Hono();
    app.route('/api', createSettingsSnapshotRoute(engine));
    app.route('/api', createAgentsRoute(engine));
    const snapshotResponse = await app.request('/api/settings/snapshot?agentId=hana');
    expect(snapshotResponse.status).toBe(200);
    const snapshot = await snapshotResponse.json();
    const pinned = await (await app.request('/api/agents/hana/pinned')).json();
    expect(snapshot.pinned.pins).toEqual(pinned.pins);
    const response = await app.request('/api/agents/hana/pinned', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pins: [...snapshot.pinned.pins, 'new legacy'], expectedPins: snapshot.pinned.pins }),
    });
    expect(response.status).toBe(200);
    expect((await (await app.request('/api/agents/hana/pinned')).json()).pins).toEqual(['legacy', 'new legacy']);
    expect(readPinnedMemoryItems(agentDir).filter(item => !sameMemoryScope(item.memoryScope, defaultScope))).toEqual(protectedBefore);
  });

  it('server freezes trusted current scope at append and rejects a branch change after GET', async () => {
    const { root, agentDir } = fixture();
    const sessionPath = path.join(agentDir, 'sessions', 'session.jsonl');
    let current = scope();
    const app = new Hono();
    app.route('/api', createAgentsRoute({ agentsDir: root, updateConfig: vi.fn(), emitEvent: vi.fn(),
      getSessionManifest: () => ({ ownerAgentId: 'hana', lifecycle: 'active', currentLocator: { path: sessionPath } }),
      getSessionMemoryScope: () => current,
      openSessionManagerAtCurrentBranch: () => ({ getBranch: () => [] }),
    }));
    const snapshot = await (await app.request('/api/agents/hana/pinned?sessionId=session-a')).json();
    current = scope('b');
    const body = { sessionId: 'session-a', pins: ['candidate A'], expectedPins: snapshot.pins, appendItem: { content: 'candidate A', memoryScope: snapshot.memoryScope } };
    const response = await app.request('/api/agents/hana/pinned', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    expect(response.status).toBe(409);
    expect(readPinnedMemoryItems(agentDir)).toEqual([]);
  });

  it.each(legacyPrivateScopes)('rejects legacy/$knowledge bulk PUT even when its private expectedPins still match', async (memoryScope) => {
    const { agentDir, engine, app } = pinnedRouteFixture(memoryScope);
    addPinnedMemoryItem(agentDir, 'original shared');
    addPinnedMemoryItem(agentDir, 'private pin', { memoryScope });
    const snapshot = await (await app.request('/api/agents/hana/pinned?sessionId=session-a')).json();
    expect(snapshot.pins).toEqual(['private pin']);
    addPinnedMemoryItem(agentDir, 'concurrent shared');
    const before = readPinnedMemoryItems(agentDir);
    const response = await app.request('/api/agents/hana/pinned', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-a', pins: ['replacement private pin'], expectedPins: snapshot.pins }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'scoped pins require structured append' });
    expect(readPinnedMemoryItems(agentDir)).toEqual(before);
    expect((await (await app.request('/api/agents/hana/pinned')).json()).pins).toEqual(['original shared', 'concurrent shared']);
    expect((await (await app.request('/api/agents/hana/pinned?sessionId=session-a')).json()).pins).toEqual(['private pin']);
    expect(engine.updateConfig).not.toHaveBeenCalled();
    expect(engine.emitEvent).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'settings without a session', sessionId: undefined, memoryScope: undefined },
    { label: 'session without scope metadata', sessionId: 'session-a', memoryScope: undefined },
    { label: 'session with plain legacy metadata', sessionId: 'session-a', memoryScope: { realm: 'legacy' } },
  ])('preserves default bulk PUT and CAS for $label', async ({ sessionId, memoryScope }) => {
    const { agentDir, app } = pinnedRouteFixture(memoryScope);
    addPinnedMemoryItem(agentDir, 'original shared');
    for (const privateScope of legacyPrivateScopes) {
      addPinnedMemoryItem(agentDir, `private ${privateScope.knowledge}`, { memoryScope: privateScope });
    }
    const defaultScope = normalizeMemoryScope(undefined, 'hana');
    const protectedBefore = readPinnedMemoryItems(agentDir).filter(item => !sameMemoryScope(item.memoryScope, defaultScope));
    const url = `/api/agents/hana/pinned${sessionId ? `?sessionId=${sessionId}` : ''}`;
    const snapshot = await (await app.request(url)).json();
    expect(snapshot.pins).toEqual(['original shared']);
    const put = (pins, expectedPins) => app.request('/api/agents/hana/pinned', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, pins, expectedPins }),
    });
    expect((await put(['updated shared'], snapshot.pins)).status).toBe(200);
    expect((await (await app.request(url)).json()).pins).toEqual(['updated shared']);
    addPinnedMemoryItem(agentDir, 'concurrent shared');
    const beforeConflict = readPinnedMemoryItems(agentDir);
    const conflict = await put(['stale replacement'], ['updated shared']);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: 'pinned_memory_conflict' });
    expect(readPinnedMemoryItems(agentDir)).toEqual(beforeConflict);
    expect(readPinnedMemoryItems(agentDir).filter(item => !sameMemoryScope(item.memoryScope, defaultScope))).toEqual(protectedBefore);
  });

  it.each(legacyPrivateScopes)('still accepts structured append into the trusted legacy/$knowledge scope', async (memoryScope) => {
    const { agentDir, app } = pinnedRouteFixture(memoryScope);
    addPinnedMemoryItem(agentDir, 'shared pin');
    addPinnedMemoryItem(agentDir, 'private pin', { memoryScope });
    const before = readPinnedMemoryItems(agentDir);
    const snapshot = await (await app.request('/api/agents/hana/pinned?sessionId=session-a')).json();
    const response = await app.request('/api/agents/hana/pinned', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-a', pins: [...snapshot.pins, 'new private pin'], expectedPins: snapshot.pins,
        appendItem: { content: 'new private pin', memoryScope: snapshot.memoryScope } }),
    });
    expect(response.status).toBe(200);
    const after = readPinnedMemoryItems(agentDir);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.at(-1)).toMatchObject({ content: 'new private pin', memoryScope, origin: 'manual' });
    expect((await (await app.request('/api/agents/hana/pinned')).json()).pins).toEqual(['shared pin']);
    expect((await (await app.request('/api/agents/hana/pinned?sessionId=session-a')).json()).pins).toEqual(['private pin', 'new private pin']);
  });
});
