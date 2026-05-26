import { hanaFetch } from '../../api';

export interface NormalizedUsage {
  input?: {
    totalTokens?: number | null;
    uncachedTokens?: number | null;
  };
  output?: {
    totalTokens?: number | null;
    reasoningTokens?: number | null;
  };
  cache?: {
    readTokens?: number | null;
    writeTokens?: number | null;
    missTokens?: number | null;
    hit?: boolean | null;
    created?: boolean | null;
    hitRatio?: number | null;
    support?: string | null;
  };
  totalTokens?: number | null;
  costTotal?: number | null;
}

export interface UsageLedgerEntry {
  requestId: string;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  status: 'ok' | 'error' | 'aborted' | 'usage_missing';
  source: {
    subsystem?: string;
    operation?: string;
    surface?: string;
    trigger?: string;
    actor?: Record<string, unknown>;
    parent?: Record<string, unknown>;
  };
  attribution: {
    kind?: string;
    agentId?: string | null;
    sessionPath?: string | null;
    conversationId?: string | null;
    conversationType?: string | null;
    childAgentId?: string | null;
    childSessionPath?: string | null;
    taskId?: string | null;
  };
  model: {
    provider?: string | null;
    modelId?: string | null;
    api?: string | null;
  };
  usage: NormalizedUsage | null;
  error: {
    name?: string | null;
    message?: string | null;
  } | null;
}

export async function loadLlmUsageEntries(limit = 500): Promise<UsageLedgerEntry[]> {
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 2000) : 500;
  const res = await hanaFetch(`/api/usage/llm?limit=${safeLimit}`);
  const data: unknown = await res.json();
  if (!isUsageResponse(data)) return [];
  return data.entries;
}

function isUsageResponse(value: unknown): value is { entries: UsageLedgerEntry[] } {
  if (!value || typeof value !== 'object') return false;
  const entries = (value as { entries?: unknown }).entries;
  return Array.isArray(entries);
}
