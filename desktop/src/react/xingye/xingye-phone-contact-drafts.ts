/**
 * 渲染端「待确认通讯录候选」store 助手。
 *
 * 设计要点：
 *  - 草稿落到独立的 `phone-contact/drafts.jsonl`（agent 在心跳里 propose 的）。
 *  - 5 个 action 全开（update / add / block / delete / restore），但所有 action
 *    都是「待用户审阅 → confirm 才生效」——agent 调本工具只产出待确认草稿，
 *    没有任何动作会绕过用户。
 *  - 安全约束（与 phone-store 的 applyAiContactUpdates hardcoded skip 对齐）：
 *    AI 不可对 user / agent 提议 add / block / delete / restore——server 层已经
 *    拒，渲染端这里再做一次防御性 check。
 *  - confirm 时按 action 分发到 phone-store 现成 helper：
 *    - update → savePhoneContactMeta + markManualFields=true + source='manual'
 *      （用户审阅认可即视为手动编辑，未来 AI 增量不会再覆盖）
 *    - add → applyAiGeneratedContacts({ metaSource: 'manual', mergeMatchingDisplayName: 'never' })
 *    - block / delete / restore → blockPhoneContact / deletePhoneContact / restorePhoneContact
 *      （三者都已经是 markManualFields=true + source='manual' 语义）
 *  - 「丢弃」直接删 draft，不动通讯录。
 */

import { appendXingyeEvent, type XingyeEventInput } from './xingye-event-log';
import { postXingyeStorage } from './xingye-storage-api';
import { createAgentXingyeStorageBackend } from './xingye-storage-backend';
import {
  applyAiGeneratedContacts,
  blockPhoneContact,
  deletePhoneContact,
  findVirtualContactByName,
  getPhoneContactMeta,
  restorePhoneContact,
  savePhoneContactMeta,
  type XingyeAiGeneratedContact,
  type XingyeContactTargetType,
  type XingyeVirtualContactKind,
} from './xingye-phone-store';

const backend = createAgentXingyeStorageBackend(postXingyeStorage);

export const XINGYE_PHONE_CONTACT_DRAFTS_JSONL = 'phone-contact/drafts.jsonl';

const SAFE_AGENT_ID_RE = /^[A-Za-z0-9_-]{1,120}$/;

const REMARK_MAX = 120;
const IMPRESSION_MAX = 600;
const RELATIONSHIP_HINT_MAX = 120;
const TAG_MAX_LEN = 32;
const TAGS_MAX_COUNT = 8;
const REASON_MAX = 500;
const DISPLAY_NAME_MAX = 80;
const SHORT_BIO_MAX = 200;
const GENERATED_REASON_MAX = 300;

export type XingyePhoneContactDraftAction = 'update' | 'add' | 'block' | 'delete' | 'restore';

export const PHONE_CONTACT_DRAFT_ALLOWED_ACTIONS: ReadonlyArray<XingyePhoneContactDraftAction> = [
  'update',
  'add',
  'block',
  'delete',
  'restore',
];

const ALLOWED_ACTION_SET: ReadonlySet<XingyePhoneContactDraftAction> = new Set(
  PHONE_CONTACT_DRAFT_ALLOWED_ACTIONS,
);

export const PHONE_CONTACT_DRAFT_ALLOWED_TARGET_TYPES: ReadonlyArray<XingyeContactTargetType> = [
  'agent',
  'virtual_contact',
  'user',
];

const ALLOWED_TARGET_TYPE_SET: ReadonlySet<XingyeContactTargetType> = new Set(
  PHONE_CONTACT_DRAFT_ALLOWED_TARGET_TYPES,
);

export const PHONE_CONTACT_DRAFT_ALLOWED_FACTIONS: ReadonlyArray<string> = [
  '自己人',
  '中立',
  '对立',
  '未知',
];

const ALLOWED_FACTION_SET: ReadonlySet<string> = new Set(PHONE_CONTACT_DRAFT_ALLOWED_FACTIONS);

export const PHONE_CONTACT_DRAFT_ALLOWED_STATUSES: ReadonlyArray<'active' | 'blocked' | 'deleted'> = [
  'active',
  'blocked',
  'deleted',
];

const ALLOWED_STATUS_SET: ReadonlySet<string> = new Set(PHONE_CONTACT_DRAFT_ALLOWED_STATUSES);

const ALLOWED_KINDS: ReadonlySet<string> = new Set<XingyeVirtualContactKind>([
  'friend',
  'family',
  'coworker',
  'classmate',
  'mentor',
  'rival',
  'enemy',
  'client',
  'patient',
  'informant',
  'superior',
  'subordinate',
  'ex',
  'neighbor',
  'unknown',
]);

export type XingyePhoneContactDraftPatch = {
  remark?: string;
  impression?: string;
  relationshipHint?: string;
  tags?: string[];
  faction?: string;
};

export type XingyePhoneContactDraftContact = {
  displayName: string;
  kind: XingyeVirtualContactKind;
  shortBio?: string;
  remark?: string;
  impression?: string;
  relationshipHint?: string;
  tags?: string[];
  faction?: string;
  status?: 'active' | 'blocked' | 'deleted';
  generatedReason?: string;
};

export type XingyePendingPhoneContactDraft = {
  id: string;
  action: XingyePhoneContactDraftAction;
  targetType: XingyeContactTargetType;
  targetId?: string;
  matchName?: string;
  displayName?: string;
  patch?: XingyePhoneContactDraftPatch;
  contact?: XingyePhoneContactDraftContact;
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
    console.warn('[xingye-phone-contact-drafts] event log append failed:', error);
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

function normalizeTags(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const sliced = trimmed.slice(0, TAG_MAX_LEN);
    if (seen.has(sliced)) continue;
    seen.add(sliced);
    out.push(sliced);
    if (out.length >= TAGS_MAX_COUNT) break;
  }
  return out;
}

function normalizeFaction(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return ALLOWED_FACTION_SET.has(trimmed) ? trimmed : undefined;
}

function normalizeStatus(value: unknown): 'active' | 'blocked' | 'deleted' | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!ALLOWED_STATUS_SET.has(trimmed)) return undefined;
  return trimmed as 'active' | 'blocked' | 'deleted';
}

function normalizeKind(value: unknown): XingyeVirtualContactKind {
  if (typeof value !== 'string') return 'unknown';
  const trimmed = value.trim();
  return ALLOWED_KINDS.has(trimmed) ? (trimmed as XingyeVirtualContactKind) : 'unknown';
}

function normalizePatch(raw: unknown): XingyePhoneContactDraftPatch | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const patch: XingyePhoneContactDraftPatch = {};
  const remark = normalizeOptionalText(r.remark, REMARK_MAX);
  if (remark !== undefined) patch.remark = remark;
  const impression = normalizeOptionalText(r.impression, IMPRESSION_MAX);
  if (impression !== undefined) patch.impression = impression;
  const relationshipHint = normalizeOptionalText(r.relationshipHint, RELATIONSHIP_HINT_MAX);
  if (relationshipHint !== undefined) patch.relationshipHint = relationshipHint;
  const tags = normalizeTags(r.tags);
  if (tags && tags.length > 0) patch.tags = tags;
  const faction = normalizeFaction(r.faction);
  if (faction !== undefined) patch.faction = faction;
  return Object.keys(patch).length > 0 ? patch : null;
}

function normalizeContact(raw: unknown): XingyePhoneContactDraftContact | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const displayName = normalizeOptionalText(r.displayName, DISPLAY_NAME_MAX);
  if (!displayName) return null;
  const contact: XingyePhoneContactDraftContact = {
    displayName,
    kind: normalizeKind(r.kind),
  };
  const shortBio = normalizeOptionalText(r.shortBio, SHORT_BIO_MAX);
  if (shortBio !== undefined) contact.shortBio = shortBio;
  const remark = normalizeOptionalText(r.remark, REMARK_MAX);
  if (remark !== undefined) contact.remark = remark;
  const impression = normalizeOptionalText(r.impression, IMPRESSION_MAX);
  if (impression !== undefined) contact.impression = impression;
  const relationshipHint = normalizeOptionalText(r.relationshipHint, RELATIONSHIP_HINT_MAX);
  if (relationshipHint !== undefined) contact.relationshipHint = relationshipHint;
  const tags = normalizeTags(r.tags);
  if (tags && tags.length > 0) contact.tags = tags;
  const faction = normalizeFaction(r.faction);
  if (faction !== undefined) contact.faction = faction;
  const status = normalizeStatus(r.status);
  if (status !== undefined) contact.status = status;
  const generatedReason = normalizeOptionalText(r.generatedReason, GENERATED_REASON_MAX);
  if (generatedReason !== undefined) contact.generatedReason = generatedReason;
  return contact;
}

function normalizeTargetType(value: unknown): XingyeContactTargetType | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim() as XingyeContactTargetType;
  return ALLOWED_TARGET_TYPE_SET.has(trimmed) ? trimmed : null;
}

function normalizeAction(value: unknown): XingyePhoneContactDraftAction | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim() as XingyePhoneContactDraftAction;
  return ALLOWED_ACTION_SET.has(trimmed) ? trimmed : null;
}

/**
 * 防御性 security check：与 server 端 resolveAction 同源。
 * confirm 前再校验一次，避免老 jsonl row 或绕过 server 写入的草稿能被 confirm。
 */
function isActionAllowedForTargetType(action: XingyePhoneContactDraftAction, targetType: XingyeContactTargetType): boolean {
  if (targetType === 'user' && action !== 'update') return false;
  if (targetType === 'agent' && action !== 'update') return false;
  if (action === 'add' && targetType !== 'virtual_contact') return false;
  return true;
}

function normalizeDraftRow(value: unknown): XingyePendingPhoneContactDraft | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : '';
  if (!id) return null;
  const targetType = normalizeTargetType(raw.targetType);
  if (!targetType) return null;
  /**
   * 旧 row 兼容：早期版本没有 action 字段（默认 update）。
   */
  const action = normalizeAction(raw.action) ?? 'update';
  if (!isActionAllowedForTargetType(action, targetType)) return null;
  const targetId = typeof raw.targetId === 'string' && raw.targetId.trim() ? raw.targetId.trim() : undefined;
  const matchName = normalizeOptionalText(raw.matchName, DISPLAY_NAME_MAX);
  if (action === 'update' && !targetId) return null;
  if ((action === 'block' || action === 'delete' || action === 'restore') && !targetId && !matchName) return null;
  let patch: XingyePhoneContactDraftPatch | undefined;
  let contact: XingyePhoneContactDraftContact | undefined;
  if (action === 'update') {
    const p = normalizePatch(raw.patch);
    if (!p) return null;
    patch = p;
  } else if (action === 'add') {
    const c = normalizeContact(raw.contact);
    if (!c) return null;
    contact = c;
  }
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
    action,
    targetType,
    targetId,
    matchName,
    displayName: normalizeOptionalText(raw.displayName, DISPLAY_NAME_MAX),
    patch,
    contact,
    reason: normalizeOptionalText(raw.reason, REASON_MAX),
    source,
    sourceEventIds,
    createdAt,
  };
}

function sortDrafts(a: XingyePendingPhoneContactDraft, b: XingyePendingPhoneContactDraft): number {
  const ta = Date.parse(a.createdAt);
  const tb = Date.parse(b.createdAt);
  if (ta !== tb && !Number.isNaN(ta) && !Number.isNaN(tb)) return tb - ta;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

export async function listPhoneContactDrafts(
  agentId: string,
): Promise<XingyePendingPhoneContactDraft[]> {
  const aid = String(agentId ?? '').trim();
  if (!aid) return [];
  try {
    const rows = await backend.listJsonl<unknown>(aid, XINGYE_PHONE_CONTACT_DRAFTS_JSONL);
    return rows
      .map(normalizeDraftRow)
      .filter((d): d is XingyePendingPhoneContactDraft => Boolean(d))
      .sort(sortDrafts);
  } catch {
    return [];
  }
}

export async function discardPhoneContactDraft(
  agentId: string,
  draftId: string,
): Promise<boolean> {
  const aid = assertAgentId(agentId, '丢弃通讯录草稿');
  const did = draftId.trim();
  if (!did) throw new Error('丢弃草稿失败：缺少草稿 id。');
  const deleted = await backend.deleteJsonlRecord(aid, XINGYE_PHONE_CONTACT_DRAFTS_JSONL, did);
  if (deleted) {
    await appendDraftEventBestEffort(aid, {
      type: 'phone_contact.draft_discarded',
      source: 'xingye-phone-contact-drafts',
      subjectId: did,
      payload: { draftId: did },
    });
  }
  return deleted;
}

/**
 * 解析 block/delete/restore 草稿的目标 contact id：
 *  - 优先 targetId；
 *  - 否则用 matchName 通过 findVirtualContactByName 解析（仅 virtual_contact 可走 matchName）。
 * 返回 null 表示找不到——UI 应提示用户「联系人已不存在，是否丢弃此建议」。
 */
function resolveStatusActionTargetId(
  agentId: string,
  draft: XingyePendingPhoneContactDraft,
): string | null {
  if (draft.targetId) return draft.targetId;
  if (draft.targetType === 'virtual_contact' && draft.matchName) {
    const vc = findVirtualContactByName(agentId, draft.matchName);
    if (vc?.id) return vc.id;
  }
  return null;
}

/**
 * 确认草稿 = 按 action 分发到 phone-store 的现成 helper：
 *  - update → savePhoneContactMeta + markManualFields=true + source='manual'
 *  - add    → applyAiGeneratedContacts（仅 virtual_contact；metaSource='manual'）
 *  - block / delete / restore → blockPhoneContact / deletePhoneContact / restorePhoneContact
 *
 * 所有 helper 内部都会更新 meta + 写 changeLog（manual_edit source），让 sms 增量
 * 补全流程同样能消费。
 */
export async function confirmPhoneContactDraft(
  agentId: string,
  draftId: string,
  edits?: { patch?: Partial<XingyePhoneContactDraftPatch> },
): Promise<{
  draftId: string;
  action: XingyePhoneContactDraftAction;
  targetType: XingyeContactTargetType;
  targetId: string;
  appliedFields?: Array<keyof XingyePhoneContactDraftPatch>;
}> {
  const aid = assertAgentId(agentId, '确认通讯录草稿');
  const did = draftId.trim();
  if (!did) throw new Error('确认草稿失败：缺少草稿 id。');

  const drafts = await listPhoneContactDrafts(aid);
  const draft = drafts.find((d) => d.id === did);
  if (!draft) throw new Error('确认草稿失败：草稿不存在或已被丢弃。');

  /**
   * 防御性二次 check：normalizeDraftRow 已经按 action/targetType 组合拒过，但
   * 万一未来出现新的攻击面，这里再确认一次。
   */
  if (!isActionAllowedForTargetType(draft.action, draft.targetType)) {
    throw new Error(`确认草稿失败：组合不允许（action=${draft.action} on targetType=${draft.targetType}）。`);
  }

  let appliedFields: Array<keyof XingyePhoneContactDraftPatch> | undefined;
  let resolvedTargetId = draft.targetId ?? '';

  if (draft.action === 'update') {
    const mergedRaw: Record<string, unknown> = { ...(draft.patch ?? {}) };
    if (edits?.patch && typeof edits.patch === 'object' && !Array.isArray(edits.patch)) {
      for (const [k, v] of Object.entries(edits.patch)) {
        mergedRaw[k] = v;
      }
    }
    const mergedPatch = normalizePatch(mergedRaw);
    if (!mergedPatch) {
      throw new Error('确认草稿失败：合并后没有任何可应用的字段（patch 为空）。');
    }
    if (draft.targetType === 'virtual_contact') {
      const meta = getPhoneContactMeta(aid, draft.targetType, draft.targetId!);
      if (!meta) {
        throw new Error('确认草稿失败：目标虚拟联系人不存在或已被删除——请丢弃此建议。');
      }
    }
    savePhoneContactMeta(
      aid,
      draft.targetType,
      draft.targetId!,
      {
        remark: mergedPatch.remark,
        impression: mergedPatch.impression,
        relationshipHint: mergedPatch.relationshipHint,
        tags: mergedPatch.tags,
        faction: mergedPatch.faction,
        source: 'manual',
      },
      undefined,
      { markManualFields: true },
    );
    appliedFields = Object.keys(mergedPatch) as Array<keyof XingyePhoneContactDraftPatch>;
  } else if (draft.action === 'add') {
    if (!draft.contact) throw new Error('确认草稿失败：add 草稿缺少 contact 字段。');
    const aiContact: XingyeAiGeneratedContact = {
      targetType: 'virtual_contact',
      displayName: draft.contact.displayName,
      kind: draft.contact.kind,
      shortBio: draft.contact.shortBio,
      remark: draft.contact.remark,
      impression: draft.contact.impression,
      relationshipHint: draft.contact.relationshipHint,
      tags: draft.contact.tags,
      faction: draft.contact.faction,
      status: draft.contact.status,
      generatedReason: draft.contact.generatedReason ?? '',
    };
    const result = applyAiGeneratedContacts(aid, [aiContact], {
      /**
       * metaSource='manual'：用户审阅确认 = 手动认可，未来 AI 增量更新不会无声覆盖。
       * mergeMatchingDisplayName='never'：要 add 就是 add，不要合并到老同名条目。
       */
      virtualSource: 'manual',
      metaSource: 'manual',
      mergeMatchingDisplayName: 'never',
    });
    if (result.createdCount > 0) {
      const want = draft.contact.displayName.trim().toLowerCase();
      const savedVc = result.saved.filter((s) => s.displayName.trim().toLowerCase() === want).at(-1)
        ?? result.saved[result.saved.length - 1];
      resolvedTargetId = savedVc?.id ?? '';
    } else {
      throw new Error('确认草稿失败：未新增任何联系人（可能因同名去重或字段缺失）。');
    }
  } else if (draft.action === 'block' || draft.action === 'delete' || draft.action === 'restore') {
    /**
     * 这三个 action 在 server / normalizeDraftRow 已经限定 targetType='virtual_contact'，
     * 这里只允许 virtual_contact 走这一路；matchName fallback 解析也只查 virtual_contact。
     */
    if (draft.targetType !== 'virtual_contact') {
      throw new Error(`确认草稿失败：${draft.action} 仅允许 virtual_contact。`);
    }
    const tid = resolveStatusActionTargetId(aid, draft);
    if (!tid) {
      throw new Error('确认草稿失败：目标虚拟联系人不存在或已被删除——请丢弃此建议。');
    }
    resolvedTargetId = tid;
    if (draft.action === 'block') blockPhoneContact(aid, 'virtual_contact', tid);
    else if (draft.action === 'delete') deletePhoneContact(aid, 'virtual_contact', tid);
    else restorePhoneContact(aid, 'virtual_contact', tid);
  }

  try {
    await backend.deleteJsonlRecord(aid, XINGYE_PHONE_CONTACT_DRAFTS_JSONL, did);
  } catch (error) {
    console.warn('[xingye-phone-contact-drafts] confirm: failed to delete draft after apply:', error);
  }

  await appendDraftEventBestEffort(aid, {
    type: 'phone_contact.draft_confirmed',
    source: 'xingye-phone-contact-drafts',
    subjectId: did,
    payload: {
      draftId: did,
      action: draft.action,
      targetType: draft.targetType,
      targetId: resolvedTargetId,
      appliedFields: appliedFields ?? [],
    },
  });

  return {
    draftId: did,
    action: draft.action,
    targetType: draft.targetType,
    targetId: resolvedTargetId,
    appliedFields,
  };
}
