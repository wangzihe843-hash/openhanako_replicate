import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as XingyeMemoryCandidateStore from './xingye-memory-candidate-store';
import {
  confirmXingyeMemoryCandidateToPinned,
  createXingyeMemoryCandidate,
  getXingyeMemoryCandidate,
  listXingyeMemoryCandidates,
  rejectXingyeMemoryCandidate,
  updateXingyeMemoryCandidate,
  XINGYE_MEMORY_CANDIDATE_IMPORTANCE_HIGH,
  XINGYE_MEMORY_CANDIDATE_IMPORTANCE_MEDIUM,
} from './xingye-memory-candidate-store';

vi.mock('../hooks/use-hana-fetch', () => ({
  hanaUrl: (path: string) => path,
  hanaFetch: vi.fn(),
}));

const { hanaFetch } = await import('../hooks/use-hana-fetch');

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
    vi.mocked(hanaFetch).mockReset();
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

    expect(hanaFetch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(hanaFetch).mock.calls[0][0]).toBe('/api/agents/agent-1/pinned');
    expect(vi.mocked(hanaFetch).mock.calls[1][0]).toBe('/api/agents/agent-1/pinned');
    const putInit = vi.mocked(hanaFetch).mock.calls[1][1] as RequestInit;
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

    expect(hanaFetch).toHaveBeenCalledTimes(1);
    expect(candidate.status).toBe('written');
    expect(alreadyInPinned).toBe(true);
  });

  it('rejects fact target without calling import API', async () => {
    const c = createXingyeMemoryCandidate('agent-1', { content: 'x', target: 'fact' }, storage);
    await expect(
      confirmXingyeMemoryCandidateToPinned('agent-1', c.id, { storage, fetchImpl: hanaFetch }),
    ).rejects.toThrow(/fact write path not implemented/);
    expect(hanaFetch).not.toHaveBeenCalled();
  });

  it('rejects longterm target without calling fetch', async () => {
    const c = createXingyeMemoryCandidate('agent-1', { content: 'x', target: 'longterm' }, storage);
    await expect(
      confirmXingyeMemoryCandidateToPinned('agent-1', c.id, { storage, fetchImpl: hanaFetch }),
    ).rejects.toThrow(/longterm write path not implemented/);
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
    vi.mocked(hanaFetch).mockReset();

    const second = createXingyeMemoryCandidate('agent-1', { content: '  dup  ' }, storage);
    vi.mocked(hanaFetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ pins: ['dup'] }),
    } as Response);

    const { candidate, alreadyInPinned } = await confirmXingyeMemoryCandidateToPinned('agent-1', second.id, {
      storage,
      fetchImpl: hanaFetch,
    });

    expect(hanaFetch).toHaveBeenCalledTimes(1);
    expect(alreadyInPinned).toBe(true);
    expect(candidate.status).toBe('written');
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
    const older = createXingyeMemoryCandidate('a1', { content: 'older' }, storage);
    const newer = createXingyeMemoryCandidate('a1', { content: 'newer' }, storage);
    updateXingyeMemoryCandidate('a1', older.id, { reason: 'touch' }, storage);
    const list = listXingyeMemoryCandidates('a1', storage);
    expect(list[0].id).toBe(older.id);
    expect(list[1].id).toBe(newer.id);
  });

  it('does not export patchXingyeMemoryCandidate (no direct cross-agent patch)', () => {
    expect('patchXingyeMemoryCandidate' in XingyeMemoryCandidateStore).toBe(false);
  });

  it('update throws on agent mismatch', () => {
    const c = createXingyeMemoryCandidate('a1', { content: 'x' }, storage);
    expect(() => updateXingyeMemoryCandidate('other', c.id, { content: 'y' }, storage)).toThrow(/agent mismatch/);
  });
});
