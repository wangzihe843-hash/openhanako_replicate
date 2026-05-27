import { postXingyeStorage } from './xingye-storage-api';
import { createAgentXingyeStorageBackend } from './xingye-storage-backend';
import { appendXingyeEvent, type XingyeEventInput } from './xingye-event-log';
import { originFromEntryId, withDraftConfirmLock } from './xingye-draft-confirm-lock';
import { detectFilesDuplicate, normalizeTitleForDedup, type FilesDuplicateResult } from './xingye-files-dedupe';

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

/**
 * 把指定 folder 的 `updatedAt` 刷成 `nowIso`，并持久化整个 folders 列表。
 *
 * 为什么需要：folder.updatedAt 只在 ensureDefaultFileFolders 创建时写一次；
 * 后续 appendFileEntry / updateFileEntry / deleteFileEntry 不会更新 folder 本身，
 * 导致 PhoneFilesApp 首页"修改"列永远是初始化时间。这个 helper 把入口收拢，
 * 写 entries 的 mutating 函数都调一次。
 *
 * 失败仅 warn——entry 已经写入成功；folder 时间慢一次不致命。
 */
async function bumpFolderUpdatedAtBestEffort(
  agentId: string,
  folderId: string,
  nowIso: string,
): Promise<void> {
  try {
    const existing = await listFileFolders(agentId);
    const next = existing.map((f) =>
      f.id === folderId ? { ...f, updatedAt: nowIso } : f,
    );
    /** 没匹配到 folderId 就不写——可能是脏 entry 指向不存在的 folder，不应该新建。 */
    if (next === existing || !next.some((f) => f.id === folderId)) return;
    await persistFolders(agentId, next);
  } catch (error) {
    console.warn('[xingye-files-store] bump folder.updatedAt failed:', error);
  }
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

/**
 * `options.id`：心跳 confirm 流程会传 `from-draft-${draft.id}` 走幂等路径
 * （见 confirmFileDraft 注释）。用户手动新建 entry 时不传，沿用随机 id。
 *
 * `options.skipDedupe`：跳过 dedupe（默认 false）。两个场景需要 true：
 *   1. UI 用户已经在 duplicate modal 上点了「仍然新建一条」，明确 override；
 *   2. confirmFileDraft 从 draft 进 entry（已经在 confirm 阶段过完 dedupe；
 *      避免双层拦截 / 加锁顺序问题）。
 *
 * `options.knownEntries`：调用方已经有 entries 列表时直接传，避免 dedupe
 * 内部再读一次 jsonl。UI 入口（PhoneFilesApp）天然有 entries state，正好用。
 *
 * 命中 dedupe 抛 `DuplicateFileEntryError`，调用方按 instanceof 分支处理。
 */
export async function appendFileEntry(
  agentId: string,
  input: XingyeFileEntryDraft,
  options: { id?: string; skipDedupe?: boolean; knownEntries?: XingyeFileEntry[] } = {},
): Promise<XingyeFileEntry> {
  const aid = assertAgentId(agentId, '保存');
  const nowIso = new Date().toISOString();
  const id = typeof options.id === 'string' && options.id.trim() ? options.id.trim() : newFileEntryId();
  const entry = buildEntry(aid, input, nowIso, id);
  if (!options.skipDedupe) {
    const existingEntries = options.knownEntries ?? (await listFileEntries(aid));
    const detection = detectFilesDuplicate(
      { title: entry.title, folderId: entry.folderId },
      existingEntries,
    );
    if (detection.kind !== 'unique') {
      throw new DuplicateFileEntryError(detection);
    }
  }
  await backend.appendJsonl(aid, XINGYE_FILES_ENTRIES_JSONL, entry);
  await bumpFolderUpdatedAtBestEffort(aid, entry.folderId, nowIso);
  await appendFileEventBestEffort(aid, {
    type: 'file.entry_appended',
    source: 'xingye-files-store',
    subjectId: entry.id,
    payload: {
      entryId: entry.id,
      folderId: entry.folderId,
      title: entry.title,
      entrySource: entry.source,
      origin: originFromEntryId(entry.id),
    },
  });
  return entry;
}

export async function deleteFileEntry(agentId: string, entryId: string): Promise<boolean> {
  const aid = assertAgentId(agentId, '删除');
  const eid = entryId.trim();
  if (!eid) throw new Error('删除失败：缺少文件 id。');
  /**
   * 在删除前读一次拿到 folderId，删完再 bump 对应 folder 的 updatedAt。
   * 这里宽容点——拿不到 folderId 就跳过 bump，不阻塞主流程。
   */
  let folderIdToBump: string | null = null;
  try {
    const existing = (await listFileEntries(aid)).find((e) => e.id === eid);
    if (existing) folderIdToBump = existing.folderId;
  } catch {
    folderIdToBump = null;
  }
  const deleted = await backend.deleteJsonlRecord(aid, XINGYE_FILES_ENTRIES_JSONL, eid);
  if (deleted) {
    if (folderIdToBump) {
      await bumpFolderUpdatedAtBestEffort(aid, folderIdToBump, new Date().toISOString());
    }
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

export type XingyeFileDraftAction = 'add' | 'update';

/**
 * action='update' 时的更新补丁。
 *
 * 字段语义：
 *  - title：罕用——通常仅修笔误，整体替换。
 *  - bodyAppend：**追加到现有 body 末尾的段落**（不是替换原文）。files 笔记是
 *    累积式的，模型误判时只追加一段比覆写整篇代价小一个数量级。
 *  - summary：整体改写。
 *  - tags：整体替换（与 phone_contact patch.tags 同语义，空数组在 server
 *    normalizeFilesDraftPatch 里已经被丢弃）。
 *  - folderId：仅 UI 在 confirm 阶段提供（"挪柜子"）；AI 路径不传。
 */
export type XingyeFileDraftPatch = {
  title?: string;
  bodyAppend?: string;
  summary?: string;
  tags?: string[];
  folderId?: string;
};

export type XingyePendingFileDraft = {
  id: string;
  /** 'add'（新增 entry）或 'update'（把 patch 应用到 targetEntryId 指向的 entry）。 */
  action: XingyeFileDraftAction;
  /** action='update' 时定位的目标 entry id（与 matchTitle 至少其一）。 */
  targetEntryId?: string;
  /** action='update' 时备用按 title 名字匹配（trim + 归一后精确比较）。 */
  matchTitle?: string;
  /** action='update' 时的更新补丁；至少含一个非空字段。 */
  patch?: XingyeFileDraftPatch;
  /** action='add' 时的标题。update 时缺省。 */
  title: string;
  /** action='add' 时的正文。update 不用本字段，正文修改走 patch.bodyAppend。 */
  body: string;
  summary?: string;
  /**
   * Suggested folder NAME (not id). UI 在 confirm 时按名字匹配同名 folder，
   * 匹配不上回退到「待确认」folder。仅 action='add' 用。
   */
  folderHint?: string;
  tags?: string[];
  reason?: string;
  source: string;
  sourceEventIds?: string[];
  createdAt: string;
};

/**
 * `appendFileEntry` 检测到候选与已有 entry 重复时抛出。
 *
 * UI 层 `catch (err) { if (err instanceof DuplicateFileEntryError) ... }` 据此弹
 * "已有相似条目《X》，是否改为更新它 / 仍然新建" 的 modal。
 */
export class DuplicateFileEntryError extends Error {
  readonly existing: XingyeFileEntry;
  readonly detection: FilesDuplicateResult;
  constructor(detection: FilesDuplicateResult & { kind: 'exact_dup' | 'similar' }) {
    super(`资料柜里已有相似条目《${detection.entry.title}》`);
    this.name = 'DuplicateFileEntryError';
    this.existing = detection.entry;
    this.detection = detection;
  }
}

/**
 * 归一 update 用的 patch（与 server lib/xingye/files-drafts.js#normalizeFilesDraftPatch
 * 字段允许列表对齐：title / bodyAppend / summary / tags；外加 UI 路径允许的
 * folderId（"挪柜子"）。空数组 tags 丢弃。
 */
function normalizeFilesDraftPatch(value: unknown): XingyeFileDraftPatch | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const patch: XingyeFileDraftPatch = {};
  const title = normalizeOptionalText(raw.title, 160);
  if (title !== undefined) patch.title = title;
  if (typeof raw.bodyAppend === 'string') {
    const trimmed = raw.bodyAppend.trim();
    if (trimmed) patch.bodyAppend = trimmed.slice(0, 8000);
  }
  const summary = normalizeOptionalText(raw.summary, 300);
  if (summary !== undefined) patch.summary = summary;
  const tags = normalizeTags(raw.tags);
  if (tags && tags.length > 0) patch.tags = tags;
  const folderId = typeof raw.folderId === 'string' ? raw.folderId.trim() : '';
  if (folderId) patch.folderId = folderId;
  return Object.keys(patch).length > 0 ? patch : null;
}

function normalizeFileDraftRow(value: unknown): XingyePendingFileDraft | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : '';
  if (!id) return null;
  const rawAction = typeof raw.action === 'string' ? raw.action.trim() : '';
  const action: XingyeFileDraftAction = rawAction === 'update' ? 'update' : 'add';
  const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim().slice(0, 160) : '';
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

  let targetEntryId: string | undefined;
  let matchTitle: string | undefined;
  let patch: XingyeFileDraftPatch | undefined;
  if (action === 'update') {
    targetEntryId = normalizeOptionalText(raw.targetEntryId, 120);
    matchTitle = normalizeOptionalText(raw.matchTitle, 160);
    if (!targetEntryId && !matchTitle) return null;
    const normalized = normalizeFilesDraftPatch(raw.patch);
    if (!normalized) return null;
    patch = normalized;
  } else {
    if (!title) return null;
  }

  return {
    id,
    action,
    targetEntryId,
    matchTitle,
    patch,
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

/**
 * 渲染端 append 一条资料柜草稿。
 *
 * 心跳侧的 draft 由 server `lib/xingye/files-drafts.js#appendFilesDraftServer`
 * 写入；本函数主要给"渲染端自身想生成草稿"的场景（极少用，与 server 对称保留）。
 *
 * 支持 action='add' / 'update' 两种形态——参数与 server 同 schema：update 必须
 * 含 targetEntryId 或 matchTitle 之一，加非空 patch。
 */
export async function appendFileDraft(
  agentId: string,
  input: {
    action?: XingyeFileDraftAction;
    targetEntryId?: string;
    matchTitle?: string;
    patch?: XingyeFileDraftPatch;
    title?: string;
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
  const source = (input.source ?? '').trim();
  if (!source) throw new Error('草稿来源 (source) 不能为空。');
  const action: XingyeFileDraftAction = input.action === 'update' ? 'update' : 'add';
  const title = (input.title ?? '').trim().slice(0, 160);
  const body = (typeof input.body === 'string' ? input.body : '').slice(0, 8000);
  const summary = normalizeOptionalText(input.summary, 300);
  const folderHint = normalizeOptionalText(input.folderHint, 80);
  const tags = normalizeTags(input.tags);
  const reason = normalizeOptionalText(input.reason, 1000);
  const sourceEventIds = Array.isArray(input.sourceEventIds)
    ? input.sourceEventIds.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : undefined;

  let targetEntryId: string | undefined;
  let matchTitle: string | undefined;
  let patch: XingyeFileDraftPatch | undefined;
  if (action === 'update') {
    targetEntryId = normalizeOptionalText(input.targetEntryId, 120);
    matchTitle = normalizeOptionalText(input.matchTitle, 160);
    if (!targetEntryId && !matchTitle) {
      throw new Error("草稿动作为 'update' 时需要 targetEntryId 或 matchTitle。");
    }
    const normalized = normalizeFilesDraftPatch(input.patch);
    if (!normalized) throw new Error("草稿动作为 'update' 时需要非空 patch。");
    patch = normalized;
  } else {
    if (!title) throw new Error('草稿标题不能为空。');
  }

  const id = newFileDraftId();
  const createdAt = new Date().toISOString();
  const row: XingyePendingFileDraft & { key: string } = {
    id, key: id, action, targetEntryId, matchTitle, patch,
    title, body, summary, folderHint, tags, createdAt, reason, source, sourceEventIds,
  };
  await backend.appendJsonl(aid, XINGYE_FILES_DRAFTS_JSONL, row);
  await appendFileEventBestEffort(aid, {
    type: 'file.draft_proposed',
    source,
    subjectId: id,
    payload: {
      draftId: id,
      action,
      targetEntryId: targetEntryId ?? null,
      matchTitle: matchTitle ?? null,
      patchFields: patch ? Object.keys(patch) : [],
      title: title || null,
      folderHint: folderHint ?? null,
      hasBody: Boolean(body.trim()),
      reason: reason ?? null,
      sourceEventIds: sourceEventIds ?? [],
    },
  });
  return {
    id, action, targetEntryId, matchTitle, patch,
    title, body, summary, folderHint, tags, createdAt, reason, source, sourceEventIds,
  };
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

/** Confirmed-from-draft entry 用确定性 id：让 confirm retry 走幂等查重路径。 */
function fileEntryIdFromDraftId(draftId: string): string {
  return `from-draft-${draftId}`;
}

/**
 * 把 draft.targetEntryId / matchTitle 解析成现存 entry。
 *
 * 顺序：
 *   1. targetEntryId 精确匹配 entry.id
 *   2. matchTitle normalize 后 == entry.title normalize
 *   3. matchTitle normalize startsWith / 反向 startsWith（与 resolveFolderIdFromHint 同思路）
 *
 * 找不到 → null（confirm 时调用方需要给用户报错"目标条目已不存在"）。
 */
export function resolveTargetEntry(
  entries: XingyeFileEntry[],
  draft: Pick<XingyePendingFileDraft, 'targetEntryId' | 'matchTitle'>,
): XingyeFileEntry | null {
  const id = draft.targetEntryId?.trim();
  if (id) {
    const hit = entries.find((e) => e.id === id);
    if (hit) return hit;
  }
  const matchTitle = draft.matchTitle?.trim();
  if (matchTitle) {
    const target = normalizeTitleForDedup(matchTitle);
    if (target) {
      const exact = entries.find((e) => normalizeTitleForDedup(e.title) === target);
      if (exact) return exact;
      const prefix = entries.find((e) => {
        const t = normalizeTitleForDedup(e.title);
        return t.startsWith(target) || target.startsWith(t);
      });
      if (prefix) return prefix;
    }
  }
  return null;
}

export type ConfirmFileDraftEdits = {
  /** 仅 action='add' 有效；'update' 路径请通过 patch.folderId 指定（用于挪柜子）。 */
  folderId?: string;
  /** 仅 action='add' 有效；'update' 改名请通过 patch.title。 */
  title?: string;
  /** 仅 action='add' 有效；'update' 追加请通过 patch.bodyAppend。 */
  body?: string;
  /** 仅 action='add' 有效；'update' 重写请通过 patch.summary。 */
  summary?: string | null;
  /** 仅 action='add' 有效；'update' 改 tags 请通过 patch.tags。 */
  tags?: string[] | null;
  /**
   * action='update' 时 UI 收集的最终 patch（用户在 confirm 弹窗里改过的最终态）。
   * 与 draft.patch 合并：edits.patch 覆盖 draft.patch 同名字段。
   */
  patch?: XingyeFileDraftPatch;
};

function resolveAddFolderId(
  folders: XingyeFileFolder[],
  edits: ConfirmFileDraftEdits | undefined,
  draft: XingyePendingFileDraft,
): string {
  const explicit = edits?.folderId?.trim() || '';
  if (explicit && folders.some((f) => f.id === explicit)) return explicit;
  return resolveFolderIdFromHint(folders, draft.folderHint);
}

/**
 * 用户在「待确认草稿」区点「确认生成」时调用。两条主路径：
 *
 * **action='add'（默认 / 向后兼容）**：
 *   1. entry id 用 `from-draft-${draftId}`；先 list entries 查同 id 的 entry
 *      （上一次 confirm 写完 entry 但 delete draft 失败的重试） → 复用；
 *   2. 否则解析 folderId（edits 优先 / draft.folderHint / 「待确认」folder），
 *      过一遍 dedupe（命中抛 DuplicateFileEntryError），调 appendFileEntry
 *      （skipDedupe=true：本函数已亲自过过了，避免重复读 entries）；
 *   3. 从 drafts 删掉；删除失败仅 warn——重试时步骤 1 兜底防重；
 *   4. 发 file.draft_confirmed（payload.action='add'）。
 *
 * **action='update'**：
 *   1. resolveTargetEntry 找老 entry；找不到 → 抛"目标条目已不存在"；
 *   2. 合并 draft.patch + edits.patch（后者覆盖前者）；
 *   3. bodyAppend 追加到老 entry.body 末尾（≤8000 截断），其它字段按 patch 替换；
 *   4. 调 updateFileEntry 写入；
 *   5. 从 drafts 删掉；发 file.draft_confirmed（payload.action='update'）。
 *
 * 进程内 per-draft 锁防止 UI 双击/多窗口产生并发 confirm。
 */
export async function confirmFileDraft(
  agentId: string,
  draftId: string,
  edits?: ConfirmFileDraftEdits,
): Promise<XingyeFileEntry> {
  const aid = assertAgentId(agentId, '确认资料柜草稿');
  const did = draftId.trim();
  if (!did) throw new Error('确认草稿失败：缺少草稿 id。');
  return withDraftConfirmLock(`files::${aid}::${did}`, async () => {
    const entries = await listFileEntries(aid);
    const expectedEntryId = fileEntryIdFromDraftId(did);
    const existingFromDraft = entries.find((e) => e.id === expectedEntryId);

    const draft = (await listFileDrafts(aid)).find((d) => d.id === did);
    if (!draft && !existingFromDraft) {
      throw new Error('确认草稿失败：草稿不存在或已被丢弃。');
    }

    let entry: XingyeFileEntry;
    let resolvedAction: XingyeFileDraftAction = 'add';

    if (existingFromDraft) {
      /** 幂等重试：上次 confirm 写完 entry 但 delete draft 失败。 */
      entry = existingFromDraft;
      resolvedAction = draft?.action ?? 'add';
    } else if (draft && draft.action === 'update') {
      resolvedAction = 'update';
      const target = resolveTargetEntry(entries, draft);
      if (!target) {
        throw new Error('确认草稿失败：目标条目已不存在；请丢弃此草稿后重新整理。');
      }
      const mergedPatch: XingyeFileDraftPatch = { ...(draft.patch ?? {}), ...(edits?.patch ?? {}) };
      const nextTitle = (mergedPatch.title ?? target.title).trim().slice(0, 160) || target.title;
      const nextBody = mergedPatch.bodyAppend
        ? `${target.body ? `${target.body}\n\n` : ''}${mergedPatch.bodyAppend}`.slice(0, 8000)
        : target.body;
      const nextSummary = Object.prototype.hasOwnProperty.call(mergedPatch, 'summary')
        ? normalizeOptionalText(mergedPatch.summary, 300)
        : target.summary;
      const nextTags = Object.prototype.hasOwnProperty.call(mergedPatch, 'tags')
        ? normalizeTags(mergedPatch.tags)
        : target.tags;
      const nextFolderId = mergedPatch.folderId?.trim() || target.folderId;
      const updated = await updateFileEntry(aid, target.id, {
        folderId: nextFolderId,
        title: nextTitle,
        body: nextBody,
        summary: nextSummary,
        tags: nextTags,
        source: target.source,
      });
      if (!updated) {
        throw new Error('确认草稿失败：updateFileEntry 未找到目标条目（并发删除）。');
      }
      entry = updated;
    } else if (draft) {
      resolvedAction = 'add';
      const folders = await ensureDefaultFileFolders(aid);
      const folderId = resolveAddFolderId(folders, edits, draft);

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

      const detection = detectFilesDuplicate({ title, folderId }, entries);
      if (detection.kind !== 'unique') {
        throw new DuplicateFileEntryError(detection);
      }

      entry = await appendFileEntry(
        aid,
        {
          folderId,
          title,
          body,
          summary: resolveSummary(),
          tags: resolveTags(),
          source: 'xingye-heartbeat-confirmed',
        },
        { id: expectedEntryId, skipDedupe: true, knownEntries: entries },
      );
    } else {
      throw new Error('确认草稿失败：草稿不存在或已被丢弃。');
    }

    try {
      await backend.deleteJsonlRecord(aid, XINGYE_FILES_DRAFTS_JSONL, did);
    } catch (error) {
      console.warn('[xingye-files-store] confirm draft: failed to delete draft after entry append:', error);
    }
    await appendFileEventBestEffort(aid, {
      type: 'file.draft_confirmed',
      source: 'xingye-files-store',
      subjectId: did,
      payload: {
        draftId: did,
        action: resolvedAction,
        entryId: entry.id,
        folderId: entry.folderId,
      },
    });
    return entry;
  });
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
  /**
   * folderId 没变就只 bump 当前 folder；
   * 改了 folder（move）就两个 folder 都 bump（源 folder 少了一条、目标 folder 多了一条）。
   */
  await bumpFolderUpdatedAtBestEffort(aid, updated.folderId, updated.updatedAt ?? new Date().toISOString());
  if (current.folderId !== updated.folderId) {
    await bumpFolderUpdatedAtBestEffort(aid, current.folderId, updated.updatedAt ?? new Date().toISOString());
  }
  return updated;
}
