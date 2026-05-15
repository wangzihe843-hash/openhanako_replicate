/**
 * xingye-group-chat-orchestrator.ts — 星野群聊「手动提醒直接回复」MVP 的编排器。
 *
 * 单次手动触发的流程：
 *  1. 通过 `/api/channels/:id` 读取群聊近期消息与成员列表。
 *  2. 校验当前 agent 是该频道成员。
 *  3. 用最新一条消息（按消息列表顺序）构造 dedupeKey：
 *       `${agentId}::${channelId}::${latestMessageId}`
 *     —— 若该 dedupeKey 已存在历史 run，直接返回历史结果，避免重复触发。
 *  4. 若最后一条消息是当前 agent 自己发的，直接 skip。
 *  5. 调用 `generateGroupChatReplyWithAI` 让模型判断：reply / skip。
 *  6. 若 reply：通过 `POST /api/xingye/group-chat/post-as-agent` 写回，
 *     一次手动触发最多写回一条消息。
 *  7. 无论 reply / skip / error，都通过 runs.jsonl 落盘记录，以便防重复。
 *
 * 显式禁止：
 * - 不调用 channel-router 的 triggerImmediate，因此不会触发其他 agent 自动抢答；
 * - 不轮询，不计时器，不写 heartbeat 自动巡检；
 * - 不模拟 user 发言；
 * - 不一次写多条消息。
 */

import { hanaFetch } from '../hooks/use-hana-fetch';
import type { Agent, ChannelMessage } from '../types';
import { generateGroupChatReplyWithAI } from './xingye-group-chat-ai';
import {
  appendGroupChatRun,
  buildChannelMessageId,
  findGroupChatRunByDedupeKey,
  makeGroupChatDedupeKey,
  type XingyeGroupChatRun,
} from './xingye-group-chat-state-store';
import { readXingyeRoleProfile } from './xingye-profile-store';

const RECENT_WINDOW = 20;

export type TriggerGroupChatReplyParams = {
  agent: Agent;
  channelId: string;
  timeoutMs?: number;
};

export type FetchedChannel = {
  id: string;
  name: string;
  description: string;
  members: string[];
  messages: ChannelMessage[];
};

export type TriggerGroupChatReplyOutcome =
  | {
      status: 'replied';
      run: XingyeGroupChatRun;
      channel: FetchedChannel;
      reply: { sender: string; timestamp: string; body: string };
    }
  | {
      status: 'skipped';
      run: XingyeGroupChatRun;
      channel: FetchedChannel;
      reason?: string;
    }
  | {
      status: 'noop';
      reason: string;
      channel: FetchedChannel;
      /** dedupe 命中时回传历史 run（不会写入新 run）。 */
      previousRun: XingyeGroupChatRun;
    }
  | {
      status: 'error';
      error: string;
      run?: XingyeGroupChatRun;
      channel?: FetchedChannel;
    };

async function fetchChannel(channelId: string): Promise<FetchedChannel> {
  const res = await hanaFetch(`/api/channels/${encodeURIComponent(channelId)}`);
  const data = (await res.json().catch(() => ({}))) as {
    id?: string;
    name?: string;
    description?: string;
    members?: unknown;
    messages?: unknown;
    error?: string;
  };
  if (!res.ok) {
    throw new Error(data?.error || `读取群聊失败: HTTP ${res.status}`);
  }
  const members = Array.isArray(data.members)
    ? data.members.filter((m): m is string => typeof m === 'string')
    : [];
  const rawMessages = Array.isArray(data.messages) ? data.messages : [];
  const messages: ChannelMessage[] = [];
  for (const item of rawMessages) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const sender = typeof obj.sender === 'string' ? obj.sender : '';
    const timestamp = typeof obj.timestamp === 'string' ? obj.timestamp : '';
    const body = typeof obj.body === 'string' ? obj.body : '';
    if (sender && timestamp && body) {
      messages.push({ sender, timestamp, body });
    }
  }
  return {
    id: data.id || channelId,
    name: data.name || channelId,
    description: data.description || '',
    members,
    messages,
  };
}

async function postAsAgent(params: {
  channelId: string;
  agentId: string;
  body: string;
}): Promise<{ timestamp: string }> {
  const res = await hanaFetch('/api/xingye/group-chat/post-as-agent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      channelId: params.channelId,
      agentId: params.agentId,
      body: params.body,
    }),
  });
  const data = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    timestamp?: string;
    error?: string;
  };
  if (!res.ok || data.ok === false || !data.timestamp) {
    throw new Error(data?.error || `写回群聊失败: HTTP ${res.status}`);
  }
  return { timestamp: data.timestamp };
}

function recentMessagesForPrompt(messages: ChannelMessage[]): ChannelMessage[] {
  if (messages.length <= RECENT_WINDOW) return messages;
  return messages.slice(messages.length - RECENT_WINDOW);
}

export async function triggerGroupChatReply(
  params: TriggerGroupChatReplyParams,
): Promise<TriggerGroupChatReplyOutcome> {
  const { agent } = params;
  const channelId = String(params.channelId ?? '').trim();
  if (!agent?.id) {
    return { status: 'error', error: '当前 agent 无效' };
  }
  if (!channelId) {
    return { status: 'error', error: '缺少 channelId' };
  }

  let channel: FetchedChannel;
  try {
    channel = await fetchChannel(channelId);
  } catch (err) {
    return {
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    };
  }

  if (!channel.members.includes(agent.id)) {
    return {
      status: 'error',
      error: '当前 agent 不在频道成员列表，无法回复',
      channel,
    };
  }

  const recent = recentMessagesForPrompt(channel.messages);
  const latest = recent.length ? recent[recent.length - 1] : null;
  const latestMessageId = latest ? buildChannelMessageId(latest) : '';
  const sourceMessageIds = recent.map((m) => buildChannelMessageId(m));

  const dedupeKey = makeGroupChatDedupeKey({
    agentId: agent.id,
    channelId,
    latestMessageId,
  });

  const existing = await findGroupChatRunByDedupeKey(agent.id, dedupeKey);
  if (existing) {
    return {
      status: 'noop',
      reason: existing.status === 'replied'
        ? '同一最新消息已回复过，跳过避免刷屏'
        : '同一最新消息此前已处理过，跳过',
      channel,
      previousRun: existing,
    };
  }

  if (latest && latest.sender === agent.id) {
    const run = await safeAppendRun({
      agentId: agent.id,
      channelId,
      sourceMessageIds,
      latestMessageId,
      status: 'skipped',
      reason: '最新一条消息是当前 agent 自己刚发的，不再追发',
    });
    return {
      status: 'skipped',
      run,
      channel,
      reason: run.reason,
    };
  }

  let aiResult;
  try {
    const profile = await readXingyeRoleProfile(agent.id);
    aiResult = await generateGroupChatReplyWithAI({
      agent,
      profile,
      channelId,
      channelName: channel.name,
      channelDescription: channel.description,
      channelMembers: channel.members,
      recentMessages: recent,
      timeoutMs: params.timeoutMs,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const run = await safeAppendRun({
      agentId: agent.id,
      channelId,
      sourceMessageIds,
      latestMessageId,
      status: 'error',
      reason: message,
    });
    return { status: 'error', error: message, run, channel };
  }

  if (aiResult.decision === 'skip') {
    const run = await safeAppendRun({
      agentId: agent.id,
      channelId,
      sourceMessageIds,
      latestMessageId,
      status: 'skipped',
      reason: aiResult.reason || 'AI 判断当前无需回复',
    });
    return { status: 'skipped', run, channel, reason: run.reason };
  }

  // decision = reply
  let replyTimestamp: string;
  try {
    const posted = await postAsAgent({
      channelId,
      agentId: agent.id,
      body: aiResult.reply,
    });
    replyTimestamp = posted.timestamp;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const run = await safeAppendRun({
      agentId: agent.id,
      channelId,
      sourceMessageIds,
      latestMessageId,
      status: 'error',
      reason: `写回群聊失败：${message}`,
      replyContent: aiResult.reply,
    });
    return { status: 'error', error: message, run, channel };
  }

  const run = await safeAppendRun({
    agentId: agent.id,
    channelId,
    sourceMessageIds,
    latestMessageId,
    status: 'replied',
    replyMessageId: buildChannelMessageId({
      sender: agent.id,
      timestamp: replyTimestamp,
    }),
    replyContent: aiResult.reply,
    reason: aiResult.reason,
  });

  return {
    status: 'replied',
    run,
    channel,
    reply: {
      sender: agent.id,
      timestamp: replyTimestamp,
      body: aiResult.reply,
    },
  };
}

type SafeAppendRunInput = Parameters<typeof appendGroupChatRun>[0];

async function safeAppendRun(input: SafeAppendRunInput): Promise<XingyeGroupChatRun> {
  return appendGroupChatRun(input);
}
