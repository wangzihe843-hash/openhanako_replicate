/**
 * 服务端「待确认报纸草稿（意图）」追加助手。
 *
 * 与渲染端 desktop/src/react/xingye/xingye-news-drafts.ts 的
 * `apps/news/drafts.jsonl` 是同一物理文件：UI 通过 /api/xingye/storage listJsonl
 * 读，server 端这里直接 fs 追加。
 *
 * 关键点：
 *  - 报纸是多板块的重型结构化生成，心跳 agent 不在工具里写整份报纸，只提一个
 *    **意图**——TA 想出一期报纸、想从什么角度（angle）切入。
 *  - 仅写 drafts.jsonl，不写 entries.jsonl、不发 news.entry_appended；用户在
 *    PhoneNewsApp「待确认草稿」区点「确认出版」，UI 才用 angle 跑
 *    generateNewsDraftWithAI 生成整期报纸并落地。
 *  - angle / reason 均可选（意图本身允许「没有特定角度，就是想出一期」）。
 *  - 写完 append 一条 news.draft_proposed 事件供心跳消费者聚合。
 */

import fs from "node:fs";
import path from "node:path";

import { appendXingyeEvent, withXingyeAgentEventLock } from "./events.js";

export const XINGYE_NEWS_DRAFTS_RELATIVE_PATH = path.join("apps", "news", "drafts.jsonl");

const SAFE_AGENT_ID_RE = /^[A-Za-z0-9_-]{1,120}$/;
const ANGLE_MAX = 400;
const REASON_MAX = 1000;

function normalizeOptionalString(value, maxLen) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return typeof maxLen === "number" ? trimmed.slice(0, maxLen) : trimmed;
}

function newDraftId() {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `news-${globalThis.crypto.randomUUID()}`;
  }
  return `news-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;
}

function draftsFilePath(agentDir) {
  return path.join(agentDir, "xingye", XINGYE_NEWS_DRAFTS_RELATIVE_PATH);
}

/**
 * 服务端 append 一条报纸意图草稿。
 *
 * @param {object} args
 * @param {string} args.agentDir HANA_HOME/agents/{agentId}
 * @param {string} args.agentId
 * @param {{ angle?: string, reason?: string, source: string, sourceEventIds?: string[] }} args.input
 * @returns {Promise<object|null>} 写入的草稿；非法输入 → null（不抛）。
 */
export async function appendNewsDraftServer({ agentDir, agentId, input }) {
  if (typeof agentId !== "string" || !SAFE_AGENT_ID_RE.test(agentId)) return null;
  if (typeof agentDir !== "string" || !agentDir.trim()) return null;
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;

  const source = normalizeOptionalString(input.source);
  if (!source) return null;

  const angle = normalizeOptionalString(input.angle, ANGLE_MAX);
  const reason = normalizeOptionalString(input.reason, REASON_MAX);
  const sourceEventIds = Array.isArray(input.sourceEventIds)
    ? input.sourceEventIds.filter((entry) => typeof entry === "string" && entry.trim()).map((entry) => entry.trim())
    : undefined;

  const id = newDraftId();
  const createdAt = new Date().toISOString();
  const row = { id, key: id, angle, reason, source, sourceEventIds, createdAt };

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
        type: "news.draft_proposed",
        source,
        subjectId: id,
        payload: {
          draftId: id,
          angle: angle ?? null,
          reason: reason ?? null,
          sourceEventIds: sourceEventIds ?? [],
        },
      },
    });
  } catch (err) {
    console.warn(`[xingye-news-drafts] event log append failed: ${err?.message || err}`);
  }

  return { id, angle, reason, source, sourceEventIds, createdAt };
}
