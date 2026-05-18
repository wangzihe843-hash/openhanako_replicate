/**
 * 服务端「待确认通讯录更新候选」追加助手。
 *
 * 与渲染端 desktop/src/react/xingye/xingye-phone-contact-drafts.ts 共用同一份
 * `phone-contact/drafts.jsonl`：UI 通过 /api/xingye/storage listJsonl 读，server
 * 这里直接 fs 追加。
 *
 * 设计取舍：
 *  - 5 个 action 全开（update / add / block / delete / restore），但所有 action
 *    都仍然是「待用户审阅 → confirm 才生效」——agent 调本工具只产出**待确认草稿**，
 *    没有任何动作会绕过用户。
 *  - **AI 不可主动 add/block/delete/restore user 或 agent**：user 只能 update；
 *    agent 也只能 update。这一约束与 phone-store 的 applyAiContactUpdates
 *    内置 hardcoded skip 完全一致（详见 xingye-phone-store.ts:2245-2254）。
 *    server 端这里提前拒，避免 jsonl 里残留永远不会被 confirm 的草稿。
 *  - **add 只能针对 virtual_contact**：批量造名单 / 真实角色 / user 都不在
 *    本工具的 add 范围。
 *  - patch（update 用）允许 5 个"印象 / 关系判断"字段：remark / impression /
 *    relationshipHint / tags / faction；status / 骨架字段一律忽略。
 *  - contact（add 用）字段允许：displayName（必填）、kind（必填）、shortBio、
 *    remark、impression、relationshipHint、tags、faction、status、generatedReason。
 *  - block / delete / restore 不需要 patch / contact，但需要 targetId 或 matchName。
 *  - 视角约定（agent-视角）：remark / impression / relationshipHint 都是
 *    **当前角色（agent）对该联系人**的相处印象与判断；user 这条联系人也按
 *    "agent 看 user" 的视角写——不要把用户原话搬进 impression。
 *  - 写完发一条 phone_contact.draft_proposed 事件，让心跳摘要里能聚合。
 */

import path from "node:path";
import fs from "node:fs";

import { appendXingyeEvent, withXingyeAgentEventLock } from "./events.js";

export const XINGYE_PHONE_CONTACT_DRAFTS_RELATIVE_PATH = path.join("phone-contact", "drafts.jsonl");

const SAFE_AGENT_ID_RE = /^[A-Za-z0-9_-]{1,120}$/;

const DISPLAY_NAME_MAX = 80;
const SHORT_BIO_MAX = 200;
const REMARK_MAX = 120;
const IMPRESSION_MAX = 600;
const RELATIONSHIP_HINT_MAX = 120;
const TAG_MAX_LEN = 32;
const TAGS_MAX_COUNT = 8;
const REASON_MAX = 500;
const GENERATED_REASON_MAX = 300;

export const PHONE_CONTACT_DRAFT_ALLOWED_TARGET_TYPES = Object.freeze([
  "agent",
  "virtual_contact",
  "user",
]);

export const PHONE_CONTACT_DRAFT_ALLOWED_ACTIONS = Object.freeze([
  "update",
  "add",
  "block",
  "delete",
  "restore",
]);

/**
 * faction 取值限制与 phone-prompts.ts 的 TAG_FACTION_STATUS_RULES 保持同源：
 * 允许 4 种；其它值（含空字符串）会被丢弃。
 */
export const PHONE_CONTACT_DRAFT_ALLOWED_FACTIONS = Object.freeze([
  "自己人",
  "中立",
  "对立",
  "未知",
]);

/**
 * status 仅在 add.contact.status 上接受；patch.status 仍然被忽略。
 * 与 XingyeContactStatus 一致：active / blocked / deleted。
 */
export const PHONE_CONTACT_DRAFT_ALLOWED_STATUSES = Object.freeze([
  "active",
  "blocked",
  "deleted",
]);

/**
 * add.contact.kind 必须是已知 kind 之一，与 XingyeVirtualContactKind 同源。
 * 其它值会被归一为 'unknown'（applyAiGeneratedContacts 也会兜底）。
 */
export const PHONE_CONTACT_DRAFT_ALLOWED_KINDS = Object.freeze([
  "friend",
  "family",
  "coworker",
  "classmate",
  "mentor",
  "rival",
  "enemy",
  "client",
  "patient",
  "informant",
  "superior",
  "subordinate",
  "ex",
  "neighbor",
  "unknown",
]);

function normalizeOptionalString(value, maxLen) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return typeof maxLen === "number" ? trimmed.slice(0, maxLen) : trimmed;
}

function normalizeTags(value) {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set();
  const out = [];
  for (const raw of value) {
    if (typeof raw !== "string") continue;
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

function normalizeFaction(value) {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) return undefined;
  return PHONE_CONTACT_DRAFT_ALLOWED_FACTIONS.includes(trimmed) ? trimmed : undefined;
}

function normalizeStatus(value) {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) return undefined;
  return PHONE_CONTACT_DRAFT_ALLOWED_STATUSES.includes(trimmed) ? trimmed : undefined;
}

function normalizeKind(value) {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) return "unknown";
  return PHONE_CONTACT_DRAFT_ALLOWED_KINDS.includes(trimmed) ? trimmed : "unknown";
}

function normalizePatch(rawPatch) {
  if (!rawPatch || typeof rawPatch !== "object" || Array.isArray(rawPatch)) return null;
  const patch = {};
  const remark = normalizeOptionalString(rawPatch.remark, REMARK_MAX);
  if (remark !== undefined) patch.remark = remark;
  const impression = normalizeOptionalString(rawPatch.impression, IMPRESSION_MAX);
  if (impression !== undefined) patch.impression = impression;
  const relationshipHint = normalizeOptionalString(rawPatch.relationshipHint, RELATIONSHIP_HINT_MAX);
  if (relationshipHint !== undefined) patch.relationshipHint = relationshipHint;
  const tags = normalizeTags(rawPatch.tags);
  /**
   * tags 与其它字段的差异：空数组也算"显式给出 tags"——但对"更新候选"来说，
   * 空数组没有应用价值（等于不变 / 等于清空，前者噪声，后者用户应自己手动做），
   * 所以这里把空数组也丢弃，要求 tags 必须至少 1 项才算有效 patch 项。
   */
  if (tags && tags.length > 0) patch.tags = tags;
  const faction = normalizeFaction(rawPatch.faction);
  if (faction !== undefined) patch.faction = faction;
  return Object.keys(patch).length > 0 ? patch : null;
}

/**
 * add 用：归一 contact 字段。
 * 必填：displayName + kind。其余字段缺失或非法时丢弃（confirm 阶段
 * applyAiGeneratedContacts 自带兜底）。
 */
function normalizeContact(rawContact) {
  if (!rawContact || typeof rawContact !== "object" || Array.isArray(rawContact)) return null;
  const displayName = normalizeOptionalString(rawContact.displayName, DISPLAY_NAME_MAX);
  if (!displayName) return null;
  const contact = {
    targetType: "virtual_contact",
    displayName,
    kind: normalizeKind(rawContact.kind),
  };
  const shortBio = normalizeOptionalString(rawContact.shortBio, SHORT_BIO_MAX);
  if (shortBio !== undefined) contact.shortBio = shortBio;
  const remark = normalizeOptionalString(rawContact.remark, REMARK_MAX);
  if (remark !== undefined) contact.remark = remark;
  const impression = normalizeOptionalString(rawContact.impression, IMPRESSION_MAX);
  if (impression !== undefined) contact.impression = impression;
  const relationshipHint = normalizeOptionalString(rawContact.relationshipHint, RELATIONSHIP_HINT_MAX);
  if (relationshipHint !== undefined) contact.relationshipHint = relationshipHint;
  const tags = normalizeTags(rawContact.tags);
  if (tags && tags.length > 0) contact.tags = tags;
  const faction = normalizeFaction(rawContact.faction);
  if (faction !== undefined) contact.faction = faction;
  const status = normalizeStatus(rawContact.status);
  if (status !== undefined) contact.status = status;
  const generatedReason = normalizeOptionalString(rawContact.generatedReason, GENERATED_REASON_MAX);
  if (generatedReason !== undefined) contact.generatedReason = generatedReason;
  return contact;
}

function newDraftId() {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `pcd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;
}

function draftsFilePath(agentDir) {
  return path.join(agentDir, "xingye", XINGYE_PHONE_CONTACT_DRAFTS_RELATIVE_PATH);
}

/**
 * 与 phone-store applyAiContactUpdates 的 hardcoded skip 对齐：
 * - user：仅 update 可用
 * - agent：仅 update 可用
 * - virtual_contact：全部 5 个 action 可用
 * 返回 null 表示组合不允许；否则返回归一后的 action。
 */
function resolveAction(action, targetType) {
  if (!PHONE_CONTACT_DRAFT_ALLOWED_ACTIONS.includes(action)) return null;
  if (targetType === "user" && action !== "update") return null;
  if (targetType === "agent" && action !== "update") return null;
  if (action === "add" && targetType !== "virtual_contact") return null;
  return action;
}

/**
 * 服务端 append 一条通讯录更新候选草稿。
 *
 * @param {object} args
 * @param {string} args.agentDir HANA_HOME/agents/{agentId}
 * @param {string} args.agentId
 * @param {{
 *   action?: 'update'|'add'|'block'|'delete'|'restore',
 *   targetType: 'agent'|'virtual_contact'|'user',
 *   targetId?: string,
 *   matchName?: string,
 *   displayName?: string,
 *   patch?: {
 *     remark?: string,
 *     impression?: string,
 *     relationshipHint?: string,
 *     tags?: string[],
 *     faction?: string,
 *   },
 *   contact?: {
 *     displayName: string,
 *     kind?: string,
 *     shortBio?: string,
 *     remark?: string,
 *     impression?: string,
 *     relationshipHint?: string,
 *     tags?: string[],
 *     faction?: string,
 *     status?: 'active'|'blocked'|'deleted',
 *     generatedReason?: string,
 *   },
 *   reason?: string,
 *   source: string,
 *   sourceEventIds?: string[],
 * }} args.input
 * @returns {Promise<object|null>}
 */
export async function appendPhoneContactDraftServer({ agentDir, agentId, input }) {
  if (typeof agentId !== "string" || !SAFE_AGENT_ID_RE.test(agentId)) return null;
  if (typeof agentDir !== "string" || !agentDir.trim()) return null;
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;

  const source = normalizeOptionalString(input.source);
  if (!source) return null;

  const targetType = typeof input.targetType === "string" ? input.targetType.trim() : "";
  if (!PHONE_CONTACT_DRAFT_ALLOWED_TARGET_TYPES.includes(targetType)) return null;

  const rawAction = typeof input.action === "string" ? input.action.trim() : "update";
  const action = resolveAction(rawAction || "update", targetType);
  if (!action) return null;

  const targetId = normalizeOptionalString(input.targetId);
  const matchName = normalizeOptionalString(input.matchName, DISPLAY_NAME_MAX);
  /**
   * 标识要求：
   * - update：必须有 targetId（user 用 "__user__"；agent 用 agentId；virtual_contact 用 vc.id）
   * - add：targetId 不需要（confirm 时由 applyAiGeneratedContacts 生成新 id）
   * - block/delete/restore：必须有 targetId 或 matchName 之一（与 applyAiContactUpdates 的解析策略一致）
   */
  if (action === "update" && !targetId) return null;
  if ((action === "block" || action === "delete" || action === "restore") && !targetId && !matchName) return null;

  let patch;
  let contact;
  if (action === "update") {
    patch = normalizePatch(input.patch);
    if (!patch) return null;
  } else if (action === "add") {
    contact = normalizeContact(input.contact);
    if (!contact) return null;
  }
  // block / delete / restore 不需要 patch / contact

  const displayName = normalizeOptionalString(input.displayName, DISPLAY_NAME_MAX)
    || (action === "add" ? contact?.displayName : undefined);
  const reason = normalizeOptionalString(input.reason, REASON_MAX);
  const sourceEventIds = Array.isArray(input.sourceEventIds)
    ? input.sourceEventIds.filter((entry) => typeof entry === "string" && entry.trim()).map((entry) => entry.trim())
    : undefined;

  const id = newDraftId();
  const createdAt = new Date().toISOString();
  const row = {
    id,
    key: id,
    action,
    targetType,
    targetId,
    matchName,
    displayName,
    patch,
    contact,
    reason,
    source,
    sourceEventIds,
    createdAt,
  };

  await withXingyeAgentEventLock(agentId, async () => {
    const file = draftsFilePath(agentDir);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.appendFile(file, `${JSON.stringify(row)}\n`, "utf-8");
  });

  try {
    await appendXingyeEvent({
      agentDir,
      agentId,
      input: {
        type: "phone_contact.draft_proposed",
        source,
        subjectId: id,
        payload: {
          draftId: id,
          action,
          targetType,
          targetId: targetId ?? null,
          matchName: matchName ?? null,
          patchFields: patch ? Object.keys(patch) : [],
          hasContact: Boolean(contact),
          reason: reason ?? null,
          sourceEventIds: sourceEventIds ?? [],
        },
      },
    });
  } catch (err) {
    console.warn(`[xingye-phone-contact-drafts] event log append failed: ${err?.message || err}`);
  }

  return {
    id,
    action,
    targetType,
    targetId,
    matchName,
    displayName,
    patch,
    contact,
    reason,
    source,
    sourceEventIds,
    createdAt,
  };
}
