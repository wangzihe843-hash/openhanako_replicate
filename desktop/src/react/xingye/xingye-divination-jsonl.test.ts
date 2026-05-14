import { describe, expect, it } from 'vitest';
import { createMemoryXingyeStorageBackend } from './xingye-storage-backend';
import {
  XINGYE_DIVINATION_APP_ID,
  createXingyeAppEntryStore,
  resolveDivinationEntriesScopedPath,
  xingyeAppEntriesPath,
} from './xingye-app-entry-store';

describe('xingye divination JSONL (MVP store)', () => {
  it('append + list by agent + divination appId uses apps/divination/entries.jsonl', async () => {
    const backend = createMemoryXingyeStorageBackend();
    const store = createXingyeAppEntryStore(backend, {
      idFactory: (() => {
        const ids = ['div-1', 'div-2'];
        return () => ids.shift() ?? 'div-x';
      })(),
      now: () => '2026-05-14T08:00:00.000Z',
    });

    await store.appendEntry('agent-a', XINGYE_DIVINATION_APP_ID, {
      title: '晨问',
      content: '叙事结果 A',
      metadata: { method: 'iching_liuyao', resolverReason: '国风' },
    });
    await store.appendEntry('agent-a', XINGYE_DIVINATION_APP_ID, {
      title: '夜问',
      content: '叙事结果 B',
    });

    expect(xingyeAppEntriesPath(XINGYE_DIVINATION_APP_ID)).toBe('apps/divination/entries.jsonl');
    expect(resolveDivinationEntriesScopedPath('agent-a').relativePath).toBe('apps/divination/entries.jsonl');

    const rows = await store.listEntries('agent-a', XINGYE_DIVINATION_APP_ID);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.id)).toEqual(['div-1', 'div-2']);
    expect(rows.every((r) => r.appId === 'divination' && r.agentId === 'agent-a')).toBe(true);
  });

  it('deleteEntry removes one id and keeps others for divination', async () => {
    const store = createXingyeAppEntryStore(createMemoryXingyeStorageBackend(), {
      idFactory: (() => {
        const ids = ['div-1', 'div-2', 'div-3'];
        return () => ids.shift() ?? 'div-x';
      })(),
    });

    await store.appendEntry('agent-a', XINGYE_DIVINATION_APP_ID, { title: '1', content: 'a' });
    await store.appendEntry('agent-a', XINGYE_DIVINATION_APP_ID, { title: '2', content: 'b' });
    await store.appendEntry('agent-a', XINGYE_DIVINATION_APP_ID, { title: '3', content: 'c' });

    await expect(store.deleteEntry('agent-a', XINGYE_DIVINATION_APP_ID, 'div-2')).resolves.toBe(true);
    await expect(store.listEntries('agent-a', XINGYE_DIVINATION_APP_ID)).resolves.toEqual([
      expect.objectContaining({ id: 'div-1', title: '1' }),
      expect.objectContaining({ id: 'div-3', title: '3' }),
    ]);
  });

  it('does not leak divination rows across agents A and B', async () => {
    const store = createXingyeAppEntryStore(createMemoryXingyeStorageBackend(), {
      idFactory: (() => {
        let n = 0;
        return () => `div-${++n}`;
      })(),
    });

    await store.appendEntry('agent-a', XINGYE_DIVINATION_APP_ID, { title: 'A-only', content: 'x' });
    await store.appendEntry('agent-b', XINGYE_DIVINATION_APP_ID, { title: 'B-only', content: 'y' });

    await expect(store.listEntries('agent-a', XINGYE_DIVINATION_APP_ID)).resolves.toEqual([
      expect.objectContaining({ agentId: 'agent-a', title: 'A-only' }),
    ]);
    await expect(store.listEntries('agent-b', XINGYE_DIVINATION_APP_ID)).resolves.toEqual([
      expect.objectContaining({ agentId: 'agent-b', title: 'B-only' }),
    ]);
  });
});
