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
