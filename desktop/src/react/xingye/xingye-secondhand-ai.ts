import { hanaFetch } from '../hooks/use-hana-fetch';
import type { Agent } from '../types';
import type { XingyeRoleProfile } from './xingye-profile-store';
import { peekDeskHeartbeatUiOutcome } from './xingye-desk-heartbeat-memory';
import { parseImaginedPriceToMoney } from './xingye-money';
import { parseChineseTimeHint } from './xingye-app-history-state';
import {
  buildSecondhandDraftPrompt,
  buildSecondhandPolishPrompt,
  SECONDHAND_AI_PLATFORM_STYLES,
  SECONDHAND_AI_STATUSES,
} from './xingye-secondhand-prompts';
import { buildSecondhandBuyerChatPrompt } from './xingye-secondhand-buyer-chat-prompts';
import {
  readSecondhandBuyerChat,
  saveSecondhandBuyerChat,
} from './xingye-secondhand-buyer-chat-store';
import type {
  SecondhandBuyerChat,
  SecondhandBuyerChatMessage,
  SecondhandBuyerChatStatus,
} from './xingye-secondhand-buyer-chat-store';
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

export type XingyeSecondhandAiStatus = (typeof SECONDHAND_AI_STATUSES)[number];
export type XingyeSecondhandAiPlatformStyle = (typeof SECONDHAND_AI_PLATFORM_STYLES)[number];

export type SecondhandHistoryMode = {
  kind: 'initial' | 'recent' | 'gap_fill';
  dayRangeHint: string;
  startDays: number;
  endDays: number;
};

export type XingyeSecondhandAiDraft = {
  itemName: string;
  status: XingyeSecondhandAiStatus;
  platformStyle: XingyeSecondhandAiPlatformStyle;
  category?: string;
  /**
   * TA 想象里这件东西能卖出的价格感，不带货币符号外的修饰。
   * 见 xingye-secondhand-prompts.ts 的 schema 说明。
   */
  askingPrice?: string;
  /**
   * 价格 delta 短语（"比当初买价低 220" / "卖不上价" / "居然有人加价收"），不带货币符号。
   */
  delta?: string;
  /**
   * 买家 / 接手人（"巷口的旧书客" / "楼下收旧货的"）。虚构买家口吻；非真实电商平台。
   */
  buyer?: string;
  /**
   * 由 askingPrice 本地解析出的数值金额（见 parseImaginedPriceToMoney）。
   * LLM 只产 askingPrice 氛围文本，amount / currency 在 normalize 阶段本地确定性提取，
   * 让记账模块按币种求和无需回头再做映射。「约换一只新壶」等 fallback 写法解析不出来 → undefined。
   */
  amount?: number;
  /** amount 配对的货币单位（¥ / $ / 两银子 / 金币 / 信用点 …）。 */
  currency?: string;
  reason?: string;
  tags?: string[];
  content: string;
  /** 历史批量模式才会回填：「N 天前」/「昨天」等自然语言时间感。 */
  occurredAtHint?: string;
  /** 由 occurredAtHint 解析得到的 ISO；不可解析时为 undefined。 */
  occurredAt?: string;
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
 * 读取当前 agent 已有的二手 entries，提取里面用过的 askingPrice / buyer 样本，
 * 作为「货币 / 买家锚点」喂回 prompt。让模型在仙侠 / 废土 / 未来这类世界观货币
 * 没有 lore 显式定义时**沿用历史已用过的单位**——避免今天写"灵石"明天写"金锭"。
 *
 * 三层兜底关系（prompt 端会严格执行）：
 *   1. lore 里显式定义的货币（用户在设定库里写过的）→ 绝对优先
 *   2. 本函数返回的历史锚点 → 已有 entries 用过什么单位就接着用
 *   3. 都没有 → 这是 TA 第一次写二手记录，按 prompt 指南候选集挑一个
 *
 * 采样策略：
 *   - listAppEntries 默认按 updatedAt 倒序；取前若干条
 *   - askingPrice 去重保留前 6 个、buyer 去重保留前 4 个（频次隐式靠"最近优先"）
 *   - 完全没有 → 返回 ''；prompt 端会显示「（无；这是 TA 第一次写）」
 *
 * 失败（agentId 非法 / 读盘错）→ 返回 ''，generation 主流程不受影响。
 */
async function buildSecondhandCurrencyAnchorBlock(agentId: string): Promise<string> {
  try {
    const rows = await listAppEntries(agentId, 'secondhand');
    if (!rows.length) return '';
    const priceSamples: string[] = [];
    const buyerSamples: string[] = [];
    const priceSeen = new Set<string>();
    const buyerSeen = new Set<string>();
    for (const row of rows) {
      const meta = (row.metadata ?? {}) as Record<string, unknown>;
      const price = typeof meta.askingPrice === 'string' ? meta.askingPrice.trim() : '';
      const buyer = typeof meta.buyer === 'string' ? meta.buyer.trim() : '';
      if (price && !priceSeen.has(price) && priceSamples.length < 6) {
        priceSeen.add(price);
        priceSamples.push(price);
      }
      if (buyer && !buyerSeen.has(buyer) && buyerSamples.length < 4) {
        buyerSeen.add(buyer);
        buyerSamples.push(buyer);
      }
      if (priceSamples.length >= 6 && buyerSamples.length >= 4) break;
    }
    if (!priceSamples.length && !buyerSamples.length) return '';
    const lines: string[] = [];
    if (priceSamples.length) {
      lines.push(`- 价格表达样本：${priceSamples.map((p) => `「${p}」`).join('、')}`);
    }
    if (buyerSamples.length) {
      lines.push(`- 买家口吻样本：${buyerSamples.map((s) => `「${s}」`).join('、')}`);
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

function normalizeStatus(value: unknown): XingyeSecondhandAiStatus {
  return (SECONDHAND_AI_STATUSES as readonly string[]).includes(value as string)
    ? (value as XingyeSecondhandAiStatus)
    : 'to_sell';
}

function normalizePlatformStyle(value: unknown): XingyeSecondhandAiPlatformStyle {
  return (SECONDHAND_AI_PLATFORM_STYLES as readonly string[]).includes(value as string)
    ? (value as XingyeSecondhandAiPlatformStyle)
    : 'generic';
}

/** 解析时间感自然语言 → ISO（支持中文数字与模糊词；见 parseChineseTimeHint）。 */
const parseOccurredAtHintSecondhand = parseChineseTimeHint;

export function normalizeSecondhandDraftResult(raw: unknown): XingyeSecondhandAiDraft | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const itemName = typeof record.itemName === 'string' ? record.itemName.trim() : '';
  const content = typeof record.content === 'string' ? record.content.trim() : '';
  if (!itemName) return null;
  const askingPrice = normalizeOptional(record.askingPrice, 60);
  const money = parseImaginedPriceToMoney(askingPrice);
  const occurredAtHint = normalizeOptional(record.occurredAtHint, 32);
  const occurredAt = parseOccurredAtHintSecondhand(occurredAtHint);
  return {
    itemName: truncateChars(itemName, 80),
    status: normalizeStatus(record.status),
    platformStyle: normalizePlatformStyle(record.platformStyle),
    category: normalizeOptional(record.category, 24),
    askingPrice,
    delta: normalizeOptional(record.delta, 32),
    buyer: normalizeOptional(record.buyer, 24),
    amount: money?.amount,
    currency: money?.currency,
    reason: normalizeOptional(record.reason, 200),
    tags: normalizeTags(record.tags),
    content: truncateChars(content, 600),
    occurredAtHint,
    occurredAt,
  };
}

/** 解析 historyMode 下模型返回的 `{ drafts: [...] }` 包络结构。无效项被丢弃。 */
export function normalizeSecondhandDraftResults(raw: unknown): XingyeSecondhandAiDraft[] {
  if (!raw) return [];
  let items: unknown[] = [];
  if (Array.isArray(raw)) {
    items = raw;
  } else if (typeof raw === 'object') {
    const drafts = (raw as Record<string, unknown>).drafts;
    if (Array.isArray(drafts)) items = drafts;
  }
  const out: XingyeSecondhandAiDraft[] = [];
  for (const item of items) {
    const normalized = normalizeSecondhandDraftResult(item);
    if (normalized) out.push(normalized);
  }
  return out;
}

/**
 * 调 `POST /api/xingye/phone-generate`（kind: secondhand_draft）。
 * 不写入二手存储，返回的草稿由调用方填到编辑框。
 *
 * 任意上下文（profile/lore/recent chat/heartbeat/relationship）缺失都优雅降级为「（无）」。
 */
export async function generateSecondhandDraftWithAI(params: {
  agent: Agent;
  ownerProfile: XingyeRoleProfile | null | undefined;
  userIntent?: string;
  userName?: string;
  timeoutMs?: number;
}): Promise<XingyeSecondhandAiDraft> {
  const { agent, ownerProfile } = params;
  const timeoutMs = params.timeoutMs ?? 90_000;
  const userIntent = params.userIntent?.trim() ?? '';
  const userName = await resolveXingyeSpeakerUserName(params.userName);
  const agentName = ownerProfile?.displayName?.trim() || agent.name || '当前角色';

  const stableLoreBlock = await buildStableLoreBlock(agent.id);
  const currencyAnchorBlock = await buildSecondhandCurrencyAnchorBlock(agent.id);

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

  const prompt = buildSecondhandDraftPrompt({
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
      kind: 'secondhand_draft',
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

  const normalized = normalizeSecondhandDraftResult(data?.result);
  if (!normalized) {
    throw new Error('模型返回无效：缺少 itemName 或 JSON 解析失败');
  }
  return normalized;
}

/**
 * 「批量历史生成」入口，返回多条二手 draft。
 * 与 generateSecondhandDraftWithAI 区别同 shopping 镜像版。
 */
export async function generateSecondhandHistoryWithAI(params: {
  agent: Agent;
  ownerProfile: XingyeRoleProfile | null | undefined;
  userIntent?: string;
  userName?: string;
  historyMode: SecondhandHistoryMode;
  desiredCount: number;
  timeoutMs?: number;
}): Promise<XingyeSecondhandAiDraft[]> {
  const { agent, ownerProfile, historyMode } = params;
  const timeoutMs = params.timeoutMs ?? 120_000;
  const userIntent = params.userIntent?.trim() ?? '';
  const desiredCount = Math.max(2, Math.min(10, Math.floor(params.desiredCount ?? 4)));
  const userName = await resolveXingyeSpeakerUserName(params.userName);
  const agentName = ownerProfile?.displayName?.trim() || agent.name || '当前角色';

  const stableLoreBlock = await buildStableLoreBlock(agent.id);
  const currencyAnchorBlock = await buildSecondhandCurrencyAnchorBlock(agent.id);

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
    recentSceneBlock = formatXingyeRecentChatExcerptsForPrompt(recentChatExcerpts)
      || describeRecentContextForPrompt(recentContext);
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

  const prompt = buildSecondhandDraftPrompt({
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
    historyMode,
    desiredCount,
  });

  const response = await hanaFetch('/api/xingye/phone-generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    timeout: timeoutMs,
    body: JSON.stringify({
      kind: 'secondhand_draft',
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

  const drafts = normalizeSecondhandDraftResults(data?.result);
  if (drafts.length === 0) {
    throw new Error('模型返回无效：未生成可用的二手记录草稿');
  }
  return drafts;
}

/**
 * 调用 polish prompt 返回的三字段子集。每个字段都可能为 undefined（模型留空字符串 → undefined）。
 * confirmSecondhandDraft 的 edits 入参把 null 当"清空"、把 undefined 当"沿用 draft"，
 * 所以这里返回 undefined 而不是空串，调用方需要自己决定是否当成"沿用"还是"清空"。
 */
export type XingyeSecondhandPolishResult = {
  askingPrice?: string;
  delta?: string;
  buyer?: string;
  /** 由润色后的 askingPrice 本地解析出的数值金额（同 normalizeSecondhandDraftResult）。 */
  amount?: number;
  /** amount 配对的货币单位。 */
  currency?: string;
};

function normalizeSecondhandPolishResult(raw: unknown): XingyeSecondhandPolishResult | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const askingPrice = normalizeOptional(record.askingPrice, 60);
  const money = parseImaginedPriceToMoney(askingPrice);
  return {
    askingPrice,
    delta: normalizeOptional(record.delta, 32),
    buyer: normalizeOptional(record.buyer, 24),
    amount: money?.amount,
    currency: money?.currency,
  };
}

/**
 * 「确认并润色价格」二段式流程的 AI 调用层。
 *
 * 与 generateSecondhandDraftWithAI 的关键区别：
 *  - 输入是**已有的 draft 全字段**（含用户在草稿卡上的临时编辑）+ lore + 历史货币锚点；
 *    不需要 recent chat / relationship / heartbeat ——那些是"灵感来源"，润色不需要。
 *  - 输出只含 { askingPrice, delta, buyer } 三个字段；itemName / content / 等
 *    由调用方在 confirmSecondhandDraft 阶段 verbatim 锁回去，模型即使乱写也不会污染正文。
 *  - kind 标签用 'secondhand_polish'，便于服务端 / 监控区分。
 */
export async function generateSecondhandPolishWithAI(params: {
  agent: Agent;
  ownerProfile: XingyeRoleProfile | null | undefined;
  draft: {
    itemName: string;
    status: string;
    category?: string;
    content?: string;
    reason?: string;
    tags?: string[];
    askingPrice?: string;
    delta?: string;
    buyer?: string;
  };
  userName?: string;
  timeoutMs?: number;
}): Promise<XingyeSecondhandPolishResult> {
  const { agent, ownerProfile, draft } = params;
  const timeoutMs = params.timeoutMs ?? 60_000;
  const userName = await resolveXingyeSpeakerUserName(params.userName);
  const agentName = ownerProfile?.displayName?.trim() || agent.name || '当前角色';

  const stableLoreBlock = await buildStableLoreBlock(agent.id);
  const currencyAnchorBlock = await buildSecondhandCurrencyAnchorBlock(agent.id);

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

  const prompt = buildSecondhandPolishPrompt({
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
      kind: 'secondhand_polish',
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

  const normalized = normalizeSecondhandPolishResult(data?.result);
  if (!normalized) {
    throw new Error('模型返回无效：JSON 解析失败');
  }
  return normalized;
}

export type SecondhandBuyerChatAiResult = {
  messages: SecondhandBuyerChatMessage[];
};

function newBuyerChatMessageId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `bc-${crypto.randomUUID()}`;
  }
  return `bc-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * LLM 只回 `{role, text}`，本地补齐 id / 时间戳：以 endIso（一般 = entry.updatedAt）为
 * 最后一条，每条往前回拨 30–180 秒，让聊天像「最近发生过的一小段」。
 * 遵循 LLM 只回定性、数值本地生成的约定。
 */
function normalizeSecondhandBuyerChatResult(
  raw: unknown,
  opts: { endIso: string; minCount: number },
): SecondhandBuyerChatAiResult | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const rawMessages = rec.messages;
  if (!Array.isArray(rawMessages) || rawMessages.length < opts.minCount) return null;

  const deltas: number[] = [];
  for (let i = 0; i < rawMessages.length; i += 1) {
    deltas.push(30 + Math.floor(Math.random() * 150));
  }
  const endMs = (() => {
    const t = Date.parse(opts.endIso);
    return Number.isFinite(t) ? t : Date.now();
  })();
  const totalSec = deltas.reduce((a, b) => a + b, 0);
  let cursorMs = endMs - totalSec * 1000;

  const out: SecondhandBuyerChatMessage[] = [];
  for (let i = 0; i < rawMessages.length; i += 1) {
    const item = rawMessages[i];
    if (!item || typeof item !== 'object') return null;
    const m = item as Record<string, unknown>;
    const role = m.role === 'seller' ? 'seller' : m.role === 'buyer' ? 'buyer' : null;
    const text = typeof m.text === 'string' ? m.text.trim() : '';
    if (!role || !text) return null;
    if (i === 0 && role !== 'buyer') return null;
    cursorMs += deltas[i] * 1000;
    out.push({
      id: newBuyerChatMessageId(),
      role,
      text: truncateChars(text, 200),
      at: new Date(cursorMs).toISOString(),
    });
  }
  return { messages: out };
}

export function pickRandomSecondhandBuyerChatCount(): number {
  return 8 + Math.floor(Math.random() * 7);
}

/**
 * append_closing 模式的归一：解析续写的 1–maxCount 条成交收尾消息。
 * 与 full 模式不同：
 *  - **不要求**第一条是 buyer（续写衔接，发话人由上下文决定）；
 *  - 时间戳从 startIso（一般 = 既有最后一条的 at）**向后**推，每条 +30–180s，
 *    让成交段排在「在谈」段之后；
 *  - 某条带 `afterDelivery: true`（模型标在「买家收到货之后」那条上）时，在它之前
 *    额外插入 **1–4 天** 的间隔——让售后反馈像隔了几天到货才发的，面板也会因此渲染
 *    出日期分隔线。隔几天由本地随机（遵循「LLM 只回定性、数值本地生成」）；
 *  - 允许返回空数组（模型没给有效消息 → 当作「沉默成交」，由调用方决定如何处理）。
 * raw 完全不是对象 / messages 不是数组 → null（硬失败，调用方据此降级为沉默）。
 */
function normalizeSecondhandBuyerChatClosing(
  raw: unknown,
  opts: { startIso: string; maxCount: number },
): SecondhandBuyerChatAiResult | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const rawMessages = rec.messages;
  if (!Array.isArray(rawMessages)) return null;
  const startMs = (() => {
    const t = Date.parse(opts.startIso);
    return Number.isFinite(t) ? t : Date.now();
  })();
  let cursorMs = startMs;
  const out: SecondhandBuyerChatMessage[] = [];
  for (let i = 0; i < rawMessages.length && out.length < opts.maxCount; i += 1) {
    const item = rawMessages[i];
    if (!item || typeof item !== 'object') continue;
    const m = item as Record<string, unknown>;
    const role = m.role === 'seller' ? 'seller' : m.role === 'buyer' ? 'buyer' : null;
    const text = typeof m.text === 'string' ? m.text.trim() : '';
    if (!role || !text) continue;
    const jitterSec = 30 + Math.floor(Math.random() * 150);
    const deliveryGapSec = m.afterDelivery === true ? (1 + Math.floor(Math.random() * 4)) * 86_400 : 0;
    cursorMs += (deliveryGapSec + jitterSec) * 1000;
    out.push({
      id: newBuyerChatMessageId(),
      role,
      text: truncateChars(text, 200),
      at: new Date(cursorMs).toISOString(),
    });
  }
  return { messages: out };
}

/**
 * 二手 buyer chat 生成入口。
 *
 * - 仅 status === 'sold' / 'negotiating' 才有意义；调用方负责守门。
 * - kind = 'secondhand_buyer_chat'；需要 server PHONE_GENERATE_KINDS 已注册。
 * - 失败抛 Error，调用方决定是否提示「重新生成」按钮。
 */
export async function generateSecondhandBuyerChatWithAI(params: {
  agent: Agent;
  ownerProfile: XingyeRoleProfile | null | undefined;
  entry: {
    id: string;
    updatedAt: string;
    metadata: {
      itemName: string;
      status: SecondhandBuyerChatStatus;
      category?: string;
      askingPrice?: string;
      delta?: string;
      buyer?: string;
      reason?: string;
      platformStyle?: string;
      tags?: string[];
    };
    content?: string;
  };
  userName?: string;
  desiredMessageCount?: number;
  /**
   * 'full'（默认）= 从零生成整段；'append_closing' = 保留 priorMessages 只续写成交收尾 1–3 条。
   * append_closing 用于挂牌从「在谈」迁移到「已售」时延续旧聊天（见 SecondhandBuyerChatPanel）。
   */
  mode?: 'full' | 'append_closing';
  /** append_closing 模式下的既有对话（之前「在谈」段）。 */
  priorMessages?: SecondhandBuyerChatMessage[];
  timeoutMs?: number;
}): Promise<SecondhandBuyerChatAiResult> {
  const { agent, ownerProfile, entry } = params;
  const timeoutMs = params.timeoutMs ?? 90_000;
  const userName = await resolveXingyeSpeakerUserName(params.userName);
  const agentName = ownerProfile?.displayName?.trim() || agent.name || '当前角色';
  const mode = params.mode ?? 'full';
  const priorMessages = params.priorMessages ?? [];
  const desiredMessageCount = params.desiredMessageCount ?? pickRandomSecondhandBuyerChatCount();

  const stableLoreBlock = await buildStableLoreBlock(agent.id);

  const queryText = buildXingyeLoreRuntimeQueryText([
    ...profilePartsForQuery(ownerProfile ?? null),
    userName,
    agentName,
    entry.metadata.itemName,
    entry.metadata.category ?? '',
    entry.metadata.buyer ?? '',
    entry.metadata.reason ?? '',
    entry.content ?? '',
    stableLoreBlock.slice(0, 2000),
  ]);

  let keywordLoreBlock = '';
  try {
    const keywordCtx = collectXingyeLoreRuntimeContext(agent.id, {
      purpose: 'generic',
      queryText,
      maxChars: 1800,
      includeAlways: false,
      includeKeyword: true,
    });
    keywordLoreBlock = formatXingyeLoreRuntimeContextBlock(keywordCtx);
  } catch {
    keywordLoreBlock = '';
  }

  const relationshipBlock = formatRelationshipBlock(agent.id);

  const prompt = buildSecondhandBuyerChatPrompt({
    agent,
    userName,
    profile: ownerProfile,
    entry: {
      itemName: entry.metadata.itemName,
      status: entry.metadata.status,
      category: entry.metadata.category,
      askingPrice: entry.metadata.askingPrice,
      delta: entry.metadata.delta,
      buyer: entry.metadata.buyer,
      reason: entry.metadata.reason,
      content: entry.content,
      platformStyle: entry.metadata.platformStyle,
      tags: entry.metadata.tags,
    },
    desiredMessageCount,
    stableLoreBlock,
    keywordLoreBlock,
    relationshipBlock,
    mode,
    priorMessages: priorMessages.map((m) => ({ role: m.role, text: m.text })),
  });

  const response = await hanaFetch('/api/xingye/phone-generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    timeout: timeoutMs,
    body: JSON.stringify({
      kind: 'secondhand_buyer_chat',
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

  if (mode === 'append_closing') {
    // 时间戳从既有最后一条之后续推；既有为空时退回 entry.updatedAt。
    const lastPrior = priorMessages.length ? priorMessages[priorMessages.length - 1] : null;
    const startIso = lastPrior?.at || entry.updatedAt;
    const normalizedClosing = normalizeSecondhandBuyerChatClosing(data?.result, {
      startIso,
      maxCount: 3,
    });
    if (!normalizedClosing) {
      throw new Error('模型返回的成交收尾数据无效（messages 缺失或格式错误）');
    }
    return normalizedClosing;
  }

  const normalized = normalizeSecondhandBuyerChatResult(data?.result, {
    endIso: entry.updatedAt,
    minCount: Math.max(4, Math.min(6, Math.floor(desiredMessageCount / 2))),
  });
  if (!normalized) {
    throw new Error('模型返回的聊天数据无效（messages 缺失或格式错误）');
  }
  return normalized;
}

/**
 * 「在谈 → 已售」迁移时（同 entryId），成交收尾的处理：
 *  - 50% 续写一小段成交收尾（1–3 条），衔接旧对话；
 *  - 50% **沉默成交**——满意收货的真实买家往往不再发消息，旧「在谈」对话原样保留即可。
 * 两种情况都把 itemStatus 标成 'sold'，避免下次打开重复触发 / 重复掷骰。
 */
export const SECONDHAND_SOLD_SILENT_PROBABILITY = 0.5;

/**
 * 拿到某条 sold/negotiating 挂牌「最终形态」的买家聊天，必要时生成 / 迁移并落盘。
 *
 * 抽出来让**买家聊天面板**和**二手互评补聊天**走同一条路径，避免两处各自迁移导致不一致
 * （例如互评基于「在谈」段生成、聊天面板却又另外续写了成交收尾，二者对不上）。
 *
 * 三条分支（与原 SecondhandBuyerChatPanel.init 同源）：
 *  - 无缓存 → 按 status 整段生成、落盘、返回（**生成失败抛出**，调用方决定报错或降级）。
 *  - 有缓存且「在谈→已售」迁移（缓存 itemStatus='negotiating' 且当前 status='sold'）→
 *    50% 沉默成交（仅升 itemStatus）、50% 续写 1–3 条成交收尾（续写失败按沉默处理，不抛）；落盘、返回。
 *  - 其它（缓存状态与当前一致）→ 原样返回缓存。
 */
export async function ensureSecondhandBuyerChat(params: {
  agent: Agent;
  ownerProfile: XingyeRoleProfile | null | undefined;
  agentId: string;
  entry: {
    id: string;
    updatedAt: string;
    content?: string;
    metadata: {
      itemName: string;
      status: SecondhandBuyerChatStatus;
      category?: string;
      askingPrice?: string;
      delta?: string;
      buyer?: string;
      reason?: string;
      platformStyle?: string;
      tags?: string[];
    };
  };
  userName?: string;
}): Promise<SecondhandBuyerChat> {
  const { agent, ownerProfile, agentId, entry, userName } = params;
  const status = entry.metadata.status;
  const buyerName = entry.metadata.buyer?.trim() || '陌生人';

  const chatEntry = {
    id: entry.id,
    updatedAt: entry.updatedAt,
    content: entry.content,
    metadata: {
      itemName: entry.metadata.itemName,
      status: 'sold' as SecondhandBuyerChatStatus,
      category: entry.metadata.category,
      askingPrice: entry.metadata.askingPrice,
      delta: entry.metadata.delta,
      buyer: entry.metadata.buyer,
      reason: entry.metadata.reason,
      platformStyle: entry.metadata.platformStyle,
      tags: entry.metadata.tags,
    },
  };

  const existing = await readSecondhandBuyerChat(agentId, entry.id);

  // 在谈 → 已售出 迁移：保留旧对话，按概率续写成交收尾，并把 itemStatus 升到 'sold'。
  if (existing && status === 'sold' && existing.itemStatus === 'negotiating') {
    let closing: SecondhandBuyerChatMessage[] = [];
    const silent = Math.random() < SECONDHAND_SOLD_SILENT_PROBABILITY;
    if (!silent) {
      try {
        const appended = await generateSecondhandBuyerChatWithAI({
          agent,
          ownerProfile,
          userName,
          entry: chatEntry,
          mode: 'append_closing',
          priorMessages: existing.messages,
        });
        closing = appended.messages;
      } catch {
        // 续写失败不阻塞：当作沉默成交，仍把状态升到 sold。
        closing = [];
      }
    }
    const upgraded: SecondhandBuyerChat = {
      ...existing,
      itemStatus: 'sold',
      messages: closing.length ? [...existing.messages, ...closing] : existing.messages,
    };
    await saveSecondhandBuyerChat(agentId, upgraded);
    return upgraded;
  }

  if (existing) return existing;

  // 无缓存 → 整段生成（按当前 status，可能是 negotiating 或 sold）。
  const result = await generateSecondhandBuyerChatWithAI({
    agent,
    ownerProfile,
    userName,
    entry: { ...chatEntry, metadata: { ...chatEntry.metadata, status } },
  });
  const record: SecondhandBuyerChat = {
    entryId: entry.id,
    buyerName,
    itemName: entry.metadata.itemName,
    itemStatus: status,
    messages: result.messages,
    generatedAt: new Date().toISOString(),
  };
  await saveSecondhandBuyerChat(agentId, record);
  return record;
}
