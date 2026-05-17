/**
 * 服务端「待确认日记草稿」追加助手。
 *
 * 与渲染端 desktop/src/react/xingye/xingye-journal-store.ts 的 `journal/drafts.jsonl`
 * 是同一物理文件：UI 通过 /api/xingye/storage listJsonl 读，server 端这里直接 fs 追加。
 *
 * 关键点：
 *  - 仅写 drafts.jsonl，不写 entries.jsonl，不发 journal.entry_appended；
 *    需要等用户在 PhoneJournalApp「待确认草稿」区点确认，UI 才会调用
 *    confirmJournalDraft 把它搬到 entries 并发 entry_appended。
 *  - 写完顺手 append 一条 journal.draft_proposed 事件到 events/log.json，
 *    让下一轮心跳消费者能在「自上次巡检以来」里看到「日记草稿提议×N」。
 *  - 同 agent 内串行化追加复用 lib/xingye/events.js 的 per-agent lock，
 *    避免 fs.appendFile 并发交叉。
 */

import fs from "node:fs";
import path from "node:path";

import { appendXingyeEvent, withXingyeAgentEventLock } from "./events.js";

export const XINGYE_JOURNAL_DRAFTS_RELATIVE_PATH = path.join("journal", "drafts.jsonl");

const SAFE_AGENT_ID_RE = /^[A-Za-z0-9_-]{1,120}$/;
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

function normalizeOptionalString(value, maxLen) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return typeof maxLen === "number" ? trimmed.slice(0, maxLen) : trimmed;
}

function localDayKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function newDraftId() {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `j-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;
}

function draftsFilePath(agentDir) {
  return path.join(agentDir, "xingye", XINGYE_JOURNAL_DRAFTS_RELATIVE_PATH);
}

/**
 * 服务端 append 一条日记草稿。
 *
 * @param {object} args
 * @param {string} args.agentDir HANA_HOME/agents/{agentId}
 * @param {string} args.agentId
 * @param {{ title?: string, body: string, dayKey?: string, mood?: string, reason?: string,
 *           source: string, sourceEventIds?: string[] }} args.input
 * @returns {Promise<object|null>} 写入的草稿；非法输入 → null（不抛）。
 */
export async function appendJournalDraftServer({ agentDir, agentId, input }) {
  if (typeof agentId !== "string" || !SAFE_AGENT_ID_RE.test(agentId)) return null;
  if (typeof agentDir !== "string" || !agentDir.trim()) return null;
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const body = typeof input.body === "string" ? input.body.trim() : "";
  if (!body) return null;
  const source = normalizeOptionalString(input.source);
  if (!source) return null;
  const now = new Date();
  const dayKey = typeof input.dayKey === "string" && DAY_KEY_RE.test(input.dayKey)
    ? input.dayKey
    : localDayKey(now);
  const title = normalizeOptionalString(input.title) || "无标题";
  const mood = normalizeOptionalString(input.mood, 24);
  const reason = normalizeOptionalString(input.reason);
  const sourceEventIds = Array.isArray(input.sourceEventIds)
    ? input.sourceEventIds.filter((entry) => typeof entry === "string" && entry.trim()).map((entry) => entry.trim())
    : undefined;
  const id = newDraftId();
  const createdAt = now.toISOString();
  const row = {
    id,
    key: id,
    dayKey,
    title,
    body,
    createdAt,
    mood,
    reason,
    source,
    sourceEventIds,
  };

  /**
   * 串行化追加：共用 events.js 的 per-agent lock 避免 fs.appendFile + 同一 agent
   * 的事件 append 互相切片。锁的语义只是「同一 agent 串行」，与「事件 vs 草稿文件」
   * 在哪个文件无关；让两条路径共用同一把锁更省心。
   */
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
        type: "journal.draft_proposed",
        source,
        subjectId: id,
        payload: {
          draftId: id,
          dayKey,
          title,
          hasMood: Boolean(mood),
          reason: reason ?? null,
          sourceEventIds: sourceEventIds ?? [],
        },
      },
    });
  } catch (err) {
    /** event log 失败不阻塞 draft 落盘；UI 仍能在「待确认草稿」区看到。 */
    console.warn(`[xingye-journal-drafts] event log append failed: ${err?.message || err}`);
  }

  return {
    id,
    dayKey,
    title,
    body,
    createdAt,
    mood,
    reason,
    source,
    sourceEventIds,
  };
}
