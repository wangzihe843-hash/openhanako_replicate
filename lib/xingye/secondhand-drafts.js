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
 *
 * **action='update' 形态（与 files / phone_contact 范式对齐）**：
 *  - 让 agent 把「已有挂牌」的状态迁移（在谈→已售 等）落成「更新补丁」草稿，
 *    而不是再 add 一条几乎同名的新 entry（否则旧挂牌的买家聊天按 entryId 存会成孤儿）；
 *  - update 必须有非空 patch；目标定位 targetEntryId 优先，matchName 兜底
 *    （matchName 缺省回退到 itemName——update 草稿的 itemName 必填，天然可当匹配名）；
 *  - patch 支持 status / askingPrice / delta / buyer / category / tags +
 *    contentAppend（追加一句备注，不整体覆盖正文）；
 *  - confirm 阶段在渲染端 confirmSecondhandDraft 按 action 分发：
 *    add 走 appendAppEntry 新建，update 走 updateAppEntry 把 patch merge 到目标 entry
 *    （**保持 entryId 不变**，买家聊天因此得以延续）。
 */

import fs from "node:fs";
import path from "node:path";

import { appendXingyeEvent, withXingyeAgentEventLock } from "./events.js";

export const XINGYE_SECONDHAND_DRAFTS_RELATIVE_PATH = path.join("apps", "secondhand", "drafts.jsonl");

const SAFE_AGENT_ID_RE = /^[A-Za-z0-9_-]{1,120}$/;
/**
 * status 在 dispatch 边界做主校验（与 shopping.status / accounting.direction 同处理）：
 * status 是可选项（缺省合法地落到 'to_sell'），但只要 agent **给了**一个非法值，
 * 就直接 ok:false 退回让它重发——避免被下面的 normalizeStatus 静默兜成 'to_sell'，
 * 把一笔「已售出 / 在谈 / 撤下」误记成「想出掉」。这里仍保留 normalizeStatus 作为
 * 防御性后备（也覆盖「缺省 → to_sell」这一合法默认）。
 */
export const SECONDHAND_DRAFT_ALLOWED_STATUSES = Object.freeze(["to_sell", "listed", "sold", "negotiating", "kept", "delisted"]);
const SECONDHAND_STATUSES = new Set(SECONDHAND_DRAFT_ALLOWED_STATUSES);
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
const TARGET_ID_MAX = 120;
const MATCH_NAME_MAX = 80;

export const SECONDHAND_DRAFT_ALLOWED_ACTIONS = Object.freeze(["add", "update"]);

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

/**
 * 归一 update 用的 patch：
 *  - 允许字段：status / askingPrice / delta / buyer / category / tags / contentAppend
 *  - status 必须是合法枚举值，否则丢弃该字段（不回退 to_sell——update 不该悄悄改错状态）
 *  - contentAppend 是「追加一句备注到正文末尾」，不整体覆盖（镜像 files 的 bodyAppend）
 *  - tags 空数组丢弃（与 files / phone_contact 一致：空数组＝噪声，清空请用户手动做）
 *  - 全部字段都缺 → null（调用方据此拒绝空 update）
 */
export function normalizeSecondhandDraftPatch(rawPatch) {
  if (!rawPatch || typeof rawPatch !== "object" || Array.isArray(rawPatch)) return null;
  const patch = {};
  if (typeof rawPatch.status === "string" && SECONDHAND_STATUSES.has(rawPatch.status.trim())) {
    patch.status = rawPatch.status.trim();
  }
  const askingPrice = normalizeOptionalString(rawPatch.askingPrice, PRICE_MAX);
  if (askingPrice !== undefined) patch.askingPrice = askingPrice;
  const delta = normalizeOptionalString(rawPatch.delta, DELTA_MAX);
  if (delta !== undefined) patch.delta = delta;
  const buyer = normalizeOptionalString(rawPatch.buyer, BUYER_MAX);
  if (buyer !== undefined) patch.buyer = buyer;
  const category = normalizeOptionalString(rawPatch.category, CATEGORY_MAX);
  if (category !== undefined) patch.category = category;
  const tags = normalizeTags(rawPatch.tags);
  if (tags && tags.length > 0) patch.tags = tags;
  if (typeof rawPatch.contentAppend === "string") {
    const trimmed = rawPatch.contentAppend.trim();
    if (trimmed) patch.contentAppend = trimmed.slice(0, CONTENT_MAX);
  }
  return Object.keys(patch).length > 0 ? patch : null;
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
 *   action?: 'add'|'update',
 *   targetEntryId?: string,
 *   matchName?: string,
 *   patch?: { status?: string, askingPrice?: string, delta?: string, buyer?: string, category?: string, tags?: string[], contentAppend?: string },
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

  const rawAction = typeof input.action === "string" ? input.action.trim() : "add";
  const action = SECONDHAND_DRAFT_ALLOWED_ACTIONS.includes(rawAction) ? rawAction : "add";

  /**
   * update 形态的目标定位与补丁：
   *  - matchName 缺省回退到 itemName（update 草稿 itemName 必填，天然可当匹配名）；
   *  - patch 必须非空，否则视为无效 update → null（不抛，与本函数其它校验一致）。
   * add 形态完全不碰这三个字段，向后兼容。
   */
  let targetEntryId;
  let matchName;
  let patch;
  if (action === "update") {
    targetEntryId = normalizeOptionalString(input.targetEntryId, TARGET_ID_MAX);
    matchName = normalizeOptionalString(input.matchName, MATCH_NAME_MAX) || itemName;
    patch = normalizeSecondhandDraftPatch(input.patch);
    if (!patch) return null;
  }

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
    action,
    targetEntryId,
    matchName,
    patch,
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
          action,
          targetEntryId: targetEntryId ?? null,
          matchName: action === "update" ? (matchName ?? null) : null,
          patchFields: patch ? Object.keys(patch) : [],
          itemName,
          // update 草稿的语义状态在 patch.status 上；add 草稿在顶层 status 上。
          status: action === "update" ? (patch?.status ?? null) : status,
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
    action,
    targetEntryId,
    matchName,
    patch,
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
