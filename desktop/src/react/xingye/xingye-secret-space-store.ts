/**
 * xingye-secret-space-store.ts — 秘密空间历史记录（workspace-first，不经 localStorage）
 */

import { xingyeStorageClient } from './xingye-persistence';

export type SecretSpaceCategoryId =
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

function agentDir(agentId: string): string {
  return agentId.replace(/[^a-zA-Z0-9-_]/g, '_').slice(0, 120) || 'agent';
}

export async function listSecretSpaceRecords(
  agentId: string,
  category: SecretSpaceCategoryId,
): Promise<SecretSpaceRecordRef[]> {
  const rel = `v1/secret-space/${agentDir(agentId)}/${category}`;
  try {
    const data = await xingyeStorageClient({ action: 'list', relativePath: rel });
    const entries = Array.isArray(data.entries) ? data.entries : [];
    return entries
      .filter((e: { isDir?: boolean; name?: string }) => !e.isDir && typeof e.name === 'string' && /\.json$/i.test(e.name))
      .map((e: { name: string; mtime?: string }) => ({
        relativePath: `${rel}/${e.name}`,
        title: e.name.replace(/\.json$/i, ''),
        createdAt: e.mtime || '',
      }))
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
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const rel = `v1/secret-space/${agentDir(agentId)}/${category}/${runId}.json`;
  await xingyeStorageClient({
    action: 'write',
    relativePath: rel,
    content: JSON.stringify({ ...body, createdAt: new Date().toISOString() }, null, 2),
  });
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('xingye-secret-space-changed', { detail: { agentId, category } }));
  }
}
