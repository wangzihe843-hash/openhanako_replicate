/**
 * Durable memory identity. Channel/conversation routing is a separate filter.
 * Missing old metadata is deliberately legacy, never reality or a story world.
 */
export type MemoryRealm = 'legacy' | 'reality' | 'story';
export type MemoryKnowledge = 'shared' | 'character' | 'author';
export interface MemoryScope {
  version: 1;
  agentId: string;
  realm: MemoryRealm;
  worldId?: string;
  branchId?: string;
  knowledge: MemoryKnowledge;
  characterId?: string;
}
export interface MemoryScopeContext extends MemoryScope {
  viewpoint?: 'character' | 'author';
}

export const LEGACY_MEMORY_AGENT_ID = '__legacy__';

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`memory scope requires ${label}`);
  return value.trim();
}

/** Invalid explicit values throw; callers must never turn them into a legacy fallback. */
export function normalizeMemoryScope(value?: unknown, fallbackAgentId?: string): MemoryScope {
  const fallback = fallbackAgentId == null ? LEGACY_MEMORY_AGENT_ID : identifier(fallbackAgentId, 'agentId');
  if (value == null) return { version: 1, agentId: fallback, realm: 'legacy', knowledge: 'shared' };
  if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError('invalid memory scope');
  const input = value as Record<string, unknown>;
  if (input.version !== undefined && input.version !== 1) throw new TypeError('unsupported memory scope version');
  const agentId = input.agentId == null ? fallback : identifier(input.agentId, 'agentId');
  if (input.realm !== 'legacy' && input.realm !== 'reality' && input.realm !== 'story') {
    throw new TypeError('invalid memory realm');
  }
  if (input.agentId == null && fallbackAgentId == null && input.realm !== 'legacy') {
    throw new TypeError('explicit memory scope requires agentId');
  }
  const knowledge = input.knowledge === undefined ? 'shared' : input.knowledge;
  if (knowledge !== 'shared' && knowledge !== 'character' && knowledge !== 'author') {
    throw new TypeError('invalid memory knowledge');
  }
  const scope: MemoryScope = { version: 1, agentId, realm: input.realm, knowledge };
  if (scope.realm === 'story') {
    scope.worldId = identifier(input.worldId, 'worldId');
    scope.branchId = identifier(input.branchId, 'branchId');
  } else if (input.worldId != null || input.branchId != null) {
    throw new TypeError('only story memory can carry worldId or branchId');
  }
  if (knowledge === 'character') scope.characterId = identifier(input.characterId, 'characterId');
  return scope;
}

/** Viewer authority is runtime metadata, not part of the stored scope key. */
export function normalizeMemoryScopeContext(value?: unknown, fallbackAgentId?: string): MemoryScopeContext {
  const scope: MemoryScopeContext = normalizeMemoryScope(value, fallbackAgentId);
  if (value == null) return scope;
  const input = value as Record<string, unknown>;
  if (input.viewpoint !== undefined) {
    if (input.viewpoint !== 'character' && input.viewpoint !== 'author') throw new TypeError('invalid memory viewpoint');
    scope.viewpoint = input.viewpoint;
  }
  if (input.characterId != null) scope.characterId = identifier(input.characterId, 'characterId');
  return scope;
}

/** JSON tuples avoid collisions caused by delimiters inside identifiers. */
export function memoryScopeKey(value?: unknown, fallbackAgentId?: string): string {
  const scope = normalizeMemoryScope(value, fallbackAgentId);
  return JSON.stringify([scope.version, scope.agentId, scope.realm, scope.worldId ?? null,
    scope.branchId ?? null, scope.knowledge, scope.characterId ?? null]);
}

export function sameMemoryScope(a: unknown, b: unknown, fallbackAgentId?: string): boolean {
  try { return memoryScopeKey(a, fallbackAgentId) === memoryScopeKey(b, fallbackAgentId); }
  catch { return false; }
}

/** Fail closed for corrupt persisted records and invalid runtime contexts. */
export function canReadMemoryScope(record: unknown, context?: unknown, fallbackAgentId?: string): boolean {
  try {
    const stored = normalizeMemoryScope(record, fallbackAgentId);
    const viewer = normalizeMemoryScopeContext(context, fallbackAgentId);
    if (stored.agentId !== viewer.agentId || stored.realm !== viewer.realm
      || stored.worldId !== viewer.worldId || stored.branchId !== viewer.branchId) return false;
    if (viewer.viewpoint === 'author') return true;
    if (stored.knowledge === 'author') return false;
    return stored.knowledge === 'shared'
      || (stored.knowledge === 'character' && stored.characterId === viewer.characterId);
  } catch { return false; }
}
