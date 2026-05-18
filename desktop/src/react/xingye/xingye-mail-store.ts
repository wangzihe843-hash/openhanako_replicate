import { postXingyeStorage } from './xingye-storage-api';
import { createAgentXingyeStorageBackend } from './xingye-storage-backend';
import { appendXingyeEvent, type XingyeEventInput } from './xingye-event-log';
import { withDraftConfirmLock } from './xingye-draft-confirm-lock';

const backend = createAgentXingyeStorageBackend(postXingyeStorage);

async function appendMailEventBestEffort(
  agentId: string,
  input: Omit<XingyeEventInput, 'agentId'>,
): Promise<void> {
  try {
    await appendXingyeEvent(agentId, input);
  } catch (error) {
    console.warn('[xingye-mail-store] event log append failed:', error);
  }
}

/** 相对路径位于 HANA_HOME/agents/{agentId}/xingye/ 下 */
export const XINGYE_MAIL_PROFILE_JSON = 'apps/mail/profile.json';
export const XINGYE_MAIL_MESSAGES_JSONL = 'apps/mail/messages.jsonl';

/**
 * 心跳巡检（或其他自动来源）产出的「待确认邮件草稿」存放路径，与 messages 同目录、分文件。
 * 同 journal/schedule/moments：messages.jsonl 是「已生成」邮箱（含 drafts 邮箱）的最终邮件；
 * apps/mail/drafts.jsonl 这个 file 是 agent 提议、用户未确认的候选；确认后才会通过
 * appendMailMessage 写到 messages.jsonl 的 `drafts` 邮箱（用户视角的草稿箱）。
 *
 * 注意命名歧义：这里两个「drafts」语义不同：
 *  - apps/mail/drafts.jsonl：本文件——巡检提议、用户尚未确认的候选；
 *  - messages.jsonl 里 mailbox==='drafts' 的行：用户视角已经存在的草稿，可继续编辑/发送。
 *
 * 确认走 confirmMailDraft，丢弃走 discardMailDraft。
 */
export const XINGYE_MAIL_DRAFTS_JSONL = 'apps/mail/drafts.jsonl';

/** 与 server/routes/xingye-storage.js SAFE_AGENT_ID_RE 一致 */
const SAFE_AGENT_ID_RE = /^[A-Za-z0-9_-]{1,120}$/;

/** 模拟邮箱域名；这是 agent 小手机里的虚拟邮箱外观，不连接任何真实邮件服务。 */
export const XINGYE_MAIL_DOMAIN = 'hana.mail';

export type XingyeMailMailbox = 'inbox' | 'sent' | 'drafts' | 'promotions' | 'spam';

export const XINGYE_MAIL_MAILBOXES: ReadonlyArray<XingyeMailMailbox> = [
  'inbox',
  'sent',
  'drafts',
  'promotions',
  'spam',
];

export type XingyeMailFromKind = 'agent' | 'virtual_contact' | 'system' | 'promotion' | 'spam';

const XINGYE_MAIL_FROM_KINDS: ReadonlyArray<XingyeMailFromKind> = [
  'agent',
  'virtual_contact',
  'system',
  'promotion',
  'spam',
];

export type XingyeMailAddress = {
  name: string;
  address: string;
};

export type XingyeMailMessage = {
  id: string;
  /** 与 backend.deleteJsonlRecord 匹配用的 key（与 id 同值） */
  key: string;
  agentId: string;
  mailbox: XingyeMailMailbox;
  from: XingyeMailAddress & { kind: XingyeMailFromKind };
  to: XingyeMailAddress[];
  subject: string;
  body: string;
  snippet?: string;
  isRead: boolean;
  isStarred: boolean;
  autoStarred?: boolean;
  labels: string[];
  createdAt: string;
  updatedAt: string;
  source?: string;
};

export type XingyeMailProfile = {
  agentId: string;
  address: string;
  displayName: string;
  createdAt: string;
  updatedAt: string;
};

export type XingyeMailMessageDraft = {
  mailbox: XingyeMailMailbox;
  from: XingyeMailAddress & { kind: XingyeMailFromKind };
  to: XingyeMailAddress[];
  subject: string;
  body: string;
  snippet?: string;
  isRead?: boolean;
  isStarred?: boolean;
  autoStarred?: boolean;
  labels?: string[];
  source?: string;
};

function assertAgentId(agentId: string, action: string): string {
  const aid = String(agentId ?? '').trim();
  if (!aid) throw new Error(`${action}失败：缺少 agentId。`);
  if (!SAFE_AGENT_ID_RE.test(aid)) {
    throw new Error(`${action}失败：agentId 格式无效（仅允许字母、数字、下划线与短横线，长度 1–120）。`);
  }
  return aid;
}

function newMailMessageId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `mail-${crypto.randomUUID()}`;
  }
  return `mail-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function isIsoLike(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function normalizeMailbox(value: unknown): XingyeMailMailbox | null {
  return XINGYE_MAIL_MAILBOXES.includes(value as XingyeMailMailbox)
    ? (value as XingyeMailMailbox)
    : null;
}

function normalizeFromKind(value: unknown): XingyeMailFromKind {
  return XINGYE_MAIL_FROM_KINDS.includes(value as XingyeMailFromKind)
    ? (value as XingyeMailFromKind)
    : 'system';
}

function normalizeText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value.slice(0, max);
}

function normalizeOptionalText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text) return undefined;
  return text.slice(0, max);
}

function normalizeAddressName(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.slice(0, 80);
}

function normalizeAddress(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.slice(0, 160);
}

function normalizeLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    out.push(trimmed.slice(0, 24));
    if (out.length >= 8) break;
  }
  return out;
}

function normalizeToArray(value: unknown): XingyeMailAddress[] {
  if (!Array.isArray(value)) return [];
  const out: XingyeMailAddress[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const raw = entry as Record<string, unknown>;
    const name = normalizeAddressName(raw.name);
    const address = normalizeAddress(raw.address);
    if (!address) continue;
    out.push({ name: name || address, address });
    if (out.length >= 8) break;
  }
  return out;
}

function buildSnippet(body: string, max = 80): string {
  const collapsed = body.replace(/\s+/g, ' ').trim();
  if (!collapsed) return '';
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, Math.max(1, max - 1))}…`;
}

function normalizeMessage(value: unknown, expectedAgentId: string): XingyeMailMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : '';
  if (!id) return null;
  const agentId = typeof raw.agentId === 'string' && raw.agentId.trim() ? raw.agentId.trim() : '';
  if (agentId !== expectedAgentId) return null;
  const mailbox = normalizeMailbox(raw.mailbox);
  if (!mailbox) return null;
  const fromRaw = raw.from && typeof raw.from === 'object' && !Array.isArray(raw.from)
    ? (raw.from as Record<string, unknown>)
    : null;
  const fromAddress = fromRaw ? normalizeAddress(fromRaw.address) : '';
  if (!fromAddress) return null;
  const subject = normalizeText(raw.subject, 200).trim();
  const body = normalizeText(raw.body, 8000);
  if (!subject && !body) return null;
  const createdAt = typeof raw.createdAt === 'string' && isIsoLike(raw.createdAt)
    ? raw.createdAt
    : new Date(0).toISOString();
  const updatedAt = typeof raw.updatedAt === 'string' && isIsoLike(raw.updatedAt)
    ? raw.updatedAt
    : createdAt;
  return {
    id,
    key: id,
    agentId,
    mailbox,
    from: {
      name: normalizeAddressName(fromRaw?.name) || fromAddress,
      address: fromAddress,
      kind: normalizeFromKind(fromRaw?.kind),
    },
    to: normalizeToArray(raw.to),
    subject: subject || '（无主题）',
    body,
    snippet: normalizeOptionalText(raw.snippet, 200) ?? (body ? buildSnippet(body) : undefined),
    isRead: Boolean(raw.isRead),
    isStarred: Boolean(raw.isStarred),
    autoStarred: typeof raw.autoStarred === 'boolean' ? raw.autoStarred : undefined,
    labels: normalizeLabels(raw.labels),
    createdAt,
    updatedAt,
    source: normalizeOptionalText(raw.source, 80),
  };
}

function normalizeProfile(value: unknown, expectedAgentId: string): XingyeMailProfile | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const agentId = typeof raw.agentId === 'string' && raw.agentId.trim() ? raw.agentId.trim() : '';
  if (agentId !== expectedAgentId) return null;
  const address = typeof raw.address === 'string' && raw.address.trim() ? raw.address.trim() : '';
  if (!address) return null;
  const displayName = typeof raw.displayName === 'string' && raw.displayName.trim()
    ? raw.displayName.trim().slice(0, 80)
    : '';
  if (!displayName) return null;
  const createdAt = typeof raw.createdAt === 'string' && isIsoLike(raw.createdAt)
    ? raw.createdAt
    : new Date(0).toISOString();
  const updatedAt = typeof raw.updatedAt === 'string' && isIsoLike(raw.updatedAt)
    ? raw.updatedAt
    : createdAt;
  return {
    agentId,
    address: address.slice(0, 160),
    displayName,
    createdAt,
    updatedAt,
  };
}

function sortMessages(a: XingyeMailMessage, b: XingyeMailMessage): number {
  const ta = Date.parse(a.createdAt);
  const tb = Date.parse(b.createdAt);
  if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return tb - ta;
  return a.id.localeCompare(b.id);
}

function sanitizeAddressLocalPart(raw: string): string {
  const normalized = raw
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9._-]+/g, '');
  return normalized.replace(/^[._-]+|[._-]+$/g, '').slice(0, 32);
}

function randomSuffix(length = 4): string {
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const arr = new Uint8Array(Math.ceil(length / 2));
    crypto.getRandomValues(arr);
    return Array.from(arr)
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')
      .slice(0, length);
  }
  return Math.random().toString(16).slice(2, 2 + length);
}

/**
 * 基于 agent 信息生成 agent 风格的模拟邮箱地址。
 * 不连接任何真实邮件服务；域名固定为 `hana.mail`，让 UI 看起来像 Gmail/Outlook 外观但绝不是真实地址。
 */
export function buildXingyeMailAddress(input: {
  agentId: string;
  displayName?: string;
  agentName?: string;
}): string {
  const seeds: string[] = [];
  const displayName = input.displayName?.trim();
  const agentName = input.agentName?.trim();
  if (displayName) seeds.push(sanitizeAddressLocalPart(displayName));
  if (agentName) seeds.push(sanitizeAddressLocalPart(agentName));
  seeds.push(sanitizeAddressLocalPart(input.agentId));
  const local = seeds.find((s) => s.length >= 2) || 'agent';
  return `${local}.${randomSuffix(4)}@${XINGYE_MAIL_DOMAIN}`;
}

export async function getMailProfile(agentId: string): Promise<XingyeMailProfile | null> {
  const aid = String(agentId ?? '').trim();
  if (!aid) return null;
  try {
    const data = await backend.readJson<unknown>(aid, XINGYE_MAIL_PROFILE_JSON);
    return normalizeProfile(data, aid);
  } catch {
    return null;
  }
}

export type EnsureMailProfileInput = {
  displayName: string;
  agentName?: string;
};

export async function ensureMailProfile(
  agentId: string,
  input: EnsureMailProfileInput,
): Promise<XingyeMailProfile> {
  const aid = assertAgentId(agentId, '初始化邮箱');
  const existing = await getMailProfile(aid);
  if (existing) return existing;
  const nowIso = new Date().toISOString();
  const profile: XingyeMailProfile = {
    agentId: aid,
    address: buildXingyeMailAddress({
      agentId: aid,
      displayName: input.displayName,
      agentName: input.agentName,
    }),
    displayName: input.displayName.trim().slice(0, 80) || aid,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  await backend.writeJson(aid, XINGYE_MAIL_PROFILE_JSON, profile);
  return profile;
}

export async function listMailMessages(agentId: string): Promise<XingyeMailMessage[]> {
  const aid = String(agentId ?? '').trim();
  if (!aid) return [];
  try {
    const rows = await backend.listJsonl<unknown>(aid, XINGYE_MAIL_MESSAGES_JSONL);
    return rows
      .map((row) => normalizeMessage(row, aid))
      .filter((row): row is XingyeMailMessage => Boolean(row))
      .sort(sortMessages);
  } catch {
    return [];
  }
}

export async function listMailMessagesByMailbox(
  agentId: string,
  mailbox: XingyeMailMailbox,
): Promise<XingyeMailMessage[]> {
  const all = await listMailMessages(agentId);
  return all.filter((message) => message.mailbox === mailbox);
}

function buildMessage(
  agentId: string,
  draft: XingyeMailMessageDraft,
  nowIso: string,
  id = newMailMessageId(),
): XingyeMailMessage {
  const subject = (draft.subject ?? '').trim().slice(0, 200);
  const body = (draft.body ?? '').slice(0, 8000);
  if (!subject && !body) {
    throw new Error('邮件标题与正文不能同时为空。');
  }
  const fromAddress = normalizeAddress(draft.from?.address);
  if (!fromAddress) throw new Error('发件人地址不能为空。');
  const fromName = normalizeAddressName(draft.from?.name) || fromAddress;
  const toList = normalizeToArray(draft.to);
  return {
    id,
    key: id,
    agentId,
    mailbox: draft.mailbox,
    from: {
      name: fromName,
      address: fromAddress,
      kind: normalizeFromKind(draft.from?.kind),
    },
    to: toList,
    subject: subject || '（无主题）',
    body,
    snippet: normalizeOptionalText(draft.snippet, 200) ?? (body ? buildSnippet(body) : undefined),
    isRead: Boolean(draft.isRead),
    isStarred: Boolean(draft.isStarred),
    autoStarred: typeof draft.autoStarred === 'boolean' ? draft.autoStarred : undefined,
    labels: normalizeLabels(draft.labels),
    createdAt: nowIso,
    updatedAt: nowIso,
    source: normalizeOptionalText(draft.source, 80),
  };
}

/**
 * `options.id`：心跳 confirm 流程会传 `from-draft-${draft.id}` 走幂等路径
 * （见 confirmMailDraft 注释）。手动发邮件时不传，沿用随机 id。
 */
export async function appendMailMessage(
  agentId: string,
  draft: XingyeMailMessageDraft,
  options: { id?: string } = {},
): Promise<XingyeMailMessage> {
  const aid = assertAgentId(agentId, '保存邮件');
  const nowIso = new Date().toISOString();
  const id = typeof options.id === 'string' && options.id.trim() ? options.id.trim() : newMailMessageId();
  const message = buildMessage(aid, draft, nowIso, id);
  await backend.appendJsonl(aid, XINGYE_MAIL_MESSAGES_JSONL, message);
  await appendMailEventBestEffort(aid, {
    type: 'mail.messages_appended',
    source: 'xingye-mail-store',
    subjectId: message.id,
    payload: {
      count: 1,
      mailbox: message.mailbox,
      firstMessageId: message.id,
      fromKind: message.from.kind,
    },
  });
  return message;
}

export async function appendMailMessages(
  agentId: string,
  drafts: XingyeMailMessageDraft[],
): Promise<XingyeMailMessage[]> {
  if (!drafts.length) return [];
  const aid = assertAgentId(agentId, '保存邮件');
  const out: XingyeMailMessage[] = [];
  // 让每条邮件 createdAt 在毫秒上递增，避免同一时刻造成排序抖动。
  let base = Date.now();
  for (const draft of drafts) {
    const iso = new Date(base++).toISOString();
    const message = buildMessage(aid, draft, iso);
    await backend.appendJsonl(aid, XINGYE_MAIL_MESSAGES_JSONL, message);
    out.push(message);
  }
  await appendMailEventBestEffort(aid, {
    type: 'mail.messages_appended',
    source: 'xingye-mail-store',
    subjectId: out[0].id,
    payload: {
      count: out.length,
      mailbox: out[0].mailbox,
      firstMessageId: out[0].id,
      fromKind: out[0].from.kind,
    },
  });
  return out;
}

export type XingyeMailMessagePatch = Partial<{
  mailbox: XingyeMailMailbox;
  subject: string;
  body: string;
  isRead: boolean;
  isStarred: boolean;
  autoStarred: boolean;
  labels: string[];
  to: XingyeMailAddress[];
}>;

export async function updateMailMessage(
  agentId: string,
  messageId: string,
  patch: XingyeMailMessagePatch,
): Promise<XingyeMailMessage | null> {
  const aid = assertAgentId(agentId, '更新邮件');
  const mid = messageId.trim();
  if (!mid) throw new Error('更新失败：缺少邮件 id。');
  const current = (await listMailMessages(aid)).find((message) => message.id === mid);
  if (!current) return null;
  const nextSubject = patch.subject !== undefined ? patch.subject.trim().slice(0, 200) : current.subject;
  const nextBody = patch.body !== undefined ? patch.body.slice(0, 8000) : current.body;
  const nextMailbox = patch.mailbox !== undefined ? patch.mailbox : current.mailbox;
  const nextStarred = patch.isStarred !== undefined ? Boolean(patch.isStarred) : current.isStarred;
  const updated: XingyeMailMessage = {
    ...current,
    mailbox: nextMailbox,
    subject: nextSubject || '（无主题）',
    body: nextBody,
    snippet: nextBody ? buildSnippet(nextBody) : current.snippet,
    isRead: patch.isRead !== undefined ? Boolean(patch.isRead) : current.isRead,
    isStarred: nextStarred,
    autoStarred:
      patch.autoStarred !== undefined ? Boolean(patch.autoStarred) : current.autoStarred,
    labels: patch.labels !== undefined ? normalizeLabels(patch.labels) : current.labels,
    to: patch.to !== undefined ? normalizeToArray(patch.to) : current.to,
    updatedAt: new Date().toISOString(),
  };
  await backend.deleteJsonlRecord(aid, XINGYE_MAIL_MESSAGES_JSONL, mid);
  await backend.appendJsonl(aid, XINGYE_MAIL_MESSAGES_JSONL, updated);
  return updated;
}

export async function setMailMessageStar(
  agentId: string,
  messageId: string,
  isStarred: boolean,
): Promise<XingyeMailMessage | null> {
  return updateMailMessage(agentId, messageId, { isStarred });
}

export async function deleteMailMessage(agentId: string, messageId: string): Promise<boolean> {
  const aid = assertAgentId(agentId, '删除邮件');
  const mid = messageId.trim();
  if (!mid) throw new Error('删除失败：缺少邮件 id。');
  const deleted = await backend.deleteJsonlRecord(aid, XINGYE_MAIL_MESSAGES_JSONL, mid);
  if (deleted) {
    await appendMailEventBestEffort(aid, {
      type: 'mail.message_deleted',
      source: 'xingye-mail-store',
      subjectId: mid,
      payload: { messageId: mid },
    });
  }
  return deleted;
}

// ─────────────────────────────────────────────────────────────────────────
//  Pending mail drafts (heartbeat-proposed, awaiting user confirmation)
// ─────────────────────────────────────────────────────────────────────────

export type XingyePendingMailDraft = {
  id: string;
  subject: string;
  body: string;
  toAddress?: string;
  toName?: string;
  /** Why the draft was proposed — shown to the user before they confirm. */
  reason?: string;
  /** Producer 标识，例：'xingye-heartbeat-tool'。 */
  source: string;
  /** Event ids that motivated this draft (for traceability)；可空。 */
  sourceEventIds?: string[];
  createdAt: string;
};

function normalizeMailDraftRow(value: unknown): XingyePendingMailDraft | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : '';
  if (!id) return null;
  const subject = typeof raw.subject === 'string' ? raw.subject.trim().slice(0, 200) : '';
  const body = typeof raw.body === 'string' ? raw.body.slice(0, 8000) : '';
  /** subject 和 body 不能同时为空——与 server 端 mail-drafts.js / buildMessage 一致。 */
  if (!subject && !body.trim()) return null;
  const createdAt = typeof raw.createdAt === 'string' && raw.createdAt
    ? raw.createdAt
    : new Date(0).toISOString();
  const source = typeof raw.source === 'string' && raw.source.trim()
    ? raw.source.trim()
    : 'unknown';
  const toAddress = normalizeOptionalText(raw.toAddress, 160);
  const toName = normalizeOptionalText(raw.toName, 80);
  const reason = normalizeOptionalText(raw.reason, 1000);
  const eventIdsRaw = raw.sourceEventIds;
  const sourceEventIds = Array.isArray(eventIdsRaw)
    ? eventIdsRaw.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : undefined;
  return { id, subject, body, toAddress, toName, createdAt, reason, source, sourceEventIds };
}

function sortMailDrafts(a: XingyePendingMailDraft, b: XingyePendingMailDraft): number {
  const ta = Date.parse(a.createdAt);
  const tb = Date.parse(b.createdAt);
  if (ta !== tb && !Number.isNaN(ta) && !Number.isNaN(tb)) return tb - ta;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

export async function listMailDrafts(agentId: string): Promise<XingyePendingMailDraft[]> {
  const aid = String(agentId ?? '').trim();
  if (!aid) return [];
  try {
    const rows = await backend.listJsonl<unknown>(aid, XINGYE_MAIL_DRAFTS_JSONL);
    return rows
      .map(normalizeMailDraftRow)
      .filter((d): d is XingyePendingMailDraft => Boolean(d))
      .sort(sortMailDrafts);
  } catch {
    return [];
  }
}

function newMailDraftId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `mail-${crypto.randomUUID()}`;
  }
  return `mail-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 写入一条「待确认邮件草稿」。
 *
 * 与 appendMailMessage 区别：
 *  - 不写 messages.jsonl，不发 mail.messages_appended，因此不会出现在任何邮箱里；
 *  - 发出 `mail.draft_proposed`，便于心跳消费者下一轮汇总「新增 N 条邮件草稿待确认」。
 *  - subject 与 body 至少一个非空（trim）；其它字段都可空。
 */
export async function appendMailDraft(
  agentId: string,
  input: {
    subject?: string;
    body?: string;
    toAddress?: string;
    toName?: string;
    reason?: string;
    source: string;
    sourceEventIds?: string[];
  },
): Promise<XingyePendingMailDraft> {
  const aid = assertAgentId(agentId, '保存邮件草稿');
  const subject = (typeof input.subject === 'string' ? input.subject.trim() : '').slice(0, 200);
  const body = (typeof input.body === 'string' ? input.body : '').slice(0, 8000);
  if (!subject && !body.trim()) {
    throw new Error('草稿主题与正文不能同时为空。');
  }
  const source = input.source.trim();
  if (!source) throw new Error('草稿来源 (source) 不能为空。');
  const toAddress = normalizeOptionalText(input.toAddress, 160);
  const toName = normalizeOptionalText(input.toName, 80);
  const reason = normalizeOptionalText(input.reason, 1000);
  const sourceEventIds = Array.isArray(input.sourceEventIds)
    ? input.sourceEventIds.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : undefined;
  const id = newMailDraftId();
  const createdAt = new Date().toISOString();
  const row: XingyePendingMailDraft & { key: string } = {
    id,
    key: id,
    subject,
    body,
    toAddress,
    toName,
    createdAt,
    reason,
    source,
    sourceEventIds,
  };
  await backend.appendJsonl(aid, XINGYE_MAIL_DRAFTS_JSONL, row);
  await appendMailEventBestEffort(aid, {
    type: 'mail.draft_proposed',
    source,
    subjectId: id,
    payload: {
      draftId: id,
      subject: subject || null,
      hasBody: Boolean(body.trim()),
      toAddress: toAddress ?? null,
      reason: reason ?? null,
      sourceEventIds: sourceEventIds ?? [],
    },
  });
  return { id, subject, body, toAddress, toName, createdAt, reason, source, sourceEventIds };
}

export async function discardMailDraft(agentId: string, draftId: string): Promise<boolean> {
  const aid = assertAgentId(agentId, '丢弃邮件草稿');
  const did = draftId.trim();
  if (!did) throw new Error('丢弃草稿失败：缺少草稿 id。');
  const deleted = await backend.deleteJsonlRecord(aid, XINGYE_MAIL_DRAFTS_JSONL, did);
  if (deleted) {
    await appendMailEventBestEffort(aid, {
      type: 'mail.draft_discarded',
      source: 'xingye-mail-store',
      subjectId: did,
      payload: { draftId: did },
    });
  }
  return deleted;
}

/** Confirmed-from-draft message 用确定性 id：让 confirm retry 走幂等查重路径。 */
function mailMessageIdFromDraftId(draftId: string): string {
  return `from-draft-${draftId}`;
}

/**
 * 用户在「待确认草稿」区点「确认生成」时调用：
 *   1. message id 用 `from-draft-${draftId}`；先 list messages 查重，发现已有
 *      同 id 的 message（说明上一次 confirm 写完但 delete draft 失败）→ 复用，
 *      跳过 appendMailMessage；
 *   2. 否则 appendMailMessage 写入 messages.jsonl（mailbox='drafts'，
 *      from.kind='agent'，发 mail.messages_appended）；
 *   3. 从 apps/mail/drafts.jsonl 删掉；删除失败仅 warn——重试时 (1) 兜底防重；
 *   4. 发 mail.draft_confirmed。
 *
 * profile 由调用方传入——巡检产出的草稿默认用 agent 自身邮箱地址当 from。
 * 如果 agent 还没初始化 mail profile，UI 应先 ensureMailProfile 再确认。
 *
 * 进程内 per-draft 锁防止 UI 双击/多窗口产生并发 confirm。
 */
export async function confirmMailDraft(
  agentId: string,
  draftId: string,
  profile: XingyeMailProfile,
  edits?: {
    subject?: string;
    body?: string;
    toAddress?: string | null;
    toName?: string | null;
  },
): Promise<XingyeMailMessage> {
  const aid = assertAgentId(agentId, '确认邮件草稿');
  const did = draftId.trim();
  if (!did) throw new Error('确认草稿失败：缺少草稿 id。');
  if (!profile || typeof profile.address !== 'string' || !profile.address.trim()) {
    throw new Error('确认草稿失败：未提供有效邮箱 profile（请先在邮箱主页初始化）。');
  }
  return withDraftConfirmLock(`mail::${aid}::${did}`, async () => {
    const expectedMessageId = mailMessageIdFromDraftId(did);
    const existingMessage = (await listMailMessages(aid)).find((m) => m.id === expectedMessageId);

    const draft = (await listMailDrafts(aid)).find((d) => d.id === did);
    if (!draft && !existingMessage) {
      throw new Error('确认草稿失败：草稿不存在或已被丢弃。');
    }

    let message: XingyeMailMessage;
    if (existingMessage) {
      message = existingMessage;
    } else if (draft) {
      const resolveOptional = (
        key: 'toAddress' | 'toName',
        max: number,
      ): string | undefined => {
        if (edits && Object.prototype.hasOwnProperty.call(edits, key)) {
          const v = edits[key];
          if (v === null) return undefined;
          if (typeof v === 'string') {
            const trimmed = v.trim();
            return trimmed ? trimmed.slice(0, max) : undefined;
          }
        }
        return draft[key];
      };
      const subject = ((edits?.subject ?? draft.subject) || '').trim().slice(0, 200);
      const body = (edits?.body ?? draft.body).slice(0, 8000);
      if (!subject && !body.trim()) {
        throw new Error('确认草稿失败：主题与正文不能同时为空。');
      }
      const toAddress = resolveOptional('toAddress', 160);
      const toName = resolveOptional('toName', 80);
      const to = toAddress ? [{ name: toName || toAddress, address: toAddress }] : [];
      message = await appendMailMessage(
        aid,
        {
          mailbox: 'drafts',
          from: { name: profile.displayName, address: profile.address, kind: 'agent' },
          to,
          subject,
          body,
          isRead: true,
          source: 'xingye-heartbeat-confirmed',
        },
        { id: expectedMessageId },
      );
    } else {
      throw new Error('确认草稿失败：草稿不存在或已被丢弃。');
    }

    try {
      await backend.deleteJsonlRecord(aid, XINGYE_MAIL_DRAFTS_JSONL, did);
    } catch (error) {
      console.warn('[xingye-mail-store] confirm draft: failed to delete draft after message append:', error);
    }
    await appendMailEventBestEffort(aid, {
      type: 'mail.draft_confirmed',
      source: 'xingye-mail-store',
      subjectId: did,
      payload: { draftId: did, messageId: message.id, mailbox: message.mailbox },
    });
    return message;
  });
}
