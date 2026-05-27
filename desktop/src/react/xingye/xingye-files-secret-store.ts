import { postXingyeStorage } from './xingye-storage-api';
import { createAgentXingyeStorageBackend } from './xingye-storage-backend';
import { appendXingyeEvent, type XingyeEventInput } from './xingye-event-log';

const backend = createAgentXingyeStorageBackend(postXingyeStorage);

/** HANA_HOME/agents/{agentId}/xingye/ 下的相对路径。 */
export const XINGYE_FILES_HIDDEN_STATE_JSON = 'files/hidden.json';
export const XINGYE_FILES_HIDDEN_ENTRIES_JSONL = 'files/hidden-entries.jsonl';

const SAFE_AGENT_ID_RE = /^[A-Za-z0-9_-]{1,120}$/;

async function appendHiddenEventBestEffort(
  agentId: string,
  input: Omit<XingyeEventInput, 'agentId'>,
): Promise<void> {
  try {
    await appendXingyeEvent(agentId, input);
  } catch (error) {
    console.warn('[xingye-files-secret-store] event log append failed:', error);
  }
}

function assertAgentId(agentId: string, action: string): string {
  const aid = agentId.trim();
  if (!aid) throw new Error(`${action}失败：缺少 agentId。`);
  if (!SAFE_AGENT_ID_RE.test(aid)) {
    throw new Error(`${action}失败：agentId 格式无效。`);
  }
  return aid;
}

/**
 * 隐藏文件夹的状态记录。
 *
 * - `passwordHash` 为 sha-256(lowercased password) 的 hex；空字符串表示「尚未设置 / 等待首次锁定」。
 * - `candidateLabel` 仅用作回忆提示（如「林雾的姓名首字母」），不暴露真实密码。
 * - `lastUnlockedAt` / `lockedAt` 是 ISO，前者用于「上次解锁时间」展示与防抖。
 * - `seedGenerated` 表示首次解锁后 AI 种子是否已经生成过。
 */
export type XingyeHiddenFolderState = {
  agentId: string;
  /** true = 上锁；false = 已解锁。 */
  locked: boolean;
  passwordHash: string;
  /** 当前密码对应的可读 label（如「林雾的姓名首字母」），仅 UI 提示用。 */
  candidateLabel: string;
  lastUnlockedAt?: string;
  lockedAt?: string;
  /** AI 是否已经为这个隐藏文件夹生成过种子条目。 */
  seedGenerated: boolean;
  updatedAt: string;
};

export type XingyeHiddenFileEntryKind =
  | 'weakness'
  | 'guilty_pleasure'
  | 'secret_taste'
  | 'secret_plan'
  | 'manual';

export type XingyeHiddenFileEntry = {
  id: string;
  key: string;
  agentId: string;
  kind: XingyeHiddenFileEntryKind;
  title: string;
  body: string;
  source: 'ai_seed' | 'manual';
  createdAt: string;
  updatedAt?: string;
};

export type XingyeHiddenFileEntryDraft = {
  kind: XingyeHiddenFileEntryKind;
  title: string;
  body: string;
  source?: 'ai_seed' | 'manual';
};

function defaultState(agentId: string): XingyeHiddenFolderState {
  return {
    agentId,
    locked: true,
    passwordHash: '',
    candidateLabel: '',
    seedGenerated: false,
    updatedAt: new Date(0).toISOString(),
  };
}

function normalizeState(value: unknown, expectedAgentId: string): XingyeHiddenFolderState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const agentId = typeof raw.agentId === 'string' ? raw.agentId.trim() : '';
  if (agentId !== expectedAgentId) return null;
  const locked = typeof raw.locked === 'boolean' ? raw.locked : true;
  const passwordHash = typeof raw.passwordHash === 'string' ? raw.passwordHash.trim() : '';
  const candidateLabel = typeof raw.candidateLabel === 'string' ? raw.candidateLabel.trim().slice(0, 120) : '';
  const lastUnlockedAt = typeof raw.lastUnlockedAt === 'string' && raw.lastUnlockedAt ? raw.lastUnlockedAt : undefined;
  const lockedAt = typeof raw.lockedAt === 'string' && raw.lockedAt ? raw.lockedAt : undefined;
  const seedGenerated = typeof raw.seedGenerated === 'boolean' ? raw.seedGenerated : false;
  const updatedAt = typeof raw.updatedAt === 'string' && raw.updatedAt ? raw.updatedAt : new Date(0).toISOString();
  return { agentId, locked, passwordHash, candidateLabel, lastUnlockedAt, lockedAt, seedGenerated, updatedAt };
}

export async function readHiddenFolderState(agentId: string): Promise<XingyeHiddenFolderState> {
  const aid = agentId.trim();
  if (!aid) return defaultState('');
  try {
    const raw = await backend.readJson<unknown>(aid, XINGYE_FILES_HIDDEN_STATE_JSON);
    if (raw == null) return defaultState(aid);
    return normalizeState(raw, aid) ?? defaultState(aid);
  } catch {
    return defaultState(aid);
  }
}

async function persistHiddenFolderState(agentId: string, state: XingyeHiddenFolderState): Promise<void> {
  await backend.writeJson(agentId, XINGYE_FILES_HIDDEN_STATE_JSON, state);
}

/**
 * Hash 密码（小写 + trim）。用 Web Crypto sha-256，输出 hex。
 *
 * 用 sha-256 而不是 plaintext 是为了不在 disk 上留下明文密码——
 * 候选池本来就是从已知字段派生的，但 hash 至少让落盘文件「不可一眼读出」。
 */
export async function hashPassword(input: string): Promise<string> {
  const normalized = input.trim().toLowerCase();
  if (!normalized) return '';
  const subtle =
    typeof crypto !== 'undefined' && crypto && (crypto as Crypto).subtle
      ? (crypto as Crypto).subtle
      : null;
  if (!subtle) {
    /** Node / SSR 兜底——开发只跑 jsdom 测试，正常生产里 subtle 一定有。 */
    let h = 0;
    for (let i = 0; i < normalized.length; i++) h = (h * 31 + normalized.charCodeAt(i)) | 0;
    return `fallback-${(h >>> 0).toString(16)}`;
  }
  const data = new TextEncoder().encode(normalized);
  const buf = await subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export type SetHiddenFolderPasswordInput = {
  password: string;
  candidateLabel: string;
};

/**
 * 用一条候选密码（明文）+ label 重新锁定隐藏文件夹。
 *
 * 调用方负责挑候选——store 只负责 hash 并落盘。
 */
export async function setHiddenFolderPassword(
  agentId: string,
  input: SetHiddenFolderPasswordInput,
): Promise<XingyeHiddenFolderState> {
  const aid = assertAgentId(agentId, '锁定隐藏文件夹');
  const password = input.password.trim();
  if (!password) throw new Error('锁定失败：候选密码为空。');
  const passwordHash = await hashPassword(password);
  const nowIso = new Date().toISOString();
  const previous = await readHiddenFolderState(aid);
  const next: XingyeHiddenFolderState = {
    ...previous,
    agentId: aid,
    locked: true,
    passwordHash,
    candidateLabel: input.candidateLabel.trim().slice(0, 120),
    lockedAt: nowIso,
    updatedAt: nowIso,
  };
  await persistHiddenFolderState(aid, next);
  return next;
}

/**
 * 尝试用 `attempt` 解锁。匹配成功 → 落盘 unlocked 状态 + 返回 ok=true。
 * 不匹配 → 不改盘，返回 ok=false。
 *
 * `expectedHash` 由调用方传入（store 不知道候选池）；通常做法是：
 *   1. PhoneFilesApp 算出候选池 -> hashPassword(attempt) -> 与所有候选 hash 对比
 *   2. 或：直接对比 attempt 的 hash 与 state.passwordHash
 *
 * 这里只校验「attempt 的 hash === state.passwordHash」——简单稳定。
 */
export async function attemptUnlock(
  agentId: string,
  attempt: string,
): Promise<{ ok: boolean; state: XingyeHiddenFolderState }> {
  const aid = assertAgentId(agentId, '解锁隐藏文件夹');
  const state = await readHiddenFolderState(aid);
  if (!state.locked) return { ok: true, state };
  if (!state.passwordHash) return { ok: false, state };
  const attemptHash = await hashPassword(attempt);
  if (!attemptHash || attemptHash !== state.passwordHash) {
    await appendHiddenEventBestEffort(aid, {
      type: 'file.hidden_unlock_failed',
      source: 'xingye-files-secret-store',
      subjectId: aid,
      payload: {},
    });
    return { ok: false, state };
  }
  const nowIso = new Date().toISOString();
  const next: XingyeHiddenFolderState = {
    ...state,
    locked: false,
    lastUnlockedAt: nowIso,
    updatedAt: nowIso,
  };
  await persistHiddenFolderState(aid, next);
  await appendHiddenEventBestEffort(aid, {
    type: 'file.hidden_unlocked',
    source: 'xingye-files-secret-store',
    subjectId: aid,
    payload: { candidateLabel: state.candidateLabel },
  });
  return { ok: true, state: next };
}

export async function markHiddenFolderSeedGenerated(agentId: string): Promise<XingyeHiddenFolderState> {
  const aid = assertAgentId(agentId, '标记种子已生成');
  const state = await readHiddenFolderState(aid);
  const next: XingyeHiddenFolderState = {
    ...state,
    agentId: aid,
    seedGenerated: true,
    updatedAt: new Date().toISOString(),
  };
  await persistHiddenFolderState(aid, next);
  return next;
}

/**
 * 心跳钩子：解锁状态下以 `probability` 概率重锁，并换一条新密码 + label。
 * 候选选择由调用方完成（store 不依赖候选池模块，避免循环依赖）。
 *
 * `randomSource` 测试可注入；默认 Math.random。
 *
 * Returns: 是否真的重锁了 + 当前 state。
 */
export async function maybeRelockOnHeartbeat(
  agentId: string,
  options: {
    nextPassword: string;
    nextCandidateLabel: string;
    probability: number;
    randomSource?: () => number;
  },
): Promise<{ relocked: boolean; state: XingyeHiddenFolderState }> {
  const aid = assertAgentId(agentId, '心跳重锁');
  const state = await readHiddenFolderState(aid);
  if (state.locked) return { relocked: false, state };
  const rng = options.randomSource ?? Math.random;
  const p = Math.max(0, Math.min(1, options.probability));
  if (rng() >= p) return { relocked: false, state };
  if (!options.nextPassword.trim()) return { relocked: false, state };
  const passwordHash = await hashPassword(options.nextPassword);
  const nowIso = new Date().toISOString();
  const next: XingyeHiddenFolderState = {
    ...state,
    locked: true,
    passwordHash,
    candidateLabel: options.nextCandidateLabel.trim().slice(0, 120),
    lockedAt: nowIso,
    updatedAt: nowIso,
  };
  await persistHiddenFolderState(aid, next);
  await appendHiddenEventBestEffort(aid, {
    type: 'file.hidden_relocked',
    source: 'xingye-files-secret-store',
    subjectId: aid,
    payload: { candidateLabel: next.candidateLabel, trigger: 'heartbeat' },
  });
  return { relocked: true, state: next };
}

// ─── Hidden entries ────────────────────────────────────────────────────────

function newHiddenEntryId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `hid-${crypto.randomUUID()}`;
  }
  return `hid-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeKind(value: unknown): XingyeHiddenFileEntryKind {
  if (
    value === 'weakness'
    || value === 'guilty_pleasure'
    || value === 'secret_taste'
    || value === 'secret_plan'
    || value === 'manual'
  ) {
    return value;
  }
  return 'manual';
}

function normalizeEntryRow(value: unknown, expectedAgentId: string): XingyeHiddenFileEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : '';
  if (!id) return null;
  const agentId = typeof raw.agentId === 'string' ? raw.agentId.trim() : '';
  if (agentId !== expectedAgentId) return null;
  const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim().slice(0, 160) : '';
  if (!title) return null;
  const body = typeof raw.body === 'string' ? raw.body.slice(0, 4000) : '';
  const createdAt =
    typeof raw.createdAt === 'string' && raw.createdAt ? raw.createdAt : new Date(0).toISOString();
  const updatedAt = typeof raw.updatedAt === 'string' && raw.updatedAt ? raw.updatedAt : undefined;
  const source = raw.source === 'ai_seed' || raw.source === 'manual' ? raw.source : 'manual';
  return {
    id,
    key: id,
    agentId,
    kind: normalizeKind(raw.kind),
    title,
    body,
    source,
    createdAt,
    updatedAt,
  };
}

export async function listHiddenEntries(agentId: string): Promise<XingyeHiddenFileEntry[]> {
  const aid = agentId.trim();
  if (!aid) return [];
  try {
    const rows = await backend.listJsonl<unknown>(aid, XINGYE_FILES_HIDDEN_ENTRIES_JSONL);
    return rows
      .map((row) => normalizeEntryRow(row, aid))
      .filter((row): row is XingyeHiddenFileEntry => Boolean(row))
      .sort((a, b) => {
        const ta = Date.parse(a.updatedAt ?? a.createdAt);
        const tb = Date.parse(b.updatedAt ?? b.createdAt);
        if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return tb - ta;
        return a.id.localeCompare(b.id);
      });
  } catch {
    return [];
  }
}

export async function appendHiddenEntry(
  agentId: string,
  input: XingyeHiddenFileEntryDraft,
): Promise<XingyeHiddenFileEntry> {
  const aid = assertAgentId(agentId, '保存隐藏条目');
  const title = input.title.trim().slice(0, 160);
  if (!title) throw new Error('标题不能为空。');
  const body = (input.body ?? '').slice(0, 4000);
  const id = newHiddenEntryId();
  const nowIso = new Date().toISOString();
  const entry: XingyeHiddenFileEntry = {
    id,
    key: id,
    agentId: aid,
    kind: normalizeKind(input.kind),
    title,
    body,
    source: input.source ?? 'manual',
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  await backend.appendJsonl(aid, XINGYE_FILES_HIDDEN_ENTRIES_JSONL, entry);
  return entry;
}

export async function deleteHiddenEntry(agentId: string, entryId: string): Promise<boolean> {
  const aid = assertAgentId(agentId, '删除隐藏条目');
  const eid = entryId.trim();
  if (!eid) throw new Error('删除失败：缺少条目 id。');
  return backend.deleteJsonlRecord(aid, XINGYE_FILES_HIDDEN_ENTRIES_JSONL, eid);
}
