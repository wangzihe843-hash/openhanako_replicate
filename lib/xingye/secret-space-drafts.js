/**
 * 服务端「待确认秘密空间草稿」追加助手。
 *
 * 与渲染端 desktop/src/react/xingye/xingye-secret-space-drafts.ts 的
 * `secret-space/drafts.jsonl` 是同一物理文件：UI 通过 /api/xingye/storage
 * listJsonl 读，server 端这里直接 fs 追加。
 *
 * 关键点：
 *  - 仅写 drafts.jsonl，不写 secret-space/{category}.jsonl，不发 secret_space.record_appended；
 *    需要等用户在 SecretSpacePanel「待确认草稿」区点确认，UI 才会调用
 *    confirmSecretSpaceDraft 把它搬进对应 category 文件并发 record_appended +
 *    secret_space.draft_confirmed。
 *  - 限制 category 为「不会自动外发、永远只属于秘密空间」的五个子集：
 *      state / dream / saved_item / draft_reply / unsent_moment
 *    （`draft_reply` 与 `mail.draft` 的区别：mail.draft 是真要寄出的信，draft_reply
 *     永远不发——存在的意义是「TA 选择了沉默」。`unsent_moment` 与 `moments.draft`
 *     同理：moments.draft 会进朋友圈 feed 给联系人看，unsent_moment 永远只属于秘密
 *     空间，不公开。`memory_fragment` 仍排除——走 MemoryCandidatePanel 经
 *     `memory_candidate` 模块（用户手动点 AI 生成候选 + 人工 confirm/reject，或
 *     agent 通过 xingye_propose_draft 的 memory_candidate 模块提议）。）
 *  - 草稿不带 meta JSON（meta 是 category-dependent 自由字段，让用户在 confirm
 *    时补；本工具只接 `title` + `body` + 可选 `tags`，最大化跨 category 兼容）。
 *  - 写完顺手 append 一条 secret_space.draft_proposed 事件，便于心跳消费者聚合。
 */

import fs from "node:fs";
import path from "node:path";

import { appendXingyeEvent, withXingyeAgentEventLock } from "./events.js";
import { normalizeSecretSpaceDraftRevisions } from "./secret-space-draft-revisions.js";

export const XINGYE_SECRET_SPACE_DRAFTS_RELATIVE_PATH = path.join("secret-space", "drafts.jsonl");

const SAFE_AGENT_ID_RE = /^[A-Za-z0-9_-]{1,120}$/;

/** 允许 propose-draft 走的 category 子集；其它 category 会被拒。 */
export const SECRET_SPACE_DRAFT_ALLOWED_CATEGORIES = Object.freeze([
  "state",
  "dream",
  "saved_item",
  "draft_reply",
  "unsent_moment",
]);

const TITLE_MAX = 160;
const BODY_MAX = 4000;
const TAG_MAX = 32;
const TAG_LIST_MAX = 8;

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
    return `ss-${globalThis.crypto.randomUUID()}`;
  }
  return `ss-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;
}

function draftsFilePath(agentDir) {
  return path.join(agentDir, "xingye", XINGYE_SECRET_SPACE_DRAFTS_RELATIVE_PATH);
}

/**
 * 服务端 append 一条秘密空间草稿。
 *
 * @param {object} args
 * @param {string} args.agentDir HANA_HOME/agents/{agentId}
 * @param {string} args.agentId
 * @param {{
 *   category: 'state' | 'dream' | 'saved_item' | 'draft_reply' | 'unsent_moment',
 *   title?: string,
 *   body: string,
 *   tags?: string[],
 *   reason?: string,
 *   source: string,
 *   sourceEventIds?: string[],
 *   revisions?: object,
 * }} args.input
 *
 * `revisions` 仅在 category === 'draft_reply' 时被采纳——其它分类的草稿没有
 * 「划掉重写」的 UI 语义,字段会被丢弃。详见 secret-space-draft-revisions.js。
 * @returns {Promise<object|null>} 写入的草稿；非法输入 → null（不抛）。
 */
export async function appendSecretSpaceDraftServer({ agentDir, agentId, input }) {
  if (typeof agentId !== "string" || !SAFE_AGENT_ID_RE.test(agentId)) return null;
  if (typeof agentDir !== "string" || !agentDir.trim()) return null;
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;

  const category = typeof input.category === "string" ? input.category.trim() : "";
  if (!SECRET_SPACE_DRAFT_ALLOWED_CATEGORIES.includes(category)) return null;

  const body = typeof input.body === "string" ? input.body.trim().slice(0, BODY_MAX) : "";
  if (!body) return null;

  const source = normalizeOptionalString(input.source);
  if (!source) return null;

  const title = normalizeOptionalString(input.title, TITLE_MAX);
  const tags = normalizeTags(input.tags);
  const reason = normalizeOptionalString(input.reason);
  const sourceEventIds = Array.isArray(input.sourceEventIds)
    ? input.sourceEventIds.filter((entry) => typeof entry === "string" && entry.trim()).map((entry) => entry.trim())
    : undefined;

  /**
   * revisions(划掉的开场白 / 段间补丁 / 边角批注)只对 draft_reply 有意义。
   * 其它 category 即便误传也丢弃,防止脏数据污染 jsonl。
   */
  const revisions = category === "draft_reply"
    ? normalizeSecretSpaceDraftRevisions(input.revisions)
    : null;

  const id = newDraftId();
  const createdAt = new Date().toISOString();
  const row = {
    id,
    key: id,
    category,
    title,
    body,
    tags,
    createdAt,
    reason,
    source,
    sourceEventIds,
    ...(revisions ? { revisions } : {}),
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
        type: "secret_space.draft_proposed",
        source,
        subjectId: id,
        payload: {
          draftId: id,
          category,
          titleExcerpt: title ? title.slice(0, 60) : null,
          bodyExcerpt: body.slice(0, 60),
          reason: reason ?? null,
          sourceEventIds: sourceEventIds ?? [],
        },
      },
    });
  } catch (err) {
    console.warn(`[xingye-secret-space-drafts] event log append failed: ${err?.message || err}`);
  }

  return {
    id,
    category,
    title,
    body,
    tags,
    createdAt,
    reason,
    source,
    sourceEventIds,
    ...(revisions ? { revisions } : {}),
  };
}
