import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { canReadMemoryScope, normalizeMemoryScope, sameMemoryScope, type MemoryScopeContext } from "../../shared/memory-scope.ts";
import { normalizeMemorySourceDependencies } from "../../shared/memory-provenance.ts";
import { hashScopedSourceMessage } from "./scoped-derivation-store.ts";
import { atomicWriteSync } from "../../shared/safe-fs.ts";

const STORE_FILE = "pinned-memory.json";
const MARKDOWN_FILE = "pinned.md";
const SCHEMA_VERSION = 1;

function pinnedPath(agentDir) {
  return path.join(agentDir, MARKDOWN_FILE);
}

function storePath(agentDir) {
  return path.join(agentDir, STORE_FILE);
}

function normalizeContent(value) {
  return String(value ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

function normalizeId(value) {
  return String(value ?? "").trim();
}

function makeId(content, index = null) {
  const suffix = index === null ? crypto.randomUUID() : crypto.createHash("sha256")
    .update(`${index}\0${content}`)
    .digest("hex")
    .slice(0, 20);
  return `pin_${suffix}`;
}

function normalizeItem(raw, index, agentId = undefined) {
  const content = normalizeContent(raw?.content);
  if (!content) return null;
  const id = normalizeId(raw?.id) || makeId(content, index);
  const createdAt = typeof raw?.createdAt === "string" && raw.createdAt.trim()
    ? raw.createdAt
    : null;
  const memoryScope = normalizeMemoryScope(raw?.memoryScope, agentId);
  if (agentId && memoryScope.agentId !== agentId) throw new Error("pinned memory agent mismatch");
  if (raw?.origin !== undefined && raw.origin !== "manual" && raw.origin !== "derived") throw new Error("invalid pinned memory origin");
  const origin = raw?.origin === "derived" ? "derived" : "manual";
  const sourceDependencies = normalizeMemorySourceDependencies(raw?.sourceDependencies);
  const sourceStatus = origin === "derived" && sourceDependencies.length === 0 ? "unknown"
    : raw?.sourceStatus === "active" || raw?.sourceStatus === "stale" ? raw.sourceStatus : "unknown";
  return { id, content, ...(createdAt ? { createdAt } : {}), memoryScope, origin, sourceDependencies, sourceStatus };
}

function serializeItems(items, agentId = undefined) {
  return {
    version: SCHEMA_VERSION,
    items: items.map((item, index) => {
      const normalized = normalizeItem(item, index, agentId);
      if (!normalized) {
        throw new Error("Pinned memory item content must be a non-empty string");
      }
      return normalized;
    }),
  };
}

export function renderPinnedMarkdown(items) {
  const lines = items.flatMap((item) => {
    const contentLines = normalizeContent(item.content).split("\n");
    return contentLines.map((line, index) => index === 0 ? `- ${line}` : `  ${line}`);
  });
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

function parseLegacyPinnedMarkdown(content, agentId) {
  const text = String(content ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  const rawItems = [];
  let current = null;

  for (const line of lines) {
    const bullet = line.match(/^-\s(.*)$/);
    if (bullet) {
      if (current !== null) rawItems.push(current);
      current = bullet[1];
      continue;
    }

    if (current === null) {
      if (line.trim()) current = line;
      continue;
    }

    current += `\n${line.replace(/^ {2}/, "")}`;
  }

  if (current !== null) rawItems.push(current);
  return rawItems
    .map((content, index) => normalizeItem({ id: makeId(content, index), content }, index, agentId))
    .filter(Boolean);
}

function readMarkdownIfExists(agentDir) {
  try {
    return fs.readFileSync(pinnedPath(agentDir), "utf-8");
  } catch (err) {
    if (err.code === "ENOENT") return "";
    throw err;
  }
}

function readStoreItems(agentDir) {
  const raw = fs.readFileSync(storePath(agentDir), "utf-8");
  const parsed = JSON.parse(raw);
  if (!parsed || parsed.version !== SCHEMA_VERSION || !Array.isArray(parsed.items)) {
    throw new Error(`Invalid pinned memory store schema in ${storePath(agentDir)}`);
  }
  return serializeItems(parsed.items, path.basename(agentDir)).items;
}

function shouldPreferMarkdown(agentDir) {
  try {
    const markdownStat = fs.statSync(pinnedPath(agentDir));
    const storeStat = fs.statSync(storePath(agentDir));
    return markdownStat.mtimeMs > storeStat.mtimeMs + 1;
  } catch (err) {
    if (err.code === "ENOENT") return false;
    throw err;
  }
}

export function writePinnedMemoryItems(agentDir, items) {
  const data = serializeItems(items, path.basename(agentDir));
  fs.mkdirSync(agentDir, { recursive: true });
  atomicWriteSync(pinnedPath(agentDir), renderPinnedMarkdown(data.items.filter(item => item.memoryScope.realm === "legacy" && (item.origin === "manual" || item.sourceStatus === "active"))));
  atomicWriteSync(storePath(agentDir), `${JSON.stringify(data, null, 2)}\n`);
  return data.items;
}

export function readPinnedMemoryItems(agentDir) {
  let items;
  if (fs.existsSync(storePath(agentDir)) && !shouldPreferMarkdown(agentDir)) {
    items = readStoreItems(agentDir);
  } else {
    const stored = fs.existsSync(storePath(agentDir)) ? readStoreItems(agentDir) : [];
    const legacy = parseLegacyPinnedMarkdown(readMarkdownIfExists(agentDir), path.basename(agentDir));
    items = [...legacy.map(item => stored.find(old => old.memoryScope.realm === "legacy" && old.content === item.content) ?? item),
      ...stored.filter(item => item.memoryScope.realm !== "legacy")];
  }
  return writePinnedMemoryItems(agentDir, items);
}

/** Only this projection belongs in prompts. Management reads deliberately retain all records. */
export function readPinnedMemoryForContext(agentDir, memoryScope: MemoryScopeContext): string {
  return renderPinnedMarkdown(readPinnedMemoryItems(agentDir).filter(item =>
    canReadMemoryScope(item.memoryScope, memoryScope)
    && (item.origin === "manual" || item.sourceStatus === "active")));
}

/** Source retraction never deletes user-pinned or real-world history. */
export function invalidatePinnedMemoryBySession(agentDir, sessionId, options: { sourceMessages?: Array<{ entryId?: string; id?: string; role?: string; content?: unknown; timestamp?: string | null }> | null } = {}): number {
  const retainedHashes = Array.isArray(options.sourceMessages)
    ? new Map(options.sourceMessages.map((message, index) => [String(message.entryId || message.id || `position-${index}`), hashScopedSourceMessage(message)]))
    : null;
  let count = 0;
  const items = readPinnedMemoryItems(agentDir).map(item => {
    if (item.origin !== "derived" || item.memoryScope.realm !== "story"
      || !item.sourceDependencies.some(source => source.sessionId === sessionId) || item.sourceStatus === "stale") return item;
    const matching = item.sourceDependencies.filter(source => source.sessionId === sessionId);
    const allRetained = retainedHashes && matching.every(source => {
      if (source.entryId) return retainedHashes.get(source.entryId) === (source.hash || source.revision);
      return source.sourceRefs?.length > 0 && source.sourceRefs.every(ref => retainedHashes.get(ref.entryId) === ref.hash);
    });
    if (allRetained) return item;
    count++;
    return { ...item, sourceStatus: "stale" };
  });
  if (count) writePinnedMemoryItems(agentDir, items);
  return count;
}

export function addPinnedMemoryItem(agentDir, content, metadata: { memoryScope?: unknown; origin?: "manual" | "derived"; sourceDependencies?: unknown; sourceStatus?: string } = {}) {
  const normalized = normalizeContent(content);
  if (!normalized) {
    throw new Error("Pinned memory content must be a non-empty string");
  }

  const memoryScope = normalizeMemoryScope(metadata.memoryScope, path.basename(agentDir));
  const items = readPinnedMemoryItems(agentDir);
  const existingIndex = items.findIndex((item) => item.content === normalized && sameMemoryScope(item.memoryScope, memoryScope));
  if (existingIndex >= 0) {
    // Explicit user confirmation makes a derived pin independently durable.
    if (metadata.origin === "manual" && items[existingIndex].origin === "derived") {
      items[existingIndex] = { ...items[existingIndex], origin: "manual" };
      return { item: items[existingIndex], items: writePinnedMemoryItems(agentDir, items), alreadyExists: true };
    }
    return { item: null, items, alreadyExists: true };
  }

  const item = {
    ...metadata,
    memoryScope,
    id: makeId(normalized),
    content: normalized,
    createdAt: new Date().toISOString(),
  };
  const nextItems = writePinnedMemoryItems(agentDir, [...items, item]);
  return { item: nextItems[nextItems.length - 1], items: nextItems, alreadyExists: false };
}

export function removePinnedMemoryItems(agentDir, { id, keyword, memoryScope }: { id?: string; keyword?: string; memoryScope?: unknown } = {}) {
  const normalizedId = normalizeId(id);
  const keywordTrim = normalizeContent(keyword);
  const normalizedKeyword = keywordTrim.toLowerCase();
  if (!normalizedId && !normalizedKeyword) {
    throw new Error("Either id or keyword must be provided");
  }

  const items = readPinnedMemoryItems(agentDir);

  // 精确匹配优先：keyword 恰好等于某条 content 时只删那条，避免
  // unpin "foo" 把 "foobar"/"FOOZ" 一并删掉的过度删除；没有精确命中
  // 才回退到 i18n 描述承诺的「模糊匹配」（不区分大小写子串）。
  const hasExactKeyword = normalizedKeyword
    ? items.some((item) => (!memoryScope || sameMemoryScope(item.memoryScope, memoryScope)) && item.content === keywordTrim)
    : false;

  const removed = [];
  const remaining = [];

  for (const item of items) {
    const matchesId = normalizedId && item.id === normalizedId;
    const matchesKeyword = normalizedKeyword && (
      hasExactKeyword
        ? item.content === keywordTrim
        : item.content.toLowerCase().includes(normalizedKeyword)
    );
    if ((!memoryScope || sameMemoryScope(item.memoryScope, memoryScope)) && (matchesId || matchesKeyword)) {
      removed.push(item);
    } else {
      remaining.push(item);
    }
  }

  if (removed.length > 0) {
    writePinnedMemoryItems(agentDir, remaining);
  }

  return { removed, items: remaining };
}

export function replacePinnedMemoryItems(agentDir, contents) {
  const previous = readPinnedMemoryItems(agentDir);
  // Match the settings endpoint's default scope exactly. Legacy author/character
  // records are independently scoped too and must survive a default-pin edit.
  const memoryScope = normalizeMemoryScope(undefined, path.basename(agentDir));
  const legacy = previous.filter(item => sameMemoryScope(item.memoryScope, memoryScope));
  const items = contents
    .map((content) => normalizeContent(content))
    .filter(Boolean)
    .map((content) => legacy.find(item => item.content === content) ?? ({
      id: makeId(content), content, origin: "manual", createdAt: new Date().toISOString(),
    }));
  return writePinnedMemoryItems(agentDir, [...items, ...previous.filter(item => !sameMemoryScope(item.memoryScope, memoryScope))]);
}
