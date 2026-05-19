import { hanaFetch } from '../hooks/use-hana-fetch';
import type { Agent } from '../types';
import type { XingyeRoleProfile } from './xingye-profile-store';
import { peekDeskHeartbeatUiOutcome } from './xingye-desk-heartbeat-memory';
import {
  buildShoppingDraftPrompt,
  buildShoppingPolishPrompt,
  SHOPPING_AI_PLATFORM_STYLES,
  SHOPPING_AI_STATUSES,
} from './xingye-shopping-prompts';
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

export type XingyeShoppingAiStatus = (typeof SHOPPING_AI_STATUSES)[number];
export type XingyeShoppingAiPlatformStyle = (typeof SHOPPING_AI_PLATFORM_STYLES)[number];

export type XingyeShoppingAiDraft = {
  itemName: string;
  status: XingyeShoppingAiStatus;
  platformStyle: XingyeShoppingAiPlatformStyle;
  category?: string;
  imaginedPrice?: string;
  /**
   * 价格 delta 短语（"比想象便宜 220" / "凑得起" / "比预算高 60"），不带货币符号。
   * 见 xingye-shopping-prompts.ts 的 schema 说明。
   */
  delta?: string;
  /**
   * 卖家 / 店名（"光阴二手店" / "街口那家成衣"）。虚构小店口吻；非真实电商平台。
   */
  seller?: string;
  reason?: string;
  tags?: string[];
  content: string;
};

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

/**
 * 读取当前 agent 已有的购物 entries，提取里面用过的 imaginedPrice / seller 样本，
 * 作为「货币 / 卖家锚点」喂回 prompt。让模型在仙侠 / 废土 / 未来这类世界观货币
 * 没有 lore 显式定义时**沿用历史已用过的单位**——避免今天写"灵石"明天写"金锭"。
 *
 * 三层兜底关系（prompt 端会严格执行）：
 *   1. lore 里显式定义的货币（用户在设定库里写过的）→ 绝对优先
 *   2. 本函数返回的历史锚点 → 已有 entries 用过什么单位就接着用
 *   3. 都没有 → 这是 TA 第一次写购物清单，按 prompt 指南候选集挑一个
 *
 * 采样策略：
 *   - listAppEntries 默认按 updatedAt 倒序；取前若干条
 *   - imaginedPrice 去重保留前 6 个、seller 去重保留前 4 个（频次隐式靠"最近优先"）
 *   - 完全没有 → 返回 ''；prompt 端会显示「（无；这是 TA 第一次写）」
 *
 * 失败（agentId 非法 / 读盘错）→ 返回 ''，generation 主流程不受影响。
 */
async function buildShoppingCurrencyAnchorBlock(agentId: string): Promise<string> {
  try {
    const rows = await listAppEntries(agentId, 'shopping');
    if (!rows.length) return '';
    const priceSamples: string[] = [];
    const sellerSamples: string[] = [];
    const priceSeen = new Set<string>();
    const sellerSeen = new Set<string>();
    for (const row of rows) {
      const meta = (row.metadata ?? {}) as Record<string, unknown>;
      const price = typeof meta.imaginedPrice === 'string' ? meta.imaginedPrice.trim() : '';
      const seller = typeof meta.seller === 'string' ? meta.seller.trim() : '';
      if (price && !priceSeen.has(price) && priceSamples.length < 6) {
        priceSeen.add(price);
        priceSamples.push(price);
      }
      if (seller && !sellerSeen.has(seller) && sellerSamples.length < 4) {
        sellerSeen.add(seller);
        sellerSamples.push(seller);
      }
      if (priceSamples.length >= 6 && sellerSamples.length >= 4) break;
    }
    if (!priceSamples.length && !sellerSamples.length) return '';
    const lines: string[] = [];
    if (priceSamples.length) {
      lines.push(`- 价格表达样本：${priceSamples.map((p) => `「${p}」`).join('、')}`);
    }
    if (sellerSamples.length) {
      lines.push(`- 卖家口吻样本：${sellerSamples.map((s) => `「${s}」`).join('、')}`);
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

function normalizeOptional(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text) return undefined;
  return truncateChars(text, max);
}

function normalizeTags(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const t = item.trim();
    if (!t) continue;
    out.push(t.slice(0, 24));
    if (out.length >= 8) break;
  }
  return out.length ? out : undefined;
}

function normalizeStatus(value: unknown): XingyeShoppingAiStatus {
  return (SHOPPING_AI_STATUSES as readonly string[]).includes(value as string)
    ? (value as XingyeShoppingAiStatus)
    : 'wanted';
}

function normalizePlatformStyle(value: unknown): XingyeShoppingAiPlatformStyle {
  return (SHOPPING_AI_PLATFORM_STYLES as readonly string[]).includes(value as string)
    ? (value as XingyeShoppingAiPlatformStyle)
    : 'generic';
}

export function normalizeShoppingDraftResult(raw: unknown): XingyeShoppingAiDraft | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const itemName = typeof record.itemName === 'string' ? record.itemName.trim() : '';
  const content = typeof record.content === 'string' ? record.content.trim() : '';
  if (!itemName) return null;
  return {
    itemName: truncateChars(itemName, 80),
    status: normalizeStatus(record.status),
    platformStyle: normalizePlatformStyle(record.platformStyle),
    category: normalizeOptional(record.category, 24),
    imaginedPrice: normalizeOptional(record.imaginedPrice, 60),
    delta: normalizeOptional(record.delta, 32),
    seller: normalizeOptional(record.seller, 24),
    reason: normalizeOptional(record.reason, 200),
    tags: normalizeTags(record.tags),
    content: truncateChars(content, 600),
  };
}

/**
 * 调 `POST /api/xingye/phone-generate`（kind: shopping_draft）。
 * 不写入购物存储，返回的草稿由调用方填到编辑框。
 *
 * 任意上下文（profile/lore/recent chat/heartbeat/relationship）缺失都优雅降级为「（无）」。
 */
export async function generateShoppingDraftWithAI(params: {
  agent: Agent;
  ownerProfile: XingyeRoleProfile | null | undefined;
  userIntent?: string;
  userName?: string;
  timeoutMs?: number;
}): Promise<XingyeShoppingAiDraft> {
  const { agent, ownerProfile } = params;
  const timeoutMs = params.timeoutMs ?? 90_000;
  const userIntent = params.userIntent?.trim() ?? '';
  const userName = await resolveXingyeSpeakerUserName(params.userName);
  const agentName = ownerProfile?.displayName?.trim() || agent.name || '当前角色';

  const stableLoreBlock = await buildStableLoreBlock(agent.id);
  const currencyAnchorBlock = await buildShoppingCurrencyAnchorBlock(agent.id);

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

  const prompt = buildShoppingDraftPrompt({
    agent,
    userName,
    profile: ownerProfile,
    userIntent,
    recentSceneBlock,
    stableLoreBlock,
    keywordLoreBlock,
    relationshipBlock,
    heartbeatBlock,
    currencyAnchorBlock,
  });

  const response = await hanaFetch('/api/xingye/phone-generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    timeout: timeoutMs,
    body: JSON.stringify({
      kind: 'shopping_draft',
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

  const normalized = normalizeShoppingDraftResult(data?.result);
  if (!normalized) {
    throw new Error('模型返回无效：缺少 itemName 或 JSON 解析失败');
  }
  return normalized;
}

/**
 * 调用 polish prompt 返回的三字段子集。每个字段都可能为 undefined（模型留空字符串 → undefined）。
 * confirmShoppingDraft 的 edits 入参把 null 当"清空"、把 undefined 当"沿用 draft"，
 * 所以这里返回 undefined 而不是空串，调用方需要自己决定是否当成"沿用"还是"清空"。
 */
export type XingyeShoppingPolishResult = {
  imaginedPrice?: string;
  delta?: string;
  seller?: string;
};

function normalizeShoppingPolishResult(raw: unknown): XingyeShoppingPolishResult | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  return {
    imaginedPrice: normalizeOptional(record.imaginedPrice, 60),
    delta: normalizeOptional(record.delta, 32),
    seller: normalizeOptional(record.seller, 24),
  };
}

/**
 * 「确认并润色价格」二段式流程的 AI 调用层。
 *
 * 与 generateShoppingDraftWithAI 的关键区别：
 *  - 输入是**已有的 draft 全字段**（含用户在草稿卡上的临时编辑）+ lore + 历史货币锚点；
 *    不需要 recent chat / relationship / heartbeat ——那些是"灵感来源"，润色不需要。
 *  - 输出只含 { imaginedPrice, delta, seller } 三个字段；itemName / content / 等
 *    由调用方在 confirmShoppingDraft 阶段 verbatim 锁回去，模型即使乱写也不会污染正文。
 *  - kind 标签用 'shopping_polish'，便于服务端 / 监控区分。
 */
export async function generateShoppingPolishWithAI(params: {
  agent: Agent;
  ownerProfile: XingyeRoleProfile | null | undefined;
  draft: {
    itemName: string;
    status: string;
    category?: string;
    content?: string;
    reason?: string;
    tags?: string[];
    imaginedPrice?: string;
    delta?: string;
    seller?: string;
  };
  userName?: string;
  timeoutMs?: number;
}): Promise<XingyeShoppingPolishResult> {
  const { agent, ownerProfile, draft } = params;
  const timeoutMs = params.timeoutMs ?? 60_000;
  const userName = await resolveXingyeSpeakerUserName(params.userName);
  const agentName = ownerProfile?.displayName?.trim() || agent.name || '当前角色';

  const stableLoreBlock = await buildStableLoreBlock(agent.id);
  const currencyAnchorBlock = await buildShoppingCurrencyAnchorBlock(agent.id);

  const queryText = buildXingyeLoreRuntimeQueryText([
    ...profilePartsForQuery(ownerProfile ?? null),
    userName,
    agentName,
    draft.itemName,
    draft.category ?? '',
    draft.content ?? '',
    draft.reason ?? '',
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

  const prompt = buildShoppingPolishPrompt({
    agent,
    userName,
    profile: ownerProfile,
    draft,
    stableLoreBlock,
    keywordLoreBlock,
    currencyAnchorBlock,
  });

  const response = await hanaFetch('/api/xingye/phone-generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    timeout: timeoutMs,
    body: JSON.stringify({
      kind: 'shopping_polish',
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

  const normalized = normalizeShoppingPolishResult(data?.result);
  if (!normalized) {
    throw new Error('模型返回无效：JSON 解析失败');
  }
  return normalized;
}
