import { hanaFetch } from '../hooks/use-hana-fetch';
import type { Agent } from '../types';
import type { XingyeRoleProfile } from './xingye-profile-store';
import {
  buildShoppingReviewPrompt,
  buildSecondhandReviewPrompt,
} from './xingye-review-prompts';
import type {
  AppReviewSide,
  ReviewSentiment,
} from './xingye-app-review-store';
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
import {
  buildXingyeRecentChatExcerpts,
  formatXingyeRecentChatExcerptsForPrompt,
  resolveXingyeSpeakerUserName,
} from './xingye-speaker-context';
import { getRelationshipState } from './xingye-state-store';
import { postXingyeStorage } from './xingye-storage-api';

/**
 * 购物 / 二手「评价」AI 生成层。
 *
 * 遵循「LLM 只回定性核心、数值本地确定性生成」：模型每一侧只回
 * `{ reviewed, sentiment, text }`，**星级由本地从 sentiment 映射**（见 starsFromSentiment）。
 * 「默认好评」固定 5 星、不抖动。店家差评回复**固定模板为主、偶尔采用模型候选**。
 *
 * 上下文 helper（stableLore / keywordLore / recentScene / relationship）与
 * xingye-secondhand-ai.ts 同款——按本仓约定各模块各持一份拷贝，缺失都优雅降级为「（无）」。
 */

// ── 上下文 helper（镜像 xingye-secondhand-ai.ts；评价不需要 currencyAnchor / heartbeat）──

function truncateChars(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(0, max - 1))}…`;
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

type ReviewContextBlocks = {
  stableLoreBlock: string;
  keywordLoreBlock: string;
  recentSceneBlock: string;
  relationshipBlock: string;
};

/**
 * 收集评价生成所需的全部上下文块。任意一块失败 / 缺失都降级为空字符串，
 * prompt 端渲染「（无）」，不阻塞主流程。
 */
async function collectReviewContextBlocks(params: {
  agent: Agent;
  ownerProfile: XingyeRoleProfile | null | undefined;
  userName: string;
  extraQueryParts: string[];
}): Promise<ReviewContextBlocks> {
  const { agent, ownerProfile, userName, extraQueryParts } = params;
  const agentName = ownerProfile?.displayName?.trim() || agent.name || '当前角色';

  const stableLoreBlock = await buildStableLoreBlock(agent.id);

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

  const queryText = buildXingyeLoreRuntimeQueryText([
    ...profilePartsForQuery(ownerProfile ?? null),
    userName,
    agentName,
    ...extraQueryParts,
    typeof recentContext.summaryText === 'string' ? recentContext.summaryText : '',
    relationshipBlock,
    stableLoreBlock.slice(0, 2000),
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

  return { stableLoreBlock, keywordLoreBlock, recentSceneBlock, relationshipBlock };
}

// ── 定性 → 本地数值映射 ──

function normalizeSentiment(value: unknown): ReviewSentiment {
  return value === 'good' || value === 'neutral' || value === 'bad' ? value : 'good';
}

/**
 * sentiment → 星级（本地确定性 + 轻微抖动）。1–2 差评 / 3 中评 / 4–5 好评。
 * 注意：本函数仅用于 **reviewed=true** 的真实评价；「默认好评」固定 5 星、不走这里、不抖动。
 */
export function starsFromSentiment(sentiment: ReviewSentiment): number {
  if (sentiment === 'bad') return Math.random() < 0.5 ? 1 : 2;
  if (sentiment === 'neutral') return 3;
  return Math.random() < 0.5 ? 4 : 5;
}

/**
 * 把模型一侧的原始 `{reviewed, sentiment, text}` 归一成 AppReviewSide。
 * - reviewed 必须严格 === true **且** text 非空，才算"作出了评价"；否则视作"未评价"。
 * - 未评价 → 固定 5 星好评、text 空（UI 渲染「系统默认给出好评」）。
 */
export function normalizeReviewSide(by: AppReviewSide['by'], raw: unknown): AppReviewSide {
  const rec = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const text = typeof rec.text === 'string' ? rec.text.trim() : '';
  const reviewed = rec.reviewed === true && text.length > 0;
  if (!reviewed) {
    return { by, reviewed: false, stars: 5, text: '' };
  }
  const sentiment = normalizeSentiment(rec.sentiment);
  return { by, reviewed: true, stars: starsFromSentiment(sentiment), text: truncateChars(text, 60) };
}

// ── 店家差评回复 ──

/** 店家对差评的客服腔小作文模板池（固定为主时从这里随机取一条）。 */
export const SELLER_REPLY_TEMPLATES: readonly string[] = [
  '非常抱歉给您带来了不太愉快的购物体验，您反馈的问题我们已经记录下来，会认真核实改进。如有需要欢迎随时联系我们，会尽力为您处理。',
  '亲，很抱歉这次没能让您满意～收到反馈我们很重视，已经在排查问题了。给您添麻烦了，后续有任何问题都可以找我们。',
  '抱歉让您失望了。我们一向把品质放在第一位，这次的疏漏一定会认真改进。感谢您的反馈，也希望以后有机会能挽回这次的印象。',
  '看到您的评价我们心里也很不是滋味，实在抱歉。问题我们会跟进到底，给您带来的不便深表歉意，也谢谢您愿意指出来。',
];

/** 差评时店家**会回复**的概率；"可能会写一条小作文"——30% 的差评店家干脆不回。 */
const SELLER_REPLY_PROBABILITY = 0.7;

/** 回复时采用模型候选（而非固定模板）的概率；"固定为主 + 偶尔 LLM 小作文"。 */
const SELLER_REPLY_AI_PROBABILITY = 0.2;

/**
 * 决定最终的店家回复：仅在 agent 给出差评时**可能**返回非空。
 *  - 非差评 → 永远 null。
 *  - 差评 → 约 70% 概率回复（另 30% 店家不回，返回 null）；回复时约 80% 固定模板、约 20% 模型候选
 *    （候选为空时回退模板）。
 */
function resolveSellerReply(agentSide: AppReviewSide, aiCandidate: string): string | null {
  if (!(agentSide.reviewed && agentSide.stars <= 2)) return null;
  if (Math.random() >= SELLER_REPLY_PROBABILITY) return null;
  const candidate = aiCandidate.trim();
  if (candidate && Math.random() < SELLER_REPLY_AI_PROBABILITY) {
    return truncateChars(candidate, 120);
  }
  const idx = Math.floor(Math.random() * SELLER_REPLY_TEMPLATES.length);
  return SELLER_REPLY_TEMPLATES[idx] ?? SELLER_REPLY_TEMPLATES[0];
}

async function postReviewGenerate(params: {
  kind: 'shopping_review' | 'secondhand_review';
  agentId: string;
  prompt: string;
  timeoutMs: number;
}): Promise<unknown> {
  const { kind, agentId, prompt, timeoutMs } = params;
  const response = await hanaFetch('/api/xingye/phone-generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    timeout: timeoutMs,
    body: JSON.stringify({ kind, ownerAgentId: agentId, agentId, prompt, timeoutMs }),
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
  return data?.result;
}

// ── 购物评价 ──

export type ShoppingReviewResult = {
  /** 长度 1：[agent]（TA 买家评商品）。 */
  sides: AppReviewSide[];
  /** 仅 agent 差评时非空：店家小作文回复。 */
  sellerReply: string | null;
};

export function normalizeShoppingReviewResult(raw: unknown): ShoppingReviewResult {
  const rec = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const agentSide = normalizeReviewSide('agent', rec.agent);
  const aiCandidate = typeof rec.sellerReply === 'string' ? rec.sellerReply : '';
  return { sides: [agentSide], sellerReply: resolveSellerReply(agentSide, aiCandidate) };
}

export async function generateShoppingReviewWithAI(params: {
  agent: Agent;
  ownerProfile: XingyeRoleProfile | null | undefined;
  entry: {
    itemName: string;
    status: string;
    category?: string;
    seller?: string;
    reason?: string;
    imaginedPrice?: string;
    content?: string;
    tags?: string[];
  };
  userName?: string;
  timeoutMs?: number;
}): Promise<ShoppingReviewResult> {
  const { agent, ownerProfile, entry } = params;
  const timeoutMs = params.timeoutMs ?? 60_000;
  const userName = await resolveXingyeSpeakerUserName(params.userName);

  const blocks = await collectReviewContextBlocks({
    agent,
    ownerProfile,
    userName,
    extraQueryParts: [entry.itemName, entry.category ?? '', entry.seller ?? '', entry.reason ?? '', entry.content ?? ''],
  });

  const prompt = buildShoppingReviewPrompt({
    agent,
    userName,
    profile: ownerProfile,
    entry,
    ...blocks,
  });

  const result = await postReviewGenerate({ kind: 'shopping_review', agentId: agent.id, prompt, timeoutMs });
  return normalizeShoppingReviewResult(result);
}

// ── 二手互评 ──

export type SecondhandReviewResult = {
  /** 长度 2：[agent(卖家→买家), counterparty(买家→卖家/商品)]。 */
  sides: AppReviewSide[];
};

export function normalizeSecondhandReviewResult(raw: unknown): SecondhandReviewResult {
  const rec = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    sides: [normalizeReviewSide('agent', rec.seller), normalizeReviewSide('counterparty', rec.buyer)],
  };
}

export async function generateSecondhandReviewWithAI(params: {
  agent: Agent;
  ownerProfile: XingyeRoleProfile | null | undefined;
  entry: {
    itemName: string;
    status: string;
    category?: string;
    askingPrice?: string;
    delta?: string;
    buyer?: string;
    reason?: string;
    content?: string;
    tags?: string[];
  };
  /** 该 entry 的买家聊天（若有）；最高优先剧情依据。 */
  buyerChatMessages?: Array<{ role: 'buyer' | 'seller'; text: string }>;
  userName?: string;
  timeoutMs?: number;
}): Promise<SecondhandReviewResult> {
  const { agent, ownerProfile, entry, buyerChatMessages } = params;
  const timeoutMs = params.timeoutMs ?? 60_000;
  const userName = await resolveXingyeSpeakerUserName(params.userName);

  const blocks = await collectReviewContextBlocks({
    agent,
    ownerProfile,
    userName,
    extraQueryParts: [entry.itemName, entry.category ?? '', entry.buyer ?? '', entry.reason ?? '', entry.content ?? ''],
  });

  const prompt = buildSecondhandReviewPrompt({
    agent,
    userName,
    profile: ownerProfile,
    entry,
    buyerChatMessages,
    ...blocks,
  });

  const result = await postReviewGenerate({ kind: 'secondhand_review', agentId: agent.id, prompt, timeoutMs });
  return normalizeSecondhandReviewResult(result);
}
