import { describe, expect, it } from 'vitest';
import { createMemoryXingyeStorageBackend } from './xingye-storage-backend';
import {
  createDivinationEntryApi,
  createXingyeAppEntryStore,
  getDivinationEntryAgentTopic,
  resolveDivinationEntriesScopedPath,
  xingyeAppEntriesPath,
  type AppEntry,
} from './xingye-app-entry-store';

describe('xingye-app-entry-store', () => {
  it('stores simple app entries at apps/{appId}/entries.jsonl', async () => {
    const backend = createMemoryXingyeStorageBackend();
    const store = createXingyeAppEntryStore(backend, {
      idFactory: () => 'entry-1',
      now: () => '2026-05-14T06:30:00.000Z',
    });

    const entry = await store.appendEntry('agent-a', 'divination', {
      title: 'Morning draw',
      content: 'The tower, interpreted as a warning.',
      metadata: { deck: 'tarot' },
      source: 'manual',
    });

    expect(xingyeAppEntriesPath('divination')).toBe('apps/divination/entries.jsonl');
    expect(entry).toMatchObject({
      id: 'entry-1',
      agentId: 'agent-a',
      appId: 'divination',
      title: 'Morning draw',
      content: 'The tower, interpreted as a warning.',
      metadata: { deck: 'tarot' },
      source: 'manual',
      createdAt: '2026-05-14T06:30:00.000Z',
      updatedAt: '2026-05-14T06:30:00.000Z',
    });
    await expect(backend.listJsonl<AppEntry>('agent-a', 'apps/divination/entries.jsonl')).resolves.toEqual([entry]);
  });

  it('returns an empty list for a missing app entry file', async () => {
    const store = createXingyeAppEntryStore(createMemoryXingyeStorageBackend());
    await expect(store.listEntries('agent-a', 'shopping')).resolves.toEqual([]);
  });

  it('backdates createdAt/updatedAt when input.createdAt is a valid ISO (历史批量场景)', async () => {
    const store = createXingyeAppEntryStore(createMemoryXingyeStorageBackend(), {
      idFactory: () => 'entry-1',
      now: () => '2026-05-26T10:00:00.000Z',
    });

    const entry = await store.appendEntry('agent-a', 'shopping', {
      title: '旧台灯',
      content: '在巷口杂货店看到的，挺合我的口味。',
      metadata: { status: 'received', platformStyle: 'generic', itemName: '旧台灯' },
      source: 'xingye-shopping-init-history',
      createdAt: '2026-05-19T00:00:00.000Z',
    });

    expect(entry.createdAt).toBe('2026-05-19T00:00:00.000Z');
    expect(entry.updatedAt).toBe('2026-05-19T00:00:00.000Z');
  });

  it('falls back to now when input.createdAt is invalid or missing', async () => {
    const store = createXingyeAppEntryStore(createMemoryXingyeStorageBackend(), {
      idFactory: (() => {
        let n = 0;
        return () => `entry-${++n}`;
      })(),
      now: () => '2026-05-26T10:00:00.000Z',
    });

    const noOverride = await store.appendEntry('agent-a', 'shopping', {
      title: 'a', content: '', metadata: {}, source: 'manual',
    });
    expect(noOverride.createdAt).toBe('2026-05-26T10:00:00.000Z');

    const badIso = await store.appendEntry('agent-a', 'shopping', {
      title: 'b', content: '', metadata: {}, source: 'manual',
      createdAt: 'not-a-date',
    });
    expect(badIso.createdAt).toBe('2026-05-26T10:00:00.000Z');

    const empty = await store.appendEntry('agent-a', 'shopping', {
      title: 'c', content: '', metadata: {}, source: 'manual',
      createdAt: '',
    });
    expect(empty.createdAt).toBe('2026-05-26T10:00:00.000Z');
  });

  it('updates one entry without changing the other entries', async () => {
    const store = createXingyeAppEntryStore(createMemoryXingyeStorageBackend(), {
      idFactory: (() => {
        const ids = ['entry-1', 'entry-2'];
        return () => ids.shift() ?? 'entry-x';
      })(),
      now: (() => {
        const times = [
          '2026-05-14T06:30:00.000Z',
          '2026-05-14T06:31:00.000Z',
          '2026-05-14T06:32:00.000Z',
        ];
        return () => times.shift() ?? '2026-05-14T06:33:00.000Z';
      })(),
    });

    await store.appendEntry('agent-a', 'reading_notes', { title: 'A', content: 'first' });
    await store.appendEntry('agent-a', 'reading_notes', { title: 'B', content: 'second' });

    await expect(store.updateEntry('agent-a', 'reading_notes', 'entry-1', {
      content: 'first revised',
      metadata: { page: 42 },
    })).resolves.toMatchObject({
      id: 'entry-1',
      title: 'A',
      content: 'first revised',
      metadata: { page: 42 },
      updatedAt: '2026-05-14T06:32:00.000Z',
    });

    await expect(store.listEntries('agent-a', 'reading_notes')).resolves.toEqual([
      expect.objectContaining({ id: 'entry-1', content: 'first revised' }),
      expect.objectContaining({ id: 'entry-2', content: 'second' }),
    ]);
  });

  it('deletes only the selected entry', async () => {
    const store = createXingyeAppEntryStore(createMemoryXingyeStorageBackend(), {
      idFactory: (() => {
        const ids = ['entry-1', 'entry-2'];
        return () => ids.shift() ?? 'entry-x';
      })(),
    });

    await store.appendEntry('agent-a', 'shopping', { title: 'Stationery', content: 'Bought pens in-world.' });
    await store.appendEntry('agent-a', 'shopping', { title: 'Tea', content: 'Logged a simulated tea order.' });

    await expect(store.deleteEntry('agent-a', 'shopping', 'entry-1')).resolves.toBe(true);
    await expect(store.listEntries('agent-a', 'shopping')).resolves.toEqual([
      expect.objectContaining({ id: 'entry-2', title: 'Tea' }),
    ]);
  });

  it('keeps appId and agentId scopes isolated', async () => {
    const store = createXingyeAppEntryStore(createMemoryXingyeStorageBackend(), {
      idFactory: (() => {
        let n = 0;
        return () => `entry-${++n}`;
      })(),
    });

    await store.appendEntry('agent-a', 'divination', { title: 'A divination', content: 'A' });
    await store.appendEntry('agent-a', 'shopping', { title: 'A shopping', content: 'B' });
    await store.appendEntry('agent-b', 'divination', { title: 'B divination', content: 'C' });

    await expect(store.listEntries('agent-a', 'divination')).resolves.toEqual([
      expect.objectContaining({ agentId: 'agent-a', appId: 'divination', title: 'A divination' }),
    ]);
    await expect(store.listEntries('agent-a', 'shopping')).resolves.toEqual([
      expect.objectContaining({ agentId: 'agent-a', appId: 'shopping', title: 'A shopping' }),
    ]);
    await expect(store.listEntries('agent-b', 'divination')).resolves.toEqual([
      expect.objectContaining({ agentId: 'agent-b', appId: 'divination', title: 'B divination' }),
    ]);
  });

  it('does not put complex apps into the unified AppEntry store', async () => {
    const store = createXingyeAppEntryStore(createMemoryXingyeStorageBackend());
    await expect(store.appendEntry('agent-a', 'mail', { title: 'Nope', content: 'complex app' })).rejects.toThrow(/appId/);
    await expect(store.appendEntry('agent-a', 'files', { title: 'Nope', content: 'complex app' })).rejects.toThrow(/appId/);
  });

  it('exposes divination JSONL under HANA_HOME-scoped path apps/divination/entries.jsonl', () => {
    expect(resolveDivinationEntriesScopedPath('agent-a')).toEqual({
      agentId: 'agent-a',
      relativePath: 'apps/divination/entries.jsonl',
      scopedPath: 'HANA_HOME/agents/agent-a/xingye/apps/divination/entries.jsonl',
    });
  });

  it('divination API appends, lists, and deletes with normalized metadata', async () => {
    const backend = createMemoryXingyeStorageBackend();
    const store = createXingyeAppEntryStore(backend, {
      idFactory: (() => {
        const ids = ['div-1', 'div-2'];
        return () => ids.shift() ?? 'div-x';
      })(),
      now: () => '2026-05-14T07:00:00.000Z',
    });
    const div = createDivinationEntryApi(store);

    const first = await div.appendDivinationEntry('agent-a', {
      title: 'Draw 1',
      content: 'Reading text',
      metadata: {
        method: 'iching',
        methodLabel: 'I Ching',
        question: 'Will it rain?',
        symbols: [{ line: 1 }, 'second'],
        autoSelected: true,
        resolverReason: 'user asked for weather',
      },
    });

    expect(first).toMatchObject({
      id: 'div-1',
      agentId: 'agent-a',
      appId: 'divination',
      title: 'Draw 1',
      content: 'Reading text',
      source: 'divination',
      metadata: {
        method: 'iching',
        methodLabel: 'I Ching',
        question: 'Will it rain?',
        agentQuestion: 'Will it rain?',
        symbols: [{ line: 1 }, 'second'],
        autoSelected: true,
        resolverReason: 'user asked for weather',
      },
      createdAt: '2026-05-14T07:00:00.000Z',
      updatedAt: '2026-05-14T07:00:00.000Z',
    });

    await div.appendDivinationEntry('agent-a', {
      title: 'Draw 2',
      content: 'Another',
      metadata: { question: 'Only question set' },
    });

    const listed = await div.loadDivinationEntries('agent-a');
    expect(listed).toHaveLength(2);
    expect(listed[1].metadata).toEqual({
      method: '',
      methodLabel: '',
      question: 'Only question set',
      agentQuestion: 'Only question set',
      symbols: [],
      autoSelected: false,
      resolverReason: '',
    });

    await expect(div.deleteDivinationEntry('agent-a', 'div-1')).resolves.toBe(true);
    await expect(div.loadDivinationEntries('agent-a')).resolves.toEqual([
      expect.objectContaining({ id: 'div-2', title: 'Draw 2' }),
    ]);
  });

  it('divination metadata roundtrip: agentQuestion, userProvidedTheme, contextSummary', async () => {
    const backend = createMemoryXingyeStorageBackend();
    const store = createXingyeAppEntryStore(backend, {
      idFactory: () => 'div-theme',
      now: () => '2026-05-14T09:00:00.000Z',
    });
    const div = createDivinationEntryApi(store);
    await div.appendDivinationEntry('agent-a', {
      title: 'T',
      content: 'C',
      metadata: {
        method: 'field_oracle',
        methodLabel: '战地',
        agentQuestion: '我想确认补给线',
        question: '我想确认补给线',
        userProvidedTheme: '只是注脚',
        contextSummary: 'xingye.profile.json',
        symbols: [],
        autoSelected: true,
        resolverReason: 'r',
      },
    });
    const listed = await div.loadDivinationEntries('agent-a');
    expect(listed[0].metadata.agentQuestion).toBe('我想确认补给线');
    expect(listed[0].metadata.userProvidedTheme).toBe('只是注脚');
    expect(listed[0].metadata.contextSummary).toBe('xingye.profile.json');
  });

  it('getDivinationEntryAgentTopic falls back to legacy question', () => {
    expect(
      getDivinationEntryAgentTopic({
        method: '',
        methodLabel: '',
        question: '旧字段只有 question',
        agentQuestion: '',
        symbols: [],
        autoSelected: false,
        resolverReason: '',
      }),
    ).toBe('旧字段只有 question');
  });
});
