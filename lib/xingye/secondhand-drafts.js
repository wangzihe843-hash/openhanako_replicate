/**
 * 服务端「待确认二手草稿」追加助手。
 *
 * 二手模块是购物模块的镜像：购物 = TA 想买什么，二手 = TA 想把自己的东西
 * 出掉什么。两者结构对称、互不耦合。
 *
 * 与渲染端 desktop/src/react/xingye/xingye-app-entry-store.ts 的
 * `apps/secondhand/drafts.jsonl` 是同一物理文件：UI 通过 /api/xingye/storage
 * listJsonl 读，server 端这里直接 fs 追加。
 *
 * 关键点：
 *  - 仅写 drafts.jsonl，不写 entries.jsonl，不发 secondhand.entry_appended；
 *    需要等用户在 PhoneSecondhandApp「待确认草稿」区点确认，UI 才会调用
 *    confirmSecondhandDraft 把它搬到 entries.jsonl 并发
 *    secondhand.entry_appended + secondhand.draft_confirmed。
 *  - 草稿层只承诺 itemName + 可选的 status / category / askingPrice / reason /
 *    tags / content；status 默认 'to_sell'（巡检产出最常见的语义就是「TA 想出掉」）。
 *  - 写完顺手 append 一条 secondhand.draft_proposed 事件，便于心跳消费者聚合。
 */

import fs from "node:fs";
import path from "node:path";

import { appendXingyeEvent, withXingyeAgentEventLock } from "./events.js";

export const XINGYE_SECONDHAND_DRAFTS_RELATIVE_PATH = path.join("apps", "secondhand", "drafts.jsonl");

const SAFE_AGENT_ID_RE = /^[A-Za-z0-9_-]{1,120}$/;
const SECONDHAND_STATUSES = new Set(["to_sell", "listed", "sold", "negotiating", "kept", "delisted"]);
const SECONDHAND_PLATFORM_STYLES = new Set(["amazon", "taobao", "xianyu", "generic"]);
const ITEM_NAME_MAX = 80;
const CATEGORY_MAX = 24;
const PRICE_MAX = 40;
const DELTA_MAX = 32;
const BUYER_MAX = 24;
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
  return typeof value === "string" && SECONDHAND_STATUSES.has(value) ? value : "to_sell";
}

function normalizePlatformStyle(value) {
  return typeof value === "string" && SECONDHAND_PLATFORM_STYLES.has(value) ? value : "generic";
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
    return `resell-${globalThis.crypto.randomUUID()}`;
  }
  return `resell-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;
}

function draftsFilePath(agentDir) {
  return path.join(agentDir, "xingye", XINGYE_SECONDHAND_DRAFTS_RELATIVE_PATH);
}

/**
 * 服务端 append 一条二手草稿。
 *
 * @param {object} args
 * @param {string} args.agentDir HANA_HOME/agents/{agentId}
 * @param {string} args.agentId
 * @param {{
 *   itemName: string,
 *   status?: string,
 *   platformStyle?: string,
 *   category?: string,
 *   askingPrice?: string,
 *   delta?: string,
 *   buyer?: string,
 *   reason?: string,
 *   content?: string,
 *   tags?: string[],
 *   source: string,
 *   sourceEventIds?: string[],
 * }} args.input
 * @returns {Promise<object|null>} 写入的草稿；非法输入 → null（不抛）。
 */
export async function appendSecondhandDraftServer({ agentDir, agentId, input }) {
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
  /**
   * askingPrice：TA 想象里的卖价 / 期望成交价，不带「真实标价」语义。
   * 镜像购物的 imaginedPrice——同样必须用 TA 所在世界观对应的货币写法。
   */
  const askingPrice = normalizeOptionalString(input.askingPrice, PRICE_MAX);
  /**
   * delta / buyer：随小手机二手 UI 加入。
   * - delta：「比当初买价低一半」「居然有人加价收」等卖出落差短语，不带货币符号。
   * - buyer：「巷口的旧书客」「一个说很喜欢的姑娘」这种 TA 想象里的买家口吻，
   *   非真实电商平台。
   * 两者都是可选，落盘和 confirm 路径都按字面写到 metadata 上。
   */
  const delta = normalizeOptionalString(input.delta, DELTA_MAX);
  const buyer = normalizeOptionalString(input.buyer, BUYER_MAX);
  /**
   * `reason` 这里有两种语义：
   *  - 用户视角：为什么把这件东西挂出去卖（写进 metadata.reason，显示在卡片上）
   *  - 巡检视角：为什么提议这条草稿（写进顶层 reason，显示在「待确认草稿」气泡上）
   * 工具只接一个 reason 字段，落盘时同时填两处——确认时 confirm 路径把它带进 metadata。
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
    askingPrice,
    delta,
    buyer,
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
        type: "secondhand.draft_proposed",
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
    console.warn(`[xingye-secondhand-drafts] event log append failed: ${err?.message || err}`);
  }

  return {
    id,
    itemName,
    status,
    platformStyle,
    category,
    askingPrice,
    delta,
    buyer,
    reason,
    content,
    tags,
    createdAt,
    source,
    sourceEventIds,
  };
}
