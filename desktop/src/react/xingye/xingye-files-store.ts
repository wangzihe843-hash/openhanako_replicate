import { postXingyeStorage } from './xingye-storage-api';
import { createAgentXingyeStorageBackend } from './xingye-storage-backend';
import { appendXingyeEvent, type XingyeEventInput } from './xingye-event-log';

const backend = createAgentXingyeStorageBackend(postXingyeStorage);

async function appendFileEventBestEffort(
  agentId: string,
  input: Omit<XingyeEventInput, 'agentId'>,
): Promise<void> {
  try {
    await appendXingyeEvent(agentId, input);
  } catch (error) {
    console.warn('[xingye-files-store] event log append failed:', error);
  }
}

/** 相对路径位于 HANA_HOME/agents/{agentId}/xingye/ 下 */
export const XINGYE_FILES_FOLDERS_JSON = 'files/folders.json';
export const XINGYE_FILES_ENTRIES_JSONL = 'files/entries.jsonl';

/**
 * 心跳巡检（或其他自动来源）产出的「待确认资料柜草稿」存放路径，与 entries 同目录、分文件。
 *
 * 关键约束：草稿**不带** folderId —— 巡检里 agent 不知道用户私人的 folder uuid。
 * 草稿允许带 `folderHint`（按文件夹**名字**），UI 在 confirm 时按名字匹配同名 folder，
 * 匹配不上回退到「待确认」folder（DEFAULT_FILE_FOLDER_BLUEPRINTS 里有）。
 */
export const XINGYE_FILES_DRAFTS_JSONL = 'files/drafts.jsonl';

/** 与 server/routes/xingye-storage.js SAFE_AGENT_ID_RE 一致 */
const SAFE_AGENT_ID_RE = /^[A-Za-z0-9_-]{1,120}$/;

export type XingyeFileFolder = {
  id: string;
  agentId: string;
  name: string;
  description?: string;
  order: number;
  createdAt: string;
  updatedAt: string;
};

export type XingyeFileEntry = {
  id: string;
  /** 与 backend.deleteJsonlRecord 匹配用的 key（与 id 同值） */
  key: string;
  agentId: string;
  folderId: string;
  title: string;
  body: string;
  summary?: string;
  tags?: string[];
  source?: string;
  createdAt: string;
  updatedAt?: string;
};

export type XingyeFileEntryDraft = {
  folderId: string;
  title: string;
  body: string;
  summary?: string;
  tags?: string[];
  source?: string;
};

/**
 * 资料柜默认文件夹（agent 视角的世界观 / 关系 / user / 线索 / 待确认）。
 * 这些不是系统目录，仅是 agent 小手机里的虚拟分类。
 */
export const DEFAULT_FILE_FOLDER_BLUEPRINTS: ReadonlyArray<{
  name: string;
  description: string;
}> = [
  { name: '世界观整理', description: '关于 TA 所处世界的设定与规则。' },
  { name: '人际关系', description: 'TA 接触过的人、关系与分寸感。' },
  { name: '关于 user', description: 'TA 视角里整理的关于 user 的资料。' },
  { name: '线索与发现', description: '日常聊天里 TA 留意到的线索片段。' },
  { name: '待确认', description: '不确定真假、需要再核实的事。' },
];

function newFolderId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `fold-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function newFileEntryId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `fil-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
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

function normalizeTags(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    out.push(trimmed.slice(0, 32));
    if (out.length >= 16) break;
  }
  return out.length ? out : undefined;
}

function normalizeFolder(value: unknown, expectedAgentId: string): XingyeFileFolder | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : '';
  if (!id) return null;
  const agentId = typeof raw.agentId === 'string' && raw.agentId.trim() ? raw.agentId.trim() : '';
  if (agentId !== expectedAgentId) return null;
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 80) : '';
  if (!name) return null;
  const order = typeof raw.order === 'number' && Number.isFinite(raw.order) ? raw.order : 0;
  const createdAt = typeof raw.createdAt === 'string' && isIsoLike(raw.createdAt)
    ? raw.createdAt
    : new Date(0).toISOString();
  const updatedAt = typeof raw.updatedAt === 'string' && isIsoLike(raw.updatedAt)
    ? raw.updatedAt
    : createdAt;
  return {
    id,
    agentId,
    name,
    description: normalizeOptionalText(raw.description, 240),
    order,
    createdAt,
    updatedAt,
  };
}

function normalizeRow(value: unknown, expectedAgentId: string): XingyeFileEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : '';
  if (!id) return null;
  const agentId = typeof raw.agentId === 'string' && raw.agentId.trim() ? raw.agentId.trim() : '';
  if (agentId !== expectedAgentId) return null;
  const folderId = typeof raw.folderId === 'string' && raw.folderId.trim() ? raw.folderId.trim() : '';
  if (!folderId) return null;
  const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim().slice(0, 160) : '';
  const body = typeof raw.body === 'string' ? raw.body.slice(0, 8000) : '';
  if (!title) return null;
  const createdAt = typeof raw.createdAt === 'string' && isIsoLike(raw.createdAt)
    ? raw.createdAt
    : new Date(0).toISOString();
  const updatedAt = typeof raw.updatedAt === 'string' && isIsoLike(raw.updatedAt) ? raw.updatedAt : undefined;
  return {
    id,
    key: id,
    agentId,
    folderId,
    title,
    body,
    summary: normalizeOptionalText(raw.summary, 300),
    tags: normalizeTags(raw.tags),
    source: normalizeOptionalText(raw.source, 80),
    createdAt,
    updatedAt,
  };
}

function sortFolders(a: XingyeFileFolder, b: XingyeFileFolder): number {
  if (a.order !== b.order) return a.order - b.order;
  const ta = Date.parse(a.createdAt);
  const tb = Date.parse(b.createdAt);
  if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb;
  return a.id.localeCompare(b.id);
}

function sortFileEntries(a: XingyeFileEntry, b: XingyeFileEntry): number {
  const ta = Date.parse(a.updatedAt ?? a.createdAt);
  const tb = Date.parse(b.updatedAt ?? b.createdAt);
  if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return tb - ta;
  return a.id.localeCompare(b.id);
}

function assertAgentId(agentId: string, action: string): string {
  const aid = agentId.trim();
  if (!aid) throw new Error(`${action}失败：缺少 agentId。`);
  if (!SAFE_AGENT_ID_RE.test(aid)) {
    throw new Error(`${action}失败：agentId 格式无效（仅允许字母、数字、下划线与短横线，长度 1–120）。`);
  }
  return aid;
}

export async function listFileFolders(agentId: string): Promise<XingyeFileFolder[]> {
  const aid = agentId.trim();
  if (!aid) return [];
  try {
    const data = await backend.readJson<{ folders?: unknown }>(aid, XINGYE_FILES_FOLDERS_JSON);
    const arr = Array.isArray(data?.folders) ? data!.folders : [];
    return arr
      .map((row) => normalizeFolder(row, aid))
      .filter((row): row is XingyeFileFolder => Boolean(row))
      .sort(sortFolders);
  } catch {
    return [];
  }
}

async function persistFolders(agentId: string, folders: XingyeFileFolder[]): Promise<void> {
  await backend.writeJson(agentId, XINGYE_FILES_FOLDERS_JSON, { folders });
}

export async function ensureDefaultFileFolders(agentId: string): Promise<XingyeFileFolder[]> {
  const aid = assertAgentId(agentId, '初始化资料柜');
  const existing = await listFileFolders(aid);
  if (existing.length > 0) return existing;
  const nowIso = new Date().toISOString();
  const folders: XingyeFileFolder[] = DEFAULT_FILE_FOLDER_BLUEPRINTS.map((blueprint, idx) => ({
    id: newFolderId(),
    agentId: aid,
    name: blueprint.name,
    description: blueprint.description,
    order: idx,
    createdAt: nowIso,
    updatedAt: nowIso,
  }));
  await persistFolders(aid, folders);
  return folders;
}

export async function listFileEntries(agentId: string): Promise<XingyeFileEntry[]> {
  const aid = agentId.trim();
  if (!aid) return [];
  try {
    const rows = await backend.listJsonl<unknown>(aid, XINGYE_FILES_ENTRIES_JSONL);
    return rows
      .map((row) => normalizeRow(row, aid))
      .filter((row): row is XingyeFileEntry => Boolean(row))
      .sort(sortFileEntries);
  } catch {
    return [];
  }
}

export async function listFileEntriesByFolder(
  agentId: string,
  folderId: string,
): Promise<XingyeFileEntry[]> {
  const fid = folderId.trim();
  if (!fid) return [];
  const all = await listFileEntries(agentId);
  return all.filter((entry) => entry.folderId === fid);
}

function buildEntry(
  agentId: string,
  input: XingyeFileEntryDraft,
  nowIso: string,
  id = newFileEntryId(),
): XingyeFileEntry {
  const title = input.title.trim().slice(0, 160);
  const body = (input.body ?? '').slice(0, 8000);
  const folderId = input.folderId.trim();
  if (!folderId) throw new Error('文件夹不能为空。');
  if (!title) throw new Error('标题不能为空。');
  return {
    id,
    key: id,
    agentId,
    folderId,
    title,
    body,
    summary: normalizeOptionalText(input.summary, 300),
    tags: normalizeTags(input.tags),
    source: normalizeOptionalText(input.source, 80),
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

export async function appendFileEntry(
  agentId: string,
  input: XingyeFileEntryDraft,
): Promise<XingyeFileEntry> {
  const aid = assertAgentId(agentId, '保存');
  const nowIso = new Date().toISOString();
  const entry = buildEntry(aid, input, nowIso);
  await backend.appendJsonl(aid, XINGYE_FILES_ENTRIES_JSONL, entry);
  await appendFileEventBestEffort(aid, {
    type: 'file.entry_appended',
    source: 'xingye-files-store',
    subjectId: entry.id,
    payload: {
      entryId: entry.id,
      folderId: entry.folderId,
      title: entry.title,
      entrySource: entry.source,
    },
  });
  return entry;
}

export async function deleteFileEntry(agentId: string, entryId: string): Promise<boolean> {
  const aid = assertAgentId(agentId, '删除');
  const eid = entryId.trim();
  if (!eid) throw new Error('删除失败：缺少文件 id。');
  const deleted = await backend.deleteJsonlRecord(aid, XINGYE_FILES_ENTRIES_JSONL, eid);
  if (deleted) {
    await appendFileEventBestEffort(aid, {
      type: 'file.entry_deleted',
      source: 'xingye-files-store',
      subjectId: eid,
      payload: { entryId: eid },
    });
  }
  return deleted;
}

// ─────────────────────────────────────────────────────────────────────────
//  Pending file drafts (heartbeat-proposed, awaiting user confirmation)
// ─────────────────────────────────────────────────────────────────────────

export const FILES_FALLBACK_FOLDER_NAME = '待确认';

export type XingyePendingFileDraft = {
  id: string;
  title: string;
  body: string;
  summary?: string;
  /**
   * Suggested folder NAME (not id). UI 在 confirm 时按名字匹配同名 folder，
   * 匹配不上回退到「待确认」folder。
   */
  folderHint?: string;
  tags?: string[];
  reason?: string;
  source: string;
  sourceEventIds?: string[];
  createdAt: string;
};

function normalizeFileDraftRow(value: unknown): XingyePendingFileDraft | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : '';
  if (!id) return null;
  const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim().slice(0, 160) : '';
  if (!title) return null;
  const body = typeof raw.body === 'string' ? raw.body.slice(0, 8000) : '';
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
    summary: normalizeOptionalText(raw.summary, 300),
    folderHint: normalizeOptionalText(raw.folderHint, 80),
    tags: normalizeTags(raw.tags),
    reason: normalizeOptionalText(raw.reason, 1000),
    source,
    sourceEventIds,
    createdAt,
  };
}

function sortFileDrafts(a: XingyePendingFileDraft, b: XingyePendingFileDraft): number {
  const ta = Date.parse(a.createdAt);
  const tb = Date.parse(b.createdAt);
  if (ta !== tb && !Number.isNaN(ta) && !Number.isNaN(tb)) return tb - ta;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

export async function listFileDrafts(agentId: string): Promise<XingyePendingFileDraft[]> {
  const aid = String(agentId ?? '').trim();
  if (!aid) return [];
  try {
    const rows = await backend.listJsonl<unknown>(aid, XINGYE_FILES_DRAFTS_JSONL);
    return rows
      .map(normalizeFileDraftRow)
      .filter((d): d is XingyePendingFileDraft => Boolean(d))
      .sort(sortFileDrafts);
  } catch {
    return [];
  }
}

function newFileDraftId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `fil-${crypto.randomUUID()}`;
  }
  return `fil-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function appendFileDraft(
  agentId: string,
  input: {
    title: string;
    body?: string;
    summary?: string;
    folderHint?: string;
    tags?: string[];
    reason?: string;
    source: string;
    sourceEventIds?: string[];
  },
): Promise<XingyePendingFileDraft> {
  const aid = assertAgentId(agentId, '保存资料柜草稿');
  const title = (input.title ?? '').trim().slice(0, 160);
  if (!title) throw new Error('草稿标题不能为空。');
  const source = input.source.trim();
  if (!source) throw new Error('草稿来源 (source) 不能为空。');
  const body = (typeof input.body === 'string' ? input.body : '').slice(0, 8000);
  const summary = normalizeOptionalText(input.summary, 300);
  const folderHint = normalizeOptionalText(input.folderHint, 80);
  const tags = normalizeTags(input.tags);
  const reason = normalizeOptionalText(input.reason, 1000);
  const sourceEventIds = Array.isArray(input.sourceEventIds)
    ? input.sourceEventIds.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : undefined;
  const id = newFileDraftId();
  const createdAt = new Date().toISOString();
  const row: XingyePendingFileDraft & { key: string } = {
    id, key: id, title, body, summary, folderHint, tags, createdAt, reason, source, sourceEventIds,
  };
  await backend.appendJsonl(aid, XINGYE_FILES_DRAFTS_JSONL, row);
  await appendFileEventBestEffort(aid, {
    type: 'file.draft_proposed',
    source,
    subjectId: id,
    payload: {
      draftId: id,
      title,
      folderHint: folderHint ?? null,
      hasBody: Boolean(body.trim()),
      reason: reason ?? null,
      sourceEventIds: sourceEventIds ?? [],
    },
  });
  return { id, title, body, summary, folderHint, tags, createdAt, reason, source, sourceEventIds };
}

export async function discardFileDraft(agentId: string, draftId: string): Promise<boolean> {
  const aid = assertAgentId(agentId, '丢弃资料柜草稿');
  const did = draftId.trim();
  if (!did) throw new Error('丢弃草稿失败：缺少草稿 id。');
  const deleted = await backend.deleteJsonlRecord(aid, XINGYE_FILES_DRAFTS_JSONL, did);
  if (deleted) {
    await appendFileEventBestEffort(aid, {
      type: 'file.draft_discarded',
      source: 'xingye-files-store',
      subjectId: did,
      payload: { draftId: did },
    });
  }
  return deleted;
}

/**
 * 把 folderHint 解析成可用的 folderId：
 *  1. 优先按名字精确匹配（trim 后）
 *  2. 退而求其次按 startsWith 匹配
 *  3. 都匹配不上 → 「待确认」folder（默认蓝图里有的）
 *  4. 连「待确认」都没有（用户删了）→ 第一个 folder
 *
 * 调用方负责保证 folders 数组非空（confirmFileDraft 里会先 ensureDefaultFileFolders）。
 */
export function resolveFolderIdFromHint(
  folders: XingyeFileFolder[],
  folderHint: string | undefined | null,
): string {
  if (!folders.length) throw new Error('无可用文件夹');
  const trimmed = (folderHint ?? '').trim();
  if (trimmed) {
    const exact = folders.find((f) => f.name === trimmed);
    if (exact) return exact.id;
    const prefix = folders.find((f) => f.name.startsWith(trimmed) || trimmed.startsWith(f.name));
    if (prefix) return prefix.id;
  }
  const fallback = folders.find((f) => f.name === FILES_FALLBACK_FOLDER_NAME);
  return fallback ? fallback.id : folders[0].id;
}

/**
 * 用户在「待确认草稿」区点「确认生成」时调用：先 appendFileEntry 写入 entries.jsonl
 * （发 file.entry_appended），再从 drafts 删掉，最后发 file.draft_confirmed。
 *
 * folderId 解析顺序（参考 resolveFolderIdFromHint）：
 *   edits.folderId 显式指定 → 用之
 *   否则按 draft.folderHint 在现有 folders 里匹配 → 用之
 *   都匹配不上 → 「待确认」folder，再不行用第一个 folder
 */
export async function confirmFileDraft(
  agentId: string,
  draftId: string,
  edits?: {
    folderId?: string;
    title?: string;
    body?: string;
    summary?: string | null;
    tags?: string[] | null;
  },
): Promise<XingyeFileEntry> {
  const aid = assertAgentId(agentId, '确认资料柜草稿');
  const did = draftId.trim();
  if (!did) throw new Error('确认草稿失败：缺少草稿 id。');
  const draft = (await listFileDrafts(aid)).find((d) => d.id === did);
  if (!draft) throw new Error('确认草稿失败：草稿不存在或已被丢弃。');

  /** 用户可能从未初始化过文件夹；先确保有默认蓝图。 */
  const folders = await ensureDefaultFileFolders(aid);
  let folderId = edits?.folderId?.trim() || '';
  if (folderId) {
    /** 显式指定的 folderId 必须真实存在；否则回退到 hint 解析。 */
    if (!folders.some((f) => f.id === folderId)) folderId = '';
  }
  if (!folderId) folderId = resolveFolderIdFromHint(folders, draft.folderHint);

  const title = (edits?.title ?? draft.title).trim().slice(0, 160) || '无标题';
  const body = (edits?.body ?? draft.body).slice(0, 8000);
  const resolveSummary = (): string | undefined => {
    if (edits && Object.prototype.hasOwnProperty.call(edits, 'summary')) {
      if (edits.summary === null) return undefined;
      if (typeof edits.summary === 'string') return normalizeOptionalText(edits.summary, 300);
    }
    return draft.summary;
  };
  const resolveTags = (): string[] | undefined => {
    if (edits && Object.prototype.hasOwnProperty.call(edits, 'tags')) {
      if (edits.tags === null) return undefined;
      return normalizeTags(edits.tags);
    }
    return draft.tags;
  };

  const entry = await appendFileEntry(aid, {
    folderId,
    title,
    body,
    summary: resolveSummary(),
    tags: resolveTags(),
    source: 'xingye-heartbeat-confirmed',
  });
  try {
    await backend.deleteJsonlRecord(aid, XINGYE_FILES_DRAFTS_JSONL, did);
  } catch (error) {
    console.warn('[xingye-files-store] confirm draft: failed to delete draft after entry append:', error);
  }
  await appendFileEventBestEffort(aid, {
    type: 'file.draft_confirmed',
    source: 'xingye-files-store',
    subjectId: did,
    payload: { draftId: did, entryId: entry.id, folderId: entry.folderId },
  });
  return entry;
}

export async function updateFileEntry(
  agentId: string,
  entryId: string,
  patch: Partial<XingyeFileEntryDraft>,
): Promise<XingyeFileEntry | null> {
  const aid = assertAgentId(agentId, '更新');
  const eid = entryId.trim();
  if (!eid) throw new Error('更新失败：缺少文件 id。');
  const current = (await listFileEntries(aid)).find((entry) => entry.id === eid);
  if (!current) return null;
  const nextTitle = patch.title !== undefined ? patch.title.trim().slice(0, 160) : current.title;
  if (!nextTitle) throw new Error('标题不能为空。');
  const nextBody = patch.body !== undefined ? patch.body.slice(0, 8000) : current.body;
  const nextFolderId = patch.folderId !== undefined ? patch.folderId.trim() : current.folderId;
  if (!nextFolderId) throw new Error('文件夹不能为空。');
  const updated: XingyeFileEntry = {
    ...current,
    title: nextTitle,
    body: nextBody,
    folderId: nextFolderId,
    summary: patch.summary !== undefined ? normalizeOptionalText(patch.summary, 300) : current.summary,
    tags: patch.tags !== undefined ? normalizeTags(patch.tags) : current.tags,
    source: patch.source !== undefined ? normalizeOptionalText(patch.source, 80) : current.source,
    updatedAt: new Date().toISOString(),
  };
  await backend.deleteJsonlRecord(aid, XINGYE_FILES_ENTRIES_JSONL, eid);
  await backend.appendJsonl(aid, XINGYE_FILES_ENTRIES_JSONL, updated);
  return updated;
}
