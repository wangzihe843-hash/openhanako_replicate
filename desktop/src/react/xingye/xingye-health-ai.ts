/**
 * xingye-health-ai.ts — 健康模块的一键 AI 生成。
 *
 * 走与日记 / 通讯录 / 秘密空间一致的 `POST /api/xingye/phone-generate`
 * （kind: health_day）。
 *
 * 关键：只让模型回「当天状态 scenario + 建议 advice」，不回曲线数据。
 * 上下文以「最近聊天」为主信号，设定库 / 关系状态 / 巡检为辅；任意一项缺失都优雅降级。
 */

import { hanaFetch } from '../hooks/use-hana-fetch';
import type { Agent } from '../types';
import type { XingyeRoleProfile } from './xingye-profile-store';
import { peekDeskHeartbeatUiOutcome } from './xingye-desk-heartbeat-memory';
import {
  HEALTH_FALLBACK_ADVICE,
  todayIsoDate,
  type HealthAdvice,
  type HealthScenario,
} from './xingye-health-data';
import { buildHealthContinuityAnchorBlock as buildSlotAwareHealthAnchorBlock } from './xingye-health-dedupe';
import { buildHealthDayPrompt } from './xingye-health-prompts';
import { listHealthDays } from './xingye-health-store';
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

const VALID_SCENARIOS: ReadonlySet<HealthScenario> = new Set<HealthScenario>([
  'calm',
  'high_stress',
  'active',
]);

function truncateChars(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(0, max - 1))}…`;
}

function safeText(value: string | undefined): string {
  return value?.trim() || '';
}

/** 当前时刻 HH:mm（本地时区）。 */
function clockHHmm(now: Date = new Date()): string {
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
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

/**
 * 把模型返回收敛成 { scenario, advice }。
 * - scenario 非法 / 缺失 → 'calm'。
 * - advice 缺正文 → 用 scenario 对应的固定降级文案（不抛错；属于「内容缺失优雅降级」）。
 */
export function normalizeHealthDayResult(
  raw: unknown,
  now: Date = new Date(),
): { scenario: HealthScenario; advice: HealthAdvice } {
  const generatedAt = clockHHmm(now);
  let scenario: HealthScenario = 'calm';
  let title = '今日分析';
  let body = '';

  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const record = raw as Record<string, unknown>;
    if (typeof record.scenario === 'string' && VALID_SCENARIOS.has(record.scenario as HealthScenario)) {
      scenario = record.scenario as HealthScenario;
    }
    const adviceRaw = record.advice;
    if (adviceRaw && typeof adviceRaw === 'object' && !Array.isArray(adviceRaw)) {
      const a = adviceRaw as Record<string, unknown>;
      if (typeof a.title === 'string' && a.title.trim()) title = a.title.trim().slice(0, 60);
      if (typeof a.body === 'string') body = a.body.trim();
    } else if (typeof record.advice === 'string') {
      body = record.advice.trim();
    }
  }

  if (!body) {
    const fallback = HEALTH_FALLBACK_ADVICE[scenario];
    return { scenario, advice: { title: fallback.title, body: fallback.body, generatedAt } };
  }
  return { scenario, advice: { title, body: body.slice(0, 1200), generatedAt } };
}

/**
 * 一键生成「今天」（或指定 isoDate）的健康状态 + 建议。
 * 不写存储；由调用方拿结果落盘。模型调用失败时抛错，UI 据此提示并允许重试。
 */
export async function generateHealthDayWithAI(params: {
  agent: Agent;
  ownerProfile: XingyeRoleProfile | null | undefined;
  isoDate?: string;
  timeoutMs?: number;
}): Promise<{ scenario: HealthScenario; advice: HealthAdvice }> {
  const { agent, ownerProfile } = params;
  const timeoutMs = params.timeoutMs ?? 90_000;
  const isoDate = params.isoDate ?? todayIsoDate();

  const stableLoreBlock = await buildStableLoreBlock(agent.id);
  // 反套路 anchor：从 health store 拉历史 advice，让 dedupe 模块根据 slot
  // 识别（喝水 / 睡眠 / 运动 / 步数 / 压力）+ 摘录构造 anchor。
  // 历史为空（首次生成）→ 返回 ''，prompt 端会显示「（无）」占位。
  let healthHistory: Awaited<ReturnType<typeof listHealthDays>> = [];
  try {
    healthHistory = await listHealthDays(agent.id);
  } catch {
    healthHistory = [];
  }
  const continuityAnchorBlock = buildSlotAwareHealthAnchorBlock(healthHistory);
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
    purpose: 'generic',
    queryText,
    maxChars: 2000,
    includeAlways: false,
    includeKeyword: true,
  });
  const keywordLoreBlock = formatXingyeLoreRuntimeContextBlock(keywordCtx);

  const prompt = buildHealthDayPrompt({
    agent,
    userName,
    profile: ownerProfile,
    isoDate,
    recentSceneBlock,
    hasRecentChats: recentContext.hasOpenHanakoMessages,
    stableLoreBlock,
    keywordLoreBlock,
    relationshipBlock,
    heartbeatBlock,
    continuityAnchorBlock,
  });

  const response = await hanaFetch('/api/xingye/phone-generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    timeout: timeoutMs,
    body: JSON.stringify({
      kind: 'health_day',
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
      ? `：${(data.details as { message?: string }[]).map((item) => item.message ?? '').join('；')}`
      : '';
    throw new Error(`${data?.error || '模型调用失败'}${details}`);
  }

  return normalizeHealthDayResult(data?.result);
}
