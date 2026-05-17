/**
 * 服务端「待确认邮件草稿」追加助手。
 *
 * 与渲染端 desktop/src/react/xingye/xingye-mail-store.ts 的 `apps/mail/drafts.jsonl`
 * 是同一物理文件：UI 通过 /api/xingye/storage listJsonl 读，server 端这里直接 fs 追加。
 *
 * 关键点：
 *  - 仅写 drafts.jsonl，不写 messages.jsonl，不发 mail.messages_appended；
 *    需要等用户在 PhoneMailApp「待确认草稿」区点确认，UI 才会调用
 *    confirmMailDraft 把它搬到 messages.jsonl（落到 `drafts` 邮箱）并发
 *    mail.messages_appended + mail.draft_confirmed。
 *  - 草稿层只承诺 subject / body（其一可空，但 trim 后两个都空则拒绝）；
 *    toName / toAddress 可选，因为巡检上下文里 agent 不一定能稳定填出
 *    用户邮箱地址——留给用户在确认时补。
 *  - fromKind 默认 'agent'（角色自己想写的信）；不接其它 kind——巡检产出
 *    的草稿语义就是「TA 想给 X 写一封信」。
 *  - 写完顺手 append 一条 mail.draft_proposed 事件，便于心跳消费者聚合。
 */

import fs from "node:fs";
import path from "node:path";

import { appendXingyeEvent, withXingyeAgentEventLock } from "./events.js";

export const XINGYE_MAIL_DRAFTS_RELATIVE_PATH = path.join("apps", "mail", "drafts.jsonl");

const SAFE_AGENT_ID_RE = /^[A-Za-z0-9_-]{1,120}$/;
const MAIL_SUBJECT_MAX = 200;
const MAIL_BODY_MAX = 8000;
const MAIL_ADDRESS_MAX = 160;
const MAIL_ADDRESS_NAME_MAX = 80;

function normalizeOptionalString(value, maxLen) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return typeof maxLen === "number" ? trimmed.slice(0, maxLen) : trimmed;
}

function clampText(value, maxLen) {
  if (typeof value !== "string") return "";
  return value.slice(0, maxLen);
}

function newDraftId() {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `mail-${globalThis.crypto.randomUUID()}`;
  }
  return `mail-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;
}

function draftsFilePath(agentDir) {
  return path.join(agentDir, "xingye", XINGYE_MAIL_DRAFTS_RELATIVE_PATH);
}

/**
 * 服务端 append 一条邮件草稿。
 *
 * @param {object} args
 * @param {string} args.agentDir HANA_HOME/agents/{agentId}
 * @param {string} args.agentId
 * @param {{
 *   subject?: string,
 *   body?: string,
 *   toName?: string,
 *   toAddress?: string,
 *   reason?: string,
 *   source: string,
 *   sourceEventIds?: string[],
 * }} args.input
 * @returns {Promise<object|null>} 写入的草稿；非法输入 → null（不抛）。
 */
export async function appendMailDraftServer({ agentDir, agentId, input }) {
  if (typeof agentId !== "string" || !SAFE_AGENT_ID_RE.test(agentId)) return null;
  if (typeof agentDir !== "string" || !agentDir.trim()) return null;
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;

  const subject = clampText(typeof input.subject === "string" ? input.subject.trim() : "", MAIL_SUBJECT_MAX);
  const body = clampText(typeof input.body === "string" ? input.body : "", MAIL_BODY_MAX);
  /**
   * 与 xingye-mail-store buildMessage 同步：subject 与 body **同时** 空则拒绝。
   * 单独主题或单独正文都允许（仿真信件场景里，TA 可能只想写一行问候没主题）。
   */
  if (!subject && !body.trim()) return null;

  const source = normalizeOptionalString(input.source);
  if (!source) return null;

  const toAddress = normalizeOptionalString(input.toAddress, MAIL_ADDRESS_MAX);
  const toName = normalizeOptionalString(input.toName, MAIL_ADDRESS_NAME_MAX);
  const reason = normalizeOptionalString(input.reason);
  const sourceEventIds = Array.isArray(input.sourceEventIds)
    ? input.sourceEventIds.filter((entry) => typeof entry === "string" && entry.trim()).map((entry) => entry.trim())
    : undefined;

  const id = newDraftId();
  const createdAt = new Date().toISOString();
  const row = {
    id,
    key: id,
    subject,
    body,
    toAddress,
    toName,
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
        type: "mail.draft_proposed",
        source,
        subjectId: id,
        payload: {
          draftId: id,
          subject: subject || null,
          hasBody: Boolean(body.trim()),
          toAddress: toAddress ?? null,
          reason: reason ?? null,
          sourceEventIds: sourceEventIds ?? [],
        },
      },
    });
  } catch (err) {
    console.warn(`[xingye-mail-drafts] event log append failed: ${err?.message || err}`);
  }

  return { id, subject, body, toAddress, toName, createdAt, reason, source, sourceEventIds };
}
