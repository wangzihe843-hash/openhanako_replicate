/**
 * 为占卜占法解析器构建完整角色背景语料（profile + 磁盘 lore/entries.json），
 * 仅纳入 enabled=true 的设定；不绕过 enabled=false 的「不引用」语义。
 */

import type { Agent } from '../types';
import { readXingyeRoleProfile, type XingyeRoleProfile } from './xingye-profile-store';
import {
  loreEntriesFromAgentLoreJsonBody,
  type XingyeLoreEntry,
  XINGYE_LORE_CATEGORIES,
} from './xingye-lore-store';
import { buildXingyeLoreRuntimeQueryText, collectMatchedKeywords } from './xingye-lore-runtime-context';
import type { XingyeDivinationAgentLike } from './xingye-divination-method-resolver';
import { createAgentXingyeStorageBackend } from './xingye-storage-backend';
import { postXingyeStorage } from './xingye-storage-api';

const LORE_ENTRIES_RELATIVE_PATH = 'lore/entries.json';
const MAX_LORE_CORPUS_CHARS = 24_000;
const ALWAYS_FULL_CANONICAL = 8_000;
const ALWAYS_SLICE_PRIVATE = 2_000;
const ALWAYS_SLICE_DRAFT = 800;
const MANUAL_CONTENT_SLICE = 600;

const divinationReadBackend = createAgentXingyeStorageBackend(postXingyeStorage);

const STABLE_LORE_CATEGORIES = new Set<string>(XINGYE_LORE_CATEGORIES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeTopLevelLoreJson(raw: unknown): Record<string, unknown> {
  if (Array.isArray(raw)) {
    const tmp: Record<string, unknown> = {};
    for (let i = 0; i < raw.length; i += 1) {
      const row = raw[i];
      if (!isRecord(row)) continue;
      const id = typeof row.id === 'string' && row.id.trim() ? row.id.trim() : String(i);
      tmp[id] = row;
    }
    return tmp;
  }
  if (isRecord(raw)) return raw;
  return {};
}

function visibilityRank(v: XingyeLoreEntry['visibility']): number {
  if (v === 'canonical') return 0;
  if (v === 'private') return 1;
  return 2;
}

function sortEnabledLoreForDivination(entries: XingyeLoreEntry[]): XingyeLoreEntry[] {
  return [...entries].sort((a, b) => {
    const vr = visibilityRank(a.visibility) - visibilityRank(b.visibility);
    if (vr !== 0) return vr;
    if (b.priority !== a.priority) return b.priority - a.priority;
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}

function sliceContent(raw: string, max: number): string {
  if (raw.length <= max) return raw;
  return `${raw.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * 单条 enabled lore 拼入占卜语料（不处理 enabled=false；调用方需先过滤）。
 */
function buildEnabledLoreCorpusChunk(entry: XingyeLoreEntry, keywordQueryText: string): { text: string; title: string } | null {
  if (!STABLE_LORE_CATEGORIES.has(entry.category)) return null;

  const title = entry.title.trim();
  const kwLine = entry.keywords.length ? `  关键词：${entry.keywords.join('、')}` : '';
  const keywordHit = collectMatchedKeywords(entry.keywords, keywordQueryText, []).length > 0;

  if (entry.insertionMode === 'always') {
    let body = '';
    if (entry.visibility === 'canonical') {
      body = sliceContent(entry.content, ALWAYS_FULL_CANONICAL);
    } else if (entry.visibility === 'private') {
      body = sliceContent(entry.content, ALWAYS_SLICE_PRIVATE);
    } else {
      body = sliceContent(entry.content, ALWAYS_SLICE_DRAFT);
    }
    const lines = [`- 标题：${title}`, kwLine, `  内容：${body}`].filter((x) => x && x.trim());
    return { text: lines.join('\n'), title };
  }

  if (entry.insertionMode === 'manual') {
    const body = sliceContent(entry.content, MANUAL_CONTENT_SLICE);
    const lines = [`- 标题：${title}`, `  插入：manual（摘要）`, kwLine, `  内容摘录：${body}`].filter((x) => x && x.trim());
    return { text: lines.join('\n'), title };
  }

  if (entry.insertionMode === 'keyword') {
    const lines: string[] = [`- 标题：${title}`, kwLine].filter((x) => x && x.trim()) as string[];
    if (keywordHit) {
      lines.push(`  内容：${sliceContent(entry.content, ALWAYS_FULL_CANONICAL)}`);
    }
    return { text: lines.join('\n'), title };
  }

  return null;
}

export type DivinationResolverContextBuilt = {
  agentLike: XingyeDivinationAgentLike;
  /** 供调试与二次处理：合并后的纯文本体积 */
  contextText: string;
  contextLength: number;
  /** 人类可读来源标签 */
  contextSources: string[];
  /** 磁盘 entries 中 enabled=false 的条数（未将其 content 纳入语料） */
  loreSkippedDisabledCount: number;
  /** 实际写入 extraCorpus 的 enabled lore 标题 */
  enabledLoreTitlesInCorpus: string[];
  /** 无 enabled lore 文本纳入占卜语料（仅 profile 等） */
  profileOnlyNoEnabledLore: boolean;
};

function profileToAgentLike(profile: XingyeRoleProfile, agent: Agent | null): XingyeDivinationAgentLike {
  return {
    name: agent?.name ?? profile.displayName,
    yuan: agent?.yuan,
    displayName: profile.displayName ?? agent?.name,
    shortBio: profile.shortBio,
    identitySummary: profile.identitySummary,
    backgroundSummary: profile.backgroundSummary,
    personalitySummary: profile.personalitySummary,
    relationshipLabel: profile.relationshipLabel,
    speakingStyle: profile.speakingStyle,
    values: profile.values,
    taboos: profile.taboos,
    relationshipMode: profile.relationshipMode,
    behaviorLogic: profile.behaviorLogic,
    gender: profile.gender,
  };
}

export type BuildDivinationResolverContextOptions = {
  /** 当前问卜问题：用于 keyword 型 lore 是否允许纳入全文 */
  divinationQuestion?: string | null;
};

/**
 * 从 agentId 读取 `xingye/profile.json`（经 readXingyeRoleProfile）、合并可选内存 profile、
 * 读取 `lore/entries.json`（顶层 object 或兼容 array），仅纳入 enabled=true 的 lore 文本。
 */
export async function buildDivinationResolverContext(
  agentId: string,
  agent: Agent | null,
  profileFallback?: XingyeRoleProfile | null,
  options?: BuildDivinationResolverContextOptions,
): Promise<DivinationResolverContextBuilt | null> {
  const id = typeof agentId === 'string' ? agentId.trim() : '';
  if (!id) return null;

  let disk: XingyeRoleProfile | null = null;
  try {
    disk = await readXingyeRoleProfile(id);
  } catch {
    disk = null;
  }
  const profile =
    disk && profileFallback
      ? { ...disk, ...profileFallback, agentId: disk.agentId, updatedAt: profileFallback.updatedAt ?? disk.updatedAt }
      : disk ?? profileFallback ?? null;

  const sources: string[] = [];
  const extraChunks: string[] = [];

  if (disk && profileFallback) {
    sources.push('xingye.profile.json', 'xingye.profile(hook_overlay)');
  } else if (disk) {
    sources.push('xingye.profile.json');
  } else if (profileFallback) {
    sources.push('xingye.profile(hook_fallback)');
  } else {
    sources.push('(no_profile_json)');
  }

  const profileQueryText = buildXingyeLoreRuntimeQueryText([
    profile?.identitySummary,
    profile?.backgroundSummary,
    profile?.shortBio,
    profile?.personalitySummary,
    profile?.behaviorLogic,
  ]);
  const divQ = typeof options?.divinationQuestion === 'string' ? options.divinationQuestion.trim() : '';
  const keywordQueryText = buildXingyeLoreRuntimeQueryText([profileQueryText, divQ]);

  let loreSkippedDisabledCount = 0;
  const enabledLoreTitlesInCorpus: string[] = [];

  let rawLore: unknown = null;
  try {
    rawLore = await divinationReadBackend.readJson<unknown>(id, LORE_ENTRIES_RELATIVE_PATH);
  } catch {
    rawLore = null;
  }

  if (rawLore != null) {
    sources.push('xingye.lore.entries.json');
  }

  const normalizedBody = normalizeTopLevelLoreJson(rawLore);
  const allParsed = loreEntriesFromAgentLoreJsonBody(normalizedBody, id);

  for (const entry of allParsed) {
    if (!entry.enabled) {
      loreSkippedDisabledCount += 1;
    }
  }

  const enabledSorted = sortEnabledLoreForDivination(allParsed.filter((e) => e.enabled));

  let loreTotal = 0;
  for (const entry of enabledSorted) {
    const built = buildEnabledLoreCorpusChunk(entry, keywordQueryText);
    if (!built) continue;
    if (loreTotal + built.text.length > MAX_LORE_CORPUS_CHARS) break;
    extraChunks.push(built.text);
    loreTotal += built.text.length;
    enabledLoreTitlesInCorpus.push(built.title);
    sources.push(`xingye.lore.entries.json:${built.title}`);
  }

  const contextText = extraChunks.filter(Boolean).join('\n\n');
  const profileOnlyNoEnabledLore = enabledLoreTitlesInCorpus.length === 0;

  if (rawLore != null && profileOnlyNoEnabledLore) {
    sources.push('[notice]未读取到纳入占法上下文的 enabled lore，仅使用 profile 摘要');
  }

  const base: XingyeDivinationAgentLike = profile
    ? profileToAgentLike(profile, agent)
    : {
        name: agent?.name,
        yuan: agent?.yuan,
      };

  const agentLike: XingyeDivinationAgentLike = {
    ...base,
    extraCorpus: contextText.trim() || undefined,
  };

  const profileCorpusLen = [
    base.displayName,
    base.shortBio,
    base.identitySummary,
    base.backgroundSummary,
    base.personalitySummary,
    base.relationshipLabel,
    base.speakingStyle,
    base.values,
    base.taboos,
    base.relationshipMode,
    base.behaviorLogic,
    base.description,
    base.era,
    base.culture,
  ]
    .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    .join('\n').length;

  const contextLength = profileCorpusLen + contextText.length;

  return {
    agentLike,
    contextText,
    contextLength,
    contextSources: sources,
    loreSkippedDisabledCount,
    enabledLoreTitlesInCorpus,
    profileOnlyNoEnabledLore,
  };
}
