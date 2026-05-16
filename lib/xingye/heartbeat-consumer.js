import fs from "fs";
import path from "path";

export const XINGYE_HEARTBEAT_CONSUMER_ID = "xingye.heartbeat";
export const XINGYE_EVENT_LOG_RELATIVE_PATH = path.join("events", "log.json");
export const XINGYE_HEARTBEAT_RESULT_RELATIVE_PATH = path.join("heartbeat", "result.json");
export const XINGYE_HEARTBEAT_HISTORY_RELATIVE_PATH = path.join("heartbeat", "history.jsonl");

const SUGGESTION_BY_TYPE = {
  "secret_space.record_appended": "Review the new secret-space record and decide whether it should inform future chat, lore, or relationship-state suggestions.",
  "secret_space.record_deleted": "Review the removed secret-space record and avoid relying on stale private context.",
  "memory_candidate.written": "Review the written memory candidate and decide whether it needs promotion, correction, or follow-up.",
  "phone.contact_changed": "Review the contact change and decide whether future phone suggestions need updated context.",
  "phone.sms_appended": "Review the new SMS context and decide whether a reply, memory candidate, or relationship-state suggestion is appropriate.",
  "relationship_state.suggested": "Review the relationship-state suggestion before applying any state change.",
  "relationship_state.applied": "Review the applied relationship-state change and watch for follow-up context.",
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
  "journal.entry_appended": "日记新增",
  "journal.entry_deleted": "日记删除",
  "schedule.entry_appended": "日程新增",
  "schedule.entry_deleted": "日程删除",
  "file.entry_appended": "文件新增",
  "file.entry_deleted": "文件删除",
  "divination.entry_appended": "占卜记录",
  "divination.entry_deleted": "占卜删除",
  "shopping.entry_appended": "购物记录",
  "shopping.entry_deleted": "购物删除",
  "reading_notes.entry_appended": "读书批注",
  "reading_notes.entry_deleted": "读书批注删除",
  "secret_space.record_appended": "秘密空间新增",
  "secret_space.record_deleted": "秘密空间删除",
  "pinned_memory.changed": "固定记忆变更",
  "memory_candidate.created": "新记忆候选",
  "memory_candidate.written": "记忆已固化",
  "relationship_state.suggested": "关系建议",
  "relationship_state.applied": "关系更新",
  "moment.created": "朋友圈新增",
  "moment.deleted": "朋友圈删除",
};

const TYPE_ORDER_ZH = [
  "phone.contact_changed",
  "phone.sms_appended",
  "mm_chat.turns_appended",
  "mail.messages_appended",
  "mail.message_deleted",
  "recent_chat.observed",
  "journal.entry_appended",
  "journal.entry_deleted",
  "schedule.entry_appended",
  "schedule.entry_deleted",
  "file.entry_appended",
  "file.entry_deleted",
  "divination.entry_appended",
  "divination.entry_deleted",
  "shopping.entry_appended",
  "shopping.entry_deleted",
  "reading_notes.entry_appended",
  "reading_notes.entry_deleted",
  "moment.created",
  "moment.deleted",
  "secret_space.record_appended",
  "secret_space.record_deleted",
  "memory_candidate.created",
  "memory_candidate.written",
  "pinned_memory.changed",
  "relationship_state.suggested",
  "relationship_state.applied",
];

const TYPE_ORDER_INDEX_ZH = new Map(TYPE_ORDER_ZH.map((type, index) => [type, index]));

/**
 * 把事件按类型聚合为「自上次巡检以来：A×2、B×5（共 7 条）」格式。
 * 无事件返回空字符串；类型未登记标签时回退到事件 type 字符串。
 */
export function summarizeXingyeEventsForHeartbeatZh(events) {
  if (!Array.isArray(events) || events.length === 0) return "";
  const counts = new Map();
  for (const event of events) {
    if (!event || typeof event.type !== "string") continue;
    counts.set(event.type, (counts.get(event.type) || 0) + 1);
  }
  if (counts.size === 0) return "";
  const parts = Array.from(counts.entries())
    .sort((a, b) => {
      const ai = TYPE_ORDER_INDEX_ZH.has(a[0]) ? TYPE_ORDER_INDEX_ZH.get(a[0]) : Number.MAX_SAFE_INTEGER;
      const bi = TYPE_ORDER_INDEX_ZH.has(b[0]) ? TYPE_ORDER_INDEX_ZH.get(b[0]) : Number.MAX_SAFE_INTEGER;
      if (ai !== bi) return ai - bi;
      return a[0].localeCompare(b[0]);
    })
    .map(([type, count]) => `${TYPE_LABEL_ZH[type] || type}×${count}`);
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
  const events = rawEvents
    .map((event) => normalizeEvent(event))
    .filter((event) => event && event.agentId === agentId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
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
}

async function markConsumed(logPath, log, consumedEventIds, consumedAt) {
  const ids = new Set(consumedEventIds);
  const next = {
    ...log,
    events: log.events.map((event) => {
      if (!ids.has(event.id)) return event;
      return {
        ...event,
        consumedBy: {
          ...(event.consumedBy || {}),
          [XINGYE_HEARTBEAT_CONSUMER_ID]: consumedAt,
        },
      };
    }),
  };
  await atomicWriteJson(logPath, next);
}

export async function runXingyeHeartbeatConsumer({ agentId, agentDir, now = () => new Date() } = {}) {
  const aid = normalizeString(agentId);
  const dir = normalizeString(agentDir);
  if (!aid || !dir) return { consumed: 0, skipped: true };

  const { path: logPath, log } = await readEventLog(dir, aid);
  const events = log.events.filter((event) => !event.consumedBy?.[XINGYE_HEARTBEAT_CONSUMER_ID]);
  if (events.length === 0) return { consumed: 0, skipped: true };

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
  };

  await writeHeartbeatResult(dir, result);
  await markConsumed(logPath, log, result.consumedEventIds, createdAt);
  return { consumed: events.length, result };
}
