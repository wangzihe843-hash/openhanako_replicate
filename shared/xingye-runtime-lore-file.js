import fs from 'node:fs';
import path from 'node:path';
import { canReadMemoryScope, normalizeMemoryScopeContext } from './memory-scope.ts';

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function sanitizeAgentIdForPath(agentId) {
  return normalizeString(agentId).replace(/[^a-zA-Z0-9-_]/g, '_').slice(0, 120) || '';
}

function readJsonArray(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [];
}

function readJsonObject(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

function pushUnique(candidates, seen, filePath, read, authoritative = false) {
  const normalizedPath = normalizeString(filePath);
  if (!normalizedPath || seen.has(normalizedPath)) return;
  seen.add(normalizedPath);
  candidates.push({ filePath: normalizedPath, read, authoritative });
}

function getAgentDirName(agentId, safeAgentId) {
  const normalizedAgentId = normalizeString(agentId);
  if (normalizedAgentId && !/[\\/]/.test(normalizedAgentId)) return normalizedAgentId;
  return safeAgentId;
}

function buildRuntimeLoreSourceCandidates({
  workspaceRoot,
  hanakoHome,
  agentId,
  agentDir,
}) {
  const normalizedWorkspaceRoot = normalizeString(workspaceRoot);
  const normalizedHanakoHome = normalizeString(hanakoHome);
  const normalizedAgentId = normalizeString(agentId);
  const normalizedAgentDir = normalizeString(agentDir);
  const safeAgentId = sanitizeAgentIdForPath(normalizedAgentId);
  const candidates = [];
  const seen = new Set();

  if (!normalizedAgentId || !safeAgentId) return candidates;

  const readAgentLoreEntriesFile = (filePath) => () => Object.values(readJsonObject(filePath))
    .filter((entry) => normalizeString(entry?.agentId) === normalizedAgentId);

  // Official agent-scope store (same relative path as desktop xingye persistence: lore/entries.json).
  if (normalizedHanakoHome) {
    const agentDirName = getAgentDirName(normalizedAgentId, safeAgentId);
    const entriesPath = path.join(normalizedHanakoHome, 'agents', agentDirName, 'xingye', 'lore', 'entries.json');
    pushUnique(candidates, seen, entriesPath, readAgentLoreEntriesFile(entriesPath), true);
  }

  if (normalizedAgentDir) {
    const entriesPath = path.join(normalizedAgentDir, 'xingye', 'lore', 'entries.json');
    pushUnique(candidates, seen, entriesPath, readAgentLoreEntriesFile(entriesPath), true);
  }

  if (normalizedWorkspaceRoot) {
    const base = path.join(normalizedWorkspaceRoot, '.xingye');
    pushUnique(
      candidates,
      seen,
      path.join(base, 'agents', safeAgentId, 'lore.json'),
      () => readJsonArray(path.join(base, 'agents', safeAgentId, 'lore.json')),
    );
    pushUnique(
      candidates,
      seen,
      path.join(base, 'v1', 'data', 'lore-entries.json'),
      () => Object.values(readJsonObject(path.join(base, 'v1', 'data', 'lore-entries.json')))
        .filter((entry) => entry?.agentId === normalizedAgentId),
    );
  }

  if (normalizedAgentDir) {
    const mirrorPath = path.join(normalizedAgentDir, 'xingye', 'lore.json');
    pushUnique(candidates, seen, mirrorPath, () => readJsonArray(mirrorPath));
  }

  if (normalizedHanakoHome) {
    const agentDirName = getAgentDirName(normalizedAgentId, safeAgentId);
    const mirrorPath = path.join(normalizedHanakoHome, 'agents', agentDirName, 'xingye', 'lore.json');
    pushUnique(candidates, seen, mirrorPath, () => readJsonArray(mirrorPath));
  }

  return candidates;
}

export function readXingyeRuntimeLoreEntriesSync({
  workspaceRoot,
  hanakoHome,
  agentId,
  agentDir,
  memoryScope,
} = {}) {
  const context = normalizeMemoryScopeContext(memoryScope, normalizeString(agentId) || undefined);
  const candidates = buildRuntimeLoreSourceCandidates({
    workspaceRoot,
    hanakoHome,
    agentId,
    agentDir,
  });

  for (const candidate of candidates) {
    try {
      const entries = candidate.read();
      // An existing official store, including {} or a null deletion tombstone,
      // is authoritative. Falling through would resurrect deleted mirror lore.
      if (candidate.authoritative || entries.length > 0) return entries.filter((entry) =>
        normalizeString(entry?.agentId) === normalizeString(agentId)
        && canReadMemoryScope(entry.memoryScope, context, normalizeString(agentId) || undefined)
        && entry.sourceStatus !== 'stale'
        && !(entry.origin === 'derived' && entry.memoryScope?.realm !== 'legacy' && entry.sourceStatus !== 'active'));
    } catch (error) {
      // An unreadable authoritative source is not proof it was deleted. Never
      // resurrect its old compatibility mirror after a corrupt/torn read.
      if (candidate.authoritative && error?.code !== 'ENOENT') return [];
    }
  }

  return [];
}
