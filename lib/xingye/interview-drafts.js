/**
 * 服务端「待确认独家专访草稿（意图）」追加助手。
 *
 * 与渲染端 desktop/src/react/xingye/xingye-interview-drafts.ts 的
 * `secret-space/interview-drafts.jsonl` 是同一物理文件。
 *
 * 关键点：
 *  - 专访是固定 5 题 + 弹幕 + 幕后的重型结构化生成，心跳 agent 只提一个**意图**
 *    ——TA 愿意接受一次专访、用户想问的那一题（userQuestion，可空）。
 *  - 仅写 interview-drafts.jsonl，不写 interview.jsonl、不发 interview.entry_appended；
 *    用户在专访面板「待确认草稿」区点「确认录制」，UI 才用 userQuestion 跑
 *    generateSecretInterviewWithAI 生成整期专访并落地。
 *  - 写完 append 一条 interview.draft_proposed 事件供心跳消费者聚合。
 */

import fs from "node:fs";
import path from "node:path";

import { appendXingyeEvent, withXingyeAgentEventLock } from "./events.js";

export const XINGYE_INTERVIEW_DRAFTS_RELATIVE_PATH = path.join("secret-space", "interview-drafts.jsonl");

const SAFE_AGENT_ID_RE = /^[A-Za-z0-9_-]{1,120}$/;
const QUESTION_MAX = 200;
const REASON_MAX = 1000;

function normalizeOptionalString(value, maxLen) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return typeof maxLen === "number" ? trimmed.slice(0, maxLen) : trimmed;
}

function newDraftId() {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `interview-${globalThis.crypto.randomUUID()}`;
  }
  return `interview-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;
}

function draftsFilePath(agentDir) {
  return path.join(agentDir, "xingye", XINGYE_INTERVIEW_DRAFTS_RELATIVE_PATH);
}

/**
 * 服务端 append 一条专访意图草稿。
 *
 * @param {object} args
 * @param {string} args.agentDir HANA_HOME/agents/{agentId}
 * @param {string} args.agentId
 * @param {{ userQuestion?: string, reason?: string, source: string, sourceEventIds?: string[] }} args.input
 * @returns {Promise<object|null>} 写入的草稿；非法输入 → null（不抛）。
 */
export async function appendInterviewDraftServer({ agentDir, agentId, input }) {
  if (typeof agentId !== "string" || !SAFE_AGENT_ID_RE.test(agentId)) return null;
  if (typeof agentDir !== "string" || !agentDir.trim()) return null;
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;

  const source = normalizeOptionalString(input.source);
  if (!source) return null;

  const userQuestion = normalizeOptionalString(input.userQuestion, QUESTION_MAX);
  const reason = normalizeOptionalString(input.reason, REASON_MAX);
  const sourceEventIds = Array.isArray(input.sourceEventIds)
    ? input.sourceEventIds.filter((entry) => typeof entry === "string" && entry.trim()).map((entry) => entry.trim())
    : undefined;

  const id = newDraftId();
  const createdAt = new Date().toISOString();
  const row = { id, key: id, userQuestion, reason, source, sourceEventIds, createdAt };

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
        type: "interview.draft_proposed",
        source,
        subjectId: id,
        payload: {
          draftId: id,
          userQuestion: userQuestion ?? null,
          reason: reason ?? null,
          sourceEventIds: sourceEventIds ?? [],
        },
      },
    });
  } catch (err) {
    console.warn(`[xingye-interview-drafts] event log append failed: ${err?.message || err}`);
  }

  return { id, userQuestion, reason, source, sourceEventIds, createdAt };
}
