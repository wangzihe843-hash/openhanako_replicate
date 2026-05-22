/**
 * 渲染端「待确认二手草稿」store 助手。
 *
 * 二手模块是购物模块的镜像（购物 = 买，二手 = 卖），结构与 xingye-shopping-drafts.ts
 * 一一对称。二手模块的「已生成」列表走 xingye-app-entry-store 的通用 AppEntry 路径
 * （`apps/secondhand/entries.jsonl`，appId='secondhand'）。这里只挂草稿这一支：
 *
 *  - 草稿落到 `apps/secondhand/drafts.jsonl`（与 entries 同目录、分文件）。
 *  - listSecondhandDrafts / appendSecondhandDraft / discardSecondhandDraft /
 *    confirmSecondhandDraft 四件套，发对应的
 *    secondhand.draft_proposed / discarded / confirmed 事件。
 *  - confirm 路径复用 createXingyeAppEntryStore(...).appendEntry('agent', 'secondhand', ...)，
 *    把 metadata 还原成 SecondhandEntryMetadata（status/platformStyle/itemName/category/
 *    askingPrice/delta/buyer/reason/tags），保证「已生成」卡片能正常渲染。
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

const backend = createAgentXingyeStorageBackend(postXingyeStorage);

async function appendSecondhandDraftEventBestEffort(
  agentId: string,
  input: Omit<XingyeEventInput, 'agentId'>,
): Promise<void> {
  try {
    await appendXingyeEvent(agentId, input);
  } catch (error) {
    console.warn('[xingye-secondhand-drafts] event log append failed:', error);
  }
}

export const XINGYE_SECONDHAND_DRAFTS_JSONL = 'apps/secondhand/drafts.jsonl';

const SAFE_AGENT_ID_RE = /^[A-Za-z0-9_-]{1,120}$/;

export type SecondhandDraftStatus =
  | 'to_sell'
  | 'listed'
  | 'sold'
  | 'negotiating'
  | 'kept'
  | 'delisted';

export type SecondhandDraftPlatformStyle = 'amazon' | 'taobao' | 'xianyu' | 'generic';

const SECONDHAND_DRAFT_STATUSES = new Set<SecondhandDraftStatus>([
  'to_sell',
  'listed',
  'sold',
  'negotiating',
  'kept',
  'delisted',
]);

const SECONDHAND_DRAFT_PLATFORM_STYLES = new Set<SecondhandDraftPlatformStyle>([
  'amazon',
  'taobao',
  'xianyu',
  'generic',
]);

export type XingyePendingSecondhandDraft = {
  id: string;
  itemName: string;
  status: SecondhandDraftStatus;
  platformStyle: SecondhandDraftPlatformStyle;
  category?: string;
  /** TA 想象里的卖价 / 期望成交价；见 SecondhandEntryMetadata.askingPrice。 */
  askingPrice?: string;
  /** 价格 delta 短语，不带货币符号；见 SecondhandEntryMetadata.delta。 */
  delta?: string;
  /** 买家 / 接手人口吻，不带真实电商平台；见 SecondhandEntryMetadata.buyer。 */
  buyer?: string;
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

function normalizeStatus(value: unknown): SecondhandDraftStatus {
  return typeof value === 'string' && SECONDHAND_DRAFT_STATUSES.has(value as SecondhandDraftStatus)
    ? (value as SecondhandDraftStatus)
    : 'to_sell';
}

function normalizePlatformStyle(value: unknown): SecondhandDraftPlatformStyle {
  return typeof value === 'string' && SECONDHAND_DRAFT_PLATFORM_STYLES.has(value as SecondhandDraftPlatformStyle)
    ? (value as SecondhandDraftPlatformStyle)
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

function normalizeDraftRow(value: unknown): XingyePendingSecondhandDraft | null {
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
    askingPrice: normalizeOptionalText(raw.askingPrice, 40),
    delta: normalizeOptionalText(raw.delta, 32),
    buyer: normalizeOptionalText(raw.buyer, 24),
    reason: normalizeOptionalText(raw.reason, 500),
    content: normalizeOptionalText(raw.content, 2000),
    tags: normalizeTags(raw.tags),
    createdAt,
    source,
    sourceEventIds,
  };
}

function sortSecondhandDrafts(a: XingyePendingSecondhandDraft, b: XingyePendingSecondhandDraft): number {
  const ta = Date.parse(a.createdAt);
  const tb = Date.parse(b.createdAt);
  if (ta !== tb && !Number.isNaN(ta) && !Number.isNaN(tb)) return tb - ta;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

export async function listSecondhandDrafts(agentId: string): Promise<XingyePendingSecondhandDraft[]> {
  const aid = String(agentId ?? '').trim();
  if (!aid) return [];
  try {
    const rows = await backend.listJsonl<unknown>(aid, XINGYE_SECONDHAND_DRAFTS_JSONL);
    return rows
      .map(normalizeDraftRow)
      .filter((d): d is XingyePendingSecondhandDraft => Boolean(d))
      .sort(sortSecondhandDrafts);
  } catch {
    return [];
  }
}

function newSecondhandDraftId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `resell-${crypto.randomUUID()}`;
  }
  return `resell-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 写入一条「待确认二手草稿」。
 *
 * 与 appendAppEntry('secondhand', ...) 区别：
 *  - 不写 entries.jsonl，不发 secondhand.entry_appended；
 *  - 发出 `secondhand.draft_proposed`，便于心跳消费者下一轮汇总。
 */
export async function appendSecondhandDraft(
  agentId: string,
  input: {
    itemName: string;
    status?: SecondhandDraftStatus;
    platformStyle?: SecondhandDraftPlatformStyle;
    category?: string;
    askingPrice?: string;
    delta?: string;
    buyer?: string;
    reason?: string;
    content?: string;
    tags?: string[];
    source: string;
    sourceEventIds?: string[];
  },
): Promise<XingyePendingSecondhandDraft> {
  const aid = assertAgentId(agentId, '保存二手草稿');
  const itemName = (input.itemName ?? '').trim().slice(0, 80);
  if (!itemName) throw new Error('草稿物品名不能为空。');
  const source = input.source.trim();
  if (!source) throw new Error('草稿来源 (source) 不能为空。');
  const status = normalizeStatus(input.status);
  const platformStyle = normalizePlatformStyle(input.platformStyle);
  const category = normalizeOptionalText(input.category, 24);
  const askingPrice = normalizeOptionalText(input.askingPrice, 40);
  const delta = normalizeOptionalText(input.delta, 32);
  const buyer = normalizeOptionalText(input.buyer, 24);
  const reason = normalizeOptionalText(input.reason, 500);
  const content = normalizeOptionalText(input.content, 2000);
  const tags = normalizeTags(input.tags);
  const sourceEventIds = Array.isArray(input.sourceEventIds)
    ? input.sourceEventIds.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : undefined;
  const id = newSecondhandDraftId();
  const createdAt = new Date().toISOString();
  const row: XingyePendingSecondhandDraft & { key: string } = {
    id,
    key: id,
    itemName,
    status,
    platformStyle,
    category,
    askingPrice,
    delta,
    buyer,
    reason,
    content,
    tags,
    createdAt,
    source,
    sourceEventIds,
  };
  await backend.appendJsonl(aid, XINGYE_SECONDHAND_DRAFTS_JSONL, row);
  await appendSecondhandDraftEventBestEffort(aid, {
    type: 'secondhand.draft_proposed',
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
    askingPrice,
    delta,
    buyer,
    reason,
    content,
    tags,
    createdAt,
    source,
    sourceEventIds,
  };
}

export async function discardSecondhandDraft(agentId: string, draftId: string): Promise<boolean> {
  const aid = assertAgentId(agentId, '丢弃二手草稿');
  const did = draftId.trim();
  if (!did) throw new Error('丢弃草稿失败：缺少草稿 id。');
  const deleted = await backend.deleteJsonlRecord(aid, XINGYE_SECONDHAND_DRAFTS_JSONL, did);
  if (deleted) {
    await appendSecondhandDraftEventBestEffort(aid, {
      type: 'secondhand.draft_discarded',
      source: 'xingye-secondhand-drafts',
      subjectId: did,
      payload: { draftId: did },
    });
  }
  return deleted;
}

/** Confirmed-from-draft entry 用确定性 id：让 confirm retry 走幂等查重路径。 */
function secondhandEntryIdFromDraftId(draftId: string): string {
  return `from-draft-${draftId}`;
}

/**
 * 用户在「待确认草稿」区点「确认生成」时调用：
 *   1. entry id 用 `from-draft-${draftId}`；先 listAppEntries('secondhand') 查重，
 *      发现已有同 id 的 entry（说明上一次 confirm 写完 entry 但 delete draft 失败）
 *      → 复用现有 entry，跳过 appendAppEntry；
 *   2. 否则 appendAppEntry('secondhand', ...) 写入 entries（自动发
 *      secondhand.entry_appended），传 `id` 选项作为确定性 id；
 *   3. 从 drafts 删掉；删除失败仅 warn——重试时 (1) 兜底防重；
 *   4. 发 secondhand.draft_confirmed。
 *
 * 进程内 per-draft 锁防止 UI 双击/多窗口产生并发 confirm。
 */
export async function confirmSecondhandDraft(
  agentId: string,
  draftId: string,
  edits?: {
    itemName?: string;
    status?: SecondhandDraftStatus;
    platformStyle?: SecondhandDraftPlatformStyle;
    category?: string | null;
    askingPrice?: string | null;
    delta?: string | null;
    buyer?: string | null;
    content?: string | null;
    reason?: string | null;
    tags?: string[] | null;
  },
): Promise<AppEntry> {
  const aid = assertAgentId(agentId, '确认二手草稿');
  const did = draftId.trim();
  if (!did) throw new Error('确认草稿失败：缺少草稿 id。');
  return withDraftConfirmLock(`secondhand::${aid}::${did}`, async () => {
    const expectedEntryId = secondhandEntryIdFromDraftId(did);
    const existingEntry = (await listAppEntries(aid, 'secondhand')).find((e) => e.id === expectedEntryId);

    const draft = (await listSecondhandDrafts(aid)).find((d) => d.id === did);
    if (!draft && !existingEntry) {
      throw new Error('确认草稿失败：草稿不存在或已被丢弃。');
    }

    let entry: AppEntry;
    if (existingEntry) {
      entry = existingEntry;
    } else if (draft) {
      const resolveOptional = (
        key: 'category' | 'askingPrice' | 'delta' | 'buyer' | 'content' | 'reason',
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
      const askingPrice = resolveOptional('askingPrice', 40);
      const delta = resolveOptional('delta', 32);
      const buyer = resolveOptional('buyer', 24);
      const reason = resolveOptional('reason', 500);
      const content = resolveOptional('content', 2000) ?? '';
      const tags = resolveTags();

      const metadata: Record<string, unknown> = {
        status,
        platformStyle,
        itemName,
      };
      if (category) metadata.category = category;
      if (askingPrice) metadata.askingPrice = askingPrice;
      if (delta) metadata.delta = delta;
      if (buyer) metadata.buyer = buyer;
      if (reason) metadata.reason = reason;
      if (tags && tags.length > 0) metadata.tags = tags;

      entry = await appendAppEntry(aid, 'secondhand', {
        id: expectedEntryId,
        title: itemName,
        content,
        metadata,
        source: 'xingye-heartbeat-confirmed',
      });
    } else {
      throw new Error('确认草稿失败：草稿不存在或已被丢弃。');
    }

    try {
      await backend.deleteJsonlRecord(aid, XINGYE_SECONDHAND_DRAFTS_JSONL, did);
    } catch (error) {
      console.warn('[xingye-secondhand-drafts] confirm draft: failed to delete draft after entry append:', error);
    }
    await appendSecondhandDraftEventBestEffort(aid, {
      type: 'secondhand.draft_confirmed',
      source: 'xingye-secondhand-drafts',
      subjectId: did,
      payload: { draftId: did, entryId: entry.id, itemName: entry.title },
    });
    return entry;
  });
}
