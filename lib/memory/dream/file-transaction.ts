import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { atomicWriteSync } from "../../../shared/safe-fs.ts";
import type { MemoryResetToken } from "../compiled-memory-state.ts";

type FileImage = { name: string; base64: string | null };
export type DreamFileJournal = {
  schemaVersion: 2;
  revisionId: string;
  targetRevisionId?: string;
  startedAt: string;
  operation: "dream" | "restore";
  reset: MemoryResetToken;
  memoryMdPath: string;
  beforeFiles: FileImage[];
  beforeHash: string;
};

const DREAM_FILES = ["facts.md", "longterm.md", "memory.md"];
const RESTORE_FILES = [...DREAM_FILES, "today.md", "week.md"];
const DAILY_FILE = /^daily\/\d{4}-\d{2}-\d{2}\.md$/;
// The compiled output is configurable, but cannot replace an input or the
// protocol that protects it. Include inputs Dream itself does not rewrite.
const RESERVED_FILES = [
  "facts.md", "today.md", "week.md", "longterm.md", "editable-facts.md",
  "reset.json", "today-state.json", "editable-facts-state.json", "daily-state.json",
  "longterm.md.fingerprint", "week.md.migrated.bak", "scoped-derivations.v1.json",
  "memories.db", ".v2-migrated",
];
const RESERVED_DIRECTORIES = ["daily", "dream", "summaries", "reset-archive"];

export function assertDreamOutputSeparated(memoryDir: string, memoryMdPath: string) {
  const normalize = (value: string) => {
    const resolved = path.resolve(value);
    return process.platform === "darwin" || process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  const relative = path.relative(normalize(memoryDir), normalize(memoryMdPath));
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return;
  const key = relative.split(path.sep).join("/");
  if (!key || key === "memory.md.tmp"
    || RESERVED_FILES.some(name => key === name || key === `${name}.tmp`
      || key.startsWith(`${name}/`) || key.startsWith(`${name}.tmp/`))
    || RESERVED_DIRECTORIES.some(name => key === name || key.startsWith(`${name}/`))) {
    throw new Error("Dream memory output overlaps a memory source or transaction file");
  }
}

function imageHash(images: FileImage[]) {
  return crypto.createHash("sha256").update(JSON.stringify(images)).digest("hex");
}

function filePath(memoryDir: string, memoryMdPath: string, name: string) {
  return name === "memory.md" ? path.resolve(memoryMdPath) : path.join(memoryDir, name);
}

function readImage(target: string): string | null {
  try {
    // Atomic replacement cannot restore the identity of a non-regular file.
    if (!fs.lstatSync(target).isFile()) throw new Error("Dream requires a regular memory file");
    return fs.readFileSync(target).toString("base64");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export function assertNoPendingDreamJournal(journalPath: string) {
  try { fs.lstatSync(journalPath); }
  catch (error) { if (error?.code === "ENOENT") return; throw error; }
  throw new Error("Dream pending journal must be recovered before another operation");
}

export function captureDreamFileJournal(memoryDir: string, options: {
  revisionId: string;
  targetRevisionId?: string;
  operation: DreamFileJournal["operation"];
  reset: MemoryResetToken;
  memoryMdPath: string;
  dailyDates?: string[];
}): DreamFileJournal {
  assertDreamOutputSeparated(memoryDir, options.memoryMdPath);
  const names = options.operation === "dream" ? [...DREAM_FILES]
    : [...RESTORE_FILES, ...(options.dailyDates || []).map(date => `daily/${date}.md`)];
  const resolved = names.map(name => path.resolve(filePath(memoryDir, options.memoryMdPath, name)));
  if (new Set(resolved).size !== names.length) throw new Error("Dream memory output overlaps a source file");
  const beforeFiles = names.map(name => ({ name, base64: readImage(filePath(memoryDir, options.memoryMdPath, name)) }));
  return {
    schemaVersion: 2,
    revisionId: options.revisionId,
    ...(options.targetRevisionId ? { targetRevisionId: options.targetRevisionId } : {}),
    startedAt: new Date().toISOString(),
    operation: options.operation,
    reset: options.reset,
    memoryMdPath: path.resolve(options.memoryMdPath),
    beforeFiles,
    beforeHash: imageHash(beforeFiles),
  };
}

export function readDreamFileJournal(raw: unknown, memoryDir: string, memoryMdPath: string): DreamFileJournal {
  const journal = raw as DreamFileJournal;
  const invalid = () => { throw new Error("Dream file journal has an invalid format"); };
  if (!journal || journal.schemaVersion !== 2 || !["dream", "restore"].includes(journal.operation)
    || typeof journal.revisionId !== "string" || !journal.revisionId
    || typeof journal.startedAt !== "string" || !journal.startedAt
    || journal.memoryMdPath !== path.resolve(memoryMdPath)
    || !Array.isArray(journal.beforeFiles) || !journal.reset
    || journal.reset.domain !== "compiled" || typeof journal.reset.memoryDir !== "string"
    || !(journal.reset.resetAt === null || typeof journal.reset.resetAt === "string")
    || !(journal.reset.revision === null || typeof journal.reset.revision === "string")) return invalid();
  assertDreamOutputSeparated(memoryDir, memoryMdPath);
  const required = journal.operation === "dream" ? DREAM_FILES : RESTORE_FILES;
  const names = new Set<string>();
  const targets = new Set<string>();
  for (const image of journal.beforeFiles) {
    if (!image || typeof image.name !== "string" || names.has(image.name)
      || (!required.includes(image.name) && !(journal.operation === "restore" && DAILY_FILE.test(image.name)))
      || !(image.base64 === null || typeof image.base64 === "string"
        && Buffer.from(image.base64, "base64").toString("base64") === image.base64)) return invalid();
    names.add(image.name);
    targets.add(path.resolve(filePath(memoryDir, memoryMdPath, image.name)));
  }
  if (required.some(name => !names.has(name)) || targets.size !== names.size
    || journal.beforeHash !== imageHash(journal.beforeFiles)) return invalid();
  return journal;
}

export function publishDreamFileJournal(journalPath: string, journal: DreamFileJournal) {
  const bytes = `${JSON.stringify(journal, null, 2)}\n`;
  atomicWriteSync(journalPath, bytes);
  if (fs.readFileSync(journalPath, "utf-8") !== bytes) throw new Error("Dream journal write verification failed");
}

export function rollbackDreamFiles(memoryDir: string, journal: DreamFileJournal) {
  for (const image of journal.beforeFiles) {
    const target = filePath(memoryDir, journal.memoryMdPath, image.name);
    if (readImage(target) === image.base64) continue;
    if (image.base64 === null) {
      try { fs.unlinkSync(target); }
      catch (error) { if (error?.code !== "ENOENT") throw error; }
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      atomicWriteSync(target, Buffer.from(image.base64, "base64"));
    }
  }
  for (const image of journal.beforeFiles) {
    if (readImage(filePath(memoryDir, journal.memoryMdPath, image.name)) !== image.base64) {
      throw new Error(`Dream rollback verification failed: ${image.name}`);
    }
  }
}

export function verifyDreamFileWrites(memoryDir: string, memoryMdPath: string, writes: Record<string, string>) {
  for (const [name, body] of Object.entries(writes)) {
    if (readImage(filePath(memoryDir, memoryMdPath, name)) !== Buffer.from(body).toString("base64")) {
      throw new Error(`Dream write verification failed: ${name}`);
    }
  }
}
