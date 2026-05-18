import type { SecretSpaceCategoryId } from './SecretSpaceHome';
import type { SecretSpaceSampleRecord } from './secret-space-record-types';
import { postXingyeStorage } from './xingye-storage-api';
import { createAgentXingyeStorageBackend } from './xingye-storage-backend';
import { appendXingyeEvent } from './xingye-event-log';
import {
  recordFieldAsString,
  stableSecretSpaceRecordId,
} from './xingye-secret-space-record-id';
import { originFromEntryId } from './xingye-draft-confirm-lock';

const backend = createAgentXingyeStorageBackend(postXingyeStorage);

/** 与 server/routes/xingye-storage.js SAFE_AGENT_ID_RE 一致 */
const SAFE_AGENT_ID_RE = /^[A-Za-z0-9_-]{1,120}$/;

function secretSpaceCategoryRel(category: SecretSpaceCategoryId): string {
  return `secret-space/${category}.jsonl`;
}

function normalizeRecord(
  value: unknown,
  category: SecretSpaceCategoryId,
): SecretSpaceSampleRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const createdAt = typeof raw.createdAt === 'string' && raw.createdAt ? raw.createdAt : new Date(0).toISOString();
  const recordIdStable = stableSecretSpaceRecordId(category, raw);
  const title = typeof raw.title === 'string' && raw.title ? raw.title : recordIdStable;
  const body = typeof raw.body === 'string'
    ? raw.body
    : (typeof raw.content === 'string' ? raw.content : '');
  /**
   * 直接用 category 作 kind——secret-space-record-types 里已为 state 加了一项。
   * 之前把 state 强行重命名成 memory_fragment 会让 state.jsonl 里的条目在列表
   * 里挂"回忆"标签，跟主视图（RelationshipStatePanel）语义错位。
   */
  const kind = category;
  if (!body && typeof raw.summary !== 'string') return null;
  return {
    recordId: recordIdStable,
    key: recordIdStable,
    title,
    body,
    createdAt,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : undefined,
    summary: typeof raw.summary === 'string' ? raw.summary : undefined,
    meta: typeof raw.meta === 'string' ? raw.meta : undefined,
    source: typeof raw.source === 'string' ? raw.source : undefined,
    tags: Array.isArray(raw.tags) ? raw.tags.filter((tag): tag is string => typeof tag === 'string') : undefined,
    kind,
  };
}

export async function listSecretSpaceRecords(
  agentId: string,
  category: SecretSpaceCategoryId,
): Promise<SecretSpaceSampleRecord[]> {
  if (!agentId) return [];
  try {
    const records = await backend.listJsonl<Record<string, unknown>>(agentId, secretSpaceCategoryRel(category));
    return records
      .map((record) => normalizeRecord(record, category))
      .filter((record): record is SecretSpaceSampleRecord => Boolean(record))
      .sort((a, b) => Date.parse(b.createdAt || '0') - Date.parse(a.createdAt || '0'));
  } catch {
    return [];
  }
}

function logDeleteDebug(
  phase: string,
  payload: { agentId: string; category: SecretSpaceCategoryId; recordId: string },
): void {
  if (typeof process === 'undefined' || process.env.NODE_ENV !== 'development') return;
  console.warn('[deleteSecretSpaceRecord]', phase, {
    agentId: payload.agentId.slice(0, 80),
    category: payload.category,
    recordId: payload.recordId.slice(0, 160),
    method: 'POST',
    path: '/api/xingye/storage',
    action: 'write',
    bodyKeys: ['action', 'agentId', 'relativePath', 'encoding', 'content'],
  });
}

async function appendSecretSpaceEvent(
  agentId: string,
  event: {
    type: 'secret_space.record_appended' | 'secret_space.record_deleted';
    subjectId: string;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  try {
    await appendXingyeEvent(agentId, {
      type: event.type,
      source: 'xingye-secret-space-store',
      subjectId: event.subjectId,
      payload: event.payload,
    });
  } catch (error) {
    console.warn('[xingye-secret-space-store] event log append failed:', error);
  }
}

/** 写回时补齐 recordId/key/id，便于后续删除不再依赖 legacy 推导 */
function enrichRowForPersist(category: SecretSpaceCategoryId, raw: Record<string, unknown>): Record<string, unknown> {
  const id = stableSecretSpaceRecordId(category, raw);
  return {
    ...raw,
    recordId: recordFieldAsString(raw.recordId) || id,
    key: recordFieldAsString(raw.key) || id,
    id: recordFieldAsString(raw.id) || id,
  };
}

/**
 * 删除一条秘密空间记录：listJsonl → 去掉匹配 recordId 的行 → `action:write` 写回 UTF-8 JSONL。
 * 不依赖后端 `deleteJsonlRecord`（避免旧服务端返回 400 invalid action）。
 */
export async function deleteSecretSpaceRecord(
  agentId: string,
  category: SecretSpaceCategoryId,
  recordId: string,
): Promise<boolean> {
  const rid = recordId.trim();
  const aid = agentId.trim();

  if (!aid) {
    throw new Error('删除失败：缺少 agentId。');
  }
  if (!SAFE_AGENT_ID_RE.test(aid)) {
    throw new Error(`删除失败：agentId 格式无效（仅允许字母、数字、下划线与短横线，长度 1–120）。`);
  }
  if (!rid) {
    throw new Error('删除失败：缺少 recordId。');
  }

  logDeleteDebug('request', { agentId: aid, category, recordId: rid });

  const rel = secretSpaceCategoryRel(category);
  const rows = await backend.listJsonl<Record<string, unknown>>(aid, rel);

  const next: Record<string, unknown>[] = [];
  let removed = false;
  for (const raw of rows) {
    const sid = stableSecretSpaceRecordId(category, raw);
    if (!removed && sid === rid) {
      removed = true;
      continue;
    }
    next.push(enrichRowForPersist(category, raw));
  }

  if (!removed) {
    logDeleteDebug('not-found', { agentId: aid, category, recordId: rid });
    return false;
  }

  const content = next.length === 0 ? '' : `${next.map((r) => JSON.stringify(r)).join('\n')}\n`;

  logDeleteDebug('write', { agentId: aid, category, recordId: rid });

  await postXingyeStorage({
    action: 'write',
    agentId: aid,
    relativePath: rel,
    content,
    encoding: 'utf8',
  });

  await appendSecretSpaceEvent(aid, {
    type: 'secret_space.record_deleted',
    subjectId: category,
    payload: { category, recordId: rid },
  });

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('xingye-secret-space-changed', { detail: { agentId: aid, category } }));
  }
  return true;
}

export async function appendSecretSpaceRecord(
  agentId: string,
  category: SecretSpaceCategoryId,
  body: Record<string, unknown>,
): Promise<void> {
  const now = new Date().toISOString();
  const key = typeof body.key === 'string' && body.key
    ? body.key
    : (typeof body.id === 'string' && body.id ? body.id : `${category}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`);
  const stableId = typeof body.recordId === 'string' && body.recordId ? body.recordId : key;
  await backend.appendJsonl(agentId, secretSpaceCategoryRel(category), {
    ...body,
    key,
    id: typeof body.id === 'string' && body.id ? body.id : key,
    recordId: stableId,
    kind: body.kind ?? category,
    createdAt: body.createdAt ?? now,
    updatedAt: body.updatedAt ?? body.createdAt ?? now,
  });
  await appendSecretSpaceEvent(agentId, {
    type: 'secret_space.record_appended',
    subjectId: category,
    payload: {
      category,
      recordId: stableId,
      title: typeof body.title === 'string' ? body.title : undefined,
      source: typeof body.source === 'string' ? body.source : undefined,
      /** stableId 等于 body.key（confirm 路径会传 'from-draft-${draftId}'） */
      origin: originFromEntryId(stableId),
    },
  });
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('xingye-secret-space-changed', { detail: { agentId, category } }));
  }
}
