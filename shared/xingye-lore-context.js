const STABLE_LORE_CATEGORIES = new Set(['background', 'relationship', 'character']);
const DEFAULT_MAX_CHARS = 2_000;
const STABLE_LORE_TITLE = '【星野核心设定】';
const STABLE_LORE_NOTICE =
  '以下是角色长期背景、核心关系或核心人物设定，来自用户编辑的 Xingye Lore。不要把它们当作刚发生的事件；若与当前聊天事实冲突，以当前聊天事实为准。';
const RUNTIME_LORE_TITLE = '# 星野设定参考';
const RUNTIME_LORE_NOTICE = [
  '以下内容是本轮相关世界观、地点、组织、规则、事件或人物关系参考。',
  '只作为当前回复的背景约束，不要写入长期记忆。',
  '不要机械复述原文。',
  '如果与当前用户消息或最近聊天冲突，以当前对话事实为准。',
].join('\n');
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

function toStringArray(value) {
  return Array.isArray(value) ? value : [];
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

function isRuntimeLoreCandidate(entry, agentId) {
  if (!entry || typeof entry !== 'object') return false;
  if (normalizeString(entry.agentId) !== agentId) return false;
  if (entry.enabled !== true) return false;
  if (entry.visibility !== 'canonical') return false;
  if (entry.insertionMode !== 'keyword') return false;
  if (!normalizeString(entry.content)) return false;
  if (!normalizeKeywords(entry.keywords).length) return false;
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

function toRuntimeMetadata(entry, matchedKeywords) {
  return {
    ...toMetadata(entry),
    matchedKeywords,
  };
}

function getEntryTitle(entry) {
  return normalizeString(entry.title) || normalizeString(entry.id) || '未命名设定';
}

function formatEntryBlock(entry, content = normalizeString(entry.content)) {
  const title = getEntryTitle(entry);
  return `- 标题：${title}\n  内容：${content}`;
}

function formatRuntimeEntryBlock(entry, matchedKeywords, content = normalizeString(entry.content)) {
  return [
    `- 标题：${getEntryTitle(entry)}`,
    `  分类：${normalizeString(entry.category)}`,
    `  匹配关键词：${matchedKeywords.join(', ')}`,
    `  内容：${content}`,
  ].join('\n');
}

function composeText(blocks) {
  if (!blocks.length) return '';
  return `${STABLE_LORE_TITLE}\n${STABLE_LORE_NOTICE}\n\n${blocks.join('\n\n')}`;
}

function composeRuntimeText(blocks) {
  if (!blocks.length) return '';
  return `${RUNTIME_LORE_TITLE}\n${RUNTIME_LORE_NOTICE}\n\n${blocks.join('\n\n')}`;
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

function truncateRuntimeContentForBudget(entry, matchedKeywords, existingBlocks, maxChars) {
  const fullContent = normalizeString(entry.content);
  const prefix = [
    `- 标题：${getEntryTitle(entry)}`,
    `  分类：${normalizeString(entry.category)}`,
    `  匹配关键词：${matchedKeywords.join(', ')}`,
    '  内容：',
  ].join('\n');
  const textWithoutContent = composeRuntimeText([...existingBlocks, `${prefix}${OMISSION_MARKER}`]);
  const availableContentChars = maxChars - textWithoutContent.length;

  if (availableContentChars <= 0) return null;
  const truncatedContent = `${fullContent.slice(0, availableContentChars)}${OMISSION_MARKER}`;
  return `${prefix}${truncatedContent}`;
}

function normalizeKeywords(keywords) {
  return toStringArray(keywords).map(normalizeString).filter(Boolean);
}

function getRecentMessageText(message) {
  if (typeof message === 'string') return message;
  if (!message || typeof message !== 'object') return '';
  return normalizeString(message.text) || normalizeString(message.content) || normalizeString(message.message);
}

function buildQueryText(userText, recentMessages) {
  return [normalizeString(userText), ...toStringArray(recentMessages).map(getRecentMessageText)]
    .filter(Boolean)
    .join('\n');
}

function getMatchedKeywords(entry, queryText) {
  const normalizedQuery = queryText.toLocaleLowerCase();
  return normalizeKeywords(entry.keywords).filter((keyword) =>
    normalizedQuery.includes(keyword.toLocaleLowerCase()),
  );
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

export function buildXingyeRuntimeLoreContext({
  entries,
  agentId,
  userText,
  recentMessages,
  maxChars = DEFAULT_MAX_CHARS,
} = {}) {
  const normalizedAgentId = normalizeString(agentId);
  const normalizedMaxChars = normalizeMaxChars(maxChars);
  const queryText = buildQueryText(userText, recentMessages);
  if (!normalizedAgentId || normalizedMaxChars <= 0 || !queryText) {
    return { text: '', entries: [] };
  }

  const candidates = toEntryArray(entries)
    .filter((entry) => isRuntimeLoreCandidate(entry, normalizedAgentId))
    .map((entry) => ({ entry, matchedKeywords: getMatchedKeywords(entry, queryText) }))
    .filter(({ matchedKeywords }) => matchedKeywords.length > 0)
    .sort((a, b) => compareStableLoreEntries(a.entry, b.entry));

  const blocks = [];
  const selectedEntries = [];

  for (const { entry, matchedKeywords } of candidates) {
    const fullBlock = formatRuntimeEntryBlock(entry, matchedKeywords);
    const fullText = composeRuntimeText([...blocks, fullBlock]);
    if (fullText.length <= normalizedMaxChars) {
      blocks.push(fullBlock);
      selectedEntries.push(toRuntimeMetadata(entry, matchedKeywords));
      continue;
    }

    const truncatedBlock = truncateRuntimeContentForBudget(
      entry,
      matchedKeywords,
      blocks,
      normalizedMaxChars,
    );
    if (truncatedBlock) {
      blocks.push(truncatedBlock);
      selectedEntries.push(toRuntimeMetadata(entry, matchedKeywords));
    }
  }

  if (!selectedEntries.length) {
    return { text: '', entries: [] };
  }

  return {
    text: composeRuntimeText(blocks),
    entries: selectedEntries,
  };
}
