import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const DEFAULT_MAX_CHARS = 4_000;
const OMISSION_MARKER = '...';
const FILE_TITLE = '# Xingye Lore Memory';
const MANAGED_FILE_MARKER_PREFIX = '<!-- xingye-lore-memory:managed=true';
const MANAGED_SECTION_TITLE = '## Managed Stable Lore';

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeMaxChars(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : DEFAULT_MAX_CHARS;
}

function normalizePriority(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function toEntryArray(entries) {
  if (Array.isArray(entries)) return entries;
  if (entries && typeof entries === 'object') return Object.values(entries);
  return [];
}

function assertWritableIdentity({ hanakoHome, agentId }) {
  const normalizedHanakoHome = normalizeString(hanakoHome);
  const normalizedAgentId = normalizeString(agentId);
  if (!normalizedHanakoHome) {
    throw new Error('hanakoHome is required');
  }
  if (!normalizedAgentId) {
    throw new Error('agentId is required');
  }
  if (normalizedAgentId.includes('/') || normalizedAgentId.includes('\\') || normalizedAgentId === '.' || normalizedAgentId === '..') {
    throw new Error('agentId must be a single path segment');
  }
  return { normalizedHanakoHome, normalizedAgentId };
}

function getReadableIdentity({ hanakoHome, agentId }) {
  const normalizedHanakoHome = normalizeString(hanakoHome);
  const normalizedAgentId = normalizeString(agentId);
  if (!normalizedHanakoHome || !normalizedAgentId) return null;
  if (normalizedAgentId.includes('/') || normalizedAgentId.includes('\\') || normalizedAgentId === '.' || normalizedAgentId === '..') {
    return null;
  }
  return { normalizedHanakoHome, normalizedAgentId };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sanitizeMarkdownText(value) {
  return normalizeString(value).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function sanitizeMarkerValue(value) {
  return normalizeString(value).replace(/[\s<>]/g, '_');
}

function getLoreTitle(lore) {
  return sanitizeMarkdownText(lore?.title) || sanitizeMarkerValue(lore?.id) || 'Untitled lore';
}

function buildManagedFileMarker(agentId) {
  return `${MANAGED_FILE_MARKER_PREFIX} agentId=${sanitizeMarkerValue(agentId)} -->`;
}

function buildStartMarker({ loreId, agentId, category, updatedAt }) {
  return `<!-- xingye-lore:id=${sanitizeMarkerValue(loreId)} agentId=${sanitizeMarkerValue(agentId)} category=${sanitizeMarkerValue(category)} updatedAt=${sanitizeMarkerValue(updatedAt)} -->`;
}

function buildEndMarker(loreId) {
  return `<!-- /xingye-lore:id=${sanitizeMarkerValue(loreId)} -->`;
}

function buildLoreBlock({ agentId, lore, content }) {
  const loreId = sanitizeMarkerValue(lore?.id);
  const category = sanitizeMarkerValue(lore?.category);
  const updatedAt = sanitizeMarkerValue(lore?.updatedAt);
  if (!loreId || !category || !updatedAt) {
    throw new Error('lore.id, lore.category, and lore.updatedAt are required');
  }

  const safeContent = sanitizeMarkdownText(content);
  return [
    buildStartMarker({ loreId, agentId, category, updatedAt }),
    `### ${getLoreTitle(lore)}`,
    safeContent,
    buildEndMarker(loreId),
  ].join('\n');
}

function createEmptyFileContent(agentId) {
  return `${FILE_TITLE}\n\n${buildManagedFileMarker(agentId)}\n\n${MANAGED_SECTION_TITLE}\n`;
}

function ensureManagedSection(content, agentId) {
  const current = sanitizeMarkdownText(content);
  const base = current || createEmptyFileContent(agentId);
  const withTitle = base.includes(FILE_TITLE) ? base : `${FILE_TITLE}\n\n${base}`;
  const withMarker = withTitle.includes(MANAGED_FILE_MARKER_PREFIX)
    ? withTitle
    : `${withTitle.trimEnd()}\n\n${buildManagedFileMarker(agentId)}\n`;
  return withMarker.includes(MANAGED_SECTION_TITLE)
    ? withMarker
    : `${withMarker.trimEnd()}\n\n${MANAGED_SECTION_TITLE}\n`;
}

function blockPatternForLoreId(loreId) {
  const safeLoreId = escapeRegExp(sanitizeMarkerValue(loreId));
  return new RegExp(
    `\\n?<!-- xingye-lore:id=${safeLoreId}\\b[^>]*-->[\\s\\S]*?<!-- \\/xingye-lore:id=${safeLoreId} -->\\n?`,
    'g',
  );
}

function listManagedLoreIds(content) {
  const ids = new Set();
  const pattern = /<!-- xingye-lore:id=([^\s>]+)\b[^>]*-->/g;
  let match;
  while ((match = pattern.exec(content)) !== null) {
    ids.add(match[1]);
  }
  return ids;
}

function getExistingManagedBlock(content, loreId) {
  const pattern = blockPatternForLoreId(loreId);
  const match = pattern.exec(content);
  return match ? match[0].trim() : '';
}

function removeManagedBlock(content, loreId) {
  return content.replace(blockPatternForLoreId(loreId), '\n').trimEnd();
}

function appendManagedBlock(content, block) {
  const prepared = ensureManagedSection(content, '');
  const sectionIndex = prepared.indexOf(MANAGED_SECTION_TITLE);
  const insertAt = sectionIndex + MANAGED_SECTION_TITLE.length;
  return `${prepared.slice(0, insertAt).trimEnd()}\n\n${block}\n${prepared.slice(insertAt).trim() ? `\n${prepared.slice(insertAt).trimStart()}` : ''}`.trimEnd();
}

function isStableLoreCandidate(entry, agentId) {
  if (!entry || typeof entry !== 'object') return false;
  if (normalizeString(entry.agentId) !== agentId) return false;
  if (entry.enabled !== true) return false;
  if (entry.visibility !== 'canonical') return false;
  if (entry.insertionMode !== 'always') return false;
  if (!normalizeString(entry.summary) && !normalizeString(entry.content)) return false;
  if (!normalizeString(entry.id)) return false;
  return true;
}

function compareStableLoreEntries(a, b) {
  const priorityDelta = normalizePriority(b.priority) - normalizePriority(a.priority);
  if (priorityDelta !== 0) return priorityDelta;

  const updatedDelta = normalizeString(b.updatedAt).localeCompare(normalizeString(a.updatedAt));
  if (updatedDelta !== 0) return updatedDelta;

  const titleDelta = normalizeString(a.title).localeCompare(normalizeString(b.title));
  if (titleDelta !== 0) return titleDelta;

  return normalizeString(a.id).localeCompare(normalizeString(b.id));
}

function truncateText(text, maxChars) {
  const normalized = sanitizeMarkdownText(text);
  if (normalized.length <= maxChars) return normalized;
  if (maxChars <= OMISSION_MARKER.length) return OMISSION_MARKER.slice(0, maxChars);
  return `${normalized.slice(0, maxChars - OMISSION_MARKER.length)}${OMISSION_MARKER}`;
}

function getLoreSummaryContent(entry) {
  return normalizeString(entry.summary) || normalizeString(entry.content);
}

function buildSyncCandidates({ entries, agentId, maxChars }) {
  let remaining = normalizeMaxChars(maxChars) - managedPromptHeader().length;
  const candidates = [];

  for (const entry of toEntryArray(entries)
    .filter((candidate) => isStableLoreCandidate(candidate, agentId))
    .sort(compareStableLoreEntries)) {
    const separator = candidates.length ? 2 : 0;
    const block = fitManagedBlock(
      buildLoreBlock({ agentId, lore: entry, content: getLoreSummaryContent(entry) }),
      remaining - separator,
    );
    // A large title or marker may not fit while later entries still do.
    if (!block) continue;
    remaining -= block.length + separator;
    candidates.push({ entry, block });
  }

  return candidates;
}

function managedPromptHeader() {
  return `${FILE_TITLE}\n\n${MANAGED_SECTION_TITLE}\n\n`;
}

/** Keep the closing marker intact even when only part of the body fits. */
function fitManagedBlock(block, maxChars) {
  if (block.length <= maxChars) return block;
  const match = /^(<!-- xingye-lore:[^\n]*-->\n### [^\n]*\n)([\s\S]*)(\n<!-- \/xingye-lore:[^\n]*-->)$/.exec(block);
  if (!match) return '';
  const bodyBudget = maxChars - match[1].length - match[3].length;
  if (bodyBudget <= OMISSION_MARKER.length) return '';
  return `${match[1]}${truncateText(match[2], bodyBudget)}${match[3]}`;
}

function extractManagedPromptContent(content, { entries, agentId, maxChars }) {
  let ranked;
  if (entries !== undefined) {
    // The canonical store decides eligibility and current content. The managed
    // Markdown is a derived mirror and may lag behind an edit or failed sync.
    ranked = toEntryArray(entries)
      .filter((entry) => isStableLoreCandidate(entry, agentId))
      .sort(compareStableLoreEntries)
      .flatMap((entry, index) => {
        try {
          return [{ block: buildLoreBlock({ agentId, lore: entry, content: getLoreSummaryContent(entry) }), rank: index }];
        } catch {
          return [];
        }
      });
  } else {
    // Older installs can have a managed mirror without entries.json. Keep that
    // read-only fallback, including its saved summaries and original order.
    const pattern = /<!-- xingye-lore:id=[^\s>]+\b[^>]*-->[\s\S]*?<!-- \/xingye-lore:id=[^\s>]+ -->/g;
    ranked = [...content.matchAll(pattern)].map((match, rank) => ({ block: match[0], rank }));
  }
  const selected = [];
  const deferred = [];
  let remaining = normalizeMaxChars(maxChars) - managedPromptHeader().length;
  for (const { block, rank } of ranked) {
    const separator = selected.length ? 2 : 0;
    if (block.length > remaining - separator) {
      deferred.push({ block, rank });
      continue;
    }
    selected.push({ block, rank });
    remaining -= block.length + separator;
  }
  // A large high-priority block may use only the space left after complete
  // later blocks have had a chance, preserving the managed closing marker.
  for (const { block, rank } of deferred) {
    const separator = selected.length ? 2 : 0;
    const fitted = fitManagedBlock(block, remaining - separator);
    if (!fitted) continue;
    selected.push({ block: fitted, rank });
    break;
  }
  selected.sort((a, b) => a.rank - b.rank);
  return selected.length ? `${managedPromptHeader()}${selected.map((item) => item.block).join('\n\n')}` : '';
}

function loreEntriesPath({ hanakoHome, agentId }) {
  return path.join(hanakoHome, 'agents', agentId, 'xingye', 'lore', 'entries.json');
}

export function getXingyeLoreMemoryFilePath({ hanakoHome, agentId } = {}) {
  const identity = assertWritableIdentity({ hanakoHome, agentId });
  return path.join(identity.normalizedHanakoHome, 'agents', identity.normalizedAgentId, 'xingye', 'lore-memory.md');
}

export async function readXingyeLoreMemoryFile({ hanakoHome, agentId } = {}) {
  const identity = getReadableIdentity({ hanakoHome, agentId });
  if (!identity) return '';
  const filePath = path.join(identity.normalizedHanakoHome, 'agents', identity.normalizedAgentId, 'xingye', 'lore-memory.md');

  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
}

export async function writeXingyeLoreMemoryFile({ hanakoHome, agentId, content } = {}) {
  const filePath = getXingyeLoreMemoryFilePath({ hanakoHome, agentId });
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp.${randomUUID()}`;
  try {
    await fs.writeFile(temporary, sanitizeMarkdownText(content), 'utf8');
    await fs.rename(temporary, filePath);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
  return filePath;
}

export async function upsertXingyeLoreMemoryBlock({ hanakoHome, agentId, lore, content } = {}) {
  const { normalizedAgentId } = assertWritableIdentity({ hanakoHome, agentId });
  const current = await readXingyeLoreMemoryFile({ hanakoHome, agentId });
  const block = buildLoreBlock({ agentId: normalizedAgentId, lore, content });
  const loreId = sanitizeMarkerValue(lore?.id);
  const withoutExisting = removeManagedBlock(ensureManagedSection(current, normalizedAgentId), loreId);
  const next = appendManagedBlock(withoutExisting, block);
  await writeXingyeLoreMemoryFile({ hanakoHome, agentId, content: next });
  return next;
}

export async function removeXingyeLoreMemoryBlock({ hanakoHome, agentId, loreId } = {}) {
  assertWritableIdentity({ hanakoHome, agentId });
  const current = await readXingyeLoreMemoryFile({ hanakoHome, agentId });
  if (!current) return '';
  const next = removeManagedBlock(current, loreId);
  await writeXingyeLoreMemoryFile({ hanakoHome, agentId, content: next });
  return next;
}

export async function syncXingyeStableLoreMemoryFile({
  hanakoHome,
  agentId,
  entries,
  maxChars = DEFAULT_MAX_CHARS,
} = {}) {
  const { normalizedAgentId } = assertWritableIdentity({ hanakoHome, agentId });
  const filePath = getXingyeLoreMemoryFilePath({ hanakoHome, agentId });
  const current = ensureManagedSection(await readXingyeLoreMemoryFile({ hanakoHome, agentId }), normalizedAgentId);
  const candidates = buildSyncCandidates({ entries, agentId: normalizedAgentId, maxChars });
  const candidateIds = new Set(candidates.map(({ entry }) => sanitizeMarkerValue(entry.id)));
  let next = current;
  let removed = 0;
  let upserted = 0;
  let retained = 0;

  for (const existingId of listManagedLoreIds(current)) {
    if (!candidateIds.has(existingId)) {
      removed += 1;
    }
    next = removeManagedBlock(next, existingId);
  }

  for (const { entry, block } of candidates) {
    const loreId = sanitizeMarkerValue(entry.id);
    const existingBlock = getExistingManagedBlock(current, loreId);
    if (existingBlock === block) {
      retained += 1;
      continue;
    }
    upserted += 1;
  }
  // Rebuild the complete ordered managed section, including retained blocks.
  // A priority-only edit must move an unchanged block too.
  if (candidates.length) next = appendManagedBlock(next, candidates.map(({ block }) => block).join('\n\n'));

  await writeXingyeLoreMemoryFile({ hanakoHome, agentId, content: next });
  return { upserted, removed, retained, filePath };
}

export async function readXingyeStableLoreMemoryForPrompt({
  hanakoHome,
  agentId,
  maxChars = DEFAULT_MAX_CHARS,
} = {}) {
  const identity = getReadableIdentity({ hanakoHome, agentId });
  if (!identity) return '';
  const normalized = { hanakoHome: identity.normalizedHanakoHome, agentId: identity.normalizedAgentId };
  let entries;
  try {
    entries = JSON.parse(await fs.readFile(loreEntriesPath(normalized), 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') return '';
  }
  if (entries !== undefined) return extractManagedPromptContent('', { entries, agentId: normalized.agentId, maxChars });
  const content = await readXingyeLoreMemoryFile(normalized);
  if (!content) return '';
  return extractManagedPromptContent(content, { entries, agentId: normalized.agentId, maxChars });
}

export function readXingyeStableLoreMemoryForPromptSync({
  hanakoHome,
  agentId,
  maxChars = DEFAULT_MAX_CHARS,
} = {}) {
  const identity = getReadableIdentity({ hanakoHome, agentId });
  if (!identity) return '';
  let entries;
  try {
    entries = JSON.parse(readFileSync(loreEntriesPath({ hanakoHome: identity.normalizedHanakoHome, agentId: identity.normalizedAgentId }), 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') return '';
  }
  if (entries !== undefined) return extractManagedPromptContent('', { entries, agentId: identity.normalizedAgentId, maxChars });
  const filePath = path.join(identity.normalizedHanakoHome, 'agents', identity.normalizedAgentId, 'xingye', 'lore-memory.md');
  let content = '';
  try {
    content = readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
  if (!content) return '';
  return extractManagedPromptContent(content, { entries, agentId: identity.normalizedAgentId, maxChars });
}
