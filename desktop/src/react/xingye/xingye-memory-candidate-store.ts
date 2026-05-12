import { useEffect, useState } from 'react';
import { hanaFetch } from '../hooks/use-hana-fetch';
import { getXingyePersistenceStorage } from './xingye-persistence';
import {
  assertXingyeMemoryTargetWritable,
  normalizeXingyeMemoryCandidateTarget,
  type XingyeMemoryCandidateCanonicalTarget,
  type XingyeMemoryCandidateTarget,
} from './xingye-memory-target-policy';

export type { XingyeMemoryCandidateCanonicalTarget, XingyeMemoryCandidateTarget } from './xingye-memory-target-policy';
export type XingyeMemoryCandidateStatus = 'pending' | 'rejected' | 'written';

/** 存为 number（1/2/3）；UI 用 low/medium/high 映射，不向用户展示数字。 */
export const XINGYE_MEMORY_CANDIDATE_IMPORTANCE_LOW = 1;
export const XINGYE_MEMORY_CANDIDATE_IMPORTANCE_MEDIUM = 2;
export const XINGYE_MEMORY_CANDIDATE_IMPORTANCE_HIGH = 3;

export type XingyeMemoryCandidateImportanceLevel = 'low' | 'medium' | 'high';

export type XingyeMemoryCandidate = {
  id: string;
  agentId: string;
  sourceDomain?: string;
  sourceId?: string;
  content: string;
  reason?: string;
  importance?: number;
  status: XingyeMemoryCandidateStatus;
  target: XingyeMemoryCandidateTarget;
  createdAt: string;
  updatedAt: string;
  writtenAt?: string;
};

export type XingyeMemoryCandidateMap = Record<string, XingyeMemoryCandidate>;

export const XINGYE_MEMORY_CANDIDATES_STORAGE_KEY = 'xingye.memoryCandidates';

export const XINGYE_MEMORY_CANDIDATES_CHANGED = 'xingye-memory-candidates-changed';

const STATUSES: XingyeMemoryCandidateStatus[] = ['pending', 'rejected', 'written'];

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function getLocalStorage(): StorageLike | null {
  return getXingyePersistenceStorage();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function createId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `mc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeCandidate(value: unknown, fallbackId?: string): XingyeMemoryCandidate | null {
  if (!isRecord(value)) return null;
  const id = normalizeOptionalString(value.id) ?? fallbackId;
  const agentId = normalizeOptionalString(value.agentId);
  const content = normalizeOptionalString(value.content);
  if (!id || !agentId || !content) return null;
  const target = normalizeXingyeMemoryCandidateTarget(value.target);
  const status = typeof value.status === 'string' && STATUSES.includes(value.status as XingyeMemoryCandidateStatus)
    ? (value.status as XingyeMemoryCandidateStatus)
    : 'pending';
  const now = new Date().toISOString();
  const createdAt = normalizeOptionalString(value.createdAt) ?? now;
  const updatedAt = normalizeOptionalString(value.updatedAt) ?? createdAt;
  const writtenAt = normalizeOptionalString(value.writtenAt);
  const importance = typeof value.importance === 'number' && Number.isFinite(value.importance) ? value.importance : undefined;
  const c: XingyeMemoryCandidate = {
    id,
    agentId,
    content,
    target,
    status,
    createdAt,
    updatedAt,
    sourceDomain: normalizeOptionalString(value.sourceDomain),
    sourceId: normalizeOptionalString(value.sourceId),
    reason: normalizeOptionalString(value.reason),
    importance,
  };
  if (writtenAt) c.writtenAt = writtenAt;
  return c;
}

export function loadXingyeMemoryCandidateMap(storage: StorageLike | null = getLocalStorage()): XingyeMemoryCandidateMap {
  if (!storage) return {};
  try {
    const raw = storage.getItem(XINGYE_MEMORY_CANDIDATES_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return {};
    const out: XingyeMemoryCandidateMap = {};
    for (const [key, v] of Object.entries(parsed)) {
      const n = normalizeCandidate(v, key);
      if (n) out[n.id] = n;
    }
    return out;
  } catch (error) {
    console.warn('[xingye-memory-candidate-store] failed to load:', error);
    return {};
  }
}

function saveXingyeMemoryCandidateMap(map: XingyeMemoryCandidateMap, storage: StorageLike | null = getLocalStorage()) {
  try {
    storage?.setItem(XINGYE_MEMORY_CANDIDATES_STORAGE_KEY, JSON.stringify(map));
  } catch (error) {
    console.warn('[xingye-memory-candidate-store] failed to save:', error);
    throw error instanceof Error ? error : new Error(String(error));
  }
}

function notifyXingyeMemoryCandidatesChanged() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(XINGYE_MEMORY_CANDIDATES_CHANGED));
}

export function listXingyeMemoryCandidates(
  agentId: string,
  storage: StorageLike | null = getLocalStorage(),
): XingyeMemoryCandidate[] {
  return Object.values(loadXingyeMemoryCandidateMap(storage))
    .filter((c) => c.agentId === agentId)
    .sort((a, b) => {
      const byUpdated = b.updatedAt.localeCompare(a.updatedAt);
      if (byUpdated !== 0) return byUpdated;
      return b.createdAt.localeCompare(a.createdAt);
    });
}

export function getXingyeMemoryCandidate(
  id: string,
  storage: StorageLike | null = getLocalStorage(),
): XingyeMemoryCandidate | null {
  return loadXingyeMemoryCandidateMap(storage)[id] ?? null;
}

/** 仅模块内使用；必须传入与记录一致的 agentId，防止跨 agent 误写。 */
function patchXingyeMemoryCandidateForAgent(
  agentId: string,
  candidateId: string,
  patch: Partial<Omit<XingyeMemoryCandidate, 'id' | 'agentId' | 'createdAt'>>,
  storage: StorageLike | null = getLocalStorage(),
): XingyeMemoryCandidate | null {
  const map = loadXingyeMemoryCandidateMap(storage);
  const prev = map[candidateId];
  if (!prev) return null;
  if (prev.agentId !== agentId) throw new Error('memory candidate agent mismatch');
  const next = normalizeCandidate({
    ...prev,
    ...patch,
    id: prev.id,
    agentId: prev.agentId,
    createdAt: prev.createdAt,
    updatedAt: new Date().toISOString(),
  });
  if (!next) return null;
  map[candidateId] = next;
  saveXingyeMemoryCandidateMap(map, storage);
  notifyXingyeMemoryCandidatesChanged();
  return next;
}

export function createXingyeMemoryCandidate(
  agentId: string,
  input: {
    content: string;
    target?: XingyeMemoryCandidateCanonicalTarget;
    sourceDomain?: string;
    sourceId?: string;
    reason?: string;
    importance?: number;
  },
  storage: StorageLike | null = getLocalStorage(),
): XingyeMemoryCandidate {
  const now = new Date().toISOString();
  const id = createId();
  const target = normalizeXingyeMemoryCandidateTarget(input.target ?? 'pinned');
  const candidate = normalizeCandidate({
    id,
    agentId,
    content: input.content,
    target,
    status: 'pending',
    sourceDomain: input.sourceDomain,
    sourceId: input.sourceId,
    reason: input.reason,
    importance: input.importance,
    createdAt: now,
    updatedAt: now,
  });
  if (!candidate) throw new Error('Unable to create memory candidate.');
  const map = loadXingyeMemoryCandidateMap(storage);
  map[id] = candidate;
  saveXingyeMemoryCandidateMap(map, storage);
  notifyXingyeMemoryCandidatesChanged();
  return candidate;
}

export function importanceLevelFromNumber(n?: number): XingyeMemoryCandidateImportanceLevel {
  if (n === XINGYE_MEMORY_CANDIDATE_IMPORTANCE_LOW) return 'low';
  if (n === XINGYE_MEMORY_CANDIDATE_IMPORTANCE_HIGH) return 'high';
  return 'medium';
}

export function importanceNumberFromLevel(level: XingyeMemoryCandidateImportanceLevel): number {
  if (level === 'low') return XINGYE_MEMORY_CANDIDATE_IMPORTANCE_LOW;
  if (level === 'high') return XINGYE_MEMORY_CANDIDATE_IMPORTANCE_HIGH;
  return XINGYE_MEMORY_CANDIDATE_IMPORTANCE_MEDIUM;
}

export function formatMemoryCandidateImportanceLabel(n?: number): string {
  const level = importanceLevelFromNumber(n);
  if (level === 'low') return '低';
  if (level === 'high') return '高';
  return '中';
}

/** UI 下拉用：只暴露档位与中文标签，数值由 importanceNumberFromLevel 转换。 */
export const XINGYE_MEMORY_CANDIDATE_IMPORTANCE_UI_OPTIONS: readonly {
  level: XingyeMemoryCandidateImportanceLevel;
  label: string;
}[] = [
  { level: 'low', label: '低' },
  { level: 'medium', label: '中' },
  { level: 'high', label: '高' },
] as const;

export const XINGYE_SECRET_SPACE_MANUAL_CANDIDATE_REASON_DEFAULT = '用户从秘密空间手动保存为候选重要记忆';

export function updateXingyeMemoryCandidate(
  agentId: string,
  candidateId: string,
  patch: Partial<Pick<XingyeMemoryCandidate, 'content' | 'reason' | 'importance'>>,
  storage: StorageLike | null = getLocalStorage(),
): XingyeMemoryCandidate {
  const prev = getXingyeMemoryCandidate(candidateId, storage);
  if (!prev) throw new Error('memory candidate not found');
  if (prev.agentId !== agentId) throw new Error('memory candidate agent mismatch');
  if (prev.status !== 'pending') throw new Error('candidate is not pending');
  const next = patchXingyeMemoryCandidateForAgent(agentId, candidateId, patch, storage);
  if (!next) throw new Error('failed to update memory candidate');
  return next;
}

export function rejectXingyeMemoryCandidate(
  agentId: string,
  candidateId: string,
  storage: StorageLike | null = getLocalStorage(),
): XingyeMemoryCandidate {
  const prev = getXingyeMemoryCandidate(candidateId, storage);
  if (!prev) throw new Error('memory candidate not found');
  if (prev.agentId !== agentId) throw new Error('memory candidate agent mismatch');
  if (prev.status !== 'pending') throw new Error('candidate is not pending');
  const next = patchXingyeMemoryCandidateForAgent(agentId, candidateId, { status: 'rejected' }, storage);
  if (!next) throw new Error('failed to reject memory candidate');
  return next;
}

export function useXingyeMemoryCandidates(agentId: string | null | undefined): XingyeMemoryCandidate[] {
  const id = agentId ?? '';
  const [rows, setRows] = useState<XingyeMemoryCandidate[]>(() => (id ? listXingyeMemoryCandidates(id) : []));

  useEffect(() => {
    const refresh = () => setRows(id ? listXingyeMemoryCandidates(id) : []);
    refresh();
    if (typeof window === 'undefined') return undefined;

    const refreshFromStorage = (event: StorageEvent) => {
      if (event.key === XINGYE_MEMORY_CANDIDATES_STORAGE_KEY) refresh();
    };

    const onPersistence = () => refresh();
    window.addEventListener(XINGYE_MEMORY_CANDIDATES_CHANGED, refresh);
    window.addEventListener('storage', refreshFromStorage);
    window.addEventListener('xingye-persistence-changed', onPersistence);
    return () => {
      window.removeEventListener(XINGYE_MEMORY_CANDIDATES_CHANGED, refresh);
      window.removeEventListener('storage', refreshFromStorage);
      window.removeEventListener('xingye-persistence-changed', onPersistence);
    };
  }, [id]);

  return rows;
}

export function normalizePinBulletText(content: string): string {
  return content.replace(/\s+/g, ' ').trim();
}

function pinsAlreadyHasNormalizedBullet(existingPins: string[], bullet: string): boolean {
  return existingPins.some((p) => normalizePinBulletText(p) === bullet);
}

type FetchLike = (path: string, init?: RequestInit & { timeout?: number }) => Promise<Response>;

export type ConfirmXingyeMemoryCandidateToPinnedResult = {
  candidate: XingyeMemoryCandidate;
  alreadyInPinned: boolean;
};

/**
 * 统一「重要记忆」写入网关：校验候选存在、agent 一致、状态为 pending，再经 target policy 断言可写性。
 * 不代表所有 target 可写；**当前仅 pinned** 会走通并成功调用底层 pinned 写入。
 */
export async function confirmXingyeMemoryCandidate(
  agentId: string,
  candidateId: string,
  options?: { fetchImpl?: FetchLike; storage?: StorageLike | null },
): Promise<ConfirmXingyeMemoryCandidateToPinnedResult> {
  const storage = options?.storage ?? getLocalStorage();
  const c = getXingyeMemoryCandidate(candidateId, storage);
  if (!c) throw new Error('memory candidate not found');
  if (c.agentId !== agentId) throw new Error('memory candidate agent mismatch');
  if (c.status !== 'pending') throw new Error('candidate is not pending');
  assertXingyeMemoryTargetWritable(c.target);
  return confirmXingyeMemoryCandidateToPinned(agentId, candidateId, options);
}

/**
 * 底层：仅将 **target 为 pinned** 的待定候选合并写入原生 pinned.md（GET 再必要时 PUT）。
 * 非 pinned（fact / longterm / unknown）在可写性断言处拒绝；上层请优先使用 {@link confirmXingyeMemoryCandidate}。
 */
export async function confirmXingyeMemoryCandidateToPinned(
  agentId: string,
  candidateId: string,
  options?: { fetchImpl?: FetchLike; storage?: StorageLike | null },
): Promise<ConfirmXingyeMemoryCandidateToPinnedResult> {
  const storage = options?.storage ?? getLocalStorage();
  const fetchImpl = options?.fetchImpl ?? hanaFetch;
  const c = getXingyeMemoryCandidate(candidateId, storage);
  if (!c) throw new Error('memory candidate not found');
  if (c.agentId !== agentId) throw new Error('memory candidate agent mismatch');
  if (c.status !== 'pending') throw new Error('candidate is not pending');
  assertXingyeMemoryTargetWritable(c.target);
  if (c.target !== 'pinned') {
    throw new Error('only pinned targets can use the pinned write path');
  }

  const bullet = normalizePinBulletText(c.content);
  if (!bullet) throw new Error('empty candidate content');

  const getRes = await fetchImpl(`/api/agents/${agentId}/pinned`);
  const getJson: unknown = await getRes.json().catch(() => ({}));
  if (!getRes.ok) {
    const err = isRecord(getJson) && typeof getJson.error === 'string' ? getJson.error : `GET pinned failed (${getRes.status})`;
    throw new Error(err);
  }
  const pinsRaw = isRecord(getJson) ? getJson.pins : undefined;
  const existing: string[] = Array.isArray(pinsRaw)
    ? pinsRaw.filter((p): p is string => typeof p === 'string').map((p) => p.trim()).filter(Boolean)
    : [];

  const alreadyInPinned = pinsAlreadyHasNormalizedBullet(existing, bullet);

  if (!alreadyInPinned) {
    const nextPins = [...existing, bullet];
    const putRes = await fetchImpl(`/api/agents/${agentId}/pinned`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pins: nextPins }),
    });
    const putJson: unknown = await putRes.json().catch(() => ({}));
    if (!putRes.ok) {
      const err = isRecord(putJson) && typeof putJson.error === 'string' ? putJson.error : `PUT pinned failed (${putRes.status})`;
      throw new Error(err);
    }
    if (isRecord(putJson) && putJson.error) {
      throw new Error(String(putJson.error));
    }
  }

  const writtenAt = new Date().toISOString();
  const updated = patchXingyeMemoryCandidateForAgent(
    agentId,
    candidateId,
    { status: 'written', writtenAt },
    storage,
  );
  if (!updated) throw new Error('failed to update candidate after write');
  return { candidate: updated, alreadyInPinned };
}
