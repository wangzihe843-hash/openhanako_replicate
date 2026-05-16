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
