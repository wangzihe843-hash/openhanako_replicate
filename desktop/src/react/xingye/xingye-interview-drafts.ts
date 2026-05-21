/**
 * 渲染端「待确认独家专访草稿」store 助手（意图草稿模型）。
 *
 * 与报纸同理：一期专访是固定 5 题 + 弹幕 + 幕后的重型结构化生成，心跳 agent
 * 只提一个**意图**——TA 愿意接受一次专访、用户想问的那一题（可空）。意图草稿
 * 落 `secret-space/interview-drafts.jsonl`（与 interview.jsonl 同目录、分文件）。
 *
 * 用户在专访面板「待确认草稿」区点「确认录制」时，UI 才用意图里的 userQuestion
 * 跑现成的 generateSecretInterviewWithAI，拿到 SecretInterviewMetadata 后调
 * confirmInterviewDraftWithEntry 落地。
 *
 *  - 事件：interview.draft_proposed / discarded / confirmed；confirm 落地时
 *    appendSecretSpaceRecord('interview') 还会自动发 interview.entry_appended。
 *  - confirm 用确定性 recordId `from-draft-${draftId}` + 先 list 查重做幂等。
 */

import { appendXingyeEvent, type XingyeEventInput } from './xingye-event-log';
import { postXingyeStorage } from './xingye-storage-api';
import { createAgentXingyeStorageBackend } from './xingye-storage-backend';
import { originFromEntryId, withDraftConfirmLock } from './xingye-draft-confirm-lock';
import {
  appendSecretSpaceRecord,
  listSecretSpaceRecords,
} from './xingye-secret-space-store';
import {
  flattenSecretInterviewToContent,
  type SecretInterviewMetadata,
} from './xingye-secret-space-interview-types';

const backend = createAgentXingyeStorageBackend(postXingyeStorage);

export const XINGYE_INTERVIEW_DRAFTS_JSONL = 'secret-space/interview-drafts.jsonl';

const SAFE_AGENT_ID_RE = /^[A-Za-z0-9_-]{1,120}$/;
const QUESTION_MAX = 200;
const REASON_MAX = 1000;

async function appendInterviewDraftEventBestEffort(
  agentId: string,
  input: Omit<XingyeEventInput, 'agentId'>,
): Promise<void> {
  try {
    await appendXingyeEvent(agentId, input);
  } catch (error) {
    console.warn('[xingye-interview-drafts] event log append failed:', error);
  }
}

export type XingyePendingInterviewDraft = {
  id: string;
  /** 用户/TA 想在专访里被问到的那一题（confirm 时作为 userQuestion 传给生成）。 */
  userQuestion?: string;
  reason?: string;
  source: string;
  sourceEventIds?: string[];
  createdAt: string;
};

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

function normalizeDraftRow(value: unknown): XingyePendingInterviewDraft | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : '';
  if (!id) return null;
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
    userQuestion: normalizeOptionalText(raw.userQuestion, QUESTION_MAX),
    reason: normalizeOptionalText(raw.reason, REASON_MAX),
    source,
    sourceEventIds,
    createdAt,
  };
}

function sortDrafts(a: XingyePendingInterviewDraft, b: XingyePendingInterviewDraft): number {
  const ta = Date.parse(a.createdAt);
  const tb = Date.parse(b.createdAt);
  if (ta !== tb && !Number.isNaN(ta) && !Number.isNaN(tb)) return tb - ta;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

export async function listInterviewDrafts(agentId: string): Promise<XingyePendingInterviewDraft[]> {
  const aid = String(agentId ?? '').trim();
  if (!aid) return [];
  try {
    const rows = await backend.listJsonl<unknown>(aid, XINGYE_INTERVIEW_DRAFTS_JSONL);
    return rows
      .map(normalizeDraftRow)
      .filter((d): d is XingyePendingInterviewDraft => Boolean(d))
      .sort(sortDrafts);
  } catch {
    return [];
  }
}

function newDraftId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `interview-${crypto.randomUUID()}`;
  }
  return `interview-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 写入一条「待确认专访草稿（意图）」。
 *
 * 不写 interview.jsonl、不发 interview.entry_appended；只发 interview.draft_proposed。
 */
export async function appendInterviewDraft(
  agentId: string,
  input: {
    userQuestion?: string;
    reason?: string;
    source: string;
    sourceEventIds?: string[];
  },
): Promise<XingyePendingInterviewDraft> {
  const aid = assertAgentId(agentId, '保存专访草稿');
  const source = input.source.trim();
  if (!source) throw new Error('草稿来源 (source) 不能为空。');
  const userQuestion = normalizeOptionalText(input.userQuestion, QUESTION_MAX);
  const reason = normalizeOptionalText(input.reason, REASON_MAX);
  const sourceEventIds = Array.isArray(input.sourceEventIds)
    ? input.sourceEventIds.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : undefined;
  const id = newDraftId();
  const createdAt = new Date().toISOString();
  const row: XingyePendingInterviewDraft & { key: string } = {
    id, key: id, userQuestion, reason, source, sourceEventIds, createdAt,
  };
  await backend.appendJsonl(aid, XINGYE_INTERVIEW_DRAFTS_JSONL, row);
  await appendInterviewDraftEventBestEffort(aid, {
    type: 'interview.draft_proposed',
    source,
    subjectId: id,
    payload: {
      draftId: id,
      userQuestion: userQuestion ?? null,
      reason: reason ?? null,
      sourceEventIds: sourceEventIds ?? [],
    },
  });
  return { id, userQuestion, reason, source, sourceEventIds, createdAt };
}

export async function discardInterviewDraft(agentId: string, draftId: string): Promise<boolean> {
  const aid = assertAgentId(agentId, '丢弃专访草稿');
  const did = draftId.trim();
  if (!did) throw new Error('丢弃草稿失败：缺少草稿 id。');
  const deleted = await backend.deleteJsonlRecord(aid, XINGYE_INTERVIEW_DRAFTS_JSONL, did);
  if (deleted) {
    await appendInterviewDraftEventBestEffort(aid, {
      type: 'interview.draft_discarded',
      source: 'xingye-interview-drafts',
      subjectId: did,
      payload: { draftId: did },
    });
  }
  return deleted;
}

/** Confirmed-from-draft record 用确定性 id：让 confirm retry 走幂等查重路径。 */
function interviewRecordIdFromDraftId(draftId: string): string {
  return `from-draft-${draftId}`;
}

export type ConfirmedInterviewResult = {
  recordId: string;
  title: string;
};

/**
 * 用户在「待确认草稿」区点「确认录制」时调用。
 *
 * 专访内容不在草稿里——调用方（专访面板）须先用草稿 userQuestion 跑
 * generateSecretInterviewWithAI 拿到 SecretInterviewMetadata，再传进来。
 * 本函数负责幂等落地 + 删草稿 + 发 interview.draft_confirmed：
 *   1. recordId 用 `from-draft-${draftId}`；先 listSecretSpaceRecords('interview')
 *      查重，已有同 id → 复用，跳过 appendSecretSpaceRecord；
 *   2. 否则 appendSecretSpaceRecord('interview', ...)（自动发 interview.entry_appended）；
 *   3. 从 interview-drafts 删掉；删除失败仅 warn——重试时 (1) 兜底防重；
 *   4. 发 interview.draft_confirmed。
 */
export async function confirmInterviewDraftWithEntry(
  agentId: string,
  draftId: string,
  meta: SecretInterviewMetadata,
): Promise<ConfirmedInterviewResult> {
  const aid = assertAgentId(agentId, '确认专访草稿');
  const did = draftId.trim();
  if (!did) throw new Error('确认草稿失败：缺少草稿 id。');
  if (!meta || typeof meta !== 'object') throw new Error('确认草稿失败：缺少专访内容。');
  return withDraftConfirmLock(`interview::${aid}::${did}`, async () => {
    const recordId = interviewRecordIdFromDraftId(did);
    const existing = (await listSecretSpaceRecords(aid, 'interview')).find((r) => r.recordId === recordId);

    let title = meta.title;
    if (existing) {
      title = existing.title;
    } else {
      const content = flattenSecretInterviewToContent(meta);
      const summary = content.length > 120 ? `${content.slice(0, 120)}…` : content;
      await appendSecretSpaceRecord(aid, 'interview', {
        key: recordId,
        id: recordId,
        recordId,
        title: meta.title,
        body: content,
        summary,
        source: 'xingye-heartbeat-confirmed',
        metadata: meta as unknown as Record<string, unknown>,
      });
    }

    try {
      await backend.deleteJsonlRecord(aid, XINGYE_INTERVIEW_DRAFTS_JSONL, did);
    } catch (error) {
      console.warn('[xingye-interview-drafts] confirm draft: failed to delete draft after record append:', error);
    }
    await appendInterviewDraftEventBestEffort(aid, {
      type: 'interview.draft_confirmed',
      source: 'xingye-interview-drafts',
      subjectId: did,
      payload: {
        draftId: did,
        recordId,
        title,
        origin: originFromEntryId(recordId),
      },
    });
    return { recordId, title };
  });
}
