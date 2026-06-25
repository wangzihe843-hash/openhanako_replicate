/**
 * xingye-recent-context.ts — 收集"当前角色最近一次 OpenHanako 聊天"的精简摘要
 *
 * 用于「更新联系人 / 回滚上次并更新」的 AI prompt。
 * 只读：从 useStore 当前 in-memory chatSessions 缓存里取。
 * 不会触发 loadMessages、不会修改 OpenHanako 任何原生 store。
 *
 * 如果当前角色尚未在 OpenHanako 聊天 tab 打开过（或缓存已被 LRU 淘汰），
 * 返回空 context 并在 sourceNotes 里说明，调用方据此显示提示。
 */

import { useStore } from '../stores';
import { sessionScopedValue } from '../stores/session-slice';
import type { ChatListItem, ChatMessage, ContentBlock } from '../stores/chat-types';
import type { Session } from '../types';

export type XingyeRecentMessageRole = 'user' | 'assistant' | 'system' | 'unknown';

export interface XingyeRecentMessage {
  role: XingyeRecentMessageRole;
  content: string;
  createdAt?: string;
  source: 'openhanako_chat' | 'phone_sms' | 'manual';
}

export interface XingyeRecentContext {
  agentId: string;
  messages: XingyeRecentMessage[];
  summaryText: string;
  sourceNotes: string[];
  /** 提示 UI 是否成功读取到任何 OpenHanako 聊天内容 */
  hasOpenHanakoMessages: boolean;
}

interface CollectArgs {
  agentId: string | null | undefined;
  /** 单条 content 截断到的最大字符数（默认 500） */
  maxContentChars?: number;
  /** 取最近 N 条消息（默认 30） */
  maxMessages?: number;
  /** 总 summaryText 软上限字符数（默认 8000） */
  maxTotalChars?: number;
}

const DEFAULT_MAX_CONTENT_CHARS = 500;
const DEFAULT_MAX_MESSAGES = 30;
const DEFAULT_MAX_TOTAL_CHARS = 8_000;

/**
 * Strip HTML tags + decode common entities + collapse whitespace.
 * AssistantMessage 的 text 块以 rendered HTML (renderMarkdown) 形式存在；
 * 这里只是为了喂进 LLM prompt，做粗略清洗就够。
 */
function stripHtmlToPlain(html: string): string {
  if (!html) return '';
  // Drop <style>/<script>/<thead> noise & code fences markup, keep code body.
  const withoutTags = html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|pre|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  const decoded = withoutTags
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  return decoded.replace(/[\u00A0\t ]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function truncate(text: string, max: number): string {
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * 从 assistant 消息的 blocks 中抽出可读纯文本。
 * 跳过 thinking（链式推理私域）、工具调用、文件、附件、subagent 等富块。
 * 仅保留 text 块（HTML 反解为纯文本）和 mood 文案。
 */
function extractAssistantPlainText(msg: ChatMessage): string {
  const blocks: ContentBlock[] = Array.isArray(msg.blocks) ? msg.blocks : [];
  const parts: string[] = [];
  for (const block of blocks) {
    if (!block) continue;
    if (block.type === 'text') {
      const text = stripHtmlToPlain(block.html);
      if (text) parts.push(text);
    } else if (block.type === 'mood') {
      const text = (block.text || '').trim();
      if (text) parts.push(`（${text}）`);
    }
  }
  return parts.join('\n').trim();
}

function extractUserPlainText(msg: ChatMessage): string {
  const main = (msg.text || '').trim();
  const quoted = (msg.quotedText || '').trim();
  if (main && quoted) return `${quoted ? `引用：${quoted}\n` : ''}${main}`;
  return main || quoted;
}

function messageCreatedAt(msg: ChatMessage): string | undefined {
  if (typeof msg.timestamp === 'number' && Number.isFinite(msg.timestamp)) {
    try {
      return new Date(msg.timestamp).toISOString();
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function sessionModifiedTime(session: Session): number {
  const parsed = Date.parse(session.modified || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * 取该 agentId 下被 in-memory chatSessions 缓存的最新一条 session。
 * 不触发 loadMessages，不动 store。
 */
function pickCachedLatestSessionForAgent(agentId: string): {
  session: Session | null;
  reason: 'cached' | 'no_session' | 'not_cached';
  totalSessionsForAgent: number;
} {
  const state = useStore.getState();
  const sessionsForAgent = state.sessions
    .filter(session => session.agentId === agentId)
    .sort((a, b) => sessionModifiedTime(b) - sessionModifiedTime(a));
  if (sessionsForAgent.length === 0) {
    return { session: null, reason: 'no_session', totalSessionsForAgent: 0 };
  }
  for (const session of sessionsForAgent) {
    const cached = sessionScopedValue(state, state.chatSessions, session.path);
    if (cached && Array.isArray(cached.items) && cached.items.length > 0) {
      return { session, reason: 'cached', totalSessionsForAgent: sessionsForAgent.length };
    }
  }
  return { session: null, reason: 'not_cached', totalSessionsForAgent: sessionsForAgent.length };
}

function buildSummaryText(messages: XingyeRecentMessage[], maxTotalChars: number): string {
  if (messages.length === 0) return '';
  const lines: string[] = [];
  let used = 0;
  for (const msg of messages) {
    const rolePrefix = msg.role === 'user'
      ? '用户'
      : msg.role === 'assistant'
        ? '角色'
        : msg.role === 'system'
          ? '系统'
          : '未知';
    const line = `[${rolePrefix}] ${msg.content}`;
    if (used + line.length > maxTotalChars && lines.length > 0) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join('\n');
}

/**
 * 主接口：拿到当前 agent 的「最近聊天上下文」。
 * 永远不抛错；任何失败路径都返回空 context + 带说明的 sourceNotes，
 * 调用方据此把"未读到聊天"原样写进 prompt / UI 提示。
 */
export function collectRecentContextForAgent(args: CollectArgs): XingyeRecentContext {
  const maxContentChars = args.maxContentChars ?? DEFAULT_MAX_CONTENT_CHARS;
  const maxMessages = args.maxMessages ?? DEFAULT_MAX_MESSAGES;
  const maxTotalChars = args.maxTotalChars ?? DEFAULT_MAX_TOTAL_CHARS;
  const agentId = (args.agentId ?? '').trim();
  const empty: XingyeRecentContext = {
    agentId,
    messages: [],
    summaryText: '',
    sourceNotes: [],
    hasOpenHanakoMessages: false,
  };

  if (!agentId) {
    return { ...empty, sourceNotes: ['未指定 agentId，本次未读取最近聊天。'] };
  }

  let pick: ReturnType<typeof pickCachedLatestSessionForAgent>;
  try {
    pick = pickCachedLatestSessionForAgent(agentId);
  } catch (err) {
    return {
      ...empty,
      sourceNotes: [`读取 OpenHanako session 失败：${err instanceof Error ? err.message : String(err)}`],
    };
  }

  if (!pick.session) {
    if (pick.reason === 'no_session') {
      return {
        ...empty,
        sourceNotes: [
          '当前角色尚无 OpenHanako 会话记录，本次仅根据角色资料与通讯录更新。',
        ],
      };
    }
    return {
      ...empty,
      sourceNotes: [
        `检测到 ${pick.totalSessionsForAgent} 个会话，但消息缓存为空（可能尚未在「聊天」tab 打开本角色）。本次仅根据角色资料与通讯录更新。`,
      ],
    };
  }

  const latestState = useStore.getState();
  const cached = sessionScopedValue(latestState, latestState.chatSessions, pick.session.path);
  const items: ChatListItem[] = cached?.items ?? [];
  if (items.length === 0) {
    return {
      ...empty,
      sourceNotes: ['最近一次 OpenHanako 会话消息为空，本次仅根据角色资料与通讯录更新。'],
    };
  }

  // 倒序取最新 N 条 message-typed item，再正序还原
  const messageItems: ChatMessage[] = [];
  for (let i = items.length - 1; i >= 0 && messageItems.length < maxMessages; i -= 1) {
    const item = items[i];
    if (item.type !== 'message') continue;
    messageItems.push(item.data);
  }
  messageItems.reverse();

  const messages: XingyeRecentMessage[] = [];
  for (const msg of messageItems) {
    const content = msg.role === 'user'
      ? extractUserPlainText(msg)
      : extractAssistantPlainText(msg);
    if (!content) continue;
    messages.push({
      role: msg.role,
      content: truncate(content, maxContentChars),
      createdAt: messageCreatedAt(msg),
      source: 'openhanako_chat',
    });
  }

  const summaryText = buildSummaryText(messages, maxTotalChars);
  const sourceNotes: string[] = [];
  if (messages.length === 0) {
    sourceNotes.push('最近 OpenHanako 聊天没有可解析的文本内容（可能均为工具调用或附件），本次仅根据角色资料与通讯录更新。');
  } else {
    sourceNotes.push(
      `已从 OpenHanako 会话 ${pick.session.path} 读取最近 ${messages.length} 条文本消息。`,
    );
  }

  return {
    agentId,
    messages,
    summaryText,
    sourceNotes,
    hasOpenHanakoMessages: messages.length > 0,
  };
}

/**
 * 仅用于 prompt 拼接的紧凑视图：包含 summaryText 和必要时的 sourceNotes。
 * 避免把内部字段（agentId / source 标签）写到 LLM 看到的上下文里。
 */
export function describeRecentContextForPrompt(ctx: XingyeRecentContext): string {
  if (!ctx.hasOpenHanakoMessages) {
    return [
      '最近 OpenHanako 聊天上下文：（无）',
      ctx.sourceNotes.length ? `说明：${ctx.sourceNotes.join(' ')}` : '',
    ].filter(Boolean).join('\n');
  }
  return [
    '最近 OpenHanako 聊天（最旧→最新，仅供你参考最近发生的事，不要把这些内容当作短信复述）：',
    ctx.summaryText,
  ].join('\n');
}
