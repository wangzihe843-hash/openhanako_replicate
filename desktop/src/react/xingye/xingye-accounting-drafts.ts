/**
 * 渲染端「待确认记账草稿」store 助手。
 *
 * 记账模块的「已生成」列表走 xingye-app-entry-store 的通用 AppEntry 路径
 * （`apps/accounting/entries.jsonl`，appId='accounting'）。这里只挂草稿这一支：
 *
 *  - 草稿落到 `apps/accounting/drafts.jsonl`（与 entries 同目录、分文件）。
 *  - listAccountingDrafts / appendAccountingDraft / discardAccountingDraft /
 *    confirmAccountingDraft 四件套，发对应的
 *    accounting.draft_proposed / discarded / confirmed 事件。
 *  - confirm 路径复用 appendAppEntry(aid, 'accounting', ...)，把 metadata 还原成
 *    AccountingEntryMetadata（direction/amount/currency/category/counterparty/occurredAt），
 *    保证记账账本能正常渲染。
 *
 * 与购物 / 二手草稿的区别：记账记的是 TA 在购物 / 二手之外的「原生收支」——
 * 工资、房租、餐饮、水电、人情往来、利息……所以没有 status / platformStyle 生命周期，
 * 改用 direction（income / expense）+ amount + currency 这套交易语义。
 */

import { appendXingyeEvent, type XingyeEventInput } from './xingye-event-log';
import { postXingyeStorage } from './xingye-storage-api';
import { createAgentXingyeStorageBackend } from './xingye-storage-backend';
import {
  appendAppEntry,
  listAppEntries,
  type AppEntry,
} from './xingye-app-entry-store';
import { withDraftConfirmLock } from './xingye-draft-confirm-lock';
import { normalizeAmount, normalizeCurrency } from './xingye-money';

const backend = createAgentXingyeStorageBackend(postXingyeStorage);

async function appendAccountingDraftEventBestEffort(
  agentId: string,
  input: Omit<XingyeEventInput, 'agentId'>,
): Promise<void> {
  try {
    await appendXingyeEvent(agentId, input);
  } catch (error) {
    console.warn('[xingye-accounting-drafts] event log append failed:', error);
  }
}

export const XINGYE_ACCOUNTING_DRAFTS_JSONL = 'apps/accounting/drafts.jsonl';

const SAFE_AGENT_ID_RE = /^[A-Za-z0-9_-]{1,120}$/;

/** 收支方向：income = 收入（钱进），expense = 支出（钱出）。 */
export type AccountingDirection = 'income' | 'expense';

const ACCOUNTING_DIRECTIONS = new Set<AccountingDirection>(['income', 'expense']);

export type XingyePendingAccountingDraft = {
  id: string;
  /** 摘要 / 条目名，如「五月薪俸」「这个月房租」。写入 entries 时落到 AppEntry.title。 */
  title: string;
  direction: AccountingDirection;
  /** 非负数值金额；正负由 direction 表达。 */
  amount: number;
  /** 货币单位（¥ / $ / 两银子 / 金币 / 信用点 …）；缺省时记账按「未标注币种」归类。 */
  currency?: string;
  /** 分类，如「工资 / 餐饮 / 房租 / 交通 / 医疗 / 人情 / 利息」，按 TA 世界观自由文本。 */
  category?: string;
  /** 付款方 / 收款方口吻，如「东家」「房东」「巷口面摊」。 */
  counterparty?: string;
  /** 交易发生日 ISO；缺省时记账回退到 createdAt。 */
  occurredAt?: string;
  /** 为什么提议这条草稿（展示给用户帮助决定是否确认）。 */
  reason?: string;
  /** 备注/正文，写入 entries 时落到 AppEntry.content。 */
  content?: string;
  /** Producer 标识，例：'xingye-heartbeat-tool'。 */
  source: string;
  /** 触发本草稿的 xingye event id 列表（可空，用于追溯）。 */
  sourceEventIds?: string[];
  createdAt: string;
};

function assertAgentId(agentId: string, action: string): string {
  const aid = String(agentId ?? '').trim();
  if (!aid) throw new Error(`${action}失败：缺少 agentId。`);
  if (!SAFE_AGENT_ID_RE.test(aid)) {
    throw new Error(`${action}失败：agentId 格式无效（仅允许字母、数字、下划线与短横线，长度 1–120）。`);
  }
  return aid;
}

function normalizeOptionalText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, max);
}

function normalizeDirection(value: unknown): AccountingDirection {
  return typeof value === 'string' && ACCOUNTING_DIRECTIONS.has(value as AccountingDirection)
    ? (value as AccountingDirection)
    : 'expense';
}

/** 交易发生日：可解析的日期 → 归一为 ISO 字符串；否则 undefined。 */
function normalizeOccurredAt(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const parsed = Date.parse(value.trim());
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function normalizeSourceEventIds(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : undefined;
}

function normalizeDraftRow(value: unknown): XingyePendingAccountingDraft | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : '';
  if (!id) return null;
  const title = normalizeOptionalText(raw.title, 80);
  if (!title) return null;
  const amount = normalizeAmount(raw.amount);
  if (amount === undefined) return null;
  const createdAt = typeof raw.createdAt === 'string' && raw.createdAt
    ? raw.createdAt
    : new Date(0).toISOString();
  const source = typeof raw.source === 'string' && raw.source.trim()
    ? raw.source.trim()
    : 'unknown';
  return {
    id,
    title,
    direction: normalizeDirection(raw.direction),
    amount,
    currency: normalizeCurrency(raw.currency),
    category: normalizeOptionalText(raw.category, 24),
    counterparty: normalizeOptionalText(raw.counterparty, 40),
    occurredAt: normalizeOccurredAt(raw.occurredAt),
    reason: normalizeOptionalText(raw.reason, 500),
    content: normalizeOptionalText(raw.content, 2000),
    createdAt,
    source,
    sourceEventIds: normalizeSourceEventIds(raw.sourceEventIds),
  };
}

function sortAccountingDrafts(
  a: XingyePendingAccountingDraft,
  b: XingyePendingAccountingDraft,
): number {
  const ta = Date.parse(a.createdAt);
  const tb = Date.parse(b.createdAt);
  if (ta !== tb && !Number.isNaN(ta) && !Number.isNaN(tb)) return tb - ta;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

export async function listAccountingDrafts(agentId: string): Promise<XingyePendingAccountingDraft[]> {
  const aid = String(agentId ?? '').trim();
  if (!aid) return [];
  try {
    const rows = await backend.listJsonl<unknown>(aid, XINGYE_ACCOUNTING_DRAFTS_JSONL);
    return rows
      .map(normalizeDraftRow)
      .filter((d): d is XingyePendingAccountingDraft => Boolean(d))
      .sort(sortAccountingDrafts);
  } catch {
    return [];
  }
}

function newAccountingDraftId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `ledger-${crypto.randomUUID()}`;
  }
  return `ledger-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 写入一条「待确认记账草稿」。
 *
 * 与 appendAppEntry('accounting', ...) 区别：
 *  - 不写 entries.jsonl，不发 accounting.entry_appended；
 *  - 发出 `accounting.draft_proposed`，便于心跳消费者下一轮汇总。
 */
export async function appendAccountingDraft(
  agentId: string,
  input: {
    title: string;
    direction?: AccountingDirection;
    amount: number;
    currency?: string;
    category?: string;
    counterparty?: string;
    occurredAt?: string;
    reason?: string;
    content?: string;
    source: string;
    sourceEventIds?: string[];
  },
): Promise<XingyePendingAccountingDraft> {
  const aid = assertAgentId(agentId, '保存记账草稿');
  const title = (input.title ?? '').trim().slice(0, 80);
  if (!title) throw new Error('草稿摘要不能为空。');
  const source = input.source.trim();
  if (!source) throw new Error('草稿来源 (source) 不能为空。');
  const amount = normalizeAmount(input.amount);
  if (amount === undefined) throw new Error('草稿金额无效：必须是非负数字。');
  const direction = normalizeDirection(input.direction);
  const currency = normalizeCurrency(input.currency);
  const category = normalizeOptionalText(input.category, 24);
  const counterparty = normalizeOptionalText(input.counterparty, 40);
  const occurredAt = normalizeOccurredAt(input.occurredAt);
  const reason = normalizeOptionalText(input.reason, 500);
  const content = normalizeOptionalText(input.content, 2000);
  const sourceEventIds = normalizeSourceEventIds(input.sourceEventIds);
  const id = newAccountingDraftId();
  const createdAt = new Date().toISOString();
  const draft: XingyePendingAccountingDraft = {
    id,
    title,
    direction,
    amount,
    currency,
    category,
    counterparty,
    occurredAt,
    reason,
    content,
    createdAt,
    source,
    sourceEventIds,
  };
  await backend.appendJsonl(aid, XINGYE_ACCOUNTING_DRAFTS_JSONL, { ...draft, key: id });
  await appendAccountingDraftEventBestEffort(aid, {
    type: 'accounting.draft_proposed',
    source,
    subjectId: id,
    payload: {
      draftId: id,
      title,
      direction,
      amount,
      currency: currency ?? null,
      reason: reason ?? null,
      sourceEventIds: sourceEventIds ?? [],
    },
  });
  return draft;
}

export async function discardAccountingDraft(agentId: string, draftId: string): Promise<boolean> {
  const aid = assertAgentId(agentId, '丢弃记账草稿');
  const did = draftId.trim();
  if (!did) throw new Error('丢弃草稿失败：缺少草稿 id。');
  const deleted = await backend.deleteJsonlRecord(aid, XINGYE_ACCOUNTING_DRAFTS_JSONL, did);
  if (deleted) {
    await appendAccountingDraftEventBestEffort(aid, {
      type: 'accounting.draft_discarded',
      source: 'xingye-accounting-drafts',
      subjectId: did,
      payload: { draftId: did },
    });
  }
  return deleted;
}

/** Confirmed-from-draft entry 用确定性 id：让 confirm retry 走幂等查重路径。 */
function accountingEntryIdFromDraftId(draftId: string): string {
  return `from-draft-${draftId}`;
}

export type AccountingDraftEdits = {
  title?: string;
  direction?: AccountingDirection;
  amount?: number;
  currency?: string | null;
  category?: string | null;
  counterparty?: string | null;
  occurredAt?: string | null;
  content?: string | null;
  reason?: string | null;
};

/**
 * 用户在「待确认草稿」区点「确认生成」时调用：
 *   1. entry id 用 `from-draft-${draftId}`；先 listAppEntries('accounting') 查重，
 *      发现已有同 id 的 entry（说明上一次 confirm 写完 entry 但 delete draft 失败）
 *      → 复用现有 entry，跳过 appendAppEntry；
 *   2. 否则 appendAppEntry('accounting', ...) 写入 entries（自动发
 *      accounting.entry_appended），传 `id` 选项作为确定性 id；
 *   3. 从 drafts 删掉；删除失败仅 warn——重试时 (1) 兜底防重；
 *   4. 发 accounting.draft_confirmed。
 *
 * 进程内 per-draft 锁防止 UI 双击/多窗口产生并发 confirm。
 */
export async function confirmAccountingDraft(
  agentId: string,
  draftId: string,
  edits?: AccountingDraftEdits,
): Promise<AppEntry> {
  const aid = assertAgentId(agentId, '确认记账草稿');
  const did = draftId.trim();
  if (!did) throw new Error('确认草稿失败：缺少草稿 id。');
  return withDraftConfirmLock(`accounting::${aid}::${did}`, async () => {
    const expectedEntryId = accountingEntryIdFromDraftId(did);
    const existingEntry = (await listAppEntries(aid, 'accounting')).find((e) => e.id === expectedEntryId);

    const draft = (await listAccountingDrafts(aid)).find((d) => d.id === did);
    if (!draft && !existingEntry) {
      throw new Error('确认草稿失败：草稿不存在或已被丢弃。');
    }

    let entry: AppEntry;
    if (existingEntry) {
      entry = existingEntry;
    } else if (draft) {
      const resolveOptional = (
        key: 'currency' | 'category' | 'counterparty' | 'content' | 'reason',
        max: number,
      ): string | undefined => {
        if (edits && Object.prototype.hasOwnProperty.call(edits, key)) {
          const v = edits[key];
          if (v === null) return undefined;
          if (typeof v === 'string') {
            return key === 'currency' ? normalizeCurrency(v) : normalizeOptionalText(v, max);
          }
        }
        return draft[key];
      };
      const resolveOccurredAt = (): string | undefined => {
        if (edits && Object.prototype.hasOwnProperty.call(edits, 'occurredAt')) {
          if (edits.occurredAt === null) return undefined;
          if (typeof edits.occurredAt === 'string') return normalizeOccurredAt(edits.occurredAt);
        }
        return draft.occurredAt;
      };

      const title = ((edits?.title ?? draft.title) || '').trim().slice(0, 80);
      if (!title) throw new Error('确认草稿失败：摘要不能为空。');
      const direction = normalizeDirection(edits?.direction ?? draft.direction);
      const amount = normalizeAmount(edits?.amount ?? draft.amount);
      if (amount === undefined) throw new Error('确认草稿失败：金额无效。');
      const currency = resolveOptional('currency', 16);
      const category = resolveOptional('category', 24);
      const counterparty = resolveOptional('counterparty', 40);
      const reason = resolveOptional('reason', 500);
      const content = resolveOptional('content', 2000) ?? '';
      const occurredAt = resolveOccurredAt();

      const metadata: Record<string, unknown> = { direction, amount, title };
      if (currency) metadata.currency = currency;
      if (category) metadata.category = category;
      if (counterparty) metadata.counterparty = counterparty;
      if (occurredAt) metadata.occurredAt = occurredAt;
      if (reason) metadata.reason = reason;

      entry = await appendAppEntry(aid, 'accounting', {
        id: expectedEntryId,
        title,
        content,
        metadata,
        source: 'xingye-heartbeat-confirmed',
        // 历史批量草稿带 occurredAt 时，让 entry.createdAt 也回到那一天；
        // ledger 投影本就读 meta.occurredAt ?? entry.createdAt，但其他地方（按 updatedAt
        // 排序、event log timestamp）会受影响。这里两边同步避免错位。
        createdAt: occurredAt,
      });
    } else {
      throw new Error('确认草稿失败：草稿不存在或已被丢弃。');
    }

    try {
      await backend.deleteJsonlRecord(aid, XINGYE_ACCOUNTING_DRAFTS_JSONL, did);
    } catch (error) {
      console.warn('[xingye-accounting-drafts] confirm draft: failed to delete draft after entry append:', error);
    }
    await appendAccountingDraftEventBestEffort(aid, {
      type: 'accounting.draft_confirmed',
      source: 'xingye-accounting-drafts',
      subjectId: did,
      payload: { draftId: did, entryId: entry.id, title: entry.title },
    });
    return entry;
  });
}
