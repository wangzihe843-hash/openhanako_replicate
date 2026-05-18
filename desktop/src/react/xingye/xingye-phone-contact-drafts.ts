/**
 * 渲染端「待确认通讯录更新候选」store 助手。
 *
 * 设计要点：
 *  - 草稿落到独立的 `phone-contact/drafts.jsonl`（agent 在心跳里 propose 的）。
 *  - 用户在小手机通讯录 → 联系人列表顶部「待确认草稿 · 来自心跳巡检」区点
 *    「采纳建议」→ 走 confirmPhoneContactDraft → 内部调用 savePhoneContactMeta
 *    把 patch 合并到现有联系人 meta（remark / impression / relationshipHint /
 *    tags / faction 这 5 个字段；其余字段不动）。`markManualFields: true` —
 *    用户在 UI 上 review 过即视为手动认可。
 *  - 「丢弃」直接删 draft，不动通讯录。
 *  - 候选只针对**现有联系人**：confirm 时检查 contact meta 是否存在；不存在
 *    （已被删 / 已被替换）就 fail，让 UI 提示「联系人已不存在，是否丢弃此建议」。
 *  - 不允许的字段（displayName / kind / status / linkedAgentId / shortBio /
 *    avatarDataUrl / originalName）：server 端不写入 patch；这里 confirm 时
 *    也只透传 patch 中的 5 个字段到 savePhoneContactMeta，无需额外屏蔽。
 */

import { appendXingyeEvent, type XingyeEventInput } from './xingye-event-log';
import { postXingyeStorage } from './xingye-storage-api';
import { createAgentXingyeStorageBackend } from './xingye-storage-backend';
import {
  getPhoneContactMeta,
  savePhoneContactMeta,
  type XingyeContactTargetType,
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

export type XingyePhoneContactDraftPatch = {
  remark?: string;
  impression?: string;
  relationshipHint?: string;
  tags?: string[];
  faction?: string;
};

export type XingyePendingPhoneContactDraft = {
  id: string;
  targetType: XingyeContactTargetType;
  targetId: string;
  displayName?: string;
  patch: XingyePhoneContactDraftPatch;
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

function normalizeTargetType(value: unknown): XingyeContactTargetType | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim() as XingyeContactTargetType;
  return ALLOWED_TARGET_TYPE_SET.has(trimmed) ? trimmed : null;
}

function normalizeDraftRow(value: unknown): XingyePendingPhoneContactDraft | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : '';
  if (!id) return null;
  const targetType = normalizeTargetType(raw.targetType);
  if (!targetType) return null;
  const targetId = typeof raw.targetId === 'string' && raw.targetId.trim() ? raw.targetId.trim() : '';
  if (!targetId) return null;
  const patch = normalizePatch(raw.patch);
  if (!patch) return null;
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
    targetType,
    targetId,
    displayName: normalizeOptionalText(raw.displayName, DISPLAY_NAME_MAX),
    patch,
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
  const aid = assertAgentId(agentId, '丢弃通讯录更新候选');
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
 * 确认草稿 = 把 patch 合并到现有联系人 meta：
 *   1. 列出当前 drafts，按 draftId 取出待 confirm 的那条；找不到则 fail。
 *   2. 把 edits（如果有）覆盖到 patch 上；再归一一次（确保经过相同的字段过滤 / 长度限制）。
 *   3. 用 getPhoneContactMeta 检查 (targetType, targetId) 是否存在——**对 agent 和
 *      user 这两种 targetType**，contact meta 可能尚未持久化（首次互动前没人调用
 *      savePhoneContactMeta），此时也允许 confirm，等于"首次落 meta"。仅对
 *      virtual_contact 要求存在 meta（虚拟联系人没 meta 等同于"已被删除/不存在"）。
 *   4. 调 savePhoneContactMeta 合并 patch（source='manual'，markManualFields=true）。
 *   5. 从 drafts.jsonl 删掉这条；删除失败仅 warn。
 *   6. 发 phone_contact.draft_confirmed 事件。
 */
export async function confirmPhoneContactDraft(
  agentId: string,
  draftId: string,
  edits?: { patch?: Partial<XingyePhoneContactDraftPatch> },
): Promise<{
  draftId: string;
  targetType: XingyeContactTargetType;
  targetId: string;
  appliedFields: Array<keyof XingyePhoneContactDraftPatch>;
}> {
  const aid = assertAgentId(agentId, '确认通讯录更新候选');
  const did = draftId.trim();
  if (!did) throw new Error('确认草稿失败：缺少草稿 id。');

  const drafts = await listPhoneContactDrafts(aid);
  const draft = drafts.find((d) => d.id === did);
  if (!draft) throw new Error('确认草稿失败：草稿不存在或已被丢弃。');

  const mergedRaw: Record<string, unknown> = { ...draft.patch };
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
    const meta = getPhoneContactMeta(aid, draft.targetType, draft.targetId);
    if (!meta) {
      throw new Error('确认草稿失败：目标虚拟联系人不存在或已被删除——请丢弃此建议。');
    }
  }

  savePhoneContactMeta(
    aid,
    draft.targetType,
    draft.targetId,
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

  try {
    await backend.deleteJsonlRecord(aid, XINGYE_PHONE_CONTACT_DRAFTS_JSONL, did);
  } catch (error) {
    console.warn('[xingye-phone-contact-drafts] confirm: failed to delete draft after meta save:', error);
  }

  const appliedFields = Object.keys(mergedPatch) as Array<keyof XingyePhoneContactDraftPatch>;
  await appendDraftEventBestEffort(aid, {
    type: 'phone_contact.draft_confirmed',
    source: 'xingye-phone-contact-drafts',
    subjectId: did,
    payload: {
      draftId: did,
      targetType: draft.targetType,
      targetId: draft.targetId,
      appliedFields,
    },
  });

  return { draftId: did, targetType: draft.targetType, targetId: draft.targetId, appliedFields };
}
