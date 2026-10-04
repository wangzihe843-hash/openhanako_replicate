/** Source identities for derived memory. Never infer scope or validity from prose. */
export type MemorySourceRef = { entryId: string; hash: string; role?: string };
export type MemorySourceDependency = {
  sessionId: string;
  entryId?: string;
  revision?: string;
  type?: string;
  hash?: string;
  generation?: number;
  writeFence?: number;
  sourceRefs?: MemorySourceRef[];
  upstreamSummaryIds?: string[];
};
export type MemorySourceStatus = 'unknown' | 'active' | 'stale';

export function normalizeMemorySourceDependencies(value: unknown): MemorySourceDependency[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 100) throw new Error('invalid memory source dependencies');
  return value.map((raw) => {
    if (!raw || typeof raw !== 'object' || typeof raw.sessionId !== 'string' || !raw.sessionId.trim()) {
      throw new Error('invalid memory source session');
    }
    const dependency: MemorySourceDependency = { sessionId: raw.sessionId.trim() };
    if (raw.entryId !== undefined) {
      if (typeof raw.entryId !== 'string' || !raw.entryId.trim()) throw new Error('invalid memory source entry');
      dependency.entryId = raw.entryId;
    }
    if (typeof raw.type === 'string') dependency.type = raw.type;
    if (raw.hash !== undefined) {
      if (typeof raw.hash !== 'string' || !/^[a-f0-9]{64}$/.test(raw.hash)) throw new Error('invalid memory dependency hash');
      dependency.hash = raw.hash;
    }
    if (raw.generation !== undefined) {
      if (!Number.isSafeInteger(raw.generation) || raw.generation < 0) throw new Error('invalid memory dependency generation');
      dependency.generation = raw.generation;
    }
    if (raw.writeFence !== undefined) {
      if (!Number.isSafeInteger(raw.writeFence) || raw.writeFence < 0) throw new Error('invalid memory dependency write fence');
      dependency.writeFence = raw.writeFence;
    }
    if (raw.revision !== undefined) {
      if ((typeof raw.revision !== 'string' && typeof raw.revision !== 'number') || !String(raw.revision).trim()) {
        throw new Error('invalid memory source revision');
      }
      dependency.revision = String(raw.revision);
    }
    if (raw.sourceRefs !== undefined) {
      if (!Array.isArray(raw.sourceRefs) || raw.sourceRefs.length > 1000) throw new Error('invalid memory source refs');
      dependency.sourceRefs = raw.sourceRefs.map((ref: MemorySourceRef) => {
        if (!ref || typeof ref.entryId !== 'string' || !ref.entryId.trim()
          || typeof ref.hash !== 'string' || !/^[a-f0-9]{64}$/.test(ref.hash)) throw new Error('invalid memory source hash');
        return { entryId: ref.entryId, hash: ref.hash, ...(typeof ref.role === 'string' ? { role: ref.role } : {}) };
      });
    }
    if (raw.upstreamSummaryIds !== undefined) {
      if (!Array.isArray(raw.upstreamSummaryIds) || raw.upstreamSummaryIds.some((id: unknown) => typeof id !== 'string' || !id.trim())) {
        throw new Error('invalid memory upstream summaries');
      }
      dependency.upstreamSummaryIds = [...raw.upstreamSummaryIds];
    }
    return dependency;
  });
}
