import { postXingyeStorage } from './xingye-storage-api';
import { createAgentXingyeStorageBackend } from './xingye-storage-backend';
import { appendXingyeEvent, type XingyeEventInput } from './xingye-event-log';

const backend = createAgentXingyeStorageBackend(postXingyeStorage);

async function appendMmChatEventBestEffort(
  agentId: string,
  input: Omit<XingyeEventInput, 'agentId'>,
): Promise<void> {
  try {
    await appendXingyeEvent(agentId, input);
  } catch (error) {
    console.warn('[xingye-mm-chat-store] event log append failed:', error);
  }
}

/** 相对路径位于 HANA_HOME/agents/{agentId}/xingye/ 下 */
export const XINGYE_MM_CHAT_SESSIONS_JSON = 'mm-chat/sessions.json';

/** 与 server/routes/xingye-storage.js SAFE_AGENT_ID_RE 一致 */
const SAFE_AGENT_ID_RE = /^[A-Za-z0-9_-]{1,120}$/;

export type XingyeMmChatRole = 'ta' | 'ai';

/** 追问轮次可选：保留用户填写的「追问方向」短提示，不展示为角色提问正文。 */
export type XingyeMmChatTurnMeta = {
  followUpUserHint?: string;
};

export type XingyeMmChatTurn = {
  id: string;
  role: XingyeMmChatRole;
  text: string;
  createdAt?: string;
  meta?: XingyeMmChatTurnMeta;
};

export type XingyeMmChatSession = {
  id: string;
  title: string;
  preview: string;
  messages: XingyeMmChatTurn[];
  createdAt?: string;
  updatedAt?: string;
};

export type XingyeMmChatPersistedV1 = {
  version: 1;
  /** 空字符串表示未选中会话（列表态）；非空时应对应 `sessions` 中某条 id（兼容旧数据）。 */
  activeSessionId: string;
  sessions: XingyeMmChatSession[];
  /**
   * 仅在「首次打开 MM Chat」自动触发的 backlog 初始化成功后写入。
   * 之后即使删光 sessions 也不会再触发初始化——避免"删光后又被自动重灌"，
   * 与 accounting/shopping/secondhand 的 initializedAt 同义（只是这边不复用
   * history-state.json，因为 MM Chat 是 sessions.json 单文件、gap-fill 概念用不上）。
   */
  initializedAt?: string;
};

function newSessionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `s-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/** 新 agent 或无落盘文件时的空壳（不再写入 mock 示例会话）。 */
export function createEmptyMmChatPersisted(): XingyeMmChatPersistedV1 {
  return { version: 1, activeSessionId: '', sessions: [] };
}

/** @deprecated 使用 createEmptyMmChatPersisted；历史命名保留，行为与空壳一致。 */
export function cloneDefaultMmChatPersisted(): XingyeMmChatPersistedV1 {
  return createEmptyMmChatPersisted();
}

function isIsoLike(value: string): boolean {
  const t = Date.parse(value);
  return Number.isFinite(t);
}

function normalizeRole(value: unknown): XingyeMmChatRole | null {
  if (value === 'ta' || value === 'agent') return 'ta';
  if (value === 'ai' || value === 'assistant') return 'ai';
  return null;
}

function normalizeTurnMeta(value: unknown): XingyeMmChatTurnMeta | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const hint = raw.followUpUserHint;
  if (typeof hint !== 'string' || !hint.trim()) return undefined;
  return { followUpUserHint: hint.trim().slice(0, 800) };
}

function normalizeTurn(value: unknown): XingyeMmChatTurn | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : '';
  const textRaw = typeof raw.text === 'string' ? raw.text : (typeof raw.content === 'string' ? raw.content : '');
  const text = textRaw;
  const role = normalizeRole(raw.role);
  if (!id || !role || !String(text).trim()) return null;
  const createdAt = typeof raw.createdAt === 'string' && raw.createdAt.trim() && isIsoLike(raw.createdAt.trim())
    ? raw.createdAt.trim()
    : undefined;
  const meta = normalizeTurnMeta(raw.meta);
  return { id, role, text, createdAt, ...(meta ? { meta } : {}) };
}

function fillSessionDefaults(sess: XingyeMmChatSession): XingyeMmChatSession {
  const firstMsgAt = sess.messages.find((m) => m.createdAt)?.createdAt;
  const createdAt = sess.createdAt && isIsoLike(sess.createdAt) ? sess.createdAt : (firstMsgAt ?? undefined);
  const updatedAt = sess.updatedAt && isIsoLike(sess.updatedAt) ? sess.updatedAt : (firstMsgAt ?? createdAt ?? undefined);
  return { ...sess, createdAt, updatedAt };
}

function normalizeSession(value: unknown): XingyeMmChatSession | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : '';
  const title = typeof raw.title === 'string' ? raw.title : '';
  const preview = typeof raw.preview === 'string' ? raw.preview : '';
  if (!id) return null;
  const messagesRaw = raw.messages;
  const messages: XingyeMmChatTurn[] = [];
  if (Array.isArray(messagesRaw)) {
    for (const m of messagesRaw) {
      const t = normalizeTurn(m);
      if (t) messages.push(t);
    }
  }
  const createdAt = typeof raw.createdAt === 'string' && raw.createdAt.trim() ? raw.createdAt.trim() : undefined;
  const updatedAt = typeof raw.updatedAt === 'string' && raw.updatedAt.trim() ? raw.updatedAt.trim() : undefined;
  return fillSessionDefaults({ id, title, preview, messages, createdAt, updatedAt });
}

function normalizePersisted(value: unknown): XingyeMmChatPersistedV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1) return null;
  const activeRaw = typeof raw.activeSessionId === 'string' ? raw.activeSessionId.trim() : '';
  const sessionsRaw = raw.sessions;
  if (!Array.isArray(sessionsRaw)) return null;
  const sessions: XingyeMmChatSession[] = [];
  for (const s of sessionsRaw) {
    const sess = normalizeSession(s);
    if (sess) sessions.push(sess);
  }
  const initializedAtRaw = typeof raw.initializedAt === 'string' ? raw.initializedAt.trim() : '';
  const initializedAt = initializedAtRaw && isIsoLike(initializedAtRaw) ? initializedAtRaw : undefined;
  if (sessions.length === 0) {
    return { version: 1, activeSessionId: '', sessions: [], ...(initializedAt ? { initializedAt } : {}) };
  }
  const ids = new Set(sessions.map((s) => s.id));
  let activeSessionId = activeRaw;
  if (!activeSessionId || !ids.has(activeSessionId)) {
    activeSessionId = '';
  }
  return { version: 1, activeSessionId, sessions, ...(initializedAt ? { initializedAt } : {}) };
}

export function sortMmChatSessionsByUpdatedAtDesc(sessions: XingyeMmChatSession[]): XingyeMmChatSession[] {
  return [...sessions].sort((a, b) => {
    const ta = Date.parse(a.updatedAt ?? a.createdAt ?? '') || 0;
    const tb = Date.parse(b.updatedAt ?? b.createdAt ?? '') || 0;
    return tb - ta;
  });
}

export async function readMmChatPersistence(agentId: string): Promise<XingyeMmChatPersistedV1 | null> {
  const aid = agentId.trim();
  if (!aid) return null;
  try {
    const raw = await backend.readJson<unknown>(aid, XINGYE_MM_CHAT_SESSIONS_JSON);
    return normalizePersisted(raw);
  } catch {
    return null;
  }
}

export async function saveMmChatPersistence(agentId: string, data: XingyeMmChatPersistedV1): Promise<void> {
  const aid = agentId.trim();
  if (!aid) {
    throw new Error('保存失败：缺少 agentId。');
  }
  if (!SAFE_AGENT_ID_RE.test(aid)) {
    throw new Error('保存失败：agentId 格式无效（仅允许字母、数字、下划线与短横线，长度 1–120）。');
  }
  if (data.version !== 1 || !Array.isArray(data.sessions)) {
    throw new Error('保存失败：数据无效。');
  }
  if (data.sessions.length === 0) {
    if (data.activeSessionId !== '') {
      throw new Error('保存失败：无会话时 activeSessionId 应为空字符串。');
    }
  } else {
    const ids = new Set(data.sessions.map((s) => s.id));
    if (data.activeSessionId && !ids.has(data.activeSessionId)) {
      throw new Error('保存失败：activeSessionId 与会话列表不一致。');
    }
  }
  await backend.writeJson(aid, XINGYE_MM_CHAT_SESSIONS_JSON, data);
}

export async function listMmChatSessions(agentId: string): Promise<XingyeMmChatSession[]> {
  const row = await readMmChatPersistence(agentId);
  return sortMmChatSessionsByUpdatedAtDesc(row?.sessions ?? []);
}

export async function getMmChatSession(agentId: string, sessionId: string): Promise<XingyeMmChatSession | null> {
  const sid = sessionId.trim();
  if (!sid) return null;
  const row = await readMmChatPersistence(agentId);
  return row?.sessions.find((s) => s.id === sid) ?? null;
}

export async function createMmChatSession(
  agentId: string,
  draft: { title: string; preview: string; messages: XingyeMmChatTurn[] },
): Promise<XingyeMmChatSession> {
  const aid = agentId.trim();
  if (!aid || !SAFE_AGENT_ID_RE.test(aid)) {
    throw new Error('创建失败：agentId 无效。');
  }
  const existing = (await readMmChatPersistence(aid)) ?? createEmptyMmChatPersisted();
  const now = new Date().toISOString();
  const id = newSessionId();
  const messages = draft.messages.map((m) => ({
    ...m,
    createdAt: m.createdAt && isIsoLike(m.createdAt) ? m.createdAt : now,
  }));
  const session: XingyeMmChatSession = {
    id,
    title: draft.title.trim().slice(0, 200) || '咨询',
    preview: draft.preview.trim() || '尚无消息',
    messages,
    createdAt: now,
    updatedAt: now,
  };
  const sessions = [...existing.sessions, session];
  await saveMmChatPersistence(aid, {
    version: 1,
    activeSessionId: '',
    sessions,
    ...(existing.initializedAt ? { initializedAt: existing.initializedAt } : {}),
  });
  return session;
}

export async function deleteMmChatSession(agentId: string, sessionId: string): Promise<void> {
  const aid = agentId.trim();
  const sid = sessionId.trim();
  if (!aid || !sid || !SAFE_AGENT_ID_RE.test(aid)) {
    throw new Error('删除失败：参数无效。');
  }
  const existing = await readMmChatPersistence(aid);
  if (!existing) return;
  const sessions = existing.sessions.filter((s) => s.id !== sid);
  let activeSessionId = existing.activeSessionId;
  if (activeSessionId === sid) activeSessionId = '';
  const preserveInit = existing.initializedAt ? { initializedAt: existing.initializedAt } : {};
  if (sessions.length === 0) {
    // 即便用户删光，也保留 initializedAt——防止删光 → 自动重新 bootstrap 灌入。
    await saveMmChatPersistence(aid, { version: 1, activeSessionId: '', sessions: [], ...preserveInit });
    return;
  }
  const ids = new Set(sessions.map((s) => s.id));
  if (activeSessionId && !ids.has(activeSessionId)) activeSessionId = '';
  await saveMmChatPersistence(aid, { version: 1, activeSessionId, sessions, ...preserveInit });
}

/**
 * 向既有会话追加若干条消息并更新 `updatedAt` / 列表预览。
 */
export async function appendMmChatTurnsToSession(
  agentId: string,
  sessionId: string,
  newTurns: XingyeMmChatTurn[],
  opts?: { preview?: string },
): Promise<XingyeMmChatSession | null> {
  const aid = agentId.trim();
  const sid = sessionId.trim();
  if (!aid || !sid || !SAFE_AGENT_ID_RE.test(aid)) {
    throw new Error('追加失败：参数无效。');
  }
  if (!newTurns.length) {
    throw new Error('追加失败：没有新消息。');
  }
  const row = await readMmChatPersistence(aid);
  if (!row) return null;
  const idx = row.sessions.findIndex((s) => s.id === sid);
  if (idx < 0) return null;
  const now = new Date().toISOString();
  const sess = row.sessions[idx];
  const normalized = newTurns.map((m) => ({
    ...m,
    createdAt: m.createdAt && isIsoLike(m.createdAt) ? m.createdAt : now,
  }));
  const mergedMessages = [...sess.messages, ...normalized];
  let preview = opts?.preview?.trim();
  if (!preview) {
    for (let i = mergedMessages.length - 1; i >= 0; i -= 1) {
      const t = String(mergedMessages[i]?.text ?? '').replace(/\s+/g, ' ').trim();
      if (t) {
        preview = t.length > 48 ? `${t.slice(0, 47)}…` : t;
        break;
      }
    }
  }
  if (!preview) preview = '尚无消息';
  const updated: XingyeMmChatSession = {
    ...sess,
    messages: mergedMessages,
    preview,
    updatedAt: now,
  };
  const sessions = [...row.sessions];
  sessions[idx] = updated;
  await saveMmChatPersistence(aid, {
    version: 1,
    activeSessionId: row.activeSessionId,
    sessions,
    ...(row.initializedAt ? { initializedAt: row.initializedAt } : {}),
  });
  await appendMmChatEventBestEffort(aid, {
    type: 'mm_chat.turns_appended',
    source: 'xingye-mm-chat-store',
    subjectId: sid,
    payload: {
      sessionId: sid,
      count: normalized.length,
      lastRole: normalized[normalized.length - 1]?.role,
    },
  });
  return updated;
}

/** 别名：与需求文档 `listSessions` / `getSession` / `createSession` / `deleteSession` 对齐 */
export const listSessions = listMmChatSessions;
export const getSession = getMmChatSession;
export const createSession = createMmChatSession;
export const deleteSession = deleteMmChatSession;
