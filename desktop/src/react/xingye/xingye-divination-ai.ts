import { hanaFetch } from '../hooks/use-hana-fetch';
import type { Agent } from '../types';
import { peekDeskHeartbeatUiOutcome } from './xingye-desk-heartbeat-memory';
import type {
  XingyeDivinationAgentLike,
  XingyeDivinationMethodId,
} from './xingye-divination-method-resolver';
import { buildDivinationReadingPrompt } from './xingye-divination-prompts';
import { getXingyePersistenceStorage } from './xingye-persistence';
import {
  collectRecentContextForAgent,
  describeRecentContextForPrompt,
} from './xingye-recent-context';
import { resolveXingyeSpeakerUserName } from './xingye-speaker-context';
import { getRelationshipState } from './xingye-state-store';
import { sanitizeDivinationReadingContent } from './phone-divination-narrative';

export type DivinationReadingResult = {
  title: string;
  agentQuestion: string;
  content: string;
};

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

function clampLine(value: string, maxChars: number): string {
  const t = value.replace(/\s+/g, ' ').trim();
  if (t.length <= maxChars) return t;
  return `${t.slice(0, Math.max(0, maxChars - 1))}…`;
}

export function normalizeDivinationReadingResult(raw: unknown): DivinationReadingResult | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const contentRaw = typeof record.content === 'string' ? record.content : '';
  const bodyRaw = typeof record.body === 'string' ? record.body : '';
  const content = sanitizeDivinationReadingContent(contentRaw || bodyRaw);
  if (!content || content.length < 16) return null;

  const agentQuestionRaw = typeof record.agentQuestion === 'string'
    ? record.agentQuestion
    : (typeof record.question === 'string' ? record.question : '');
  const agentQuestion = clampLine(agentQuestionRaw, 80);
  if (!agentQuestion) return null;

  const titleRaw = typeof record.title === 'string' ? record.title : '';
  const title = clampLine(titleRaw, 80) || agentQuestion.slice(0, 48);

  return { title, agentQuestion, content };
}

export type GenerateDivinationReadingArgs = {
  agent: Pick<Agent, 'id' | 'name' | 'yuan'>;
  methodId: XingyeDivinationMethodId;
  methodLabel: string;
  symbols: readonly string[];
  agentLike: XingyeDivinationAgentLike;
  userProvidedTheme?: string;
  resolverReason?: string;
  timeoutMs?: number;
};

/**
 * 调用 `POST /api/xingye/phone-generate`（`kind: divination_reading`），生成一次占卜叙事；
 * 与日记 / 秘密空间 / MM Chat / TA 状态等模块一致，由模型生成文本，本地仅做 sanitize 与字段归一。
 */
export async function generateDivinationReadingWithAI(
  args: GenerateDivinationReadingArgs,
): Promise<DivinationReadingResult> {
  const { agent, methodId, methodLabel, symbols, agentLike, userProvidedTheme, resolverReason } = args;
  const timeoutMs = args.timeoutMs ?? 90_000;

  const userName = await resolveXingyeSpeakerUserName();
  const recentContext = collectRecentContextForAgent({ agentId: agent.id });
  const recentSceneBlock = describeRecentContextForPrompt(recentContext);
  const relationshipBlock = formatRelationshipBlock(agent.id);
  const heartbeatLine = peekDeskHeartbeatUiOutcome(agent.id);
  const heartbeatBlock = heartbeatLine ? heartbeatLine.trim() : '';

  const prompt = buildDivinationReadingPrompt({
    agent,
    userName,
    agentLike,
    methodId,
    methodLabel,
    symbols,
    userProvidedTheme,
    resolverReason,
    recentSceneBlock,
    relationshipBlock,
    heartbeatBlock,
  });

  const response = await hanaFetch('/api/xingye/phone-generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    timeout: timeoutMs,
    body: JSON.stringify({
      kind: 'divination_reading',
      ownerAgentId: agent.id,
      agentId: agent.id,
      prompt,
      timeoutMs,
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
    throw new Error(`${data?.error || '占卜生成失败'}${details}`);
  }

  const normalized = normalizeDivinationReadingResult(data?.result);
  if (!normalized) {
    throw new Error('模型返回无效：缺少正文 / agentQuestion 或 JSON 解析失败');
  }
  return normalized;
}
