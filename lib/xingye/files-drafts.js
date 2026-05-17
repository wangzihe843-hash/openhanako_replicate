/**
 * 服务端「待确认资料柜草稿」追加助手。
 *
 * 与渲染端 desktop/src/react/xingye/xingye-files-store.ts 的 `files/drafts.jsonl`
 * 是同一物理文件：UI 通过 /api/xingye/storage listJsonl 读，server 端这里直接 fs 追加。
 *
 * 关键点：
 *  - 仅写 drafts.jsonl，不写 entries.jsonl，不发 file.entry_appended；
 *    需要等用户在 PhoneFilesApp「待确认草稿」区点确认（可改 folderId）后才 confirm。
 *  - 草稿不含 folderId —— 巡检里 agent 不知道用户私人的 folder uuid。允许 agent
 *    给一个 `folderHint`（按文件夹**名字**而非 id），UI 在 confirm 时优先匹配同名
 *    folder，匹配不上回退到「待确认」folder（DEFAULT_FILE_FOLDER_BLUEPRINTS 里有）。
 *  - 写完顺手 append 一条 file.draft_proposed 事件，便于心跳消费者聚合。
 */

import fs from "node:fs";
import path from "node:path";

import { appendXingyeEvent, withXingyeAgentEventLock } from "./events.js";

export const XINGYE_FILES_DRAFTS_RELATIVE_PATH = path.join("files", "drafts.jsonl");

const SAFE_AGENT_ID_RE = /^[A-Za-z0-9_-]{1,120}$/;
const TITLE_MAX = 160;
const BODY_MAX = 8000;
const SUMMARY_MAX = 300;
const FOLDER_HINT_MAX = 80;
const TAG_MAX = 32;
const TAG_LIST_MAX = 16;

function normalizeOptionalString(value, maxLen) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return typeof maxLen === "number" ? trimmed.slice(0, maxLen) : trimmed;
}

function normalizeTags(value) {
  if (!Array.isArray(value)) return undefined;
  const out = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    out.push(trimmed.slice(0, TAG_MAX));
    if (out.length >= TAG_LIST_MAX) break;
  }
  return out.length ? out : undefined;
}

function newDraftId() {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `fil-${globalThis.crypto.randomUUID()}`;
  }
  return `fil-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;
}

function draftsFilePath(agentDir) {
  return path.join(agentDir, "xingye", XINGYE_FILES_DRAFTS_RELATIVE_PATH);
}

/**
 * 服务端 append 一条资料柜草稿。
 *
 * @param {object} args
 * @param {string} args.agentDir HANA_HOME/agents/{agentId}
 * @param {string} args.agentId
 * @param {{
 *   title: string,
 *   body?: string,
 *   summary?: string,
 *   folderHint?: string,
 *   tags?: string[],
 *   reason?: string,
 *   source: string,
 *   sourceEventIds?: string[],
 * }} args.input
 * @returns {Promise<object|null>} 写入的草稿；非法输入 → null（不抛）。
 */
export async function appendFilesDraftServer({ agentDir, agentId, input }) {
  if (typeof agentId !== "string" || !SAFE_AGENT_ID_RE.test(agentId)) return null;
  if (typeof agentDir !== "string" || !agentDir.trim()) return null;
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;

  const title = normalizeOptionalString(input.title, TITLE_MAX);
  if (!title) return null;

  const source = normalizeOptionalString(input.source);
  if (!source) return null;

  const body = typeof input.body === "string" ? input.body.slice(0, BODY_MAX) : "";
  const summary = normalizeOptionalString(input.summary, SUMMARY_MAX);
  const folderHint = normalizeOptionalString(input.folderHint, FOLDER_HINT_MAX);
  const tags = normalizeTags(input.tags);
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
    body,
    summary,
    folderHint,
    tags,
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
        type: "file.draft_proposed",
        source,
        subjectId: id,
        payload: {
          draftId: id,
          title,
          folderHint: folderHint ?? null,
          hasBody: Boolean(body.trim()),
          reason: reason ?? null,
          sourceEventIds: sourceEventIds ?? [],
        },
      },
    });
  } catch (err) {
    console.warn(`[xingye-files-drafts] event log append failed: ${err?.message || err}`);
  }

  return { id, title, body, summary, folderHint, tags, createdAt, reason, source, sourceEventIds };
}
