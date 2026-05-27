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
  confirmFileDraft,
  deleteFileEntry,
  DuplicateFileEntryError,
  ensureDefaultFileFolders,
  listFileEntries,
  listFileEntriesByFolder,
  listFileFolders,
  resolveTargetEntry,
  updateFileEntry,
  XINGYE_FILES_DRAFTS_JSONL,
  XINGYE_FILES_ENTRIES_JSONL,
  XINGYE_FILES_FOLDERS_JSON,
  DEFAULT_FILE_FOLDER_BLUEPRINTS,
  type XingyeFileEntry,
} from './xingye-files-store';
import { __resetDraftConfirmLockForTests } from './xingye-draft-confirm-lock';

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
    __resetDraftConfirmLockForTests();
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

  it('appendFileEntry honors caller-supplied id (used by confirm flow)', async () => {
    postMock.mockResolvedValue({ ok: true });
    const row = await appendFileEntry(
      'agent-x',
      { folderId: 'fold-1', title: 'hi', body: 'body', source: 'manual' },
      { id: 'from-draft-xyz' },
    );
    expect(row.id).toBe('from-draft-xyz');
    expect(row.key).toBe('from-draft-xyz');
    const append = lastCall('appendJsonl');
    const data = append.data as { id: string; key: string };
    expect(data.id).toBe('from-draft-xyz');
    expect(data.key).toBe('from-draft-xyz');
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
    /**
     * `deleteFileEntry` 现在的实现会：
     *   1. listJsonl(entries) 读 entry-1 拿到 folderId，用于后续 folder.updatedAt 刷新；
     *   2. deleteJsonlRecord 真删；
     *   3. bumpFolderUpdatedAtBestEffort → readJson(folders) + writeJson(folders)
     *      （best-effort，失败仅 warn，不影响主流程返回值）。
     * 测试只断言主语义：deleteJsonlRecord 收到正确 recordId 且函数返回 true。
     * 后两步的 mock 给定即可让 bump 不抛错；不强校验 bump 的存在与否。
     */
    postMock
      // (1) listJsonl(entries) → 找到 entry-1 所在的 folderId
      .mockResolvedValueOnce({
        ok: true,
        records: [
          { id: 'entry-1', agentId: 'agent-x', folderId: 'fold-1', title: 'T', body: 'b', createdAt: '2026-05-15T10:00:00.000Z' },
        ],
      })
      // (2) deleteJsonlRecord → 返回 deleted:true
      .mockResolvedValueOnce({ ok: true, deleted: true })
      // (3) readJson(folders) → bumpFolderUpdatedAtBestEffort 读 folders
      .mockResolvedValueOnce({ ok: true, data: { folders: [{ id: 'fold-1', agentId: 'agent-x', name: 'x', order: 0, createdAt: '2026-05-15T10:00:00.000Z', updatedAt: '2026-05-15T10:00:00.000Z' }] } })
      // (4) writeJson(folders) → bump 持久化
      .mockResolvedValueOnce({ ok: true });
    await expect(deleteFileEntry('agent-x', 'entry-1')).resolves.toBe(true);
    expect(postMock).toHaveBeenCalledWith({
      action: 'deleteJsonlRecord',
      agentId: 'agent-x',
      relativePath: XINGYE_FILES_ENTRIES_JSONL,
      recordId: 'entry-1',
    });
  });

  it('deleteFileEntry still resolves true when bumping folder.updatedAt fails', async () => {
    /**
     * folder.updatedAt 同步是 best-effort：如果 readJson(folders) 或 writeJson 失败，
     * 主流程（entry 删除成功）依然返回 true。
     */
    postMock
      .mockResolvedValueOnce({
        ok: true,
        records: [
          { id: 'entry-1', agentId: 'agent-x', folderId: 'fold-1', title: 'T', body: 'b', createdAt: '2026-05-15T10:00:00.000Z' },
        ],
      })
      .mockResolvedValueOnce({ ok: true, deleted: true })
      .mockRejectedValueOnce(new Error('folders.json missing'));
    await expect(deleteFileEntry('agent-x', 'entry-1')).resolves.toBe(true);
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

  describe('confirmFileDraft idempotency', () => {
    /**
     * Shared mock setup: ensureDefaultFileFolders + folder hint resolution requires
     * folders.json with at least one folder. We seed via readJson + writeJson responses.
     */
    const SEEDED_FOLDER = {
      id: 'pending-folder',
      agentId: 'agent-x',
      name: '待确认',
      order: 0,
      createdAt: '2026-05-15T10:00:00.000Z',
      updatedAt: '2026-05-15T10:00:00.000Z',
    };

    it(
      'reuses an existing entry on retry when the prior delete-draft failed (no duplicate append)',
      async () => {
        const draftRow = {
          id: 'd-orphan',
          title: 'kept title',
          body: 'kept body',
          folderHint: '待确认',
          createdAt: '2026-05-17T12:00:00.000Z',
          source: 'xingye-heartbeat-tool',
        };
        const existingEntry = {
          id: 'from-draft-d-orphan',
          key: 'from-draft-d-orphan',
          agentId: 'agent-x',
          folderId: SEEDED_FOLDER.id,
          title: 'previous title',
          body: 'previous body',
          createdAt: '2026-05-17T12:00:00.000Z',
          updatedAt: '2026-05-17T12:00:00.000Z',
          source: 'xingye-heartbeat-confirmed',
        };
        postMock
          // listFileEntries → existing entry from prior partial confirm
          .mockResolvedValueOnce({ ok: true, records: [existingEntry] })
          // listFileDrafts → orphan draft still present
          .mockResolvedValueOnce({ ok: true, records: [draftRow] })
          // everything else (delete + event log writes) succeeds
          .mockResolvedValue({ ok: true, deleted: true, records: [] });

        const entry = await confirmFileDraft('agent-x', 'd-orphan');
        expect(entry.id).toBe('from-draft-d-orphan');
        expect(entry.body).toBe('previous body');

        const calls = postMock.mock.calls.map((c) => c[0] as Call);
        const entryAppends = calls.filter(
          (c) => c.action === 'appendJsonl' && c.relativePath === XINGYE_FILES_ENTRIES_JSONL,
        );
        expect(entryAppends.length).toBe(0);
        const draftDeletes = calls.filter(
          (c) => c.action === 'deleteJsonlRecord' && c.relativePath === XINGYE_FILES_DRAFTS_JSONL,
        );
        expect(draftDeletes.length).toBe(1);
      },
    );

    it('two concurrent confirmFileDraft calls for same draft share one append', async () => {
      const draftRow = {
        id: 'd-dbl',
        title: 'double click',
        body: 'body',
        folderHint: '待确认',
        createdAt: '2026-05-17T12:00:00.000Z',
        source: 'xingye-heartbeat-tool',
      };
      postMock
        .mockResolvedValueOnce({ ok: true, records: [] }) // listFileEntries
        .mockResolvedValueOnce({ ok: true, records: [draftRow] }) // listFileDrafts
        // readJson for folders (ensureDefaultFileFolders) — return seeded
        .mockResolvedValueOnce({ ok: true, data: { folders: [SEEDED_FOLDER] } })
        // remaining: appendJsonl entries, deleteJsonlRecord, events
        .mockResolvedValue({ ok: true, deleted: true, records: [] });

      const [a, b] = await Promise.all([
        confirmFileDraft('agent-x', 'd-dbl'),
        confirmFileDraft('agent-x', 'd-dbl'),
      ]);
      expect(a.id).toBe('from-draft-d-dbl');
      expect(b.id).toBe('from-draft-d-dbl');

      const calls = postMock.mock.calls.map((c) => c[0] as Call);
      const entryAppends = calls.filter(
        (c) => c.action === 'appendJsonl' && c.relativePath === XINGYE_FILES_ENTRIES_JSONL,
      );
      expect(entryAppends.length).toBe(1);
    });
  });

  it('updateFileEntry returns null when entry not found', async () => {
    postMock.mockResolvedValueOnce({ ok: true, records: [] });
    const result = await updateFileEntry('agent-x', 'missing', { title: 'x' });
    expect(result).toBeNull();
  });

  describe('appendFileEntry dedupe', () => {
    function makeEntry(partial: Partial<XingyeFileEntry> & { id: string; title: string; folderId: string }): XingyeFileEntry {
      return {
        key: partial.id,
        agentId: 'agent-x',
        body: '',
        createdAt: '2026-05-15T10:00:00.000Z',
        ...partial,
      };
    }

    it('throws DuplicateFileEntryError on exact title dup in same folder (knownEntries)', async () => {
      const existing = [makeEntry({ id: 'e1', title: '师父的话', folderId: 'fold-1' })];
      let err: unknown;
      try {
        await appendFileEntry(
          'agent-x',
          { folderId: 'fold-1', title: '师父的话', body: 'b', source: 'manual' },
          { knownEntries: existing },
        );
      } catch (e) { err = e; }
      expect(err).toBeInstanceOf(DuplicateFileEntryError);
      if (err instanceof DuplicateFileEntryError) expect(err.existing.id).toBe('e1');
      // 不应该写 entries
      const appends = postMock.mock.calls
        .map((c) => c[0] as Call)
        .filter((c) => c.action === 'appendJsonl' && c.relativePath === XINGYE_FILES_ENTRIES_JSONL);
      expect(appends).toHaveLength(0);
    });

    it('does not dedupe across different folders', async () => {
      const existing = [makeEntry({ id: 'e1', title: '师父的话', folderId: 'fold-other' })];
      postMock.mockResolvedValue({ ok: true });
      const row = await appendFileEntry(
        'agent-x',
        { folderId: 'fold-1', title: '师父的话', body: 'b', source: 'manual' },
        { knownEntries: existing },
      );
      expect(row.title).toBe('师父的话');
      const append = lastCall('appendJsonl');
      expect(append.relativePath).toBe(XINGYE_FILES_ENTRIES_JSONL);
    });

    it('skipDedupe=true bypasses dedupe (user clicked "still create")', async () => {
      const existing = [makeEntry({ id: 'e1', title: '师父的话', folderId: 'fold-1' })];
      postMock.mockResolvedValue({ ok: true });
      const row = await appendFileEntry(
        'agent-x',
        { folderId: 'fold-1', title: '师父的话', body: 'b', source: 'manual' },
        { knownEntries: existing, skipDedupe: true },
      );
      expect(row.title).toBe('师父的话');
    });

    it('without knownEntries reads listJsonl(entries) once', async () => {
      // (1) listFileEntries inside appendFileEntry's dedupe path
      postMock.mockResolvedValueOnce({ ok: true, records: [] });
      // (2) appendJsonl
      postMock.mockResolvedValueOnce({ ok: true });
      // (3) bumpFolderUpdatedAtBestEffort → readJson(folders); make it fail-safe
      postMock.mockResolvedValueOnce({ ok: true, missing: true });
      await appendFileEntry('agent-x', { folderId: 'fold-1', title: '新条目', body: 'b' });
      const lists = postMock.mock.calls
        .map((c) => c[0] as Call)
        .filter((c) => c.action === 'listJsonl' && c.relativePath === XINGYE_FILES_ENTRIES_JSONL);
      expect(lists).toHaveLength(1);
    });
  });

  describe('resolveTargetEntry', () => {
    const entries: XingyeFileEntry[] = [
      {
        id: 'e1', key: 'e1', agentId: 'agent-x', folderId: 'fold-1',
        title: '师父说过的几句话', body: '', createdAt: '',
      },
    ];

    it('matches by targetEntryId', () => {
      expect(resolveTargetEntry(entries, { targetEntryId: 'e1' })?.id).toBe('e1');
    });

    it('matches by matchTitle (normalized exact)', () => {
      expect(resolveTargetEntry(entries, { matchTitle: '《师父说过的几句话》' })?.id).toBe('e1');
    });

    it('returns null when neither matches', () => {
      expect(resolveTargetEntry(entries, { matchTitle: '完全不相干' })).toBeNull();
    });

    it('returns null when nothing provided', () => {
      expect(resolveTargetEntry(entries, {})).toBeNull();
    });
  });

  describe('confirmFileDraft action=update', () => {
    const TARGET_ENTRY = {
      id: 'e-target', key: 'e-target', agentId: 'agent-x', folderId: 'fold-1',
      title: '师父的话', body: '老段落 1', createdAt: '2026-05-15T10:00:00.000Z',
      updatedAt: '2026-05-15T10:00:00.000Z', source: 'manual',
    };

    it('appends bodyAppend to target entry and removes draft', async () => {
      const draftRow = {
        id: 'd-upd', action: 'update', targetEntryId: 'e-target',
        patch: { bodyAppend: '新段落 2' },
        title: '', body: '', createdAt: '2026-05-17T12:00:00.000Z',
        source: 'xingye-heartbeat-tool',
      };
      postMock
        // listFileEntries (initial)
        .mockResolvedValueOnce({ ok: true, records: [TARGET_ENTRY] })
        // listFileDrafts
        .mockResolvedValueOnce({ ok: true, records: [draftRow] })
        // updateFileEntry → listFileEntries again
        .mockResolvedValueOnce({ ok: true, records: [TARGET_ENTRY] })
        // updateFileEntry → deleteJsonlRecord(entries)
        .mockResolvedValueOnce({ ok: true, deleted: true })
        // updateFileEntry → appendJsonl(entries)
        .mockResolvedValueOnce({ ok: true })
        // bumpFolderUpdatedAtBestEffort → readJson(folders)
        .mockResolvedValueOnce({ ok: true, missing: true })
        // deleteJsonlRecord(drafts)
        .mockResolvedValueOnce({ ok: true, deleted: true })
        // event log appendJsonl
        .mockResolvedValue({ ok: true });

      const entry = await confirmFileDraft('agent-x', 'd-upd');
      expect(entry.id).toBe('e-target');
      expect(entry.body).toBe('老段落 1\n\n新段落 2');

      // 不应该有 from-draft-* entry append
      const entryAppends = postMock.mock.calls
        .map((c) => c[0] as Call)
        .filter((c) => c.action === 'appendJsonl' && c.relativePath === XINGYE_FILES_ENTRIES_JSONL);
      // 1 个 append（来自 updateFileEntry 的"删旧 + appen 新"）
      expect(entryAppends).toHaveLength(1);
      const data = entryAppends[0].data as { id: string; body: string };
      expect(data.id).toBe('e-target');
      expect(data.body).toBe('老段落 1\n\n新段落 2');

      // drafts 应该被删
      const draftDeletes = postMock.mock.calls
        .map((c) => c[0] as Call)
        .filter((c) => c.action === 'deleteJsonlRecord' && c.relativePath === XINGYE_FILES_DRAFTS_JSONL);
      expect(draftDeletes).toHaveLength(1);
    });

    it('throws when target entry not found', async () => {
      const draftRow = {
        id: 'd-missing', action: 'update', targetEntryId: 'e-nope',
        patch: { bodyAppend: 'x' },
        title: '', body: '', createdAt: '2026-05-17T12:00:00.000Z',
        source: 'xingye-heartbeat-tool',
      };
      postMock
        .mockResolvedValueOnce({ ok: true, records: [TARGET_ENTRY] })
        .mockResolvedValueOnce({ ok: true, records: [draftRow] });
      await expect(confirmFileDraft('agent-x', 'd-missing')).rejects.toThrow(/目标条目已不存在/);
    });

    it('resolves matchTitle when targetEntryId not given', async () => {
      const draftRow = {
        id: 'd-by-name', action: 'update', matchTitle: '《师父的话》',
        patch: { summary: '新摘要' },
        title: '', body: '', createdAt: '2026-05-17T12:00:00.000Z',
        source: 'xingye-heartbeat-tool',
      };
      postMock
        .mockResolvedValueOnce({ ok: true, records: [TARGET_ENTRY] })
        .mockResolvedValueOnce({ ok: true, records: [draftRow] })
        .mockResolvedValueOnce({ ok: true, records: [TARGET_ENTRY] })
        .mockResolvedValueOnce({ ok: true, deleted: true })
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValueOnce({ ok: true, missing: true })
        .mockResolvedValue({ ok: true, deleted: true });
      const entry = await confirmFileDraft('agent-x', 'd-by-name');
      expect(entry.id).toBe('e-target');
      expect(entry.summary).toBe('新摘要');
    });
  });

  describe('confirmFileDraft action=add + dedupe', () => {
    const SEEDED_FOLDER = {
      id: 'fold-1', agentId: 'agent-x', name: '人际关系', order: 0,
      createdAt: '2026-05-15T10:00:00.000Z', updatedAt: '2026-05-15T10:00:00.000Z',
    };

    it('throws DuplicateFileEntryError when an entry with same title was added after draft was written', async () => {
      const conflictingEntry = {
        id: 'e-existing', key: 'e-existing', agentId: 'agent-x', folderId: 'fold-1',
        title: '师父的话', body: '', createdAt: '2026-05-16T10:00:00.000Z',
      };
      const draftRow = {
        id: 'd-conflict', action: 'add', title: '师父的话', body: 'b',
        folderHint: '人际关系', createdAt: '2026-05-17T12:00:00.000Z',
        source: 'xingye-heartbeat-tool',
      };
      postMock
        // listFileEntries → 已有冲突 entry
        .mockResolvedValueOnce({ ok: true, records: [conflictingEntry] })
        // listFileDrafts
        .mockResolvedValueOnce({ ok: true, records: [draftRow] })
        // ensureDefaultFileFolders → readJson(folders)
        .mockResolvedValueOnce({ ok: true, data: { folders: [SEEDED_FOLDER] } });

      let err: unknown;
      try { await confirmFileDraft('agent-x', 'd-conflict'); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(DuplicateFileEntryError);

      // 不应该写 entry，也不应该删 draft（让用户决定）
      const entryAppends = postMock.mock.calls
        .map((c) => c[0] as Call)
        .filter((c) => c.action === 'appendJsonl' && c.relativePath === XINGYE_FILES_ENTRIES_JSONL);
      expect(entryAppends).toHaveLength(0);
      const draftDeletes = postMock.mock.calls
        .map((c) => c[0] as Call)
        .filter((c) => c.action === 'deleteJsonlRecord' && c.relativePath === XINGYE_FILES_DRAFTS_JSONL);
      expect(draftDeletes).toHaveLength(0);
    });
  });
});
