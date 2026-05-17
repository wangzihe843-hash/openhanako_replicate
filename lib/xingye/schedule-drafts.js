/**
 * 服务端「待确认日程草稿」追加助手。
 *
 * 与渲染端 desktop/src/react/xingye/xingye-schedule-store.ts 的 `schedule/drafts.jsonl`
 * 是同一物理文件：UI 通过 /api/xingye/storage listJsonl 读，server 端这里直接 fs 追加。
 *
 * 关键点：
 *  - 仅写 drafts.jsonl，不写 entries.jsonl，不发 schedule.entry_appended；
 *    需要等用户在 PhoneScheduleApp「待确认草稿」区点确认，UI 才会调用
 *    confirmScheduleDraft 把它搬到 entries 并发 entry_appended。
 *  - 写完顺手 append 一条 schedule.draft_proposed 事件到 events/log.json，
 *    让下一轮心跳消费者能在「自上次巡检以来」里看到「日程草稿提议×N」。
 *  - 同 agent 内串行化追加复用 lib/xingye/events.js 的 per-agent lock。
 */

import fs from "node:fs";
import path from "node:path";

import { appendXingyeEvent, withXingyeAgentEventLock } from "./events.js";

export const XINGYE_SCHEDULE_DRAFTS_RELATIVE_PATH = path.join("schedule", "drafts.jsonl");

const SAFE_AGENT_ID_RE = /^[A-Za-z0-9_-]{1,120}$/;

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
  return `sch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;
}

function draftsFilePath(agentDir) {
  return path.join(agentDir, "xingye", XINGYE_SCHEDULE_DRAFTS_RELATIVE_PATH);
}

/**
 * 服务端 append 一条日程草稿。
 *
 * @param {object} args
 * @param {string} args.agentDir HANA_HOME/agents/{agentId}
 * @param {string} args.agentId
 * @param {{
 *   title: string,
 *   dateLabel: string,
 *   content: string,
 *   timeText?: string,
 *   note?: string,
 *   category?: string,
 *   reason?: string,
 *   source: string,
 *   sourceEventIds?: string[],
 * }} args.input
 * @returns {Promise<object|null>} 写入的草稿；非法输入 → null（不抛）。
 */
export async function appendScheduleDraftServer({ agentDir, agentId, input }) {
  if (typeof agentId !== "string" || !SAFE_AGENT_ID_RE.test(agentId)) return null;
  if (typeof agentDir !== "string" || !agentDir.trim()) return null;
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;

  /** 与渲染端 buildEntry 的尺寸约束一致：title ≤80、dateLabel ≤80、content ≤2000、note ≤500、category ≤24。 */
  const title = normalizeOptionalString(input.title, 80);
  const dateLabel = normalizeOptionalString(input.dateLabel, 80);
  const content = normalizeOptionalString(input.content, 2000);
  if (!title || !dateLabel || !content) return null;

  const source = normalizeOptionalString(input.source);
  if (!source) return null;

  const timeText = normalizeOptionalString(input.timeText, 80);
  const note = normalizeOptionalString(input.note, 500);
  const category = normalizeOptionalString(input.category, 24);
  const reason = normalizeOptionalString(input.reason);
  const sourceEventIds = Array.isArray(input.sourceEventIds)
    ? input.sourceEventIds.filter((entry) => typeof entry === "string" && entry.trim()).map((entry) => entry.trim())
    : undefined;

  const id = newDraftId();
  const createdAt = new Date().toISOString();
  const row = {
    id,
    key: id,
    title,
    dateLabel,
    timeText,
    content,
    note,
    category,
    createdAt,
    reason,
    source,
    sourceEventIds,
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
        type: "schedule.draft_proposed",
        source,
        subjectId: id,
        payload: {
          draftId: id,
          title,
          dateLabel,
          reason: reason ?? null,
          sourceEventIds: sourceEventIds ?? [],
        },
      },
    });
  } catch (err) {
    console.warn(`[xingye-schedule-drafts] event log append failed: ${err?.message || err}`);
  }

  return {
    id,
    title,
    dateLabel,
    timeText,
    content,
    note,
    category,
    createdAt,
    reason,
    source,
    sourceEventIds,
  };
}
