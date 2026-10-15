import fs from "fs";
import path from "path";
import { randomUUID } from "node:crypto";
import { ScopedDerivationStore } from "./scoped-derivation-store.ts";
import { atomicWriteSync } from "../../shared/safe-fs.ts";

const COMPILED_FILES = ["memory.md", "facts.md", "today.md", "week.md", "longterm.md"];

export function resetMarkerPath(memoryDir) {
  return path.join(memoryDir, "reset.json");
}

export type MemoryResetToken = {
  memoryDir: string;
  domain: "compiled" | "facts";
  resetAt: string | null;
  revision: string | null;
};

export type ChannelMemoryBoundary = { messageCount: number; prefixHash: string };

type ResetMarker = {
  compiledResetAt: string;
  resetRevision?: string;
  factsResetAt?: string;
  factsResetRevision?: string;
  v1Retired?: boolean;
  channelSources?: Record<string, ChannelMemoryBoundary>;
  updatedAt?: string;
};

function validDate(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !Number.isNaN(Date.parse(value));
}

// Only absence means "never reset". I/O and invalid markers must fail closed.
export function readMemoryResetMarker(memoryDir: string): ResetMarker | null {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(resetMarkerPath(memoryDir), "utf-8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`Memory reset marker is unreadable: ${error?.message || error}`, { cause: error });
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !validDate(raw.compiledResetAt)) {
    throw new Error("Memory reset marker has an invalid compiledResetAt");
  }
  if (raw.factsResetAt !== undefined) {
    if (!validDate(raw.factsResetAt) || typeof raw.factsResetRevision !== "string"
      || !raw.factsResetRevision || raw.v1Retired !== true
      || !raw.channelSources || typeof raw.channelSources !== "object" || Array.isArray(raw.channelSources)
      || Object.values(raw.channelSources as Record<string, ChannelMemoryBoundary>).some((entry) =>
        !entry || !Number.isSafeInteger(entry.messageCount) || entry.messageCount < 0
        || typeof entry.prefixHash !== "string" || !/^[a-f0-9]{64}$/.test(entry.prefixHash))) {
      throw new Error("Memory reset marker has an invalid full-reset boundary");
    }
  } else if (raw.factsResetRevision !== undefined || raw.v1Retired !== undefined || raw.channelSources !== undefined) {
    throw new Error("Memory reset marker has an incomplete full-reset boundary");
  }
  return raw;
}

export function readCompiledResetState(memoryDir): { resetAt: string | null; revision: string | null } {
  const raw = readMemoryResetMarker(memoryDir);
  return { resetAt: raw?.compiledResetAt || null, revision: typeof raw?.resetRevision === "string" ? raw.resetRevision : null };
}

export function readCompiledResetAt(memoryDir) {
  return readCompiledResetState(memoryDir).resetAt;
}

export function captureMemoryReset(memoryDir: string, domain: MemoryResetToken["domain"] = "compiled"): MemoryResetToken {
  const raw = readMemoryResetMarker(memoryDir);
  return {
    memoryDir: path.resolve(memoryDir), domain,
    resetAt: (domain === "facts" ? raw?.factsResetAt : raw?.compiledResetAt) || null,
    revision: domain === "facts"
      ? raw?.factsResetRevision || null
      : typeof raw?.resetRevision === "string" ? raw.resetRevision : null,
  };
}

// Synchronous: no await between this check and the caller's entire commit.
export function isMemoryResetCurrent(memoryDir: string, captured: MemoryResetToken, domain: MemoryResetToken["domain"] = captured?.domain) {
  if (!captured || captured.domain !== domain || captured.memoryDir !== path.resolve(memoryDir)
    || !["compiled", "facts"].includes(captured.domain)) return false;
  const current = captureMemoryReset(memoryDir, captured.domain);
  return current.resetAt === captured.resetAt && current.revision === captured.revision;
}

// Retained for callers of the original timestamp/revision API.
export function isCompiledResetCurrent(memoryDir, captured: ReturnType<typeof readCompiledResetState>) {
  const current = readCompiledResetState(memoryDir);
  return current.resetAt === captured.resetAt && current.revision === captured.revision;
}

export function writeCompiledResetMarker(memoryDir, resetAt = new Date().toISOString(), options: {
  kind?: "compiled" | "full";
  channelSources?: Record<string, ChannelMemoryBoundary>;
} = {}) {
  if (!validDate(resetAt)) throw new Error("compiledResetAt must be an ISO timestamp");
  const previous = readMemoryResetMarker(memoryDir);
  fs.mkdirSync(memoryDir, { recursive: true });
  const marker: ResetMarker = {
    ...previous,
    compiledResetAt: resetAt,
    resetRevision: randomUUID(),
    updatedAt: new Date().toISOString(),
    ...(options.kind === "full" ? {
      factsResetAt: resetAt,
      factsResetRevision: randomUUID(),
      v1Retired: true,
      channelSources: options.channelSources || {},
    } : {}),
  };
  atomicWrite(resetMarkerPath(memoryDir), JSON.stringify(marker, null, 2) + "\n");
  return resetAt;
}

// Move active inputs to a unique, non-consumed location. Never overwrite archives
// or unlink newly retired user content. Failure propagates to the reset route.
export function archiveRetiredMemorySources(memoryDir: string, relativePaths: string[]) {
  const sources = relativePaths.filter((name) => {
    try { fs.lstatSync(path.join(memoryDir, name)); return true; }
    catch (error) { if (error?.code === "ENOENT") return false; throw error; }
  });
  if (!sources.length) return null;
  const archiveRoot = path.join(memoryDir, "reset-archive");
  fs.mkdirSync(archiveRoot, { recursive: true });
  const archive = fs.mkdtempSync(path.join(archiveRoot, "retired-"));
  for (const name of sources) {
    if (path.isAbsolute(name) || name.split(/[\\/]/).includes("..")) throw new Error("Invalid retired memory path");
    const destination = path.join(archive, name);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.renameSync(path.join(memoryDir, name), destination);
  }
  return archive;
}

export function clearCompiledMemoryArtifacts(memoryDir) {
  const retired = ["editable-facts.md", "dream/pending-apply.json"];
  try {
    for (const entry of fs.readdirSync(path.join(memoryDir, "daily"), { withFileTypes: true })) {
      if (entry.isFile() && /^\d{4}-\d{2}-\d{2}\.md(?:\.fingerprint)?$/.test(entry.name)) {
        retired.push(path.join("daily", entry.name));
      }
    }
  } catch (error) { if (error?.code !== "ENOENT") throw error; }
  archiveRetiredMemorySources(memoryDir, retired);
  new ScopedDerivationStore(memoryDir).invalidateAll();
  fs.mkdirSync(memoryDir, { recursive: true });
  for (const name of COMPILED_FILES) {
    const filePath = path.join(memoryDir, name);
    fs.writeFileSync(filePath, "", "utf-8");
    removeIfExists(`${filePath}.fingerprint`);
  }
}

export function clearCompiledSummarySources(summariesDir, summaryManager = null) {
  new ScopedDerivationStore(path.dirname(summariesDir)).invalidateAll("summary sources reset");
  fs.mkdirSync(summariesDir, { recursive: true });
  for (const entry of fs.readdirSync(summariesDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    removeIfExists(path.join(summariesDir, entry.name));
  }
  summaryManager?.clearCache?.();
}

export function normalizeCompiledSectionBody(value) {
  const raw = stripThinkTagBlocks(String(value || "")).trim();
  if (!raw) return "";

  const parsedArray = parseStringArray(raw);
  const text = parsedArray
    ? parsedArray.map((item) => `- ${item.trim()}`).join("\n")
    : raw;

  return text
    .split(/\r?\n/)
    .filter((line) => !/^#{1,6}\s+\S/.test(line.trim()))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function normalizeCompiledLLMResult(value, source = "compiled memory") {
  const normalized = normalizeCompiledSectionBody(value);
  if (!normalized && hasDanglingLeadingThinkTag(value)) {
    throw new Error(`${source} returned an unterminated thinking block`);
  }
  return normalized;
}

export function stripThinkTagBlocks(value) {
  return String(value || "")
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>\s*/gi, "")
    .replace(/^\s*<think(?:ing)?>[\s\S]*$/i, "")
    .replace(/<\/think(?:ing)?>\s*/gi, "");
}

export function hasDanglingLeadingThinkTag(value) {
  const text = String(value || "");
  return /^\s*<think(?:ing)?>/i.test(text) && !/<\/think(?:ing)?>/i.test(text);
}

function parseStringArray(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    if (!parsed.every((item) => typeof item === "string")) return null;
    return parsed.filter((item) => item.trim());
  } catch {
    return null;
  }
}

function removeIfExists(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
  }
}

function atomicWrite(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  atomicWriteSync(filePath, content);
}
