/**
 * 渲染端「待确认秘密空间草稿」store 助手。
 *
 * 秘密空间的「已生成」记录走 xingye-secret-space-store 的 appendSecretSpaceRecord
 * 路径（每个 category 一个 jsonl）。这里只挂草稿这一支：
 *
 *  - 草稿落到统一的 `secret-space/drafts.jsonl`（不分 category 文件 —— UI
 *    入口在 SecretSpacePanel home 顶部，列表里再用 `category` 字段区分）。
 *  - listSecretSpaceDrafts / appendSecretSpaceDraft / discardSecretSpaceDraft /
 *    confirmSecretSpaceDraft 四件套，发对应的 secret_space.draft_* 事件。
 *  - confirm 路径调用 appendSecretSpaceRecord(category, ...)，把 title/body/tags
 *    塞进 record；category 写入后即发 secret_space.record_appended。
 *  - 限制 category 到 state / dream / saved_item 三个（与 server 端
 *    SECRET_SPACE_DRAFT_ALLOWED_CATEGORIES 同步）。
 */

import { appendXingyeEvent, type XingyeEventInput } from './xingye-event-log';
import { postXingyeStorage } from './xingye-storage-api';
import { createAgentXingyeStorageBackend } from './xingye-storage-backend';
import { appendSecretSpaceRecord, listSecretSpaceRecords } from './xingye-secret-space-store';
import type { SecretSpaceCategoryId } from './SecretSpaceHome';
import { withDraftConfirmLock } from './xingye-draft-confirm-lock';

const backend = createAgentXingyeStorageBackend(postXingyeStorage);

async function appendSecretSpaceDraftEventBestEffort(
  agentId: string,
  input: Omit<XingyeEventInput, 'agentId'>,
): Promise<void> {
  try {
    await appendXingyeEvent(agentId, input);
  } catch (error) {
    console.warn('[xingye-secret-space-drafts] event log append failed:', error);
  }
}

export const XINGYE_SECRET_SPACE_DRAFTS_JSONL = 'secret-space/drafts.jsonl';

const SAFE_AGENT_ID_RE = /^[A-Za-z0-9_-]{1,120}$/;

/** 与 lib/xingye/secret-space-drafts.js SECRET_SPACE_DRAFT_ALLOWED_CATEGORIES 同步。 */
export const SECRET_SPACE_DRAFT_ALLOWED_CATEGORIES = ['state', 'dream', 'saved_item'] as const;
export type SecretSpaceDraftCategory = (typeof SECRET_SPACE_DRAFT_ALLOWED_CATEGORIES)[number];

const ALLOWED_SET = new Set<string>(SECRET_SPACE_DRAFT_ALLOWED_CATEGORIES);

export type XingyePendingSecretSpaceDraft = {
  id: string;
  category: SecretSpaceDraftCategory;
  title?: string;
  body: string;
  tags?: string[];
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

function isAllowedCategory(value: unknown): value is SecretSpaceDraftCategory {
  return typeof value === 'string' && ALLOWED_SET.has(value);
}

function normalizeOptionalText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, max);
}

function normalizeTags(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    out.push(trimmed.slice(0, 32));
    if (out.length >= 8) break;
  }
  return out.length ? out : undefined;
}

function normalizeDraftRow(value: unknown): XingyePendingSecretSpaceDraft | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : '';
  if (!id) return null;
  const category = raw.category;
  if (!isAllowedCategory(category)) return null;
  const body = normalizeOptionalText(raw.body, 4000);
  if (!body) return null;
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
    category,
    title: normalizeOptionalText(raw.title, 160),
    body,
    tags: normalizeTags(raw.tags),
    reason: normalizeOptionalText(raw.reason, 1000),
    source,
    sourceEventIds,
    createdAt,
  };
}

function sortDrafts(
  a: XingyePendingSecretSpaceDraft,
  b: XingyePendingSecretSpaceDraft,
): number {
  const ta = Date.parse(a.createdAt);
  const tb = Date.parse(b.createdAt);
  if (ta !== tb && !Number.isNaN(ta) && !Number.isNaN(tb)) return tb - ta;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

export async function listSecretSpaceDrafts(
  agentId: string,
): Promise<XingyePendingSecretSpaceDraft[]> {
  const aid = String(agentId ?? '').trim();
  if (!aid) return [];
  try {
    const rows = await backend.listJsonl<unknown>(aid, XINGYE_SECRET_SPACE_DRAFTS_JSONL);
    return rows
      .map(normalizeDraftRow)
      .filter((d): d is XingyePendingSecretSpaceDraft => Boolean(d))
      .sort(sortDrafts);
  } catch {
    return [];
  }
}

function newDraftId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `ss-${crypto.randomUUID()}`;
  }
  return `ss-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function appendSecretSpaceDraft(
  agentId: string,
  input: {
    category: SecretSpaceDraftCategory;
    title?: string;
    body: string;
    tags?: string[];
    reason?: string;
    source: string;
    sourceEventIds?: string[];
  },
): Promise<XingyePendingSecretSpaceDraft> {
  const aid = assertAgentId(agentId, '保存秘密空间草稿');
  if (!isAllowedCategory(input.category)) {
    throw new Error(`草稿 category 不允许：${input.category}。允许：${SECRET_SPACE_DRAFT_ALLOWED_CATEGORIES.join(' / ')}。`);
  }
  const body = (input.body ?? '').trim().slice(0, 4000);
  if (!body) throw new Error('草稿正文不能为空。');
  const source = input.source.trim();
  if (!source) throw new Error('草稿来源 (source) 不能为空。');
  const title = normalizeOptionalText(input.title, 160);
  const tags = normalizeTags(input.tags);
  const reason = normalizeOptionalText(input.reason, 1000);
  const sourceEventIds = Array.isArray(input.sourceEventIds)
    ? input.sourceEventIds.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : undefined;
  const id = newDraftId();
  const createdAt = new Date().toISOString();
  const row: XingyePendingSecretSpaceDraft & { key: string } = {
    id, key: id, category: input.category, title, body, tags, createdAt, reason, source, sourceEventIds,
  };
  await backend.appendJsonl(aid, XINGYE_SECRET_SPACE_DRAFTS_JSONL, row);
  await appendSecretSpaceDraftEventBestEffort(aid, {
    type: 'secret_space.draft_proposed',
    source,
    subjectId: id,
    payload: {
      draftId: id,
      category: input.category,
      titleExcerpt: title ? title.slice(0, 60) : null,
      bodyExcerpt: body.slice(0, 60),
      reason: reason ?? null,
      sourceEventIds: sourceEventIds ?? [],
    },
  });
  return { id, category: input.category, title, body, tags, createdAt, reason, source, sourceEventIds };
}

export async function discardSecretSpaceDraft(
  agentId: string,
  draftId: string,
): Promise<boolean> {
  const aid = assertAgentId(agentId, '丢弃秘密空间草稿');
  const did = draftId.trim();
  if (!did) throw new Error('丢弃草稿失败：缺少草稿 id。');
  const deleted = await backend.deleteJsonlRecord(aid, XINGYE_SECRET_SPACE_DRAFTS_JSONL, did);
  if (deleted) {
    await appendSecretSpaceDraftEventBestEffort(aid, {
      type: 'secret_space.draft_discarded',
      source: 'xingye-secret-space-drafts',
      subjectId: did,
      payload: { draftId: did },
    });
  }
  return deleted;
}

/** Confirmed-from-draft record 用确定性 key：让 confirm retry 走幂等查重路径。 */
function secretSpaceRecordKeyFromDraftId(draftId: string): string {
  return `from-draft-${draftId}`;
}

/**
 * 确认草稿：
 *   1. record key 用 `from-draft-${draftId}`；先 listSecretSpaceRecords(category)
 *      查重，发现已有同 key 的 record（说明上一次 confirm 写完但 delete draft 失败）
 *      → 复用，跳过 appendSecretSpaceRecord；
 *   2. 否则 appendSecretSpaceRecord 写入 secret-space/{category}.jsonl（发
 *      secret_space.record_appended）；
 *   3. 从 drafts 删掉；删除失败仅 warn——重试时 (1) 兜底防重；
 *   4. 发 secret_space.draft_confirmed。
 *
 * 用户可改 category（限制在允许子集里），title / body / tags。
 *
 * 已知边界：用户在 retry 前把 category 改成另一个允许值会让查重在新 category 失败，
 * 从而在新 category 重新写一条记录——但 entries 总数仍受控（每 category 内只 1 条）。
 * 这是低概率场景；UI 默认不让 category 在 confirm 流程里被改。
 *
 * 进程内 per-draft 锁防止 UI 双击/多窗口产生并发 confirm。
 */
export async function confirmSecretSpaceDraft(
  agentId: string,
  draftId: string,
  edits?: {
    category?: SecretSpaceDraftCategory;
    title?: string;
    body?: string;
    tags?: string[] | null;
  },
): Promise<{ category: SecretSpaceDraftCategory; recordId: string }> {
  const aid = assertAgentId(agentId, '确认秘密空间草稿');
  const did = draftId.trim();
  if (!did) throw new Error('确认草稿失败：缺少草稿 id。');
  return withDraftConfirmLock(`secret_space::${aid}::${did}`, async () => {
    const expectedRecordKey = secretSpaceRecordKeyFromDraftId(did);
    const draft = (await listSecretSpaceDrafts(aid)).find((d) => d.id === did);

    /**
     * 决定目标 category：edits.category > draft.category。
     * 如果 draft 已不存在但仍有 edits.category（理论上不会，但兜底），直接走 edits。
     */
    const category: SecretSpaceDraftCategory =
      edits?.category && isAllowedCategory(edits.category)
        ? edits.category
        : (draft?.category as SecretSpaceDraftCategory | undefined ?? 'state');

    /** 在目标 category 查重——orphan-retry 场景的核心兜底。 */
    const existingRecord = (await listSecretSpaceRecords(aid, category as SecretSpaceCategoryId))
      .find((r) => r.recordId === expectedRecordKey);

    if (!draft && !existingRecord) {
      throw new Error('确认草稿失败：草稿不存在或已被丢弃。');
    }

    if (!existingRecord) {
      if (!draft) {
        throw new Error('确认草稿失败：草稿不存在或已被丢弃。');
      }
      const body = (edits?.body ?? draft.body).trim().slice(0, 4000);
      if (!body) throw new Error('确认草稿失败：正文不能为空。');
      const title = normalizeOptionalText(edits?.title ?? draft.title ?? '', 160);
      const resolveTags = (): string[] | undefined => {
        if (edits && Object.prototype.hasOwnProperty.call(edits, 'tags')) {
          if (edits.tags === null) return undefined;
          return normalizeTags(edits.tags);
        }
        return draft.tags;
      };
      const tags = resolveTags();

      /**
       * appendSecretSpaceRecord 接受 generic body：把 title/body/tags 一起塞进去。
       * recordId 由 store 内部 stableSecretSpaceRecordId 算出；传入 key 让它落到
       * `from-draft-${draftId}`，后续查重 / 删除都按这个稳定 key。
       */
      const recordBody: Record<string, unknown> = {
        key: expectedRecordKey,
        title: title || undefined,
        body,
        source: 'xingye-heartbeat-confirmed',
      };
      if (tags && tags.length > 0) recordBody.tags = tags;

      await appendSecretSpaceRecord(aid, category as SecretSpaceCategoryId, recordBody);
    }

    try {
      await backend.deleteJsonlRecord(aid, XINGYE_SECRET_SPACE_DRAFTS_JSONL, did);
    } catch (error) {
      console.warn('[xingye-secret-space-drafts] confirm draft: failed to delete draft after record append:', error);
    }
    await appendSecretSpaceDraftEventBestEffort(aid, {
      type: 'secret_space.draft_confirmed',
      source: 'xingye-secret-space-drafts',
      subjectId: did,
      payload: { draftId: did, category, recordKey: expectedRecordKey },
    });
    return { category, recordId: expectedRecordKey };
  });
}
