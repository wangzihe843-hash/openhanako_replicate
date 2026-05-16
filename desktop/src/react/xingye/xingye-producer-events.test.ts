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
import { appendJournalEntry, deleteJournalEntry } from './xingye-journal-store';
import { appendScheduleEntry, deleteScheduleEntry } from './xingye-schedule-store';
import { appendFileEntry, deleteFileEntry } from './xingye-files-store';
import { appendMailMessage, appendMailMessages, deleteMailMessage } from './xingye-mail-store';
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
