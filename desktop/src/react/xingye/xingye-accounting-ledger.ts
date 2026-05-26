/**
 * 记账账本：把三个来源合并成一份统一账本。
 *
 *  1. accounting 模块自有的「原生收支」entries（工资 / 房租 / 餐饮 / 人情 / 利息 …）；
 *  2. shopping 模块的购物 entries —— **读取时**投影成「支出」；
 *  3. secondhand 模块的二手 entries —— **读取时**投影成「收入」。
 *
 * 关键不变量：每笔交易只有一个「家」。购物 / 二手的行永远不被复制进 accounting 自己的
 * 存储，这里只是读取期投影，所以删一条购物记录、账本下次读自然就没了——零陈旧、零同步。
 * 依赖方向单向：记账读购物 / 二手，购物 / 二手不知道记账存在。
 *
 * 不同世界观货币（¥ / 两银子 / 金币 / 信用点 …）语义上不能跨币种相加，所以汇总按
 * `currency` 分组。没填数值金额的行（购物 / 二手只写了氛围价格文本）计入「待补金额」，
 * 不参与求和。只有「已实现」的真实现金流（购物已下单 / 已收到、二手已售出、记账原生）
 * 才计入汇总——想买清单、未售出的闲置只是计划，不是账。
 */

import { listAppEntries, type AppEntry } from './xingye-app-entry-store';
import type { AccountingDirection } from './xingye-accounting-drafts';
import { normalizeAmount, normalizeCurrency } from './xingye-money';

/** 账本行的来源模块；同时也是回跳源记录用的 appId。 */
export type LedgerSource = 'accounting' | 'shopping' | 'secondhand';

/** accounting 模块自有原生收支 entry 的 metadata 形态。 */
export type AccountingEntryMetadata = {
  direction: AccountingDirection;
  /** 非负数值金额；正负由 direction 表达。 */
  amount: number;
  title: string;
  currency?: string;
  category?: string;
  counterparty?: string;
  /** 交易发生日 ISO；缺省回退 entry.createdAt。 */
  occurredAt?: string;
};

export type AccountingEntry = AppEntry & {
  appId: 'accounting';
  metadata: AccountingEntryMetadata;
};

/** 三方投影后的统一账本行。`{ source, id }` 即回跳源记录的 `{ appId, entryId }`。 */
export type LedgerEntry = {
  id: string;
  source: LedgerSource;
  /** native = accounting 自有；derived = 购物 / 二手投影而来。 */
  origin: 'native' | 'derived';
  direction: AccountingDirection;
  title: string;
  /** 数值金额；null = 金额待补（购物 / 二手只写了氛围价格文本，没填 amount）。 */
  amount: number | null;
  /** 货币单位；null = 未标注币种。 */
  currency: string | null;
  category?: string;
  /** 付款方 / 收款方（购物映射 seller、二手映射 buyer、记账用 counterparty）。 */
  counterparty?: string;
  /**
   * 是否为已实现的真实现金流：
   *  - 购物：已下单 / 已收到才算（想买 / 犹豫 / 收藏是计划，已退掉是退款）；
   *  - 二手：已售出才算（想卖 / 挂出 / 在谈 / 留下 / 撤下都没成交）；
   *  - 记账原生：恒 true。
   * 只有已实现的行参与汇总。
   */
  realized: boolean;
  /** 排序 / 显示用时间 ISO。 */
  occurredAt: string;
  /** 备注正文（源 AppEntry.content）。 */
  note?: string;
};

/** 单一币种的收支汇总。 */
export type LedgerCurrencyTotals = {
  /** 货币单位；空串表示未标注币种。 */
  currency: string;
  income: number;
  expense: number;
  /** income - expense。 */
  net: number;
  /** 该币种下计入求和的已实现行数。 */
  realizedCount: number;
};

export type LedgerSummary = {
  /** 按活跃度（收 + 支）降序的各币种汇总。 */
  byCurrency: LedgerCurrencyTotals[];
  /** 已实现但没填数值金额的行数（账本里提示用户「待补金额」）。 */
  missingAmountCount: number;
};

export type Ledger = {
  /** 全部账本行，按 occurredAt 倒序。含未实现行（realized=false），由 UI 决定是否展示。 */
  entries: LedgerEntry[];
  summary: LedgerSummary;
};

const SHOPPING_REALIZED_STATUSES = new Set(['ordered', 'received']);
const SECONDHAND_REALIZED_STATUSES = new Set(['sold']);

function normalizeDirection(value: unknown): AccountingDirection {
  return value === 'income' ? 'income' : 'expense';
}

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function readOccurredAt(value: unknown): string | undefined {
  const text = readString(value);
  if (!text) return undefined;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

/** 解析 accounting 自有原生 entry 的 metadata。 */
export function normalizeAccountingMetadata(entry: AppEntry): AccountingEntryMetadata {
  const meta = (entry.metadata ?? {}) as Record<string, unknown>;
  const title = readString(meta.title) ?? entry.title;
  const out: AccountingEntryMetadata = {
    direction: normalizeDirection(meta.direction),
    amount: normalizeAmount(meta.amount) ?? 0,
    title,
  };
  const currency = normalizeCurrency(meta.currency);
  if (currency) out.currency = currency;
  const category = readString(meta.category);
  if (category) out.category = category;
  const counterparty = readString(meta.counterparty);
  if (counterparty) out.counterparty = counterparty;
  const occurredAt = readOccurredAt(meta.occurredAt);
  if (occurredAt) out.occurredAt = occurredAt;
  return out;
}

/** accounting 原生 entry → 账本行。 */
export function projectAccountingEntry(entry: AppEntry): LedgerEntry {
  const meta = normalizeAccountingMetadata(entry);
  return {
    id: entry.id,
    source: 'accounting',
    origin: 'native',
    direction: meta.direction,
    title: meta.title,
    amount: normalizeAmount(meta.amount) ?? null,
    currency: meta.currency ?? null,
    category: meta.category,
    counterparty: meta.counterparty,
    realized: true,
    occurredAt: meta.occurredAt ?? entry.createdAt,
    note: readString(entry.content),
  };
}

/** shopping 购物 entry → 账本支出行。 */
export function projectShoppingEntry(entry: AppEntry): LedgerEntry {
  const meta = (entry.metadata ?? {}) as Record<string, unknown>;
  const status = typeof meta.status === 'string' ? meta.status : '';
  return {
    id: entry.id,
    source: 'shopping',
    origin: 'derived',
    direction: 'expense',
    title: readString(meta.itemName) ?? entry.title,
    amount: normalizeAmount(meta.amount) ?? null,
    currency: normalizeCurrency(meta.currency) ?? null,
    category: readString(meta.category),
    counterparty: readString(meta.seller),
    realized: SHOPPING_REALIZED_STATUSES.has(status),
    occurredAt: entry.updatedAt,
    note: readString(entry.content),
  };
}

/** secondhand 二手 entry → 账本收入行。 */
export function projectSecondhandEntry(entry: AppEntry): LedgerEntry {
  const meta = (entry.metadata ?? {}) as Record<string, unknown>;
  const status = typeof meta.status === 'string' ? meta.status : '';
  return {
    id: entry.id,
    source: 'secondhand',
    origin: 'derived',
    direction: 'income',
    title: readString(meta.itemName) ?? entry.title,
    amount: normalizeAmount(meta.amount) ?? null,
    currency: normalizeCurrency(meta.currency) ?? null,
    category: readString(meta.category),
    counterparty: readString(meta.buyer),
    realized: SECONDHAND_REALIZED_STATUSES.has(status),
    occurredAt: entry.updatedAt,
    note: readString(entry.content),
  };
}

function compareByOccurredAtDesc(a: LedgerEntry, b: LedgerEntry): number {
  const ta = Date.parse(a.occurredAt);
  const tb = Date.parse(b.occurredAt);
  if (ta !== tb && !Number.isNaN(ta) && !Number.isNaN(tb)) return tb - ta;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** 按币种汇总已实现的账本行；没填金额的已实现行计入 missingAmountCount。 */
export function summarizeLedger(entries: LedgerEntry[]): LedgerSummary {
  const buckets = new Map<string, LedgerCurrencyTotals>();
  let missingAmountCount = 0;
  for (const entry of entries) {
    if (!entry.realized) continue;
    if (entry.amount === null) {
      missingAmountCount += 1;
      continue;
    }
    const key = entry.currency ?? '';
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { currency: key, income: 0, expense: 0, net: 0, realizedCount: 0 };
      buckets.set(key, bucket);
    }
    if (entry.direction === 'income') bucket.income += entry.amount;
    else bucket.expense += entry.amount;
    bucket.realizedCount += 1;
  }
  const byCurrency = [...buckets.values()].map((bucket) => ({
    ...bucket,
    income: Math.round(bucket.income * 100) / 100,
    expense: Math.round(bucket.expense * 100) / 100,
    net: Math.round((bucket.income - bucket.expense) * 100) / 100,
  }));
  byCurrency.sort((a, b) => b.income + b.expense - (a.income + a.expense));
  return { byCurrency, missingAmountCount };
}

/**
 * 读取并合并一个 agent 的完整账本。
 *
 * 三方 entries 并行读取后投影、合并、按时间倒序、汇总。任一来源读失败按空处理，
 * 账本仍能呈现其余来源。
 */
export async function loadLedger(agentId: string): Promise<Ledger> {
  const aid = String(agentId ?? '').trim();
  if (!aid) return { entries: [], summary: { byCurrency: [], missingAmountCount: 0 } };

  const safeList = async (appId: 'accounting' | 'shopping' | 'secondhand'): Promise<AppEntry[]> => {
    try {
      return await listAppEntries(aid, appId);
    } catch {
      return [];
    }
  };

  const [accountingRows, shoppingRows, secondhandRows] = await Promise.all([
    safeList('accounting'),
    safeList('shopping'),
    safeList('secondhand'),
  ]);

  const entries = [
    ...accountingRows.map(projectAccountingEntry),
    ...shoppingRows.map(projectShoppingEntry),
    ...secondhandRows.map(projectSecondhandEntry),
  ].sort(compareByOccurredAtDesc);

  return { entries, summary: summarizeLedger(entries) };
}
