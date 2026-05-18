/**
 * 渲染端「待确认占卜草稿」store 助手——心象提示形态。
 *
 * 占卜的「已生成」列表走 xingye-app-entry-store 的 DivinationEntry 路径
 * （`apps/divination/entries.jsonl`，appId='divination'）。这里只挂草稿这一支：
 *
 *  - 草稿落到 `apps/divination/drafts.jsonl`（与 entries 同目录、分文件）。
 *  - listDivinationDrafts / appendDivinationDraft / discardDivinationDraft /
 *    confirmDivinationDraft 四件套，发对应的 divination.draft_proposed /
 *    discarded / confirmed 事件。
 *  - confirm 路径直接走 appendAppEntry('divination', ...)（**不**用
 *    appendDivinationEntry——那条要求 AI 生成的结构化 metadata）。
 *    心象提示的 metadata 固定：
 *      method='oracle_generic'、methodLabel='心象提示'、symbols=[]、
 *      autoSelected=false、question=agentQuestion=agentQuestion、
 *      resolverReason=draft.reason 或固定文案。
 *  - 心象 entry 与正式占卜 entry 并列出现在占卜历史里，UI 已支持空 symbols
 *    的渲染（DivinationEntryMetadata.symbols 类型本身就是 unknown[]）。
 */

import { appendXingyeEvent, type XingyeEventInput } from './xingye-event-log';
import { postXingyeStorage } from './xingye-storage-api';
import { createAgentXingyeStorageBackend } from './xingye-storage-backend';
import {
  appendAppEntry,
  listAppEntries,
  type AppEntry,
} from './xingye-app-entry-store';
import { originFromEntryId, withDraftConfirmLock } from './xingye-draft-confirm-lock';

const backend = createAgentXingyeStorageBackend(postXingyeStorage);

async function appendDivinationDraftEventBestEffort(
  agentId: string,
  input: Omit<XingyeEventInput, 'agentId'>,
): Promise<void> {
  try {
    await appendXingyeEvent(agentId, input);
  } catch (error) {
    console.warn('[xingye-divination-drafts] event log append failed:', error);
  }
}

export const XINGYE_DIVINATION_DRAFTS_JSONL = 'apps/divination/drafts.jsonl';

const SAFE_AGENT_ID_RE = /^[A-Za-z0-9_-]{1,120}$/;

/** 心象提示固定用 oracle_generic 这一 method；正式占卜走另一条路径。 */
export const DIVINATION_DRAFT_FIXED_METHOD = 'oracle_generic';
export const DIVINATION_DRAFT_FIXED_METHOD_LABEL = '心象提示';

export type XingyePendingDivinationDraft = {
  id: string;
  agentQuestion: string;
  content: string;
  themeHint?: string;
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

function normalizeDraftRow(value: unknown): XingyePendingDivinationDraft | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : '';
  if (!id) return null;
  const agentQuestion = normalizeOptionalText(raw.agentQuestion, 200);
  if (!agentQuestion) return null;
  const content = normalizeOptionalText(raw.content, 2000);
  if (!content) return null;
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
    agentQuestion,
    content,
    themeHint: normalizeOptionalText(raw.themeHint, 80),
    reason: normalizeOptionalText(raw.reason, 1000),
    source,
    sourceEventIds,
    createdAt,
  };
}

function sortDrafts(
  a: XingyePendingDivinationDraft,
  b: XingyePendingDivinationDraft,
): number {
  const ta = Date.parse(a.createdAt);
  const tb = Date.parse(b.createdAt);
  if (ta !== tb && !Number.isNaN(ta) && !Number.isNaN(tb)) return tb - ta;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

export async function listDivinationDrafts(
  agentId: string,
): Promise<XingyePendingDivinationDraft[]> {
  const aid = String(agentId ?? '').trim();
  if (!aid) return [];
  try {
    const rows = await backend.listJsonl<unknown>(aid, XINGYE_DIVINATION_DRAFTS_JSONL);
    return rows
      .map(normalizeDraftRow)
      .filter((d): d is XingyePendingDivinationDraft => Boolean(d))
      .sort(sortDrafts);
  } catch {
    return [];
  }
}

function newDraftId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `div-${crypto.randomUUID()}`;
  }
  return `div-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function appendDivinationDraft(
  agentId: string,
  input: {
    agentQuestion: string;
    content: string;
    themeHint?: string;
    reason?: string;
    source: string;
    sourceEventIds?: string[];
  },
): Promise<XingyePendingDivinationDraft> {
  const aid = assertAgentId(agentId, '保存占卜（心象）草稿');
  const agentQuestion = (input.agentQuestion ?? '').trim().slice(0, 200);
  if (!agentQuestion) throw new Error('草稿 agentQuestion 不能为空。');
  const content = (input.content ?? '').trim().slice(0, 2000);
  if (!content) throw new Error('草稿正文（心象）不能为空。');
  const source = input.source.trim();
  if (!source) throw new Error('草稿来源 (source) 不能为空。');
  const themeHint = normalizeOptionalText(input.themeHint, 80);
  const reason = normalizeOptionalText(input.reason, 1000);
  const sourceEventIds = Array.isArray(input.sourceEventIds)
    ? input.sourceEventIds.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : undefined;
  const id = newDraftId();
  const createdAt = new Date().toISOString();
  const row: XingyePendingDivinationDraft & { key: string } = {
    id, key: id, agentQuestion, content, themeHint, reason, source, sourceEventIds, createdAt,
  };
  await backend.appendJsonl(aid, XINGYE_DIVINATION_DRAFTS_JSONL, row);
  await appendDivinationDraftEventBestEffort(aid, {
    type: 'divination.draft_proposed',
    source,
    subjectId: id,
    payload: {
      draftId: id,
      agentQuestion,
      themeHint: themeHint ?? null,
      reason: reason ?? null,
      sourceEventIds: sourceEventIds ?? [],
    },
  });
  return { id, agentQuestion, content, themeHint, reason, source, sourceEventIds, createdAt };
}

export async function discardDivinationDraft(agentId: string, draftId: string): Promise<boolean> {
  const aid = assertAgentId(agentId, '丢弃占卜（心象）草稿');
  const did = draftId.trim();
  if (!did) throw new Error('丢弃草稿失败：缺少草稿 id。');
  const deleted = await backend.deleteJsonlRecord(aid, XINGYE_DIVINATION_DRAFTS_JSONL, did);
  if (deleted) {
    await appendDivinationDraftEventBestEffort(aid, {
      type: 'divination.draft_discarded',
      source: 'xingye-divination-drafts',
      subjectId: did,
      payload: { draftId: did },
    });
  }
  return deleted;
}

/** Confirmed-from-draft entry 用确定性 id：让 confirm retry 走幂等查重路径。 */
function divinationEntryIdFromDraftId(draftId: string): string {
  return `from-draft-${draftId}`;
}

/**
 * 用户在「待确认草稿」区点「原样保存」/「正式加工」时调用——把心象草稿落进占卜历史。
 *
 *   1. entry id 用 `from-draft-${draftId}`；先 listAppEntries('divination') 查重，
 *      已有 → 复用跳过 append；
 *   2. 否则 appendAppEntry('divination', ...) 写入 entries（发
 *      divination.entry_appended），传 `id` 选项作为确定性 id。
 *   3. 从 drafts 删掉；删除失败仅 warn——重试时 (1) 兜底防重；
 *   4. 发 divination.draft_confirmed。
 *
 * 两条路径共享这一份函数：
 *  - 「原样保存」：edits 只含 agentQuestion / content / themeHint；metadata 固定
 *    心象语义（method='oracle_generic'、symbols=[]、autoSelected=false、**不带**
 *    fortuneScore 等），渲染端就不显示运势区。
 *  - 「正式加工」：edits 额外带 method/methodLabel/title/symbols/autoSelected/
 *    fortuneScore/omens/luckyDirection/luckyColor —— 来自 AI 加工产物。这些字段
 *    都是可选的，缺省时回退到草稿原值或心象固定值；运势相关字段任一缺失则整组
 *    不写入（依赖 entry-store mergeDivinationMetadata 的"全或无"语义）。
 *
 * 进程内 per-draft 锁防止 UI 双击/多窗口产生并发 confirm。
 */
export async function confirmDivinationDraft(
  agentId: string,
  draftId: string,
  edits?: {
    agentQuestion?: string;
    content?: string;
    themeHint?: string | null;
    /** 正式加工产物：覆写 entry 标题；空时回退到 agentQuestion。 */
    title?: string;
    /** 正式加工产物：method/methodLabel（如 'tarot' / '塔罗'）。空时保留 oracle_generic / 心象提示。 */
    method?: string;
    methodLabel?: string;
    /** 正式加工产物：起卦时抽到的符号；空时保留 []。 */
    symbols?: unknown[];
    autoSelected?: boolean;
    fortuneScore?: { overall: number; career: number; love: number; wealth: number };
    omens?: { good: string; bad: string };
    luckyDirection?: string;
    luckyColor?: string;
    /**
     * 正式加工路径：把用户给的「可选关注方向」(用户视角 theme) 也带过来。
     * 与正常生成 entry (PhoneDivinationApp.handleGenerate → appendDivinationEntry)
     * 同款语义——详情页用它显示「记录中的可选关注方向」。注意：与 themeHint 是
     * 不同字段，themeHint 是草稿自己的主题（agent 视角），userProvidedTheme 是
     * 用户外部输入。
     */
    userProvidedTheme?: string;
  },
): Promise<AppEntry> {
  const aid = assertAgentId(agentId, '确认占卜（心象）草稿');
  const did = draftId.trim();
  if (!did) throw new Error('确认草稿失败：缺少草稿 id。');
  return withDraftConfirmLock(`divination::${aid}::${did}`, async () => {
    const expectedEntryId = divinationEntryIdFromDraftId(did);
    const existingEntry = (await listAppEntries(aid, 'divination')).find((e) => e.id === expectedEntryId);

    const draft = (await listDivinationDrafts(aid)).find((d) => d.id === did);
    if (!draft && !existingEntry) {
      throw new Error('确认草稿失败：草稿不存在或已被丢弃。');
    }

    let entry: AppEntry;
    if (existingEntry) {
      entry = existingEntry;
    } else if (draft) {
      const agentQuestion = ((edits?.agentQuestion ?? draft.agentQuestion) || '').trim().slice(0, 200);
      if (!agentQuestion) throw new Error('确认草稿失败：agentQuestion 不能为空。');
      const content = ((edits?.content ?? draft.content) || '').trim().slice(0, 2000);
      if (!content) throw new Error('确认草稿失败：正文（心象）不能为空。');

      const resolveTheme = (): string | undefined => {
        if (edits && Object.prototype.hasOwnProperty.call(edits, 'themeHint')) {
          if (edits.themeHint === null) return undefined;
          if (typeof edits.themeHint === 'string') return normalizeOptionalText(edits.themeHint, 80);
        }
        return draft.themeHint;
      };
      const themeHint = resolveTheme();

      const effectiveMethod = (edits?.method && edits.method.trim()) || DIVINATION_DRAFT_FIXED_METHOD;
      const effectiveMethodLabel = (edits?.methodLabel && edits.methodLabel.trim()) || DIVINATION_DRAFT_FIXED_METHOD_LABEL;
      const effectiveSymbols = Array.isArray(edits?.symbols) ? edits!.symbols : [];
      const effectiveAutoSelected = typeof edits?.autoSelected === 'boolean' ? edits.autoSelected : false;
      const effectiveTitle = (edits?.title && edits.title.trim()) || agentQuestion;

      const metadata: Record<string, unknown> = {
        method: effectiveMethod,
        methodLabel: effectiveMethodLabel,
        question: agentQuestion,
        agentQuestion,
        symbols: effectiveSymbols,
        autoSelected: effectiveAutoSelected,
        resolverReason: draft.reason || '巡检：TA 主动写下的心象提示',
      };
      if (themeHint) metadata.themeHint = themeHint;
      if (edits?.userProvidedTheme && edits.userProvidedTheme.trim()) {
        metadata.userProvidedTheme = edits.userProvidedTheme.trim();
      }
      if (edits?.fortuneScore) metadata.fortuneScore = edits.fortuneScore;
      if (edits?.omens) metadata.omens = edits.omens;
      if (edits?.luckyDirection && edits.luckyDirection.trim()) metadata.luckyDirection = edits.luckyDirection.trim();
      if (edits?.luckyColor && edits.luckyColor.trim()) metadata.luckyColor = edits.luckyColor.trim();

      entry = await appendAppEntry(aid, 'divination', {
        id: expectedEntryId,
        title: effectiveTitle,
        content,
        metadata,
        source: 'xingye-heartbeat-confirmed',
      });
    } else {
      throw new Error('确认草稿失败：草稿不存在或已被丢弃。');
    }

    try {
      await backend.deleteJsonlRecord(aid, XINGYE_DIVINATION_DRAFTS_JSONL, did);
    } catch (error) {
      console.warn('[xingye-divination-drafts] confirm draft: failed to delete draft after entry append:', error);
    }
    await appendDivinationDraftEventBestEffort(aid, {
      type: 'divination.draft_confirmed',
      source: 'xingye-divination-drafts',
      subjectId: did,
      payload: { draftId: did, entryId: entry.id, agentQuestion: entry.title, origin: originFromEntryId(entry.id) },
    });
    return entry;
  });
}
