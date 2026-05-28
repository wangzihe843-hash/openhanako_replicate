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
import { __resetDraftConfirmLockForTests } from './xingye-draft-confirm-lock';

describe('xingye-journal-store', () => {
  beforeEach(() => {
    postMock.mockReset();
    __resetDraftConfirmLockForTests();
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
        // listJournalEntries (idempotent dedupe lookup) → empty
        .mockResolvedValueOnce({ ok: true, records: [] })
        // listJournalDrafts → the pending draft
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
        // event log + delete + remaining ops
        .mockResolvedValue({ ok: true, records: [], deleted: true });

      const entry = await confirmJournalDraft('agent-x', 'd-confirm', {
        body: 'edited body',
      });
      expect(entry.body).toBe('edited body');
      expect(entry.title).toBe('kept title');
      expect(entry.dayKey).toBe('2026-05-17');
      /** Deterministic id derived from draft id; lets retries recognize an existing entry. */
      expect(entry.id).toBe('from-draft-d-confirm');

      const calls = postMock.mock.calls.map((c) => c[0] as { action?: string; relativePath?: string });
      /** appendJsonl to entries.jsonl must happen. */
      const entryAppend = calls.find(
        (c) => c.action === 'appendJsonl' && c.relativePath === XINGYE_JOURNAL_ENTRIES_JSONL,
      ) as { data?: Record<string, unknown> } | undefined;
      expect(entryAppend).toBeTruthy();
      expect(entryAppend?.data?.id).toBe('from-draft-d-confirm');
      expect(entryAppend?.data?.key).toBe('from-draft-d-confirm');
      /** deleteJsonlRecord on drafts must happen. */
      expect(
        calls.some(
          (c) =>
            c.action === 'deleteJsonlRecord' && c.relativePath === XINGYE_JOURNAL_DRAFTS_JSONL,
        ),
      ).toBe(true);
    });

    it('confirmJournalDraft errors if neither draft nor existing entry is found', async () => {
      postMock
        // listJournalEntries → empty
        .mockResolvedValueOnce({ ok: true, records: [] })
        // listJournalDrafts → empty
        .mockResolvedValueOnce({ ok: true, records: [] });
      await expect(confirmJournalDraft('agent-x', 'missing-id')).rejects.toThrow(/草稿/);
    });

    it(
      'confirmJournalDraft is idempotent: a second confirm after delete-draft failure reuses '
        + 'the existing entry instead of appending a duplicate',
      async () => {
        /**
         * Simulates the bug we're guarding against:
         *  - First confirm wrote entry `from-draft-d-confirm` then failed to delete the draft.
         *  - User clicks confirm again. We must NOT append a second entry.
         *  - We MUST still retry the draft delete and emit draft_confirmed.
         */
        postMock
          // listJournalEntries → already has the entry from the prior attempt
          .mockResolvedValueOnce({
            ok: true,
            records: [
              {
                id: 'from-draft-d-confirm',
                dayKey: '2026-05-17',
                title: 'previous title',
                body: 'previous body',
                createdAt: '2026-05-17T12:00:00.000Z',
              },
            ],
          })
          // listJournalDrafts → the orphaned draft still sitting there
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
          // delete draft (success this time) + event log writes
          .mockResolvedValue({ ok: true, records: [], deleted: true });

        const entry = await confirmJournalDraft('agent-x', 'd-confirm');

        expect(entry.id).toBe('from-draft-d-confirm');
        expect(entry.body).toBe('previous body');

        const calls = postMock.mock.calls.map((c) => c[0] as { action?: string; relativePath?: string });
        /** Critical assertion: no NEW appendJsonl on entries.jsonl this time. */
        const entryAppends = calls.filter(
          (c) => c.action === 'appendJsonl' && c.relativePath === XINGYE_JOURNAL_ENTRIES_JSONL,
        );
        expect(entryAppends.length).toBe(0);
        /** But we should still retry the draft delete. */
        const draftDeletes = calls.filter(
          (c) => c.action === 'deleteJsonlRecord' && c.relativePath === XINGYE_JOURNAL_DRAFTS_JSONL,
        );
        expect(draftDeletes.length).toBe(1);
      },
    );

    it(
      'two concurrent confirmJournalDraft calls for the same draft share the in-flight Promise '
        + '(only one append round-trip)',
      async () => {
        /**
         * Simulates a double-click: two confirm calls fire before the first finishes.
         * The lock should make the second await the first's Promise, not start a parallel run.
         */
        postMock
          .mockResolvedValueOnce({ ok: true, records: [] }) // listJournalEntries
          .mockResolvedValueOnce({
            ok: true,
            records: [
              {
                id: 'd-double',
                dayKey: '2026-05-17',
                title: 'double-click title',
                body: 'double-click body',
                createdAt: '2026-05-17T12:00:00.000Z',
                source: 'xingye-heartbeat-tool',
              },
            ],
          })
          .mockResolvedValue({ ok: true, records: [], deleted: true });

        const [a, b] = await Promise.all([
          confirmJournalDraft('agent-x', 'd-double'),
          confirmJournalDraft('agent-x', 'd-double'),
        ]);
        expect(a.id).toBe('from-draft-d-double');
        expect(b.id).toBe('from-draft-d-double');

        const calls = postMock.mock.calls.map((c) => c[0] as { action?: string; relativePath?: string });
        const entryAppends = calls.filter(
          (c) => c.action === 'appendJsonl' && c.relativePath === XINGYE_JOURNAL_ENTRIES_JSONL,
        );
        /** Exactly one append even with two concurrent confirms. */
        expect(entryAppends.length).toBe(1);
      },
    );

    it('appendJournalEntry honors caller-supplied id (used by confirm flow)', async () => {
      postMock.mockResolvedValue({ ok: true });
      const entry = await appendJournalEntry('agent-x', {
        title: 't',
        body: 'b',
        id: 'from-draft-xyz',
      });
      expect(entry.id).toBe('from-draft-xyz');
      const append = postMock.mock.calls.find(
        (c) => (c[0] as { action?: string }).action === 'appendJsonl',
      )?.[0] as { data: Record<string, unknown> };
      expect(append.data.id).toBe('from-draft-xyz');
      expect(append.data.key).toBe('from-draft-xyz');
    });
  });

  describe('dateSmudged 污损标记', () => {
    it('appendJournalEntry with dateSmudged=true 强制写哨兵 dayKey 0001-01-01', async () => {
      postMock.mockResolvedValueOnce({ ok: true });
      // 即使调用方传了一个真实的 dayKey，dateSmudged=true 也会被强制改写成哨兵
      const entry = await appendJournalEntry('agent-x', {
        title: '不可考的一篇',
        body: '某段文字。',
        dayKey: '2024-06-01',
        dateSmudged: true,
      });
      expect(entry.dayKey).toBe('0001-01-01');
      expect(entry.dateSmudged).toBe(true);
      const append = postMock.mock.calls.find(
        (c) => (c[0] as { action?: string }).action === 'appendJsonl',
      )?.[0] as { data: Record<string, unknown> };
      expect(append.data.dayKey).toBe('0001-01-01');
      expect(append.data.dateSmudged).toBe(true);
    });

    it('appendJournalEntry without dateSmudged 不写出 dateSmudged 字段', async () => {
      postMock.mockResolvedValueOnce({ ok: true });
      const entry = await appendJournalEntry('agent-x', {
        title: '一篇正常的',
        body: '正文。',
        dayKey: '2024-06-01',
      });
      expect(entry.dayKey).toBe('2024-06-01');
      expect(entry.dateSmudged).toBeUndefined();
      const append = postMock.mock.calls.find(
        (c) => (c[0] as { action?: string }).action === 'appendJsonl',
      )?.[0] as { data: Record<string, unknown> };
      expect(append.data.dateSmudged).toBeUndefined();
    });

    it('listJournalEntries 读出来时保留 dateSmudged 标记', async () => {
      postMock.mockResolvedValueOnce({
        ok: true,
        records: [
          {
            id: 's-1',
            dayKey: '0001-01-01',
            title: '不可考',
            body: '糊了。',
            createdAt: '2026-05-28T10:00:00.000Z',
            dateSmudged: true,
          },
          {
            id: 'n-1',
            dayKey: '2024-06-01',
            title: '正常',
            body: '清楚。',
            createdAt: '2024-06-01T10:00:00.000Z',
          },
        ],
      });
      const rows = await listJournalEntries('agent-x');
      const smudged = rows.find((r) => r.id === 's-1');
      const normal = rows.find((r) => r.id === 'n-1');
      expect(smudged?.dateSmudged).toBe(true);
      expect(normal?.dateSmudged).toBeUndefined();
    });
  });
});
