/**
 * 服务端「待确认通讯录更新候选」追加助手。
 *
 * 与渲染端 desktop/src/react/xingye/xingye-phone-contact-drafts.ts 共用同一份
 * `phone-contact/drafts.jsonl`：UI 通过 /api/xingye/storage listJsonl 读，server
 * 这里直接 fs 追加。
 *
 * 设计取舍（与 memory_candidate / relationship_state 的差别）：
 *  - **仅支持「对现有联系人的更新候选」**：必须带 targetType + targetId，且
 *    targetType ∈ {agent, virtual_contact, user}。本工具**不接受**「新增联系人」
 *    或「拉黑 / 删除 / 恢复」类候选——那些是 phone-ai 增量更新路径的事，由用户
 *    在小手机通讯录界面手动触发 AI 更新走完。
 *  - patch 仅允许 5 个"印象 / 关系判断"类字段：remark / impression /
 *    relationshipHint / tags / faction。**不允许**改 status / faction 之外的
 *    骨架字段（displayName / kind / shortBio / avatarDataUrl / linkedAgentId）。
 *  - patch 必须至少包含一个非空字段，否则没有可应用的内容，拒。
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
const REMARK_MAX = 120;
const IMPRESSION_MAX = 600;
const RELATIONSHIP_HINT_MAX = 120;
const TAG_MAX_LEN = 32;
const TAGS_MAX_COUNT = 8;
const REASON_MAX = 500;

export const PHONE_CONTACT_DRAFT_ALLOWED_TARGET_TYPES = Object.freeze([
  "agent",
  "virtual_contact",
  "user",
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
 * 服务端 append 一条通讯录更新候选草稿。
 *
 * @param {object} args
 * @param {string} args.agentDir HANA_HOME/agents/{agentId}
 * @param {string} args.agentId
 * @param {{
 *   targetType: 'agent'|'virtual_contact'|'user',
 *   targetId: string,
 *   displayName?: string,
 *   patch: {
 *     remark?: string,
 *     impression?: string,
 *     relationshipHint?: string,
 *     tags?: string[],
 *     faction?: string,
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
  const targetId = normalizeOptionalString(input.targetId);
  if (!targetId) return null;

  const patch = normalizePatch(input.patch);
  if (!patch) return null;

  const displayName = normalizeOptionalString(input.displayName, DISPLAY_NAME_MAX);
  const reason = normalizeOptionalString(input.reason, REASON_MAX);
  const sourceEventIds = Array.isArray(input.sourceEventIds)
    ? input.sourceEventIds.filter((entry) => typeof entry === "string" && entry.trim()).map((entry) => entry.trim())
    : undefined;

  const id = newDraftId();
  const createdAt = new Date().toISOString();
  const row = {
    id,
    key: id,
    targetType,
    targetId,
    displayName,
    patch,
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
          targetType,
          targetId,
          patchFields: Object.keys(patch),
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
    targetType,
    targetId,
    displayName,
    patch,
    reason,
    source,
    sourceEventIds,
    createdAt,
  };
}
