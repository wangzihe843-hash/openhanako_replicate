/**
 * 服务端「待确认占卜草稿」追加助手。
 *
 * 与渲染端 desktop/src/react/xingye/xingye-app-entry-store.ts 的
 * `apps/divination/drafts.jsonl` 是同一物理文件：UI 通过 /api/xingye/storage
 * listJsonl 读，server 端这里直接 fs 追加。
 *
 * 语义偏移（重要——和 PhoneDivinationApp 主流程不同）：
 *
 * 正式占卜（PhoneDivinationApp 创建路径）走 generateDivinationReadingWithAI →
 * appendDivinationEntry，会算法/AI 跑出 symbols + 结构化 reading。但巡检场景里
 * agent 无法触发 AI 流程产生 reading；要让 draft 适配「confirm = 原子 append entry」
 * 这条不变量，必须放弃结构化 reading，把草稿建模成「心象提示」：
 *
 *   - method 固定 'oracle_generic'，methodLabel 固定 '心象提示'
 *   - symbols 强制 []（标记为「不抽符」）
 *   - autoSelected=false（是 agent 主动判断要做这次心象，不是用户触发的自动选法）
 *   - resolverReason 来自巡检的 reason
 *   - content = agent 自己写的直觉读出（短，不强求结构）
 *   - agentQuestion / question 都来自 input.agentQuestion
 *   - userProvidedTheme / themeHint 可选
 *
 * 这条「心象提示」entry 落到 apps/divination/entries.jsonl，与正式占卜并列，
 * UI 现有渲染逻辑能处理（method='oracle_generic' 已被支持，只是 symbols 为空）。
 *
 * 用户视角：「TA 刚刚捕捉到一个心象，写下来给你看一眼」。不是一卦正经占卜。
 */

import fs from "node:fs";
import path from "node:path";

import { appendXingyeEvent, withXingyeAgentEventLock } from "./events.js";

export const XINGYE_DIVINATION_DRAFTS_RELATIVE_PATH = path.join("apps", "divination", "drafts.jsonl");

const SAFE_AGENT_ID_RE = /^[A-Za-z0-9_-]{1,120}$/;
const AGENT_QUESTION_MAX = 200;
const CONTENT_MAX = 2000;
const THEME_HINT_MAX = 80;
const REASON_MAX = 1000;

function normalizeOptionalString(value, maxLen) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return typeof maxLen === "number" ? trimmed.slice(0, maxLen) : trimmed;
}

function newDraftId() {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `div-${globalThis.crypto.randomUUID()}`;
  }
  return `div-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;
}

function draftsFilePath(agentDir) {
  return path.join(agentDir, "xingye", XINGYE_DIVINATION_DRAFTS_RELATIVE_PATH);
}

/**
 * 服务端 append 一条占卜草稿（心象提示形态）。
 *
 * @param {object} args
 * @param {string} args.agentDir HANA_HOME/agents/{agentId}
 * @param {string} args.agentId
 * @param {{
 *   agentQuestion: string,
 *   content: string,
 *   themeHint?: string,
 *   reason?: string,
 *   source: string,
 *   sourceEventIds?: string[],
 * }} args.input
 * @returns {Promise<object|null>} 写入的草稿；非法输入 → null（不抛）。
 */
export async function appendDivinationDraftServer({ agentDir, agentId, input }) {
  if (typeof agentId !== "string" || !SAFE_AGENT_ID_RE.test(agentId)) return null;
  if (typeof agentDir !== "string" || !agentDir.trim()) return null;
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;

  const agentQuestion = normalizeOptionalString(input.agentQuestion, AGENT_QUESTION_MAX);
  if (!agentQuestion) return null;
  const content = normalizeOptionalString(input.content, CONTENT_MAX);
  if (!content) return null;
  const source = normalizeOptionalString(input.source);
  if (!source) return null;

  const themeHint = normalizeOptionalString(input.themeHint, THEME_HINT_MAX);
  const reason = normalizeOptionalString(input.reason, REASON_MAX);
  const sourceEventIds = Array.isArray(input.sourceEventIds)
    ? input.sourceEventIds.filter((entry) => typeof entry === "string" && entry.trim()).map((entry) => entry.trim())
    : undefined;

  const id = newDraftId();
  const createdAt = new Date().toISOString();
  const row = {
    id,
    key: id,
    agentQuestion,
    content,
    themeHint,
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
        type: "divination.draft_proposed",
        source,
        subjectId: id,
        payload: {
          draftId: id,
          agentQuestion,
          themeHint: themeHint ?? null,
          reason: reason ?? null,
          sourceEventIds: sourceEventIds ?? [],
        },
      },
    });
  } catch (err) {
    console.warn(`[xingye-divination-drafts] event log append failed: ${err?.message || err}`);
  }

  return { id, agentQuestion, content, themeHint, reason, source, sourceEventIds, createdAt };
}
