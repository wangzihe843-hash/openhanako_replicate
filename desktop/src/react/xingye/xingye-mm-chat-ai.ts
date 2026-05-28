import { hanaFetch } from '../hooks/use-hana-fetch';
import type { Agent } from '../types';
import type { XingyeRoleProfile } from './xingye-profile-store';
import { peekDeskHeartbeatUiOutcome } from './xingye-desk-heartbeat-memory';
import {
  buildMmChatFollowupAgentQuestionPrompt,
  buildMmChatFollowupAssistantAnswerPrompt,
  buildMmChatGenerationPrompt,
  buildMmChatInitialBacklogPrompt,
  buildMmChatMultiRoundFollowupPrompt,
  buildMmChatMultiRoundNewPrompt,
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
import { listMmChatSessions, type XingyeMmChatSession } from './xingye-mm-chat-store';

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

/**
 * MM Chat 跨会话「连续性反重复锚点」。
 *
 * 用途：当 agent 又点「再问助手一个新问题」（mode='new'）时，让模型看一眼
 * TA 最近问过哪些 session 主题——避免短时间内连开两三个几乎一模一样的会话
 * （典型 case：「我下一步该怎么开口」连续生成三次）。
 *
 * 设计取舍：
 * - 只在 mode='new' 路径下用。followup 模式已经把整个 session history 喂给了
 *   模型（formatMmChatSessionHistoryForPrompt），它已经知道"刚才说过什么"，
 *   不需要再叠一层 anchor。
 * - 抽样维度：最近 6 个 session 的 title + ta 提问首句首 30 字。title 是会话主轴，
 *   ta 第一句话给主题以更具体的语义（光看 title 太抽象）。
 * - 失败/读盘异常 → 返回空串（与其他模块一致的优雅降级）。
 */
const MM_CHAT_CONTINUITY_ANCHOR_LIMIT = 6;
const MM_CHAT_CONTINUITY_SNIPPET_CHARS = 30;

export function buildMmChatContinuityAnchorBlockFromSessions(
  sessions: XingyeMmChatSession[],
): string {
  if (!Array.isArray(sessions) || sessions.length === 0) return '';
  // listMmChatSessions 已按 updatedAt 倒序；这里直接 take。
  const picked = sessions.slice(0, MM_CHAT_CONTINUITY_ANCHOR_LIMIT);
  const lines: string[] = [];
  for (const s of picked) {
    const title = (s.title ?? '').trim().slice(0, 40);
    if (!title) continue;
    let firstTaQ = '';
    for (const m of s.messages ?? []) {
      if (m?.role === 'ta' && typeof m.text === 'string' && m.text.trim()) {
        firstTaQ = m.text.trim().replace(/\s+/g, ' ').slice(0, MM_CHAT_CONTINUITY_SNIPPET_CHARS);
        break;
      }
    }
    if (firstTaQ) {
      lines.push(`  · 《${title}》— ${firstTaQ}`);
    } else {
      lines.push(`  · 《${title}》`);
    }
  }
  if (lines.length === 0) return '';
  return [
    '- 最近你（TA）已经向助手问过这些主题（请换不同切口，不要短时间内重复发起几乎相同的咨询）:',
    ...lines,
  ].join('\n');
}

async function buildMmChatContinuityAnchorBlock(agentId: string): Promise<string> {
  try {
    const sessions = await listMmChatSessions(agentId);
    return buildMmChatContinuityAnchorBlockFromSessions(sessions);
  } catch {
    return '';
  }
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

  // 跨会话反重复锚点：仅 new 模式需要——followup 已经把整 session history 喂给模型了。
  const continuityAnchorBlock = await buildMmChatContinuityAnchorBlock(agent.id);

  const prompt = buildMmChatGenerationPrompt({
    agent,
    userName,
    profile: ownerProfile,
    recentSceneBlock,
    stableLoreBlock,
    keywordLoreBlock,
    relationshipBlock,
    heartbeatBlock,
    continuityAnchorBlock,
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

// ---------------------------------------------------------------------------
// 多轮一次性生成（UI 默认走这条路径）
// ---------------------------------------------------------------------------

export type XingyeMmChatAiRoundQA = { question: string; answer: string };

export type XingyeMmChatAiMultiResult = {
  /** new 模式：本会话标题；followup 模式：空串（沿用既有会话标题）。 */
  title: string;
  rounds: XingyeMmChatAiRoundQA[];
};

/**
 * 随机轮数：3-5。
 *
 * 抽成具名函数，便于测试 spy/stub。范围本身写死，因为 UI 不再暴露选择器——
 * 用户的需求是"每次点一下就随机展开 3-5 轮"，没必要做成可配置。
 */
export function pickRandomMmChatRoundCount(): number {
  return Math.floor(Math.random() * 3) + 3;
}

/** 数组中每个 round 单独 normalize；缺一不可。 */
function normalizeMmChatRoundsArray(raw: unknown): XingyeMmChatAiRoundQA[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: XingyeMmChatAiRoundQA[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const rec = item as Record<string, unknown>;
    const q = typeof rec.question === 'string' ? rec.question.trim() : '';
    const a = typeof rec.answer === 'string' ? rec.answer.trim() : '';
    if (!q || !a) return null;
    out.push({
      question: clampCodePoints(q, 3500),
      answer: clampCodePoints(a, 3500),
    });
  }
  return out;
}

export function normalizeMmChatMultiRoundResult(
  raw: unknown,
  opts: { requireTitle: boolean },
): XingyeMmChatAiMultiResult | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const rounds = normalizeMmChatRoundsArray(rec.rounds);
  if (!rounds) return null;
  let title = '';
  const titleRaw = rec.title;
  if (typeof titleRaw === 'string' && titleRaw.trim()) {
    title = titleRaw.trim().slice(0, 200);
  } else if (opts.requireTitle) {
    // 兜底：从第一轮 question 截取
    title = truncateChars(rounds[0].question, 48);
  }
  return { title, rounds };
}

export type GenerateMmChatRoundsWithAIParams = {
  agent: Agent;
  ownerProfile: XingyeRoleProfile | null | undefined;
  timeoutMs?: number;
  /** 不传则走 pickRandomMmChatRoundCount()（3-5 随机）。 */
  roundCount?: number;
  mode?: MmChatGenerationMode;
  followUp?: {
    sessionTitle: string;
    sessionMessages: XingyeMmChatTurn[];
    /** 仅作用于本批 rounds[0].question 的方向提示。 */
    directionHint?: string;
  };
};

/**
 * MM Chat 多轮一次性生成。
 *
 * - new 模式：返回 `{title, rounds[]}`，UI 拿到后 flatten 成 (ta, ai, ta, ai, ...) 交给
 *   createMmChatSession 一次性入库。
 * - followup 模式：返回 `{title:'', rounds[]}`，UI 调 appendMmChatTurnsToSession 追加。
 *
 * followup 不再走 2-step 拆分——多轮单调用，prompt 内已 inline 了"角色式判断点"等约束。
 */
export async function generateMmChatRoundsWithAI(
  params: GenerateMmChatRoundsWithAIParams,
): Promise<XingyeMmChatAiMultiResult> {
  const { agent, ownerProfile } = params;
  const timeoutMs = params.timeoutMs ?? 90_000;
  const mode: MmChatGenerationMode = params.mode ?? 'new';
  const roundCount = Math.max(1, Math.floor(params.roundCount ?? pickRandomMmChatRoundCount()));

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

    const prompt = buildMmChatMultiRoundFollowupPrompt({
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
      firstRoundDirectionHint: directionHint,
      roundCount,
    });

    const raw = await postMmChatPhoneGenerate({
      agent,
      prompt,
      timeoutMs,
      mmChatMode: `followup_multi_${roundCount}`,
    });
    const normalized = normalizeMmChatMultiRoundResult(raw, { requireTitle: false });
    if (!normalized || normalized.rounds.length === 0) {
      throw new Error('模型返回无效：缺少 rounds 数组或 JSON 解析失败');
    }
    return normalized;
  }

  // new 模式：注入跨会话反重复锚点。
  const continuityAnchorBlock = await buildMmChatContinuityAnchorBlock(agent.id);

  const prompt = buildMmChatMultiRoundNewPrompt({
    agent,
    userName,
    profile: ownerProfile,
    recentSceneBlock,
    stableLoreBlock,
    keywordLoreBlock,
    relationshipBlock,
    heartbeatBlock,
    continuityAnchorBlock,
    roundCount,
  });

  const raw = await postMmChatPhoneGenerate({
    agent,
    prompt,
    timeoutMs,
    mmChatMode: `new_multi_${roundCount}`,
  });
  const normalized = normalizeMmChatMultiRoundResult(raw, { requireTitle: true });
  if (!normalized || normalized.rounds.length === 0) {
    throw new Error('模型返回无效：缺少 rounds 数组或 JSON 解析失败');
  }
  return normalized;
}

// ---------------------------------------------------------------------------
// 首次打开 MM Chat 的 backlog 初始化（一次调用产出 N 条独立 session）
// ---------------------------------------------------------------------------

/** 模型可返回的重要度档位，约束轮数（与 prompt 内规则对齐）。 */
export type XingyeMmChatBacklogImportanceTag = 'high' | 'medium' | 'low';

export type XingyeMmChatBacklogSession = {
  title: string;
  importanceTag: XingyeMmChatBacklogImportanceTag;
  rounds: XingyeMmChatAiRoundQA[];
};

export type XingyeMmChatBacklogResult = {
  sessions: XingyeMmChatBacklogSession[];
};

/** 客户端随机的初始化 session 条数（3-5）。抽成具名函数便于测试 spy。 */
export function pickRandomMmChatInitialBacklogSize(): number {
  return Math.floor(Math.random() * 3) + 3;
}

const MM_CHAT_BACKLOG_MIN_ROUNDS = 1;
const MM_CHAT_BACKLOG_MAX_ROUNDS = 5;
const MM_CHAT_BACKLOG_SPAN_DAYS = 10;

function normalizeBacklogImportance(raw: unknown): XingyeMmChatBacklogImportanceTag {
  if (raw === 'high' || raw === 'medium' || raw === 'low') return raw;
  return 'medium';
}

/**
 * Backlog 结果归一化。
 *
 * 不严格校验"轮数与 importanceTag 是否自洽"——prompt 已经向模型讲清规则，
 * 真出现错档，落地后用户看着也合理（一条短话题的 high 标签不至于报错）。
 * 只做几件确定性兜底：rounds 至少 1 条 + 最多 5 条 + question/answer 非空。
 */
export function normalizeMmChatInitialBacklogResult(raw: unknown): XingyeMmChatBacklogResult | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const sessionsRaw = rec.sessions;
  if (!Array.isArray(sessionsRaw) || sessionsRaw.length === 0) return null;
  const sessions: XingyeMmChatBacklogSession[] = [];
  for (const item of sessionsRaw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const r = item as Record<string, unknown>;
    const titleRaw = typeof r.title === 'string' ? r.title.trim() : '';
    const rounds = normalizeMmChatRoundsArray(r.rounds);
    if (!rounds || rounds.length === 0) continue;
    const clamped = rounds.slice(0, MM_CHAT_BACKLOG_MAX_ROUNDS);
    if (clamped.length < MM_CHAT_BACKLOG_MIN_ROUNDS) continue;
    const title = titleRaw ? titleRaw.slice(0, 200) : truncateChars(clamped[0].question, 48);
    sessions.push({
      title,
      importanceTag: normalizeBacklogImportance(r.importanceTag),
      rounds: clamped,
    });
  }
  if (sessions.length === 0) return null;
  return { sessions };
}

export type XingyeMmChatBacklogTimestampedSession = XingyeMmChatBacklogSession & {
  /** 整条 session 的发生时间——session.createdAt/updatedAt 和所有 turn 都用同一个值。 */
  occurredAt: string;
};

/**
 * 把 N 条 backlog session 的"发生时间"确定性铺到过去 [1, MM_CHAT_BACKLOG_SPAN_DAYS] 天里：
 * 第 0 条 ≈ 10 天前，最后一条 ≈ 1 天前，让列表里时间从远到近自然递增。
 *
 * 时间不交给 LLM 编（[[feedback_ai_payload_minimization]]：数值/批量数据本地确定性生成）。
 * 同 distributeOccurredAtFallback 的思路，但 MM Chat 不需要保留 LLM 自己写的 occurredAt——
 * 整条 session 一个时间足够，UI 列表里 formatSessionTime 也只用一个时间。
 *
 * 接受可选 referenceNow：测试可注入固定时间。
 */
export function distributeMmChatBacklogTimestamps(
  sessions: XingyeMmChatBacklogSession[],
  referenceNow?: Date,
): XingyeMmChatBacklogTimestampedSession[] {
  if (sessions.length === 0) return [];
  const now = referenceNow ?? new Date();
  const todayMs = now.getTime();
  const span = MM_CHAT_BACKLOG_SPAN_DAYS;
  const total = Math.max(1, sessions.length);
  return sessions.map((s, i) => {
    // i=0 → 最远（span 天前）；i=last → 最近（1 天前）
    const offsetDays = Math.max(1, Math.round(span - (i / total) * (span - 1)));
    const past = new Date(todayMs - offsetDays * 24 * 3600 * 1000);
    return { ...s, occurredAt: past.toISOString() };
  });
}

export type GenerateMmChatInitialBacklogParams = {
  agent: Agent;
  ownerProfile: XingyeRoleProfile | null | undefined;
  timeoutMs?: number;
  /** 不传则走 pickRandomMmChatInitialBacklogSize()（3-5 随机）。 */
  sessionCount?: number;
};

/**
 * 首次打开 MM Chat：一次性产出 N 条独立 session 的 backlog。
 *
 * 不写盘——由调用方（PhoneMmChatApp 的 bootstrap effect）拿到结果后：
 *  1) 走 distributeMmChatBacklogTimestamps 给每条 session 派一个"发生时间"；
 *  2) flatten 成 turn 数组、组装成 XingyeMmChatSession[]；
 *  3) 单次 saveMmChatPersistence 写入 sessions.json，并设置 initializedAt。
 */
export async function generateMmChatInitialBacklogWithAI(
  params: GenerateMmChatInitialBacklogParams,
): Promise<XingyeMmChatBacklogResult> {
  const { agent, ownerProfile } = params;
  const timeoutMs = params.timeoutMs ?? 120_000;
  const sessionCount = Math.max(
    1,
    Math.floor(params.sessionCount ?? pickRandomMmChatInitialBacklogSize()),
  );

  const stableLoreBlock = await buildStableLoreBlock(agent.id);
  const userName = await resolveXingyeSpeakerUserName();
  const recentContext = collectRecentContextForAgent({ agentId: agent.id });
  const recentSceneBlock = describeRecentContextForPrompt(recentContext);
  const relationshipBlock = formatRelationshipBlock(agent.id);
  const heartbeatLine = peekDeskHeartbeatUiOutcome(agent.id);
  const heartbeatBlock = heartbeatLine ? heartbeatLine.trim() : '';

  const queryText = buildXingyeLoreRuntimeQueryText([
    ...profilePartsForQuery(ownerProfile ?? null),
    recentContext.summaryText,
    relationshipBlock,
    stableLoreBlock.slice(0, 2000),
    heartbeatLine ?? '',
  ]);

  const keywordCtx = collectXingyeLoreRuntimeContext(agent.id, {
    purpose: 'mm_chat',
    queryText,
    maxChars: 2000,
    includeAlways: false,
    includeKeyword: true,
  });
  const keywordLoreBlock = formatXingyeLoreRuntimeContextBlock(keywordCtx);

  const prompt = buildMmChatInitialBacklogPrompt({
    agent,
    userName,
    profile: ownerProfile,
    recentSceneBlock,
    stableLoreBlock,
    keywordLoreBlock,
    relationshipBlock,
    heartbeatBlock,
    sessionCount,
  });

  const raw = await postMmChatPhoneGenerate({
    agent,
    prompt,
    timeoutMs,
    mmChatMode: `initial_backlog_${sessionCount}`,
  });

  const normalized = normalizeMmChatInitialBacklogResult(raw);
  if (!normalized) {
    throw new Error('模型返回无效：缺少 sessions 数组或 JSON 解析失败');
  }
  return normalized;
}
