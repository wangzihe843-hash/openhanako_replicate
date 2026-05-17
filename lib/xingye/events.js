/**
 * 服务端 Xingye event log 追加助手。
 *
 * 渲染端版本：desktop/src/react/xingye/xingye-event-log.ts，通过 HTTP 走 /api/xingye/storage 写。
 * 此处直接读写文件，给在服务端 process 内触发事件的代码用（pinned.md 工具/路由、
 * desktop-session-submit 完成事件等）。
 *
 * 关键点：
 *  - 同一 agent 的 events/log.json 用进程内 per-agent Promise chain 串行化，避免
 *    "两个写入者同时 read→append→write" 互相覆盖。
 *  - 与 lib/xingye/heartbeat-consumer.js / desktop 渲染端用同一 path + schema，
 *    consumer 不需要任何改动就能消费这边写出来的事件。
 */

import fs from "node:fs";
import path from "node:path";

import { XINGYE_EVENT_LOG_RELATIVE_PATH } from "./heartbeat-consumer.js";

const _agentLocks = new Map();

/** 同一 agent 内串行化 append，避免覆盖丢事件。 */
function withAgentLock(agentId, fn) {
  const prev = _agentLocks.get(agentId) || Promise.resolve();
  const next = prev.then(() => fn(), () => fn());
  const tracked = next.catch(() => {});
  _agentLocks.set(agentId, tracked);
  tracked.finally(() => {
    if (_agentLocks.get(agentId) === tracked) _agentLocks.delete(agentId);
  });
  return next;
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

function compareByCreatedAt(a, b) {
  return a.createdAt.localeCompare(b.createdAt);
}

function logPathFor(agentDir) {
  return path.join(agentDir, "xingye", XINGYE_EVENT_LOG_RELATIVE_PATH);
}

async function readLog(agentDir, agentId) {
  const file = logPathFor(agentDir);
  let raw;
  try {
    raw = JSON.parse(await fs.promises.readFile(file, "utf-8"));
  } catch (err) {
    if (err?.code === "ENOENT") raw = null;
    else throw err;
  }
  const rawEvents = Array.isArray(raw)
    ? raw
    : (isRecord(raw) && Array.isArray(raw.events) ? raw.events : []);
  const normalized = rawEvents.map((event) => normalizeEvent(event)).filter(Boolean);
  const events = normalized
    .filter((event) => event.agentId === agentId)
    .sort(compareByCreatedAt);
  const foreignCount = normalized.length - events.length;
  if (foreignCount > 0) {
    // 文件被串台了；append 会 atomicWriteJson 全量覆盖，foreign 事件会消失。
    // warn 出来便于排查（迁移、复制粘贴）。consumer-side 也有同款 warn，保持一致。
    console.warn(`[xingye] dropping ${foreignCount} foreign event(s) from ${file} (expected agentId=${agentId})`);
  }
  return {
    file,
    log: {
      version: 1,
      events,
      dedupeKeys: isRecord(raw) ? normalizeDedupeKeys(raw.dedupeKeys) : {},
    },
  };
}

async function atomicWriteJson(file, data) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  await fs.promises.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
  await fs.promises.rename(tmp, file);
}

function createId() {
  // Node 16+ has crypto.randomUUID, safe to use here.
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `xe-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function buildEvent(agentId, input) {
  return normalizeEvent({
    ...input,
    agentId,
    id: input.id || createId(),
    createdAt: input.createdAt || new Date().toISOString(),
  });
}

/**
 * 服务端往指定 agent 的 events/log.json 追加一条事件。
 *
 * @param {object} args
 * @param {string} args.agentDir 该 agent 的根目录（HANA_HOME/agents/<id>）。
 * @param {string} args.agentId
 * @param {{ type: string, source: string, payload: object, subjectId?: string, createdAt?: string, id?: string }} args.input
 * @returns {Promise<object|null>} 写入后的事件；输入非法时返回 null（不抛）。
 */
export async function appendXingyeEvent({ agentDir, agentId, input }) {
  const aid = normalizeString(agentId);
  const dir = normalizeString(agentDir);
  if (!aid || !dir || !isRecord(input)) return null;
  return withAgentLock(aid, async () => {
    const event = buildEvent(aid, input);
    if (!event) return null;
    const { file, log } = await readLog(dir, aid);
    log.events.push(event);
    log.events.sort(compareByCreatedAt);
    await atomicWriteJson(file, { version: 1, events: log.events, dedupeKeys: log.dedupeKeys });
    return event;
  });
}

/**
 * 同上，但如果 dedupeKey 已存在，直接返回已有事件，不追加。用于重连/重复触发场景。
 */
export async function appendXingyeEventOnce({ agentDir, agentId, input, dedupeKey }) {
  const aid = normalizeString(agentId);
  const dir = normalizeString(agentDir);
  const key = normalizeString(dedupeKey);
  if (!aid || !dir || !isRecord(input)) return null;
  if (!key) return appendXingyeEvent({ agentDir: dir, agentId: aid, input });

  return withAgentLock(aid, async () => {
    const { file, log } = await readLog(dir, aid);
    const existingId = log.dedupeKeys[key];
    if (existingId) {
      const existing = log.events.find((event) => event.id === existingId);
      if (existing) return existing;
    }
    const event = buildEvent(aid, input);
    if (!event) return null;
    log.events.push(event);
    log.events.sort(compareByCreatedAt);
    log.dedupeKeys[key] = event.id;
    await atomicWriteJson(file, { version: 1, events: log.events, dedupeKeys: log.dedupeKeys });
    return event;
  });
}

/** 暴露给 heartbeat consumer 重用，让消费者也能 piggyback 在同一把 per-agent 锁上。 */
export function withXingyeAgentEventLock(agentId, fn) {
  const aid = normalizeString(agentId);
  if (!aid) return Promise.resolve().then(fn);
  return withAgentLock(aid, fn);
}
