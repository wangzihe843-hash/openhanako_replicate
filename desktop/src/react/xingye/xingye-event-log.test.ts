import { beforeEach, describe, expect, it, vi } from 'vitest';

const jsonStore = vi.hoisted(() => new Map<string, unknown>());
const postMock = vi.hoisted(() => vi.fn(async (body: Record<string, unknown>) => {
  const agentId = typeof body.agentId === 'string' ? body.agentId : '';
  const relativePath = typeof body.relativePath === 'string' ? body.relativePath : '';
  const key = `${agentId}|${relativePath}`;
  if (body.action === 'readJson') {
    return { ok: true, data: jsonStore.get(key) ?? null };
  }
  if (body.action === 'writeJson') {
    jsonStore.set(key, body.data);
    return { ok: true };
  }
  throw new Error(`unexpected action: ${String(body.action)}`);
}));

vi.mock('./xingye-storage-api', () => ({
  postXingyeStorage: postMock,
}));

import {
  appendXingyeEvent,
  appendXingyeEventOnce,
  createXingyeEvent,
  listUnconsumedXingyeEvents,
  listXingyeEvents,
  makeXingyeEventDedupeKey,
  markXingyeEventConsumed,
  normalizeXingyeEvent,
} from './xingye-event-log';

describe('xingye-event-log', () => {
  beforeEach(() => {
    jsonStore.clear();
    postMock.mockClear();
  });

  it('normalizeXingyeEvent rejects missing agentId, missing type, and non-object payload', () => {
    expect(normalizeXingyeEvent({ type: 'moment.created', payload: {} })).toBeNull();
    expect(normalizeXingyeEvent({ agentId: 'a1', payload: {} })).toBeNull();
    expect(normalizeXingyeEvent({ agentId: 'a1', type: 'moment.created', payload: 'bad' })).toBeNull();
  });

  it('appendXingyeEvent writes and listXingyeEvents reads sorted by createdAt ascending', async () => {
    await appendXingyeEvent('a1', {
      type: 'moment.created',
      source: 'test',
      createdAt: '2026-01-02T00:00:00.000Z',
      payload: { id: 'newer' },
    });
    await appendXingyeEvent('a1', {
      type: 'moment.deleted',
      source: 'test',
      createdAt: '2026-01-01T00:00:00.000Z',
      payload: { id: 'older' },
    });

    const events = await listXingyeEvents('a1');
    expect(events.map((event) => event.payload.id)).toEqual(['older', 'newer']);
  });

  it('appendXingyeEventOnce does not append duplicate agentId + dedupeKey', async () => {
    const input = {
      type: 'secret_space.record_appended' as const,
      source: 'test',
      subjectId: 'dream-1',
      payload: { category: 'dream', recordId: 'dream-1' },
    };
    const dedupeKey = makeXingyeEventDedupeKey(input);

    const first = await appendXingyeEventOnce('a1', input, dedupeKey);
    const second = await appendXingyeEventOnce('a1', input, dedupeKey);

    expect(second.id).toBe(first.id);
    expect(await listXingyeEvents('a1')).toHaveLength(1);
  });

  it('markXingyeEventConsumed only marks the specified consumer', async () => {
    const event = await appendXingyeEvent('a1', {
      type: 'moment.created',
      source: 'test',
      payload: { id: 'm1' },
    });

    await markXingyeEventConsumed('a1', event.id, 'heartbeat');
    const [stored] = await listXingyeEvents('a1');

    expect(Object.keys(stored.consumedBy ?? {})).toEqual(['heartbeat']);
    expect(stored.consumedBy?.heartbeat).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(stored.consumedBy?.moments).toBeUndefined();
  });

  it('listUnconsumedXingyeEvents is independent per consumer', async () => {
    const event = await appendXingyeEvent('a1', {
      type: 'moment.created',
      source: 'test',
      payload: { id: 'm1' },
    });
    await markXingyeEventConsumed('a1', event.id, 'heartbeat');

    expect(await listUnconsumedXingyeEvents('a1', 'heartbeat')).toHaveLength(0);
    expect(await listUnconsumedXingyeEvents('a1', 'moments')).toHaveLength(1);
  });

  it('keeps different agents isolated', async () => {
    await appendXingyeEvent('agent-a', {
      type: 'moment.created',
      source: 'test',
      payload: { id: 'a-only' },
    });
    await appendXingyeEvent('agent-b', {
      type: 'moment.created',
      source: 'test',
      payload: { id: 'b-only' },
    });

    expect((await listXingyeEvents('agent-a')).map((event) => event.agentId)).toEqual(['agent-a']);
    expect((await listXingyeEvents('agent-b')).map((event) => event.agentId)).toEqual(['agent-b']);
  });

  it('createXingyeEvent fills id and createdAt defaults', () => {
    const event = createXingyeEvent({
      agentId: 'a1',
      type: 'memory_candidate.created',
      source: 'test',
      payload: {},
    });

    expect(event.id).toBeTruthy();
    expect(event.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
