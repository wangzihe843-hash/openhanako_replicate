import { postXingyeStorage } from './xingye-storage-api';
import { createAgentXingyeStorageBackend } from './xingye-storage-backend';

const backend = createAgentXingyeStorageBackend(postXingyeStorage);

/** 相对路径位于 HANA_HOME/agents/{agentId}/xingye/ 下 */
export const XINGYE_MAIL_PROFILE_JSON = 'apps/mail/profile.json';
export const XINGYE_MAIL_MESSAGES_JSONL = 'apps/mail/messages.jsonl';

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

export async function appendMailMessage(
  agentId: string,
  draft: XingyeMailMessageDraft,
): Promise<XingyeMailMessage> {
  const aid = assertAgentId(agentId, '保存邮件');
  const nowIso = new Date().toISOString();
  const message = buildMessage(aid, draft, nowIso);
  await backend.appendJsonl(aid, XINGYE_MAIL_MESSAGES_JSONL, message);
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
  return backend.deleteJsonlRecord(aid, XINGYE_MAIL_MESSAGES_JSONL, mid);
}
