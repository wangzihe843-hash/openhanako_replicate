/** @vitest-environment jsdom */
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureRelationshipState, getRelationshipState, useRelationshipState } from './xingye-state-store';
import {
  flushXingyePersistenceNow,
  getXingyePersistenceStorage,
  refreshXingyeAgentPersistence,
  resetXingyePersistenceForTests,
} from './xingye-persistence';

const backend = vi.hoisted(() => ({ files: new Map<string, unknown>() }));
vi.mock('./xingye-storage-api', () => ({
  postXingyeStorage: vi.fn(async (body: Record<string, unknown>) => {
    const key = `${body.agentId}:${body.relativePath}`;
    if (body.action === 'readJson') return { ok: true, data: backend.files.get(key) ?? null };
    if (body.action === 'writeJson') backend.files.set(key, body.data);
    return { ok: true };
  }),
}));
vi.mock('../stores', () => ({
  useStore: Object.assign(() => null, { getState: () => ({ serverPort: '17333', activeServerConnection: null }) }),
}));

beforeEach(() => {
  backend.files.clear();
  resetXingyePersistenceForTests();
  window.localStorage.clear();
  delete (window as unknown as { __XINGYE_PERSISTENCE_DEV_LOCAL__?: boolean }).__XINGYE_PERSISTENCE_DEV_LOCAL__;
});
afterEach(() => {
  cleanup();
  resetXingyePersistenceForTests();
});

describe('relationship initialization with real persistence binding', () => {
  it('waits for first binding, then persists the loaded profile seed', async () => {
    const profile = { relationshipLabel: '恋人', corruptionSeed: 75 };
    const hook = renderHook(() => useRelationshipState('a', profile));
    expect(hook.result.current).toBeNull();
    expect(getXingyePersistenceStorage()).toBeNull();
    await act(async () => refreshXingyeAgentPersistence('a'));
    expect(hook.result.current).toMatchObject({ agentId: 'a', affection: 90, corruption: 75 });
    await flushXingyePersistenceNow();
    expect(backend.files.get('a:relationship-state.json')).toMatchObject({ a: { affection: 90, corruption: 75 } });
  });

  it('does not seed the next owner into the previous owner binding', async () => {
    await refreshXingyeAgentPersistence('a');
    const profile = { relationshipLabel: '朋友', corruptionSeed: 20 };
    const hook = renderHook(() => useRelationshipState('b', profile));
    expect(hook.result.current).toBeNull();
    expect(getRelationshipState('b')).toBeNull();
    await act(async () => refreshXingyeAgentPersistence('b'));
    expect(hook.result.current).toMatchObject({ agentId: 'b', affection: 30, corruption: 20 });
    await flushXingyePersistenceNow();
    expect(backend.files.has('a:relationship-state.json')).toBe(false);
    expect(backend.files.get('b:relationship-state.json')).toMatchObject({ b: { affection: 30 } });
  });

  it('keeps persisted values when profile changes or persistence emits again', async () => {
    const existing = ensureRelationshipState('a', { relationshipLabel: '朋友', corruptionSeed: 25 }, window.localStorage);
    backend.files.set('a:relationship-state.json', { a: existing });
    const hook = renderHook(({ profile }) => useRelationshipState('a', profile), {
      initialProps: { profile: { relationshipLabel: '恋人', corruptionSeed: 75 } },
    });
    await act(async () => refreshXingyeAgentPersistence('a'));
    expect(hook.result.current).toMatchObject({ affection: 30, corruption: 25 });
    hook.rerender({ profile: { relationshipLabel: '仇敌', corruptionSeed: 100 } });
    act(() => window.dispatchEvent(new Event('xingye-persistence-changed')));
    expect(hook.result.current).toMatchObject({ affection: 30, corruption: 25, updatedAt: existing.updatedAt });
  });
});
