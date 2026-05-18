/**
 * 渲染端「待确认短信草稿」store 助手。
 *
 * SMS 主体存储与 mail 不同：SMS thread / message 走 localStorage（xingye-phone-store），
 * server 端文件系统里没有 sms messages 主体。但**草稿**仍走 server 端 jsonl：
 *
 *  - 草稿落到 `apps/sms/drafts.jsonl`（server 端追加，UI 通过 listJsonl 读）。
 *  - listSmsDrafts / appendSmsDraft / discardSmsDraft / confirmSmsDraft 四件套，
 *    发对应的 sms.draft_* 事件。
 *  - confirm 路径调用 addSmsMessage 写入 localStorage 的 SMS thread（direction='outgoing',
 *    source='ai_generated'），message.id 用 `from-draft-${draftId}` 实现幂等。
 *  - 限制 targetType 到 agent / virtual_contact 两种（**不允许 user**——与 server
 *    SMS_DRAFT_ALLOWED_TARGET_TYPES 同步；用户应该走正常对话）。
 *
 * 与 mail 的 confirm 关键差别：
 *  - mail.confirm 调 appendMailMessage 写 jsonl；sms.confirm 调 addSmsMessage 写
 *    localStorage。localStorage 是 sync 的，所以 confirm 路径里 addSmsMessage 调用
 *    本身不会失败（除非传参非法）；失败模式集中在 deleteJsonlRecord（清草稿）那一步。
 *  - 幂等保护：addSmsMessage 在 input.messageId 已存在时直接返回不重复 append，
 *    与 confirmSmsDraft 里 `from-draft-${draftId}` 配合实现 retry 安全。
 */

import {
  appendXingyeEvent,
  type XingyeEventInput,
} from './xingye-event-log';
import { postXingyeStorage } from './xingye-storage-api';
import { createAgentXingyeStorageBackend } from './xingye-storage-backend';
import { addSmsMessage, type XingyeContactTargetType } from './xingye-phone-store';
import { FROM_DRAFT_ID_PREFIX, withDraftConfirmLock } from './xingye-draft-confirm-lock';

const backend = createAgentXingyeStorageBackend(postXingyeStorage);

export const XINGYE_SMS_DRAFTS_JSONL = 'apps/sms/drafts.jsonl';

/** 与 lib/xingye/sms-drafts.js SMS_DRAFT_ALLOWED_TARGET_TYPES 同步。 */
export const SMS_DRAFT_ALLOWED_TARGET_TYPES = ['agent', 'virtual_contact'] as const;
export type SmsDraftTargetType = (typeof SMS_DRAFT_ALLOWED_TARGET_TYPES)[number];

const ALLOWED_TARGET_TYPES_SET = new Set<string>(SMS_DRAFT_ALLOWED_TARGET_TYPES);

const SAFE_AGENT_ID_RE = /^[A-Za-z0-9_-]{1,120}$/;

const CONTENT_MAX = 240;
const MATCH_NAME_MAX = 80;
const DISPLAY_NAME_MAX = 80;
const TARGET_ID_MAX = 160;
const REASON_MAX = 1000;

export type XingyePendingSmsDraft = {
  id: string;
  targetType: SmsDraftTargetType;
  /** targetId 与 matchName 至少其一非空。 */
  targetId?: string;
  matchName?: string;
  displayName?: string;
  content: string;
  reason?: string;
  source: string;
  sourceEventIds?: string[];
  createdAt: string;
};

async function appendSmsDraftEventBestEffort(
  agentId: string,
  input: Omit<XingyeEventInput, 'agentId'>,
): Promise<void> {
  try {
    await appendXingyeEvent(agentId, input);
  } catch (error) {
    console.warn('[xingye-sms-drafts] event log append failed:', error);
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

function isAllowedTargetType(value: unknown): value is SmsDraftTargetType {
  return typeof value === 'string' && ALLOWED_TARGET_TYPES_SET.has(value);
}

function normalizeOptionalText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, max);
}

function normalizeDraftRow(value: unknown): XingyePendingSmsDraft | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : '';
  if (!id) return null;
  const targetType = raw.targetType;
  if (!isAllowedTargetType(targetType)) return null;
  const content = typeof raw.content === 'string' ? raw.content.trim().slice(0, CONTENT_MAX) : '';
  if (!content) return null;
  const targetId = normalizeOptionalText(raw.targetId, TARGET_ID_MAX);
  const matchName = normalizeOptionalText(raw.matchName, MATCH_NAME_MAX);
  if (!targetId && !matchName) return null;
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
    targetType,
    targetId,
    matchName,
    displayName: normalizeOptionalText(raw.displayName, DISPLAY_NAME_MAX),
    content,
    reason: normalizeOptionalText(raw.reason, REASON_MAX),
    source,
    sourceEventIds,
    createdAt,
  };
}

function sortDrafts(a: XingyePendingSmsDraft, b: XingyePendingSmsDraft): number {
  const ta = Date.parse(a.createdAt);
  const tb = Date.parse(b.createdAt);
  if (ta !== tb && !Number.isNaN(ta) && !Number.isNaN(tb)) return tb - ta;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

export async function listSmsDrafts(agentId: string): Promise<XingyePendingSmsDraft[]> {
  const aid = String(agentId ?? '').trim();
  if (!aid) return [];
  try {
    const rows = await backend.listJsonl<unknown>(aid, XINGYE_SMS_DRAFTS_JSONL);
    return rows
      .map(normalizeDraftRow)
      .filter((d): d is XingyePendingSmsDraft => Boolean(d))
      .sort(sortDrafts);
  } catch {
    return [];
  }
}

function newDraftId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `sms-${crypto.randomUUID()}`;
  }
  return `sms-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function appendSmsDraft(
  agentId: string,
  input: {
    targetType: SmsDraftTargetType;
    targetId?: string;
    matchName?: string;
    displayName?: string;
    content: string;
    reason?: string;
    source: string;
    sourceEventIds?: string[];
  },
): Promise<XingyePendingSmsDraft> {
  const aid = assertAgentId(agentId, '保存短信草稿');
  if (!isAllowedTargetType(input.targetType)) {
    throw new Error(`草稿 targetType 不允许：${input.targetType}。允许：${SMS_DRAFT_ALLOWED_TARGET_TYPES.join(' / ')}。`);
  }
  const targetId = normalizeOptionalText(input.targetId, TARGET_ID_MAX);
  const matchName = normalizeOptionalText(input.matchName, MATCH_NAME_MAX);
  if (!targetId && !matchName) {
    throw new Error('草稿需要 targetId 或 matchName 之一来定位收件人。');
  }
  const content = (input.content ?? '').trim().slice(0, CONTENT_MAX);
  if (!content) throw new Error('草稿正文不能为空。');
  const source = input.source.trim();
  if (!source) throw new Error('草稿来源 (source) 不能为空。');
  const displayName = normalizeOptionalText(input.displayName, DISPLAY_NAME_MAX);
  const reason = normalizeOptionalText(input.reason, REASON_MAX);
  const sourceEventIds = Array.isArray(input.sourceEventIds)
    ? input.sourceEventIds.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : undefined;
  const id = newDraftId();
  const createdAt = new Date().toISOString();
  const row: XingyePendingSmsDraft & { key: string } = {
    id,
    key: id,
    targetType: input.targetType,
    targetId,
    matchName,
    displayName,
    content,
    createdAt,
    reason,
    source,
    sourceEventIds,
  };
  await backend.appendJsonl(aid, XINGYE_SMS_DRAFTS_JSONL, row);
  await appendSmsDraftEventBestEffort(aid, {
    type: 'sms.draft_proposed',
    source,
    subjectId: id,
    payload: {
      draftId: id,
      targetType: input.targetType,
      targetId: targetId ?? null,
      matchName: matchName ?? null,
      displayName: displayName ?? null,
      contentExcerpt: content.slice(0, 60),
      reason: reason ?? null,
      sourceEventIds: sourceEventIds ?? [],
    },
  });
  return { id, targetType: input.targetType, targetId, matchName, displayName, content, createdAt, reason, source, sourceEventIds };
}

export async function discardSmsDraft(agentId: string, draftId: string): Promise<boolean> {
  const aid = assertAgentId(agentId, '丢弃短信草稿');
  const did = draftId.trim();
  if (!did) throw new Error('丢弃草稿失败：缺少草稿 id。');
  const deleted = await backend.deleteJsonlRecord(aid, XINGYE_SMS_DRAFTS_JSONL, did);
  if (deleted) {
    await appendSmsDraftEventBestEffort(aid, {
      type: 'sms.draft_discarded',
      source: 'xingye-sms-drafts',
      subjectId: did,
      payload: { draftId: did },
    });
  }
  return deleted;
}

/** Confirmed-from-draft message 用确定性 id：让 confirm retry 走幂等查重路径。 */
function smsMessageIdFromDraftId(draftId: string): string {
  return `${FROM_DRAFT_ID_PREFIX}${draftId}`;
}

/**
 * 用户在「待确认草稿」区点「确认发送」时调用：
 *   1. 解析草稿 → 用 edits（如有）覆盖 targetType/targetId/content；
 *   2. message id 用 `from-draft-${draftId}`；调 addSmsMessage 写入 SMS thread
 *      （direction='outgoing'，source='ai_generated'）；addSmsMessage 内部对同 id
 *      已存在的消息会幂等跳过，retry 安全；
 *   3. 从 apps/sms/drafts.jsonl 删掉；删除失败仅 warn——retry 时步骤 (2) 兜底防重；
 *   4. 发 sms.draft_confirmed。
 *
 * 用户可以在 confirm 时改 targetType / targetId（重新选收件人，比如 matchName 未匹配
 * 上需要用户手选）以及 content。
 *
 * 进程内 per-draft 锁防止 UI 双击/多窗口产生并发 confirm。
 *
 * 已知边界：用户在 retry 前把 targetType / targetId 改了会让幂等查重在新 (targetType,
 * targetId) thread 中找不到 message，从而 append 一条；旧 thread 里的那条不会被清掉。
 * 这是低概率场景；UI 默认不让收件人在 confirm 流程里被改，仅当 matchName 未匹配时弹
 * 选择器。
 */
export async function confirmSmsDraft(
  agentId: string,
  draftId: string,
  edits?: {
    targetType?: SmsDraftTargetType;
    targetId?: string;
    content?: string;
  },
): Promise<{ messageId: string; targetType: SmsDraftTargetType; targetId: string }> {
  const aid = assertAgentId(agentId, '确认短信草稿');
  const did = draftId.trim();
  if (!did) throw new Error('确认草稿失败：缺少草稿 id。');
  return withDraftConfirmLock(`sms::${aid}::${did}`, async () => {
    const expectedMessageId = smsMessageIdFromDraftId(did);
    const draft = (await listSmsDrafts(aid)).find((d) => d.id === did);
    if (!draft) {
      throw new Error('确认草稿失败：草稿不存在或已被丢弃。');
    }

    const targetType: SmsDraftTargetType =
      edits?.targetType && isAllowedTargetType(edits.targetType)
        ? edits.targetType
        : draft.targetType;

    const editsTargetId = normalizeOptionalText(edits?.targetId, TARGET_ID_MAX);
    const targetId = editsTargetId ?? draft.targetId;
    if (!targetId) {
      throw new Error('确认草稿失败：缺少 targetId（请在 UI 上为该联系人指定 targetId）。');
    }

    const content = (edits?.content ?? draft.content).trim().slice(0, CONTENT_MAX);
    if (!content) throw new Error('确认草稿失败：正文不能为空。');

    const thread = addSmsMessage({
      ownerAgentId: aid,
      targetType,
      targetId,
      content,
      direction: 'outgoing',
      source: 'ai_generated',
      messageId: expectedMessageId,
    });
    if (!thread) {
      throw new Error('确认草稿失败：addSmsMessage 写入失败（agentId / targetId / content 不合法）。');
    }

    try {
      await backend.deleteJsonlRecord(aid, XINGYE_SMS_DRAFTS_JSONL, did);
    } catch (error) {
      console.warn('[xingye-sms-drafts] confirm draft: failed to delete draft after sms append:', error);
    }
    await appendSmsDraftEventBestEffort(aid, {
      type: 'sms.draft_confirmed',
      source: 'xingye-sms-drafts',
      subjectId: did,
      payload: { draftId: did, messageId: expectedMessageId, targetType, targetId },
    });
    return { messageId: expectedMessageId, targetType, targetId };
  });
}
