import { hanaFetch } from '../hooks/use-hana-fetch';
import type { Agent } from '../types';
import type { XingyeRoleProfile } from './xingye-profile-store';
import {
  buildXingyeLoreRuntimeQueryText,
  collectXingyeLoreRuntimeContext,
  formatXingyeLoreRuntimeContextBlock,
} from './xingye-lore-runtime-context';
import { XINGYE_LORE_CATEGORY_LABELS, listLoreEntries } from './xingye-lore-store';
import { getXingyePersistenceStorage } from './xingye-persistence';
import { resolveXingyeSpeakerUserName } from './xingye-speaker-context';
import { postXingyeStorage } from './xingye-storage-api';
import { buildTripsHistoryPrompt } from './xingye-trips-prompts';
import { normalizeTripDraft, type XingyeTripDraft } from './xingye-trips-store';

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
