/**
 * 单测：报纸 / 独家专访「意图草稿」store（xingye-news-drafts / xingye-interview-drafts）。
 *
 * 覆盖 append / discard / confirm 三条路径的事件发射与 confirm 幂等性：
 *  - postXingyeStorage 用内存 map 替身，让 jsonl 读写真的成功；
 *  - appendXingyeEvent 单独 spy，断言发出的事件 type / payload。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const jsonStore = vi.hoisted(() => new Map<string, unknown>());
const jsonlStore = vi.hoisted(() => new Map<string, unknown[]>());

const postMock = vi.hoisted(() => vi.fn(async (body: Record<string, unknown>) => {
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
  if (action === 'write') return {};
  throw new Error(`unexpected action: ${String(action)}`);
}));

vi.mock('./xingye-storage-api', () => ({
  postXingyeStorage: postMock,
}));

const appendEventMock = vi.hoisted(() =>
  vi.fn(async (agentId: string, input: Record<string, unknown>) => ({
    id: `e-${Math.random().toString(36).slice(2, 8)}`,
    agentId,
    ...input,
    createdAt: '2026-05-21T00:00:00.000Z',
  })),
);

vi.mock('./xingye-event-log', async () => {
  const actual = await vi.importActual<typeof import('./xingye-event-log')>('./xingye-event-log');
  return { ...actual, appendXingyeEvent: appendEventMock };
});

import {
  appendNewsDraft,
  confirmNewsDraftWithEntry,
  discardNewsDraft,
  listNewsDrafts,
} from './xingye-news-drafts';
import {
  appendInterviewDraft,
  confirmInterviewDraftWithEntry,
  discardInterviewDraft,
  listInterviewDrafts,
} from './xingye-interview-drafts';
import { listAppEntries } from './xingye-app-entry-store';
import { listSecretSpaceRecords } from './xingye-secret-space-store';
import { __resetDraftConfirmLockForTests } from './xingye-draft-confirm-lock';
import type { NewsEntryMetadata } from './xingye-news-types';
import type { SecretInterviewMetadata } from './xingye-secret-space-interview-types';

const NEWS_META: NewsEntryMetadata = {
  issueDate: '2026-05-21T00:00:00.000Z',
  masthead: '《边境暮报》',
  sections: [
    { kind: 'headline_world', title: '今日要闻', body: '边境的清晨照常落了一层薄霜。' },
    { kind: 'weather', title: '今日天气', body: '晴。' },
  ],
};

const INTERVIEW_META: SecretInterviewMetadata = {
  recordedAt: '2026-05-21T00:00:00.000Z',
  title: '专访 · 一个冬天',
  hostName: '本刊记者',
  hostIntro: '演播室里只点了一盏灯。',
  questions: [],
  backstage: '相机关了之后，TA 沉默了很久。',
};

function eventsOfType(type: string): Record<string, unknown>[] {
  return appendEventMock.mock.calls
    .map((c) => c[1] as Record<string, unknown>)
    .filter((input) => input.type === type);
}

beforeEach(() => {
  jsonStore.clear();
  jsonlStore.clear();
  postMock.mockClear();
  appendEventMock.mockClear();
  __resetDraftConfirmLockForTests();
});

describe('xingye-news-drafts', () => {
  it('appendNewsDraft writes a row and emits news.draft_proposed', async () => {
    const draft = await appendNewsDraft('agent-a', {
      angle: '想看看城里最近的世态',
      reason: '攒了够一期的进展',
      source: 'xingye-heartbeat-tool',
    });
    expect(draft.angle).toBe('想看看城里最近的世态');
    expect(await listNewsDrafts('agent-a')).toHaveLength(1);

    const proposed = eventsOfType('news.draft_proposed');
    expect(proposed).toHaveLength(1);
    expect(proposed[0]).toMatchObject({
      source: 'xingye-heartbeat-tool',
      subjectId: draft.id,
      payload: { draftId: draft.id, angle: '想看看城里最近的世态' },
    });
  });

  it('discardNewsDraft removes the row and emits news.draft_discarded only when something was deleted', async () => {
    const draft = await appendNewsDraft('agent-a', { source: 'xingye-heartbeat-tool' });
    appendEventMock.mockClear();

    expect(await discardNewsDraft('agent-a', draft.id)).toBe(true);
    expect(eventsOfType('news.draft_discarded')).toHaveLength(1);
    expect(await listNewsDrafts('agent-a')).toHaveLength(0);

    appendEventMock.mockClear();
    expect(await discardNewsDraft('agent-a', draft.id)).toBe(false);
    expect(eventsOfType('news.draft_discarded')).toHaveLength(0);
  });

  it('confirmNewsDraftWithEntry appends a from-draft entry, emits draft_confirmed, and is idempotent', async () => {
    const draft = await appendNewsDraft('agent-a', {
      angle: 'x',
      source: 'xingye-heartbeat-tool',
    });
    appendEventMock.mockClear();

    const entry = await confirmNewsDraftWithEntry('agent-a', draft.id, NEWS_META);
    expect(entry.id).toBe(`from-draft-${draft.id}`);
    expect(entry.title).toBe('《边境暮报》');
    /** appendAppEntry 自动发 news.entry_appended（origin=auto），confirm 再发 news.draft_confirmed。 */
    expect(eventsOfType('news.entry_appended')).toHaveLength(1);
    expect(eventsOfType('news.entry_appended')[0].payload).toMatchObject({ origin: 'auto' });
    expect(eventsOfType('news.draft_confirmed')[0]).toMatchObject({
      subjectId: draft.id,
      payload: { draftId: draft.id, entryId: entry.id, origin: 'auto' },
    });
    /** 草稿已删，entry 已落。 */
    expect(await listNewsDrafts('agent-a')).toHaveLength(0);
    expect(await listAppEntries('agent-a', 'news')).toHaveLength(1);

    /** 幂等：重塞 draft 模拟「上次删草稿失败」，二次 confirm 不产出第二条 entry。 */
    jsonlStore.set('agent-a|apps/news/drafts.jsonl', [
      { id: draft.id, key: draft.id, angle: 'x', source: 'xingye-heartbeat-tool', createdAt: new Date().toISOString() },
    ]);
    appendEventMock.mockClear();
    const again = await confirmNewsDraftWithEntry('agent-a', draft.id, NEWS_META);
    expect(again.id).toBe(entry.id);
    expect(await listAppEntries('agent-a', 'news')).toHaveLength(1);
    expect(eventsOfType('news.entry_appended')).toHaveLength(0);
    expect(eventsOfType('news.draft_confirmed')).toHaveLength(1);
  });
});

describe('xingye-interview-drafts', () => {
  it('appendInterviewDraft writes a row and emits interview.draft_proposed', async () => {
    const draft = await appendInterviewDraft('agent-a', {
      userQuestion: '关于那次离开，你后悔过吗',
      source: 'xingye-heartbeat-tool',
    });
    expect(await listInterviewDrafts('agent-a')).toHaveLength(1);
    const proposed = eventsOfType('interview.draft_proposed');
    expect(proposed).toHaveLength(1);
    expect(proposed[0]).toMatchObject({
      subjectId: draft.id,
      payload: { draftId: draft.id, userQuestion: '关于那次离开，你后悔过吗' },
    });
  });

  it('discardInterviewDraft removes the row and emits interview.draft_discarded', async () => {
    const draft = await appendInterviewDraft('agent-a', { source: 'xingye-heartbeat-tool' });
    appendEventMock.mockClear();
    expect(await discardInterviewDraft('agent-a', draft.id)).toBe(true);
    expect(eventsOfType('interview.draft_discarded')).toHaveLength(1);
    expect(await listInterviewDrafts('agent-a')).toHaveLength(0);
  });

  it('confirmInterviewDraftWithEntry appends an interview record, emits draft_confirmed, and is idempotent', async () => {
    const draft = await appendInterviewDraft('agent-a', { source: 'xingye-heartbeat-tool' });
    appendEventMock.mockClear();

    const result = await confirmInterviewDraftWithEntry('agent-a', draft.id, INTERVIEW_META);
    expect(result.recordId).toBe(`from-draft-${draft.id}`);
    /** appendSecretSpaceRecord 对 interview 类目发 interview.entry_appended。 */
    expect(eventsOfType('interview.entry_appended')).toHaveLength(1);
    expect(eventsOfType('interview.draft_confirmed')[0]).toMatchObject({
      subjectId: draft.id,
      payload: { draftId: draft.id, recordId: result.recordId, origin: 'auto' },
    });
    expect(await listInterviewDrafts('agent-a')).toHaveLength(0);
    expect(await listSecretSpaceRecords('agent-a', 'interview')).toHaveLength(1);

    /** 幂等：重塞 draft，二次 confirm 不产出第二条 interview 记录。 */
    jsonlStore.set('agent-a|secret-space/interview-drafts.jsonl', [
      { id: draft.id, key: draft.id, source: 'xingye-heartbeat-tool', createdAt: new Date().toISOString() },
    ]);
    appendEventMock.mockClear();
    const again = await confirmInterviewDraftWithEntry('agent-a', draft.id, INTERVIEW_META);
    expect(again.recordId).toBe(result.recordId);
    expect(await listSecretSpaceRecords('agent-a', 'interview')).toHaveLength(1);
    expect(eventsOfType('interview.entry_appended')).toHaveLength(0);
    expect(eventsOfType('interview.draft_confirmed')).toHaveLength(1);
  });
});
