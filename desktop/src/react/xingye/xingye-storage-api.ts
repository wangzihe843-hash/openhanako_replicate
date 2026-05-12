/**
 * 低层星野 workspace 文件 API（/api/xingye/storage），与 persistence 解耦供各模块调用。
 */

import { useStore } from '../stores';
import { hanaFetch } from '../hooks/use-hana-fetch';

export async function postXingyeStorage(body: Record<string, unknown>): Promise<any> {
  const agentId = useStore.getState().currentAgentId;
  const res = await hanaFetch('/api/xingye/storage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, agentId }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || res.statusText);
  return data;
}
