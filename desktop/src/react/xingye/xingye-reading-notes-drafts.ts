/**
 * 渲染端「待确认读书批注草稿」store 助手。
 *
 * 读书批注的「已生成」列表走 xingye-app-entry-store 的通用 AppEntry 路径
 * （`apps/reading_notes/entries.jsonl`，appId='reading_notes'）。这里只挂草稿这一支：
 *
 *  - 草稿落到 `apps/reading_notes/drafts.jsonl`（与 entries 同目录、分文件）。
 *  - listReadingNoteDrafts / appendReadingNoteDraft / discardReadingNoteDraft /
 *    confirmReadingNoteDraft 四件套，发对应的 reading_notes.draft_proposed /
 *    discarded / confirmed 事件。
 *  - confirm 路径复用 appendAppEntry('reading_notes', ...)，把 metadata 还原成
 *    ReadingNoteMetadata（bookId / noteType / quote）。bookHint → bookId 解析在
 *    confirm 时由 UI 完成；helper 不强求 bookId（解析不出就让 entry 不带 bookId）。
 *  - 与 xingye-shopping-drafts.ts 同款骨架（lock + 确定性 id + dedupe）。
 */

import { appendXingyeEvent, type XingyeEventInput } from './xingye-event-log';
import { postXingyeStorage } from './xingye-storage-api';
import { createAgentXingyeStorageBackend } from './xingye-storage-backend';
import {
  appendAppEntry,
  listAppEntries,
  type AppEntry,
} from './xingye-app-entry-store';
import { originFromEntryId, withDraftConfirmLock } from './xingye-draft-confirm-lock';

const backend = createAgentXingyeStorageBackend(postXingyeStorage);

async function appendReadingNoteDraftEventBestEffort(
  agentId: string,
  input: Omit<XingyeEventInput, 'agentId'>,
): Promise<void> {
  try {
    await appendXingyeEvent(agentId, input);
  } catch (error) {
    console.warn('[xingye-reading-notes-drafts] event log append failed:', error);
  }
}

export const XINGYE_READING_NOTES_DRAFTS_JSONL = 'apps/reading_notes/drafts.jsonl';

const SAFE_AGENT_ID_RE = /^[A-Za-z0-9_-]{1,120}$/;

/** 与 lib/xingye/reading-notes-drafts.js ALLOWED_NOTE_TYPES 同步。 */
export type ReadingNoteDraftType = 'reading_note' | 'question';
const ALLOWED_NOTE_TYPES = new Set<ReadingNoteDraftType>(['reading_note', 'question']);

export type XingyePendingReadingNoteDraft = {
  id: string;
  title: string;
  body: string;
  noteType: ReadingNoteDraftType;
  /** 巡检里 agent 不知道用户私人 bookId，只能给名字 hint；UI 在 confirm 时解析。 */
  bookHint?: string;
  quoteText?: string;
  reason?: string;
  source: string;
  sourceEventIds?: string[];
  createdAt: string;
};

function assertAgentId(agentId: string, action: string): string {
  const aid = String(agentId ?? '').trim();
  if (!aid) throw new Error(`${action}失败：缺少 agentId。`);
  if (!SAFE_AGENT_ID_RE.test(aid)) {
    throw new Error(`${action}失败：agentId 格式无效（仅允许字母、数字、下划线与短横线，长度 1–120）。`);
  }
  return aid;
}

function normalizeOptionalText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, max);
}

function normalizeNoteType(value: unknown): ReadingNoteDraftType {
  return typeof value === 'string' && ALLOWED_NOTE_TYPES.has(value as ReadingNoteDraftType)
    ? (value as ReadingNoteDraftType)
    : 'reading_note';
}

function normalizeDraftRow(value: unknown): XingyePendingReadingNoteDraft | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : '';
  if (!id) return null;
  const title = normalizeOptionalText(raw.title, 160);
  if (!title) return null;
  const body = normalizeOptionalText(raw.body, 4000);
  if (!body) return null;
  const createdAt = typeof raw.createdAt === 'string' && raw.createdAt
    ? raw.createdAt
    : new Date(0).toISOString();
  const source = typeof raw.source === 'string' && raw.source.trim()
    ? raw.source.trim()
    : 'unknown';
  const eventIdsRaw = raw.sourceEventIds;
  const sourceEventIds = Array.isArray(eventIdsRaw)
    ? eventIdsRaw.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : undefined;
  return {
    id,
    title,
    body,
    noteType: normalizeNoteType(raw.noteType),
    bookHint: normalizeOptionalText(raw.bookHint, 120),
    quoteText: normalizeOptionalText(raw.quoteText, 600),
    reason: normalizeOptionalText(raw.reason, 1000),
    source,
    sourceEventIds,
    createdAt,
  };
}

function sortDrafts(
  a: XingyePendingReadingNoteDraft,
  b: XingyePendingReadingNoteDraft,
): number {
  const ta = Date.parse(a.createdAt);
  const tb = Date.parse(b.createdAt);
  if (ta !== tb && !Number.isNaN(ta) && !Number.isNaN(tb)) return tb - ta;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

export async function listReadingNoteDrafts(
  agentId: string,
): Promise<XingyePendingReadingNoteDraft[]> {
  const aid = String(agentId ?? '').trim();
  if (!aid) return [];
  try {
    const rows = await backend.listJsonl<unknown>(aid, XINGYE_READING_NOTES_DRAFTS_JSONL);
    return rows
      .map(normalizeDraftRow)
      .filter((d): d is XingyePendingReadingNoteDraft => Boolean(d))
      .sort(sortDrafts);
  } catch {
    return [];
  }
}

function newDraftId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `read-${crypto.randomUUID()}`;
  }
  return `read-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 写入一条「待确认读书批注草稿」。
 *
 * 与 appendAppEntry('reading_notes', ...) 区别：
 *  - 不写 entries.jsonl，不发 reading_notes.entry_appended；
 *  - 发出 `reading_notes.draft_proposed`，便于心跳消费者下一轮汇总。
 */
export async function appendReadingNoteDraft(
  agentId: string,
  input: {
    title: string;
    body: string;
    noteType?: ReadingNoteDraftType;
    bookHint?: string;
    quoteText?: string;
    reason?: string;
    source: string;
    sourceEventIds?: string[];
  },
): Promise<XingyePendingReadingNoteDraft> {
  const aid = assertAgentId(agentId, '保存读书批注草稿');
  const title = (input.title ?? '').trim().slice(0, 160);
  if (!title) throw new Error('草稿标题不能为空。');
  const body = (input.body ?? '').trim().slice(0, 4000);
  if (!body) throw new Error('草稿正文不能为空。');
  const source = input.source.trim();
  if (!source) throw new Error('草稿来源 (source) 不能为空。');
  const noteType = normalizeNoteType(input.noteType);
  const bookHint = normalizeOptionalText(input.bookHint, 120);
  const quoteText = normalizeOptionalText(input.quoteText, 600);
  const reason = normalizeOptionalText(input.reason, 1000);
  const sourceEventIds = Array.isArray(input.sourceEventIds)
    ? input.sourceEventIds.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : undefined;
  const id = newDraftId();
  const createdAt = new Date().toISOString();
  const row: XingyePendingReadingNoteDraft & { key: string } = {
    id, key: id, title, body, noteType, bookHint, quoteText, reason, source, sourceEventIds, createdAt,
  };
  await backend.appendJsonl(aid, XINGYE_READING_NOTES_DRAFTS_JSONL, row);
  await appendReadingNoteDraftEventBestEffort(aid, {
    type: 'reading_notes.draft_proposed',
    source,
    subjectId: id,
    payload: {
      draftId: id,
      title,
      noteType,
      bookHint: bookHint ?? null,
      hasQuote: Boolean(quoteText),
      reason: reason ?? null,
      sourceEventIds: sourceEventIds ?? [],
    },
  });
  return { id, title, body, noteType, bookHint, quoteText, reason, source, sourceEventIds, createdAt };
}

export async function discardReadingNoteDraft(agentId: string, draftId: string): Promise<boolean> {
  const aid = assertAgentId(agentId, '丢弃读书批注草稿');
  const did = draftId.trim();
  if (!did) throw new Error('丢弃草稿失败：缺少草稿 id。');
  const deleted = await backend.deleteJsonlRecord(aid, XINGYE_READING_NOTES_DRAFTS_JSONL, did);
  if (deleted) {
    await appendReadingNoteDraftEventBestEffort(aid, {
      type: 'reading_notes.draft_discarded',
      source: 'xingye-reading-notes-drafts',
      subjectId: did,
      payload: { draftId: did },
    });
  }
  return deleted;
}

/** Confirmed-from-draft entry 用确定性 id：让 confirm retry 走幂等查重路径。 */
function readingNoteEntryIdFromDraftId(draftId: string): string {
  return `from-draft-${draftId}`;
}

/**
 * 用户在「待确认草稿」区点「确认生成」时调用：
 *   1. entry id 用 `from-draft-${draftId}`；先 listAppEntries('reading_notes') 查重，
 *      已有同 id 的 entry（上一次 confirm 写完 entry 但 delete draft 失败）→ 复用，
 *      跳过 appendAppEntry；
 *   2. 否则 appendAppEntry('reading_notes', ...) 写入 entries（自动发
 *      reading_notes.entry_appended），传 `id` 选项作为确定性 id；
 *   3. 从 drafts 删掉；删除失败仅 warn——重试时 (1) 兜底防重；
 *   4. 发 reading_notes.draft_confirmed。
 *
 * `edits.bookId`：UI 在 confirm 时按 bookHint 在本地书架解析出的 bookId；helper
 * 本身不做解析（不依赖 book-catalog import），调用方传 null/undefined 即代表
 * 「未匹配」——entry 不带 bookId，UI 落到「未归类批注」区。
 *
 * 进程内 per-draft 锁防止 UI 双击/多窗口产生并发 confirm。
 */
export async function confirmReadingNoteDraft(
  agentId: string,
  draftId: string,
  edits?: {
    bookId?: string | null;
    title?: string;
    body?: string;
    noteType?: ReadingNoteDraftType;
    quoteText?: string | null;
  },
): Promise<AppEntry> {
  const aid = assertAgentId(agentId, '确认读书批注草稿');
  const did = draftId.trim();
  if (!did) throw new Error('确认草稿失败：缺少草稿 id。');
  return withDraftConfirmLock(`reading_notes::${aid}::${did}`, async () => {
    const expectedEntryId = readingNoteEntryIdFromDraftId(did);
    const existingEntry = (await listAppEntries(aid, 'reading_notes')).find((e) => e.id === expectedEntryId);

    const draft = (await listReadingNoteDrafts(aid)).find((d) => d.id === did);
    if (!draft && !existingEntry) {
      throw new Error('确认草稿失败：草稿不存在或已被丢弃。');
    }

    let entry: AppEntry;
    if (existingEntry) {
      entry = existingEntry;
    } else if (draft) {
      const title = ((edits?.title ?? draft.title) || '').trim().slice(0, 160);
      if (!title) throw new Error('确认草稿失败：标题不能为空。');
      const body = ((edits?.body ?? draft.body) || '').trim().slice(0, 4000);
      if (!body) throw new Error('确认草稿失败：正文不能为空。');
      const noteType = normalizeNoteType(edits?.noteType ?? draft.noteType);

      const resolveQuote = (): string | undefined => {
        if (edits && Object.prototype.hasOwnProperty.call(edits, 'quoteText')) {
          if (edits.quoteText === null) return undefined;
          if (typeof edits.quoteText === 'string') return normalizeOptionalText(edits.quoteText, 600);
        }
        return draft.quoteText;
      };
      const quoteText = resolveQuote();

      /**
       * bookId 显式传 null 表示「UI 解析不出 bookHint，落地为未归类批注」；
       * 显式传 string → 用之；undefined（一般 UI 默认不传）→ 也走未归类。
       */
      const bookId = typeof edits?.bookId === 'string' && edits.bookId.trim()
        ? edits.bookId.trim()
        : '';

      const metadata: Record<string, unknown> = { noteType };
      if (bookId) metadata.bookId = bookId;
      if (quoteText) metadata.quote = { text: quoteText, source: 'manual' };

      entry = await appendAppEntry(aid, 'reading_notes', {
        id: expectedEntryId,
        title,
        content: body,
        metadata,
        source: 'xingye-heartbeat-confirmed',
      });
    } else {
      throw new Error('确认草稿失败：草稿不存在或已被丢弃。');
    }

    try {
      await backend.deleteJsonlRecord(aid, XINGYE_READING_NOTES_DRAFTS_JSONL, did);
    } catch (error) {
      console.warn('[xingye-reading-notes-drafts] confirm draft: failed to delete draft after entry append:', error);
    }
    await appendReadingNoteDraftEventBestEffort(aid, {
      type: 'reading_notes.draft_confirmed',
      source: 'xingye-reading-notes-drafts',
      subjectId: did,
      payload: { draftId: did, entryId: entry.id, title: entry.title, origin: originFromEntryId(entry.id) },
    });
    return entry;
  });
}
