/**
 * 渲染端「待确认关系状态草稿」store 助手。
 *
 * 与现有 xingye-state-store（localStorage 上的 relationshipStates）并存：
 *  - 本模块只管 agent 在心跳里主动 propose 的草稿（落 `relationship-state/drafts.jsonl`）。
 *  - 用户在 RelationshipStatePanel 顶部「待确认草稿 · 来自心跳巡检」区点「应用建议」
 *    → 走 confirmRelationshipStateDraft → 内部 updateRelationshipState 应用 5 个 delta
 *    + mood + stateSummary + reasonText，并发布 relationship_state.applied 事件
 *    （与「手动 refresh → AI 建议 → 接受」路径同终点）。
 *  - 「丢弃」直接删 draft，不动 relationshipState。
 */

import { appendXingyeEvent, type XingyeEventInput } from './xingye-event-log';
import { postXingyeStorage } from './xingye-storage-api';
import { createAgentXingyeStorageBackend } from './xingye-storage-backend';
import {
  updateRelationshipState,
  type XingyeRelationshipState,
  type XingyeRelationshipStatePatch,
} from './xingye-state-store';

const backend = createAgentXingyeStorageBackend(postXingyeStorage);

export const XINGYE_RELATIONSHIP_STATE_DRAFTS_JSONL = 'relationship-state/drafts.jsonl';

const SAFE_AGENT_ID_RE = /^[A-Za-z0-9_-]{1,120}$/;

const DELTA_BOUNDS = {
  affectionDelta: { min: -100, max: 150 },
  trustDelta: { min: -100, max: 100 },
  loyaltyDelta: { min: -100, max: 100 },
  jealousyDelta: { min: -100, max: 100 },
  corruptionDelta: { min: -100, max: 100 },
} as const;

type DeltaKey = keyof typeof DELTA_BOUNDS;

export type XingyePendingRelationshipStateDraft = {
  id: string;
  targetType: 'user';
  targetId: '__user__';
  affectionDelta: number;
  trustDelta: number;
  loyaltyDelta: number;
  jealousyDelta: number;
  corruptionDelta: number;
  mood?: string;
  stateSummary?: string;
  reasonText?: string;
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
    console.warn('[xingye-relationship-state-drafts] event log append failed:', error);
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

function clampDelta(value: unknown, key: DeltaKey): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  const bounds = DELTA_BOUNDS[key];
  const rounded = Math.trunc(value);
  if (rounded < bounds.min) return bounds.min;
  if (rounded > bounds.max) return bounds.max;
  return rounded;
}

function normalizeDraftRow(value: unknown): XingyePendingRelationshipStateDraft | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : '';
  if (!id) return null;
  const deltas = {
    affectionDelta: clampDelta(raw.affectionDelta, 'affectionDelta'),
    trustDelta: clampDelta(raw.trustDelta, 'trustDelta'),
    loyaltyDelta: clampDelta(raw.loyaltyDelta, 'loyaltyDelta'),
    jealousyDelta: clampDelta(raw.jealousyDelta, 'jealousyDelta'),
    corruptionDelta: clampDelta(raw.corruptionDelta, 'corruptionDelta'),
  };
  const mood = normalizeOptionalText(raw.mood, 40);
  const hasDelta = Object.values(deltas).some((d) => d !== 0);
  if (!hasDelta && !mood) return null;
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
    targetType: 'user',
    targetId: '__user__',
    ...deltas,
    mood,
    stateSummary: normalizeOptionalText(raw.stateSummary, 200),
    reasonText: normalizeOptionalText(raw.reasonText, 500) || normalizeOptionalText(raw.reason, 500),
    source,
    sourceEventIds,
    createdAt,
  };
}

function sortDrafts(a: XingyePendingRelationshipStateDraft, b: XingyePendingRelationshipStateDraft): number {
  const ta = Date.parse(a.createdAt);
  const tb = Date.parse(b.createdAt);
  if (ta !== tb && !Number.isNaN(ta) && !Number.isNaN(tb)) return tb - ta;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

export async function listRelationshipStateDrafts(
  agentId: string,
): Promise<XingyePendingRelationshipStateDraft[]> {
  const aid = String(agentId ?? '').trim();
  if (!aid) return [];
  try {
    const rows = await backend.listJsonl<unknown>(aid, XINGYE_RELATIONSHIP_STATE_DRAFTS_JSONL);
    return rows
      .map(normalizeDraftRow)
      .filter((d): d is XingyePendingRelationshipStateDraft => Boolean(d))
      .sort(sortDrafts);
  } catch {
    return [];
  }
}

export async function discardRelationshipStateDraft(
  agentId: string,
  draftId: string,
): Promise<boolean> {
  const aid = assertAgentId(agentId, '丢弃关系状态草稿');
  const did = draftId.trim();
  if (!did) throw new Error('丢弃草稿失败：缺少草稿 id。');
  const deleted = await backend.deleteJsonlRecord(aid, XINGYE_RELATIONSHIP_STATE_DRAFTS_JSONL, did);
  if (deleted) {
    await appendDraftEventBestEffort(aid, {
      type: 'relationship_state.draft_discarded',
      source: 'xingye-relationship-state-drafts',
      subjectId: did,
      payload: { draftId: did },
    });
  }
  return deleted;
}

/**
 * 确认草稿 = 把 5 个 delta + mood + stateSummary + reasonText 应用到本地状态：
 *   1. 通过 updateRelationshipState 应用 patch（内部 clamp 数值、推入 previousStates）；
 *   2. 发 relationship_state.applied 事件（与「手动接受」路径同 type，让心跳/UI 不再
 *      关心来源差异）；
 *   3. 从 drafts.jsonl 删掉这条；删除失败仅 warn。
 *   4. 发 relationship_state.draft_confirmed 事件。
 *
 * 注意：updateRelationshipState 本身不发 applied 事件——那是 RelationshipStatePanel
 * 自己在 handleAccept 里手发的。我们也在这里手发，让两路径行为一致。
 */
export async function confirmRelationshipStateDraft(
  agentId: string,
  draftId: string,
  edits?: Partial<XingyeRelationshipStatePatch>,
): Promise<XingyeRelationshipState> {
  const aid = assertAgentId(agentId, '确认关系状态草稿');
  const did = draftId.trim();
  if (!did) throw new Error('确认草稿失败：缺少草稿 id。');

  const drafts = await listRelationshipStateDrafts(aid);
  const draft = drafts.find((d) => d.id === did);
  if (!draft) throw new Error('确认草稿失败：草稿不存在或已被丢弃。');

  const patch: XingyeRelationshipStatePatch = {
    affectionDelta: edits?.affectionDelta ?? draft.affectionDelta,
    trustDelta: edits?.trustDelta ?? draft.trustDelta,
    loyaltyDelta: edits?.loyaltyDelta ?? draft.loyaltyDelta,
    jealousyDelta: edits?.jealousyDelta ?? draft.jealousyDelta,
    corruptionDelta: edits?.corruptionDelta ?? draft.corruptionDelta,
    mood: edits?.mood ?? draft.mood,
    stateSummary: edits?.stateSummary ?? draft.stateSummary,
    reason: edits?.reason ?? draft.reasonText,
  };

  const next = updateRelationshipState(aid, patch);

  await appendDraftEventBestEffort(aid, {
    type: 'relationship_state.applied',
    source: 'xingye-relationship-state-drafts',
    subjectId: next.targetId,
    payload: {
      draftId: did,
      affectionDelta: patch.affectionDelta ?? 0,
      trustDelta: patch.trustDelta ?? 0,
      loyaltyDelta: patch.loyaltyDelta ?? 0,
      jealousyDelta: patch.jealousyDelta ?? 0,
      corruptionDelta: patch.corruptionDelta ?? 0,
      mood: next.mood,
    },
  });

  try {
    await backend.deleteJsonlRecord(aid, XINGYE_RELATIONSHIP_STATE_DRAFTS_JSONL, did);
  } catch (error) {
    console.warn('[xingye-relationship-state-drafts] confirm: failed to delete draft after applying:', error);
  }
  await appendDraftEventBestEffort(aid, {
    type: 'relationship_state.draft_confirmed',
    source: 'xingye-relationship-state-drafts',
    subjectId: did,
    payload: { draftId: did },
  });

  return next;
}
