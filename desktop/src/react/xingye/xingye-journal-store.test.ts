/**
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const postMock = vi.hoisted(() => vi.fn());

vi.mock('./xingye-storage-api', () => ({
  postXingyeStorage: postMock,
}));

import {
  appendJournalDraft,
  appendJournalEntry,
  confirmJournalDraft,
  deleteJournalEntry,
  discardJournalDraft,
  listJournalDrafts,
  listJournalEntries,
  XINGYE_JOURNAL_DRAFTS_JSONL,
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

  describe('drafts', () => {
    it('listJournalDrafts reads drafts.jsonl, normalizes, sorts newest first', async () => {
      postMock.mockResolvedValueOnce({
        ok: true,
        records: [
          {
            id: 'd-1',
            dayKey: '2026-05-17',
            title: 'old',
            body: 'old body',
            createdAt: '2026-05-17T08:00:00.000Z',
            source: 'xingye-heartbeat-tool',
          },
          {
            id: 'd-2',
            dayKey: '2026-05-17',
            title: 'new',
            body: 'new body',
            createdAt: '2026-05-17T12:00:00.000Z',
            source: 'xingye-heartbeat-tool',
            mood: '想他',
            reason: '上下文里反复出现',
          },
          { bogus: true },
        ],
      });
      const rows = await listJournalDrafts('agent-x');
      expect(postMock).toHaveBeenCalledWith({
        action: 'listJsonl',
        agentId: 'agent-x',
        relativePath: XINGYE_JOURNAL_DRAFTS_JSONL,
      });
      expect(rows.map((r) => r.id)).toEqual(['d-2', 'd-1']);
      expect(rows[0].reason).toBe('上下文里反复出现');
      expect(rows[0].mood).toBe('想他');
    });

    it('appendJournalDraft writes drafts.jsonl (not entries) and emits draft_proposed event', async () => {
      postMock
        .mockResolvedValueOnce({ ok: true }) // appendJsonl drafts
        .mockResolvedValueOnce({ ok: true, records: [] }) // readJson for events
        .mockResolvedValueOnce({ ok: true }) // writeJson for events
        .mockResolvedValueOnce({ ok: true }); // any extra calls
      const draft = await appendJournalDraft('agent-x', {
        title: '小灯塔的下午',
        body: '海风把灯影吹得有点歪。',
        source: 'xingye-heartbeat-tool',
        reason: '聊天里提到了灯塔',
      });
      expect(draft.id.length).toBeGreaterThan(4);
      const draftAppend = postMock.mock.calls.find(
        (c) => (c[0] as { action?: string; relativePath?: string }).action === 'appendJsonl'
          && (c[0] as { relativePath?: string }).relativePath === XINGYE_JOURNAL_DRAFTS_JSONL,
      )?.[0] as {
        action: string;
        agentId: string;
        relativePath: string;
        data: Record<string, unknown>;
      };
      expect(draftAppend).toBeTruthy();
      expect(draftAppend.data.body).toBe('海风把灯影吹得有点歪。');
      expect(draftAppend.data.source).toBe('xingye-heartbeat-tool');
      expect(draftAppend.data.reason).toBe('聊天里提到了灯塔');
      /** Must NOT write entries.jsonl directly — that's reserved for user-confirmed entries. */
      const entriesAppend = postMock.mock.calls.find(
        (c) => (c[0] as { action?: string; relativePath?: string }).action === 'appendJsonl'
          && (c[0] as { relativePath?: string }).relativePath === XINGYE_JOURNAL_ENTRIES_JSONL,
      );
      expect(entriesAppend).toBeFalsy();
    });

    it('appendJournalDraft rejects empty body and missing source', async () => {
      await expect(
        appendJournalDraft('agent-x', { title: 't', body: '   ', source: 'xingye-heartbeat-tool' }),
      ).rejects.toThrow(/正文/);
      await expect(
        appendJournalDraft('agent-x', { title: 't', body: 'real body', source: '   ' }),
      ).rejects.toThrow(/source|来源/);
      expect(postMock).not.toHaveBeenCalled();
    });

    it('discardJournalDraft removes the row from drafts.jsonl', async () => {
      postMock.mockResolvedValueOnce({ ok: true, deleted: true });
      await expect(discardJournalDraft('agent-x', 'd-1')).resolves.toBe(true);
      expect(postMock).toHaveBeenCalledWith({
        action: 'deleteJsonlRecord',
        agentId: 'agent-x',
        relativePath: XINGYE_JOURNAL_DRAFTS_JSONL,
        recordId: 'd-1',
      });
    });

    it('confirmJournalDraft moves draft → entries (entry_appended fires; draft is removed)', async () => {
      postMock
        // listJournalDrafts → listJsonl drafts
        .mockResolvedValueOnce({
          ok: true,
          records: [
            {
              id: 'd-confirm',
              dayKey: '2026-05-17',
              title: 'kept title',
              body: 'kept body',
              createdAt: '2026-05-17T12:00:00.000Z',
              source: 'xingye-heartbeat-tool',
            },
          ],
        })
        // appendJournalEntry → appendJsonl entries
        .mockResolvedValueOnce({ ok: true })
        // entry_appended event log read+write — match by action shape
        .mockResolvedValue({ ok: true, records: [] });

      const entry = await confirmJournalDraft('agent-x', 'd-confirm', {
        body: 'edited body',
      });
      expect(entry.body).toBe('edited body');
      expect(entry.title).toBe('kept title');
      expect(entry.dayKey).toBe('2026-05-17');

      const calls = postMock.mock.calls.map((c) => c[0] as { action?: string; relativePath?: string });
      /** appendJsonl to entries.jsonl must happen. */
      expect(
        calls.some(
          (c) => c.action === 'appendJsonl' && c.relativePath === XINGYE_JOURNAL_ENTRIES_JSONL,
        ),
      ).toBe(true);
      /** deleteJsonlRecord on drafts must happen. */
      expect(
        calls.some(
          (c) =>
            c.action === 'deleteJsonlRecord' && c.relativePath === XINGYE_JOURNAL_DRAFTS_JSONL,
        ),
      ).toBe(true);
    });

    it('confirmJournalDraft errors if draft not found', async () => {
      postMock.mockResolvedValueOnce({ ok: true, records: [] });
      await expect(confirmJournalDraft('agent-x', 'missing-id')).rejects.toThrow(/草稿/);
    });
  });
});
