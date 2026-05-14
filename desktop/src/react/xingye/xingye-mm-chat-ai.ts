import { hanaFetch } from '../hooks/use-hana-fetch';
import type { Agent } from '../types';
import type { XingyeRoleProfile } from './xingye-profile-store';
import { peekDeskHeartbeatUiOutcome } from './xingye-desk-heartbeat-memory';
import {
  buildMmChatFollowupAgentQuestionPrompt,
  buildMmChatFollowupAssistantAnswerPrompt,
  buildMmChatGenerationPrompt,
  formatMmChatSessionHistoryForPrompt,
  type MmChatGenerationMode,
} from './xingye-mm-chat-prompts';
import type { XingyeMmChatTurn } from './xingye-mm-chat-store';
import {
  buildXingyeLoreRuntimeQueryText,
  collectXingyeLoreRuntimeContext,
  formatXingyeLoreRuntimeContextBlock,
} from './xingye-lore-runtime-context';
import { XINGYE_LORE_CATEGORY_LABELS, listLoreEntries } from './xingye-lore-store';
import { getXingyePersistenceStorage } from './xingye-persistence';
import {
  collectRecentContextForAgent,
  describeRecentContextForPrompt,
} from './xingye-recent-context';
import { resolveXingyeSpeakerUserName } from './xingye-speaker-context';
import { getRelationshipState } from './xingye-state-store';
import { postXingyeStorage } from './xingye-storage-api';

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
  if (fromFile && fromFile.trim()) {
    return truncateChars(fromFile, 3200);
  }
  const fallback = buildStableLoreFromAlwaysEntries(agentId, 2800);
  return fallback.trim();
}

function safeText(value: string | undefined): string {
  return value?.trim() || '';
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

function profilePartsForQuery(profile: XingyeRoleProfile | null | undefined): string[] {
  if (!profile) return [];
  return [
    safeText(profile.displayName),
    safeText(profile.shortBio),
    safeText(profile.identitySummary),
    safeText(profile.backgroundSummary),
    safeText(profile.personalitySummary),
    safeText(profile.relationshipLabel),
    safeText(profile.values),
    safeText(profile.taboos),
    safeText(profile.relationshipMode),
  ];
}

function clampCodePoints(s: string, maxCodePoints: number): string {
  const t = s.trim();
  const chars = [...t];
  if (chars.length <= maxCodePoints) return t;
  return `${chars.slice(0, maxCodePoints).join('')}…`;
}

export type XingyeMmChatAiRound = {
  title: string;
  question: string;
  answer: string;
};

export function normalizeMmChatRoundResult(raw: unknown): XingyeMmChatAiRound | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const qRaw = record.question;
  const aRaw = record.answer;
  const question = typeof qRaw === 'string' ? qRaw.trim() : '';
  const answer = typeof aRaw === 'string' ? aRaw.trim() : '';
  if (!question || !answer) return null;
  const titleRaw = record.title;
  const title = typeof titleRaw === 'string' && titleRaw.trim()
    ? titleRaw.trim().slice(0, 200)
    : truncateChars(question, 48);
  return {
    title,
    question: clampCodePoints(question, 3500),
    answer: clampCodePoints(answer, 3500),
  };
}

export function normalizeMmChatFollowupAgentQuestion(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const q = (raw as Record<string, unknown>).agentFollowupQuestion;
  if (typeof q !== 'string' || !q.trim()) return null;
  return clampCodePoints(q.trim(), 3500);
}

export function normalizeMmChatFollowupAssistantAnswer(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const a = (raw as Record<string, unknown>).assistantAnswer;
  if (typeof a !== 'string' || !a.trim()) return null;
  return clampCodePoints(a.trim(), 3500);
}

function lastAiAssistantText(messages: XingyeMmChatTurn[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'ai') return String(messages[i]?.text ?? '').trim();
  }
  return '';
}

async function postMmChatPhoneGenerate(params: {
  agent: Agent;
  prompt: string;
  timeoutMs: number;
  mmChatMode: string;
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
      mmChatMode: params.mmChatMode,
    }),
  });

  let data: {
    ok?: boolean;
    error?: string;
    result?: unknown;
    details?: unknown;
  };
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

export type GenerateMmChatRoundWithAIParams = {
  agent: Agent;
  ownerProfile: XingyeRoleProfile | null | undefined;
  timeoutMs?: number;
  /** `followup` 时须提供 `followUp`。 */
  mode?: MmChatGenerationMode;
  followUp?: {
    sessionTitle: string;
    sessionMessages: XingyeMmChatTurn[];
    /** 可选。用户追问方向短提示；不会原样写入角色提问正文。 */
    directionHint?: string;
  };
};

/**
 * 调用 `POST /api/xingye/phone-generate`（`kind: mm_chat`），与日记 / 秘密空间 / TA 状态一致。
 * 不写入 MM Chat 存储；由调用方合并进当前会话并走既有 `saveMmChatPersistence`。
 */
export async function generateMmChatRoundWithAI(params: GenerateMmChatRoundWithAIParams): Promise<XingyeMmChatAiRound> {
  const { agent, ownerProfile } = params;
  const timeoutMs = params.timeoutMs ?? 90_000;
  const mode: MmChatGenerationMode = params.mode ?? 'new';

  const stableLoreBlock = await buildStableLoreBlock(agent.id);
  const userName = await resolveXingyeSpeakerUserName();
  const recentContext = collectRecentContextForAgent({ agentId: agent.id });
  const recentSceneBlock = describeRecentContextForPrompt(recentContext);
  const relationshipBlock = formatRelationshipBlock(agent.id);
  const heartbeatLine = peekDeskHeartbeatUiOutcome(agent.id);
  const heartbeatBlock = heartbeatLine ? heartbeatLine.trim() : '';

  const fu = params.followUp;
  const directionHint = (fu?.directionHint ?? '').trim();

  const queryText = buildXingyeLoreRuntimeQueryText([
    ...profilePartsForQuery(ownerProfile ?? null),
    recentContext.summaryText,
    relationshipBlock,
    stableLoreBlock.slice(0, 2000),
    heartbeatLine ?? '',
    mode === 'followup' ? directionHint : '',
    mode === 'followup' ? lastAiAssistantText(fu?.sessionMessages ?? []) : '',
  ]);

  const keywordCtx = collectXingyeLoreRuntimeContext(agent.id, {
    purpose: 'mm_chat',
    queryText,
    maxChars: 2000,
    includeAlways: false,
    includeKeyword: true,
  });
  const keywordLoreBlock = formatXingyeLoreRuntimeContextBlock(keywordCtx);

  const taMoniker = (ownerProfile?.displayName ?? agent.name).trim() || agent.name;

  if (mode === 'followup') {
    if (!fu || !fu.sessionMessages?.length) {
      throw new Error('追问模式需要有效的会话历史。');
    }
    const last = fu.sessionMessages[fu.sessionMessages.length - 1];
    if (!last || last.role !== 'ai' || !String(last.text ?? '').trim()) {
      throw new Error('追问须接在助手回复之后：请等待上一轮生成完成，或检查会话内容。');
    }
    const previousAi = lastAiAssistantText(fu.sessionMessages);
    const sessionHistoryBlock = formatMmChatSessionHistoryForPrompt({
      taMoniker,
      lines: fu.sessionMessages.map((m) => ({ role: m.role, text: m.text })),
      maxChars: 9000,
    });

    const stepTimeout = Math.max(35_000, Math.floor(timeoutMs / 2));

    const promptQ = buildMmChatFollowupAgentQuestionPrompt({
      agent,
      userName,
      profile: ownerProfile,
      recentSceneBlock,
      stableLoreBlock,
      keywordLoreBlock,
      relationshipBlock,
      heartbeatBlock,
      sessionTitle: fu.sessionTitle,
      sessionHistoryBlock,
      previousAiAnswer: previousAi,
      followUpDirectionHint: directionHint,
    });

    const rawQ = await postMmChatPhoneGenerate({
      agent,
      prompt: promptQ,
      timeoutMs: stepTimeout,
      mmChatMode: 'followup_agent_question',
    });
    const agentFollowupQuestion = normalizeMmChatFollowupAgentQuestion(rawQ);
    if (!agentFollowupQuestion) {
      throw new Error('模型返回无效：缺少 agentFollowupQuestion 或 JSON 解析失败');
    }

    const promptA = buildMmChatFollowupAssistantAnswerPrompt({
      agent,
      userName,
      profile: ownerProfile,
      recentSceneBlock,
      stableLoreBlock,
      keywordLoreBlock,
      relationshipBlock,
      heartbeatBlock,
      sessionHistoryBlock,
      agentFollowupQuestion,
    });

    const rawA = await postMmChatPhoneGenerate({
      agent,
      prompt: promptA,
      timeoutMs: Math.max(35_000, timeoutMs - stepTimeout),
      mmChatMode: 'followup_assistant_answer',
    });
    const assistantAnswer = normalizeMmChatFollowupAssistantAnswer(rawA);
    if (!assistantAnswer) {
      throw new Error('模型返回无效：缺少 assistantAnswer 或 JSON 解析失败');
    }

    const sessionTitle = fu.sessionTitle.trim().slice(0, 200) || truncateChars(agentFollowupQuestion, 48);
    return {
      title: sessionTitle,
      question: agentFollowupQuestion,
      answer: assistantAnswer,
    };
  }

  const prompt = buildMmChatGenerationPrompt({
    agent,
    userName,
    profile: ownerProfile,
    recentSceneBlock,
    stableLoreBlock,
    keywordLoreBlock,
    relationshipBlock,
    heartbeatBlock,
  });

  const result = await postMmChatPhoneGenerate({
    agent,
    prompt,
    timeoutMs,
    mmChatMode: 'new',
  });

  const normalized = normalizeMmChatRoundResult(result);
  if (!normalized) {
    throw new Error('模型返回无效：缺少 question/answer 或 JSON 解析失败');
  }
  return normalized;
}
