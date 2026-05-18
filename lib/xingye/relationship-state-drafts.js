/**
 * 服务端「待确认关系状态草稿」追加助手。
 *
 * 与渲染端 desktop/src/react/xingye/xingye-state-store.ts 的关系状态草稿读取路径
 * `relationship-state/drafts.jsonl` 是同一物理文件：UI 通过 /api/xingye/storage
 * listJsonl 读，server 端这里直接 fs 追加。
 *
 * 关键点：
 *  - 不直接调用 updateRelationshipState（那是 RelationshipStatePanel 在用户点
 *    「接受建议」时走的路径）；本草稿是 agent 巡检主动提议，需要用户在
 *    RelationshipStatePanel 的「待确认 · 来自心跳巡检」区点「应用建议」后才会
 *    把 5 个 delta + mood + stateSummary + reason 应用到本地 relationshipState。
 *  - delta 字段范围与 RelationshipStatePanel.METRICS 一致：
 *      affectionDelta: -100..150（其它都是 -100..100，jealousy/corruption 也允许 -）
 *    server 端只做粗钳（剪到合理范围内），细致校验在 UI confirm 时再做。
 *  - 五个 delta 至少要有一项非零，或者 mood 必填；否则没有可应用的内容，拒。
 *  - 写完发一条 relationship_state.draft_proposed 事件，让心跳摘要里能聚合。
 */

import path from "node:path";
import fs from "node:fs";

import { appendXingyeEvent, withXingyeAgentEventLock } from "./events.js";

export const XINGYE_RELATIONSHIP_STATE_DRAFTS_RELATIVE_PATH = path.join("relationship-state", "drafts.jsonl");

const SAFE_AGENT_ID_RE = /^[A-Za-z0-9_-]{1,120}$/;

const MOOD_MAX = 40;
const SUMMARY_MAX = 200;
const REASON_MAX = 500;

const DELTA_BOUNDS = {
  affectionDelta: { min: -100, max: 150 },
  trustDelta: { min: -100, max: 100 },
  loyaltyDelta: { min: -100, max: 100 },
  jealousyDelta: { min: -100, max: 100 },
  corruptionDelta: { min: -100, max: 100 },
};

function normalizeOptionalString(value, maxLen) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return typeof maxLen === "number" ? trimmed.slice(0, maxLen) : trimmed;
}

function normalizeDelta(value, key) {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  const bounds = DELTA_BOUNDS[key];
  if (!bounds) return 0;
  const rounded = Math.trunc(value);
  if (rounded < bounds.min) return bounds.min;
  if (rounded > bounds.max) return bounds.max;
  return rounded;
}

function newDraftId() {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `rsd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;
}

function draftsFilePath(agentDir) {
  return path.join(agentDir, "xingye", XINGYE_RELATIONSHIP_STATE_DRAFTS_RELATIVE_PATH);
}

/**
 * 服务端 append 一条关系状态草稿。
 *
 * @param {object} args
 * @param {string} args.agentDir HANA_HOME/agents/{agentId}
 * @param {string} args.agentId
 * @param {{
 *   affectionDelta?: number,
 *   trustDelta?: number,
 *   loyaltyDelta?: number,
 *   jealousyDelta?: number,
 *   corruptionDelta?: number,
 *   mood?: string,
 *   stateSummary?: string,
 *   reasonText?: string,
 *   reason?: string,
 *   source: string,
 *   sourceEventIds?: string[],
 * }} args.input
 * @returns {Promise<object|null>}
 */
export async function appendRelationshipStateDraftServer({ agentDir, agentId, input }) {
  if (typeof agentId !== "string" || !SAFE_AGENT_ID_RE.test(agentId)) return null;
  if (typeof agentDir !== "string" || !agentDir.trim()) return null;
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;

  const source = normalizeOptionalString(input.source);
  if (!source) return null;

  const deltas = {
    affectionDelta: normalizeDelta(input.affectionDelta, "affectionDelta"),
    trustDelta: normalizeDelta(input.trustDelta, "trustDelta"),
    loyaltyDelta: normalizeDelta(input.loyaltyDelta, "loyaltyDelta"),
    jealousyDelta: normalizeDelta(input.jealousyDelta, "jealousyDelta"),
    corruptionDelta: normalizeDelta(input.corruptionDelta, "corruptionDelta"),
  };
  const mood = normalizeOptionalString(input.mood, MOOD_MAX);
  const stateSummary = normalizeOptionalString(input.stateSummary, SUMMARY_MAX);
  /**
   * 兼容两种命名：reasonText（明确字段）和 reason（与其它模块草稿一致的"为何提议"）。
   * 关系状态语义里这两个其实是同一个东西——agent 写下"建议变化的原因"，UI 展示给
   * 用户帮他决定要不要应用。优先用 reasonText，回退到 reason。
   */
  const reasonText = normalizeOptionalString(input.reasonText, REASON_MAX)
    || normalizeOptionalString(input.reason, REASON_MAX);

  /**
   * 至少要有一个有效的状态变化：任一 delta 非零，或 mood 非空。
   * stateSummary / reasonText 单独不能成为有效草稿（只描述但不动状态）。
   */
  const hasDelta = Object.values(deltas).some((d) => d !== 0);
  if (!hasDelta && !mood) return null;

  const sourceEventIds = Array.isArray(input.sourceEventIds)
    ? input.sourceEventIds.filter((entry) => typeof entry === "string" && entry.trim()).map((entry) => entry.trim())
    : undefined;

  const id = newDraftId();
  const createdAt = new Date().toISOString();
  const row = {
    id,
    key: id,
    targetType: "user",
    targetId: "__user__",
    ...deltas,
    mood,
    stateSummary,
    reasonText,
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
        type: "relationship_state.draft_proposed",
        source,
        subjectId: id,
        payload: {
          draftId: id,
          ...deltas,
          hasMood: Boolean(mood),
          reasonSummary: reasonText ? reasonText.slice(0, 180) : null,
          sourceEventIds: sourceEventIds ?? [],
        },
      },
    });
  } catch (err) {
    console.warn(`[xingye-relationship-state-drafts] event log append failed: ${err?.message || err}`);
  }

  return {
    id,
    targetType: "user",
    targetId: "__user__",
    ...deltas,
    mood,
    stateSummary,
    reasonText,
    source,
    sourceEventIds,
    createdAt,
  };
}
