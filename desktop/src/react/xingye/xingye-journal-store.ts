import { postXingyeStorage } from './xingye-storage-api';
import { createAgentXingyeStorageBackend } from './xingye-storage-backend';
import { appendXingyeEvent, type XingyeEventInput } from './xingye-event-log';

const backend = createAgentXingyeStorageBackend(postXingyeStorage);

async function appendJournalEventBestEffort(
  agentId: string,
  input: Omit<XingyeEventInput, 'agentId'>,
): Promise<void> {
  try {
    await appendXingyeEvent(agentId, input);
  } catch (error) {
    console.warn('[xingye-journal-store] event log append failed:', error);
  }
}

/** 相对路径位于 HANA_HOME/agents/{agentId}/xingye/ 下 */
export const XINGYE_JOURNAL_ENTRIES_JSONL = 'journal/entries.jsonl';

/**
 * 心跳巡检（或其他自动来源）产出的「待确认日记草稿」存放路径。
 *
 * 与 entries.jsonl 分文件：
 *  - entries.jsonl 只放用户确认过的、出现在「已生成」列表的最终日记。
 *  - drafts.jsonl 是自动来源（如 agent 心跳）刚生成、未经用户确认的候选；
 *    始终先落盘后再呈现，避免用户「没立刻点开页面」而丢草稿。
 *  - 确认后通过 confirmJournalDraft 原子地：先 append 到 entries，再从 drafts 删掉；
 *    丢弃通过 discardJournalDraft 直接从 drafts 移除，不进 entries 也不发 entry_appended。
 */
export const XINGYE_JOURNAL_DRAFTS_JSONL = 'journal/drafts.jsonl';

/** 与 server/routes/xingye-storage.js SAFE_AGENT_ID_RE 一致 */
const SAFE_AGENT_ID_RE = /^[A-Za-z0-9_-]{1,120}$/;

export type XingyeJournalEntry = {
  id: string;
  /** ISO 日期（YYYY-MM-DD，按创建时刻本地日历） */
  dayKey: string;
  title: string;
  body: string;
  createdAt: string;
  /** 心情短语（2–6 字），如「平淡 / 想他 / 安静」；可选 */
  mood?: string;
};

export type XingyeJournalDraft = {
  id: string;
  dayKey: string;
  title: string;
  body: string;
  /** Optional mood, same shape as final entry */
  mood?: string;
  /** Why the draft was proposed — shown to the user before they confirm */
  reason?: string;
  /** Producer (e.g. 'xingye-heartbeat')；用于 UI 区分来源 */
  source: string;
  /** Event ids that motivated this draft (for traceability)；可空 */
  sourceEventIds?: string[];
  createdAt: string;
};

function newJournalId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `j-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

function localDayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function normalizeRow(value: unknown): XingyeJournalEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : '';
  if (!id) return null;
  const dayKey = typeof raw.dayKey === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.dayKey) ? raw.dayKey : '';
  if (!dayKey) return null;
  const title = typeof raw.title === 'string' ? raw.title : '无标题';
  const body = typeof raw.body === 'string' ? raw.body : '';
  const createdAt = typeof raw.createdAt === 'string' && raw.createdAt ? raw.createdAt : new Date(0).toISOString();
  const moodRaw = raw.mood;
  const mood = typeof moodRaw === 'string' && moodRaw.trim() ? moodRaw.trim().slice(0, 24) : undefined;
  return { id, dayKey, title, body, createdAt, mood };
}

function sortJournalEntries(a: XingyeJournalEntry, b: XingyeJournalEntry): number {
  if (a.dayKey !== b.dayKey) return a.dayKey < b.dayKey ? 1 : -1;
  const ta = Date.parse(a.createdAt);
  const tb = Date.parse(b.createdAt);
  if (ta !== tb) return Number.isNaN(tb) || Number.isNaN(ta) ? 0 : tb - ta;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

export async function listJournalEntries(agentId: string): Promise<XingyeJournalEntry[]> {
  const aid = agentId.trim();
  if (!aid) return [];
  try {
    const rows = await backend.listJsonl<unknown>(aid, XINGYE_JOURNAL_ENTRIES_JSONL);
    return rows
      .map(normalizeRow)
      .filter((e): e is XingyeJournalEntry => Boolean(e))
      .sort(sortJournalEntries);
  } catch {
    return [];
  }
}

export async function appendJournalEntry(
  agentId: string,
  input: { title: string; body: string; dayKey?: string; mood?: string },
): Promise<XingyeJournalEntry> {
  const aid = agentId.trim();
  if (!aid) {
    throw new Error('保存失败：缺少 agentId。');
  }
  if (!SAFE_AGENT_ID_RE.test(aid)) {
    throw new Error('保存失败：agentId 格式无效（仅允许字母、数字、下划线与短横线，长度 1–120）。');
  }
  const body = input.body.trim();
  if (!body) {
    throw new Error('正文不能为空。');
  }
  const now = new Date();
  const dayKey = input.dayKey && /^\d{4}-\d{2}-\d{2}$/.test(input.dayKey) ? input.dayKey : localDayKey(now);
  const title = input.title.trim() || '无标题';
  const id = newJournalId();
  const createdAt = now.toISOString();
  const mood = typeof input.mood === 'string' && input.mood.trim() ? input.mood.trim().slice(0, 24) : undefined;
  const row: XingyeJournalEntry & { key: string } = { id, key: id, dayKey, title, body, createdAt, mood };
  await backend.appendJsonl(aid, XINGYE_JOURNAL_ENTRIES_JSONL, row);
  await appendJournalEventBestEffort(aid, {
    type: 'journal.entry_appended',
    source: 'xingye-journal-store',
    subjectId: id,
    payload: { entryId: id, dayKey, title, hasMood: Boolean(mood) },
  });
  return { id, dayKey, title, body, createdAt, mood };
}

function normalizeDraftRow(value: unknown): XingyeJournalDraft | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : '';
  if (!id) return null;
  const dayKey = typeof raw.dayKey === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.dayKey) ? raw.dayKey : '';
  if (!dayKey) return null;
  const title = typeof raw.title === 'string' ? raw.title : '无标题';
  const body = typeof raw.body === 'string' ? raw.body : '';
  if (!body.trim()) return null;
  const createdAt = typeof raw.createdAt === 'string' && raw.createdAt ? raw.createdAt : new Date(0).toISOString();
  const source = typeof raw.source === 'string' && raw.source.trim() ? raw.source.trim() : 'unknown';
  const moodRaw = raw.mood;
  const mood = typeof moodRaw === 'string' && moodRaw.trim() ? moodRaw.trim().slice(0, 24) : undefined;
  const reasonRaw = raw.reason;
  const reason = typeof reasonRaw === 'string' && reasonRaw.trim() ? reasonRaw.trim() : undefined;
  const eventIdsRaw = raw.sourceEventIds;
  const sourceEventIds = Array.isArray(eventIdsRaw)
    ? eventIdsRaw.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : undefined;
  return { id, dayKey, title, body, createdAt, mood, source, reason, sourceEventIds };
}

function sortJournalDrafts(a: XingyeJournalDraft, b: XingyeJournalDraft): number {
  const ta = Date.parse(a.createdAt);
  const tb = Date.parse(b.createdAt);
  if (ta !== tb && !Number.isNaN(ta) && !Number.isNaN(tb)) return tb - ta;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

export async function listJournalDrafts(agentId: string): Promise<XingyeJournalDraft[]> {
  const aid = agentId.trim();
  if (!aid) return [];
  try {
    const rows = await backend.listJsonl<unknown>(aid, XINGYE_JOURNAL_DRAFTS_JSONL);
    return rows
      .map(normalizeDraftRow)
      .filter((d): d is XingyeJournalDraft => Boolean(d))
      .sort(sortJournalDrafts);
  } catch {
    return [];
  }
}

/**
 * 写入一条「待确认日记草稿」。
 *
 * 与 appendJournalEntry 区别：
 *  - 不写 entries.jsonl，不发 journal.entry_appended，因此不会出现在用户的日记列表里；
 *  - 发出 `journal.draft_proposed` 事件，便于心跳消费者下一轮汇总「新增 N 条日记草稿待确认」。
 */
export async function appendJournalDraft(
  agentId: string,
  input: {
    title: string;
    body: string;
    dayKey?: string;
    mood?: string;
    reason?: string;
    source: string;
    sourceEventIds?: string[];
  },
): Promise<XingyeJournalDraft> {
  const aid = agentId.trim();
  if (!aid) {
    throw new Error('保存草稿失败：缺少 agentId。');
  }
  if (!SAFE_AGENT_ID_RE.test(aid)) {
    throw new Error('保存草稿失败：agentId 格式无效（仅允许字母、数字、下划线与短横线，长度 1–120）。');
  }
  const body = input.body.trim();
  if (!body) {
    throw new Error('草稿正文不能为空。');
  }
  const source = input.source.trim();
  if (!source) {
    throw new Error('草稿来源 (source) 不能为空。');
  }
  const now = new Date();
  const dayKey = input.dayKey && /^\d{4}-\d{2}-\d{2}$/.test(input.dayKey) ? input.dayKey : localDayKey(now);
  const title = input.title.trim() || '无标题';
  const id = newJournalId();
  const createdAt = now.toISOString();
  const mood = typeof input.mood === 'string' && input.mood.trim() ? input.mood.trim().slice(0, 24) : undefined;
  const reason = typeof input.reason === 'string' && input.reason.trim() ? input.reason.trim() : undefined;
  const sourceEventIds = Array.isArray(input.sourceEventIds)
    ? input.sourceEventIds.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : undefined;
  const row: XingyeJournalDraft & { key: string } = {
    id,
    key: id,
    dayKey,
    title,
    body,
    createdAt,
    mood,
    reason,
    source,
    sourceEventIds,
  };
  await backend.appendJsonl(aid, XINGYE_JOURNAL_DRAFTS_JSONL, row);
  await appendJournalEventBestEffort(aid, {
    type: 'journal.draft_proposed',
    source,
    subjectId: id,
    payload: { draftId: id, dayKey, title, hasMood: Boolean(mood), reason: reason ?? null, sourceEventIds: sourceEventIds ?? [] },
  });
  return { id, dayKey, title, body, createdAt, mood, reason, source, sourceEventIds };
}

export async function discardJournalDraft(agentId: string, draftId: string): Promise<boolean> {
  const aid = agentId.trim();
  const did = draftId.trim();
  if (!aid) {
    throw new Error('丢弃草稿失败：缺少 agentId。');
  }
  if (!SAFE_AGENT_ID_RE.test(aid)) {
    throw new Error('丢弃草稿失败：agentId 格式无效（仅允许字母、数字、下划线与短横线，长度 1–120）。');
  }
  if (!did) {
    throw new Error('丢弃草稿失败：缺少草稿 id。');
  }
  const deleted = await backend.deleteJsonlRecord(aid, XINGYE_JOURNAL_DRAFTS_JSONL, did);
  if (deleted) {
    await appendJournalEventBestEffort(aid, {
      type: 'journal.draft_discarded',
      source: 'xingye-journal-store',
      subjectId: did,
      payload: { draftId: did },
    });
  }
  return deleted;
}

/**
 * 用户在「待确认草稿」区点「确认生成」时调用：
 *   1. 用 `edits`（可选）覆盖草稿字段；
 *   2. 通过 appendJournalEntry 写入 entries.jsonl（发 journal.entry_appended）；
 *   3. 从 drafts.jsonl 删掉这条；
 *   4. 发 journal.draft_confirmed 事件，把 draftId/entryId 配对记下。
 *
 * 如果 (2) 写入成功但 (3) 删除失败，我们宁可保留 draft 也不重复写 entry —— 用户可手动再丢弃。
 */
export async function confirmJournalDraft(
  agentId: string,
  draftId: string,
  edits?: { title?: string; body?: string; dayKey?: string; mood?: string | null },
): Promise<XingyeJournalEntry> {
  const aid = agentId.trim();
  const did = draftId.trim();
  if (!aid) {
    throw new Error('确认草稿失败：缺少 agentId。');
  }
  if (!SAFE_AGENT_ID_RE.test(aid)) {
    throw new Error('确认草稿失败：agentId 格式无效（仅允许字母、数字、下划线与短横线，长度 1–120）。');
  }
  if (!did) {
    throw new Error('确认草稿失败：缺少草稿 id。');
  }
  const drafts = await listJournalDrafts(aid);
  const draft = drafts.find((d) => d.id === did);
  if (!draft) {
    throw new Error('确认草稿失败：草稿不存在或已被丢弃。');
  }
  const titleFromEdit = typeof edits?.title === 'string' ? edits.title : undefined;
  const bodyFromEdit = typeof edits?.body === 'string' ? edits.body : undefined;
  const dayKeyFromEdit = typeof edits?.dayKey === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(edits.dayKey)
    ? edits.dayKey
    : undefined;
  /** edits.mood === null 表示「显式清空心情」；undefined 表示「保留草稿原值」。 */
  const moodFromEdit = edits && Object.prototype.hasOwnProperty.call(edits, 'mood')
    ? (edits.mood === null ? undefined : (typeof edits.mood === 'string' ? edits.mood : draft.mood))
    : draft.mood;
  const title = (titleFromEdit ?? draft.title).trim() || '无标题';
  const body = (bodyFromEdit ?? draft.body).trim();
  if (!body) {
    throw new Error('确认草稿失败：正文不能为空。');
  }
  const dayKey = dayKeyFromEdit ?? draft.dayKey;
  const entry = await appendJournalEntry(aid, { title, body, dayKey, mood: moodFromEdit ?? undefined });
  try {
    await backend.deleteJsonlRecord(aid, XINGYE_JOURNAL_DRAFTS_JSONL, did);
  } catch (error) {
    console.warn('[xingye-journal-store] confirm draft: failed to delete draft after entry append:', error);
  }
  await appendJournalEventBestEffort(aid, {
    type: 'journal.draft_confirmed',
    source: 'xingye-journal-store',
    subjectId: did,
    payload: { draftId: did, entryId: entry.id, dayKey: entry.dayKey },
  });
  return entry;
}

export async function deleteJournalEntry(agentId: string, entryId: string): Promise<boolean> {
  const aid = agentId.trim();
  const eid = entryId.trim();
  if (!aid) {
    throw new Error('删除失败：缺少 agentId。');
  }
  if (!SAFE_AGENT_ID_RE.test(aid)) {
    throw new Error('删除失败：agentId 格式无效（仅允许字母、数字、下划线与短横线，长度 1–120）。');
  }
  if (!eid) {
    throw new Error('删除失败：缺少日记 id。');
  }
  const deleted = await backend.deleteJsonlRecord(aid, XINGYE_JOURNAL_ENTRIES_JSONL, eid);
  if (deleted) {
    await appendJournalEventBestEffort(aid, {
      type: 'journal.entry_deleted',
      source: 'xingye-journal-store',
      subjectId: eid,
      payload: { entryId: eid },
    });
  }
  return deleted;
}
