import { postXingyeStorage } from './xingye-storage-api';
import {
  createAgentXingyeStorageBackend,
  type XingyeStorageBackend,
} from './xingye-storage-backend';

const SAFE_AGENT_ID_RE = /^[A-Za-z0-9_-]{1,120}$/;

export type ResolvedAgentScopedXingyePath = {
  agentId: string;
  relativePath: string;
  scopedPath: string;
};

export type XingyeJsonlRecord = Record<string, unknown>;

function normalizeRelativePath(relativePath: string): string {
  const raw = String(relativePath ?? '').trim().replace(/\\/g, '/');
  if (!raw || raw.startsWith('/') || /^[A-Za-z]:\//.test(raw)) {
    throw new Error('relativePath must be a non-empty relative Xingye path');
  }
  const segments = raw.split('/').filter(Boolean);
  if (!segments.length || segments.some((segment) => segment === '.' || segment === '..')) {
    throw new Error('relativePath must stay inside the agent xingye root');
  }
  return segments.join('/');
}

export function requireSafeXingyeAgentId(agentId: string): string {
  const aid = String(agentId ?? '').trim();
  if (!SAFE_AGENT_ID_RE.test(aid)) {
    throw new Error('agentId must contain only letters, numbers, underscore, or dash');
  }
  return aid;
}

export function resolveAgentScopedXingyePath(
  agentId: string,
  relativePath: string,
): ResolvedAgentScopedXingyePath {
  const aid = requireSafeXingyeAgentId(agentId);
  const rel = normalizeRelativePath(relativePath);
  return {
    agentId: aid,
    relativePath: rel,
    scopedPath: `HANA_HOME/agents/${aid}/xingye/${rel}`,
  };
}

export function nowIso(date: Date = new Date()): string {
  return date.toISOString();
}

export function generateXingyeId(prefix = 'xingye'): string {
  const safePrefix = String(prefix || 'xingye').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'xingye';
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${safePrefix}-${crypto.randomUUID()}`;
  }
  return `${safePrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

function jsonlRecordFieldAsString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function recordMatchesId(record: unknown, recordId: string): boolean {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
  const raw = record as Record<string, unknown>;
  return jsonlRecordFieldAsString(raw.id) === recordId || jsonlRecordFieldAsString(raw.key) === recordId;
}

export function createXingyeStore(
  backend: XingyeStorageBackend = createAgentXingyeStorageBackend(postXingyeStorage),
) {
  return {
    readJson<T>(agentId: string, relativePath: string): Promise<T | null> {
      const resolved = resolveAgentScopedXingyePath(agentId, relativePath);
      return backend.readJson<T>(resolved.agentId, resolved.relativePath);
    },

    writeJson<T>(agentId: string, relativePath: string, data: T): Promise<void> {
      const resolved = resolveAgentScopedXingyePath(agentId, relativePath);
      return backend.writeJson<T>(resolved.agentId, resolved.relativePath, data);
    },

    listJsonl<T>(agentId: string, relativePath: string): Promise<T[]> {
      const resolved = resolveAgentScopedXingyePath(agentId, relativePath);
      return backend.listJsonl<T>(resolved.agentId, resolved.relativePath);
    },

    appendJsonl<T>(agentId: string, relativePath: string, record: T): Promise<void> {
      const resolved = resolveAgentScopedXingyePath(agentId, relativePath);
      return backend.appendJsonl<T>(resolved.agentId, resolved.relativePath, record);
    },

    writeJsonl<T>(agentId: string, relativePath: string, records: T[]): Promise<void> {
      const resolved = resolveAgentScopedXingyePath(agentId, relativePath);
      return backend.writeJsonl<T>(resolved.agentId, resolved.relativePath, records);
    },

    async updateJsonlRecord<T>(
      agentId: string,
      relativePath: string,
      recordId: string,
      updater: (record: T) => T | null,
    ): Promise<T | null> {
      const rid = String(recordId ?? '').trim();
      if (!rid) throw new Error('recordId is required');
      const resolved = resolveAgentScopedXingyePath(agentId, relativePath);
      const records = await backend.listJsonl<T>(resolved.agentId, resolved.relativePath);
      let current: T | null = records.find((record) => recordMatchesId(record, rid)) ?? null;
      // Reapply a pure updater to the latest row on conflict. Never retry an
      // ambiguous transport failure: the server may already have committed it.
      for (let attempt = 0; current !== null && attempt < 12; attempt += 1) {
        const updated = updater(structuredClone(current));
        if (updated === null) return null;
        const result = await backend.compareAndSwapJsonlRecord<T>(resolved.agentId, resolved.relativePath, rid, current, updated);
        if (result.updated) return result.record;
        current = result.record;
      }
      if (current === null) return null;
      throw new Error('更新冲突过多，请重试。');
    },

    deleteJsonlRecord(agentId: string, relativePath: string, recordId: string): Promise<boolean> {
      const rid = String(recordId ?? '').trim();
      if (!rid) throw new Error('recordId is required');
      const resolved = resolveAgentScopedXingyePath(agentId, relativePath);
      return backend.deleteJsonlRecord(resolved.agentId, resolved.relativePath, rid);
    },
  };
}
