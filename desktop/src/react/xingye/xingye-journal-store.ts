import { postXingyeStorage } from './xingye-storage-api';
import { createAgentXingyeStorageBackend } from './xingye-storage-backend';

const backend = createAgentXingyeStorageBackend(postXingyeStorage);

/** 相对路径位于 HANA_HOME/agents/{agentId}/xingye/ 下 */
export const XINGYE_JOURNAL_ENTRIES_JSONL = 'journal/entries.jsonl';

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
  return { id, dayKey, title, body, createdAt, mood };
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
  return backend.deleteJsonlRecord(aid, XINGYE_JOURNAL_ENTRIES_JSONL, eid);
}
