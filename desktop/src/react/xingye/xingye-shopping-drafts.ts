/**
 * 渲染端「待确认购物草稿」store 助手。
 *
 * 购物模块的「已生成」列表走 xingye-app-entry-store 的通用 AppEntry 路径
 * （`apps/shopping/entries.jsonl`，appId='shopping'）。这里只挂草稿这一支：
 *
 *  - 草稿落到 `apps/shopping/drafts.jsonl`（与 entries 同目录、分文件）。
 *  - listShoppingDrafts / appendShoppingDraft / discardShoppingDraft / confirmShoppingDraft
 *    四件套，发对应的 shopping.draft_proposed / discarded / confirmed 事件。
 *  - confirm 路径复用 createXingyeAppEntryStore(...).appendEntry('agent', 'shopping', ...)，
 *    把 metadata 还原成 ShoppingEntryMetadata（status/platformStyle/itemName/category/
 *    imaginedPrice/reason/tags），保证「已生成」卡片能正常渲染。
 */

import { appendXingyeEvent, type XingyeEventInput } from './xingye-event-log';
import { postXingyeStorage } from './xingye-storage-api';
import { createAgentXingyeStorageBackend } from './xingye-storage-backend';
import {
  appendAppEntry,
  type AppEntry,
} from './xingye-app-entry-store';

const backend = createAgentXingyeStorageBackend(postXingyeStorage);

async function appendShoppingDraftEventBestEffort(
  agentId: string,
  input: Omit<XingyeEventInput, 'agentId'>,
): Promise<void> {
  try {
    await appendXingyeEvent(agentId, input);
  } catch (error) {
    console.warn('[xingye-shopping-drafts] event log append failed:', error);
  }
}

export const XINGYE_SHOPPING_DRAFTS_JSONL = 'apps/shopping/drafts.jsonl';

const SAFE_AGENT_ID_RE = /^[A-Za-z0-9_-]{1,120}$/;

export type ShoppingDraftStatus =
  | 'wanted'
  | 'ordered'
  | 'received'
  | 'hesitating'
  | 'returned'
  | 'favorite';

export type ShoppingDraftPlatformStyle = 'amazon' | 'taobao' | 'xianyu' | 'generic';

const SHOPPING_DRAFT_STATUSES = new Set<ShoppingDraftStatus>([
  'wanted',
  'ordered',
  'received',
  'hesitating',
  'returned',
  'favorite',
]);

const SHOPPING_DRAFT_PLATFORM_STYLES = new Set<ShoppingDraftPlatformStyle>([
  'amazon',
  'taobao',
  'xianyu',
  'generic',
]);

export type XingyePendingShoppingDraft = {
  id: string;
  itemName: string;
  status: ShoppingDraftStatus;
  platformStyle: ShoppingDraftPlatformStyle;
  category?: string;
  imaginedPrice?: string;
  /** 为什么提议这条草稿（展示给用户帮助决定是否确认）。 */
  reason?: string;
  /** 备注/正文，写入 entries 时落到 AppEntry.content。 */
  content?: string;
  tags?: string[];
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

function normalizeStatus(value: unknown): ShoppingDraftStatus {
  return typeof value === 'string' && SHOPPING_DRAFT_STATUSES.has(value as ShoppingDraftStatus)
    ? (value as ShoppingDraftStatus)
    : 'wanted';
}

function normalizePlatformStyle(value: unknown): ShoppingDraftPlatformStyle {
  return typeof value === 'string' && SHOPPING_DRAFT_PLATFORM_STYLES.has(value as ShoppingDraftPlatformStyle)
    ? (value as ShoppingDraftPlatformStyle)
    : 'generic';
}

function normalizeTags(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    out.push(trimmed.slice(0, 24));
    if (out.length >= 8) break;
  }
  return out.length ? out : undefined;
}

function normalizeDraftRow(value: unknown): XingyePendingShoppingDraft | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : '';
  if (!id) return null;
  const itemName = normalizeOptionalText(raw.itemName, 80);
  if (!itemName) return null;
  const createdAt = typeof raw.createdAt === 'string' && raw.createdAt
    ? raw.createdAt
    : new Date(0).toISOString();
  const source = typeof raw.source === 'string' && raw.source.trim()
    ? raw.source.trim()
    : 'unknown';
  const eventIdsRaw = raw.sourceEventIds;
  const sourceEventIds = Array.isArray(eventIdsRaw)
    ? eventIdsRaw.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : undefined;
  return {
    id,
    itemName,
    status: normalizeStatus(raw.status),
    platformStyle: normalizePlatformStyle(raw.platformStyle),
    category: normalizeOptionalText(raw.category, 24),
    imaginedPrice: normalizeOptionalText(raw.imaginedPrice, 40),
    reason: normalizeOptionalText(raw.reason, 500),
    content: normalizeOptionalText(raw.content, 2000),
    tags: normalizeTags(raw.tags),
    createdAt,
    source,
    sourceEventIds,
  };
}

function sortShoppingDrafts(a: XingyePendingShoppingDraft, b: XingyePendingShoppingDraft): number {
  const ta = Date.parse(a.createdAt);
  const tb = Date.parse(b.createdAt);
  if (ta !== tb && !Number.isNaN(ta) && !Number.isNaN(tb)) return tb - ta;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

export async function listShoppingDrafts(agentId: string): Promise<XingyePendingShoppingDraft[]> {
  const aid = String(agentId ?? '').trim();
  if (!aid) return [];
  try {
    const rows = await backend.listJsonl<unknown>(aid, XINGYE_SHOPPING_DRAFTS_JSONL);
    return rows
      .map(normalizeDraftRow)
      .filter((d): d is XingyePendingShoppingDraft => Boolean(d))
      .sort(sortShoppingDrafts);
  } catch {
    return [];
  }
}

function newShoppingDraftId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `shop-${crypto.randomUUID()}`;
  }
  return `shop-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 写入一条「待确认购物草稿」。
 *
 * 与 appendAppEntry('shopping', ...) 区别：
 *  - 不写 entries.jsonl，不发 shopping.entry_appended；
 *  - 发出 `shopping.draft_proposed`，便于心跳消费者下一轮汇总。
 */
export async function appendShoppingDraft(
  agentId: string,
  input: {
    itemName: string;
    status?: ShoppingDraftStatus;
    platformStyle?: ShoppingDraftPlatformStyle;
    category?: string;
    imaginedPrice?: string;
    reason?: string;
    content?: string;
    tags?: string[];
    source: string;
    sourceEventIds?: string[];
  },
): Promise<XingyePendingShoppingDraft> {
  const aid = assertAgentId(agentId, '保存购物草稿');
  const itemName = (input.itemName ?? '').trim().slice(0, 80);
  if (!itemName) throw new Error('草稿物品名不能为空。');
  const source = input.source.trim();
  if (!source) throw new Error('草稿来源 (source) 不能为空。');
  const status = normalizeStatus(input.status);
  const platformStyle = normalizePlatformStyle(input.platformStyle);
  const category = normalizeOptionalText(input.category, 24);
  const imaginedPrice = normalizeOptionalText(input.imaginedPrice, 40);
  const reason = normalizeOptionalText(input.reason, 500);
  const content = normalizeOptionalText(input.content, 2000);
  const tags = normalizeTags(input.tags);
  const sourceEventIds = Array.isArray(input.sourceEventIds)
    ? input.sourceEventIds.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : undefined;
  const id = newShoppingDraftId();
  const createdAt = new Date().toISOString();
  const row: XingyePendingShoppingDraft & { key: string } = {
    id,
    key: id,
    itemName,
    status,
    platformStyle,
    category,
    imaginedPrice,
    reason,
    content,
    tags,
    createdAt,
    source,
    sourceEventIds,
  };
  await backend.appendJsonl(aid, XINGYE_SHOPPING_DRAFTS_JSONL, row);
  await appendShoppingDraftEventBestEffort(aid, {
    type: 'shopping.draft_proposed',
    source,
    subjectId: id,
    payload: {
      draftId: id,
      itemName,
      status,
      reason: reason ?? null,
      sourceEventIds: sourceEventIds ?? [],
    },
  });
  return {
    id,
    itemName,
    status,
    platformStyle,
    category,
    imaginedPrice,
    reason,
    content,
    tags,
    createdAt,
    source,
    sourceEventIds,
  };
}

export async function discardShoppingDraft(agentId: string, draftId: string): Promise<boolean> {
  const aid = assertAgentId(agentId, '丢弃购物草稿');
  const did = draftId.trim();
  if (!did) throw new Error('丢弃草稿失败：缺少草稿 id。');
  const deleted = await backend.deleteJsonlRecord(aid, XINGYE_SHOPPING_DRAFTS_JSONL, did);
  if (deleted) {
    await appendShoppingDraftEventBestEffort(aid, {
      type: 'shopping.draft_discarded',
      source: 'xingye-shopping-drafts',
      subjectId: did,
      payload: { draftId: did },
    });
  }
  return deleted;
}

/**
 * 用户在「待确认草稿」区点「确认生成」时调用：先通过 appendAppEntry('shopping', ...)
 * 写入 entries（自动发 shopping.entry_appended），再从 drafts 删掉，最后发
 * shopping.draft_confirmed。entries 写入失败时保留 draft 不重复写。
 */
export async function confirmShoppingDraft(
  agentId: string,
  draftId: string,
  edits?: {
    itemName?: string;
    status?: ShoppingDraftStatus;
    platformStyle?: ShoppingDraftPlatformStyle;
    category?: string | null;
    imaginedPrice?: string | null;
    content?: string | null;
    reason?: string | null;
    tags?: string[] | null;
  },
): Promise<AppEntry> {
  const aid = assertAgentId(agentId, '确认购物草稿');
  const did = draftId.trim();
  if (!did) throw new Error('确认草稿失败：缺少草稿 id。');
  const draft = (await listShoppingDrafts(aid)).find((d) => d.id === did);
  if (!draft) throw new Error('确认草稿失败：草稿不存在或已被丢弃。');

  const resolveOptional = (
    key: 'category' | 'imaginedPrice' | 'content' | 'reason',
    max: number,
  ): string | undefined => {
    if (edits && Object.prototype.hasOwnProperty.call(edits, key)) {
      const v = edits[key];
      if (v === null) return undefined;
      if (typeof v === 'string') return normalizeOptionalText(v, max);
    }
    return draft[key];
  };
  const resolveTags = (): string[] | undefined => {
    if (edits && Object.prototype.hasOwnProperty.call(edits, 'tags')) {
      if (edits.tags === null) return undefined;
      return normalizeTags(edits.tags);
    }
    return draft.tags;
  };

  const itemName = ((edits?.itemName ?? draft.itemName) || '').trim().slice(0, 80);
  if (!itemName) throw new Error('确认草稿失败：物品名不能为空。');
  const status = normalizeStatus(edits?.status ?? draft.status);
  const platformStyle = normalizePlatformStyle(edits?.platformStyle ?? draft.platformStyle);
  const category = resolveOptional('category', 24);
  const imaginedPrice = resolveOptional('imaginedPrice', 40);
  const reason = resolveOptional('reason', 500);
  const content = resolveOptional('content', 2000) ?? '';
  const tags = resolveTags();

  const metadata: Record<string, unknown> = {
    status,
    platformStyle,
    itemName,
  };
  if (category) metadata.category = category;
  if (imaginedPrice) metadata.imaginedPrice = imaginedPrice;
  if (reason) metadata.reason = reason;
  if (tags && tags.length > 0) metadata.tags = tags;

  const entry = await appendAppEntry(aid, 'shopping', {
    title: itemName,
    content,
    metadata,
    source: 'xingye-heartbeat-confirmed',
  });
  try {
    await backend.deleteJsonlRecord(aid, XINGYE_SHOPPING_DRAFTS_JSONL, did);
  } catch (error) {
    console.warn('[xingye-shopping-drafts] confirm draft: failed to delete draft after entry append:', error);
  }
  await appendShoppingDraftEventBestEffort(aid, {
    type: 'shopping.draft_confirmed',
    source: 'xingye-shopping-drafts',
    subjectId: did,
    payload: { draftId: did, entryId: entry.id, itemName },
  });
  return entry;
}
