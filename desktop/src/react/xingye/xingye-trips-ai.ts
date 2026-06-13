import { hanaFetch } from '../hooks/use-hana-fetch';
import type { Agent } from '../types';
import type { XingyeRoleProfile } from './xingye-profile-store';
import {
  buildXingyeLoreRuntimeQueryText,
  collectXingyeLoreRuntimeContext,
  formatXingyeLoreRuntimeContextBlock,
} from './xingye-lore-runtime-context';
import { XINGYE_LORE_CATEGORY_LABELS, listLoreEntries } from './xingye-lore-store';
import { assertXingyePersistenceBoundTo, getXingyePersistenceStorage } from './xingye-persistence';
import { peekDeskHeartbeatUiOutcome } from './xingye-desk-heartbeat-memory';
import { collectRecentContextForAgent, describeRecentContextForPrompt } from './xingye-recent-context';
import { getRelationshipState } from './xingye-state-store';
import { resolveXingyeSpeakerUserName } from './xingye-speaker-context';
import { postXingyeStorage } from './xingye-storage-api';
import { buildTripsHistoryPrompt } from './xingye-trips-prompts';
import {
  listTripEntries,
  normalizeTripDraft,
  type XingyeTripDraft,
  type XingyeTripEntry,
} from './xingye-trips-store';

function truncateChars(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(0, max - 1))}…`;
}

function safeText(value: string | undefined): string {
  return value?.trim() || '';
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
 * 规范化模型返回的行程批量。
 *
 * 接受 `{ trips: [...] }`（首选）/ `{ entries: [...] }` / `{ drafts: [...] }` / 裸数组。
 * 每条经 normalizeTripDraft 过滤（缺起点 / 终点 → 丢弃）；按 from→to + chapter 去重。
 */
export function normalizeTripsHistoryResults(raw: unknown): XingyeTripDraft[] {
  let items: unknown[] = [];
  if (Array.isArray(raw)) {
    items = raw;
  } else if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>;
    if (Array.isArray(r.trips)) items = r.trips;
    else if (Array.isArray(r.entries)) items = r.entries;
    else if (Array.isArray(r.drafts)) items = r.drafts;
  }
  const out: XingyeTripDraft[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const draft = normalizeTripDraft(item);
    if (!draft) continue;
    const key = `${draft.from.name}→${draft.to.name}|${draft.chapter}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(draft);
  }
  return out;
}

/**
 * 「首次打开行程 app」时的历史批量生成：按 lore 提取 TA 走过的 3–6 段路。
 *
 * 与日记 / 购物的历史生成一致：只用 stable lore + keyword lore + profile（首次打开时
 * user 视角的最近聊天很可能为空，不依赖它）；走 POST /api/xingye/phone-generate。
 * 任意单条解析失败不会让整批失败，只过滤无效条；最终一条都没有则抛错。
 */
export async function generateTripsHistoryWithAI(params: {
  agent: Agent;
  ownerProfile: XingyeRoleProfile | null | undefined;
  /** 期望生成的条目数（3–6；越界会被夹紧）。 */
  desiredCount: number;
  timeoutMs?: number;
}): Promise<XingyeTripDraft[]> {
  const { agent, ownerProfile } = params;
  const timeoutMs = params.timeoutMs ?? 120_000;
  const desiredCount = Math.max(3, Math.min(6, Math.floor(params.desiredCount ?? 4)));

  // 跨角色守卫：下面按 agent.id 读 ambient lore，但 getXingyePersistenceStorage() 绑定的是
  // 「当前激活角色」；切角色异步重绑未完成时抢跑会串到上一个角色。绑定不一致即抛，由调用方跳过/重试。
  assertXingyePersistenceBoundTo(agent.id);

  const stableLoreBlock = await buildStableLoreBlock(agent.id);
  const userName = await resolveXingyeSpeakerUserName();

  const queryText = buildXingyeLoreRuntimeQueryText([
    ...profilePartsForQuery(ownerProfile ?? null),
    stableLoreBlock.slice(0, 2000),
  ]);

  const keywordCtx = collectXingyeLoreRuntimeContext(agent.id, {
    purpose: 'journal_draft',
    queryText,
    maxChars: 2000,
    includeAlways: false,
    includeKeyword: true,
  });
  const keywordLoreBlock = formatXingyeLoreRuntimeContextBlock(keywordCtx);

  const prompt = buildTripsHistoryPrompt({
    agent,
    userName,
    profile: ownerProfile,
    stableLoreBlock,
    keywordLoreBlock,
    desiredCount,
  });

  const response = await hanaFetch('/api/xingye/phone-generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    timeout: timeoutMs,
    body: JSON.stringify({
      kind: 'trips_history',
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

  const drafts = normalizeTripsHistoryResults(data?.result);
  if (drafts.length === 0) {
    throw new Error('模型返回无效：未生成可用的行程');
  }
  return drafts;
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

/** 已记录行程的去重锚点：`from → to · chapter` 列表（截断到 max 条）。 */
function buildExistingTripsAnchor(trips: XingyeTripEntry[], max = 16): string {
  if (!trips.length) return '';
  return trips
    .slice(0, max)
    .map((t) => `- ${t.from.name} → ${t.to.name}${t.chapter ? ` · ${t.chapter}` : ''}`)
    .join('\n');
}

/**
 * 「手动 AI 更新行程」：用户在行程 app 点「整理新行程」时调用。
 *
 * 与 generateTripsHistoryWithAI（首次打开、纯 lore 批量）区别：
 *  - 额外喂入 **最近 OpenHanako 聊天摘录 + 上次巡检结果 + 当前关系状态**，让模型从
 *    「最近 TA 提到 / 浮现的过去旅程」取材（走 mode:'update' 的 prompt 分支）；
 *  - 传入已记录行程做**去重锚点**，并对模型输出按 from→to|chapter 二次过滤，避免补出
 *    和现有行程重复的路；
 *  - 默认产出更少（1–3 条），是「增量补一段」而非「铺满一批」。
 *
 * 与购物 / 记账的「手动批量更新」一致：产出的是**待确认草稿**（由调用方写入
 * drafts.jsonl，落到行程 app 的「待确认草稿」区），不直接进「已走过的路」列表。
 */
export async function generateTripsUpdateWithAI(params: {
  agent: Agent;
  ownerProfile: XingyeRoleProfile | null | undefined;
  /** 已记录行程（去重 + 锚点）；不传则内部 listTripEntries 拉一次。 */
  existingTrips?: XingyeTripEntry[];
  /** 期望生成几条（1–3；越界会被夹紧）。 */
  desiredCount?: number;
  timeoutMs?: number;
}): Promise<XingyeTripDraft[]> {
  const { agent, ownerProfile } = params;
  const timeoutMs = params.timeoutMs ?? 120_000;
  const desiredCount = Math.max(1, Math.min(3, Math.floor(params.desiredCount ?? 2)));

  // 跨角色守卫：同 generateTripsHistoryWithAI——下面按 agent.id 读 ambient lore / 关系状态 /
  // 最近上下文，绑定不一致时抢跑会串到上一个角色（关系/上下文无 entry.agentId 过滤兜底）。
  assertXingyePersistenceBoundTo(agent.id);

  const existingTrips = params.existingTrips ?? (await listTripEntries(agent.id));
  const existingKeys = new Set(existingTrips.map((t) => `${t.from.name}→${t.to.name}|${t.chapter}`));

  const stableLoreBlock = await buildStableLoreBlock(agent.id);
  const userName = await resolveXingyeSpeakerUserName();

  const recentContext = collectRecentContextForAgent({ agentId: agent.id });
  const recentSceneBlock = describeRecentContextForPrompt(recentContext);
  const relationshipBlock = formatRelationshipBlock(agent.id);
  const heartbeatLine = peekDeskHeartbeatUiOutcome(agent.id);
  const heartbeatBlock = heartbeatLine ? heartbeatLine.trim() : '';
  const existingTripsAnchor = buildExistingTripsAnchor(existingTrips);

  const queryText = buildXingyeLoreRuntimeQueryText([
    ...profilePartsForQuery(ownerProfile ?? null),
    recentContext.summaryText,
    relationshipBlock,
    stableLoreBlock.slice(0, 2000),
    heartbeatLine ?? '',
  ]);

  const keywordCtx = collectXingyeLoreRuntimeContext(agent.id, {
    purpose: 'journal_draft',
    queryText,
    maxChars: 2000,
    includeAlways: false,
    includeKeyword: true,
  });
  const keywordLoreBlock = formatXingyeLoreRuntimeContextBlock(keywordCtx);

  const prompt = buildTripsHistoryPrompt({
    agent,
    userName,
    profile: ownerProfile,
    stableLoreBlock,
    keywordLoreBlock,
    desiredCount,
    mode: 'update',
    recentSceneBlock,
    relationshipBlock,
    heartbeatBlock,
    existingTripsAnchor,
  });

  const response = await hanaFetch('/api/xingye/phone-generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    timeout: timeoutMs,
    body: JSON.stringify({
      kind: 'trips_history',
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

  const drafts = normalizeTripsHistoryResults(data?.result).filter(
    (d) => !existingKeys.has(`${d.from.name}→${d.to.name}|${d.chapter}`),
  );
  if (drafts.length === 0) {
    throw new Error('没有整理出新的行程（可能都和已记录的重复了，或最近聊天里没有可提取的旅程）');
  }
  return drafts;
}
