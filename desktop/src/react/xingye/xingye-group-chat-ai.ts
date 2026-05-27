/**
 * xingye-group-chat-ai.ts — 调用模型生成一条群聊回复，或返回 skip。
 *
 * 复用 `POST /api/xingye/phone-generate`（kind: mm_chat 仍是 JSON 通道），
 * 但 prompt 完全独立，且明确要求只生成 reply 字段或返回 skip。
 *
 * 不在此处写回任何群聊文件，不更新 runs.jsonl —— 那些由 orchestrator 处理。
 */

import { hanaFetch } from '../hooks/use-hana-fetch';
import type { Agent } from '../types';
import type { XingyeRoleProfile } from './xingye-profile-store';
import {
  buildGroupChatReplyPrompt,
  normalizeGroupChatReplyAiResult,
  type GroupChatPromptMessage,
  type GroupChatReplyAiResult,
} from './xingye-group-chat-prompts';
import { resolveXingyeSpeakerUserName } from './xingye-speaker-context';
import {
  collectRecentContextForAgent,
  describeRecentContextForPrompt,
} from './xingye-recent-context';
import { getRelationshipState } from './xingye-state-store';
import { getXingyePersistenceStorage } from './xingye-persistence';
import { listLoreEntries, XINGYE_LORE_CATEGORY_LABELS } from './xingye-lore-store';
import { postXingyeStorage } from './xingye-storage-api';
import {
  buildXingyeLoreRuntimeQueryText,
  collectXingyeLoreRuntimeContext,
  formatXingyeLoreRuntimeContextBlock,
} from './xingye-lore-runtime-context';

export type GenerateGroupChatReplyParams = {
  agent: Agent;
  profile?: XingyeRoleProfile | null;
  channelId: string;
  channelName: string;
  channelDescription?: string;
  channelMembers: string[];
  recentMessages: GroupChatPromptMessage[];
  timeoutMs?: number;
};

function truncateChars(text: string, max: number): string {
  const t = text.trim();
  if (t.length > max) return `${t.slice(0, Math.max(0, max - 1))}…`;
  return t;
}

async function readLoreMemoryMarkdown(agentId: string): Promise<string | null> {
  const aid = agentId.trim();
  if (!aid) return null;
  try {
    const data = (await postXingyeStorage({
      action: 'read',
      agentId: aid,
      relativePath: 'lore-memory.md',
      binary: false,
    })) as { missing?: boolean; content?: unknown };
    if (data?.missing || typeof data?.content !== 'string') return null;
    let text = data.content.trim();
    text = text.replace(/^<!--[\s\S]*?-->\s*/m, '').trim();
    return text || null;
  } catch {
    return null;
  }
}

function buildStableLoreFromAlwaysEntries(agentId: string, maxChars: number): string {
  const storage = getXingyePersistenceStorage();
  const entries = listLoreEntries(agentId, storage).filter(
    (e) => e.enabled && e.visibility === 'canonical' && e.insertionMode === 'always',
  );
  if (!entries.length) return '';
  const lines: string[] = [];
  let used = 0;
  for (const e of entries) {
    const label = XINGYE_LORE_CATEGORY_LABELS[e.category] ?? e.category;
    const block = `- 《${e.title}》（${label}）\n${e.content.trim()}`;
    if (used + block.length > maxChars && lines.length > 0) break;
    lines.push(block);
    used += block.length + 2;
    if (used >= maxChars) break;
  }
  return lines.join('\n\n');
}

async function buildStableLoreBlock(agentId: string): Promise<string> {
  const fromFile = await readLoreMemoryMarkdown(agentId);
  if (fromFile && fromFile.trim()) return truncateChars(fromFile, 3200);
  return buildStableLoreFromAlwaysEntries(agentId, 2800).trim();
}

function formatRelationshipBlock(agentId: string): string {
  const storage = getXingyePersistenceStorage();
  const state = getRelationshipState(agentId, storage);
  if (!state) return '';
  return JSON.stringify(
    {
      mood: state.mood,
      relationshipLabel: state.relationshipLabel,
      stateSummary: state.stateSummary,
      lastReason: state.lastReason,
      affection: state.affection,
      trust: state.trust,
    },
    null,
    2,
  );
}

/**
 * 群聊「流式反重复锚点」：从最近窗口里抽出**当前 agent 自己**发过的最近 6–8 条短摘要，
 * 让模型在生成 reply 时不要复述自己刚说过的话。
 *
 * 设计取舍：
 * - 群聊不是卡片型生成（不像 news/journal/secret_space 那样一期一条），而是
 *   流式对话。"重复"的形态是「同一 agent 短时间内说类似的话」+「群里反复讨论同一个梗」。
 *   recentMessages 已经把全员近期发言喂给了模型，但模型容易把自己上一两轮的 reply
 *   再写一遍——这里专门抽 agent 自己的最近发言做反重复锚点。
 * - 不把别人的发言也纳入 anchor：那是「对话上下文」（已经在 history block 里），
 *   不是「我已经表达过的话」。混在一起会让指令含义模糊（变成"避免说任何重复的话"，
 *   在群聊场景里这会扼杀正常的接话）。
 * - 每条只取首 30 字 + 时间戳；prompt 端用 ANCHOR_PREFIX 包裹，无历史返回空串。
 *
 * 不接 store —— 群聊消息的真相是 `/api/channels/:id`，已经通过 recentMessages
 * 透传进来；这里只是从入参中抽样。
 */
const GROUP_CHAT_OWN_REPLY_ANCHOR_LIMIT = 8;
const GROUP_CHAT_OWN_REPLY_SNIPPET_CHARS = 30;

export function buildGroupChatOwnReplyContinuityAnchorBlock(args: {
  agentId: string;
  agentName: string;
  recentMessages: GroupChatPromptMessage[];
}): string {
  const aid = args.agentId.trim();
  const aname = args.agentName.trim() || aid;
  if (!aid) return '';
  if (!Array.isArray(args.recentMessages) || args.recentMessages.length === 0) return '';
  // 倒序遍历，挑出 sender === agentId 的最近 N 条；保持倒序展示（最近的在最上面）。
  const own: GroupChatPromptMessage[] = [];
  for (let i = args.recentMessages.length - 1; i >= 0 && own.length < GROUP_CHAT_OWN_REPLY_ANCHOR_LIMIT; i -= 1) {
    const m = args.recentMessages[i];
    if (!m) continue;
    if (m.sender === aid || m.sender === aname) own.push(m);
  }
  if (own.length === 0) return '';
  const lines: string[] = [
    `- 你（${aname}）在这条群聊里最近已经说过的几句（请避免再写几乎相同的话；让对话向前推进，不要原地打转）:`,
  ];
  for (const m of own) {
    const snippet = (m.body ?? '').trim().replace(/\s+/g, ' ').slice(0, GROUP_CHAT_OWN_REPLY_SNIPPET_CHARS);
    if (!snippet) continue;
    lines.push(`  · [${m.timestamp}] ${snippet}`);
  }
  return lines.join('\n');
}

function profilePartsForQuery(profile: XingyeRoleProfile | null | undefined): string[] {
  if (!profile) return [];
  return [
    profile.displayName ?? '',
    profile.shortBio ?? '',
    profile.identitySummary ?? '',
    profile.backgroundSummary ?? '',
    profile.personalitySummary ?? '',
    profile.relationshipLabel ?? '',
    profile.values ?? '',
    profile.taboos ?? '',
    profile.relationshipMode ?? '',
  ].map((s) => s.trim()).filter(Boolean);
}

async function postPhoneGenerate(params: {
  agent: Agent;
  prompt: string;
  timeoutMs: number;
}): Promise<unknown> {
  const response = await hanaFetch('/api/xingye/phone-generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    timeout: params.timeoutMs,
    body: JSON.stringify({
      kind: 'mm_chat',
      ownerAgentId: params.agent.id,
      agentId: params.agent.id,
      prompt: params.prompt,
      timeoutMs: params.timeoutMs,
      mmChatMode: 'xingye_group_chat_reply',
    }),
  });
  let data: { ok?: boolean; error?: string; result?: unknown; details?: unknown };
  try {
    data = await response.json();
  } catch {
    throw new Error('解析服务器响应失败');
  }
  if (!response.ok || data?.ok === false || data?.error) {
    const details = Array.isArray(data?.details)
      ? `：${(data.details as { message?: string }[])
          .map((item) => item.message ?? '')
          .join('；')}`
      : '';
    throw new Error(`${data?.error || '模型调用失败'}${details}`);
  }
  return data?.result;
}

export async function generateGroupChatReplyWithAI(
  params: GenerateGroupChatReplyParams,
): Promise<GroupChatReplyAiResult> {
  const { agent, profile } = params;
  const timeoutMs = params.timeoutMs ?? 90_000;

  const userName = await resolveXingyeSpeakerUserName();
  const recentContext = collectRecentContextForAgent({ agentId: agent.id });
  const recentSceneBlock = describeRecentContextForPrompt(recentContext);
  const relationshipBlock = formatRelationshipBlock(agent.id);
  const stableLoreBlock = await buildStableLoreBlock(agent.id);

  const queryText = buildXingyeLoreRuntimeQueryText([
    ...profilePartsForQuery(profile ?? null),
    recentContext.summaryText,
    relationshipBlock,
    stableLoreBlock.slice(0, 2000),
    ...params.recentMessages.slice(-6).map((m) => m.body),
  ]);

  const keywordCtx = collectXingyeLoreRuntimeContext(agent.id, {
    purpose: 'mm_chat',
    queryText,
    maxChars: 2000,
    includeAlways: false,
    includeKeyword: true,
  });
  const keywordLoreBlock = formatXingyeLoreRuntimeContextBlock(keywordCtx);

  const ownReplyAnchorBlock = buildGroupChatOwnReplyContinuityAnchorBlock({
    agentId: agent.id,
    agentName: profile?.displayName ?? agent.name,
    recentMessages: params.recentMessages,
  });

  const prompt = buildGroupChatReplyPrompt({
    agent,
    profile,
    userName,
    channelId: params.channelId,
    channelName: params.channelName,
    channelDescription: params.channelDescription,
    channelMembers: params.channelMembers,
    recentMessages: params.recentMessages,
    recentSceneBlock,
    stableLoreBlock,
    keywordLoreBlock,
    relationshipBlock,
    ownReplyAnchorBlock,
  });

  const result = await postPhoneGenerate({ agent, prompt, timeoutMs });
  const normalized = normalizeGroupChatReplyAiResult(result);
  if (!normalized) {
    throw new Error('模型返回无效：缺少 decision/reply 字段或 JSON 解析失败');
  }
  return normalized;
}
