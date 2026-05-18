/**
 * 服务端「待确认重要记忆候选草稿」追加助手。
 *
 * 与渲染端 desktop/src/react/xingye/xingye-memory-candidate-store.ts 的
 * `memory-candidate/drafts.jsonl` 是同一物理文件：UI 通过 /api/xingye/storage
 * listJsonl 读，server 端这里直接 fs 追加。
 *
 * 关键点：
 *  - 不直接落入 localStorage 的 `xingye.memoryCandidates`（那是 MemoryCandidatePanel
 *    走「用户手动点 AI 生成」时存放正式候选的地方）；本草稿是 agent 巡检主动提议，
 *    需要用户在 MemoryCandidatePanel 的「待确认 · 来自心跳巡检」区点「采纳为候选」
 *    后才会调用 createXingyeMemoryCandidate 把它转成 status=pending 的正式候选。
 *  - 仅 target=pinned 可写（与 confirmXingyeMemoryCandidate 的可写性断言一致）；
 *    其它 target（fact / longterm / unknown）不在巡检产出范围。
 *  - importance 在工具层用 low / medium / high 字符串接收；server 端归一为 number
 *    1/2/3（与 XINGYE_MEMORY_CANDIDATE_IMPORTANCE_* 一致），方便 UI 直接读。
 *  - 写完发一条 memory_candidate.draft_proposed 事件，让心跳摘要里能聚合。
 */

import path from "node:path";
import fs from "node:fs";

import { appendXingyeEvent, withXingyeAgentEventLock } from "./events.js";

export const XINGYE_MEMORY_CANDIDATE_DRAFTS_RELATIVE_PATH = path.join("memory-candidate", "drafts.jsonl");

const SAFE_AGENT_ID_RE = /^[A-Za-z0-9_-]{1,120}$/;

const CONTENT_MAX = 600;
const REASON_MAX = 300;

export const MEMORY_CANDIDATE_DRAFT_ALLOWED_IMPORTANCE = Object.freeze(["low", "medium", "high"]);

function importanceLevelToNumber(level) {
  if (level === "low") return 1;
  if (level === "high") return 3;
  return 2;
}

function normalizeOptionalString(value, maxLen) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return typeof maxLen === "number" ? trimmed.slice(0, maxLen) : trimmed;
}

function newDraftId() {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `mcd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;
}

function draftsFilePath(agentDir) {
  return path.join(agentDir, "xingye", XINGYE_MEMORY_CANDIDATE_DRAFTS_RELATIVE_PATH);
}

/**
 * 服务端 append 一条记忆候选草稿。
 *
 * @param {object} args
 * @param {string} args.agentDir HANA_HOME/agents/{agentId}
 * @param {string} args.agentId
 * @param {{
 *   content: string,
 *   importance?: 'low'|'medium'|'high',
 *   reason?: string,
 *   source: string,
 *   sourceEventIds?: string[],
 * }} args.input
 * @returns {Promise<object|null>}
 */
export async function appendMemoryCandidateDraftServer({ agentDir, agentId, input }) {
  if (typeof agentId !== "string" || !SAFE_AGENT_ID_RE.test(agentId)) return null;
  if (typeof agentDir !== "string" || !agentDir.trim()) return null;
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;

  const content = normalizeOptionalString(input.content, CONTENT_MAX);
  if (!content) return null;
  const source = normalizeOptionalString(input.source);
  if (!source) return null;
  const importanceLevel = MEMORY_CANDIDATE_DRAFT_ALLOWED_IMPORTANCE.includes(input.importance)
    ? input.importance
    : "medium";
  const importance = importanceLevelToNumber(importanceLevel);
  const reason = normalizeOptionalString(input.reason, REASON_MAX);
  const sourceEventIds = Array.isArray(input.sourceEventIds)
    ? input.sourceEventIds.filter((entry) => typeof entry === "string" && entry.trim()).map((entry) => entry.trim())
    : undefined;

  const id = newDraftId();
  const createdAt = new Date().toISOString();
  const row = {
    id,
    key: id,
    content,
    importance,
    importanceLevel,
    target: "pinned",
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
        type: "memory_candidate.draft_proposed",
        source,
        subjectId: id,
        payload: {
          draftId: id,
          importance,
          importanceLevel,
          target: "pinned",
          reason: reason ?? null,
          sourceEventIds: sourceEventIds ?? [],
        },
      },
    });
  } catch (err) {
    console.warn(`[xingye-memory-candidate-drafts] event log append failed: ${err?.message || err}`);
  }

  return {
    id,
    content,
    importance,
    importanceLevel,
    target: "pinned",
    reason,
    source,
    sourceEventIds,
    createdAt,
  };
}
