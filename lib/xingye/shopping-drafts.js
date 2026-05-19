/**
 * 服务端「待确认购物草稿」追加助手。
 *
 * 与渲染端 desktop/src/react/xingye/xingye-app-entry-store.ts 的
 * `apps/shopping/drafts.jsonl` 是同一物理文件：UI 通过 /api/xingye/storage listJsonl
 * 读，server 端这里直接 fs 追加。
 *
 * 关键点：
 *  - 仅写 drafts.jsonl，不写 entries.jsonl，不发 shopping.entry_appended；
 *    需要等用户在 PhoneShoppingApp「待确认草稿」区点确认，UI 才会调用
 *    confirmShoppingDraft 把它搬到 entries.jsonl 并发
 *    shopping.entry_appended + shopping.draft_confirmed。
 *  - 草稿层只承诺 itemName + 可选的 status / category / imaginedPrice / reason /
 *    tags / content；status 默认 'wanted'（巡检产出最常见的语义就是「TA 想买」）。
 *  - 写完顺手 append 一条 shopping.draft_proposed 事件，便于心跳消费者聚合。
 */

import fs from "node:fs";
import path from "node:path";

import { appendXingyeEvent, withXingyeAgentEventLock } from "./events.js";

export const XINGYE_SHOPPING_DRAFTS_RELATIVE_PATH = path.join("apps", "shopping", "drafts.jsonl");

const SAFE_AGENT_ID_RE = /^[A-Za-z0-9_-]{1,120}$/;
const SHOPPING_STATUSES = new Set(["wanted", "ordered", "received", "hesitating", "returned", "favorite"]);
const SHOPPING_PLATFORM_STYLES = new Set(["amazon", "taobao", "xianyu", "generic"]);
const ITEM_NAME_MAX = 80;
const CATEGORY_MAX = 24;
const PRICE_MAX = 40;
const DELTA_MAX = 32;
const SELLER_MAX = 24;
const REASON_MAX = 500;
const CONTENT_MAX = 2000;
const TAG_MAX = 24;
const TAG_LIST_MAX = 8;

function normalizeOptionalString(value, maxLen) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return typeof maxLen === "number" ? trimmed.slice(0, maxLen) : trimmed;
}

function normalizeStatus(value) {
  return typeof value === "string" && SHOPPING_STATUSES.has(value) ? value : "wanted";
}

function normalizePlatformStyle(value) {
  return typeof value === "string" && SHOPPING_PLATFORM_STYLES.has(value) ? value : "generic";
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
    return `shop-${globalThis.crypto.randomUUID()}`;
  }
  return `shop-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;
}

function draftsFilePath(agentDir) {
  return path.join(agentDir, "xingye", XINGYE_SHOPPING_DRAFTS_RELATIVE_PATH);
}

/**
 * 服务端 append 一条购物草稿。
 *
 * @param {object} args
 * @param {string} args.agentDir HANA_HOME/agents/{agentId}
 * @param {string} args.agentId
 * @param {{
 *   itemName: string,
 *   status?: string,
 *   platformStyle?: string,
 *   category?: string,
 *   imaginedPrice?: string,
 *   delta?: string,
 *   seller?: string,
 *   reason?: string,
 *   content?: string,
 *   tags?: string[],
 *   source: string,
 *   sourceEventIds?: string[],
 * }} args.input
 * @returns {Promise<object|null>} 写入的草稿；非法输入 → null（不抛）。
 */
export async function appendShoppingDraftServer({ agentDir, agentId, input }) {
  if (typeof agentId !== "string" || !SAFE_AGENT_ID_RE.test(agentId)) return null;
  if (typeof agentDir !== "string" || !agentDir.trim()) return null;
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;

  const itemName = normalizeOptionalString(input.itemName, ITEM_NAME_MAX);
  if (!itemName) return null;

  const source = normalizeOptionalString(input.source);
  if (!source) return null;

  const status = normalizeStatus(input.status);
  const platformStyle = normalizePlatformStyle(input.platformStyle);
  const category = normalizeOptionalString(input.category, CATEGORY_MAX);
  const imaginedPrice = normalizeOptionalString(input.imaginedPrice, PRICE_MAX);
  /**
   * delta / seller：随小手机购物 UI 改版加入。
   * - delta：「比想象便宜 220」「凑得起」等价格短语，不带货币符号。
   * - seller：「光阴二手店」「街口那家成衣」这种 TA 想象里的卖家口吻，
   *   非真实电商平台。
   * 两者都是可选，落盘和 confirm 路径都按字面写到 metadata 上。
   */
  const delta = normalizeOptionalString(input.delta, DELTA_MAX);
  const seller = normalizeOptionalString(input.seller, SELLER_MAX);
  /**
   * `reason` 这里有两种语义：
   *  - 用户视角：为什么把这个加进购物清单（写进 metadata.reason，显示在卡片上）
   *  - 巡检视角：为什么提议这条草稿（写进顶层 reason，显示在「待确认草稿」气泡上）
   * 工具只接一个 reason 字段，落盘时同时填两处——确认时 confirm 路径把它带进 metadata。
   * 这与 schedule-drafts.js 把 reason 仅留在顶层不同；shopping 的 entry 表自带 reason 列。
   */
  const reason = normalizeOptionalString(input.reason, REASON_MAX);
  const content = normalizeOptionalString(input.content, CONTENT_MAX);
  const tags = normalizeTags(input.tags);
  const sourceEventIds = Array.isArray(input.sourceEventIds)
    ? input.sourceEventIds.filter((entry) => typeof entry === "string" && entry.trim()).map((entry) => entry.trim())
    : undefined;

  const id = newDraftId();
  const createdAt = new Date().toISOString();
  const row = {
    id,
    key: id,
    itemName,
    status,
    platformStyle,
    category,
    imaginedPrice,
    delta,
    seller,
    reason,
    content,
    tags,
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
        type: "shopping.draft_proposed",
        source,
        subjectId: id,
        payload: {
          draftId: id,
          itemName,
          status,
          reason: reason ?? null,
          sourceEventIds: sourceEventIds ?? [],
        },
      },
    });
  } catch (err) {
    console.warn(`[xingye-shopping-drafts] event log append failed: ${err?.message || err}`);
  }

  return {
    id,
    itemName,
    status,
    platformStyle,
    category,
    imaginedPrice,
    delta,
    seller,
    reason,
    content,
    tags,
    createdAt,
    source,
    sourceEventIds,
  };
}
