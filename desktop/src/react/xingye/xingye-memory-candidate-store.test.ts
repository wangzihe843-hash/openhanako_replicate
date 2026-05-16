/**
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OPENHANAKO_AGENT_PINNED_MEMORY_CHANGED } from '../agent-pinned-memory';
import * as XingyeMemoryCandidateStore from './xingye-memory-candidate-store';
import {
  confirmXingyeMemoryCandidate,
  confirmXingyeMemoryCandidateToPinned,
  createXingyeMemoryCandidate,
  getXingyeMemoryCandidate,
  listXingyeMemoryCandidates,
  loadXingyeMemoryCandidateMap,
  rejectXingyeMemoryCandidate,
  updateXingyeMemoryCandidate,
  XINGYE_MEMORY_CANDIDATES_STORAGE_KEY,
  XINGYE_MEMORY_CANDIDATE_IMPORTANCE_HIGH,
  XINGYE_MEMORY_CANDIDATE_IMPORTANCE_MEDIUM,
} from './xingye-memory-candidate-store';
import { listXingyeEvents } from './xingye-event-log';

vi.mock('../hooks/use-hana-fetch', () => ({
  hanaUrl: (path: string) => path,
  hanaFetch: vi.fn(),
}));

const { hanaFetch } = await import('../hooks/use-hana-fetch');

const eventJsonStore = new Map<string, unknown>();

function eventLogKey(body: Record<string, unknown>): string {
  return `${body.agentId}|${body.relativePath}`;
}

function resetHanaFetchMock(): void {
  vi.mocked(hanaFetch).mockReset();
  vi.mocked(hanaFetch).mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === '/api/xingye/storage') {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const key = eventLogKey(body);
      if (body.action === 'readJson') return { ok: true, json: async () => ({ ok: true, data: eventJsonStore.get(key) ?? null }) } as Response;
      if (body.action === 'writeJson') {
        eventJsonStore.set(key, body.data);
        return { ok: true, json: async () => ({ ok: true }) } as Response;
      }
    }
    return undefined as unknown as Response;
  });
}

function pinnedCalls() {
  return vi.mocked(hanaFetch).mock.calls.filter((call) =>
    typeof call[0] === 'string' && call[0].includes('/pinned'));
}

class MemoryStorage implements Storage {
  private values = new Map<string, string>();

  get length() {
    return this.values.size;
  }

  clear() {
    this.values.clear();
  }

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  key(index: number) {
    return Array.from(this.values.keys())[index] ?? null;
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

describe('xingye-memory-candidate-store pinned confirm', () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
    eventJsonStore.clear();
    resetHanaFetchMock();
  });

  it('GET pinned then PUT with deduped append and marks candidate written', async () => {
    const c = createXingyeMemoryCandidate('agent-1', { content: '  third\nline  ' }, storage);
    expect(c.status).toBe('pending');

    vi.mocked(hanaFetch)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ pins: ['existing', 'new pin'] }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true }),
      } as Response);

    const { candidate, alreadyInPinned } = await confirmXingyeMemoryCandidateToPinned('agent-1', c.id, {
      storage,
      fetchImpl: hanaFetch,
    });

    expect(pinnedCalls()).toHaveLength(2);
    expect(pinnedCalls()[0][0]).toBe('/api/agents/agent-1/pinned');
    expect(pinnedCalls()[1][0]).toBe('/api/agents/agent-1/pinned');
    const putInit = pinnedCalls()[1][1] as RequestInit;
    expect(putInit?.method).toBe('PUT');
    const putBody = JSON.parse(String(putInit?.body));
    expect(putBody.pins).toEqual(['existing', 'new pin', 'third line']);

    expect(candidate.status).toBe('written');
    expect(candidate.writtenAt).toBeTruthy();
    expect(alreadyInPinned).toBe(false);
    expect(getXingyeMemoryCandidate(c.id, storage)?.status).toBe('written');
  });

  it('skips PUT when normalized pin already exists (whitespace-insensitive)', async () => {
    const c = createXingyeMemoryCandidate('agent-1', { content: 'same' }, storage);
    vi.mocked(hanaFetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ pins: ['  same  '] }),
    } as Response);

    const { candidate, alreadyInPinned } = await confirmXingyeMemoryCandidateToPinned('agent-1', c.id, {
      storage,
      fetchImpl: hanaFetch,
    });

    expect(pinnedCalls()).toHaveLength(1);
    expect(candidate.status).toBe('written');
    expect(alreadyInPinned).toBe(true);
  });

  it('rejects fact target without calling fetch', async () => {
    const c = createXingyeMemoryCandidate('agent-1', { content: 'x', target: 'fact' }, storage);
    await expect(
      confirmXingyeMemoryCandidateToPinned('agent-1', c.id, { storage, fetchImpl: hanaFetch }),
    ).rejects.toThrow('fact import disabled');
    expect(hanaFetch).not.toHaveBeenCalled();
  });

  it('rejects longterm target without calling fetch', async () => {
    const c = createXingyeMemoryCandidate('agent-1', { content: 'x', target: 'longterm' }, storage);
    await expect(
      confirmXingyeMemoryCandidateToPinned('agent-1', c.id, { storage, fetchImpl: hanaFetch }),
    ).rejects.toThrow(/longterm is compile output/);
    expect(hanaFetch).not.toHaveBeenCalled();
  });

  it('throws on agentId mismatch', async () => {
    const c = createXingyeMemoryCandidate('agent-1', { content: 'x' }, storage);
    await expect(
      confirmXingyeMemoryCandidateToPinned('wrong-agent', c.id, { storage, fetchImpl: hanaFetch }),
    ).rejects.toThrow(/agent mismatch/);
    expect(hanaFetch).not.toHaveBeenCalled();
  });

  it('second confirm on written candidate throws', async () => {
    const c = createXingyeMemoryCandidate('agent-1', { content: 'once' }, storage);
    vi.mocked(hanaFetch)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ pins: [] }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) } as Response);
    await confirmXingyeMemoryCandidateToPinned('agent-1', c.id, { storage, fetchImpl: hanaFetch });
    vi.mocked(hanaFetch).mockReset();
    await expect(
      confirmXingyeMemoryCandidateToPinned('agent-1', c.id, { storage, fetchImpl: hanaFetch }),
    ).rejects.toThrow(/not pending/);
    expect(hanaFetch).not.toHaveBeenCalled();
  });

  it('second pending candidate with same normalized text skips PUT and sets alreadyInPinned', async () => {
    const first = createXingyeMemoryCandidate('agent-1', { content: 'dup' }, storage);
    vi.mocked(hanaFetch)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ pins: [] }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) } as Response);
    await confirmXingyeMemoryCandidateToPinned('agent-1', first.id, { storage, fetchImpl: hanaFetch });
    resetHanaFetchMock();

    const second = createXingyeMemoryCandidate('agent-1', { content: '  dup  ' }, storage);
    vi.mocked(hanaFetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ pins: ['dup'] }),
    } as Response);

    const { candidate, alreadyInPinned } = await confirmXingyeMemoryCandidateToPinned('agent-1', second.id, {
      storage,
      fetchImpl: hanaFetch,
    });

    expect(pinnedCalls()).toHaveLength(1);
    expect(alreadyInPinned).toBe(true);
    expect(candidate.status).toBe('written');
  });

  it('appends memory_candidate.written event and keeps pinned changed event', async () => {
    const c = createXingyeMemoryCandidate('agent-1', { content: 'event pin' }, storage);
    const pinnedChanged: Array<CustomEvent<{ agentId: string; source: string; pinsCount?: number }>> = [];
    const onPinned = (event: Event) => {
      pinnedChanged.push(event as CustomEvent<{ agentId: string; source: string; pinsCount?: number }>);
    };
    window.addEventListener(OPENHANAKO_AGENT_PINNED_MEMORY_CHANGED, onPinned);

    vi.mocked(hanaFetch).mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/agents/agent-1/pinned') {
        if (init?.method === 'PUT') return { ok: true, json: async () => ({ ok: true }) } as Response;
        return { ok: true, json: async () => ({ pins: ['existing'] }) } as Response;
      }
      if (path === '/api/xingye/storage') {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        const key = `${body.agentId}|${body.relativePath}`;
        if (body.action === 'readJson') return { ok: true, json: async () => ({ ok: true, data: eventJsonStore.get(key) ?? null }) } as Response;
        if (body.action === 'writeJson') {
          eventJsonStore.set(key, body.data);
          return { ok: true, json: async () => ({ ok: true }) } as Response;
        }
      }
      return { ok: false, status: 404, json: async () => ({ error: 'unexpected path' }) } as Response;
    });

    const { candidate, alreadyInPinned } = await confirmXingyeMemoryCandidateToPinned('agent-1', c.id, {
      storage,
      fetchImpl: hanaFetch,
    });

    window.removeEventListener(OPENHANAKO_AGENT_PINNED_MEMORY_CHANGED, onPinned);

    expect(candidate.status).toBe('written');
    expect(alreadyInPinned).toBe(false);
    const events = await listXingyeEvents('agent-1');
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(expect.objectContaining({
      type: 'memory_candidate.written',
      source: 'xingye-secret-space',
      subjectId: c.id,
      payload: expect.objectContaining({
        candidateId: c.id,
        target: 'pinned',
        alreadyInPinned: false,
        pinsCount: 2,
      }),
    }));
    expect(pinnedChanged).toHaveLength(1);
    expect(pinnedChanged[0].detail).toEqual({
      agentId: 'agent-1',
      source: 'xingye-secret-space',
      pinsCount: 2,
    });
  });
});

describe('confirmXingyeMemoryCandidate gateway', () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
    resetHanaFetchMock();
  });

  it('pinned pending succeeds same as toPinned', async () => {
    const c = createXingyeMemoryCandidate('agent-1', { content: 'gw' }, storage);
    vi.mocked(hanaFetch)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ pins: [] }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) } as Response);
    const { candidate, alreadyInPinned } = await confirmXingyeMemoryCandidate('agent-1', c.id, {
      storage,
      fetchImpl: hanaFetch,
    });
    expect(candidate.status).toBe('written');
    expect(alreadyInPinned).toBe(false);
    expect(hanaFetch).toHaveBeenCalled();
  });

  it('fact throws fact import disabled with zero hanaFetch', async () => {
    const c = createXingyeMemoryCandidate('agent-1', { content: 'x', target: 'fact' }, storage);
    await expect(confirmXingyeMemoryCandidate('agent-1', c.id, { storage, fetchImpl: hanaFetch })).rejects.toThrow(
      'fact import disabled',
    );
    expect(hanaFetch).not.toHaveBeenCalled();
  });

  it('longterm throws compile message with zero fetch', async () => {
    const c = createXingyeMemoryCandidate('agent-1', { content: 'x', target: 'longterm' }, storage);
    await expect(confirmXingyeMemoryCandidate('agent-1', c.id, { storage, fetchImpl: hanaFetch })).rejects.toThrow(
      /longterm is compile output/,
    );
    expect(hanaFetch).not.toHaveBeenCalled();
  });

  it('unknown target throws invalid memory target (unknown)', async () => {
    storage.setItem(
      XINGYE_MEMORY_CANDIDATES_STORAGE_KEY,
      JSON.stringify({
        bad: {
          id: 'bad',
          agentId: 'agent-1',
          content: 'dirty',
          target: 'nope',
          status: 'pending',
          createdAt: '2020-01-01T00:00:00.000Z',
          updatedAt: '2020-01-01T00:00:00.000Z',
        },
      }),
    );
    await expect(confirmXingyeMemoryCandidate('agent-1', 'bad', { storage, fetchImpl: hanaFetch })).rejects.toThrow(
      'invalid memory target (unknown)',
    );
    expect(hanaFetch).not.toHaveBeenCalled();
  });
});

describe('xingye-memory-candidate-store normalize from storage', () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
  });

  it('loads illegal persisted target as unknown', () => {
    storage.setItem(
      XINGYE_MEMORY_CANDIDATES_STORAGE_KEY,
      JSON.stringify({
        bad: {
          id: 'bad',
          agentId: 'agent-1',
          content: 'dirty',
          target: 'nope',
          status: 'pending',
          createdAt: '2020-01-01T00:00:00.000Z',
          updatedAt: '2020-01-01T00:00:00.000Z',
        },
      }),
    );
    const map = loadXingyeMemoryCandidateMap(storage);
    expect(map.bad?.target).toBe('unknown');
  });
});

describe('xingye-memory-candidate-store CRUD', () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
  });

  it('update pending patches content reason importance', () => {
    const c = createXingyeMemoryCandidate('a1', { content: 'old', importance: XINGYE_MEMORY_CANDIDATE_IMPORTANCE_MEDIUM }, storage);
    const next = updateXingyeMemoryCandidate('a1', c.id, {
      content: 'new text',
      reason: 'because',
      importance: XINGYE_MEMORY_CANDIDATE_IMPORTANCE_HIGH,
    }, storage);
    expect(next.content).toBe('new text');
    expect(next.reason).toBe('because');
    expect(next.importance).toBe(XINGYE_MEMORY_CANDIDATE_IMPORTANCE_HIGH);
  });

  it('reject sets rejected status', () => {
    const c = createXingyeMemoryCandidate('a1', { content: 'x' }, storage);
    const next = rejectXingyeMemoryCandidate('a1', c.id, storage);
    expect(next.status).toBe('rejected');
  });

  it('list sorts by updatedAt then createdAt descending', () => {
    // ISO timestamps only have ms precision; in real CPU time these three calls
    // often collide on the same ms, leaving sort order undefined. Pin the clock
    // and step it forward so each operation gets a distinct, ordered timestamp.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      const older = createXingyeMemoryCandidate('a1', { content: 'older' }, storage);
      vi.setSystemTime(new Date('2026-01-01T00:00:00.010Z'));
      const newer = createXingyeMemoryCandidate('a1', { content: 'newer' }, storage);
      vi.setSystemTime(new Date('2026-01-01T00:00:00.020Z'));
      updateXingyeMemoryCandidate('a1', older.id, { reason: 'touch' }, storage);
      const list = listXingyeMemoryCandidates('a1', storage);
      expect(list[0].id).toBe(older.id);
      expect(list[1].id).toBe(newer.id);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not export patchXingyeMemoryCandidate (no direct cross-agent patch)', () => {
    expect('patchXingyeMemoryCandidate' in XingyeMemoryCandidateStore).toBe(false);
  });

  it('update throws on agent mismatch', () => {
    const c = createXingyeMemoryCandidate('a1', { content: 'x' }, storage);
    expect(() => updateXingyeMemoryCandidate('other', c.id, { content: 'y' }, storage)).toThrow(/agent mismatch/);
  });
});
