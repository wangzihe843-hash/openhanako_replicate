/**
 * 服务端「待确认短信草稿」追加助手。
 *
 * 与渲染端 desktop/src/react/xingye/xingye-sms-drafts.ts 的 `apps/sms/drafts.jsonl`
 * 是同一物理文件：UI 通过 /api/xingye/storage listJsonl 读，server 端这里直接 fs 追加。
 *
 * 关键点：
 *  - 仅写 drafts.jsonl，不会动 localStorage 里的 SMS thread（SMS 主体存储模型与
 *    mail 不同：SMS 的 thread/message 走 client-side localStorage，server 端文件
 *    系统里没有 sms messages 主体）；需要等用户在 PhoneSmsApp「待确认草稿」区
 *    点确认，UI 才会调用 confirmSmsDraft → addSmsMessage 落到 localStorage
 *    （direction='outgoing'），并发 sms.draft_confirmed + phone.sms_appended。
 *  - 草稿语义：「TA 想给某 virtual_contact / 其他 agent 发条短信」——和 mail
 *    模块的角色平行；direction 固定 outgoing（不接 incoming——巡检里 agent 主动
 *    产出的不应该是「想象对方发给 TA 什么」，那一支由
 *    generateSmsUpdatesForChangedContactsWithAI 在通讯录变更时直接走，不经草稿）。
 *  - **不允许 targetType='user'**——agent 不该绕过 user，直接给 user 发短信；
 *    想跟 user 说话请走正常对话。与 PhoneSmsApp 的 contactsForSms filter 一致。
 *  - targetId 必填（agent 想发给谁要明确）；matchName 作为备用（当 agent 只知道
 *    联系人显示名时用），confirm 阶段 UI 会做名字匹配；两者至少其一。
 *  - 写完顺手 append 一条 sms.draft_proposed 事件，便于心跳消费者聚合。
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

import { appendXingyeEvent, withXingyeAgentEventLock } from "./events.js";
import { detectSmsDraftDuplicate } from "./sms-dedupe.js";

export const XINGYE_SMS_DRAFTS_RELATIVE_PATH = path.join("apps", "sms", "drafts.jsonl");

const SAFE_AGENT_ID_RE = /^[A-Za-z0-9_-]{1,120}$/;

/**
 * 允许的 targetType。**不含 user**——agent 不该用 propose-draft 给 user 发短信；
 * 与 PhoneSmsApp 的 contactsForSms 同步。
 */
export const SMS_DRAFT_ALLOWED_TARGET_TYPES = Object.freeze(["agent", "virtual_contact"]);

const CONTENT_MAX = 240;
const MATCH_NAME_MAX = 80;
const DISPLAY_NAME_MAX = 80;
const TARGET_ID_MAX = 160;

function normalizeOptionalString(value, maxLen) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return typeof maxLen === "number" ? trimmed.slice(0, maxLen) : trimmed;
}

function newDraftId() {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `sms-${globalThis.crypto.randomUUID()}`;
  }
  return `sms-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;
}

function draftsFilePath(agentDir) {
  return path.join(agentDir, "xingye", XINGYE_SMS_DRAFTS_RELATIVE_PATH);
}

/**
 * 流式读 drafts.jsonl 的最近 N 条记录。
 *
 * 入库前去重只需要"近 24h 同对方"的草稿对子，全文件读太浪费——
 * 取尾部 N 条已经覆盖任何合理心跳频率（一天就算每小时一次 propose，
 * 也不会超过 24 条）。N 取 64 留点余量。
 *
 * 文件不存在 / 读失败 → 返回空数组（不阻塞主路径，让 append 照常走）。
 */
async function readRecentDrafts(file, limit = 64) {
  try {
    await fs.promises.access(file, fs.constants.R_OK);
  } catch {
    return [];
  }
  const rows = [];
  try {
    const stream = fs.createReadStream(file, { encoding: "utf-8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === "object") rows.push(parsed);
      } catch {
        // 单行 JSON 解析失败不致命，跳过。
      }
    }
  } catch {
    return rows;
  }
  return rows.length > limit ? rows.slice(rows.length - limit) : rows;
}

/**
 * 服务端 append 一条短信草稿。
 *
 * @param {object} args
 * @param {string} args.agentDir HANA_HOME/agents/{agentId}
 * @param {string} args.agentId
 * @param {{
 *   targetType: 'agent' | 'virtual_contact',
 *   targetId?: string,
 *   matchName?: string,
 *   displayName?: string,
 *   content: string,
 *   reason?: string,
 *   source: string,
 *   sourceEventIds?: string[],
 * }} args.input
 * @returns {Promise<object|null>} 写入的草稿；非法输入 → null（不抛）。
 */
export async function appendSmsDraftServer({ agentDir, agentId, input }) {
  if (typeof agentId !== "string" || !SAFE_AGENT_ID_RE.test(agentId)) return null;
  if (typeof agentDir !== "string" || !agentDir.trim()) return null;
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;

  const targetType = typeof input.targetType === "string" ? input.targetType.trim() : "";
  if (!SMS_DRAFT_ALLOWED_TARGET_TYPES.includes(targetType)) return null;

  const targetId = normalizeOptionalString(input.targetId, TARGET_ID_MAX);
  const matchName = normalizeOptionalString(input.matchName, MATCH_NAME_MAX);
  /** targetId / matchName 至少一个——confirm 阶段需要某种方式定位联系人。 */
  if (!targetId && !matchName) return null;

  const content = typeof input.content === "string" ? input.content.trim().slice(0, CONTENT_MAX) : "";
  if (!content) return null;

  const source = normalizeOptionalString(input.source);
  if (!source) return null;

  const displayName = normalizeOptionalString(input.displayName, DISPLAY_NAME_MAX);
  const reason = normalizeOptionalString(input.reason);
  const sourceEventIds = Array.isArray(input.sourceEventIds)
    ? input.sourceEventIds.filter((entry) => typeof entry === "string" && entry.trim()).map((entry) => entry.trim())
    : undefined;

  const id = newDraftId();
  const createdAt = new Date().toISOString();
  const row = {
    id,
    key: id,
    targetType,
    targetId,
    matchName,
    displayName,
    content,
    createdAt,
    reason,
    source,
    sourceEventIds,
  };

  /**
   * 入库前硬去重——心跳路径上 LLM 反复给同一对方提同样内容时拦掉，避免
   * drafts.jsonl 在一次 propose 里被 LLM 灌满几乎相同的草稿。详见 sms-dedupe.js。
   *
   * 命中 exact_dup → 不写文件、不发 sms.draft_proposed 事件，返回**已存在的草稿**
   *   并附 duplicateOf 字段，让调用方（propose-draft-tool）区分「新写入」vs「已存在」。
   * 命中 similar（bigram ≥ 0.7）→ 当前放行，由 UI 在确认阶段提示「你之前已经写过相似的」；
   *   server 端做硬过滤太激进，会丢掉合理的"换个说法再发一次"。
   *
   * **check-and-append 必须在同一把锁内原子完成**（TOCTOU 修复）：心跳驱动与对话
   * 驱动两条路径可能近乎同时 propose 同一句话——若 readRecentDrafts +
   * detectSmsDraftDuplicate 在锁外做，两者都会读到「还没有这一行」的状态、都判 unique、
   * 都把重复行追加进去，硬去重就失效了。把读 + 判重 + 追加都放进 withXingyeAgentEventLock
   * 回调里，让后到的那一次在前一次已写盘后再读，从而稳定命中 exact_dup。
   *
   * appendXingyeEvent 必须**留在锁外**——它内部用的是同一把 per-agent 锁
   * （events.js 的 withAgentLock，与 withXingyeAgentEventLock 同源），而该锁靠
   * per-agent Promise 链串行、**不可重入**；若在持锁回调里再调 appendXingyeEvent，
   * 内层会排到当前这把还没释放的锁后面，永远拿不到 → 死锁。所以事件日志在锁外补写。
   */
  const file = draftsFilePath(agentDir);
  const duplicate = await withXingyeAgentEventLock(agentId, async () => {
    const recentDrafts = await readRecentDrafts(file);
    const dup = detectSmsDraftDuplicate(
      { targetType, targetId, matchName, content },
      recentDrafts,
    );
    if (dup.kind === "exact_dup") {
      const existing = dup.draft;
      return {
        id: existing.id,
        targetType: existing.targetType,
        targetId: existing.targetId ?? undefined,
        matchName: existing.matchName ?? undefined,
        displayName: existing.displayName ?? undefined,
        content: existing.content,
        createdAt: existing.createdAt,
        reason: existing.reason ?? undefined,
        source: existing.source ?? undefined,
        sourceEventIds: existing.sourceEventIds ?? undefined,
        duplicateOf: existing.id,
      };
    }
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.appendFile(file, `${JSON.stringify(row)}\n`, "utf-8");
    return null;
  });
  if (duplicate) return duplicate;

  try {
    await appendXingyeEvent({
      agentDir,
      agentId,
      input: {
        type: "sms.draft_proposed",
        source,
        subjectId: id,
        payload: {
          draftId: id,
          targetType,
          targetId: targetId ?? null,
          matchName: matchName ?? null,
          displayName: displayName ?? null,
          contentExcerpt: content.slice(0, 60),
          reason: reason ?? null,
          sourceEventIds: sourceEventIds ?? [],
        },
      },
    });
  } catch (err) {
    console.warn(`[xingye-sms-drafts] event log append failed: ${err?.message || err}`);
  }

  return { id, targetType, targetId, matchName, displayName, content, createdAt, reason, source, sourceEventIds };
}
