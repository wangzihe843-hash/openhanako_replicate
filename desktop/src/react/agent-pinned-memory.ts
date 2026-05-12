/**
 * 轻量同步：同一 renderer 内 pinned 变更广播 + GET 解析。
 * 与 xingye-memory-candidate-store 的 normalizePinBulletText 语义保持一致（对账用）。
 */

export const OPENHANAKO_AGENT_PINNED_MEMORY_CHANGED = 'openhanako-agent-pinned-memory-changed';

export type AgentPinnedMemoryChangedSource = 'settings' | 'xingye-secret-space' | 'unknown';

export type AgentPinnedMemoryChangedDetail = {
  agentId: string;
  source: AgentPinnedMemoryChangedSource;
  pinsCount?: number;
};

export type FetchLike = (path: string, init?: RequestInit & { timeout?: number }) => Promise<Response>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** 与 xingye-memory-candidate-store.normalizePinBulletText 保持同步 */
export function normalizePinBulletForMatch(content: string): string {
  return content.replace(/\s+/g, ' ').trim();
}

export function pinnedListContainsNormalizedContent(pins: string[], candidateContent: string): boolean {
  const bullet = normalizePinBulletForMatch(candidateContent);
  if (!bullet) return false;
  return pins.some((p) => normalizePinBulletForMatch(p) === bullet);
}

export async function loadAgentPinnedMemory(agentId: string, fetchImpl: FetchLike): Promise<string[]> {
  const res = await fetchImpl(`/api/agents/${agentId}/pinned`);
  const json: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err =
      isRecord(json) && typeof json.error === 'string'
        ? json.error
        : `GET pinned failed (${res.status})`;
    throw new Error(err);
  }
  const pinsRaw = isRecord(json) ? json.pins : undefined;
  if (!Array.isArray(pinsRaw)) return [];
  return pinsRaw.filter((p): p is string => typeof p === 'string').map((p) => p.trim()).filter(Boolean);
}

export function emitAgentPinnedMemoryChanged(detail: AgentPinnedMemoryChangedDetail): void {
  if (typeof window === 'undefined' || !detail?.agentId) return;
  window.dispatchEvent(new CustomEvent(OPENHANAKO_AGENT_PINNED_MEMORY_CHANGED, { detail }));
}

export type AgentPinnedMemoryChangedHandler = (detail: AgentPinnedMemoryChangedDetail) => void;

export function subscribeAgentPinnedMemoryChanged(handler: AgentPinnedMemoryChangedHandler): () => void {
  const fn = (ev: Event) => {
    const ce = ev as CustomEvent<AgentPinnedMemoryChangedDetail>;
    if (ce.detail?.agentId) handler(ce.detail);
  };
  window.addEventListener(OPENHANAKO_AGENT_PINNED_MEMORY_CHANGED, fn as EventListener);
  return () => window.removeEventListener(OPENHANAKO_AGENT_PINNED_MEMORY_CHANGED, fn as EventListener);
}
