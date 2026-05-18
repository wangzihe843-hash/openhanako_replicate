/**
 * 渲染端「待确认记忆候选草稿」store 助手。
 *
 * 设计要点：
 *  - 草稿落到独立的 `memory-candidate/drafts.jsonl`（agent 在心跳里主动 propose 的）。
 *  - 用户在 SecretSpacePanel → 私藏回忆 (memory_fragment) 视图顶部「待确认草稿 · 来自
 *    心跳巡检」区点「采纳为回忆」→ 走 confirmMemoryCandidateDraft → 内部
 *    appendSecretSpaceRecord(agentId, 'memory_fragment', ...) 把它写入 TA 自己的私藏
 *    回忆列表（secret-space/memory_fragment.jsonl）。
 *  - **不默认写 OpenHanako pinned**。pinned 由 OpenHanako 内置 memory 从聊天记录另行
 *    维护；memory_fragment 是 TA 的「人类友好的回忆查看界面」，是否同时固化到 pinned
 *    由用户在 memory_fragment 卡片上单独决定（「推到 pinned」按钮）。
 *  - 「丢弃」直接删 draft，不创建任何回忆条目。
 */

import { appendXingyeEvent, type XingyeEventInput } from './xingye-event-log';
import { postXingyeStorage } from './xingye-storage-api';
import { createAgentXingyeStorageBackend } from './xingye-storage-backend';
import { appendSecretSpaceRecord } from './xingye-secret-space-store';

const backend = createAgentXingyeStorageBackend(postXingyeStorage);

export const XINGYE_MEMORY_CANDIDATE_DRAFTS_JSONL = 'memory-candidate/drafts.jsonl';

const SAFE_AGENT_ID_RE = /^[A-Za-z0-9_-]{1,120}$/;

export type MemoryCandidateDraftImportanceLevel = 'low' | 'medium' | 'high';
const ALLOWED_LEVELS: readonly MemoryCandidateDraftImportanceLevel[] = ['low', 'medium', 'high'];

export type XingyePendingMemoryCandidateDraft = {
  id: string;
  content: string;
  importance: number;
  importanceLevel: MemoryCandidateDraftImportanceLevel;
  reason?: string;
  source: string;
  sourceEventIds?: string[];
  createdAt: string;
};

async function appendDraftEventBestEffort(
  agentId: string,
  input: Omit<XingyeEventInput, 'agentId'>,
): Promise<void> {
  try {
    await appendXingyeEvent(agentId, input);
  } catch (error) {
    console.warn('[xingye-memory-candidate-drafts] event log append failed:', error);
  }
}

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

function normalizeLevel(value: unknown): MemoryCandidateDraftImportanceLevel {
  if (typeof value === 'string' && (ALLOWED_LEVELS as readonly string[]).includes(value)) {
    return value as MemoryCandidateDraftImportanceLevel;
  }
  return 'medium';
}

function importanceNumberFromLevel(level: MemoryCandidateDraftImportanceLevel): number {
  if (level === 'low') return 1;
  if (level === 'high') return 3;
  return 2;
}

function normalizeDraftRow(value: unknown): XingyePendingMemoryCandidateDraft | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : '';
  if (!id) return null;
  const content = normalizeOptionalText(raw.content, 600);
  if (!content) return null;
  const importanceLevel = normalizeLevel(raw.importanceLevel);
  const importanceRaw = typeof raw.importance === 'number' && Number.isFinite(raw.importance) ? raw.importance : importanceNumberFromLevel(importanceLevel);
  const source = typeof raw.source === 'string' && raw.source.trim() ? raw.source.trim() : 'unknown';
  const createdAt = typeof raw.createdAt === 'string' && raw.createdAt
    ? raw.createdAt
    : new Date(0).toISOString();
  const eventIdsRaw = raw.sourceEventIds;
  const sourceEventIds = Array.isArray(eventIdsRaw)
    ? eventIdsRaw.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : undefined;
  return {
    id,
    content,
    importance: importanceRaw,
    importanceLevel,
    reason: normalizeOptionalText(raw.reason, 300),
    source,
    sourceEventIds,
    createdAt,
  };
}

function sortDrafts(a: XingyePendingMemoryCandidateDraft, b: XingyePendingMemoryCandidateDraft): number {
  const ta = Date.parse(a.createdAt);
  const tb = Date.parse(b.createdAt);
  if (ta !== tb && !Number.isNaN(ta) && !Number.isNaN(tb)) return tb - ta;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

export async function listMemoryCandidateDrafts(
  agentId: string,
): Promise<XingyePendingMemoryCandidateDraft[]> {
  const aid = String(agentId ?? '').trim();
  if (!aid) return [];
  try {
    const rows = await backend.listJsonl<unknown>(aid, XINGYE_MEMORY_CANDIDATE_DRAFTS_JSONL);
    return rows
      .map(normalizeDraftRow)
      .filter((d): d is XingyePendingMemoryCandidateDraft => Boolean(d))
      .sort(sortDrafts);
  } catch {
    return [];
  }
}

export async function discardMemoryCandidateDraft(
  agentId: string,
  draftId: string,
): Promise<boolean> {
  const aid = assertAgentId(agentId, '丢弃记忆候选草稿');
  const did = draftId.trim();
  if (!did) throw new Error('丢弃草稿失败：缺少草稿 id。');
  const deleted = await backend.deleteJsonlRecord(aid, XINGYE_MEMORY_CANDIDATE_DRAFTS_JSONL, did);
  if (deleted) {
    await appendDraftEventBestEffort(aid, {
      type: 'memory_candidate.draft_discarded',
      source: 'xingye-memory-candidate-drafts',
      subjectId: did,
      payload: { draftId: did },
    });
  }
  return deleted;
}

/**
 * 确认草稿 = 把它写入 TA 的「私藏回忆」(memory_fragment.jsonl)：
 *   1. appendSecretSpaceRecord(agentId, 'memory_fragment', body)：record key 用
 *      `from-draft-${draftId}` 作确定性 id，让 retry 走幂等路径。
 *      会同步发 secret_space.record_appended（含 origin=auto）；下层不再调
 *      createXingyeMemoryCandidate，pinned 不被自动写入。
 *   2. 从 drafts.jsonl 删掉这条；删除失败仅 warn。
 *   3. 发 memory_candidate.draft_confirmed 事件。
 *
 * 写入 pinned 的动作单独走「在 memory_fragment 卡片点『推到 pinned』」，不在本路径内。
 */
export async function confirmMemoryCandidateDraft(
  agentId: string,
  draftId: string,
  edits?: { content?: string; importanceLevel?: MemoryCandidateDraftImportanceLevel; reason?: string | null },
): Promise<{ draftId: string; recordId: string; importanceLevel: MemoryCandidateDraftImportanceLevel }> {
  const aid = assertAgentId(agentId, '确认记忆候选草稿');
  const did = draftId.trim();
  if (!did) throw new Error('确认草稿失败：缺少草稿 id。');

  const drafts = await listMemoryCandidateDrafts(aid);
  const draft = drafts.find((d) => d.id === did);
  if (!draft) throw new Error('确认草稿失败：草稿不存在或已被丢弃。');

  const contentFromEdit = typeof edits?.content === 'string' ? edits.content : undefined;
  const content = (contentFromEdit ?? draft.content).trim().slice(0, 600);
  if (!content) throw new Error('确认草稿失败：内容不能为空。');
  const importanceLevel = edits?.importanceLevel ?? draft.importanceLevel;
  const reason = edits && Object.prototype.hasOwnProperty.call(edits, 'reason')
    ? (edits.reason === null ? undefined : normalizeOptionalText(edits.reason, 300))
    : draft.reason;

  /**
   * record key 用 `from-draft-${draftId}` 作确定性 id；如果上一次 confirm 写完
   * memory_fragment.jsonl 但 delete draft 失败,本次重试时 appendJsonl 会再写一行——
   * 这是 best-effort，对 memory_fragment 这种"附加性"内容比强查重更简单（同 key
   * 多行在列表里看起来一样，删除时按 key 一次删干净）。
   */
  const recordKey = `from-draft-${did}`;
  await appendSecretSpaceRecord(aid, 'memory_fragment', {
    key: recordKey,
    id: recordKey,
    recordId: recordKey,
    title: content.length > 48 ? `${content.slice(0, 48)}…` : content,
    body: content,
    summary: content.length > 120 ? `${content.slice(0, 120)}…` : content,
    source: 'xingye-heartbeat-tool',
    importance: importanceNumberFromLevel(importanceLevel),
    importanceLevel,
    reason,
  });

  try {
    await backend.deleteJsonlRecord(aid, XINGYE_MEMORY_CANDIDATE_DRAFTS_JSONL, did);
  } catch (error) {
    console.warn('[xingye-memory-candidate-drafts] confirm: failed to delete draft after memory_fragment append:', error);
  }
  await appendDraftEventBestEffort(aid, {
    type: 'memory_candidate.draft_confirmed',
    source: 'xingye-memory-candidate-drafts',
    subjectId: did,
    payload: { draftId: did, recordId: recordKey, importanceLevel },
  });
  return { draftId: did, recordId: recordKey, importanceLevel };
}
