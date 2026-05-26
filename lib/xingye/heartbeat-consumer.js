import fs from "fs";
import path from "path";
import { withXingyeAgentEventLock } from "./events.js";

export const XINGYE_HEARTBEAT_CONSUMER_ID = "xingye.heartbeat";
export const XINGYE_EVENT_LOG_RELATIVE_PATH = path.join("events", "log.json");
export const XINGYE_HEARTBEAT_RESULT_RELATIVE_PATH = path.join("heartbeat", "result.json");
export const XINGYE_HEARTBEAT_HISTORY_RELATIVE_PATH = path.join("heartbeat", "history.jsonl");

/**
 * Retention：consumer 把事件标记为 consumed 已超过 7 天的，从 log.json 中剔除。
 * 未被 consumer 消费的事件无论多旧都保留（让 consumer 自己负责消费）。
 *
 * 思路参考原生 cron-store 的「runs.jsonl 超过 500 行截到 300 行」模式：不让历史文件
 * 单调膨胀。区别是 events 是 JSON 结构 + dedupeKeys 引用，所以按"已 consumed 且过期"
 * 这个语义条件来剪，而不是按行数。
 *
 * 同时还有 history.jsonl 的硬截断（见下方）。
 */
export const XINGYE_EVENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const XINGYE_HEARTBEAT_HISTORY_MAX_LINES = 500;
export const XINGYE_HEARTBEAT_HISTORY_KEEP_LINES = 300;

/**
 * 距离上次 agent 主动产出草稿（任意模块的 *.draft_proposed）累计 ≥ 这个数的
 * 用户对话（recent_chat.observed），心跳就会在 prompt 里追加一条强约束：
 * 「本轮必须至少调用一次 xingye_propose_draft」。
 *
 * 防止 agent 长时间静默——巡检看到只读不写，用户也不知道 agent 还在背后默默观察。
 * 50 ≈ 平均一两天的对话量，对慢节奏的"伴侣型"角色合适；高频/SaaS-style 用户日后
 * 可以从 agent config 里覆盖（目前为常量）。
 */
export const XINGYE_AUTO_DRAFT_STALENESS_THRESHOLD = 50;

const SUGGESTION_BY_TYPE = {
  "secret_space.record_appended": "Review the new secret-space record and decide whether it should inform future chat, lore, or relationship-state suggestions.",
  "secret_space.record_deleted": "Review the removed secret-space record and avoid relying on stale private context.",
  "memory_candidate.written": "Review the written memory candidate and decide whether it needs promotion, correction, or follow-up.",
  "phone.contact_changed": "Review the contact change and decide whether future phone suggestions need updated context.",
  "phone.sms_appended": "Review the new SMS context and decide whether a reply, memory candidate, or relationship-state suggestion is appropriate.",
  "relationship_state.suggested": "Review the relationship-state suggestion before applying any state change.",
  "relationship_state.applied": "Review the applied relationship-state change and watch for follow-up context.",
  "news.entry_appended": "Review the new in-character newspaper issue and decide whether its world events or relationship column should inform future chat.",
  "interview.entry_appended": "Review the new exclusive interview and decide whether anything it reveals is worth following up on.",
};

// ──────────── 中文摘要（渲染端 PhoneHome 直接显示 / 写入 desk-heartbeat-memory，
//   原渲染端独立 consumer 已合并至此，事件类型 ↔ 中文标签的唯一真源）────────────

const TYPE_LABEL_ZH = {
  "recent_chat.observed": "最近对话",
  "phone.contact_changed": "通讯录变更",
  "phone.sms_appended": "短信",
  "mm_chat.turns_appended": "私信对话",
  "mail.messages_appended": "邮件",
  "mail.message_deleted": "邮件删除",
  "mail.draft_proposed": "邮件草稿提议",
  "mail.draft_discarded": "邮件草稿丢弃",
  "mail.draft_confirmed": "邮件草稿确认",
  "journal.entry_appended": "日记新增",
  "journal.entry_deleted": "日记删除",
  "journal.draft_proposed": "日记草稿提议",
  "journal.draft_discarded": "日记草稿丢弃",
  "journal.draft_confirmed": "日记草稿确认",
  "schedule.entry_appended": "日程新增",
  "schedule.entry_deleted": "日程删除",
  "schedule.draft_proposed": "日程草稿提议",
  "schedule.draft_discarded": "日程草稿丢弃",
  "schedule.draft_confirmed": "日程草稿确认",
  "file.entry_appended": "文件新增",
  "file.entry_deleted": "文件删除",
  "file.draft_proposed": "资料柜草稿提议",
  "file.draft_discarded": "资料柜草稿丢弃",
  "file.draft_confirmed": "资料柜草稿确认",
  "divination.entry_appended": "占卜记录",
  "divination.entry_deleted": "占卜删除",
  "divination.draft_proposed": "占卜（心象）草稿提议",
  "divination.draft_discarded": "占卜（心象）草稿丢弃",
  "divination.draft_confirmed": "占卜（心象）草稿确认",
  "shopping.entry_appended": "购物记录",
  "shopping.entry_deleted": "购物删除",
  "shopping.draft_proposed": "购物草稿提议",
  "shopping.draft_discarded": "购物草稿丢弃",
  "shopping.draft_confirmed": "购物草稿确认",
  "secondhand.entry_appended": "二手记录",
  "secondhand.entry_deleted": "二手删除",
  "secondhand.draft_proposed": "二手草稿提议",
  "secondhand.draft_discarded": "二手草稿丢弃",
  "secondhand.draft_confirmed": "二手草稿确认",
  "accounting.entry_appended": "记账新增",
  "accounting.entry_deleted": "记账删除",
  "accounting.draft_proposed": "记账草稿提议",
  "accounting.draft_discarded": "记账草稿丢弃",
  "accounting.draft_confirmed": "记账草稿确认",
  "reading_notes.entry_appended": "读书批注",
  "reading_notes.entry_deleted": "读书批注删除",
  "reading_notes.draft_proposed": "读书批注草稿提议",
  "reading_notes.draft_discarded": "读书批注草稿丢弃",
  "reading_notes.draft_confirmed": "读书批注草稿确认",
  "news.entry_appended": "报纸新增",
  "news.entry_deleted": "报纸删除",
  "news.draft_proposed": "报纸草稿提议",
  "news.draft_discarded": "报纸草稿丢弃",
  "news.draft_confirmed": "报纸草稿确认",
  "interview.entry_appended": "独家专访新增",
  "interview.entry_deleted": "独家专访删除",
  "interview.draft_proposed": "独家专访草稿提议",
  "interview.draft_discarded": "独家专访草稿丢弃",
  "interview.draft_confirmed": "独家专访草稿确认",
  "secret_space.record_appended": "秘密空间新增",
  "secret_space.record_deleted": "秘密空间删除",
  "secret_space.draft_proposed": "秘密空间草稿提议",
  "secret_space.draft_discarded": "秘密空间草稿丢弃",
  "secret_space.draft_confirmed": "秘密空间草稿确认",
  "pinned_memory.changed": "固定记忆变更",
  "memory_candidate.created": "新记忆候选",
  "memory_candidate.written": "记忆已固化",
  "memory_candidate.draft_proposed": "私藏回忆草稿提议",
  "memory_candidate.draft_discarded": "私藏回忆草稿丢弃",
  "memory_candidate.draft_confirmed": "私藏回忆草稿确认",
  "relationship_state.suggested": "关系建议",
  "relationship_state.applied": "关系更新",
  "relationship_state.draft_proposed": "关系状态草稿提议",
  "relationship_state.draft_discarded": "关系状态草稿丢弃",
  "relationship_state.draft_confirmed": "关系状态草稿确认",
  "phone_contact.draft_proposed": "通讯录更新草稿提议",
  "phone_contact.draft_discarded": "通讯录更新草稿丢弃",
  "phone_contact.draft_confirmed": "通讯录更新草稿确认",
  "moment.created": "朋友圈新增",
  "moment.deleted": "朋友圈删除",
  "moment.draft_proposed": "朋友圈草稿提议",
  "moment.draft_discarded": "朋友圈草稿丢弃",
  "moment.draft_confirmed": "朋友圈草稿确认",
  "sms.draft_proposed": "短信草稿提议",
  "sms.draft_discarded": "短信草稿丢弃",
  "sms.draft_confirmed": "短信草稿确认",
};

const TYPE_ORDER_ZH = [
  "phone.contact_changed",
  "phone.sms_appended",
  "mm_chat.turns_appended",
  "mail.messages_appended",
  "mail.message_deleted",
  "mail.draft_proposed",
  "mail.draft_discarded",
  "mail.draft_confirmed",
  "recent_chat.observed",
  "journal.entry_appended",
  "journal.entry_deleted",
  "journal.draft_proposed",
  "journal.draft_discarded",
  "journal.draft_confirmed",
  "schedule.entry_appended",
  "schedule.entry_deleted",
  "schedule.draft_proposed",
  "schedule.draft_discarded",
  "schedule.draft_confirmed",
  "file.entry_appended",
  "file.entry_deleted",
  "file.draft_proposed",
  "file.draft_discarded",
  "file.draft_confirmed",
  "divination.entry_appended",
  "divination.entry_deleted",
  "divination.draft_proposed",
  "divination.draft_discarded",
  "divination.draft_confirmed",
  "shopping.entry_appended",
  "shopping.entry_deleted",
  "shopping.draft_proposed",
  "shopping.draft_discarded",
  "shopping.draft_confirmed",
  "secondhand.entry_appended",
  "secondhand.entry_deleted",
  "secondhand.draft_proposed",
  "secondhand.draft_discarded",
  "secondhand.draft_confirmed",
  "accounting.entry_appended",
  "accounting.entry_deleted",
  "accounting.draft_proposed",
  "accounting.draft_discarded",
  "accounting.draft_confirmed",
  "reading_notes.entry_appended",
  "reading_notes.entry_deleted",
  "reading_notes.draft_proposed",
  "reading_notes.draft_discarded",
  "reading_notes.draft_confirmed",
  "news.entry_appended",
  "news.entry_deleted",
  "news.draft_proposed",
  "news.draft_discarded",
  "news.draft_confirmed",
  "interview.entry_appended",
  "interview.entry_deleted",
  "interview.draft_proposed",
  "interview.draft_discarded",
  "interview.draft_confirmed",
  "moment.created",
  "moment.deleted",
  "moment.draft_proposed",
  "moment.draft_discarded",
  "moment.draft_confirmed",
  "secret_space.record_appended",
  "secret_space.record_deleted",
  "secret_space.draft_proposed",
  "secret_space.draft_discarded",
  "secret_space.draft_confirmed",
  "memory_candidate.created",
  "memory_candidate.written",
  "memory_candidate.draft_proposed",
  "memory_candidate.draft_discarded",
  "memory_candidate.draft_confirmed",
  "pinned_memory.changed",
  "relationship_state.suggested",
  "relationship_state.applied",
  "relationship_state.draft_proposed",
  "relationship_state.draft_discarded",
  "relationship_state.draft_confirmed",
  "phone_contact.draft_proposed",
  "phone_contact.draft_discarded",
  "phone_contact.draft_confirmed",
  "sms.draft_proposed",
  "sms.draft_discarded",
  "sms.draft_confirmed",
];

const TYPE_ORDER_INDEX_ZH = new Map(TYPE_ORDER_ZH.map((type, index) => [type, index]));

/**
 * 这些事件类型表示「一条新内容被创建」，需要区分是 agent 自己产出（auto，走过
 * confirmXxxDraft 流程）还是用户手动写的（user）。其他事件类型（draft_*、*_deleted
 * 等）不分 origin——draft 三件套天生是 auto 内容上的动作，删除几乎都是用户行为。
 *
 * 加新模块到这个集合时，对应 producer 也要在 payload 里写 origin 字段
 * （desktop/src/react/xingye/xingye-draft-confirm-lock.ts originFromEntryId）。
 */
const ORIGIN_AWARE_TYPES = new Set([
  "journal.entry_appended",
  "schedule.entry_appended",
  "file.entry_appended",
  "mail.messages_appended",
  "secret_space.record_appended",
  "moment.created",
  "shopping.entry_appended",
  "secondhand.entry_appended",
  "accounting.entry_appended",
  "divination.entry_appended",
  "reading_notes.entry_appended",
  "news.entry_appended",
  "interview.entry_appended",
]);

const ORIGIN_LABEL_ZH = { auto: "自动", user: "手动" };

/**
 * 与 desktop/src/react/xingye/xingye-draft-confirm-lock.ts 的 FROM_DRAFT_ID_PREFIX
 * 保持同步。改动时两边都要动。
 */
const FROM_DRAFT_ID_PREFIX = "from-draft-";

/**
 * 从事件里推断 origin。优先用 payload.origin（producer 端权威写入）；老事件没有
 * 这个字段时回退到检查 subjectId / 常见 payload id 字段是否以 `from-draft-` 开头。
 */
function originFromEvent(event) {
  const payload = isRecord(event?.payload) ? event.payload : null;
  if (payload && (payload.origin === "auto" || payload.origin === "user")) return payload.origin;
  const idCandidates = [
    event?.subjectId,
    payload?.entryId,
    payload?.firstMessageId,
    payload?.recordId,
    payload?.postId,
    payload?.messageId,
  ];
  for (const id of idCandidates) {
    if (typeof id === "string" && id.startsWith(FROM_DRAFT_ID_PREFIX)) return "auto";
  }
  return "user";
}

/**
 * 把事件按类型聚合为「自上次巡检以来：A×2、B×5（共 7 条）」格式。
 * 无事件返回空字符串；类型未登记标签时回退到事件 type 字符串。
 *
 * 对于 ORIGIN_AWARE_TYPES 集合里的类型，会进一步按 origin 拆分：
 *   「日记新增（自动）×1、日记新增（手动）×2」
 * 让心跳 agent 在 prompt 里直接看到「哪些是我自己写的、哪些是用户写的」，
 * 避免把自己刚确认的草稿当成"用户新动作"再叠加反应。
 */
export function summarizeXingyeEventsForHeartbeatZh(events) {
  if (!Array.isArray(events) || events.length === 0) return "";
  const counts = new Map();
  for (const event of events) {
    if (!event || typeof event.type !== "string") continue;
    const type = event.type;
    const isOriginAware = ORIGIN_AWARE_TYPES.has(type);
    const bucket = isOriginAware ? `${type}::${originFromEvent(event)}` : type;
    counts.set(bucket, (counts.get(bucket) || 0) + 1);
  }
  if (counts.size === 0) return "";
  const parts = Array.from(counts.entries())
    .sort((a, b) => {
      const ta = a[0].split("::")[0];
      const tb = b[0].split("::")[0];
      const ai = TYPE_ORDER_INDEX_ZH.has(ta) ? TYPE_ORDER_INDEX_ZH.get(ta) : Number.MAX_SAFE_INTEGER;
      const bi = TYPE_ORDER_INDEX_ZH.has(tb) ? TYPE_ORDER_INDEX_ZH.get(tb) : Number.MAX_SAFE_INTEGER;
      if (ai !== bi) return ai - bi;
      /** 同类型内：auto 排在 user 前（agent 自己产出的优先看到）。 */
      return a[0].localeCompare(b[0]);
    })
    .map(([bucket, count]) => {
      const [type, origin] = bucket.split("::");
      const baseLabel = TYPE_LABEL_ZH[type] || type;
      if (!origin) return `${baseLabel}×${count}`;
      const originLabel = ORIGIN_LABEL_ZH[origin] || origin;
      return `${baseLabel}（${originLabel}）×${count}`;
    });
  return `自上次巡检以来：${parts.join("、")}（共 ${events.length} 条）`;
}

function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeDateString(value) {
  if (typeof value !== "string" || !value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function normalizeConsumedBy(value) {
  if (!isRecord(value)) return undefined;
  const out = {};
  for (const [consumerId, consumedAt] of Object.entries(value)) {
    if (typeof consumedAt === "string" && consumedAt) out[consumerId] = consumedAt;
  }
  return Object.keys(out).length ? out : undefined;
}

function normalizeEvent(input) {
  if (!isRecord(input)) return null;
  const id = normalizeString(input.id);
  const agentId = normalizeString(input.agentId);
  const type = normalizeString(input.type);
  const source = normalizeString(input.source);
  const createdAt = normalizeDateString(input.createdAt);
  const payload = isRecord(input.payload) ? input.payload : null;
  if (!id || !agentId || !type || !source || !createdAt || !payload) return null;
  const event = { id, agentId, type, source, createdAt, payload };
  const subjectId = normalizeString(input.subjectId);
  if (subjectId) event.subjectId = subjectId;
  const consumedBy = normalizeConsumedBy(input.consumedBy);
  if (consumedBy) event.consumedBy = consumedBy;
  return event;
}

function normalizeDedupeKeys(value) {
  if (!isRecord(value)) return {};
  const out = {};
  for (const [key, eventId] of Object.entries(value)) {
    if (key && typeof eventId === "string" && eventId) out[key] = eventId;
  }
  return out;
}

async function readJsonFile(filePath) {
  try {
    return JSON.parse(await fs.promises.readFile(filePath, "utf-8"));
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

async function atomicWriteJson(filePath, data) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  await fs.promises.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
  await fs.promises.rename(tmp, filePath);
}

async function readEventLog(agentDir, agentId) {
  const logPath = path.join(agentDir, "xingye", XINGYE_EVENT_LOG_RELATIVE_PATH);
  const raw = await readJsonFile(logPath);
  const rawEvents = Array.isArray(raw)
    ? raw
    : (isRecord(raw) && Array.isArray(raw.events) ? raw.events : []);
  const normalized = rawEvents.map((event) => normalizeEvent(event)).filter(Boolean);
  const events = normalized
    .filter((event) => event.agentId === agentId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const foreignCount = normalized.length - events.length;
  if (foreignCount > 0) {
    // 文件被串台了：我们写回时会 atomicWriteJson 覆盖整文件，foreign agent 的事件会消失。
    // 这里大声 warn，不静默删，便于排查迁移 / 复制粘贴造成的污染。
    console.warn(`[xingye] dropping ${foreignCount} foreign event(s) from ${logPath} (expected agentId=${agentId})`);
  }
  return {
    path: logPath,
    log: {
      version: 1,
      events,
      dedupeKeys: isRecord(raw) ? normalizeDedupeKeys(raw.dedupeKeys) : {},
    },
  };
}

function summarizeEvents(events) {
  const counts = new Map();
  for (const event of events) counts.set(event.type, (counts.get(event.type) || 0) + 1);
  const typeSummary = [...counts.entries()]
    .map(([type, count]) => `${type}: ${count}`)
    .join(", ");
  return `Consumed ${events.length} Xingye event${events.length === 1 ? "" : "s"} for heartbeat review${typeSummary ? ` (${typeSummary})` : ""}.`;
}

function buildObservations(events) {
  return events.map((event) => {
    const subject = event.subjectId ? ` subject=${event.subjectId}` : "";
    return `${event.type} from ${event.source}${subject} at ${event.createdAt}`;
  });
}

function buildSuggestedActions(events) {
  const actions = [];
  const seen = new Set();
  for (const event of events) {
    const action = SUGGESTION_BY_TYPE[event.type]
      || "Review the Xingye event and decide whether a future suggestion is needed.";
    if (!seen.has(action)) {
      seen.add(action);
      actions.push(action);
    }
  }
  return actions;
}

async function writeHeartbeatResult(agentDir, result) {
  const resultPath = path.join(agentDir, "xingye", XINGYE_HEARTBEAT_RESULT_RELATIVE_PATH);
  const historyPath = path.join(agentDir, "xingye", XINGYE_HEARTBEAT_HISTORY_RELATIVE_PATH);
  await atomicWriteJson(resultPath, result);
  await fs.promises.mkdir(path.dirname(historyPath), { recursive: true });
  await fs.promises.appendFile(historyPath, `${JSON.stringify(result)}\n`, "utf-8");
  await trimHistoryFile(historyPath);
}

/**
 * 照搬原生 cron-store 的 jsonl 截断模式：超过 MAX_LINES 时只留最后 KEEP_LINES 条。
 * 失败不影响主流程（appendFile 已经成功了，下次再修剪一样的）。
 */
async function trimHistoryFile(historyPath) {
  try {
    const content = await fs.promises.readFile(historyPath, "utf-8");
    const lines = content.trim().split("\n");
    if (lines.length <= XINGYE_HEARTBEAT_HISTORY_MAX_LINES) return;
    const tmp = `${historyPath}.tmp.${process.pid}.${Date.now()}`;
    await fs.promises.writeFile(
      tmp,
      `${lines.slice(-XINGYE_HEARTBEAT_HISTORY_KEEP_LINES).join("\n")}\n`,
      "utf-8",
    );
    await fs.promises.rename(tmp, historyPath);
  } catch { /* 修剪失败不影响主流程 */ }
}

/**
 * Prune 已被 xingye.heartbeat 消费且 consumedAt 早于 cutoff 的事件。
 * 未消费的事件无论多旧都保留。
 *
 * @param {Array} events
 * @param {string} nowIso - 当前时间（用作 cutoff 的基准）
 * @param {number} [retentionMs] - 保留窗口，默认 7 天
 * @returns {Array}
 */
export function pruneConsumedEvents(events, nowIso, retentionMs = XINGYE_EVENT_RETENTION_MS) {
  if (!Array.isArray(events) || events.length === 0) return events;
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(nowMs)) return events;
  const cutoff = nowMs - retentionMs;
  return events.filter((event) => {
    const consumedAt = event?.consumedBy?.[XINGYE_HEARTBEAT_CONSUMER_ID];
    if (typeof consumedAt !== "string") return true; // 未被 patrol 消费 → 保留
    const consumedMs = Date.parse(consumedAt);
    if (!Number.isFinite(consumedMs)) return true; // 时间解析失败 → 保守保留
    return consumedMs >= cutoff;
  });
}

/**
 * 计算「距离 agent 上次主动产出草稿，又过了多少条用户对话」。
 *
 * 输入：events 数组（应该是全量 log.events，而不是只看未消费——staleness 关心的
 *   是历史时间线，不是本轮 patrol 的增量）。
 * 输出：
 *   - lastAutoDraftAt: 最近一次 *.draft_proposed 事件的 createdAt（无则 null）
 *   - chatTurnsSinceLastDraft: 该时刻之后的 recent_chat.observed 条数（无 draft 时
 *     等于全部 recent_chat.observed 条数）
 *   - mustPropose: 是否达到/超过阈值（threshold 默认走 XINGYE_AUTO_DRAFT_STALENESS_THRESHOLD）
 *
 * 注意：
 *  - 阈值用「≥」而非「>」：50 条用户对话还没产出 → 本轮就该补
 *  - 无 draft 历史 ≠ mustPropose=true：要求至少累积 threshold 条对话才触发，避免
 *    刚装上 agent 第一次心跳就被强制推草稿
 *  - 计数只看 recent_chat.observed，不算 phone.sms/mail.messages_appended 等
 *    第三方/虚拟联系人产出的事件（user 没在直接和 agent 聊）
 */
export function computeAutoDraftStaleness(events, threshold = XINGYE_AUTO_DRAFT_STALENESS_THRESHOLD) {
  const empty = { lastAutoDraftAt: null, chatTurnsSinceLastDraft: 0, mustPropose: false };
  if (!Array.isArray(events) || events.length === 0) return empty;

  /** 找最新的 *.draft_proposed（按 createdAt 取 max；事件列表已经按时间排序但保险起见 max 一下）。 */
  let lastDraftMs = -Infinity;
  let lastDraftIso = null;
  for (const event of events) {
    if (!event || typeof event.type !== "string") continue;
    if (!event.type.endsWith(".draft_proposed")) continue;
    const ms = Date.parse(event.createdAt);
    if (!Number.isFinite(ms)) continue;
    if (ms > lastDraftMs) {
      lastDraftMs = ms;
      lastDraftIso = event.createdAt;
    }
  }

  /** 统计该时刻之后（严格大于）的 recent_chat.observed。无 draft → cutoff 设为 -∞，全数。 */
  const cutoff = Number.isFinite(lastDraftMs) ? lastDraftMs : -Infinity;
  let chatTurns = 0;
  for (const event of events) {
    if (!event || event.type !== "recent_chat.observed") continue;
    const ms = Date.parse(event.createdAt);
    if (!Number.isFinite(ms)) continue;
    if (ms > cutoff) chatTurns += 1;
  }

  return {
    lastAutoDraftAt: lastDraftIso,
    chatTurnsSinceLastDraft: chatTurns,
    mustPropose: chatTurns >= threshold,
  };
}

/** 清理 dedupeKeys 中指向已被 prune 的事件 id 的孤儿条目。 */
export function pruneOrphanDedupeKeys(dedupeKeys, events) {
  if (!dedupeKeys || typeof dedupeKeys !== "object") return {};
  const eventIds = new Set((events || []).map((e) => e?.id).filter(Boolean));
  const out = {};
  for (const [key, eventId] of Object.entries(dedupeKeys)) {
    if (eventIds.has(eventId)) out[key] = eventId;
  }
  return out;
}

async function markConsumed(logPath, log, consumedEventIds, consumedAt) {
  const ids = new Set(consumedEventIds);
  const updated = log.events.map((event) => {
    if (!ids.has(event.id)) return event;
    return {
      ...event,
      consumedBy: {
        ...(event.consumedBy || {}),
        [XINGYE_HEARTBEAT_CONSUMER_ID]: consumedAt,
      },
    };
  });
  const prunedEvents = pruneConsumedEvents(updated, consumedAt);
  const prunedDedupeKeys = pruneOrphanDedupeKeys(log.dedupeKeys, prunedEvents);
  await atomicWriteJson(logPath, { ...log, events: prunedEvents, dedupeKeys: prunedDedupeKeys });
}

export async function runXingyeHeartbeatConsumer({ agentId, agentDir, now = () => new Date() } = {}) {
  const aid = normalizeString(agentId);
  const dir = normalizeString(agentDir);
  if (!aid || !dir) return { consumed: 0, skipped: true };

  // 拿 per-agent 锁，避免 readEventLog → markConsumed 间被 appendXingyeEvent 写入丢事件
  // （markConsumed 把 in-memory log 整体覆写回去，没有锁就会把并发 append 的新事件吃掉）。
  return withXingyeAgentEventLock(aid, async () => {
    const { path: logPath, log } = await readEventLog(dir, aid);
    const events = log.events.filter((event) => !event.consumedBy?.[XINGYE_HEARTBEAT_CONSUMER_ID]);
    /**
     * Staleness 是历史维度——基于全量 log.events 算（含已被前几轮 consumer 标记
     * consumed 的），而不是本轮的增量 events。否则一旦 consumer 跑过一次，
     * 「上次 draft_proposed」就消失，结果永远 mustPropose=true。
     *
     * 即使本轮没有新事件也照算并下发：staleness 跟 "本轮是否有事可看" 无关，agent
     * 静默期间也可能需要被推一把。
     */
    const autoDraftStaleness = computeAutoDraftStaleness(log.events);

    if (events.length === 0) {
      /** 没新事件也要把 staleness 带回去——上层 patrol prompt 可能据此追加 directive。 */
      return { consumed: 0, skipped: true, autoDraftStaleness };
    }

    const createdAt = now().toISOString();
    const result = {
      version: 1,
      consumerId: XINGYE_HEARTBEAT_CONSUMER_ID,
      agentId: aid,
      createdAt,
      eventCount: events.length,
      consumedEventIds: events.map((event) => event.id),
      eventTypes: [...new Set(events.map((event) => event.type))],
      summary: summarizeEvents(events),
      summaryZh: summarizeXingyeEventsForHeartbeatZh(events),
      observations: buildObservations(events),
      suggestedActions: buildSuggestedActions(events),
      appliedActions: [],
      autoDraftStaleness,
    };

    await writeHeartbeatResult(dir, result);
    await markConsumed(logPath, log, result.consumedEventIds, createdAt);
    return { consumed: events.length, result };
  });
}
