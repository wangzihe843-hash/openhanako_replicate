/**
 * 渲染端「待确认报纸草稿」store 助手（意图草稿模型）。
 *
 * 与其它模块「草稿即成品」的形态不同：一期报纸是多板块的重型结构化生成，
 * 心跳 agent 不在工具里直接写整份报纸，只提一个**意图**——TA 想出一期报纸、
 * 想从什么角度切入。意图草稿落 `apps/news/drafts.jsonl`（与 entries 同目录、分文件）。
 *
 * 用户在 PhoneNewsApp「待确认草稿」区点「确认出版」时，UI 才用意图里的 angle
 * 作为 userIntent 跑现成的 generateNewsDraftWithAI，拿到 NewsEntryMetadata 后调
 * confirmNewsDraftWithEntry 落地——生成机器全在渲染端，无需任何服务端搬迁。
 *
 *  - listNewsDrafts / appendNewsDraft / discardNewsDraft / confirmNewsDraftWithEntry。
 *  - 事件：news.draft_proposed / discarded / confirmed；confirm 落地时
 *    appendAppEntry('news') 还会自动发 news.entry_appended（origin=auto）。
 *  - confirm 用确定性 entry id `from-draft-${draftId}` + 先 list 查重做幂等，
 *    与 xingye-reading-notes-drafts.ts 同款骨架。
 */

import { appendXingyeEvent, type XingyeEventInput } from './xingye-event-log';
import { postXingyeStorage } from './xingye-storage-api';
import { createAgentXingyeStorageBackend } from './xingye-storage-backend';
import { appendAppEntry, listAppEntries, type AppEntry } from './xingye-app-entry-store';
import { originFromEntryId, withDraftConfirmLock } from './xingye-draft-confirm-lock';
import { flattenNewsMetadataToContent, type NewsEntryMetadata } from './xingye-news-types';

const backend = createAgentXingyeStorageBackend(postXingyeStorage);

export const XINGYE_NEWS_DRAFTS_JSONL = 'apps/news/drafts.jsonl';

const SAFE_AGENT_ID_RE = /^[A-Za-z0-9_-]{1,120}$/;
const ANGLE_MAX = 400;
const REASON_MAX = 1000;

async function appendNewsDraftEventBestEffort(
  agentId: string,
  input: Omit<XingyeEventInput, 'agentId'>,
): Promise<void> {
  try {
    await appendXingyeEvent(agentId, input);
  } catch (error) {
    console.warn('[xingye-news-drafts] event log append failed:', error);
  }
}

export type XingyePendingNewsDraft = {
  id: string;
  /** TA 想读 / 想报道的角度（confirm 时作为 generateNewsDraftWithAI 的 userIntent）。 */
  angle?: string;
  reason?: string;
  source: string;
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

function normalizeDraftRow(value: unknown): XingyePendingNewsDraft | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : '';
  if (!id) return null;
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
    angle: normalizeOptionalText(raw.angle, ANGLE_MAX),
    reason: normalizeOptionalText(raw.reason, REASON_MAX),
    source,
    sourceEventIds,
    createdAt,
  };
}

function sortDrafts(a: XingyePendingNewsDraft, b: XingyePendingNewsDraft): number {
  const ta = Date.parse(a.createdAt);
  const tb = Date.parse(b.createdAt);
  if (ta !== tb && !Number.isNaN(ta) && !Number.isNaN(tb)) return tb - ta;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

export async function listNewsDrafts(agentId: string): Promise<XingyePendingNewsDraft[]> {
  const aid = String(agentId ?? '').trim();
  if (!aid) return [];
  try {
    const rows = await backend.listJsonl<unknown>(aid, XINGYE_NEWS_DRAFTS_JSONL);
    return rows
      .map(normalizeDraftRow)
      .filter((d): d is XingyePendingNewsDraft => Boolean(d))
      .sort(sortDrafts);
  } catch {
    return [];
  }
}

function newDraftId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `news-${crypto.randomUUID()}`;
  }
  return `news-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 写入一条「待确认报纸草稿（意图）」。
 *
 * 不写 entries.jsonl、不发 news.entry_appended；只发 news.draft_proposed，
 * 供心跳消费者下一轮聚合。angle / reason 都是可选弱提示。
 */
export async function appendNewsDraft(
  agentId: string,
  input: {
    angle?: string;
    reason?: string;
    source: string;
    sourceEventIds?: string[];
  },
): Promise<XingyePendingNewsDraft> {
  const aid = assertAgentId(agentId, '保存报纸草稿');
  const source = input.source.trim();
  if (!source) throw new Error('草稿来源 (source) 不能为空。');
  const angle = normalizeOptionalText(input.angle, ANGLE_MAX);
  const reason = normalizeOptionalText(input.reason, REASON_MAX);
  const sourceEventIds = Array.isArray(input.sourceEventIds)
    ? input.sourceEventIds.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : undefined;
  const id = newDraftId();
  const createdAt = new Date().toISOString();
  const row: XingyePendingNewsDraft & { key: string } = {
    id, key: id, angle, reason, source, sourceEventIds, createdAt,
  };
  await backend.appendJsonl(aid, XINGYE_NEWS_DRAFTS_JSONL, row);
  await appendNewsDraftEventBestEffort(aid, {
    type: 'news.draft_proposed',
    source,
    subjectId: id,
    payload: {
      draftId: id,
      angle: angle ?? null,
      reason: reason ?? null,
      sourceEventIds: sourceEventIds ?? [],
    },
  });
  return { id, angle, reason, source, sourceEventIds, createdAt };
}

export async function discardNewsDraft(agentId: string, draftId: string): Promise<boolean> {
  const aid = assertAgentId(agentId, '丢弃报纸草稿');
  const did = draftId.trim();
  if (!did) throw new Error('丢弃草稿失败：缺少草稿 id。');
  const deleted = await backend.deleteJsonlRecord(aid, XINGYE_NEWS_DRAFTS_JSONL, did);
  if (deleted) {
    await appendNewsDraftEventBestEffort(aid, {
      type: 'news.draft_discarded',
      source: 'xingye-news-drafts',
      subjectId: did,
      payload: { draftId: did },
    });
  }
  return deleted;
}

/** Confirmed-from-draft entry 用确定性 id：让 confirm retry 走幂等查重路径。 */
function newsEntryIdFromDraftId(draftId: string): string {
  return `from-draft-${draftId}`;
}

/**
 * 用户在「待确认草稿」区点「确认出版」时调用。
 *
 * 与 reading-notes 不同：报纸内容不在草稿里——调用方（PhoneNewsApp）须先用
 * 草稿 angle 跑 generateNewsDraftWithAI 拿到 NewsEntryMetadata，再把它传进来。
 * 本函数负责幂等落地 + 删草稿 + 发 news.draft_confirmed：
 *   1. entry id 用 `from-draft-${draftId}`；先 listAppEntries('news') 查重，
 *      已有同 id（上一次 confirm 写完 entry 但删草稿失败）→ 复用，跳过 append；
 *   2. 否则 appendAppEntry('news', ...)（自动发 news.entry_appended，origin=auto）；
 *   3. 从 drafts 删掉；删除失败仅 warn——重试时 (1) 兜底防重；
 *   4. 发 news.draft_confirmed。
 */
export async function confirmNewsDraftWithEntry(
  agentId: string,
  draftId: string,
  meta: NewsEntryMetadata,
): Promise<AppEntry> {
  const aid = assertAgentId(agentId, '确认报纸草稿');
  const did = draftId.trim();
  if (!did) throw new Error('确认草稿失败：缺少草稿 id。');
  if (!meta || typeof meta !== 'object') throw new Error('确认草稿失败：缺少报纸内容。');
  return withDraftConfirmLock(`news::${aid}::${did}`, async () => {
    const expectedEntryId = newsEntryIdFromDraftId(did);
    const existingEntry = (await listAppEntries(aid, 'news')).find((e) => e.id === expectedEntryId);

    const entry = existingEntry ?? await appendAppEntry(aid, 'news', {
      id: expectedEntryId,
      title: meta.masthead,
      content: flattenNewsMetadataToContent(meta),
      metadata: meta as unknown as Record<string, unknown>,
      source: 'xingye-heartbeat-confirmed',
    });

    try {
      await backend.deleteJsonlRecord(aid, XINGYE_NEWS_DRAFTS_JSONL, did);
    } catch (error) {
      console.warn('[xingye-news-drafts] confirm draft: failed to delete draft after entry append:', error);
    }
    await appendNewsDraftEventBestEffort(aid, {
      type: 'news.draft_confirmed',
      source: 'xingye-news-drafts',
      subjectId: did,
      payload: {
        draftId: did,
        entryId: entry.id,
        masthead: entry.title,
        origin: originFromEntryId(entry.id),
      },
    });
    return entry;
  });
}
