/**
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const postMock = vi.hoisted(() => vi.fn());

vi.mock('./xingye-storage-api', () => ({
  postXingyeStorage: postMock,
}));

import {
  appendFileEntry,
  deleteFileEntry,
  ensureDefaultFileFolders,
  listFileEntries,
  listFileEntriesByFolder,
  listFileFolders,
  updateFileEntry,
  XINGYE_FILES_ENTRIES_JSONL,
  XINGYE_FILES_FOLDERS_JSON,
  DEFAULT_FILE_FOLDER_BLUEPRINTS,
} from './xingye-files-store';

type Call = { action: string; agentId?: string; relativePath?: string; data?: unknown; recordId?: string };

function lastCall(action: string): Call {
  const calls = postMock.mock.calls.map((c) => c[0] as Call);
  const found = [...calls].reverse().find((c) => c.action === action);
  if (!found) throw new Error(`No call with action ${action} (had: ${calls.map((c) => c.action).join(',')})`);
  return found;
}

describe('xingye-files-store', () => {
  beforeEach(() => {
    postMock.mockReset();
  });

  it('listFileFolders returns normalized folders sorted by order', async () => {
    postMock.mockResolvedValueOnce({
      ok: true,
      data: {
        folders: [
          { id: 'b', agentId: 'agent-x', name: '人际关系', order: 1, createdAt: '2026-05-15T10:00:00.000Z', updatedAt: '2026-05-15T10:00:00.000Z' },
          { id: 'a', agentId: 'agent-x', name: '世界观整理', order: 0, createdAt: '2026-05-15T10:00:00.000Z', updatedAt: '2026-05-15T10:00:00.000Z' },
          { bad: true },
          { id: 'c', agentId: 'other', name: '不属于本 agent', order: 2, createdAt: '2026-05-15T10:00:00.000Z', updatedAt: '2026-05-15T10:00:00.000Z' },
        ],
      },
    });
    const folders = await listFileFolders('agent-x');
    expect(postMock).toHaveBeenCalledWith({
      action: 'readJson',
      agentId: 'agent-x',
      relativePath: XINGYE_FILES_FOLDERS_JSON,
    });
    expect(folders.map((f) => f.id)).toEqual(['a', 'b']);
  });

  it('listFileFolders returns [] for empty agentId without calling backend', async () => {
    const folders = await listFileFolders('   ');
    expect(folders).toEqual([]);
    expect(postMock).not.toHaveBeenCalled();
  });

  it('ensureDefaultFileFolders writes blueprints when none exist', async () => {
    postMock
      .mockResolvedValueOnce({ ok: true, missing: true })
      .mockResolvedValueOnce({ ok: true });
    const created = await ensureDefaultFileFolders('agent-x');
    expect(created).toHaveLength(DEFAULT_FILE_FOLDER_BLUEPRINTS.length);
    expect(created.map((f) => f.name)).toEqual(DEFAULT_FILE_FOLDER_BLUEPRINTS.map((b) => b.name));
    const writeCall = lastCall('writeJson');
    expect(writeCall.relativePath).toBe(XINGYE_FILES_FOLDERS_JSON);
    expect(writeCall.agentId).toBe('agent-x');
    const written = (writeCall.data as { folders: Array<{ name: string; agentId: string; order: number }> }).folders;
    expect(written.map((f) => f.name)).toEqual(DEFAULT_FILE_FOLDER_BLUEPRINTS.map((b) => b.name));
    expect(written.every((f) => f.agentId === 'agent-x')).toBe(true);
    expect(written.map((f) => f.order)).toEqual(DEFAULT_FILE_FOLDER_BLUEPRINTS.map((_, idx) => idx));
  });

  it('ensureDefaultFileFolders does not overwrite when folders already exist', async () => {
    postMock.mockResolvedValueOnce({
      ok: true,
      data: {
        folders: [
          { id: 'k', agentId: 'agent-x', name: '已有文件夹', order: 0, createdAt: '2026-05-15T10:00:00.000Z', updatedAt: '2026-05-15T10:00:00.000Z' },
        ],
      },
    });
    const result = await ensureDefaultFileFolders('agent-x');
    expect(result.map((f) => f.id)).toEqual(['k']);
    const writeCalls = postMock.mock.calls.filter((c) => (c[0] as Call).action === 'writeJson');
    expect(writeCalls).toHaveLength(0);
  });

  it('ensureDefaultFileFolders rejects invalid agentId before any backend call', async () => {
    await expect(ensureDefaultFileFolders('bad id')).rejects.toThrow(/agentId/);
    expect(postMock).not.toHaveBeenCalled();
  });

  it('appendFileEntry posts appendJsonl with files path and id===key', async () => {
    postMock.mockResolvedValueOnce({ ok: true });
    const row = await appendFileEntry('agent-x', {
      folderId: 'fold-1',
      title: '关于 user 的偏好',
      body: 'user 喜欢深色配色，并希望 TA 主动记下细节。',
      tags: ['user', '偏好'],
      source: '2026-05-15 闲聊',
    });
    expect(row.title).toBe('关于 user 的偏好');
    expect(row.folderId).toBe('fold-1');
    expect(row.tags).toEqual(['user', '偏好']);
    expect(row.id).toBeTruthy();
    expect(row.key).toBe(row.id);

    const append = lastCall('appendJsonl');
    expect(append.agentId).toBe('agent-x');
    expect(append.relativePath).toBe(XINGYE_FILES_ENTRIES_JSONL);
    const data = append.data as { id: string; key: string; agentId: string; folderId: string; tags?: string[] };
    expect(data.id).toBe(data.key);
    expect(data.agentId).toBe('agent-x');
    expect(data.folderId).toBe('fold-1');
    expect(data.tags).toEqual(['user', '偏好']);
  });

  it('appendFileEntry rejects empty title', async () => {
    await expect(
      appendFileEntry('agent-x', { folderId: 'fold-1', title: '   ', body: 'body' }),
    ).rejects.toThrow(/标题/);
    expect(postMock).not.toHaveBeenCalled();
  });

  it('appendFileEntry rejects invalid agentId', async () => {
    await expect(
      appendFileEntry('bad id', { folderId: 'fold-1', title: 'hi', body: 'body' }),
    ).rejects.toThrow(/agentId/);
    expect(postMock).not.toHaveBeenCalled();
  });

  it('listFileEntries returns normalized rows sorted by updatedAt desc', async () => {
    postMock.mockResolvedValueOnce({
      ok: true,
      records: [
        {
          id: 'e1', agentId: 'agent-x', folderId: 'f-1', title: '旧',
          body: 'old', createdAt: '2026-05-10T10:00:00.000Z', updatedAt: '2026-05-10T10:00:00.000Z',
        },
        {
          id: 'e2', agentId: 'agent-x', folderId: 'f-1', title: '新',
          body: 'new', createdAt: '2026-05-15T10:00:00.000Z', updatedAt: '2026-05-15T10:00:00.000Z',
        },
        { bad: 1 },
        {
          id: 'e3', agentId: 'other', folderId: 'f-1', title: '别人的',
          body: 'x', createdAt: '2026-05-15T10:00:00.000Z',
        },
      ],
    });
    const rows = await listFileEntries('agent-x');
    expect(rows.map((r) => r.id)).toEqual(['e2', 'e1']);
  });

  it('listFileEntriesByFolder filters by folderId', async () => {
    postMock.mockResolvedValueOnce({
      ok: true,
      records: [
        { id: 'a', agentId: 'agent-x', folderId: 'f-1', title: 'A', body: 'a', createdAt: '2026-05-15T10:00:00.000Z' },
        { id: 'b', agentId: 'agent-x', folderId: 'f-2', title: 'B', body: 'b', createdAt: '2026-05-15T11:00:00.000Z' },
        { id: 'c', agentId: 'agent-x', folderId: 'f-1', title: 'C', body: 'c', createdAt: '2026-05-15T12:00:00.000Z' },
      ],
    });
    const rows = await listFileEntriesByFolder('agent-x', 'f-1');
    expect(rows.map((r) => r.id).sort()).toEqual(['a', 'c']);
  });

  it('deleteFileEntry forwards recordId to deleteJsonlRecord', async () => {
    postMock.mockResolvedValueOnce({ ok: true, deleted: true });
    await expect(deleteFileEntry('agent-x', 'entry-1')).resolves.toBe(true);
    expect(postMock).toHaveBeenCalledWith({
      action: 'deleteJsonlRecord',
      agentId: 'agent-x',
      relativePath: XINGYE_FILES_ENTRIES_JSONL,
      recordId: 'entry-1',
    });
  });

  it('updateFileEntry deletes old row and appends updated one', async () => {
    postMock
      .mockResolvedValueOnce({
        ok: true,
        records: [
          {
            id: 'e1', agentId: 'agent-x', folderId: 'f-1', title: '旧标题',
            body: 'old body', createdAt: '2026-05-10T10:00:00.000Z', updatedAt: '2026-05-10T10:00:00.000Z',
          },
        ],
      })
      .mockResolvedValueOnce({ ok: true, deleted: true })
      .mockResolvedValueOnce({ ok: true });

    const updated = await updateFileEntry('agent-x', 'e1', { title: '新标题', body: 'new body' });
    expect(updated?.title).toBe('新标题');
    expect(updated?.body).toBe('new body');
    expect(updated?.folderId).toBe('f-1');

    const del = lastCall('deleteJsonlRecord');
    expect(del.recordId).toBe('e1');
    const append = lastCall('appendJsonl');
    const data = append.data as { id: string; key: string; title: string };
    expect(data.id).toBe('e1');
    expect(data.key).toBe('e1');
    expect(data.title).toBe('新标题');
  });

  it('updateFileEntry returns null when entry not found', async () => {
    postMock.mockResolvedValueOnce({ ok: true, records: [] });
    const result = await updateFileEntry('agent-x', 'missing', { title: 'x' });
    expect(result).toBeNull();
  });
});
