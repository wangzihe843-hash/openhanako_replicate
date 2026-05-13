/**
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const postMock = vi.hoisted(() => vi.fn());

vi.mock('./xingye-storage-api', () => ({
  postXingyeStorage: postMock,
}));

import {
  appendJournalEntry,
  deleteJournalEntry,
  listJournalEntries,
  XINGYE_JOURNAL_ENTRIES_JSONL,
} from './xingye-journal-store';

describe('xingye-journal-store', () => {
  beforeEach(() => {
    postMock.mockReset();
  });

  it('listJournalEntries returns normalized rows sorted by dayKey desc', async () => {
    postMock.mockResolvedValueOnce({
      ok: true,
      records: [
        { id: 'a', dayKey: '2026-01-01', title: 't1', body: 'b1', createdAt: '2026-01-01T10:00:00.000Z' },
        { id: 'b', dayKey: '2026-01-02', title: 't2', body: 'b2', createdAt: '2026-01-02T10:00:00.000Z' },
        { bad: true },
      ],
    });
    const rows = await listJournalEntries('agent-x');
    expect(postMock).toHaveBeenCalledWith({
      action: 'listJsonl',
      agentId: 'agent-x',
      relativePath: XINGYE_JOURNAL_ENTRIES_JSONL,
    });
    expect(rows.map((r) => r.id)).toEqual(['b', 'a']);
  });

  it('appendJournalEntry posts appendJsonl with journal path', async () => {
    postMock.mockResolvedValueOnce({ ok: true });
    const row = await appendJournalEntry('agent-x', { title: 'Hi', body: 'Body text' });
    expect(row.title).toBe('Hi');
    expect(row.body).toBe('Body text');
    expect(row.id.length).toBeGreaterThan(4);
    expect(row.dayKey).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const append = postMock.mock.calls.find((c) => (c[0] as { action?: string }).action === 'appendJsonl')?.[0] as {
      action: string;
      agentId: string;
      relativePath: string;
      data: Record<string, unknown>;
    };
    expect(append.agentId).toBe('agent-x');
    expect(append.relativePath).toBe(XINGYE_JOURNAL_ENTRIES_JSONL);
    expect(append.data.id).toBe(append.data.key);
    expect(append.data.body).toBe('Body text');
  });

  it('deleteJournalEntry forwards recordId to deleteJsonlRecord', async () => {
    postMock.mockResolvedValueOnce({ ok: true, deleted: true });
    await expect(deleteJournalEntry('agent-x', 'entry-1')).resolves.toBe(true);
    expect(postMock).toHaveBeenCalledWith({
      action: 'deleteJsonlRecord',
      agentId: 'agent-x',
      relativePath: XINGYE_JOURNAL_ENTRIES_JSONL,
      recordId: 'entry-1',
    });
  });

  it('rejects invalid agentId before append', async () => {
    await expect(appendJournalEntry('bad id', { title: 'x', body: 'y' })).rejects.toThrow(/agentId/);
    expect(postMock).not.toHaveBeenCalled();
  });
});
