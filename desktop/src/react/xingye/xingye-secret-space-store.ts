/**
 * xingye-secret-space-store.ts — 秘密空间历史记录（workspace-first，不经 localStorage）
 */

import { sanitizeAgentIdForPath } from './xingye-agent-path';
import { postXingyeStorage } from './xingye-storage-api';

export type SecretSpaceCategoryId =
  | 'state'
  | 'draft_reply'
  | 'dream'
  | 'saved_item'
  | 'unsent_moment'
  | 'memory_fragment';

export interface SecretSpaceRecordRef {
  relativePath: string;
  title: string;
  createdAt: string;
}

function secretSpaceCategoryRel(agentId: string, category: SecretSpaceCategoryId): string {
  return `agents/${sanitizeAgentIdForPath(agentId)}/secret-space/${category}`;
}

export async function listSecretSpaceRecords(
  agentId: string,
  category: SecretSpaceCategoryId,
): Promise<SecretSpaceRecordRef[]> {
  const rel = secretSpaceCategoryRel(agentId, category);
  try {
    const data = await postXingyeStorage({ action: 'list', relativePath: rel });
    const entries = Array.isArray(data.entries) ? data.entries : [];
    return entries
      .filter((e: { isDir?: boolean; name?: string }) => !e.isDir && typeof e.name === 'string' && /\.json$/i.test(e.name))
      .map((e: { name: string; mtime?: string }) => ({
        relativePath: `${rel}/${e.name}`,
        title: e.name.replace(/\.json$/i, ''),
        createdAt: e.mtime || '',
      }))
      .sort((a: SecretSpaceRecordRef, b: SecretSpaceRecordRef) => Date.parse(b.createdAt || '0') - Date.parse(a.createdAt || '0'));
  } catch {
    return [];
  }
}

export async function appendSecretSpaceRecord(
  agentId: string,
  category: SecretSpaceCategoryId,
  body: Record<string, unknown>,
): Promise<void> {
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const rel = `${secretSpaceCategoryRel(agentId, category)}/${runId}.json`;
  await postXingyeStorage({
    action: 'write',
    relativePath: rel,
    content: JSON.stringify({ ...body, createdAt: new Date().toISOString() }, null, 2),
  });
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('xingye-secret-space-changed', { detail: { agentId, category } }));
  }
}
