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
 *
 * **action='update' 形态（2026-05 引入，与 phone_contact 范式对齐）**：
 *  - 让 agent 把已有 entry 的更新建议落成草稿（patch.bodyAppend / title / summary / tags），
 *    而不是再 add 一条几乎同名的新 entry；
 *  - update 必须有 targetEntryId 或 matchTitle 之一 + 非空 patch；
 *  - body 字段采用 **bodyAppend**（追加段落），不是整体替换——files 笔记是累积式的，
 *    模型误判时只追加一段比覆写整篇代价小一个数量级；
 *  - confirm 阶段在渲染端 xingye-files-store#confirmFileDraft 按 action 分发：
 *    add 走 appendFileEntry（同时过相似度兜底），update 走 updateFileEntry 把
 *    patch 应用到 target entry。
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
const MATCH_TITLE_MAX = 160;
const TARGET_ID_MAX = 120;
const TAG_MAX = 32;
const TAG_LIST_MAX = 16;
const REASON_MAX = 1000;

export const FILES_DRAFT_ALLOWED_ACTIONS = Object.freeze(["add", "update"]);

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

/**
 * 归一 update 用的 patch：
 *  - 允许字段：title / bodyAppend / summary / tags
 *  - **不允许 folderId**：AI 不知道 folder uuid；用户在 UI confirm 阶段挪柜子
 *  - tags 空数组丢弃（与 phone_contact patch 一致：空数组等于不变 / 等于清空，前者噪声、
 *    后者用户应自己手动做）
 *  - 全部字段都缺 → null（调用方据此拒）
 */
export function normalizeFilesDraftPatch(rawPatch) {
  if (!rawPatch || typeof rawPatch !== "object" || Array.isArray(rawPatch)) return null;
  const patch = {};
  const title = normalizeOptionalString(rawPatch.title, TITLE_MAX);
  if (title !== undefined) patch.title = title;
  if (typeof rawPatch.bodyAppend === "string") {
    const trimmed = rawPatch.bodyAppend.trim();
    if (trimmed) patch.bodyAppend = trimmed.slice(0, BODY_MAX);
  }
  const summary = normalizeOptionalString(rawPatch.summary, SUMMARY_MAX);
  if (summary !== undefined) patch.summary = summary;
  const tags = normalizeTags(rawPatch.tags);
  if (tags && tags.length > 0) patch.tags = tags;
  return Object.keys(patch).length > 0 ? patch : null;
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
 *   action?: 'add'|'update',
 *   targetEntryId?: string,
 *   matchTitle?: string,
 *   patch?: { title?: string, bodyAppend?: string, summary?: string, tags?: string[] },
 *   title?: string,
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

  const source = normalizeOptionalString(input.source);
  if (!source) return null;

  const rawAction = typeof input.action === "string" ? input.action.trim() : "add";
  const action = FILES_DRAFT_ALLOWED_ACTIONS.includes(rawAction) ? rawAction : "add";

  const title = normalizeOptionalString(input.title, TITLE_MAX);
  const body = typeof input.body === "string" ? input.body.slice(0, BODY_MAX) : "";
  const summary = normalizeOptionalString(input.summary, SUMMARY_MAX);
  const folderHint = normalizeOptionalString(input.folderHint, FOLDER_HINT_MAX);
  const tags = normalizeTags(input.tags);
  const reason = normalizeOptionalString(input.reason, REASON_MAX);
  const sourceEventIds = Array.isArray(input.sourceEventIds)
    ? input.sourceEventIds.filter((entry) => typeof entry === "string" && entry.trim()).map((entry) => entry.trim())
    : undefined;

  let targetEntryId;
  let matchTitle;
  let patch;
  if (action === "add") {
    if (!title) return null;
  } else {
    targetEntryId = normalizeOptionalString(input.targetEntryId, TARGET_ID_MAX);
    matchTitle = normalizeOptionalString(input.matchTitle, MATCH_TITLE_MAX);
    if (!targetEntryId && !matchTitle) return null;
    patch = normalizeFilesDraftPatch(input.patch);
    if (!patch) return null;
  }

  const id = newDraftId();
  const createdAt = new Date().toISOString();
  const row = {
    id,
    key: id,
    action,
    targetEntryId,
    matchTitle,
    patch,
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
          action,
          targetEntryId: targetEntryId ?? null,
          matchTitle: matchTitle ?? null,
          patchFields: patch ? Object.keys(patch) : [],
          title: title ?? null,
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

  return {
    id,
    action,
    targetEntryId,
    matchTitle,
    patch,
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
}
