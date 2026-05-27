/**
 * 记账原生收支草稿的 LLM 生成层。
 *
 * 与购物 / 二手 AI 的关键差异：
 *  - 一次调用返回 1–3 条草稿（数组），覆盖收 / 支两个方向、多个分类——
 *    模拟"一周日常的现金流"而不是"单笔交易"，因为人不会一次只想到一件事。
 *  - 不生成"具体物品的购买 / 出手"——那归购物 / 二手模块覆盖。
 *  - amount 由 imaginedAmount 文本本地用 parseImaginedPriceToMoney 解析；
 *    解析失败的草稿在 normalize 阶段被**丢弃**（因为记账 draft 要求 amount 必填）。
 */

import { hanaFetch } from '../hooks/use-hana-fetch';
import type { Agent } from '../types';
import type { XingyeRoleProfile } from './xingye-profile-store';
import { peekDeskHeartbeatUiOutcome } from './xingye-desk-heartbeat-memory';
import { parseImaginedPriceToMoney } from './xingye-money';
import {
  ACCOUNTING_AI_DIRECTIONS,
  buildAccountingDraftPrompt,
} from './xingye-accounting-prompts';
import type { AccountingDirection } from './xingye-accounting-drafts';
import { hasMultipleJobsByProfile } from './xingye-accounting-dedupe';
import { parseChineseTimeHint } from './xingye-app-history-state';
import {
  buildXingyeLoreRuntimeQueryText,
  collectXingyeLoreRuntimeContext,
  formatXingyeLoreRuntimeContextBlock,
} from './xingye-lore-runtime-context';
import { XINGYE_LORE_CATEGORY_LABELS, listLoreEntries } from './xingye-lore-store';
import { listAppEntries } from './xingye-app-entry-store';
import {
  isStrictMonthlyCategory,
  normalizeCategory,
} from './xingye-spending-categories';
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

export type XingyeAccountingAiDraft = {
  /** 摘要 / 条目名（"五月薪俸""这个月房租"）。 */
  title: string;
  direction: AccountingDirection;
  /** 数值金额，由 imaginedAmount 本地解析（见 parseImaginedPriceToMoney）。 */
  amount: number;
  /** amount 配对的货币单位（¥ / $ / 两银子 / 金币 / 信用点 …）。 */
  currency: string;
  /** 模型给的氛围金额文本（保留供 UI 展示，便于用户判断是否修改）。 */
  imaginedAmount?: string;
  category?: string;
  /** 付款方 / 收款方。 */
  counterparty?: string;
  /** 模型给的时间感文本（"上周二""三天前"），原文保留供 UI 展示。 */
  occurredAtHint?: string;
  /** occurredAtHint 解析后的 ISO；解析不出来则 undefined，由 UI / 草稿存储回退 createdAt。 */
  occurredAt?: string;
  reason?: string;
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
 * 读取当前 agent 已有的记账 entries，提取 currency / category / counterparty 样本，
 * 作为「货币 / 分类 / 对手方锚点」喂回 prompt。让模型跨次生成稳定（不漂移）。
 *
 * 缺省（首次生成 / 历史读取失败）→ 返回空字符串，prompt 端会显示
 * 「（无；这是 TA 第一次记账）」。
 */
async function buildAccountingAnchorBlock(agentId: string): Promise<string> {
  try {
    const rows = await listAppEntries(agentId, 'accounting');
    if (!rows.length) return '';
    const currencySamples: string[] = [];
    const categorySamples: string[] = [];
    const counterpartySamples: string[] = [];
    const currencySeen = new Set<string>();
    const categorySeen = new Set<string>();
    const counterpartySeen = new Set<string>();
    for (const row of rows) {
      const meta = (row.metadata ?? {}) as Record<string, unknown>;
      const currency = typeof meta.currency === 'string' ? meta.currency.trim() : '';
      const category = typeof meta.category === 'string' ? meta.category.trim() : '';
      const counterparty = typeof meta.counterparty === 'string' ? meta.counterparty.trim() : '';
      if (currency && !currencySeen.has(currency) && currencySamples.length < 4) {
        currencySeen.add(currency);
        currencySamples.push(currency);
      }
      if (category && !categorySeen.has(category) && categorySamples.length < 8) {
        categorySeen.add(category);
        categorySamples.push(category);
      }
      if (counterparty && !counterpartySeen.has(counterparty) && counterpartySamples.length < 6) {
        counterpartySeen.add(counterparty);
        counterpartySamples.push(counterparty);
      }
      if (
        currencySamples.length >= 4
        && categorySamples.length >= 8
        && counterpartySamples.length >= 6
      ) break;
    }
    if (!currencySamples.length && !categorySamples.length && !counterpartySamples.length) return '';
    const lines: string[] = [];
    if (currencySamples.length) {
      lines.push(`- 已用货币：${currencySamples.map((c) => `「${c}」`).join('、')}`);
    }
    if (categorySamples.length) {
      lines.push(`- 已用分类：${categorySamples.map((c) => `「${c}」`).join('、')}`);
    }
    if (counterpartySamples.length) {
      lines.push(`- 已用对手方：${counterpartySamples.map((c) => `「${c}」`).join('、')}`);
    }
    return lines.join('\n');
  } catch {
    return '';
  }
}

/**
 * 读取已有记账 entries，按 (年-月, 严格月度类目) 聚合，喂回 prompt 作为「这些月里
 * 这些月度类目已经记过、不要再生成」锚点。
 *
 * 严格月度类目（房租 / 水电 / 通讯 / 保险 / 工资 …）在现实里就是一个月最多 1 条——
 * 反复点「批量新增」时，如果不告诉模型已经生成过哪一月的房租，它会乐此不疲地塞
 * 「这个月房租」「这个月房租」给同一个月两次。
 *
 * 只回望最近 6 个自然月，避免 prompt 体积失控。
 * 落地的入库 dedupe 在 PhoneAccountingApp.runBulkGeneration 里做硬过滤兜底。
 */
async function buildMonthlyCoverageBlock(agentId: string): Promise<string> {
  try {
    const rows = await listAppEntries(agentId, 'accounting');
    if (!rows.length) return '';
    const byMonth = new Map<string, Set<string>>();
    const now = new Date();
    const sixMonthsAgoMs = new Date(
      now.getFullYear(), now.getMonth() - 5, 1,
    ).getTime();
    for (const row of rows) {
      const meta = (row.metadata ?? {}) as Record<string, unknown>;
      const rawCategory = typeof meta.category === 'string' ? meta.category : '';
      const category = normalizeCategory(rawCategory);
      if (!category || !isStrictMonthlyCategory(category)) continue;
      const occurredRaw = typeof meta.occurredAt === 'string' ? meta.occurredAt : row.createdAt;
      const parsed = Date.parse(occurredRaw);
      if (!Number.isFinite(parsed)) continue;
      if (parsed < sixMonthsAgoMs) continue;
      const d = new Date(parsed);
      const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      let set = byMonth.get(ym);
      if (!set) {
        set = new Set<string>();
        byMonth.set(ym, set);
      }
      set.add(category);
    }
    if (byMonth.size === 0) return '';
    const ordered = [...byMonth.entries()].sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0));
    return ordered
      .map(([ym, cats]) => `- ${ym}：已记【${[...cats].join(' / ')}】`)
      .join('\n');
  } catch {
    return '';
  }
}

/**
 * 读取近 14 天的 accounting entries，按 YYYY-MM-DD 把每天已记过的 title 列出来，
 * 喂回 prompt 作为「这一天已经发生过这些条目，不要再生成」反面锚点。
 *
 * 解决场景：用户反复点「批量新增」，AI 在两次独立调用里各自生成了
 *   `"2026-05-27 巷口面摊午饭 / 餐饮 / ¥18"`——同标题、同金额，等于一天吃了
 * 两顿一模一样的午饭。Prompt 端把已记的 title-by-day 喂回去，让模型从源头避开。
 *
 * 入库前还有 filterSameDayDuplicates 做硬兜底（同 title 或 同四元组），
 * 但 prompt 提示能减少 token 浪费——模型一开始就不要生成重复的。
 *
 * 体积控制：每天最多 6 个 title，整体最多 14 天，单 title 截到 24 字。
 */
async function buildRecentTitlesBlock(agentId: string): Promise<string> {
  try {
    const rows = await listAppEntries(agentId, 'accounting');
    if (!rows.length) return '';
    const now = new Date();
    const cutoffMs = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() - 14,
    ).getTime();
    const byDay = new Map<string, string[]>();
    for (const row of rows) {
      const meta = (row.metadata ?? {}) as Record<string, unknown>;
      const occurredRaw = typeof meta.occurredAt === 'string' ? meta.occurredAt : row.createdAt;
      const parsed = Date.parse(occurredRaw);
      if (!Number.isFinite(parsed)) continue;
      if (parsed < cutoffMs) continue;
      const d = new Date(parsed);
      const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const title = typeof meta.title === 'string' && meta.title.trim()
        ? meta.title.trim()
        : row.title.trim();
      if (!title) continue;
      const trimmed = title.length > 24 ? `${title.slice(0, 23)}…` : title;
      let arr = byDay.get(ymd);
      if (!arr) {
        arr = [];
        byDay.set(ymd, arr);
      }
      if (arr.length < 6 && !arr.includes(trimmed)) arr.push(trimmed);
    }
    if (byDay.size === 0) return '';
    const ordered = [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0));
    return ordered
      .map(([ymd, titles]) => `- ${ymd}：${titles.map((t) => `「${t}」`).join('、')}`)
      .join('\n');
  } catch {
    return '';
  }
}

/**
 * 读取购物 / 二手最近的 itemName 摘要喂回 prompt，作为「已被其它模块覆盖」反面 anchor。
 * 防止 LLM 把"买了相机 ¥1200"这类已属购物模块的记录又塞进记账草稿。
 */
async function buildCoveredByOthersBlock(agentId: string): Promise<string> {
  try {
    const [shoppingRows, secondhandRows] = await Promise.all([
      listAppEntries(agentId, 'shopping').catch(() => []),
      listAppEntries(agentId, 'secondhand').catch(() => []),
    ]);
    const shoppingNames: string[] = [];
    const secondhandNames: string[] = [];
    const seen = new Set<string>();
    for (const row of shoppingRows) {
      const meta = (row.metadata ?? {}) as Record<string, unknown>;
      const name = typeof meta.itemName === 'string' ? meta.itemName.trim() : row.title.trim();
      if (name && !seen.has(name) && shoppingNames.length < 6) {
        seen.add(name);
        shoppingNames.push(name);
      }
    }
    for (const row of secondhandRows) {
      const meta = (row.metadata ?? {}) as Record<string, unknown>;
      const name = typeof meta.itemName === 'string' ? meta.itemName.trim() : row.title.trim();
      if (name && !seen.has(name) && secondhandNames.length < 6) {
        seen.add(name);
        secondhandNames.push(name);
      }
    }
    if (!shoppingNames.length && !secondhandNames.length) return '';
    const lines: string[] = [];
    if (shoppingNames.length) {
      lines.push(`- 购物模块已记：${shoppingNames.map((n) => `「${n}」`).join('、')}`);
    }
    if (secondhandNames.length) {
      lines.push(`- 二手模块已记：${secondhandNames.map((n) => `「${n}」`).join('、')}`);
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

function normalizeDirection(value: unknown): AccountingDirection {
  return (ACCOUNTING_AI_DIRECTIONS as readonly string[]).includes(value as string)
    ? (value as AccountingDirection)
    : 'expense';
}

/**
 * 解析时间感自然语言（"昨天" / "上周二" / "三天前" / "2026-05-12"）为 ISO 字符串。
 *
 * 策略：先试原生 Date.parse 兜底处理 ISO / 常见日期格式；不行就匹配一些常见的
 * 中文相对时间 token。完全识别不出来 → undefined，由调用方回退 createdAt。
 */
function parseOccurredAtHint(hint: string | undefined): string | undefined {
  return parseChineseTimeHint(hint);
}


/**
 * 规范化单条草稿。amount 解析失败时返回 null（被调用方过滤掉），
 * 因为记账 draft 要求 amount 必填、非负。
 */
export function normalizeAccountingDraftResult(raw: unknown): XingyeAccountingAiDraft | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const title = typeof record.title === 'string' ? record.title.trim() : '';
  const content = typeof record.content === 'string' ? record.content.trim() : '';
  if (!title) return null;

  const imaginedAmount = normalizeOptional(record.imaginedAmount, 60);
  const money = parseImaginedPriceToMoney(imaginedAmount);
  if (!money || money.amount === undefined || !money.currency) {
    return null;
  }

  const occurredAtHint = normalizeOptional(record.occurredAtHint, 32);
  const occurredAt = parseOccurredAtHint(occurredAtHint);

  return {
    title: truncateChars(title, 80),
    direction: normalizeDirection(record.direction),
    amount: money.amount,
    currency: money.currency,
    imaginedAmount,
    category: normalizeOptional(record.category, 24),
    counterparty: normalizeOptional(record.counterparty, 40),
    occurredAtHint,
    occurredAt,
    reason: normalizeOptional(record.reason, 200),
    content: truncateChars(content, 600),
  };
}

/**
 * 规范化模型返回的 { drafts: [...] } 包络结构。
 * 兼容模型偶尔直接返回数组的情况。无效项被丢弃，但不抛错——
 * 调用方拿到空数组 / 短数组时再决定是否报错。
 */
export function normalizeAccountingDraftResults(raw: unknown): XingyeAccountingAiDraft[] {
  if (!raw) return [];
  let items: unknown[] = [];
  if (Array.isArray(raw)) {
    items = raw;
  } else if (typeof raw === 'object') {
    const drafts = (raw as Record<string, unknown>).drafts;
    if (Array.isArray(drafts)) items = drafts;
  }
  const out: XingyeAccountingAiDraft[] = [];
  for (const item of items) {
    const normalized = normalizeAccountingDraftResult(item);
    if (normalized) out.push(normalized);
  }
  return out;
}

/**
 * 调 `POST /api/xingye/phone-generate`（kind: accounting_draft）。
 * 不写入记账存储，返回的草稿数组由调用方分别存草稿或填编辑框。
 *
 * 任意上下文（profile/lore/recent chat/heartbeat/relationship）缺失都优雅降级为「（无）」。
 *
 * 返回的数组可能少于 desiredCount——因为 amount 解析失败的项会被丢弃。
 * 全失败 → 抛 Error 让调用方提示用户。
 */
export type AccountingHistoryMode = {
  kind: 'initial' | 'recent' | 'gap_fill';
  dayRangeHint: string;
  startDays: number;
  endDays: number;
};

export async function generateAccountingDraftsWithAI(params: {
  agent: Agent;
  ownerProfile: XingyeRoleProfile | null | undefined;
  userIntent?: string;
  userName?: string;
  desiredCount?: number;
  timeoutMs?: number;
  /**
   * 「批量历史生成」专用上下文。无 → 走原 1-3 条 propose-draft 路径。
   * 有 → 自动放宽 desiredCount 上限到 12，要求每条 occurredAtHint 必填且分布在过去范围。
   */
  historyMode?: AccountingHistoryMode;
}): Promise<XingyeAccountingAiDraft[]> {
  const { agent, ownerProfile, historyMode } = params;
  const timeoutMs = params.timeoutMs ?? 120_000;
  const userIntent = params.userIntent?.trim() ?? '';
  const countMax = historyMode ? 12 : 3;
  const desiredCount = Math.max(1, Math.min(countMax, Math.floor(params.desiredCount ?? 3)));
  const userName = await resolveXingyeSpeakerUserName(params.userName);
  const agentName = ownerProfile?.displayName?.trim() || agent.name || '当前角色';

  const [
    stableLoreBlock,
    anchorBlock,
    coveredByOthersBlock,
    monthlyCoverageBlock,
    recentTitlesBlock,
  ] = await Promise.all([
    buildStableLoreBlock(agent.id),
    buildAccountingAnchorBlock(agent.id),
    buildCoveredByOthersBlock(agent.id),
    buildMonthlyCoverageBlock(agent.id),
    buildRecentTitlesBlock(agent.id),
  ]);

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

  // 检查 agent 是否有兼职 / 倒班 / 跑单等"一天通勤多次"职业；
  // 是 → prompt 端不强求"通勤一天 1 次"约束，入库前的 commute slot 去重也跳过。
  const agentHasMultipleJobs = hasMultipleJobsByProfile(ownerProfile ?? null);

  const prompt = buildAccountingDraftPrompt({
    agent,
    userName,
    profile: ownerProfile,
    userIntent,
    recentSceneBlock,
    stableLoreBlock,
    keywordLoreBlock,
    relationshipBlock,
    heartbeatBlock,
    anchorBlock,
    coveredByOthersBlock,
    monthlyCoverageBlock,
    recentTitlesBlock,
    agentHasMultipleJobs,
    desiredCount,
    historyMode,
  });

  const response = await hanaFetch('/api/xingye/phone-generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    timeout: timeoutMs,
    body: JSON.stringify({
      kind: 'accounting_draft',
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

  const drafts = normalizeAccountingDraftResults(data?.result);
  if (drafts.length === 0) {
    throw new Error('模型返回无效：未生成可用的记账草稿（金额或货币解析失败）');
  }
  return drafts;
}
