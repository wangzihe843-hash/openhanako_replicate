import { hanaFetch } from '../hooks/use-hana-fetch';
import type { Agent } from '../types';
import type { XingyeRoleProfile } from './xingye-profile-store';
import { peekDeskHeartbeatUiOutcome } from './xingye-desk-heartbeat-memory';
import {
  buildNewsEraAgentLike,
  resolveNewsEra,
  type NewsEraResolution,
} from './xingye-news-era-resolver';
import { getNewsEraStyle } from './xingye-news-era-style';
import { buildNewsDraftPrompt } from './xingye-news-prompts';
import {
  normalizeNewsEntryMetadata,
  type NewsEntryMetadata,
} from './xingye-news-types';
import {
  buildXingyeLoreRuntimeQueryText,
  collectXingyeLoreRuntimeContext,
  formatXingyeLoreRuntimeContextBlock,
} from './xingye-lore-runtime-context';
import { XINGYE_LORE_CATEGORY_LABELS, listLoreEntries } from './xingye-lore-store';
import { listAppEntries } from './xingye-app-entry-store';
import { getXingyePersistenceStorage } from './xingye-persistence';
import {
  collectRecentContextForAgent,
  describeRecentContextForPrompt,
} from './xingye-recent-context';
import {
  buildXingyeRecentChatExcerpts,
  formatXingyeRecentChatExcerptsForPrompt,
  resolveXingyeSpeakerUserName,
} from './xingye-speaker-context';
import { getRelationshipState } from './xingye-state-store';
import { postXingyeStorage } from './xingye-storage-api';

function truncateChars(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * 读 lore-memory.md（与 shopping-ai 同款）。失败 / 缺失 → null。
 */
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
  try {
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
  } catch {
    return '';
  }
}

async function buildStableLoreBlock(agentId: string): Promise<string> {
  const fromFile = await readLoreMemoryMarkdown(agentId);
  if (fromFile && fromFile.trim()) return truncateChars(fromFile, 3200);
  return buildStableLoreFromAlwaysEntries(agentId, 2800).trim();
}

/**
 * 新闻模块专属"反重复锚点"。
 *
 * 从已生成的 news entries 抽样：
 *  - 最近 8 期 masthead（要求本期与已用过的保持同名报头）
 *  - 最近 8 期 headline_world 标题 + 第一句（要求本期换主题、不要重复世界线大事）
 *  - 最近 4 期感情类板块（gossip/interview/review）的开头 30 字（要求本期换笔调或切口）
 *
 * 没有历史数据 → 返回空字符串，prompt 端会渲染「（无；这是 TA 的第一期报纸）」。
 */
async function buildNewsContinuityAnchorBlock(agentId: string): Promise<string> {
  try {
    const rows = await listAppEntries(agentId, 'news');
    if (!rows.length) return '';
    const mastheadSeen = new Set<string>();
    const mastheadSamples: string[] = [];
    const headlineSamples: string[] = [];
    const relationshipSamples: string[] = [];
    for (const row of rows) {
      const meta = (row.metadata ?? {}) as Record<string, unknown>;
      const masthead = typeof meta.masthead === 'string' ? meta.masthead.trim() : '';
      if (masthead && !mastheadSeen.has(masthead) && mastheadSamples.length < 8) {
        mastheadSeen.add(masthead);
        mastheadSamples.push(masthead);
      }
      const sections = Array.isArray(meta.sections) ? meta.sections : [];
      for (const s of sections) {
        if (!s || typeof s !== 'object') continue;
        const section = s as Record<string, unknown>;
        const kind = typeof section.kind === 'string' ? section.kind : '';
        const title = typeof section.title === 'string' ? section.title.trim() : '';
        const body = typeof section.body === 'string' ? section.body.trim() : '';
        if (!kind || !body) continue;
        if (kind === 'headline_world' && headlineSamples.length < 8) {
          const firstLine = body.split('\n')[0]?.slice(0, 40) ?? '';
          headlineSamples.push(title ? `${title}：${firstLine}` : firstLine);
        }
        if (
          (kind === 'gossip_column' || kind === 'interview' || kind === 'review')
          && relationshipSamples.length < 4
        ) {
          const opener = body.slice(0, 30);
          relationshipSamples.push(`[${kind}] ${opener}`);
        }
      }
      if (
        mastheadSamples.length >= 8
        && headlineSamples.length >= 8
        && relationshipSamples.length >= 4
      ) break;
    }
    if (!mastheadSamples.length && !headlineSamples.length && !relationshipSamples.length) return '';
    const lines: string[] = [];
    if (mastheadSamples.length) {
      lines.push(`- 近期报头样本（请沿用同一报名）：${mastheadSamples.map((m) => `「${m}」`).join('、')}`);
    }
    if (headlineSamples.length) {
      lines.push(`- 近期头版要闻摘录（请换不同主题，不要重复）：`);
      for (const h of headlineSamples) {
        lines.push(`  · ${h}`);
      }
    }
    if (relationshipSamples.length) {
      lines.push(`- 近期感情类板块开头（请换笔调或切口）：`);
      for (const r of relationshipSamples) {
        lines.push(`  · ${r}`);
      }
    }
    return lines.join('\n');
  } catch {
    return '';
  }
}

function formatRelationshipBlock(agentId: string): string {
  try {
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
  } catch {
    return '';
  }
}

function profilePartsForQuery(profile: XingyeRoleProfile | null | undefined): string[] {
  if (!profile) return [];
  return [
    profile.displayName,
    profile.shortBio,
    profile.identitySummary,
    profile.backgroundSummary,
    profile.personalitySummary,
    profile.relationshipLabel,
    profile.values,
    profile.taboos,
    profile.relationshipMode,
  ].filter((part): part is string => typeof part === 'string' && part.trim().length > 0);
}

/**
 * 调 `POST /api/xingye/phone-generate`（kind: news_draft），生成一整期报纸。
 *
 * 不写入存储，调用方拿到 NewsEntryMetadata 后用 appendAppEntry('news', ...) 自行落地。
 * 任意上下文（profile/lore/recent chat/heartbeat/relationship）缺失都优雅降级为「（无）」。
 */
export async function generateNewsDraftWithAI(params: {
  agent: Agent;
  ownerProfile: XingyeRoleProfile | null | undefined;
  /** 用户在弹窗里写的"今天想读什么"提示（可空）。 */
  userIntent?: string;
  userName?: string;
  timeoutMs?: number;
  /** 当期出版日（ISO）。不传则用 new Date().toISOString()。 */
  issueDateIso?: string;
}): Promise<NewsEntryMetadata> {
  const { agent, ownerProfile } = params;
  const timeoutMs = params.timeoutMs ?? 90_000;
  const userIntent = params.userIntent?.trim() ?? '';
  const issueDateIso = params.issueDateIso?.trim() || new Date().toISOString();
  const userName = await resolveXingyeSpeakerUserName(params.userName);
  const agentName = ownerProfile?.displayName?.trim() || agent.name || '当前角色';

  const stableLoreBlock = await buildStableLoreBlock(agent.id);
  const continuityAnchorBlock = await buildNewsContinuityAnchorBlock(agent.id);

  let recentContext;
  try {
    recentContext = collectRecentContextForAgent({ agentId: agent.id });
  } catch {
    recentContext = { messages: [], summaryText: '' } as unknown as ReturnType<typeof collectRecentContextForAgent>;
  }

  let recentSceneBlock = '';
  try {
    const recentChatExcerpts = buildXingyeRecentChatExcerpts({
      context: recentContext,
      userName,
      agentName,
    });
    recentSceneBlock =
      formatXingyeRecentChatExcerptsForPrompt(recentChatExcerpts) ||
      describeRecentContextForPrompt(recentContext);
  } catch {
    try {
      recentSceneBlock = describeRecentContextForPrompt(recentContext);
    } catch {
      recentSceneBlock = '';
    }
  }

  const relationshipBlock = formatRelationshipBlock(agent.id);
  const heartbeatLine = peekDeskHeartbeatUiOutcome(agent.id);
  const heartbeatBlock = heartbeatLine ? heartbeatLine.trim() : '';

  const queryText = buildXingyeLoreRuntimeQueryText([
    ...profilePartsForQuery(ownerProfile ?? null),
    userName,
    agentName,
    userIntent,
    typeof recentContext.summaryText === 'string' ? recentContext.summaryText : '',
    relationshipBlock,
    stableLoreBlock.slice(0, 2000),
    heartbeatLine ?? '',
  ]);

  let keywordLoreBlock = '';
  try {
    const keywordCtx = collectXingyeLoreRuntimeContext(agent.id, {
      purpose: 'generic',
      queryText,
      maxChars: 2000,
      includeAlways: false,
      includeKeyword: true,
    });
    keywordLoreBlock = formatXingyeLoreRuntimeContextBlock(keywordCtx);
  } catch {
    keywordLoreBlock = '';
  }

  // 按 agent profile + lore 识别 era（民国小报闲笔体 / 西方译文体 / 现代狗仔体）。
  // resolver 失败 / 抛错 → 兜底 modern_or_future（最通用，最不容易出戏）。
  let eraResolution: NewsEraResolution;
  try {
    const eraAgentLike = buildNewsEraAgentLike(agent, ownerProfile ?? null, {
      extraCorpus: stableLoreBlock || null,
      lore: keywordLoreBlock || null,
    });
    eraResolution = resolveNewsEra(eraAgentLike);
  } catch {
    eraResolution = {
      era: 'modern_or_future',
      score: 0,
      scores: { oriental_classical: 0, western_fantasy: 0, modern_or_future: 0 },
      matchedTerms: [],
      reason: 'resolver 异常 fallback。',
    };
  }
  const eraStyle = getNewsEraStyle(eraResolution.era);

  const prompt = buildNewsDraftPrompt({
    agent,
    userName,
    profile: ownerProfile,
    issueDateIso,
    userIntent,
    recentSceneBlock,
    stableLoreBlock,
    keywordLoreBlock,
    relationshipBlock,
    heartbeatBlock,
    continuityAnchorBlock,
    era: eraResolution.era,
    eraStyle,
  });

  const response = await hanaFetch('/api/xingye/phone-generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    timeout: timeoutMs,
    body: JSON.stringify({
      kind: 'news_draft',
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

  // 模型可能返回 { issueDate?, masthead, sections }；强制把当期 issueDateIso 覆盖回去，
  // 即使模型乱写日期也以系统时间为准。
  const rawResult = (data?.result && typeof data.result === 'object' && !Array.isArray(data.result))
    ? { ...(data.result as Record<string, unknown>), issueDate: issueDateIso }
    : null;

  const normalized = normalizeNewsEntryMetadata(rawResult);
  if (!normalized) {
    throw new Error('模型返回无效：缺少 masthead / sections 或字段不合规。');
  }
  return normalized;
}
