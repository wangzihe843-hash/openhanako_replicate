import type { SecretSpaceCategoryId } from './SecretSpaceHome';
import type { SecretSpaceSampleRecord } from './secret-space-record-types';
import { postXingyeStorage } from './xingye-storage-api';
import { createAgentXingyeStorageBackend } from './xingye-storage-backend';

const backend = createAgentXingyeStorageBackend(postXingyeStorage);

function secretSpaceCategoryRel(category: SecretSpaceCategoryId): string {
  return `secret-space/${category}.jsonl`;
}

function normalizeRecord(
  value: unknown,
  category: SecretSpaceCategoryId,
  index: number,
): SecretSpaceSampleRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const createdAt = typeof raw.createdAt === 'string' && raw.createdAt ? raw.createdAt : new Date(0).toISOString();
  const key =
    (typeof raw.key === 'string' && raw.key)
    || (typeof raw.id === 'string' && raw.id)
    || `${category}-${index}`;
  const title = typeof raw.title === 'string' && raw.title ? raw.title : key;
  const body = typeof raw.body === 'string'
    ? raw.body
    : (typeof raw.content === 'string' ? raw.content : '');
  const kind = category === 'state' ? 'memory_fragment' : category;
  if (!body && typeof raw.summary !== 'string') return null;
  return {
    key,
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
      .map((record, index) => normalizeRecord(record, category, index))
      .filter((record): record is SecretSpaceSampleRecord => Boolean(record))
      .sort((a, b) => Date.parse(b.createdAt || '0') - Date.parse(a.createdAt || '0'));
  } catch {
    return [];
  }
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
  await backend.appendJsonl(agentId, secretSpaceCategoryRel(category), {
    ...body,
    key,
    id: typeof body.id === 'string' && body.id ? body.id : key,
    kind: body.kind ?? category,
    createdAt: body.createdAt ?? now,
    updatedAt: body.updatedAt ?? body.createdAt ?? now,
  });
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('xingye-secret-space-changed', { detail: { agentId, category } }));
  }
}
