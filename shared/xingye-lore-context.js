const STABLE_LORE_CATEGORIES = new Set(['background', 'relationship', 'character']);
const DEFAULT_MAX_CHARS = 2_000;
const STABLE_LORE_TITLE = '【星野核心设定】';
const STABLE_LORE_NOTICE =
  '以下是角色长期背景、核心关系或核心人物设定，来自用户编辑的 Xingye Lore。不要把它们当作刚发生的事件；若与当前聊天事实冲突，以当前聊天事实为准。';
const OMISSION_MARKER = '...';

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizePriority(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function normalizeMaxChars(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : DEFAULT_MAX_CHARS;
}

function toEntryArray(entries) {
  if (Array.isArray(entries)) return entries;
  if (entries && typeof entries === 'object') return Object.values(entries);
  return [];
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

function isStableLoreCandidate(entry, agentId) {
  if (!entry || typeof entry !== 'object') return false;
  if (normalizeString(entry.agentId) !== agentId) return false;
  if (entry.enabled !== true) return false;
  if (entry.visibility !== 'canonical') return false;
  if (entry.insertionMode !== 'always') return false;
  if (!STABLE_LORE_CATEGORIES.has(entry.category)) return false;
  if (!normalizeString(entry.content)) return false;
  return true;
}

function toMetadata(entry) {
  return {
    id: normalizeString(entry.id),
    title: getEntryTitle(entry),
    category: normalizeString(entry.category),
    priority: normalizePriority(entry.priority),
    insertionMode: normalizeString(entry.insertionMode),
  };
}

function getEntryTitle(entry) {
  return normalizeString(entry.title) || normalizeString(entry.id) || '未命名设定';
}

function formatEntryBlock(entry, content = normalizeString(entry.content)) {
  const title = getEntryTitle(entry);
  return `- 标题：${title}\n  内容：${content}`;
}

function composeText(blocks) {
  if (!blocks.length) return '';
  return `${STABLE_LORE_TITLE}\n${STABLE_LORE_NOTICE}\n\n${blocks.join('\n\n')}`;
}

function truncateContentForBudget(entry, existingBlocks, maxChars) {
  const fullContent = normalizeString(entry.content);
  const title = getEntryTitle(entry);
  const prefix = `- 标题：${title}\n  内容：`;
  const textWithoutContent = composeText([...existingBlocks, `${prefix}${OMISSION_MARKER}`]);
  const availableContentChars = maxChars - textWithoutContent.length;

  if (availableContentChars <= 0) return null;
  const truncatedContent = `${fullContent.slice(0, availableContentChars)}${OMISSION_MARKER}`;
  return `${prefix}${truncatedContent}`;
}

export function buildXingyeStableLoreMemoryContext({
  entries,
  agentId,
  maxChars = DEFAULT_MAX_CHARS,
} = {}) {
  const normalizedAgentId = normalizeString(agentId);
  const normalizedMaxChars = normalizeMaxChars(maxChars);
  if (!normalizedAgentId || normalizedMaxChars <= 0) {
    return { text: '', entries: [] };
  }

  const candidates = toEntryArray(entries)
    .filter((entry) => isStableLoreCandidate(entry, normalizedAgentId))
    .sort(compareStableLoreEntries);

  const blocks = [];
  const selectedEntries = [];

  for (const entry of candidates) {
    const fullBlock = formatEntryBlock(entry);
    const fullText = composeText([...blocks, fullBlock]);
    if (fullText.length <= normalizedMaxChars) {
      blocks.push(fullBlock);
      selectedEntries.push(toMetadata(entry));
      continue;
    }

    const truncatedBlock = truncateContentForBudget(entry, blocks, normalizedMaxChars);
    if (truncatedBlock) {
      blocks.push(truncatedBlock);
      selectedEntries.push(toMetadata(entry));
    }
  }

  if (!selectedEntries.length) {
    return { text: '', entries: [] };
  }

  return {
    text: composeText(blocks),
    entries: selectedEntries,
  };
}
