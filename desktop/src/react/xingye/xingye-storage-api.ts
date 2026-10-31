import { hanaFetch } from '../hooks/use-hana-fetch';
import type { ServerConnection } from '../services/server-connection';

export async function postXingyeStorage(body: Record<string, unknown>, connection?: ServerConnection) {
  if (typeof body.agentId !== 'string' || !body.agentId) {
    throw new Error('agentId is required');
  }
  const res = await hanaFetch('/api/xingye/storage', {
    connection,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || res.statusText);
  return data;
}
