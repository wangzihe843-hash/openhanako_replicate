/** Bounded, explainable selection of Xingye prompt sections. */

const DEFAULT_BUDGET = 18_000;
const OMISSION = '\n…（本段超出上下文预算，后续内容未选入）';

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function limit(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.floor(value)) : fallback;
}

function composedLength(sections) {
  return sections.map((section) => section.text).join('\n\n').length;
}

function scopedToContext(scope, context) {
  if (!scope || typeof scope !== 'object') return false;
  if (!clean(scope.agentId) || clean(scope.agentId) !== clean(context.agentId)) return false;
  if (clean(scope.sessionId) && clean(scope.sessionId) !== clean(context.sessionId)) return false;
  if (clean(scope.branchId) && clean(scope.branchId) !== clean(context.branchId)) return false;
  return true;
}

/**
 * Sections are already authorized at their source. This selector rejects a
 * mismatched scope again, deduplicates source IDs and records the actual choice.
 * Overlong sections are deferred so they cannot consume space needed by later
 * short sections. One deferred section may use the space left after full ones.
 */
export function selectXingyeContextSections({
  sections = [],
  context = {},
  maxChars = DEFAULT_BUDGET,
  sourceBudgets = {},
  onDecision,
} = {}) {
  const totalBudget = limit(maxChars, DEFAULT_BUDGET);
  const decisions = [];
  const report = (section, reason, chars = 0) => {
    const decision = {
      id: clean(section?.id), source: clean(section?.source),
      scope: section?.scope ?? null, reason, chars,
    };
    decisions.push(decision);
    if (typeof onDecision === 'function') onDecision(decision);
  };
  const seen = new Set();
  const candidates = [];
  for (const section of Array.isArray(sections) ? sections : []) {
    const id = clean(section?.id);
    const source = clean(section?.source);
    const text = clean(section?.text);
    if (!id || !source || !text) { report(section, 'empty'); continue; }
    if (!scopedToContext(section.scope, context)) { report(section, 'scope'); continue; }
    if (seen.has(id)) { report(section, 'duplicate'); continue; }
    seen.add(id);
    candidates.push({
      ...section, id, source, text,
      priority: typeof section.priority === 'number' && Number.isFinite(section.priority) ? section.priority : 0,
      index: candidates.length,
    });
  }
  candidates.sort((a, b) => b.priority - a.priority || a.index - b.index);
  const selected = [];
  const deferred = [];
  const spentBySource = new Map();
  const sourceLimit = (source) => limit(sourceBudgets[source], totalBudget);
  for (const candidate of candidates) {
    const sourceSpent = spentBySource.get(candidate.source) ?? 0;
    if (sourceSpent + candidate.text.length <= sourceLimit(candidate.source)
      && composedLength([...selected, candidate]) <= totalBudget) {
      selected.push(candidate);
      spentBySource.set(candidate.source, sourceSpent + candidate.text.length);
    } else deferred.push(candidate);
  }
  for (const candidate of deferred) {
    const remainingSource = sourceLimit(candidate.source) - (spentBySource.get(candidate.source) ?? 0);
    const remainingTotal = totalBudget - composedLength(selected) - (selected.length ? 2 : 0);
    const allowed = Math.min(remainingSource, remainingTotal);
    if (allowed < OMISSION.length + 24) continue;
    const cut = candidate.text.slice(0, allowed - OMISSION.length).trimEnd();
    if (!cut) continue;
    const shortened = { ...candidate, text: `${cut}${OMISSION}`, truncated: true };
    if (composedLength([...selected, shortened]) > totalBudget) continue;
    selected.push(shortened);
    spentBySource.set(candidate.source, (spentBySource.get(candidate.source) ?? 0) + shortened.text.length);
    break;
  }
  selected.sort((a, b) => b.priority - a.priority || a.index - b.index);
  const byId = new Map(selected.map((section) => [section.id, section]));
  for (const candidate of candidates) {
    const chosen = byId.get(candidate.id);
    report(candidate, !chosen ? 'budget' : chosen.truncated ? 'truncated' : 'selected', chosen?.text.length ?? 0);
  }
  return {
    sections: selected.map(({ index: _index, ...section }) => section),
    text: selected.map((section) => section.text).join('\n\n'),
    decisions,
    usedChars: composedLength(selected),
    maxChars: totalBudget,
  };
}
