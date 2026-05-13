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
    observations: buildObservations(events),
    suggestedActions: buildSuggestedActions(events),
    appliedActions: [],
  };

  await writeHeartbeatResult(dir, result);
  await markConsumed(logPath, log, result.consumedEventIds, createdAt);
  return { consumed: events.length, result };
}
