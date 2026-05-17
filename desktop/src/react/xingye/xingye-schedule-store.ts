import { postXingyeStorage } from './xingye-storage-api';
import { createAgentXingyeStorageBackend } from './xingye-storage-backend';
import { appendXingyeEvent, type XingyeEventInput } from './xingye-event-log';

const backend = createAgentXingyeStorageBackend(postXingyeStorage);

async function appendScheduleEventBestEffort(
  agentId: string,
  input: Omit<XingyeEventInput, 'agentId'>,
): Promise<void> {
  try {
    await appendXingyeEvent(agentId, input);
  } catch (error) {
    console.warn('[xingye-schedule-store] event log append failed:', error);
  }
}

export const XINGYE_SCHEDULE_ENTRIES_JSONL = 'schedule/entries.jsonl';

/**
 * 心跳巡检（或其他自动来源）产出的「待确认日程草稿」存放路径，与 entries 同目录、分文件。
 * 同 journal：entries.jsonl 是「已生成」列表；drafts.jsonl 是 agent 提议、用户未确认的候选。
 * 确认走 confirmScheduleDraft，丢弃走 discardScheduleDraft。
 */
export const XINGYE_SCHEDULE_DRAFTS_JSONL = 'schedule/drafts.jsonl';

const SAFE_AGENT_ID_RE = /^[A-Za-z0-9_-]{1,120}$/;

export type XingyeScheduleSource = 'manual' | 'ai';
export type XingyeScheduleStatus = 'planned' | 'done' | 'skipped';

export type XingyeScheduleEntry = {
  id: string;
  agentId: string;
  title: string;
  dateLabel: string;
  timeText?: string;
  content: string;
  note?: string;
  source: XingyeScheduleSource;
  status: XingyeScheduleStatus;
  createdAt: string;
  updatedAt: string;
  /** 事件类别：约定 / 提醒 / 自己定的 / 也许吧 / 平常；用于客户端配色，可选 */
  category?: string;
};

/**
 * 「待确认」日程草稿——server 端 `xingye_propose_draft({ module: 'schedule', ... })`
 * 产出。不含 status/source 字段（这俩是写到 entries 时才确定的；status 总是 'planned' 起，
 * source 由 confirm 路径决定）。
 */
export type XingyePendingScheduleDraft = {
  id: string;
  title: string;
  dateLabel: string;
  timeText?: string;
  content: string;
  note?: string;
  category?: string;
  /** 为什么提议这条草稿（展示给用户帮助决定是否确认）。 */
  reason?: string;
  /** Producer 标识，例：'xingye-heartbeat-tool'。 */
  source: string;
  /** 触发本草稿的 xingye event id 列表（可空，用于追溯）。 */
  sourceEventIds?: string[];
  createdAt: string;
};

export type XingyeScheduleDraft = {
  title: string;
  dateLabel: string;
  timeText?: string;
  content: string;
  note?: string;
  source: XingyeScheduleSource;
  status?: XingyeScheduleStatus;
  category?: string;
};

function newScheduleId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `sch-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeStatus(value: unknown): XingyeScheduleStatus {
  return value === 'done' || value === 'skipped' || value === 'planned' ? value : 'planned';
}

function normalizeSource(value: unknown): XingyeScheduleSource {
  return value === 'ai' ? 'ai' : 'manual';
}

function isIsoLike(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function normalizeOptionalText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text) return undefined;
  return text.slice(0, max);
}

function normalizeRow(value: unknown, expectedAgentId: string): XingyeScheduleEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : '';
  if (!id) return null;
  const agentId = typeof raw.agentId === 'string' && raw.agentId.trim() ? raw.agentId.trim() : '';
  if (agentId !== expectedAgentId) return null;
  const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim().slice(0, 160) : '';
  const dateLabel = typeof raw.dateLabel === 'string' && raw.dateLabel.trim() ? raw.dateLabel.trim().slice(0, 80) : '';
  const content = typeof raw.content === 'string' && raw.content.trim() ? raw.content.trim().slice(0, 2000) : '';
  if (!title || !dateLabel || !content) return null;
  const createdAt = typeof raw.createdAt === 'string' && isIsoLike(raw.createdAt)
    ? raw.createdAt
    : new Date(0).toISOString();
  const updatedAt = typeof raw.updatedAt === 'string' && isIsoLike(raw.updatedAt)
    ? raw.updatedAt
    : createdAt;
  return {
    id,
    agentId,
    title,
    dateLabel,
    timeText: normalizeOptionalText(raw.timeText, 80),
    content,
    note: normalizeOptionalText(raw.note, 500),
    source: normalizeSource(raw.source),
    status: normalizeStatus(raw.status),
    createdAt,
    updatedAt,
    category: normalizeOptionalText(raw.category, 24),
  };
}

function sortScheduleEntries(a: XingyeScheduleEntry, b: XingyeScheduleEntry): number {
  if (a.dateLabel !== b.dateLabel) return a.dateLabel < b.dateLabel ? -1 : 1;
  const ta = Date.parse(a.updatedAt);
  const tb = Date.parse(b.updatedAt);
  if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return tb - ta;
  return a.id.localeCompare(b.id);
}

function assertAgentId(agentId: string, action: string): string {
  const aid = agentId.trim();
  if (!aid) throw new Error(`${action}失败：缺少 agentId。`);
  if (!SAFE_AGENT_ID_RE.test(aid)) {
    throw new Error(`${action}失败：agentId 格式无效。`);
  }
  return aid;
}

function buildEntry(agentId: string, input: XingyeScheduleDraft, nowIso: string, id = newScheduleId()): XingyeScheduleEntry {
  const title = input.title.trim().slice(0, 160);
  const dateLabel = input.dateLabel.trim().slice(0, 80);
  const content = input.content.trim().slice(0, 2000);
  if (!title) throw new Error('标题不能为空。');
  if (!dateLabel) throw new Error('日期不能为空。');
  if (!content) throw new Error('内容不能为空。');
  return {
    id,
    agentId,
    title,
    dateLabel,
    timeText: normalizeOptionalText(input.timeText, 80),
    content,
    note: normalizeOptionalText(input.note, 500),
    source: normalizeSource(input.source),
    status: normalizeStatus(input.status),
    createdAt: nowIso,
    updatedAt: nowIso,
    category: normalizeOptionalText(input.category, 24),
  };
}

export async function listScheduleEntries(agentId: string): Promise<XingyeScheduleEntry[]> {
  const aid = agentId.trim();
  if (!aid) return [];
  try {
    const rows = await backend.listJsonl<unknown>(aid, XINGYE_SCHEDULE_ENTRIES_JSONL);
    return rows
      .map((row) => normalizeRow(row, aid))
      .filter((row): row is XingyeScheduleEntry => Boolean(row))
      .sort(sortScheduleEntries);
  } catch {
    return [];
  }
}

export async function appendScheduleEntry(agentId: string, input: XingyeScheduleDraft): Promise<XingyeScheduleEntry> {
  const aid = assertAgentId(agentId, '保存');
  const nowIso = new Date().toISOString();
  const entry = buildEntry(aid, input, nowIso);
  await backend.appendJsonl(aid, XINGYE_SCHEDULE_ENTRIES_JSONL, { ...entry, key: entry.id });
  await appendScheduleEventBestEffort(aid, {
    type: 'schedule.entry_appended',
    source: 'xingye-schedule-store',
    subjectId: entry.id,
    payload: {
      entryId: entry.id,
      title: entry.title,
      dateLabel: entry.dateLabel,
      entrySource: entry.source,
    },
  });
  return entry;
}

export async function deleteScheduleEntry(agentId: string, entryId: string): Promise<boolean> {
  const aid = assertAgentId(agentId, '删除');
  const eid = entryId.trim();
  if (!eid) throw new Error('删除失败：缺少日程 id。');
  const deleted = await backend.deleteJsonlRecord(aid, XINGYE_SCHEDULE_ENTRIES_JSONL, eid);
  if (deleted) {
    await appendScheduleEventBestEffort(aid, {
      type: 'schedule.entry_deleted',
      source: 'xingye-schedule-store',
      subjectId: eid,
      payload: { entryId: eid },
    });
  }
  return deleted;
}

export async function updateScheduleEntryStatus(
  agentId: string,
  entryId: string,
  status: XingyeScheduleStatus,
): Promise<XingyeScheduleEntry | null> {
  const aid = assertAgentId(agentId, '更新');
  const eid = entryId.trim();
  if (!eid) throw new Error('更新失败：缺少日程 id。');
  const current = (await listScheduleEntries(aid)).find((entry) => entry.id === eid);
  if (!current) return null;
  const updated: XingyeScheduleEntry = {
    ...current,
    status,
    updatedAt: new Date().toISOString(),
  };
  await backend.deleteJsonlRecord(aid, XINGYE_SCHEDULE_ENTRIES_JSONL, eid);
  await backend.appendJsonl(aid, XINGYE_SCHEDULE_ENTRIES_JSONL, { ...updated, key: updated.id });
  return updated;
}

// ─────────────────────────────────────────────────────────────────────────
//  Pending schedule drafts (heartbeat-proposed, awaiting user confirmation)
// ─────────────────────────────────────────────────────────────────────────

function normalizeDraftRow(value: unknown): XingyePendingScheduleDraft | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : '';
  if (!id) return null;
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  const dateLabel = typeof raw.dateLabel === 'string' ? raw.dateLabel.trim() : '';
  const content = typeof raw.content === 'string' ? raw.content.trim() : '';
  if (!title || !dateLabel || !content) return null;
  const createdAt = typeof raw.createdAt === 'string' && raw.createdAt ? raw.createdAt : new Date(0).toISOString();
  const source = typeof raw.source === 'string' && raw.source.trim() ? raw.source.trim() : 'unknown';
  const timeText = normalizeOptionalText(raw.timeText, 80);
  const note = normalizeOptionalText(raw.note, 500);
  const category = normalizeOptionalText(raw.category, 24);
  const reason = normalizeOptionalText(raw.reason, 1000);
  const eventIdsRaw = raw.sourceEventIds;
  const sourceEventIds = Array.isArray(eventIdsRaw)
    ? eventIdsRaw.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : undefined;
  return { id, title, dateLabel, timeText, content, note, category, createdAt, reason, source, sourceEventIds };
}

function sortScheduleDrafts(a: XingyePendingScheduleDraft, b: XingyePendingScheduleDraft): number {
  const ta = Date.parse(a.createdAt);
  const tb = Date.parse(b.createdAt);
  if (ta !== tb && !Number.isNaN(ta) && !Number.isNaN(tb)) return tb - ta;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

export async function listScheduleDrafts(agentId: string): Promise<XingyePendingScheduleDraft[]> {
  const aid = agentId.trim();
  if (!aid) return [];
  try {
    const rows = await backend.listJsonl<unknown>(aid, XINGYE_SCHEDULE_DRAFTS_JSONL);
    return rows
      .map(normalizeDraftRow)
      .filter((d): d is XingyePendingScheduleDraft => Boolean(d))
      .sort(sortScheduleDrafts);
  } catch {
    return [];
  }
}

export async function appendScheduleDraft(
  agentId: string,
  input: {
    title: string;
    dateLabel: string;
    content: string;
    timeText?: string;
    note?: string;
    category?: string;
    reason?: string;
    source: string;
    sourceEventIds?: string[];
  },
): Promise<XingyePendingScheduleDraft> {
  const aid = assertAgentId(agentId, '保存草稿');
  const title = input.title.trim().slice(0, 80);
  const dateLabel = input.dateLabel.trim().slice(0, 80);
  const content = input.content.trim().slice(0, 2000);
  if (!title) throw new Error('草稿标题不能为空。');
  if (!dateLabel) throw new Error('草稿日期不能为空。');
  if (!content) throw new Error('草稿正文不能为空。');
  const source = input.source.trim();
  if (!source) throw new Error('草稿来源 (source) 不能为空。');
  const id = newScheduleId();
  const createdAt = new Date().toISOString();
  const timeText = normalizeOptionalText(input.timeText, 80);
  const note = normalizeOptionalText(input.note, 500);
  const category = normalizeOptionalText(input.category, 24);
  const reason = normalizeOptionalText(input.reason, 1000);
  const sourceEventIds = Array.isArray(input.sourceEventIds)
    ? input.sourceEventIds.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : undefined;
  const row: XingyePendingScheduleDraft & { key: string } = {
    id,
    key: id,
    title,
    dateLabel,
    timeText,
    content,
    note,
    category,
    createdAt,
    reason,
    source,
    sourceEventIds,
  };
  await backend.appendJsonl(aid, XINGYE_SCHEDULE_DRAFTS_JSONL, row);
  await appendScheduleEventBestEffort(aid, {
    type: 'schedule.draft_proposed',
    source,
    subjectId: id,
    payload: { draftId: id, title, dateLabel, reason: reason ?? null, sourceEventIds: sourceEventIds ?? [] },
  });
  return { id, title, dateLabel, timeText, content, note, category, createdAt, reason, source, sourceEventIds };
}

export async function discardScheduleDraft(agentId: string, draftId: string): Promise<boolean> {
  const aid = assertAgentId(agentId, '丢弃草稿');
  const did = draftId.trim();
  if (!did) throw new Error('丢弃草稿失败：缺少草稿 id。');
  const deleted = await backend.deleteJsonlRecord(aid, XINGYE_SCHEDULE_DRAFTS_JSONL, did);
  if (deleted) {
    await appendScheduleEventBestEffort(aid, {
      type: 'schedule.draft_discarded',
      source: 'xingye-schedule-store',
      subjectId: did,
      payload: { draftId: did },
    });
  }
  return deleted;
}

/**
 * 用户在「待确认草稿」区点「确认生成」时调用：先 appendScheduleEntry 写入 entries（发
 * entry_appended），再从 drafts 删掉，最后发 draft_confirmed。entries 写入失败时保留
 * draft 不重复写。
 */
export async function confirmScheduleDraft(
  agentId: string,
  draftId: string,
  edits?: {
    title?: string;
    dateLabel?: string;
    content?: string;
    timeText?: string | null;
    note?: string | null;
    category?: string | null;
  },
): Promise<XingyeScheduleEntry> {
  const aid = assertAgentId(agentId, '确认草稿');
  const did = draftId.trim();
  if (!did) throw new Error('确认草稿失败：缺少草稿 id。');
  const draft = (await listScheduleDrafts(aid)).find((d) => d.id === did);
  if (!draft) throw new Error('确认草稿失败：草稿不存在或已被丢弃。');

  const title = (edits?.title ?? draft.title).trim() || '无标题';
  const dateLabel = (edits?.dateLabel ?? draft.dateLabel).trim();
  const content = (edits?.content ?? draft.content).trim();
  if (!dateLabel) throw new Error('确认草稿失败：日期不能为空。');
  if (!content) throw new Error('确认草稿失败：内容不能为空。');
  /** edits.x === null 表示「显式清空」；undefined 表示「保留 draft 原值」。 */
  const resolveOptional = (key: 'timeText' | 'note' | 'category'): string | undefined => {
    if (edits && Object.prototype.hasOwnProperty.call(edits, key)) {
      const v = edits[key];
      if (v === null) return undefined;
      if (typeof v === 'string') return v.trim() || undefined;
    }
    return draft[key];
  };

  const entry = await appendScheduleEntry(aid, {
    title,
    dateLabel,
    timeText: resolveOptional('timeText'),
    content,
    note: resolveOptional('note'),
    source: 'ai',
    status: 'planned',
    category: resolveOptional('category'),
  });
  try {
    await backend.deleteJsonlRecord(aid, XINGYE_SCHEDULE_DRAFTS_JSONL, did);
  } catch (error) {
    console.warn('[xingye-schedule-store] confirm draft: failed to delete draft after entry append:', error);
  }
  await appendScheduleEventBestEffort(aid, {
    type: 'schedule.draft_confirmed',
    source: 'xingye-schedule-store',
    subjectId: did,
    payload: { draftId: did, entryId: entry.id, dateLabel: entry.dateLabel },
  });
  return entry;
}
