/**
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  flushXingyePersistenceNow,
  getXingyePersistenceStorage,
  refreshXingyeAgentPersistence,
  resetXingyePersistenceForTests,
} from './xingye-persistence';
import { postXingyeStorage } from './xingye-storage-api';

const hoisted = vi.hoisted(() => ({
  files: new Map<string, unknown>(),
  mockConnection: {
    serverId: 'local',
    spaceId: 'local',
    label: 'test',
    baseUrl: 'http://127.0.0.1:17333',
    wsUrl: 'ws://127.0.0.1:17333',
    token: null,
    authState: 'paired' as const,
    trustState: 'local' as const,
    capabilities: ['chat'],
  },
}));

vi.mock('./xingye-storage-api', () => ({
  postXingyeStorage: vi.fn(async (body: Record<string, unknown>) => {
    if (typeof body.agentId !== 'string' || !body.agentId) {
      throw new Error('agentId is required');
    }
    const key = `${body.agentId}:${body.relativePath}`;
    if (body.action === 'readJson') {
      return hoisted.files.has(key)
        ? { ok: true, data: hoisted.files.get(key) }
        : { ok: true, missing: true, data: null };
    }
    if (body.action === 'writeJson') {
      hoisted.files.set(key, body.data);
      return { ok: true };
    }
    return { ok: true };
  }),
}));

vi.mock('../stores', () => ({
  useStore: Object.assign(
    (fn: (s: { activeServerConnection: typeof hoisted.mockConnection | null }) => unknown) =>
      fn({ activeServerConnection: hoisted.mockConnection }),
    {
      getState: () => ({ activeServerConnection: hoisted.mockConnection }),
    },
  ),
}));

describe('xingye-persistence agent scoped storage', () => {
  beforeEach(() => {
    hoisted.files.clear();
    resetXingyePersistenceForTests();
    vi.mocked(postXingyeStorage).mockClear();
    delete (window as unknown as { __XINGYE_PERSISTENCE_DEV_LOCAL__?: boolean }).__XINGYE_PERSISTENCE_DEV_LOCAL__;
    delete (window as unknown as { __XINGYE_ALLOW_LEGACY_LOCAL_MIGRATE__?: boolean }).__XINGYE_ALLOW_LEGACY_LOCAL_MIGRATE__;
    window.localStorage.clear();
  });

  it('keeps agent data isolated and reloads it after persistence refresh', async () => {
    await refreshXingyeAgentPersistence('agent-a');
    const storageA = getXingyePersistenceStorage();
    expect(storageA).not.toBeNull();
    storageA?.setItem(
      'xingye.phoneContacts',
      JSON.stringify({
        'agent-a::agent::peer': {
          ownerAgentId: 'agent-a',
          targetType: 'agent',
          targetId: 'peer',
          remark: 'agent a note',
          updatedAt: '2026-05-13T00:00:00.000Z',
        },
      }),
    );
    await flushXingyePersistenceNow();

    await refreshXingyeAgentPersistence('agent-b');
    expect(getXingyePersistenceStorage()?.getItem('xingye.phoneContacts')).toBeNull();

    resetXingyePersistenceForTests();
    await refreshXingyeAgentPersistence('agent-a');
    const reloaded = JSON.parse(getXingyePersistenceStorage()?.getItem('xingye.phoneContacts') ?? '{}');
    expect(reloaded['agent-a::agent::peer'].remark).toBe('agent a note');
  });

  it('flushes a pending edit to the current agent before switching, with no wipe/cross-pollution (fast edit-then-switch race)', async () => {
    await refreshXingyeAgentPersistence('agent-a');
    // Edit agent-a's contacts but do NOT flush — this leaves a debounced flush
    // pending (the 450ms timer). Switching agents before it fires is the race.
    getXingyePersistenceStorage()?.setItem(
      'xingye.phoneContacts',
      JSON.stringify({
        'agent-a::agent::peer': {
          ownerAgentId: 'agent-a',
          targetType: 'agent',
          targetId: 'peer',
          remark: 'pending edit',
          updatedAt: '2026-06-02T00:00:00.000Z',
        },
      }),
    );

    // Switch to agent-b BEFORE the debounce fires. The pending edit must be
    // flushed to agent-a (not lost, not written into agent-b's file).
    await refreshXingyeAgentPersistence('agent-b');

    // agent-a's pending edit was persisted to agent-a's own file.
    resetXingyePersistenceForTests();
    await refreshXingyeAgentPersistence('agent-a');
    const reloadedA = JSON.parse(getXingyePersistenceStorage()?.getItem('xingye.phoneContacts') ?? '{}');
    expect(reloadedA['agent-a::agent::peer']?.remark).toBe('pending edit');

    // agent-b's file was never touched by agent-a's edit (no cross-pollution / no {} wipe).
    resetXingyePersistenceForTests();
    await refreshXingyeAgentPersistence('agent-b');
    expect(getXingyePersistenceStorage()?.getItem('xingye.phoneContacts')).toBeNull();
  });

  it('flushes a pending edit before entering disabled state (agentId -> null), so the edit is not lost', async () => {
    await refreshXingyeAgentPersistence('agent-a');
    // Arm a debounced pending edit for agent-a; do NOT flush (450ms timer still pending).
    getXingyePersistenceStorage()?.setItem(
      'xingye.phoneContacts',
      JSON.stringify({
        'agent-a::agent::peer': {
          ownerAgentId: 'agent-a',
          targetType: 'agent',
          targetId: 'peer',
          remark: 'pending before disable',
          updatedAt: '2026-06-03T00:00:00.000Z',
        },
      }),
    );

    // Enter disabled state (e.g. selected agent deleted / agents list momentarily empty).
    // The pending edit must be flushed to agent-a BEFORE memory is cleared, not silently dropped.
    await refreshXingyeAgentPersistence('');

    // agent-a's pending edit survived the transition to disabled.
    resetXingyePersistenceForTests();
    await refreshXingyeAgentPersistence('agent-a');
    const reloadedA = JSON.parse(getXingyePersistenceStorage()?.getItem('xingye.phoneContacts') ?? '{}');
    expect(reloadedA['agent-a::agent::peer']?.remark).toBe('pending before disable');
  });

  it('does not expose formal business storage without an explicit agent id', async () => {
    await refreshXingyeAgentPersistence('');
    expect(getXingyePersistenceStorage()).toBeNull();
    expect(vi.mocked(postXingyeStorage)).not.toHaveBeenCalled();
  });
});
