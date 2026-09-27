const DEFAULT_MAX_CHARS = 2_000;
const STABLE_LORE_TITLE = '【星野始终生效设定】';
const STABLE_LORE_NOTICE =
  '以下是用户编辑并标记为 always 的 Xingye Lore，会始终生效。不要把它们当作刚发生的事件；若与当前聊天事实冲突，以当前聊天事实为准。';
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

function getMatchedKeywords(entry, queryText, explicitKeywords = []) {
  const normalizedQuery = queryText.toLocaleLowerCase();
  const explicit = new Set(toStringArray(explicitKeywords).map(normalizeString).filter(Boolean)
    .map((keyword) => keyword.toLocaleLowerCase()));
  return normalizeKeywords(entry.keywords).filter((keyword) =>
    explicit.has(keyword.toLocaleLowerCase()) || normalizedQuery.includes(keyword.toLocaleLowerCase()),
  );
}

/**
 * The same eligibility, ordering and bounded fit policy is used by chat, Phone
 * and renderer-generated Xingye content. A large entry is deferred while
 * smaller entries are considered; only unused space may hold a shortened one.
 * The caller supplies the exact block formatter so its heading is counted.
 */
export function selectXingyeLoreEntries({
  entries,
  agentId,
  mode = 'keyword',
  queryText = '',
  explicitKeywords = [],
  maxChars = DEFAULT_MAX_CHARS,
  formatBlock,
  compose = (blocks) => blocks.join('\n\n'),
  priorityBoostCategories = [],
  onDecision,
} = {}) {
  const aid = normalizeString(agentId);
  const budget = normalizeMaxChars(maxChars);
  const query = normalizeString(queryText);
  const hasExplicitKeywords = toStringArray(explicitKeywords).some((keyword) => normalizeString(keyword));
  const allowedModes = mode === 'all' ? new Set(['always', 'keyword']) : new Set([mode]);
  const candidates = [];
  for (const entry of toEntryArray(entries)) {
    if (!entry || typeof entry !== 'object' || normalizeString(entry.agentId) !== aid || !aid) continue;
    let reason = '';
    if (entry.enabled !== true) reason = 'disabled';
    else if (entry.visibility !== 'canonical') reason = 'visibility';
    else if (!allowedModes.has(entry.insertionMode)) reason = 'mode';
    else if (!normalizeString(entry.content)) reason = 'empty';
    else if (entry.insertionMode === 'keyword' && !normalizeKeywords(entry.keywords).length) reason = 'no-keywords';
    else if (entry.insertionMode === 'keyword' && !query && !hasExplicitKeywords) reason = 'no-query';
    const matchedKeywords = entry.insertionMode === 'keyword' && !reason
      ? getMatchedKeywords(entry, query, explicitKeywords) : [];
    if (!reason && entry.insertionMode === 'keyword' && !matchedKeywords.length) reason = 'no-match';
    if (reason) { reportDecision(onDecision, entry, reason); continue; }
    candidates.push({ entry, matchedKeywords });
  }
  const boosts = new Set(toStringArray(priorityBoostCategories).map(normalizeString));
  candidates.sort((a, b) => {
    const boosted = Number(boosts.has(normalizeString(b.entry.category))) - Number(boosts.has(normalizeString(a.entry.category)));
    return boosted || compareStableLoreEntries(a.entry, b.entry);
  });
  const formatter = typeof formatBlock === 'function'
    ? formatBlock : (entry, matched) => formatRuntimeEntryBlock(entry, matched);
  const fitted = [];
  const deferred = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const block = formatter(candidate.entry, candidate.matchedKeywords, normalizeString(candidate.entry.content));
    if (compose([...fitted.map((item) => item.block), block]).length <= budget) {
      fitted.push({ ...candidate, block, content: normalizeString(candidate.entry.content), index, truncated: false });
    } else {
      deferred.push({ ...candidate, index });
    }
  }
  // A shortened entry is useful only after full later entries had their chance.
  for (const candidate of deferred) {
    const content = normalizeString(candidate.entry.content);
    let low = 0;
    let high = content.length - 1;
    let shortened = '';
    let shortenedContent = '';
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const attempt = formatter(candidate.entry, candidate.matchedKeywords, `${content.slice(0, mid)}${OMISSION_MARKER}`);
      const ordered = [...fitted, { ...candidate, block: attempt, truncated: true }]
        .sort((a, b) => a.index - b.index);
      if (compose(ordered.map((item) => item.block)).length <= budget) {
        shortened = attempt;
        shortenedContent = `${content.slice(0, mid)}${OMISSION_MARKER}`;
        low = mid + 1;
      } else high = mid - 1;
    }
    if (shortened && low > 24) {
      fitted.push({ ...candidate, block: shortened, content: shortenedContent, truncated: true });
      break;
    }
  }
  fitted.sort((a, b) => a.index - b.index);
  const selectedIndexes = new Set(fitted.map((item) => item.index));
  const selected = fitted.map(({ entry, matchedKeywords, block, content, truncated }) => ({
    entry, matchedKeywords, block, content, truncated,
  }));
  for (let index = 0; index < candidates.length; index += 1) {
    const { entry, matchedKeywords } = candidates[index];
    const selectedItem = fitted.find((item) => item.index === index);
    reportDecision(onDecision, entry,
      selectedItem ? (selectedItem.truncated ? 'truncated' : 'selected') : 'budget',
      matchedKeywords, selectedItem?.block.length ?? 0);
  }
  return {
    selected,
    candidateCount: candidates.length,
    usedChars: selected.length ? compose(selected.map((item) => item.block)).length : 0,
    truncated: deferred.some((item) => !selectedIndexes.has(item.index)) || selected.some((item) => item.truncated),
  };
}

// Diagnostics are opt-in and never include another agent's entries or lore content.
function reportDecision(onDecision, entry, reason, matchedKeywords = [], blockChars = 0) {
  if (typeof onDecision !== 'function') return;
  onDecision({
    id: normalizeString(entry.id), title: getEntryTitle(entry), reason,
    matchedKeywords, blockChars,
  });
}

export function buildXingyeStableLoreMemoryContext({
  entries,
  agentId,
  maxChars = DEFAULT_MAX_CHARS,
  onDecision,
} = {}) {
  const result = selectXingyeLoreEntries({
    entries, agentId, mode: 'always', maxChars,
    formatBlock: (entry, _matched, content) => formatEntryBlock(entry, content),
    compose: composeText,
    onDecision,
  });
  return result.selected.length
    ? { text: composeText(result.selected.map((item) => item.block)), entries: result.selected.map((item) => toMetadata(item.entry)) }
    : { text: '', entries: [] };
}

export function buildXingyeRuntimeLoreContext({
  entries,
  agentId,
  userText,
  recentMessages,
  maxChars = DEFAULT_MAX_CHARS,
  onDecision,
} = {}) {
  const queryText = buildQueryText(userText, recentMessages);
  const result = selectXingyeLoreEntries({
    entries, agentId, mode: 'keyword', queryText, maxChars,
    formatBlock: formatRuntimeEntryBlock,
    compose: composeRuntimeText,
    onDecision,
  });
  return result.selected.length
    ? {
      text: composeRuntimeText(result.selected.map((item) => item.block)),
      entries: result.selected.map((item) => toRuntimeMetadata(item.entry, item.matchedKeywords)),
    }
    : { text: '', entries: [] };
}
