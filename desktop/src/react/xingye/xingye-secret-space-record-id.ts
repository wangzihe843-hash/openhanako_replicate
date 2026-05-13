import type { SecretSpaceCategoryId } from './SecretSpaceHome';

/** 与 server `jsonlRecordFieldAsString` 对齐 */
export function recordFieldAsString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function fnv1a32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * 旧 JSONL 行无 recordId/key/id 时，用分类 + 固定字段生成确定性 id（不依赖行序，避免删一条后其它行 id 漂移）。
 * 若两条记录内容完全一致，会得到相同 id（极少见）；删除只移除第一条匹配。
 */
export function legacySecretSpaceRecordId(
  category: SecretSpaceCategoryId,
  raw: Record<string, unknown>,
): string {
  const createdAt = typeof raw.createdAt === 'string' ? raw.createdAt : '';
  const title = typeof raw.title === 'string' ? raw.title : '';
  const body = typeof raw.body === 'string'
    ? raw.body
    : (typeof raw.content === 'string' ? raw.content : '');
  const summary = typeof raw.summary === 'string' ? raw.summary : '';
  const payload = `${category}\x00${createdAt}\x00${title}\x00${body}\x00${summary}`;
  const h = fnv1a32(payload);
  return `ss-leg-${h.toString(16).padStart(8, '0')}`;
}

/**
 * 全链路唯一删除主键：优先存储 recordId，其次 key / id，最后 legacy 确定性 id。
 */
export function stableSecretSpaceRecordId(
  category: SecretSpaceCategoryId,
  raw: Record<string, unknown>,
): string {
  return recordFieldAsString(raw.recordId)
    || recordFieldAsString(raw.key)
    || recordFieldAsString(raw.id)
    || legacySecretSpaceRecordId(category, raw);
}
