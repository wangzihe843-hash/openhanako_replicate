/**
 * 服务端「待确认朋友圈草稿」追加助手。
 *
 * 与渲染端 desktop/src/react/xingye/xingye-moments-store.ts 的 `apps/moments/drafts.jsonl`
 * 是同一物理文件（注意路径前缀 `apps/`，和 schedule/journal 的 `<module>/` 形式不同——
 * 与现有 posts.jsonl 保持同一目录）。
 *
 * 关键点：
 *  - 仅写 drafts.jsonl，不写 posts.jsonl，不发 moment.created；
 *    需要等用户在朋友圈面板「待确认草稿」区点确认，UI 才会调用
 *    confirmMomentDraft 把它搬到 posts.jsonl 并发 moment.created。
 *  - 草稿只承诺 `content` 字段；不接 seedLikes / seedComments（互动者数据
 *    依赖通讯录与 peer roster，agent 在巡检上下文里很难稳定填对，让用户
 *    在 MomentComposer 那条「AI 生成」路径里现拉）。
 *  - 写完顺手 append 一条 moment.draft_proposed 事件，便于心跳消费者聚合。
 */

import fs from "node:fs";
import path from "node:path";

import { appendXingyeEvent, withXingyeAgentEventLock } from "./events.js";

export const XINGYE_MOMENTS_DRAFTS_RELATIVE_PATH = path.join("apps", "moments", "drafts.jsonl");

const SAFE_AGENT_ID_RE = /^[A-Za-z0-9_-]{1,120}$/;
const MOMENT_CONTENT_MAX = 280;

function normalizeOptionalString(value, maxLen) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return typeof maxLen === "number" ? trimmed.slice(0, maxLen) : trimmed;
}

function clampContent(value, maxCodePoints) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  const chars = [...trimmed];
  if (chars.length <= maxCodePoints) return trimmed;
  return `${chars.slice(0, maxCodePoints).join("")}…`;
}

function newDraftId() {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `mom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;
}

function draftsFilePath(agentDir) {
  return path.join(agentDir, "xingye", XINGYE_MOMENTS_DRAFTS_RELATIVE_PATH);
}

/**
 * 服务端 append 一条朋友圈草稿。
 *
 * @param {object} args
 * @param {string} args.agentDir HANA_HOME/agents/{agentId}
 * @param {string} args.agentId
 * @param {{
 *   content: string,
 *   reason?: string,
 *   source: string,
 *   sourceEventIds?: string[],
 * }} args.input
 * @returns {Promise<object|null>} 写入的草稿；非法输入 → null（不抛）。
 */
export async function appendMomentDraftServer({ agentDir, agentId, input }) {
  if (typeof agentId !== "string" || !SAFE_AGENT_ID_RE.test(agentId)) return null;
  if (typeof agentDir !== "string" || !agentDir.trim()) return null;
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;

  const content = clampContent(input.content, MOMENT_CONTENT_MAX);
  if (!content) return null;

  const source = normalizeOptionalString(input.source);
  if (!source) return null;

  const reason = normalizeOptionalString(input.reason);
  const sourceEventIds = Array.isArray(input.sourceEventIds)
    ? input.sourceEventIds.filter((entry) => typeof entry === "string" && entry.trim()).map((entry) => entry.trim())
    : undefined;

  const id = newDraftId();
  const createdAt = new Date().toISOString();
  const row = {
    id,
    key: id,
    content,
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
        type: "moment.draft_proposed",
        source,
        subjectId: id,
        payload: {
          draftId: id,
          contentExcerpt: content.slice(0, 60),
          reason: reason ?? null,
          sourceEventIds: sourceEventIds ?? [],
        },
      },
    });
  } catch (err) {
    console.warn(`[xingye-moments-drafts] event log append failed: ${err?.message || err}`);
  }

  return { id, content, createdAt, reason, source, sourceEventIds };
}
