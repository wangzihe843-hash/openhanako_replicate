/**
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const postMock = vi.hoisted(() => vi.fn());

vi.mock('./xingye-storage-api', () => ({
  postXingyeStorage: postMock,
}));

import {
  appendScheduleDraft,
  appendScheduleEntry,
  confirmScheduleDraft,
  deleteScheduleEntry,
  discardScheduleDraft,
  listScheduleDrafts,
  listScheduleEntries,
  updateScheduleEntryStatus,
  XINGYE_SCHEDULE_DRAFTS_JSONL,
  XINGYE_SCHEDULE_ENTRIES_JSONL,
} from './xingye-schedule-store';

describe('xingye-schedule-store', () => {
  beforeEach(() => {
    postMock.mockReset();
  });

  it('lists normalized schedule rows from the agent-scoped schedule JSONL path', async () => {
    postMock.mockResolvedValueOnce({
      ok: true,
      records: [
        {
          id: 'lin-1',
          agentId: 'linwu',
          title: '诊所前整理',
          dateLabel: '下次去诊所前',
          timeText: '上午',
          content: '把要问的事写下来。',
          note: '别太晚。',
          source: 'manual',
          status: 'planned',
          createdAt: '2026-05-12T10:00:00.000Z',
          updatedAt: '2026-05-12T10:00:00.000Z',
        },
        { id: 'bad', title: 'missing fields' },
      ],
    });

    const rows = await listScheduleEntries('linwu');

    expect(postMock).toHaveBeenCalledWith({
      action: 'listJsonl',
      agentId: 'linwu',
      relativePath: XINGYE_SCHEDULE_ENTRIES_JSONL,
    });
    expect(XINGYE_SCHEDULE_ENTRIES_JSONL).toBe('schedule/entries.jsonl');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'lin-1',
      agentId: 'linwu',
      title: '诊所前整理',
      status: 'planned',
      source: 'manual',
    });
  });

  it('appends manual entries with key=id and current agentId', async () => {
    postMock.mockResolvedValueOnce({ ok: true });

    const row = await appendScheduleEntry('linwu', {
      title: '睡前发消息',
      dateLabel: '今晚睡前',
      timeText: '睡前',
      content: '确认她有没有按时休息。',
      note: '别写成提醒。',
      source: 'manual',
    });

    const append = postMock.mock.calls.find((c) => (c[0] as { action?: string }).action === 'appendJsonl')?.[0] as {
      agentId: string;
      relativePath: string;
      data: Record<string, unknown>;
    };
    expect(row.status).toBe('planned');
    expect(row.agentId).toBe('linwu');
    expect(append.agentId).toBe('linwu');
    expect(append.relativePath).toBe(XINGYE_SCHEDULE_ENTRIES_JSONL);
    expect(append.data.key).toBe(append.data.id);
    expect(append.data.source).toBe('manual');
  });

  it('updates status by replacing the JSONL row without crossing agents', async () => {
    postMock
      .mockResolvedValueOnce({
        ok: true,
        records: [
          {
            id: 'lin-1',
            agentId: 'linwu',
            title: '睡前发消息',
            dateLabel: '今晚睡前',
            content: '确认她有没有按时休息。',
            source: 'manual',
            status: 'planned',
            createdAt: '2026-05-12T10:00:00.000Z',
            updatedAt: '2026-05-12T10:00:00.000Z',
          },
        ],
      })
      .mockResolvedValueOnce({ ok: true, deleted: true })
      .mockResolvedValueOnce({ ok: true });

    const updated = await updateScheduleEntryStatus('linwu', 'lin-1', 'done');

    expect(updated?.status).toBe('done');
    expect(postMock).toHaveBeenNthCalledWith(2, {
      action: 'deleteJsonlRecord',
      agentId: 'linwu',
      relativePath: XINGYE_SCHEDULE_ENTRIES_JSONL,
      recordId: 'lin-1',
    });
    expect(postMock).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        action: 'appendJsonl',
        agentId: 'linwu',
        relativePath: XINGYE_SCHEDULE_ENTRIES_JSONL,
      }),
    );
  });

  it('deletes one schedule entry by id', async () => {
    postMock.mockResolvedValueOnce({ ok: true, deleted: true });
    await expect(deleteScheduleEntry('hanako', 'hanako-1')).resolves.toBe(true);
    expect(postMock).toHaveBeenCalledWith({
      action: 'deleteJsonlRecord',
      agentId: 'hanako',
      relativePath: XINGYE_SCHEDULE_ENTRIES_JSONL,
      recordId: 'hanako-1',
    });
  });

  describe('drafts', () => {
    it('listScheduleDrafts reads drafts.jsonl, normalizes and sorts newest first', async () => {
      postMock.mockResolvedValueOnce({
        ok: true,
        records: [
          {
            id: 'd-old',
            title: 'old',
            dateLabel: '今天',
            content: 'old body',
            createdAt: '2026-05-17T08:00:00.000Z',
            source: 'xingye-heartbeat-tool',
          },
          {
            id: 'd-new',
            title: 'new',
            dateLabel: '明天',
            content: 'new body',
            createdAt: '2026-05-17T12:00:00.000Z',
            source: 'xingye-heartbeat-tool',
            reason: '聊天里有提到',
          },
          { bogus: true },
        ],
      });
      const rows = await listScheduleDrafts('agent-x');
      expect(postMock).toHaveBeenCalledWith({
        action: 'listJsonl',
        agentId: 'agent-x',
        relativePath: XINGYE_SCHEDULE_DRAFTS_JSONL,
      });
      expect(rows.map((r) => r.id)).toEqual(['d-new', 'd-old']);
      expect(rows[0].reason).toBe('聊天里有提到');
    });

    it('appendScheduleDraft writes drafts.jsonl (not entries) + emits draft_proposed', async () => {
      postMock.mockResolvedValue({ ok: true });
      const draft = await appendScheduleDraft('agent-x', {
        title: '陪我去诊所',
        dateLabel: '明天上午',
        content: '带社保卡',
        source: 'xingye-heartbeat-tool',
        reason: '她答应过',
      });
      expect(draft.title).toBe('陪我去诊所');
      const draftAppend = postMock.mock.calls.find(
        (c) => (c[0] as { action?: string; relativePath?: string }).action === 'appendJsonl'
          && (c[0] as { relativePath?: string }).relativePath === XINGYE_SCHEDULE_DRAFTS_JSONL,
      );
      expect(draftAppend).toBeTruthy();
      /** Must NOT write entries directly. */
      const entriesAppend = postMock.mock.calls.find(
        (c) => (c[0] as { action?: string; relativePath?: string }).action === 'appendJsonl'
          && (c[0] as { relativePath?: string }).relativePath === XINGYE_SCHEDULE_ENTRIES_JSONL,
      );
      expect(entriesAppend).toBeFalsy();
    });

    it('discardScheduleDraft removes the row from drafts.jsonl', async () => {
      postMock.mockResolvedValueOnce({ ok: true, deleted: true });
      await expect(discardScheduleDraft('agent-x', 'd-1')).resolves.toBe(true);
      expect(postMock).toHaveBeenCalledWith({
        action: 'deleteJsonlRecord',
        agentId: 'agent-x',
        relativePath: XINGYE_SCHEDULE_DRAFTS_JSONL,
        recordId: 'd-1',
      });
    });

    it('confirmScheduleDraft moves draft → entries (entry appended, draft removed)', async () => {
      postMock
        // listScheduleDrafts → listJsonl drafts
        .mockResolvedValueOnce({
          ok: true,
          records: [{
            id: 'd-c',
            title: 'kept',
            dateLabel: '明天上午',
            content: 'kept body',
            timeText: '上午',
            createdAt: '2026-05-17T12:00:00.000Z',
            source: 'xingye-heartbeat-tool',
          }],
        })
        // appendScheduleEntry → appendJsonl entries
        .mockResolvedValue({ ok: true });

      const entry = await confirmScheduleDraft('agent-x', 'd-c', { content: 'edited body' });
      expect(entry.content).toBe('edited body');
      expect(entry.title).toBe('kept');
      expect(entry.source).toBe('ai');

      const calls = postMock.mock.calls.map((c) => c[0] as { action?: string; relativePath?: string });
      expect(calls.some((c) =>
        c.action === 'appendJsonl' && c.relativePath === XINGYE_SCHEDULE_ENTRIES_JSONL,
      )).toBe(true);
      expect(calls.some((c) =>
        c.action === 'deleteJsonlRecord' && c.relativePath === XINGYE_SCHEDULE_DRAFTS_JSONL,
      )).toBe(true);
    });

    it('confirmScheduleDraft errors when draft not found', async () => {
      postMock.mockResolvedValueOnce({ ok: true, records: [] });
      await expect(confirmScheduleDraft('agent-x', 'nope')).rejects.toThrow(/草稿/);
    });
  });
});
