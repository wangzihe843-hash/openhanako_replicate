import { CORE_TOOL_NAMES, uniqueToolNames } from "../shared/tool-categories.ts";

const LEGACY_TOOL_ALIASES: Record<string, string[]> = {
  bash: ["exec_command"],
  terminal: ["exec_command", "write_stdin"],
};

function mappedToolNames(name) {
  return LEGACY_TOOL_ALIASES[name] || [name];
}

/**
 * Same repair as repairRestoredToolSnapshot, but also reports which snapshot
 * names were dropped because they are no longer registered in the runtime.
 * #1624: the restore path surfaces these as "invalid tools" in the capability
 * drift notice instead of filtering them fully silently.
 */
export function repairRestoredToolSnapshotDetailed(snapshotToolNames, allToolNames, {
  coreToolNames = CORE_TOOL_NAMES,
} = {}) {
  const available = new Set(uniqueToolNames(allToolNames));
  const toolNames = [];
  const droppedToolNames = [];
  const seen = new Set();
  const seenSnapshotNames = new Set();

  for (const name of uniqueToolNames(snapshotToolNames)) {
    if (seenSnapshotNames.has(name)) continue;
    seenSnapshotNames.add(name);
    const mappedNames = mappedToolNames(name);
    const kept = mappedNames.filter((mapped) => available.has(mapped));
    if (!kept.length) {
      droppedToolNames.push(name);
      continue;
    }
    for (const mapped of kept) {
      if (seen.has(mapped)) continue;
      seen.add(mapped);
      toolNames.push(mapped);
    }
  }

  for (const name of coreToolNames) {
    if (!available.has(name) || seen.has(name)) continue;
    seen.add(name);
    toolNames.push(name);
  }

  return { toolNames, droppedToolNames };
}

export function repairRestoredToolSnapshot(snapshotToolNames, allToolNames, options = {}) {
  return repairRestoredToolSnapshotDetailed(snapshotToolNames, allToolNames, options).toolNames;
}

export function sameToolNames(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  if (left.length !== right.length) return false;
  return left.every((name, index) => name === right[index]);
}
