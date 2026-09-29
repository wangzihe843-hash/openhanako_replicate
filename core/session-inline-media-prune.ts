/**
 * Session inline media pruning
 *
 * Provider requests may need base64/image blocks for the current turn, but
 * SessionFile/path markers are the durable identity inside Hana. This module
 * removes inline media from Pi SDK session history after the turn has finished
 * so future context replay cannot resend large base64 payloads.
 */

import { stripAllInlineMediaForHistory } from "./message-sanitizer.ts";
import {
  readSessionEntriesFile,
  writeSessionEntriesFile,
} from "./session-jsonl-file.ts";

function emptyResult() {
  return { stripped: 0, strippedImages: 0, strippedVideos: 0, strippedAudios: 0 };
}

function addCounts(target, source) {
  target.stripped += source.stripped || 0;
  target.strippedImages += source.strippedImages || 0;
  target.strippedVideos += source.strippedVideos || 0;
  target.strippedAudios += source.strippedAudios || 0;
}

function pruneSessionManagerEntries(sessionManager) {
  const result = emptyResult();
  const entries = Array.isArray(sessionManager?.fileEntries) ? sessionManager.fileEntries : [];
  const byId = new Map(entries.map((entry) => [entry?.id, entry]));
  let changed = false;

  for (const entry of entries) {
    const stripped = stripMessageEntryInlineMedia(entry, byId);
    if (!stripped.changed) continue;
    // Keep entry identity: Pi's byId index references the same objects.
    Object.assign(entry, stripped.entry);
    addCounts(result, stripped.result);
    changed = true;
  }

  if (changed && typeof sessionManager?._rewriteFile === "function") {
    sessionManager._rewriteFile();
  }

  return result;
}

function stripMessageEntryInlineMedia(entry, byId) {
  const result = emptyResult();
  const target = entry?.type === "context_edit" && entry.replacement
    ? byId.get(entry.targetId)
    : null;
  const message = entry?.type === "message"
    ? entry.message
    : target?.type === "message"
      ? { ...target.message, content: entry.replacement.content }
      : null;
  if (!message) {
    return { entry, result, changed: false };
  }

  const stripped = stripAllInlineMediaForHistory([message]);
  if (stripped.stripped === 0) {
    return { entry, result, changed: false };
  }

  addCounts(result, stripped);
  return {
    entry: entry.type === "context_edit"
      ? { ...entry, replacement: { ...entry.replacement, content: stripped.messages[0].content } }
      : { ...entry, message: stripped.messages[0] },
    result,
    changed: true,
  };
}

export function repairSessionInlineMediaEntries(entries) {
  const result = emptyResult();
  if (!Array.isArray(entries) || entries.length === 0) {
    return { entries, ...result };
  }

  let changed = false;
  const byId = new Map(entries.map((entry) => [entry?.id, entry]));
  const repaired = entries.map((entry) => {
    const stripped = stripMessageEntryInlineMedia(entry, byId);
    if (!stripped.changed) return entry;
    changed = true;
    addCounts(result, stripped.result);
    return stripped.entry;
  });

  return {
    entries: changed ? repaired : entries,
    ...result,
  };
}

export function repairSessionInlineMediaEntriesInFile(sessionPath) {
  const empty = () => ({ repaired: false, ...emptyResult() });
  const loaded = readSessionEntriesFile(sessionPath);
  if (!loaded) return empty();

  const { entries, stripped, strippedImages, strippedVideos, strippedAudios } =
    repairSessionInlineMediaEntries(loaded.entries);
  if (stripped === 0) return empty();

  try {
    writeSessionEntriesFile(sessionPath, entries);
  } catch {
    return empty();
  }

  return {
    repaired: true,
    stripped,
    strippedImages,
    strippedVideos,
    strippedAudios,
  };
}

function pruneAgentStateMessages(agent) {
  const result = emptyResult();
  const messages = agent?.state?.messages;
  if (!Array.isArray(messages)) return result;

  const stripped = stripAllInlineMediaForHistory(messages);
  if (stripped.stripped === 0) return result;
  agent.state.messages = stripped.messages;
  addCounts(result, stripped);
  return result;
}

export function pruneSessionInlineMediaHistory(session) {
  const result = emptyResult();
  addCounts(result, pruneSessionManagerEntries(session?.sessionManager));
  addCounts(result, pruneAgentStateMessages(session?.agent));
  if (result.stripped > 0) session?.refreshContext?.();
  return result;
}
