import { hanaFetch } from '../hooks/use-hana-fetch';
import type { Agent } from '../types';
import type { XingyeRoleProfile } from './xingye-profile-store';
import { XINGYE_LORE_CATEGORY_LABELS, listLoreEntries } from './xingye-lore-store';
import { getXingyePersistenceStorage } from './xingye-persistence';
import {
  collectRecentContextForAgent,
  describeRecentContextForPrompt,
} from './xingye-recent-context';

export type XingyeReadingTopicSuggestion = {
  /** Open Library subject slug, lowercase ASCII, 1-3 words (e.g. "science fiction"). */
  subject: string;
  /** Chinese display label for the chip (≤ 12 chars). */
  label: string;
  /** Optional short Chinese reason (≤ 40 chars). */
  reason?: string;
};

export type InferReadingTopicsParams = {
  agent: Agent;
  ownerProfile: XingyeRoleProfile | null | undefined;
  timeoutMs?: number;
};

const MAX_TOPICS = 6;
const SUBJECT_PATTERN = /^[a-z][a-z0-9 \-&']{1,38}[a-z0-9]$/;

function truncateChars(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(0, max - 1))}…`;
}

function safeText(value: string | undefined | null): string {
  return value?.trim() ?? '';
}

function buildStableLoreBlock(agentId: string, maxChars: number): string {
  try {
    const storage = getXingyePersistenceStorage();
    const entries = listLoreEntries(agentId, storage).filter(
      (e) => e.enabled && e.visibility === 'canonical' && e.insertionMode === 'always',
    );
    if (!entries.length) return '';
    const lines: string[] = [];
    let used = 0;
    for (const entry of entries) {
      const label = XINGYE_LORE_CATEGORY_LABELS[entry.category] ?? entry.category;
      const block = `- 《${entry.title}》（${label}）\n${entry.content.trim()}`;
      if (used + block.length > maxChars && lines.length > 0) break;
      lines.push(block);
      used += block.length + 2;
      if (used >= maxChars) break;
    }
    return lines.join('\n\n');
  } catch {
    return '';
  }
}

function profileLines(profile: XingyeRoleProfile | null | undefined): string {
  if (!profile) return '';
  const candidates: Array<[string, string]> = [
    ['名字', safeText(profile.displayName)],
    ['关系', safeText(profile.relationshipLabel)],
    ['一句话画像', safeText(profile.shortBio)],
    ['身份', safeText(profile.identitySummary)],
    ['背景', safeText(profile.backgroundSummary)],
    ['性格', safeText(profile.personalitySummary)],
    ['行为逻辑', safeText(profile.behaviorLogic)],
    ['价值观', safeText(profile.values)],
    ['禁忌', safeText(profile.taboos)],
    ['说话风格', safeText(profile.speakingStyle)],
  ];
  return candidates
    .filter((pair): pair is [string, string] => Boolean(pair[1]))
    .map(([k, v]) => `- ${k}: ${truncateChars(v, 200)}`)
    .join('\n');
}

export function buildReadingTopicsPrompt(args: {
  agent: Agent;
  ownerProfile: XingyeRoleProfile | null | undefined;
  recentSceneBlock: string;
  stableLoreBlock: string;
}): string {
  const { agent, ownerProfile, recentSceneBlock, stableLoreBlock } = args;
  const profileBlock = profileLines(ownerProfile) || '（无可用 profile）';
  const recentBlock = recentSceneBlock?.trim() ? truncateChars(recentSceneBlock, 2200) : '（暂无最近聊天上下文）';
  const loreBlock = stableLoreBlock?.trim() ? truncateChars(stableLoreBlock, 1800) : '（暂无 lore）';
  const name = safeText(ownerProfile?.displayName) || safeText(agent.name) || 'TA';

  return [
    `你是一位读书策展人，要根据下面这个虚拟角色「${name}」的画像、最近聊天和设定，推断 TA 自己可能感兴趣的「书籍类别」。`,
    '',
    '硬性要求：',
    `1) 输出 4-${MAX_TOPICS} 个类别，按相关度从高到低。`,
    '2) 每个类别的 subject 字段必须是 Open Library subject 风格的小写英文短语（1-3 个词，例如 "science fiction"、"medical ethics"、"war memoir"、"philosophy of mind"）。不要标点、不要书名、不要作者名。',
    '3) 每个类别给一个 ≤12 字的中文 label（chip 上展示），以及一个 ≤40 字的中文 reason（解释为什么 TA 会读这类书）。',
    '4) 不要重复同一英文 subject。',
    '5) 严格输出 JSON：{"topics":[{"subject":"...","label":"...","reason":"..."}]}。不要 markdown、不要解释。',
    '',
    '【角色画像】',
    profileBlock,
    '',
    '【最近聊天上下文】',
    recentBlock,
    '',
    '【固定设定 / 常驻 lore】',
    loreBlock,
  ].join('\n');
}

export function normalizeReadingTopicsResult(raw: unknown): XingyeReadingTopicSuggestion[] {
  if (!raw || typeof raw !== 'object') return [];
  const record = raw as Record<string, unknown>;
  const rawList = Array.isArray(record.topics)
    ? record.topics
    : Array.isArray(record.subjects)
      ? record.subjects
      : Array.isArray(record.items)
        ? record.items
        : [];
  const out: XingyeReadingTopicSuggestion[] = [];
  const seen = new Set<string>();
  for (const entry of rawList) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const obj = entry as Record<string, unknown>;
    const subjectRaw = typeof obj.subject === 'string' ? obj.subject.trim().toLowerCase() : '';
    const labelRaw = typeof obj.label === 'string' ? obj.label.trim() : '';
    const reasonRaw = typeof obj.reason === 'string' ? obj.reason.trim() : '';
    if (!subjectRaw || !SUBJECT_PATTERN.test(subjectRaw)) continue;
    if (seen.has(subjectRaw)) continue;
    seen.add(subjectRaw);
    const label = labelRaw ? truncateChars(labelRaw, 12) : subjectRaw;
    const suggestion: XingyeReadingTopicSuggestion = { subject: subjectRaw, label };
    if (reasonRaw) suggestion.reason = truncateChars(reasonRaw, 40);
    out.push(suggestion);
    if (out.length >= MAX_TOPICS) break;
  }
  return out;
}

/**
 * 调用 `POST /api/xingye/phone-generate`（`kind: reading_topics`），让模型根据角色画像 + 最近聊天 + 常驻 lore
 * 推断 TA 可能感兴趣的「书籍类别」。返回 Open Library subject 风格的小写英文短语（用于喂 search API）+ 中文展示 label。
 * 不写入任何存储；不调用 Open Library。
 */
export async function inferReadingTopicsWithAI(
  params: InferReadingTopicsParams,
): Promise<XingyeReadingTopicSuggestion[]> {
  const { agent, ownerProfile } = params;
  const timeoutMs = params.timeoutMs ?? 60_000;

  const recentContext = collectRecentContextForAgent({ agentId: agent.id });
  const recentSceneBlock = describeRecentContextForPrompt(recentContext);
  const stableLoreBlock = buildStableLoreBlock(agent.id, 1800);

  const prompt = buildReadingTopicsPrompt({
    agent,
    ownerProfile,
    recentSceneBlock,
    stableLoreBlock,
  });

  const response = await hanaFetch('/api/xingye/phone-generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    timeout: timeoutMs,
    body: JSON.stringify({
      kind: 'reading_topics',
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
        .filter(Boolean)
        .join('；')}`
      : '';
    throw new Error(`${data?.error || '模型调用失败'}${details}`);
  }

  const topics = normalizeReadingTopicsResult(data?.result);
  if (!topics.length) {
    throw new Error('模型未返回可用的阅读类别');
  }
  return topics;
}
