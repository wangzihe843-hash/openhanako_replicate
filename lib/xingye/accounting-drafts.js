/**
 * 服务端「待确认记账草稿」追加助手。
 *
 * 与渲染端 desktop/src/react/xingye/xingye-app-entry-store.ts 的
 * `apps/accounting/drafts.jsonl` 是同一物理文件：UI 通过 /api/xingye/storage
 * listJsonl 读，server 端这里直接 fs 追加。
 *
 * 与购物 / 二手草稿的区别：记账记的是 TA 在购物 / 二手之外的「原生收支」——
 * 工资、房租、餐饮、水电、人情、利息……所以没有 status / platformStyle
 * 这套生命周期，改用 direction (income / expense) + amount + currency
 * 这套交易语义。
 *
 * 关键点：
 *  - 仅写 drafts.jsonl，不写 entries.jsonl，不发 accounting.entry_appended；
 *    需要等用户在 PhoneAccountingApp「待确认草稿」区点确认，UI 才会调用
 *    confirmAccountingDraft 把它搬到 entries.jsonl 并发
 *    accounting.entry_appended + accounting.draft_confirmed。
 *  - LLM 通过 propose-draft 提议时同时给：imaginedAmount（氛围文本，给人看）
 *    + amount + currency（机器可读，给账本求和）。amount 必填非负数；账本必须有
 *    数值才能投影，留给前端再做模糊解析会让确认流程拐弯。
 *  - 写完顺手 append 一条 accounting.draft_proposed 事件，便于心跳消费者聚合。
 */

import fs from "node:fs";
import path from "node:path";

import { appendXingyeEvent, withXingyeAgentEventLock } from "./events.js";

export const XINGYE_ACCOUNTING_DRAFTS_RELATIVE_PATH = path.join("apps", "accounting", "drafts.jsonl");

const SAFE_AGENT_ID_RE = /^[A-Za-z0-9_-]{1,120}$/;
const ACCOUNTING_DIRECTIONS = new Set(["income", "expense"]);
const TITLE_MAX = 80;
const CATEGORY_MAX = 24;
const COUNTERPARTY_MAX = 40;
const CURRENCY_MAX = 16;
const IMAGINED_AMOUNT_MAX = 80;
const REASON_MAX = 500;
const CONTENT_MAX = 2000;

function normalizeOptionalString(value, maxLen) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return typeof maxLen === "number" ? trimmed.slice(0, maxLen) : trimmed;
}

function normalizeDirection(value) {
  return typeof value === "string" && ACCOUNTING_DIRECTIONS.has(value) ? value : "expense";
}

/** 非负有限金额，保留两位小数；非数 / NaN / Infinity / 负数 → undefined。 */
function normalizeAmount(value) {
  const n = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim() ? Number(value.trim()) : NaN;
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.round(n * 100) / 100;
}

/** 交易发生日：可解析的日期 → 归一为 ISO 字符串；否则 undefined。 */
function normalizeOccurredAt(value) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Date.parse(value.trim());
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function newDraftId() {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `ledger-${globalThis.crypto.randomUUID()}`;
  }
  return `ledger-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;
}

function draftsFilePath(agentDir) {
  return path.join(agentDir, "xingye", XINGYE_ACCOUNTING_DRAFTS_RELATIVE_PATH);
}

/**
 * 服务端 append 一条记账草稿。
 *
 * @param {object} args
 * @param {string} args.agentDir HANA_HOME/agents/{agentId}
 * @param {string} args.agentId
 * @param {{
 *   title: string,
 *   direction?: string,
 *   amount: number,
 *   currency?: string,
 *   imaginedAmount?: string,
 *   category?: string,
 *   counterparty?: string,
 *   occurredAt?: string,
 *   reason?: string,
 *   content?: string,
 *   source: string,
 *   sourceEventIds?: string[],
 * }} args.input
 * @returns {Promise<object|null>} 写入的草稿；非法输入 → null（不抛）。
 */
export async function appendAccountingDraftServer({ agentDir, agentId, input }) {
  if (typeof agentId !== "string" || !SAFE_AGENT_ID_RE.test(agentId)) return null;
  if (typeof agentDir !== "string" || !agentDir.trim()) return null;
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;

  const title = normalizeOptionalString(input.title, TITLE_MAX);
  if (!title) return null;

  const source = normalizeOptionalString(input.source);
  if (!source) return null;

  const amount = normalizeAmount(input.amount);
  if (amount === undefined) return null;

  const direction = normalizeDirection(input.direction);
  const currency = normalizeOptionalString(input.currency, CURRENCY_MAX);
  /**
   * imaginedAmount：TA 用所在世界观货币写法表达的"氛围金额"文本（"约 ¥500"、
   * "三两银子"、"几枚金币"）。amount + currency 是给账本求和用的机器可读值；
   * imaginedAmount 是给小手机卡片上人看的。两者并存。
   */
  const imaginedAmount = normalizeOptionalString(input.imaginedAmount, IMAGINED_AMOUNT_MAX);
  const category = normalizeOptionalString(input.category, CATEGORY_MAX);
  const counterparty = normalizeOptionalString(input.counterparty, COUNTERPARTY_MAX);
  const occurredAt = normalizeOccurredAt(input.occurredAt);
  /**
   * `reason` 这里有两种语义：
   *  - 用户视角：为什么把这笔钱记下（写进 metadata.reason，显示在卡片上）
   *  - 巡检视角：为什么提议这条草稿（写进顶层 reason，显示在「待确认草稿」气泡上）
   * 工具只接一个 reason 字段，落盘时同时填两处——确认时 confirm 路径把它带进 metadata。
   */
  const reason = normalizeOptionalString(input.reason, REASON_MAX);
  const content = normalizeOptionalString(input.content, CONTENT_MAX);
  const sourceEventIds = Array.isArray(input.sourceEventIds)
    ? input.sourceEventIds.filter((entry) => typeof entry === "string" && entry.trim()).map((entry) => entry.trim())
    : undefined;

  const id = newDraftId();
  const createdAt = new Date().toISOString();
  const row = {
    id,
    key: id,
    title,
    direction,
    amount,
    currency,
    imaginedAmount,
    category,
    counterparty,
    occurredAt,
    reason,
    content,
    createdAt,
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
        type: "accounting.draft_proposed",
        source,
        subjectId: id,
        payload: {
          draftId: id,
          title,
          direction,
          amount,
          currency: currency ?? null,
          reason: reason ?? null,
          sourceEventIds: sourceEventIds ?? [],
        },
      },
    });
  } catch (err) {
    console.warn(`[xingye-accounting-drafts] event log append failed: ${err?.message || err}`);
  }

  return {
    id,
    title,
    direction,
    amount,
    currency,
    imaginedAmount,
    category,
    counterparty,
    occurredAt,
    reason,
    content,
    createdAt,
    source,
    sourceEventIds,
  };
}
