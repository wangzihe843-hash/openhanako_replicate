/**
 * xingye-group-chat-prompts.ts — 星野群聊「手动提醒直接回复」MVP 的 prompt 模板。
 *
 * 设计原则：
 * - 只允许当前 agent 写一条新的群聊发言，或明确返回不回复。
 * - 不允许模拟 user 发言、不允许模拟其他 agent 发言、不允许输出系统分析或元叙述。
 * - 不允许一次输出多条消息，不允许输出 JSON 数组。
 * - 群聊不是 MM Chat，也不是短信：不要写成一对一私聊或 AI 助手腔调。
 */

import type { Agent } from '../types';
import type { XingyeRoleProfile } from './xingye-profile-store';
import { formatXingyeSpeakerContextForPrompt } from './xingye-speaker-context';

export type GroupChatPromptMessage = {
  sender: string;
  timestamp: string;
  body: string;
};

export type BuildGroupChatReplyPromptArgs = {
  agent: Pick<Agent, 'id' | 'name' | 'yuan'>;
  profile?: XingyeRoleProfile | null;
  userName?: string;
  channelId: string;
  channelName: string;
  channelDescription?: string;
  channelMembers: string[];
  recentMessages: GroupChatPromptMessage[];
  recentSceneBlock?: string;
  stableLoreBlock?: string;
  keywordLoreBlock?: string;
  relationshipBlock?: string;
  /**
   * 流式反重复锚点：当前 agent 在本群聊最近自己说过的几句（由 buildGroupChatOwnReplyContinuityAnchorBlock 生成）。
   * 空串 → 渲染「（无；这是 TA 在本群第一次发言）」。
   *
   * 与 historyBlock 的关系：history 给的是「全员近期对话」（供承接话题），
   * 这里专门抽 agent 自己的发言做反重复——避免模型把上一两轮自己的话再说一遍。
   */
  ownReplyAnchorBlock?: string;
};

export type GroupChatReplyAiDecision = 'reply' | 'skip';

export type GroupChatReplyAiResult = {
  decision: GroupChatReplyAiDecision;
  reply: string;
  reason?: string;
};

const MAX_REPLY_CHARS = 600;
const MAX_REASON_CHARS = 280;

function clamp(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, Math.max(0, max - 1))}…`;
}

export function formatGroupChatHistoryForPrompt(args: {
  agentName: string;
  userName: string;
  messages: GroupChatPromptMessage[];
  maxChars?: number;
}): string {
  const { agentName, userName, messages } = args;
  const maxChars = args.maxChars ?? 6000;
  if (!messages.length) return '（群聊里还没有任何消息）';
  const lines = messages.map((msg) => {
    const sender = msg.sender || 'unknown';
    let tag = sender;
    if (sender === agentName) tag = `${sender}（你自己）`;
    else if (sender === userName) tag = `${sender}（user 本人）`;
    else if (sender === 'system') tag = `${sender}（频道系统消息）`;
    else tag = `${sender}（其他成员）`;
    return `[${tag} · ${msg.timestamp}]\n${msg.body.trim()}`;
  });
  const marker = '…（更早消息已省略）\n\n';
  let chosen = [...lines];
  let dropped = 0;
  while (chosen.join('\n\n').length > maxChars && chosen.length > 1) {
    chosen = chosen.slice(1);
    dropped += 1;
  }
  let joined = (dropped > 0 ? marker : '') + chosen.join('\n\n');
  if (joined.length > maxChars) {
    const only = chosen[0] ?? '';
    const budget = Math.max(120, maxChars - (dropped > 0 ? marker.length : 0));
    joined = (dropped > 0 ? marker : '') + (only.length > budget ? `${only.slice(0, budget)}…` : only);
  }
  return joined;
}

function safeText(value: string | undefined | null): string {
  return value?.trim() || '';
}

export function buildGroupChatReplyPrompt(args: BuildGroupChatReplyPromptArgs): string {
  const {
    agent,
    profile,
    channelId,
    channelName,
    channelDescription,
    channelMembers,
    recentMessages,
  } = args;

  const userName = safeText(args.userName) || 'user';
  const taMoniker = safeText(profile?.displayName) || agent.name;
  /*
   * 群聊豁免 gender 强约束：
   * 群聊中 currentAgent 写自己发言时，会频繁提及其他群员（其他 agent + user）；
   * 其他 agent 各有自己的 profile.json + gender，代词必须按各自性别。
   * 强约束「所有第三人称用 currentAgent 性别代词」会让 currentAgent 把其他群员
   * 也写成同性别。currentAgent 自己的性别仍通过下方 profile JSON 透传。
   */
  const speakerContextBlock = formatXingyeSpeakerContextForPrompt({
    userName,
    agentName: taMoniker,
  });

  const otherMembers = channelMembers.filter((m) => m !== agent.id);
  const memberLine = otherMembers.length
    ? `群聊成员（含你；除你外还有：${otherMembers.join('、')}）`
    : '群聊成员（仅你和 user）';

  const historyBlock = formatGroupChatHistoryForPrompt({
    agentName: agent.name,
    userName,
    messages: recentMessages,
    maxChars: 6000,
  });

  const recentSceneBlock = safeText(args.recentSceneBlock);
  const stableLoreBlock = safeText(args.stableLoreBlock);
  const keywordLoreBlock = safeText(args.keywordLoreBlock);
  const relationshipBlock = safeText(args.relationshipBlock);
  const ownReplyAnchorBlock = safeText(args.ownReplyAnchorBlock);

  const profileLines: string[] = [];
  if (profile) {
    const fields: [string, string | undefined][] = [
      ['displayName', profile.displayName],
      ['relationshipLabel', profile.relationshipLabel],
      ['speakingStyle', profile.speakingStyle],
      ['identitySummary', profile.identitySummary],
      ['backgroundSummary', profile.backgroundSummary],
      ['personalitySummary', profile.personalitySummary],
      ['behaviorLogic', profile.behaviorLogic],
      ['values', profile.values],
      ['taboos', profile.taboos],
      ['relationshipMode', profile.relationshipMode],
    ];
    for (const [k, v] of fields) {
      const t = safeText(v);
      if (t) profileLines.push(`- ${k}: ${t}`);
    }
  }
  const profileBlock = profileLines.length ? profileLines.join('\n') : '（无）';

  const parts: string[] = [
    '你是星野模式「群聊手动提醒回复」生成器：根据下面的群聊上下文，判断当前角色是否需要发言；如要发言，只产出一条新的群聊消息。',
    '只返回严格 JSON，不要 Markdown，不要解释，不要思考过程。',
    '',
    '【硬性规则】',
    '1. 你只能输出当前角色本人的一条新的群聊发言（写在 reply 字段）。',
    '2. 不要模拟 user 的发言；不要模拟其他成员（其他 agent / system）的发言；不要假装别人在说话。',
    '3. 不要一次输出多条消息；不要在同一段里串起两条独立发言；不要使用 JSON 数组。',
    '4. 不要在 reply 中出现"系统提示"、"用户要求"、"上下文"、"模型"、"OpenHanako"、"prompt"、"AI 助手"等元叙述。',
    '5. 不要照搬历史里别人说过的话；不要以"作为 AI"或"作为助手"自报家门。',
    '6. 群聊不是短信也不是 MM Chat：不要写成一对一私聊、也不要写成对通用助手提问。',
    '7. 回复要紧扣群聊「最近消息」的最后几条，承接当前话题；要符合当前角色 profile / 关系 / 口吻；语气保持自然。',
    '8. 如果最近消息中最后一条是当前角色自己刚发的，或者当前角色没有合适的话要说（例如全是 system 公告、内容与角色完全无关、用户没在向 TA 提问且无回应必要），返回 decision = "skip"。',
    '9. reply 长度建议不超过 200 字；最长不得超过 600 字。',
    '',
    '【说话人语境】',
    speakerContextBlock,
    '',
    `【你的 agent id】 ${agent.id}`,
    `【你的展示名】 ${taMoniker}`,
    '',
    '【当前角色 profile】',
    profileBlock,
    '',
    `【群聊信息】 channelId=${channelId} · 名称=${channelName || channelId}${channelDescription ? ` · 描述=${channelDescription}` : ''}`,
    memberLine,
    '',
    '【群聊最近消息（自上而下，时间从早到晚）】',
    historyBlock,
    '',
    '【你自己在本群最近说过的话（流式反重复锚点；请避免再写几乎相同的话，让对话向前推进）】',
    ownReplyAnchorBlock || '（无；这是 TA 在本群第一次发言）',
    '',
    '【最近发生的事（仅作 TA 的背景情绪参考，不要在 reply 中复述来源）】',
    recentSceneBlock || '（无）',
    '',
    '【当前对 user 的关系状态摘要（内部参考）】',
    relationshipBlock || '（无）',
    '',
    '【星野核心设定摘录（lore-memory / 常驻设定；勿逐字复述）】',
    stableLoreBlock || '（无）',
    '',
    '【按需命中的设定库关键词条目（仅命中项；勿逐字复述）】',
    keywordLoreBlock || '（无）',
    '',
    '【输出 JSON schema（字段名必须一致；不要返回数组）】',
    JSON.stringify({ decision: 'reply | skip', reply: 'string', reason: 'string' }, null, 2),
    '',
    'decision="reply" 时：reply 是一条完整的群聊发言；reason 可写一句话简要说明回应动机（内部使用，不会被发出去）。',
    'decision="skip" 时：reply 留空字符串 ""；reason 必须写明为何此刻不开口（例如："最近消息全是 system 公告"、"话题与角色无关"、"上一条是自己刚发的"）。',
    '',
    '只返回 JSON 对象，不要任何其他文字。',
  ];

  return parts.join('\n');
}

export function normalizeGroupChatReplyAiResult(raw: unknown): GroupChatReplyAiResult | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const decisionRaw = typeof record.decision === 'string' ? record.decision.trim().toLowerCase() : '';
  let decision: GroupChatReplyAiDecision;
  if (decisionRaw === 'reply') decision = 'reply';
  else if (decisionRaw === 'skip') decision = 'skip';
  else return null;
  const replyRaw = typeof record.reply === 'string' ? record.reply : '';
  const reply = clamp(replyRaw, MAX_REPLY_CHARS);
  const reasonRaw = typeof record.reason === 'string' ? record.reason : '';
  const reason = reasonRaw.trim() ? clamp(reasonRaw, MAX_REASON_CHARS) : undefined;

  if (decision === 'reply' && !reply) return null;
  return { decision, reply: decision === 'skip' ? '' : reply, reason };
}

export const GROUP_CHAT_REPLY_LIMITS = {
  maxReplyChars: MAX_REPLY_CHARS,
  maxReasonChars: MAX_REASON_CHARS,
} as const;
