/**
 * 服务端「待确认读书批注草稿」追加助手。
 *
 * 与渲染端 desktop/src/react/xingye/xingye-app-entry-store.ts 的
 * `apps/reading_notes/drafts.jsonl` 是同一物理文件：UI 通过 /api/xingye/storage
 * listJsonl 读，server 端这里直接 fs 追加。
 *
 * 关键点：
 *  - 仅写 drafts.jsonl，不写 entries.jsonl，不发 reading_notes.entry_appended；
 *    用户在 PhoneReadingNotesApp「待确认草稿」区点确认，UI 才调用
 *    confirmReadingNoteDraft 把它搬进 entries.jsonl 并发
 *    reading_notes.entry_appended + reading_notes.draft_confirmed。
 *  - 草稿层不带 bookId（巡检里 agent 不知道用户私人书架的 uuid），只接
 *    `bookHint`（书名/作者关键词）；confirm 时按名字匹配最近一次导入的同名书，
 *    匹配不上就让 entry 不带 bookId（仍能落盘，UI 把它放到「未归类批注」）。
 *  - title / body 必填；noteType 默认 'reading_note'（最普遍的语义）。
 *  - quoteText 可选，confirm 时包裹成 { text, source: 'manual' } 形态写入 metadata。
 *  - 写完 append 一条 reading_notes.draft_proposed 事件供心跳消费者聚合。
 */

import fs from "node:fs";
import path from "node:path";

import { appendXingyeEvent, withXingyeAgentEventLock } from "./events.js";

export const XINGYE_READING_NOTES_DRAFTS_RELATIVE_PATH = path.join("apps", "reading_notes", "drafts.jsonl");

const SAFE_AGENT_ID_RE = /^[A-Za-z0-9_-]{1,120}$/;

/**
 * 与 desktop/src/react/xingye/PhoneReadingNotesApp.tsx NOTE_TYPE_LABELS 同步。
 * 草稿允许的 noteType 仅 reading_note / question 两个——其它两个（want_to_read /
 * pre_read）是用户在浏览阶段加的标签，agent 巡检场景不适合主动推。
 */
const ALLOWED_NOTE_TYPES = new Set(["reading_note", "question"]);
const TITLE_MAX = 160;
const BODY_MAX = 4000;
const BOOK_HINT_MAX = 120;
const QUOTE_MAX = 600;
const REASON_MAX = 1000;

function normalizeOptionalString(value, maxLen) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return typeof maxLen === "number" ? trimmed.slice(0, maxLen) : trimmed;
}

function normalizeNoteType(value) {
  return typeof value === "string" && ALLOWED_NOTE_TYPES.has(value) ? value : "reading_note";
}

function newDraftId() {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `read-${globalThis.crypto.randomUUID()}`;
  }
  return `read-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;
}

function draftsFilePath(agentDir) {
  return path.join(agentDir, "xingye", XINGYE_READING_NOTES_DRAFTS_RELATIVE_PATH);
}

/**
 * 服务端 append 一条读书批注草稿。
 *
 * @param {object} args
 * @param {string} args.agentDir HANA_HOME/agents/{agentId}
 * @param {string} args.agentId
 * @param {{
 *   title: string,
 *   body: string,
 *   noteType?: 'reading_note' | 'question',
 *   bookHint?: string,
 *   quoteText?: string,
 *   reason?: string,
 *   source: string,
 *   sourceEventIds?: string[],
 * }} args.input
 * @returns {Promise<object|null>} 写入的草稿；非法输入 → null（不抛）。
 */
export async function appendReadingNoteDraftServer({ agentDir, agentId, input }) {
  if (typeof agentId !== "string" || !SAFE_AGENT_ID_RE.test(agentId)) return null;
  if (typeof agentDir !== "string" || !agentDir.trim()) return null;
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;

  const title = normalizeOptionalString(input.title, TITLE_MAX);
  if (!title) return null;
  const body = normalizeOptionalString(input.body, BODY_MAX);
  if (!body) return null;
  const source = normalizeOptionalString(input.source);
  if (!source) return null;

  const noteType = normalizeNoteType(input.noteType);
  const bookHint = normalizeOptionalString(input.bookHint, BOOK_HINT_MAX);
  const quoteText = normalizeOptionalString(input.quoteText, QUOTE_MAX);
  const reason = normalizeOptionalString(input.reason, REASON_MAX);
  const sourceEventIds = Array.isArray(input.sourceEventIds)
    ? input.sourceEventIds.filter((entry) => typeof entry === "string" && entry.trim()).map((entry) => entry.trim())
    : undefined;

  const id = newDraftId();
  const createdAt = new Date().toISOString();
  const row = {
    id,
    key: id,
    title,
    body,
    noteType,
    bookHint,
    quoteText,
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
        type: "reading_notes.draft_proposed",
        source,
        subjectId: id,
        payload: {
          draftId: id,
          title,
          noteType,
          bookHint: bookHint ?? null,
          hasQuote: Boolean(quoteText),
          reason: reason ?? null,
          sourceEventIds: sourceEventIds ?? [],
        },
      },
    });
  } catch (err) {
    console.warn(`[xingye-reading-notes-drafts] event log append failed: ${err?.message || err}`);
  }

  return { id, title, body, noteType, bookHint, quoteText, reason, source, sourceEventIds, createdAt };
}
