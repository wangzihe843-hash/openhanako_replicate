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
  NEWS_SECTION_REGISTRY,
  type NewsComment,
  type NewsEntryMetadata,
  type NewsSection,
  type NewsSectionKind,
} from './xingye-news-types';
import {
  buildXingyeLoreRuntimeQueryText,
  collectXingyeLoreRuntimeContext,
  formatXingyeLoreRuntimeContextBlock,
} from './xingye-lore-runtime-context';
import type { WorldTimelineEvent } from './xingye-news-timeline';
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
  formatXingyeSpeakerContextForPrompt,
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
 *  - 最近 4 期感情类板块（gossip/review）的开头 30 字（要求本期换笔调或切口）
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
          (kind === 'gossip_column' || kind === 'review')
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

/**
 * 把本次报纸生成实际用到的 prompt + 各上下文 block 落盘到调试文件。
 *
 * - 路径：`news/.debug/last-prompt.txt`（按 agent 隔离；每期覆盖一次）
 * - 内容：era resolve 结果（含 scores / matchedTerms / reason）、各 block 内容（原样不截断）、
 *   最后是完整 prompt。便于排查「era 对了但世界观词跑偏」「某 block 里夹带了别 era 关键词」。
 * - 失败不抛错（调试日志缺失不应阻塞主流程）。
 */
async function writeLastNewsPromptDebug(
  agentId: string,
  params: {
    era: NewsEraResolution;
    prompt: string;
    stableLoreBlock: string;
    keywordLoreBlock: string;
    recentSceneBlock: string;
    relationshipBlock: string;
    heartbeatBlock: string;
    continuityAnchorBlock: string;
    userIntent: string;
  },
): Promise<void> {
  try {
    const sections: string[] = [
      '# 小手机报纸 · 最近一次生成的调试快照',
      `# 时间：${new Date().toISOString()}`,
      `# agentId：${agentId}`,
      '',
      '## era 解析结果（只看 profile）',
      `- era：${params.era.era}`,
      `- score：${params.era.score}`,
      `- scores：${JSON.stringify(params.era.scores)}`,
      `- matchedTerms：${JSON.stringify(params.era.matchedTerms)}`,
      `- reason：${params.era.reason}`,
      '',
      '## 用户附言（userIntent）',
      params.userIntent || '（无）',
      '',
      '## stableLoreBlock（lore-memory.md / always-on canonical 条目）',
      params.stableLoreBlock || '（无）',
      '',
      '## keywordLoreBlock（按 queryText 召回的 keyword-triggered 条目）',
      params.keywordLoreBlock || '（无）',
      '',
      '## recentSceneBlock（最近聊天上下文）',
      params.recentSceneBlock || '（无）',
      '',
      '## relationshipBlock（当前关系状态）',
      params.relationshipBlock || '（无）',
      '',
      '## heartbeatBlock（最近一次桌面巡检 UI 反馈）',
      params.heartbeatBlock || '（无）',
      '',
      '## continuityAnchorBlock（历史报纸抽样，跨期防重复）',
      params.continuityAnchorBlock || '（无）',
      '',
      '## 最终拼出的 prompt（原样喂给模型）',
      params.prompt,
    ];
    await postXingyeStorage({
      action: 'write',
      agentId,
      relativePath: 'news/.debug/last-prompt.txt',
      content: sections.join('\n'),
      encoding: 'utf8',
    });
  } catch {
    // 调试日志写盘失败不影响主流程；下次再生成时还会再写一次。
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

  // 按 agent profile 识别 era（民国小报闲笔体 / 西方译文体 / 现代狗仔体）。
  //
  // **输入故意收紧到只有 profile**：
  //  - keywordLoreBlock 是按 queryText 召回的，而 queryText 里夹了 recentContext.summaryText
  //    （最近聊天总结）。如果用户跟 TA 在角色扮演带"魔晶 / 教廷 / 塔楼"的桥段，
  //    那些词会顺着 recent chat → queryText → 命中 keyword lore → 倒灌进 era resolver，
  //    把一个边境医生强行判成 western_fantasy。era 应当反映**角色根本设定**，
  //    不应被一次性的 RP 主题左右。
  //  - stableLoreBlock 是 lore-memory.md 整块，可能含用户写的额外世界观笔记，
  //    同样不是角色"根本"。
  //
  // resolver 失败 / 抛错 → 兜底 modern_or_future（最通用，最不容易出戏）。
  //
  // 这个算法**必须**与 UI 侧 PhoneNewsApp fallback 时用的输入一致（profile only），
  // 才能保证旧数据缺 era 时 UI 与生成侧给出同样的判定。
  let eraResolution: NewsEraResolution;
  try {
    const eraAgentLike = buildNewsEraAgentLike(agent, ownerProfile ?? null);
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

  // ─── 调试落盘 ────────────────────────────────────────────────────────────
  // 把本次生成实际喂给模型的完整 prompt + 各 block 的来源摘要写到磁盘，
  // 路径 `news/.debug/last-prompt.txt`（每期覆盖式更新，只保留最新一份）。
  //
  // 用途：当报纸出现"era 对但世界观词跑偏"之类问题时，用户能直接打开这份文件
  // 看到 stableLore / keywordLore / recentScene / continuity 各 block 里到底
  // 塞了什么——这才是真正能判断"prompt 是否喂混"的依据。
  //
  // fire-and-forget：写盘失败不影响生成主流程。
  void writeLastNewsPromptDebug(agent.id, {
    era: eraResolution,
    prompt,
    stableLoreBlock,
    keywordLoreBlock,
    recentSceneBlock,
    relationshipBlock,
    heartbeatBlock,
    continuityAnchorBlock,
    userIntent,
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
  // 同时把已经算好的 era 灌进 raw — normalize 会校验 era 合法性后写进 metadata。
  // 这是「era 算一次绑死」的关键：UI 渲染时直接读 metadata.era，不再二次 resolve，
  // 避免两侧因输入不同（profile vs profile+lore+recent chat）走出不一样的 era。
  const rawResult = (data?.result && typeof data.result === 'object' && !Array.isArray(data.result))
    ? {
        ...(data.result as Record<string, unknown>),
        issueDate: issueDateIso,
        era: eraResolution.era,
      }
    : null;

  const normalized = normalizeNewsEntryMetadata(rawResult);
  if (!normalized) {
    throw new Error('模型返回无效：缺少 masthead / sections 或字段不合规。');
  }
  // 兜底：即便 normalize 因为某种原因没写上（理论不应发生，因为我们刚塞了合法的 era），
  // 也手动补上一次，保证存档里**一定**有 era。
  if (!normalized.era) normalized.era = eraResolution.era;
  return normalized;
}

/* ───────────────────────────────────────────────────────────────────────────
   往期新闻：按 lore + 用户确认过的时间线，生成一张某个过去日期的报纸。

   与 generateNewsDraftWithAI 的差异：
     - 跳过 recentSceneBlock / relationshipBlock / heartbeatBlock —— 往期报纸不该读"当下状态"
     - 板块过滤：默认排除 gossip_column / review / letters_to_editor（聚焦世态时间线）
     - 注入 timelineSeed 作为当期内容素材
     - issueDateIso 由调用方算好（通常是 N 天前），强制覆盖回 result
     - era 仍按 profile 算一次，绑死写进 metadata（与今日报纸一致）
   ─────────────────────────────────────────────────────────────────────── */

/**
 * 往期新闻默认排除的板块。理由：
 *   - gossip_column / review / letters_to_editor 都是关于 TA 与用户当下关系的，
 *     往期报纸里"用户"根本不存在。
 *   - obituary 保留：允许写 NPC / 亲朋好友死亡或心情；但 prompt 里有专门铁律
 *     防止它被滥用成"与用户的感情悼念"。
 */
export const HISTORICAL_EXCLUDED_KINDS: readonly NewsSectionKind[] = [
  'gossip_column',
  'review',
  'letters_to_editor',
];

export type GenerateHistoricalNewsParams = {
  agent: Agent;
  ownerProfile: XingyeRoleProfile | null | undefined;
  /** 当期出版日（ISO）。调用方按 daysBack / issueCount 算好。 */
  issueDateIso: string;
  /** 本期要覆盖的时间线事件（通常 2-4 条）。 */
  timelineSeed: readonly WorldTimelineEvent[];
  /** 额外排除的板块；与默认的 HISTORICAL_EXCLUDED_KINDS 取并集。 */
  extraExcludeKinds?: readonly NewsSectionKind[];
  timeoutMs?: number;
};

export async function generateHistoricalNewsDraftWithAI(
  params: GenerateHistoricalNewsParams,
): Promise<NewsEntryMetadata> {
  const { agent, ownerProfile, issueDateIso, timelineSeed } = params;
  const timeoutMs = params.timeoutMs ?? 90_000;
  const agentName = ownerProfile?.displayName?.trim() || agent.name || '当前角色';
  const userName = agentName; // 占位，historical 模式下 prompt 不会引用用户行为；仍传一份避免空字符串

  // lore + 跨期连续性锚点：往期报纸仍需 lore（世界观素材）和 continuity（沿用同一报名）。
  const stableLoreBlock = await buildStableLoreBlock(agent.id);
  const continuityAnchorBlock = await buildNewsContinuityAnchorBlock(agent.id);

  // keyword 触发的 lore：用时间线种子的标题 / 概述做查询文本，召回相关条目。
  const queryText = buildXingyeLoreRuntimeQueryText([
    ...profilePartsForQuery(ownerProfile ?? null),
    ...timelineSeed.map((e) => `${e.title} ${e.summary}`),
    stableLoreBlock.slice(0, 1500),
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

  // era 解析：与今日报纸完全同源，确保 UI 渲染分发用同一笔调。
  let eraResolution: NewsEraResolution;
  try {
    const eraAgentLike = buildNewsEraAgentLike(agent, ownerProfile ?? null);
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

  // 排除的板块：默认 + 用户额外提供的。
  const excludeKinds = Array.from(
    new Set<NewsSectionKind>([
      ...HISTORICAL_EXCLUDED_KINDS,
      ...(params.extraExcludeKinds ?? []),
    ]),
  );

  const prompt = buildNewsDraftPrompt({
    agent,
    userName,
    profile: ownerProfile,
    issueDateIso,
    userIntent: '', // historical 模式不接受 userIntent；语义由 timelineSeed 承载
    recentSceneBlock: '', // historical 模式下不注入；prompt 端也跳过 header
    stableLoreBlock,
    keywordLoreBlock,
    relationshipBlock: '',
    heartbeatBlock: '',
    continuityAnchorBlock,
    era: eraResolution.era,
    eraStyle,
    historicalMode: true,
    excludeKinds,
    timelineSeed,
  });

  // 调试落盘（与今日报纸分文件名，便于对照）。fire-and-forget。
  void postXingyeStorage({
    action: 'write',
    agentId: agent.id,
    relativePath: 'news/.debug/last-historical-prompt.txt',
    content: [
      `# 时间：${new Date().toISOString()}`,
      `# agentId：${agent.id}`,
      `# issueDateIso：${issueDateIso}`,
      `# excludeKinds：${excludeKinds.join(', ')}`,
      `# timelineSeed：${timelineSeed.length} 条`,
      ...timelineSeed.map((e, i) => `  ${i + 1}. ${e.dateLabel} | ${e.title} | ${e.summary} | scope=${e.scope}`),
      '',
      '## prompt',
      prompt,
    ].join('\n'),
    encoding: 'utf8',
  }).catch(() => {});

  const response = await hanaFetch('/api/xingye/phone-generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    timeout: timeoutMs,
    body: JSON.stringify({
      kind: 'news_historical_draft',
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
      ? `：${(data.details as { message?: string }[]).map((it) => it.message ?? '').join('；')}`
      : '';
    throw new Error(`${data?.error || '模型调用失败'}${details}`);
  }

  // 强制覆盖 issueDate + era + 过滤掉被排除的 kind（模型仍可能违反 prompt 返回它们）。
  const rawResult = (data?.result && typeof data.result === 'object' && !Array.isArray(data.result))
    ? (() => {
        const r = data.result as Record<string, unknown>;
        // 过滤 sections 里被排除的 kind
        const rawSections = Array.isArray(r.sections) ? r.sections : [];
        const filtered = rawSections.filter((s) => {
          if (!s || typeof s !== 'object') return false;
          const kind = (s as Record<string, unknown>).kind;
          return typeof kind === 'string' && !excludeKinds.includes(kind as NewsSectionKind);
        });
        return {
          ...r,
          sections: filtered,
          issueDate: issueDateIso,
          era: eraResolution.era,
        };
      })()
    : null;

  const normalized = normalizeNewsEntryMetadata(rawResult);
  if (!normalized) {
    throw new Error('模型返回无效：缺少 masthead / sections 或字段不合规。');
  }
  if (!normalized.era) normalized.era = eraResolution.era;
  return normalized;
}

/* ───────────────────────────────────────────────────────────────────────────
   AI 评论：以 agent 第一人称对自己手机里这份报纸的某段话写一句批注。

   设计：
   - 模型扮演的**不是**报刊记者，而是「在自己手机上看到这条新闻的 TA」
   - 输出 JSON: { sectionKind, highlightText, comment }
   - highlightText 必须是某 section.body 的连续子串；如果模型乱写，UI 找不到
     匹配就在 section 末尾追加一条无高亮的批注（兜底，不报错）
   ─────────────────────────────────────────────────────────────────────── */

export type GenerateNewsCommentParams = {
  agent: Agent;
  ownerProfile: XingyeRoleProfile | null | undefined;
  /** 当前完整的报纸 metadata（sections / masthead 都从这里取）。 */
  meta: NewsEntryMetadata;
  /** 已经存在的 comments（用作"避免重复评论同一段话"的反重复锚点）。 */
  existingComments?: NewsComment[];
  /** 可选：用户点了某个 section.kind 想让 AI 针对它评，省略则让模型自挑。 */
  preferredSectionKind?: NewsSectionKind;
  userName?: string;
  timeoutMs?: number;
};

function buildNewsCommentPrompt(args: {
  agentName: string;
  userName: string;
  profile: XingyeRoleProfile | null | undefined;
  meta: NewsEntryMetadata;
  existingComments: NewsComment[];
  preferredSectionKind?: NewsSectionKind;
}): string {
  const { agentName, userName, profile, meta, existingComments, preferredSectionKind } = args;
  const speakerCtx = formatXingyeSpeakerContextForPrompt({
    userName,
    agentName,
    gender: profile?.gender,
  });

  // 把 sections 列出来给模型挑——body 不截，让模型能挑准；但每段标上序号 + kind。
  const sectionLines: string[] = [];
  for (let i = 0; i < meta.sections.length; i += 1) {
    const s = meta.sections[i];
    const def = NEWS_SECTION_REGISTRY[s.kind];
    sectionLines.push(`### [${i}] kind=${s.kind}（${def?.label ?? s.kind}）—— ${s.title}${s.byline ? ` · 署名「${s.byline}」` : ''}`);
    sectionLines.push(s.body);
    sectionLines.push('');
  }

  const existingLines: string[] = existingComments.length
    ? existingComments.map((c) => `- 在 ${c.sectionKind} 板块对「${c.highlightText}」已批注过：「${c.comment}」`)
    : ['（无；这是本期的第 1 条批注）'];

  const preferredLine = preferredSectionKind
    ? `用户希望本次针对 \`${preferredSectionKind}\` 板块写一句批注。请挑这一段里**最让你有反应**的一句原文做 highlightText。`
    : '请自己挑一个**最让你有反应**的板块（任意 kind 都可），然后从那段 body 里抽一句原文做 highlightText。';

  return [
    `你将扮演 ${agentName}（即 TA）本人。${agentName} 正在自己的手机上读这份对自己所处世界的报道。`,
    '你**不是**报刊记者，**也不是**第三方专栏作者；你是 TA 本人，对屏幕上某一句话有一闪而过的反应，'
    + '把它写成一条**很短的内心独白式批注**（像在书页上画线 + 在旁边写一行小字）。',
    '',
    '## 视角硬约束',
    `- 以 **${agentName}** 第一人称写。可以用「我」「咱」「俺」「在下」之类符合 TA 笔调的自称（参考下方 profile 的 speakingStyle）。`,
    `- ${userName}（即用户）若被报纸提到，可以在批注里出现，但你不是在跟 ${userName} 对话，而是在自言自语。`,
    `- 不要出现「根据这篇报道」「报道说」「文中提到」等元叙述；批注是 TA **当下的反应**，不是 TA 在评论新闻文体。`,
    '- 不要泄漏「prompt」「模型」「AI」「设定库」「OpenHanako」「星野」等系统词。',
    '- 字数：comment 严格控制在 12-60 字之间。短不怕，长一定不要。',
    '',
    '## highlightText 硬约束（重要）',
    '- highlightText 必须是下面 sections 列表里某一段 body 的**逐字连续子串**——一字不能差。',
    '- 不要写省略号、不要改字、不要加引号、不要把多段拼起来。',
    '- 长度 6-50 字之间。最理想是一句话（句号 / 逗号截止）；也可以是半句，但不要只截一个词。',
    '- 选最能勾住 TA 当下情绪 / 让 TA 想反驳 / 让 TA 心头一动的那一句话。',
    '',
    preferredLine,
    '',
    '## 反重复',
    '本期报纸的已有批注（请避免针对同一句话重复写）：',
    ...existingLines,
    '',
    '## 当前角色 profile',
    JSON.stringify({ name: agentName, profile: profile ?? null }, null, 2),
    '',
    speakerCtx,
    '',
    '## 报纸本期内容（一次性给你；请挑一句话做 highlightText）',
    `报头：${meta.masthead}`,
    '',
    ...sectionLines,
    '',
    '## 输出 JSON schema（结构必须严格一致；额外字段会被丢弃）',
    JSON.stringify(
      {
        sectionKind: '上面 sections 列表里实际出现的某个 kind',
        highlightText: '上面 sections[].body 里的逐字连续子串',
        comment: 'TA 第一人称的批注，12-60 字',
      },
      null,
      2,
    ),
    '',
    '## 收尾',
    '现在生成 JSON 对象本身，不要 ```json``` 围栏，不要解释文字。',
  ].join('\n');
}

/**
 * 校验并把模型返回的原始 JSON 包装成一条 NewsComment。
 *
 * 关键的安全网：highlightText 必须出现在它声称的 section.body 里——这是 UI 高亮
 * 能正常工作的前提。如果模型把 highlightText 微改 / 拼接了，做 fallback：取
 * 该 section.body 的前 24 字做 highlight，这样至少 UI 还能展示一条评论而不报错。
 */
function buildCommentFromModelResult(
  raw: unknown,
  meta: NewsEntryMetadata,
): NewsComment | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const kindRaw = typeof r.sectionKind === 'string' ? r.sectionKind.trim() : '';
  const targetSection: NewsSection | undefined = meta.sections.find((s) => s.kind === kindRaw);
  if (!targetSection) return null;
  const commentRaw = typeof r.comment === 'string' ? r.comment.trim() : '';
  if (!commentRaw) return null;
  let highlightRaw = typeof r.highlightText === 'string' ? r.highlightText.trim() : '';
  // strip 引号——模型偶尔会把 highlightText 包在「」/""里
  highlightRaw = highlightRaw.replace(/^[「『"'“‘]+/, '').replace(/[」』"'”’]+$/, '').trim();
  // 校验：必须是 body 的连续子串
  if (!highlightRaw || !targetSection.body.includes(highlightRaw)) {
    // fallback：取 body 的前 24 字做 highlight，避免整条评论无法挂载
    highlightRaw = targetSection.body.slice(0, 24);
  }
  return {
    id: `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    sectionKind: targetSection.kind,
    highlightText: highlightRaw.slice(0, 60),
    comment: commentRaw.slice(0, 80),
    createdAt: new Date().toISOString(),
  };
}

/**
 * 调 `POST /api/xingye/phone-generate`（kind: news_comment），生成一条 NewsComment。
 * 不写存储；调用方拿到 NewsComment 后用 updateAppEntry 把它合并进 metadata.comments。
 */
export async function generateNewsCommentWithAI(params: GenerateNewsCommentParams): Promise<NewsComment> {
  const { agent, ownerProfile, meta } = params;
  const timeoutMs = params.timeoutMs ?? 60_000;
  const userName = await resolveXingyeSpeakerUserName(params.userName);
  const agentName = ownerProfile?.displayName?.trim() || agent.name || '当前角色';
  const existing = Array.isArray(params.existingComments) ? params.existingComments : [];

  const prompt = buildNewsCommentPrompt({
    agentName,
    userName,
    profile: ownerProfile,
    meta,
    existingComments: existing,
    preferredSectionKind: params.preferredSectionKind,
  });

  // 调试落盘（与报纸生成同款，不同文件名）。fire-and-forget。
  void postXingyeStorage({
    action: 'write',
    agentId: agent.id,
    relativePath: 'news/.debug/last-comment-prompt.txt',
    content: [
      `# 时间：${new Date().toISOString()}`,
      `# agentId：${agent.id}`,
      `# preferredSectionKind：${params.preferredSectionKind ?? '(未指定，模型自选)'}`,
      `# existingComments：${existing.length} 条`,
      '',
      '## 最终拼出的 prompt（原样喂给模型）',
      prompt,
    ].join('\n'),
    encoding: 'utf8',
  }).catch(() => {});

  const response = await hanaFetch('/api/xingye/phone-generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    timeout: timeoutMs,
    body: JSON.stringify({
      kind: 'news_comment',
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

  const comment = buildCommentFromModelResult(data?.result, meta);
  if (!comment) {
    throw new Error('模型返回无效：缺少 sectionKind / highlightText / comment 或字段不合规。');
  }
  return comment;
}
