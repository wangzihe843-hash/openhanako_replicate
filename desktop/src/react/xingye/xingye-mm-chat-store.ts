import { postXingyeStorage } from './xingye-storage-api';
import { createAgentXingyeStorageBackend } from './xingye-storage-backend';

const backend = createAgentXingyeStorageBackend(postXingyeStorage);

/** 相对路径位于 HANA_HOME/agents/{agentId}/xingye/ 下 */
export const XINGYE_MM_CHAT_SESSIONS_JSON = 'mm-chat/sessions.json';

/** 与 server/routes/xingye-storage.js SAFE_AGENT_ID_RE 一致 */
const SAFE_AGENT_ID_RE = /^[A-Za-z0-9_-]{1,120}$/;

export type XingyeMmChatRole = 'ta' | 'ai';

export type XingyeMmChatTurn = {
  id: string;
  role: XingyeMmChatRole;
  text: string;
};

export type XingyeMmChatSession = {
  id: string;
  title: string;
  preview: string;
  messages: XingyeMmChatTurn[];
};

export type XingyeMmChatPersistedV1 = {
  version: 1;
  activeSessionId: string;
  sessions: XingyeMmChatSession[];
};

/** 与原先 PhoneMmChatApp 内嵌 mock 一致，用作首次落盘种子 */
export const XINGYE_MM_CHAT_DEFAULT_SEED_SESSIONS: XingyeMmChatSession[] = [
  {
    id: 's1',
    title: '今晚的安排',
    preview: 'AI：可以把目标拆成三步…',
    messages: [
      { id: 'm1', role: 'ta', text: '明天要交小组作业，我现在脑子很乱，帮我排个顺序。' },
      {
        id: 'm2',
        role: 'ai',
        text:
          '可以先把「必须交付」列出来，再估时间。\n'
          + '1) 确认题目与分工\n'
          + '2) 各自草稿\n'
          + '3) 合并与检查引用格式',
      },
      { id: 'm3', role: 'ta', text: '如果只有三小时呢？' },
      {
        id: 'm4',
        role: 'ai',
        text: '三小时就只做合并版：先写结论段，再补证据与图表占位，最后统一术语。',
      },
    ],
  },
  {
    id: 's2',
    title: '新建咨询',
    preview: '尚无消息',
    messages: [],
  },
];

export function cloneDefaultMmChatPersisted(): XingyeMmChatPersistedV1 {
  return {
    version: 1,
    activeSessionId: XINGYE_MM_CHAT_DEFAULT_SEED_SESSIONS[0]!.id,
    sessions: JSON.parse(JSON.stringify(XINGYE_MM_CHAT_DEFAULT_SEED_SESSIONS)) as XingyeMmChatSession[],
  };
}

function isMmChatRole(value: unknown): value is XingyeMmChatRole {
  return value === 'ta' || value === 'ai';
}

function normalizeTurn(value: unknown): XingyeMmChatTurn | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : '';
  const text = typeof raw.text === 'string' ? raw.text : '';
  if (!id || !isMmChatRole(raw.role)) return null;
  return { id, role: raw.role, text };
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
  return { id, title, preview, messages };
}

function normalizePersisted(value: unknown): XingyeMmChatPersistedV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1) return null;
  const activeSessionId = typeof raw.activeSessionId === 'string' && raw.activeSessionId.trim()
    ? raw.activeSessionId.trim()
    : '';
  const sessionsRaw = raw.sessions;
  if (!activeSessionId || !Array.isArray(sessionsRaw) || sessionsRaw.length === 0) return null;
  const sessions: XingyeMmChatSession[] = [];
  for (const s of sessionsRaw) {
    const sess = normalizeSession(s);
    if (sess) sessions.push(sess);
  }
  if (!sessions.length) return null;
  const ids = new Set(sessions.map((s) => s.id));
  if (!ids.has(activeSessionId)) return null;
  return { version: 1, activeSessionId, sessions };
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
  if (data.version !== 1 || !data.sessions.length) {
    throw new Error('保存失败：数据无效。');
  }
  const ids = new Set(data.sessions.map((s) => s.id));
  if (!ids.has(data.activeSessionId)) {
    throw new Error('保存失败：activeSessionId 与会话列表不一致。');
  }
  await backend.writeJson(aid, XINGYE_MM_CHAT_SESSIONS_JSON, data);
}
