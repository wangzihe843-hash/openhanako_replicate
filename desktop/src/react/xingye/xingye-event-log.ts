import { postXingyeStorage } from './xingye-storage-api';
import { createAgentXingyeStorageBackend } from './xingye-storage-backend';

export const XINGYE_EVENT_LOG_RELATIVE_PATH = 'events/log.json';

export const XINGYE_EVENT_TYPES = [
  'recent_chat.observed',
  'phone.contact_changed',
  'phone.sms_appended',
  'secret_space.record_appended',
  'secret_space.record_deleted',
  'pinned_memory.changed',
  'memory_candidate.created',
  'memory_candidate.written',
  'relationship_state.suggested',
  'relationship_state.applied',
  'moment.created',
  'moment.deleted',
  'moment.draft_proposed',
  'moment.draft_discarded',
  'moment.draft_confirmed',
  'mm_chat.turns_appended',
  'journal.entry_appended',
  'journal.entry_deleted',
  'journal.draft_proposed',
  'journal.draft_discarded',
  'journal.draft_confirmed',
  'schedule.entry_appended',
  'schedule.entry_deleted',
  'schedule.draft_proposed',
  'schedule.draft_discarded',
  'schedule.draft_confirmed',
  'trips.entry_appended',
  'trips.entry_deleted',
  'trips.draft_proposed',
  'trips.draft_discarded',
  'trips.draft_confirmed',
  'mail.messages_appended',
  'mail.message_deleted',
  'mail.draft_proposed',
  'mail.draft_discarded',
  'mail.draft_confirmed',
  'file.entry_appended',
  'file.entry_deleted',
  'file.draft_proposed',
  'file.draft_discarded',
  'file.draft_confirmed',
  'file.hidden_unlocked',
  'file.hidden_unlock_failed',
  'file.hidden_relocked',
  'secret_space.draft_proposed',
  'secret_space.draft_discarded',
  'secret_space.draft_confirmed',
  'divination.entry_appended',
  'divination.entry_deleted',
  'divination.draft_proposed',
  'divination.draft_discarded',
  'divination.draft_confirmed',
  'shopping.entry_appended',
  'shopping.entry_deleted',
  'shopping.draft_proposed',
  'shopping.draft_discarded',
  'shopping.draft_confirmed',
  'secondhand.entry_appended',
  'secondhand.entry_deleted',
  'secondhand.draft_proposed',
  'secondhand.draft_discarded',
  'secondhand.draft_confirmed',
  'accounting.entry_appended',
  'accounting.entry_deleted',
  'accounting.draft_proposed',
  'accounting.draft_discarded',
  'accounting.draft_confirmed',
  'reading_notes.entry_appended',
  'reading_notes.entry_deleted',
  'reading_notes.draft_proposed',
  'reading_notes.draft_discarded',
  'reading_notes.draft_confirmed',
  'news.entry_appended',
  'news.entry_deleted',
  'news.draft_proposed',
  'news.draft_discarded',
  'news.draft_confirmed',
  'interview.entry_appended',
  'interview.entry_deleted',
  'interview.draft_proposed',
  'interview.draft_discarded',
  'interview.draft_confirmed',
  'memory_candidate.draft_proposed',
  'memory_candidate.draft_discarded',
  'memory_candidate.draft_confirmed',
  'relationship_state.draft_proposed',
  'relationship_state.draft_discarded',
  'relationship_state.draft_confirmed',
  'phone_contact.draft_proposed',
  'phone_contact.draft_discarded',
  'phone_contact.draft_confirmed',
  'sms.draft_proposed',
  'sms.draft_discarded',
  'sms.draft_confirmed',
] as const;

export type XingyeEventType = typeof XINGYE_EVENT_TYPES[number];

export type XingyeEvent = {
  id: string;
  agentId: string;
  type: XingyeEventType;
  source: string;
  subjectId?: string;
  createdAt: string;
  payload: Record<string, unknown>;
  consumedBy?: Record<string, string>;
};

export type XingyeEventInput = {
  id?: string;
  agentId?: string;
  type: XingyeEventType;
  source: string;
  subjectId?: string;
  createdAt?: string;
  payload: Record<string, unknown>;
  consumedBy?: Record<string, string>;
};

export type XingyeEventListOptions = {
  types?: readonly XingyeEventType[];
  source?: string;
  since?: string;
  limit?: number;
  newestFirst?: boolean;
};

type XingyeEventLogFile = {
  version: 1;
  events: XingyeEvent[];
  dedupeKeys: Record<string, string>;
};

const EVENT_TYPE_SET = new Set<string>(XINGYE_EVENT_TYPES);
const backend = createAgentXingyeStorageBackend(postXingyeStorage);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizePayload(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function normalizeConsumedBy(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [consumer, consumedAt] of Object.entries(value)) {
    if (typeof consumedAt === 'string' && consumedAt) out[consumer] = consumedAt;
  }
  return Object.keys(out).length ? out : undefined;
}

function normalizeDateString(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function createId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `xe-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function normalizeXingyeEvent(input: unknown): XingyeEvent | null {
  if (!isRecord(input)) return null;
  const id = normalizeString(input.id);
  const agentId = normalizeString(input.agentId);
  const type = normalizeString(input.type);
  const source = normalizeString(input.source);
  const createdAt = normalizeDateString(input.createdAt);
  const payload = normalizePayload(input.payload);

  if (!id || !agentId || !type || !EVENT_TYPE_SET.has(type) || !source || !createdAt || !payload) {
    return null;
  }

  const subjectId = normalizeString(input.subjectId);
  const event: XingyeEvent = {
    id,
    agentId,
    type: type as XingyeEventType,
    source,
    createdAt,
    payload,
  };
  if (subjectId) event.subjectId = subjectId;
  const consumedBy = normalizeConsumedBy(input.consumedBy);
  if (consumedBy) event.consumedBy = consumedBy;
  return event;
}

export function createXingyeEvent(input: XingyeEventInput): XingyeEvent {
  const event = normalizeXingyeEvent({
    ...input,
    id: input.id ?? createId(),
    createdAt: input.createdAt ?? new Date().toISOString(),
  });
  if (!event) throw new Error('invalid Xingye event');
  return event;
}

function normalizeDedupeKeys(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, eventId] of Object.entries(value)) {
    if (key && typeof eventId === 'string' && eventId) out[key] = eventId;
  }
  return out;
}

async function readLog(agentId: string): Promise<XingyeEventLogFile> {
  const raw = await backend.readJson<unknown>(agentId, XINGYE_EVENT_LOG_RELATIVE_PATH);
  const eventsRaw = Array.isArray(raw)
    ? raw
    : (isRecord(raw) && Array.isArray(raw.events) ? raw.events : []);
  const events = eventsRaw
    .map((event) => normalizeXingyeEvent(event))
    .filter((event): event is XingyeEvent => Boolean(event))
    .filter((event) => event.agentId === agentId)
    .sort(compareEventsByCreatedAt);
  const dedupeKeys = isRecord(raw) ? normalizeDedupeKeys(raw.dedupeKeys) : {};
  return { version: 1, events, dedupeKeys };
}

/**
 * 渲染端不再裸 readJson+writeJson 改 events/log.json —— 那是一次没有跨进程互斥的
 * read-modify-write，会和服务端在 withXingyeAgentEventLock 内的 read→rename 交错，把
 * draft_proposed 之类事件静默吃掉。改走服务端 appendEventLog/markEventConsumed action，
 * 这两个 action 在 lib/xingye/events.js 的 per-agent 锁内做 RMW，与服务端来源的写入串行化。
 */
async function postEventLogAppend(
  agentId: string,
  event: XingyeEvent,
  dedupeKey?: string,
): Promise<XingyeEvent> {
  const data = await postXingyeStorage({
    action: 'appendEventLog',
    agentId,
    relativePath: XINGYE_EVENT_LOG_RELATIVE_PATH,
    event,
    ...(dedupeKey ? { dedupeKey } : {}),
  });
  // 服务端归一化后回写 event（dedupe 命中时回的是已有事件）；解析失败则退回本地构造的 event。
  return normalizeXingyeEvent(data?.event) ?? event;
}

async function postEventLogMarkConsumed(
  agentId: string,
  eventId: string,
  consumer: string,
): Promise<XingyeEvent | null> {
  const data = await postXingyeStorage({
    action: 'markEventConsumed',
    agentId,
    relativePath: XINGYE_EVENT_LOG_RELATIVE_PATH,
    eventId,
    consumer,
  });
  return normalizeXingyeEvent(data?.event);
}

function compareEventsByCreatedAt(a: XingyeEvent, b: XingyeEvent): number {
  return a.createdAt.localeCompare(b.createdAt);
}

function applyListOptions(events: XingyeEvent[], options?: XingyeEventListOptions): XingyeEvent[] {
  let out = [...events];
  if (options?.types?.length) {
    const types = new Set(options.types);
    out = out.filter((event) => types.has(event.type));
  }
  if (options?.source) {
    out = out.filter((event) => event.source === options.source);
  }
  if (options?.since) {
    const since = Date.parse(options.since);
    if (Number.isFinite(since)) {
      out = out.filter((event) => Date.parse(event.createdAt) >= since);
    }
  }
  out.sort(compareEventsByCreatedAt);
  if (options?.newestFirst) out.reverse();
  if (typeof options?.limit === 'number' && options.limit >= 0) out = out.slice(0, options.limit);
  return out;
}

export async function listXingyeEvents(
  agentId: string,
  options?: XingyeEventListOptions,
): Promise<XingyeEvent[]> {
  if (!agentId.trim()) return [];
  const log = await readLog(agentId.trim());
  return applyListOptions(log.events, options);
}

export async function appendXingyeEvent(
  agentId: string,
  input: Omit<XingyeEventInput, 'agentId'> & { agentId?: string },
): Promise<XingyeEvent> {
  const aid = agentId.trim();
  if (!aid) throw new Error('agentId is required');
  // 本地构造（生成 id/createdAt、做一遍校验），实际落盘走服务端锁内 append。
  const event = createXingyeEvent({ ...input, agentId: aid });
  return postEventLogAppend(aid, event);
}

export async function markXingyeEventConsumed(
  agentId: string,
  eventId: string,
  consumerName: string,
): Promise<XingyeEvent | null> {
  const aid = agentId.trim();
  const id = eventId.trim();
  const consumer = consumerName.trim();
  if (!aid || !id || !consumer) return null;
  return postEventLogMarkConsumed(aid, id, consumer);
}

export async function listUnconsumedXingyeEvents(
  agentId: string,
  consumerName: string,
  options?: XingyeEventListOptions,
): Promise<XingyeEvent[]> {
  const consumer = consumerName.trim();
  if (!consumer) return [];
  const events = await listXingyeEvents(agentId, options);
  return events.filter((event) => !event.consumedBy?.[consumer]);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function makeXingyeEventDedupeKey(input: Pick<XingyeEventInput, 'type' | 'source' | 'subjectId' | 'payload'>): string {
  return stableStringify({
    type: input.type,
    source: input.source,
    subjectId: input.subjectId ?? '',
    payload: input.payload,
  });
}

export async function appendXingyeEventOnce(
  agentId: string,
  input: Omit<XingyeEventInput, 'agentId'> & { agentId?: string },
  dedupeKey: string,
): Promise<XingyeEvent> {
  const aid = agentId.trim();
  const key = dedupeKey.trim();
  if (!aid) throw new Error('agentId is required');
  if (!key) return appendXingyeEvent(aid, input);

  // 本地构造候选事件；dedupe 判定与落盘都在服务端锁内做（命中已有 key 时回旧事件，不追加）。
  const event = createXingyeEvent({ ...input, agentId: aid });
  return postEventLogAppend(aid, event, key);
}
