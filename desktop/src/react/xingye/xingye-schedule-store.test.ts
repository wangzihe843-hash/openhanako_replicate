/**
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const postMock = vi.hoisted(() => vi.fn());

vi.mock('./xingye-storage-api', () => ({
  postXingyeStorage: postMock,
}));

import {
  appendScheduleEntry,
  deleteScheduleEntry,
  listScheduleEntries,
  updateScheduleEntryStatus,
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
});
