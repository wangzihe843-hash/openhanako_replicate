import { describe, expect, it } from 'vitest';
import { createMemoryXingyeStorageBackend } from './xingye-storage-backend';
import {
  createXingyeStore,
  generateXingyeId,
  nowIso,
  resolveAgentScopedXingyePath,
} from './xingye-store-utils';

describe('xingye-store-utils', () => {
  it('resolves paths inside the agent-scoped xingye root', () => {
    expect(resolveAgentScopedXingyePath('agent-a', 'apps/divination/entries.jsonl')).toEqual({
      agentId: 'agent-a',
      relativePath: 'apps/divination/entries.jsonl',
      scopedPath: 'HANA_HOME/agents/agent-a/xingye/apps/divination/entries.jsonl',
    });
    expect(() => resolveAgentScopedXingyePath('agent-a', '../workspace.json')).toThrow(/relativePath/);
    expect(() => resolveAgentScopedXingyePath('bad agent', 'apps/divination/entries.jsonl')).toThrow(/agentId/);
  });

  it('reads and writes JSON while treating missing files as null', async () => {
    const store = createXingyeStore(createMemoryXingyeStorageBackend());
    await expect(store.readJson<{ ok: true }>('agent-a', 'apps/divination/settings.json')).resolves.toBeNull();
    await store.writeJson('agent-a', 'apps/divination/settings.json', { ok: true });
    await expect(store.readJson('agent-a', 'apps/divination/settings.json')).resolves.toEqual({ ok: true });
  });

  it('lists missing JSONL files as empty and supports append update delete', async () => {
    const store = createXingyeStore(createMemoryXingyeStorageBackend());
    const path = 'apps/divination/entries.jsonl';

    await expect(store.listJsonl('agent-a', path)).resolves.toEqual([]);
    await store.appendJsonl('agent-a', path, { id: 'one', title: 'One' });
    await store.appendJsonl('agent-a', path, { id: 'two', title: 'Two' });

    await expect(store.updateJsonlRecord<{ id: string; title: string }>(
      'agent-a',
      path,
      'one',
      (record) => ({ ...record, title: 'Updated' }),
    )).resolves.toEqual({ id: 'one', title: 'Updated' });

    await expect(store.deleteJsonlRecord('agent-a', path, 'two')).resolves.toBe(true);
    await expect(store.listJsonl('agent-a', path)).resolves.toEqual([{ id: 'one', title: 'Updated' }]);
  });

  it('provides ids and ISO timestamps for app records', () => {
    expect(generateXingyeId('app')).toMatch(/^app-/);
    expect(nowIso(new Date('2026-05-14T06:30:00.000Z'))).toBe('2026-05-14T06:30:00.000Z');
  });
});
