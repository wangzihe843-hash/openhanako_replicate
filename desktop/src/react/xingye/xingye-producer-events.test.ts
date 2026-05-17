/**
 * Producer 契约测试：覆盖所有写入 event log 的 store 模块，确认 type/source/subjectId 三件套正确。
 * - postXingyeStorage 用内存 map 替身，让写 jsonl 真的成功；
 * - appendXingyeEvent 单独 spy，避免 event log 写盘交叉污染断言。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const jsonStore = vi.hoisted(() => new Map<string, unknown>());
const jsonlStore = vi.hoisted(() => new Map<string, unknown[]>());

const postMock = vi.hoisted(() => vi.fn(async (body: Record<string, unknown>) => {
  // Response shapes match xingye-storage-backend.ts (data.data / data.records / data.deleted).
  const agentId = typeof body.agentId === 'string' ? body.agentId : '';
  const relativePath = typeof body.relativePath === 'string' ? body.relativePath : '';
  const key = `${agentId}|${relativePath}`;
  const action = body.action;
  if (action === 'readJson') {
    const data = jsonStore.get(key);
    if (data == null) return { missing: true };
    return { data };
  }
  if (action === 'writeJson') { jsonStore.set(key, body.data); return {}; }
  if (action === 'listJsonl') return { records: jsonlStore.get(key) ?? [] };
  if (action === 'appendJsonl') {
    const rows = (jsonlStore.get(key) ?? []) as unknown[];
    rows.push(body.data);
    jsonlStore.set(key, rows);
    return {};
  }
  if (action === 'writeJsonl') {
    jsonlStore.set(key, Array.isArray(body.records) ? body.records : []);
    return {};
  }
  if (action === 'deleteJsonlRecord') {
    const rows = (jsonlStore.get(key) ?? []) as Array<Record<string, unknown>>;
    const id = String(body.recordId ?? '');
    const next = rows.filter((row) => row.id !== id && row.key !== id);
    const deleted = next.length !== rows.length;
    jsonlStore.set(key, next);
    return { deleted };
  }
  if (action === 'write') {
    // raw text write used by secret-space delete path — not exercised here.
    return {};
  }
  throw new Error(`unexpected action: ${String(action)}`);
}));

vi.mock('./xingye-storage-api', () => ({
  postXingyeStorage: postMock,
}));

const appendEventMock = vi.hoisted(() =>
  vi.fn(async (agentId: string, input: Record<string, unknown>) => ({
    id: 'e-1', agentId, ...input, createdAt: '2026-05-16T00:00:00.000Z',
  })),
);

vi.mock('./xingye-event-log', async () => {
  const actual = await vi.importActual<typeof import('./xingye-event-log')>('./xingye-event-log');
  return { ...actual, appendXingyeEvent: appendEventMock };
});

// Imports below must come AFTER the vi.mock calls.
import { createXingyeMomentStore } from './xingye-moments-store';
import { createMemoryXingyeStorageBackend } from './xingye-storage-backend';
import { createXingyeAppEntryStore } from './xingye-app-entry-store';
import {
  appendJournalDraft,
  appendJournalEntry,
  confirmJournalDraft,
  deleteJournalEntry,
  discardJournalDraft,
} from './xingye-journal-store';
import {
  appendScheduleDraft,
  appendScheduleEntry,
  confirmScheduleDraft,
  deleteScheduleEntry,
  discardScheduleDraft,
} from './xingye-schedule-store';
import {
  appendFileDraft,
  appendFileEntry,
  confirmFileDraft,
  deleteFileEntry,
  discardFileDraft,
  ensureDefaultFileFolders,
} from './xingye-files-store';
import {
  appendSecretSpaceDraft,
  confirmSecretSpaceDraft,
  discardSecretSpaceDraft,
} from './xingye-secret-space-drafts';
import {
  appendMailDraft,
  appendMailMessage,
  appendMailMessages,
  confirmMailDraft,
  deleteMailMessage,
  discardMailDraft,
  type XingyeMailProfile,
} from './xingye-mail-store';
import {
  appendShoppingDraft,
  confirmShoppingDraft,
  discardShoppingDraft,
} from './xingye-shopping-drafts';
import {
  appendMmChatTurnsToSession,
  saveMmChatPersistence,
  type XingyeMmChatPersistedV1,
} from './xingye-mm-chat-store';

beforeEach(() => {
  jsonStore.clear();
  jsonlStore.clear();
  postMock.mockClear();
  appendEventMock.mockClear();
});

function lastEvent() {
  expect(appendEventMock).toHaveBeenCalled();
  const last = appendEventMock.mock.calls[appendEventMock.mock.calls.length - 1];
  return { agentId: last[0], input: last[1] as Record<string, unknown> };
}

describe('producer contract: moments-store', () => {
  it('emits moment.created on createPost and moment.deleted on deletePost', async () => {
    const memBackend = createMemoryXingyeStorageBackend();
    const store = createXingyeMomentStore(memBackend, {
      idFactory: (() => {
        const seen = new Map<string, number>();
        return (prefix: string) => {
          const n = (seen.get(prefix) ?? 0) + 1;
          seen.set(prefix, n);
          return `${prefix}-${n}`;
        };
      })(),
      now: () => '2026-05-16T00:00:00.000Z',
    });

    const post = await store.createPost({
      authorAgentId: 'agent-a',
      authorName: 'Hanako',
      content: 'first',
    });

    expect(post?.id).toBe('moment-1');
    expect(lastEvent()).toMatchObject({
      agentId: 'agent-a',
      input: {
        type: 'moment.created',
        source: 'xingye-moments-store',
        subjectId: 'moment-1',
      },
    });

    appendEventMock.mockClear();
    await store.deletePost('agent-a', 'moment-1');
    expect(lastEvent()).toMatchObject({
      agentId: 'agent-a',
      input: {
        type: 'moment.deleted',
        source: 'xingye-moments-store',
        subjectId: 'moment-1',
        payload: { postId: 'moment-1' },
      },
    });
  });
});

describe('producer contract: app-entry-store', () => {
  it.each([
    ['divination', 'divination.entry_appended', 'divination.entry_deleted'],
    ['shopping', 'shopping.entry_appended', 'shopping.entry_deleted'],
    ['reading_notes', 'reading_notes.entry_appended', 'reading_notes.entry_deleted'],
  ] as const)('emits %s entry events', async (appId, appendedType, deletedType) => {
    const memBackend = createMemoryXingyeStorageBackend();
    const store = createXingyeAppEntryStore(memBackend, {
      idFactory: () => `entry-${appId}-1`,
      now: () => '2026-05-16T00:00:00.000Z',
    });

    await store.appendEntry('agent-a', appId, { title: 'T', content: 'C' });
    expect(lastEvent().input).toMatchObject({
      type: appendedType,
      source: 'xingye-app-entry-store',
      subjectId: `entry-${appId}-1`,
      payload: { appId, entryId: `entry-${appId}-1`, title: 'T' },
    });

    appendEventMock.mockClear();
    await store.deleteEntry('agent-a', appId, `entry-${appId}-1`);
    expect(lastEvent().input).toMatchObject({
      type: deletedType,
      source: 'xingye-app-entry-store',
      subjectId: `entry-${appId}-1`,
    });
  });

  it('does not emit events for the diary appId', async () => {
    const memBackend = createMemoryXingyeStorageBackend();
    const store = createXingyeAppEntryStore(memBackend, {
      idFactory: () => 'diary-1',
      now: () => '2026-05-16T00:00:00.000Z',
    });

    await store.appendEntry('agent-a', 'diary', { title: 'T', content: 'C' });
    await store.deleteEntry('agent-a', 'diary', 'diary-1');
    expect(appendEventMock).not.toHaveBeenCalled();
  });
});

describe('producer contract: journal-store', () => {
  it('emits journal.entry_appended and journal.entry_deleted', async () => {
    const entry = await appendJournalEntry('agent-a', { title: 'T', body: 'body text' });
    expect(lastEvent().input).toMatchObject({
      type: 'journal.entry_appended',
      source: 'xingye-journal-store',
      subjectId: entry.id,
    });

    appendEventMock.mockClear();
    const ok = await deleteJournalEntry('agent-a', entry.id);
    expect(ok).toBe(true);
    expect(lastEvent().input).toMatchObject({
      type: 'journal.entry_deleted',
      source: 'xingye-journal-store',
      subjectId: entry.id,
    });
  });

  it('does not emit a delete event when the entry was not found', async () => {
    const ok = await deleteJournalEntry('agent-a', 'does-not-exist');
    expect(ok).toBe(false);
    expect(appendEventMock).not.toHaveBeenCalled();
  });
});

describe('producer contract: journal-store drafts', () => {
  it('appendJournalDraft emits journal.draft_proposed (and does NOT emit entry_appended)', async () => {
    const draft = await appendJournalDraft('agent-a', {
      title: 'patrol draft',
      body: 'a small moment worth remembering',
      source: 'xingye-heartbeat-tool',
      reason: 'recent_chat.observed mentioned the lighthouse',
    });

    expect(appendEventMock).toHaveBeenCalledTimes(1);
    expect(lastEvent().input).toMatchObject({
      type: 'journal.draft_proposed',
      source: 'xingye-heartbeat-tool',
      subjectId: draft.id,
      payload: { draftId: draft.id, title: 'patrol draft' },
    });
  });

  it('discardJournalDraft emits journal.draft_discarded only when something was deleted', async () => {
    const draft = await appendJournalDraft('agent-a', {
      title: 't',
      body: 'b',
      source: 'xingye-heartbeat-tool',
    });
    appendEventMock.mockClear();

    const ok = await discardJournalDraft('agent-a', draft.id);
    expect(ok).toBe(true);
    expect(lastEvent().input).toMatchObject({
      type: 'journal.draft_discarded',
      source: 'xingye-journal-store',
      subjectId: draft.id,
    });

    appendEventMock.mockClear();
    const okAgain = await discardJournalDraft('agent-a', draft.id);
    expect(okAgain).toBe(false);
    expect(appendEventMock).not.toHaveBeenCalled();
  });

  it('confirmJournalDraft fires entry_appended AND draft_confirmed (draft id ≠ entry id)', async () => {
    const draft = await appendJournalDraft('agent-a', {
      title: 'kept title',
      body: 'kept body',
      source: 'xingye-heartbeat-tool',
    });
    appendEventMock.mockClear();

    const entry = await confirmJournalDraft('agent-a', draft.id);
    expect(entry.id).not.toBe(draft.id);

    /** Both an entry_appended (from appendJournalEntry) and a draft_confirmed (from confirmJournalDraft) must fire. */
    const types = appendEventMock.mock.calls.map(
      (c) => (c[1] as Record<string, unknown>).type,
    );
    expect(types).toContain('journal.entry_appended');
    expect(types).toContain('journal.draft_confirmed');

    const draftConfirmed = appendEventMock.mock.calls
      .map((c) => c[1] as Record<string, unknown>)
      .find((input) => input.type === 'journal.draft_confirmed');
    expect(draftConfirmed).toMatchObject({
      subjectId: draft.id,
      payload: { draftId: draft.id, entryId: entry.id },
    });
  });
});

describe('producer contract: schedule-store', () => {
  it('emits schedule.entry_appended and schedule.entry_deleted', async () => {
    const entry = await appendScheduleEntry('agent-a', {
      title: '晚自习',
      dateLabel: '今天',
      content: '复习高等代数',
      source: 'manual',
    });
    expect(lastEvent().input).toMatchObject({
      type: 'schedule.entry_appended',
      source: 'xingye-schedule-store',
      subjectId: entry.id,
      payload: { entryId: entry.id, title: '晚自习', dateLabel: '今天', entrySource: 'manual' },
    });

    appendEventMock.mockClear();
    await deleteScheduleEntry('agent-a', entry.id);
    expect(lastEvent().input).toMatchObject({
      type: 'schedule.entry_deleted',
      source: 'xingye-schedule-store',
      subjectId: entry.id,
    });
  });
});

describe('producer contract: schedule-store drafts', () => {
  it('appendScheduleDraft emits schedule.draft_proposed only (no entry_appended)', async () => {
    const draft = await appendScheduleDraft('agent-a', {
      title: '陪我去诊所',
      dateLabel: '明天上午',
      content: '带社保卡',
      source: 'xingye-heartbeat-tool',
      reason: '她答应过',
    });
    expect(appendEventMock).toHaveBeenCalledTimes(1);
    expect(lastEvent().input).toMatchObject({
      type: 'schedule.draft_proposed',
      source: 'xingye-heartbeat-tool',
      subjectId: draft.id,
      payload: { draftId: draft.id, title: '陪我去诊所', dateLabel: '明天上午' },
    });
  });

  it('discardScheduleDraft emits draft_discarded only when something was deleted', async () => {
    const draft = await appendScheduleDraft('agent-a', {
      title: 't', dateLabel: 'd', content: 'c', source: 'xingye-heartbeat-tool',
    });
    appendEventMock.mockClear();
    const ok = await discardScheduleDraft('agent-a', draft.id);
    expect(ok).toBe(true);
    expect(lastEvent().input).toMatchObject({
      type: 'schedule.draft_discarded',
      source: 'xingye-schedule-store',
      subjectId: draft.id,
    });
    appendEventMock.mockClear();
    const okAgain = await discardScheduleDraft('agent-a', draft.id);
    expect(okAgain).toBe(false);
    expect(appendEventMock).not.toHaveBeenCalled();
  });

  it('confirmScheduleDraft fires entry_appended AND draft_confirmed (draft id ≠ entry id)', async () => {
    const draft = await appendScheduleDraft('agent-a', {
      title: 'kept', dateLabel: '明天', content: 'kept body', source: 'xingye-heartbeat-tool',
    });
    appendEventMock.mockClear();
    const entry = await confirmScheduleDraft('agent-a', draft.id);
    expect(entry.id).not.toBe(draft.id);
    const types = appendEventMock.mock.calls.map((c) => (c[1] as Record<string, unknown>).type);
    expect(types).toContain('schedule.entry_appended');
    expect(types).toContain('schedule.draft_confirmed');
    const confirmed = appendEventMock.mock.calls
      .map((c) => c[1] as Record<string, unknown>)
      .find((input) => input.type === 'schedule.draft_confirmed');
    expect(confirmed).toMatchObject({
      subjectId: draft.id,
      payload: { draftId: draft.id, entryId: entry.id },
    });
  });
});

describe('producer contract: moments-store drafts', () => {
  /** Lazy-import to keep the moments-store mock side effects scoped. */
  async function importMomentDraftFns() {
    return import('./xingye-moments-store');
  }

  it('appendMomentDraft emits moment.draft_proposed only (no moment.created)', async () => {
    const { appendMomentDraft } = await importMomentDraftFns();
    const draft = await appendMomentDraft('agent-a', {
      content: '晚风从灯塔后面绕过来。',
      reason: '她笑了',
      source: 'xingye-heartbeat-tool',
    });
    expect(lastEvent().input).toMatchObject({
      type: 'moment.draft_proposed',
      source: 'xingye-heartbeat-tool',
      subjectId: draft.id,
      payload: { draftId: draft.id, contentExcerpt: '晚风从灯塔后面绕过来。' },
    });
  });

  it('discardMomentDraft emits draft_discarded only when something was deleted', async () => {
    const { appendMomentDraft, discardMomentDraft } = await importMomentDraftFns();
    const draft = await appendMomentDraft('agent-a', {
      content: 'x', source: 'xingye-heartbeat-tool',
    });
    appendEventMock.mockClear();
    const ok = await discardMomentDraft('agent-a', draft.id);
    expect(ok).toBe(true);
    expect(lastEvent().input).toMatchObject({
      type: 'moment.draft_discarded',
      source: 'xingye-moments-store',
      subjectId: draft.id,
    });
    appendEventMock.mockClear();
    const okAgain = await discardMomentDraft('agent-a', draft.id);
    expect(okAgain).toBe(false);
    expect(appendEventMock).not.toHaveBeenCalled();
  });

  it('confirmMomentDraft fires moment.created AND moment.draft_confirmed (draft id ≠ post id)', async () => {
    const { appendMomentDraft, confirmMomentDraft } = await importMomentDraftFns();
    const draft = await appendMomentDraft('agent-a', {
      content: '内容', source: 'xingye-heartbeat-tool',
    });
    appendEventMock.mockClear();
    const post = await confirmMomentDraft('agent-a', draft.id);
    expect(post.id).not.toBe(draft.id);
    const types = appendEventMock.mock.calls.map((c) => (c[1] as Record<string, unknown>).type);
    expect(types).toContain('moment.created');
    expect(types).toContain('moment.draft_confirmed');
    const confirmed = appendEventMock.mock.calls
      .map((c) => c[1] as Record<string, unknown>)
      .find((input) => input.type === 'moment.draft_confirmed');
    expect(confirmed).toMatchObject({
      subjectId: draft.id,
      payload: { draftId: draft.id, postId: post.id },
    });
  });

  it('confirmMomentDraft forwards seedLikes/seedComments into the published post (combined flow)', async () => {
    const { appendMomentDraft, confirmMomentDraft } = await importMomentDraftFns();
    const draft = await appendMomentDraft('agent-a', {
      content: '正文', source: 'xingye-heartbeat-tool',
    });
    appendEventMock.mockClear();
    const post = await confirmMomentDraft('agent-a', draft.id, {
      seedLikes: [
        { actorType: 'agent', actorId: 'hanako', actorName: 'Hanako' },
      ],
      seedComments: [
        {
          actorType: 'virtual_contact',
          actorId: 'agent-a:vc-1',
          actorName: '夜班搭子',
          body: '又熬夜？',
        },
      ],
    });
    /** Seeds materialized on the published post — confirm path goes through createXingyeMomentPost. */
    expect(post.likes).toHaveLength(1);
    expect(post.likes[0]).toMatchObject({ actorType: 'agent', actorId: 'hanako' });
    expect(post.comments).toHaveLength(1);
    expect(post.comments[0]).toMatchObject({
      actorType: 'virtual_contact',
      actorId: 'agent-a:vc-1',
      body: '又熬夜？',
    });
    /** moment.created payload reflects seed counts (downstream surfaces / patrol summary). */
    const created = appendEventMock.mock.calls
      .map((c) => c[1] as Record<string, unknown>)
      .find((input) => input.type === 'moment.created');
    expect(created?.payload).toMatchObject({
      seedLikeCount: 1,
      seedCommentCount: 1,
      sourceKind: 'candidate',
    });
  });
});

describe('producer contract: files-store drafts', () => {
  it('appendFileDraft emits file.draft_proposed only (no entry_appended)', async () => {
    const draft = await appendFileDraft('agent-a', {
      title: '师父说过的几句话',
      body: '「不必逞强。」',
      folderHint: '人际关系',
      source: 'xingye-heartbeat-tool',
      reason: '晚上聊到师父',
    });
    expect(appendEventMock).toHaveBeenCalledTimes(1);
    expect(lastEvent().input).toMatchObject({
      type: 'file.draft_proposed',
      source: 'xingye-heartbeat-tool',
      subjectId: draft.id,
      payload: { draftId: draft.id, title: '师父说过的几句话', folderHint: '人际关系', hasBody: true },
    });
  });

  it('discardFileDraft emits draft_discarded only when something was deleted', async () => {
    const draft = await appendFileDraft('agent-a', {
      title: 'T', body: 'b', source: 'xingye-heartbeat-tool',
    });
    appendEventMock.mockClear();
    const ok = await discardFileDraft('agent-a', draft.id);
    expect(ok).toBe(true);
    expect(lastEvent().input).toMatchObject({
      type: 'file.draft_discarded',
      source: 'xingye-files-store',
      subjectId: draft.id,
    });
    appendEventMock.mockClear();
    const okAgain = await discardFileDraft('agent-a', draft.id);
    expect(okAgain).toBe(false);
    expect(appendEventMock).not.toHaveBeenCalled();
  });

  it('confirmFileDraft fires file.entry_appended AND file.draft_confirmed (draft id ≠ entry id; folder resolved from hint)', async () => {
    /** Seed folders so resolveFolderIdFromHint has something to match. */
    await ensureDefaultFileFolders('agent-a');
    appendEventMock.mockClear();
    const draft = await appendFileDraft('agent-a', {
      title: '师父说过的几句话',
      body: '「不必逞强。」',
      folderHint: '人际关系',
      source: 'xingye-heartbeat-tool',
    });
    appendEventMock.mockClear();
    const entry = await confirmFileDraft('agent-a', draft.id);
    expect(entry.id).not.toBe(draft.id);
    expect(entry.folderId).toBeTruthy();

    const types = appendEventMock.mock.calls.map((c) => (c[1] as Record<string, unknown>).type);
    expect(types).toContain('file.entry_appended');
    expect(types).toContain('file.draft_confirmed');
    const confirmed = appendEventMock.mock.calls
      .map((c) => c[1] as Record<string, unknown>)
      .find((input) => input.type === 'file.draft_confirmed');
    expect(confirmed).toMatchObject({
      subjectId: draft.id,
      payload: { draftId: draft.id, entryId: entry.id, folderId: entry.folderId },
    });
  });
});

describe('producer contract: secret-space drafts', () => {
  it('appendSecretSpaceDraft emits secret_space.draft_proposed only (no record_appended)', async () => {
    const draft = await appendSecretSpaceDraft('agent-a', {
      category: 'dream',
      body: '车一直没来。雨开始下。',
      source: 'xingye-heartbeat-tool',
      reason: '早上聊到昨夜的梦',
    });
    expect(appendEventMock).toHaveBeenCalledTimes(1);
    expect(lastEvent().input).toMatchObject({
      type: 'secret_space.draft_proposed',
      source: 'xingye-heartbeat-tool',
      subjectId: draft.id,
      payload: { draftId: draft.id, category: 'dream' },
    });
  });

  it('rejects disallowed category at append', async () => {
    await expect(appendSecretSpaceDraft('agent-a', {
      // @ts-expect-error - testing runtime rejection of disallowed category
      category: 'memory_fragment',
      body: 'x',
      source: 'xingye-heartbeat-tool',
    })).rejects.toThrow();
    expect(appendEventMock).not.toHaveBeenCalled();
  });

  it('discardSecretSpaceDraft emits draft_discarded only when something was deleted', async () => {
    const draft = await appendSecretSpaceDraft('agent-a', {
      category: 'state', body: 'x', source: 'xingye-heartbeat-tool',
    });
    appendEventMock.mockClear();
    const ok = await discardSecretSpaceDraft('agent-a', draft.id);
    expect(ok).toBe(true);
    expect(lastEvent().input).toMatchObject({
      type: 'secret_space.draft_discarded',
      source: 'xingye-secret-space-drafts',
      subjectId: draft.id,
    });
    appendEventMock.mockClear();
    const okAgain = await discardSecretSpaceDraft('agent-a', draft.id);
    expect(okAgain).toBe(false);
    expect(appendEventMock).not.toHaveBeenCalled();
  });

  it('confirmSecretSpaceDraft fires secret_space.record_appended AND secret_space.draft_confirmed', async () => {
    const draft = await appendSecretSpaceDraft('agent-a', {
      category: 'saved_item',
      body: '「不要把日子过成一道证明题。」',
      source: 'xingye-heartbeat-tool',
    });
    appendEventMock.mockClear();
    const result = await confirmSecretSpaceDraft('agent-a', draft.id);
    expect(result.category).toBe('saved_item');

    const types = appendEventMock.mock.calls.map((c) => (c[1] as Record<string, unknown>).type);
    expect(types).toContain('secret_space.record_appended');
    expect(types).toContain('secret_space.draft_confirmed');
    const confirmed = appendEventMock.mock.calls
      .map((c) => c[1] as Record<string, unknown>)
      .find((input) => input.type === 'secret_space.draft_confirmed');
    expect(confirmed).toMatchObject({
      subjectId: draft.id,
      payload: { draftId: draft.id, category: 'saved_item' },
    });
  });
});

describe('producer contract: files-store', () => {
  it('emits file.entry_appended and file.entry_deleted', async () => {
    const entry = await appendFileEntry('agent-a', {
      folderId: 'fav',
      title: '笔记',
      body: '内容',
      source: 'manual',
    });
    expect(lastEvent().input).toMatchObject({
      type: 'file.entry_appended',
      source: 'xingye-files-store',
      subjectId: entry.id,
      payload: { entryId: entry.id, folderId: 'fav', title: '笔记' },
    });

    appendEventMock.mockClear();
    await deleteFileEntry('agent-a', entry.id);
    expect(lastEvent().input).toMatchObject({
      type: 'file.entry_deleted',
      source: 'xingye-files-store',
      subjectId: entry.id,
    });
  });
});

describe('producer contract: mail-store', () => {
  it('emits a single mail.messages_appended for appendMailMessage', async () => {
    const message = await appendMailMessage('agent-a', {
      mailbox: 'inbox',
      from: { name: 'Friend', address: 'friend@hana.mail', kind: 'virtual_contact' },
      to: [{ name: 'Hanako', address: 'hanako@hana.mail' }],
      subject: 'hi',
      body: 'hello there',
      isRead: false,
      isStarred: false,
      labels: [],
    });
    expect(lastEvent().input).toMatchObject({
      type: 'mail.messages_appended',
      source: 'xingye-mail-store',
      subjectId: message.id,
      payload: { count: 1, mailbox: 'inbox', firstMessageId: message.id, fromKind: 'virtual_contact' },
    });
  });

  it('emits ONE mail.messages_appended per batch for appendMailMessages with a count', async () => {
    const drafts = Array.from({ length: 3 }, (_, i) => ({
      mailbox: 'inbox' as const,
      from: { name: 'F', address: 'f@hana.mail', kind: 'virtual_contact' as const },
      to: [{ name: 'H', address: 'h@hana.mail' }],
      subject: `s${i}`,
      body: `b${i}`,
      isRead: false,
      isStarred: false,
      labels: [],
    }));
    const out = await appendMailMessages('agent-a', drafts);
    expect(out).toHaveLength(3);
    expect(appendEventMock).toHaveBeenCalledTimes(1);
    expect(lastEvent().input).toMatchObject({
      type: 'mail.messages_appended',
      payload: { count: 3, firstMessageId: out[0].id },
    });
  });

  it('emits mail.message_deleted only when the row was actually removed', async () => {
    const message = await appendMailMessage('agent-a', {
      mailbox: 'inbox',
      from: { name: 'F', address: 'f@hana.mail', kind: 'virtual_contact' },
      to: [{ name: 'H', address: 'h@hana.mail' }],
      subject: 's',
      body: 'b',
      isRead: false,
      isStarred: false,
      labels: [],
    });
    appendEventMock.mockClear();

    const ok = await deleteMailMessage('agent-a', message.id);
    expect(ok).toBe(true);
    expect(lastEvent().input).toMatchObject({
      type: 'mail.message_deleted',
      source: 'xingye-mail-store',
      subjectId: message.id,
    });

    appendEventMock.mockClear();
    const noop = await deleteMailMessage('agent-a', message.id);
    expect(noop).toBe(false);
    expect(appendEventMock).not.toHaveBeenCalled();
  });
});

describe('producer contract: mail-store drafts', () => {
  const profile: XingyeMailProfile = {
    agentId: 'agent-a',
    address: 'hanako.x@hana.mail',
    displayName: 'Hanako',
    createdAt: '2026-05-16T00:00:00.000Z',
    updatedAt: '2026-05-16T00:00:00.000Z',
  };

  it('appendMailDraft emits mail.draft_proposed only (no messages_appended)', async () => {
    const draft = await appendMailDraft('agent-a', {
      subject: '给妈妈',
      body: '好久没回家。',
      toAddress: 'mom@hana.mail',
      source: 'xingye-heartbeat-tool',
      reason: '母亲节',
    });
    expect(appendEventMock).toHaveBeenCalledTimes(1);
    expect(lastEvent().input).toMatchObject({
      type: 'mail.draft_proposed',
      source: 'xingye-heartbeat-tool',
      subjectId: draft.id,
      payload: { draftId: draft.id, subject: '给妈妈', hasBody: true, toAddress: 'mom@hana.mail' },
    });
  });

  it('discardMailDraft emits draft_discarded only when something was deleted', async () => {
    const draft = await appendMailDraft('agent-a', {
      subject: 's', body: 'b', source: 'xingye-heartbeat-tool',
    });
    appendEventMock.mockClear();
    const ok = await discardMailDraft('agent-a', draft.id);
    expect(ok).toBe(true);
    expect(lastEvent().input).toMatchObject({
      type: 'mail.draft_discarded',
      source: 'xingye-mail-store',
      subjectId: draft.id,
    });
    appendEventMock.mockClear();
    const okAgain = await discardMailDraft('agent-a', draft.id);
    expect(okAgain).toBe(false);
    expect(appendEventMock).not.toHaveBeenCalled();
  });

  it('confirmMailDraft fires messages_appended AND mail.draft_confirmed (draft id ≠ message id)', async () => {
    const draft = await appendMailDraft('agent-a', {
      subject: '给妈妈',
      body: '好久没回家。',
      source: 'xingye-heartbeat-tool',
    });
    appendEventMock.mockClear();
    const message = await confirmMailDraft('agent-a', draft.id, profile);
    expect(message.id).not.toBe(draft.id);
    expect(message.mailbox).toBe('drafts');
    expect(message.from.kind).toBe('agent');
    expect(message.from.address).toBe(profile.address);

    const types = appendEventMock.mock.calls.map((c) => (c[1] as Record<string, unknown>).type);
    expect(types).toContain('mail.messages_appended');
    expect(types).toContain('mail.draft_confirmed');
    const confirmed = appendEventMock.mock.calls
      .map((c) => c[1] as Record<string, unknown>)
      .find((input) => input.type === 'mail.draft_confirmed');
    expect(confirmed).toMatchObject({
      subjectId: draft.id,
      payload: { draftId: draft.id, messageId: message.id, mailbox: 'drafts' },
    });
  });
});

describe('producer contract: shopping-drafts', () => {
  it('appendShoppingDraft emits shopping.draft_proposed only (no entry_appended)', async () => {
    const draft = await appendShoppingDraft('agent-a', {
      itemName: '《长安的荔枝》',
      status: 'hesitating',
      source: 'xingye-heartbeat-tool',
      reason: '她摸了三次',
    });
    expect(appendEventMock).toHaveBeenCalledTimes(1);
    expect(lastEvent().input).toMatchObject({
      type: 'shopping.draft_proposed',
      source: 'xingye-heartbeat-tool',
      subjectId: draft.id,
      payload: { draftId: draft.id, itemName: '《长安的荔枝》', status: 'hesitating' },
    });
  });

  it('discardShoppingDraft emits draft_discarded only when something was deleted', async () => {
    const draft = await appendShoppingDraft('agent-a', {
      itemName: 'X', source: 'xingye-heartbeat-tool',
    });
    appendEventMock.mockClear();
    const ok = await discardShoppingDraft('agent-a', draft.id);
    expect(ok).toBe(true);
    expect(lastEvent().input).toMatchObject({
      type: 'shopping.draft_discarded',
      source: 'xingye-shopping-drafts',
      subjectId: draft.id,
    });
    appendEventMock.mockClear();
    const okAgain = await discardShoppingDraft('agent-a', draft.id);
    expect(okAgain).toBe(false);
    expect(appendEventMock).not.toHaveBeenCalled();
  });

  it('confirmShoppingDraft fires shopping.entry_appended AND shopping.draft_confirmed (draft id ≠ entry id)', async () => {
    const draft = await appendShoppingDraft('agent-a', {
      itemName: '《长安的荔枝》', status: 'wanted', source: 'xingye-heartbeat-tool',
    });
    appendEventMock.mockClear();
    const entry = await confirmShoppingDraft('agent-a', draft.id);
    expect(entry.id).not.toBe(draft.id);
    expect(entry.appId).toBe('shopping');

    const types = appendEventMock.mock.calls.map((c) => (c[1] as Record<string, unknown>).type);
    expect(types).toContain('shopping.entry_appended');
    expect(types).toContain('shopping.draft_confirmed');
    const confirmed = appendEventMock.mock.calls
      .map((c) => c[1] as Record<string, unknown>)
      .find((input) => input.type === 'shopping.draft_confirmed');
    expect(confirmed).toMatchObject({
      subjectId: draft.id,
      payload: { draftId: draft.id, entryId: entry.id, itemName: '《长安的荔枝》' },
    });
  });
});

describe('producer contract: mm-chat-store', () => {
  it('emits ONE mm_chat.turns_appended per batch with count + lastRole', async () => {
    const seed: XingyeMmChatPersistedV1 = {
      version: 1,
      activeSessionId: 'sess-1',
      sessions: [{
        id: 'sess-1',
        title: '试探',
        preview: '',
        messages: [],
        createdAt: '2026-05-16T00:00:00.000Z',
        updatedAt: '2026-05-16T00:00:00.000Z',
      }],
    };
    await saveMmChatPersistence('agent-a', seed);
    appendEventMock.mockClear();

    await appendMmChatTurnsToSession('agent-a', 'sess-1', [
      { id: 't1', role: 'ta', text: '在吗？' },
      { id: 't2', role: 'ai', text: '在。' },
    ]);

    expect(appendEventMock).toHaveBeenCalledTimes(1);
    expect(lastEvent().input).toMatchObject({
      type: 'mm_chat.turns_appended',
      source: 'xingye-mm-chat-store',
      subjectId: 'sess-1',
      payload: { sessionId: 'sess-1', count: 2, lastRole: 'ai' },
    });
  });
});
