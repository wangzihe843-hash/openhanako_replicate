import crypto from "crypto";
import fs from "fs";
import path from "path";
import { atomicWriteSync } from "../../../shared/safe-fs.ts";
import {
  assemble,
  assembleWeekFromDaily,
  listWeekDayEntries,
  readCompiledMemorySections,
  writeDailyEntryBody,
} from "../compile.ts";
import { archiveRetiredMemorySources, captureMemoryReset, isMemoryResetCurrent, type MemoryResetToken } from "../compiled-memory-state.ts";
import { dreamDir, type DreamRunTrigger } from "./state-store.ts";
import {
  assertNoPendingDreamJournal,
  assertDreamOutputSeparated,
  captureDreamFileJournal,
  publishDreamFileJournal,
  readDreamFileJournal,
  rollbackDreamFiles,
  verifyDreamFileWrites,
  type DreamFileJournal,
} from "./file-transaction.ts";

export type DreamWeekDay = { date: string; body: string };
export type DreamSections = {
  facts: string;
  today: string;
  weekDays: DreamWeekDay[];
  longterm: string;
};

export type DreamRevisionKind = "dream" | "pre_restore";

export type DreamRevision = {
  schemaVersion: 1;
  revisionId: string;
  runId: string;
  trigger: DreamRunTrigger;
  createdAt: string;
  kind: DreamRevisionKind;
  restoresRevisionId: string | null;
  before: DreamSections;
};

export type DreamRevisionSummary = Omit<DreamRevision, "before"> & {
  bodyChars: number;
  sectionChars: {
    facts: number;
    today: number;
    week: number;
    longterm: number;
  };
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_REVISIONS = 10;

function revisionsDir(memoryDir: string) {
  return path.join(dreamDir(memoryDir), "revisions");
}

function pendingPath(memoryDir: string) {
  return path.join(dreamDir(memoryDir), "pending-apply.json");
}

function revisionPath(memoryDir: string, revisionId: string) {
  if (!/^[a-zA-Z0-9._-]+$/.test(revisionId)) throw new Error("Invalid Dream revision id");
  return path.join(revisionsDir(memoryDir), `${revisionId}.json`);
}

function dreamSectionsHash(sections: DreamSections) {
  return crypto.createHash("sha256").update(JSON.stringify(sections)).digest("hex");
}

function sectionCharSummary(sections: DreamSections) {
  const sectionChars = {
    facts: sections.facts.length,
    today: sections.today.length,
    week: sections.weekDays.reduce((sum, entry) => sum + entry.body.length, 0),
    longterm: sections.longterm.length,
  };
  return {
    bodyChars: Object.values(sectionChars).reduce((sum, value) => sum + value, 0),
    sectionChars,
  };
}

export function snapshotDreamSections(memoryDir: string, opts: { strictReads?: boolean } = {}): DreamSections {
  const sections = readCompiledMemorySections(memoryDir, { strictReads: opts.strictReads, skipBaseline: opts.strictReads });
  return {
    facts: sections.facts,
    today: sections.today,
    weekDays: listWeekDayEntries(memoryDir, opts),
    longterm: sections.longterm,
  };
}

export function createDreamRevision(memoryDir: string, options: {
  runId: string;
  trigger: DreamRunTrigger;
  before: DreamSections;
  kind?: DreamRevisionKind;
  restoresRevisionId?: string | null;
  retainRevisionIds?: string[];
}) {
  const revisionId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}`;
  const revision: DreamRevision = {
    schemaVersion: 1,
    revisionId,
    runId: options.runId,
    trigger: options.trigger,
    createdAt: new Date().toISOString(),
    kind: options.kind || "dream",
    restoresRevisionId: options.restoresRevisionId || null,
    before: options.before,
  };
  fs.mkdirSync(revisionsDir(memoryDir), { recursive: true });
  atomicWriteSync(revisionPath(memoryDir, revisionId), `${JSON.stringify(revision, null, 2)}\n`);
  pruneDreamRevisions(memoryDir, new Set([revisionId, ...(options.retainRevisionIds || [])]));
  return revision;
}

export function readDreamRevision(memoryDir: string, revisionId: string): DreamRevision {
  let raw: any;
  try {
    raw = JSON.parse(fs.readFileSync(revisionPath(memoryDir, revisionId), "utf-8"));
  } catch (err: any) {
    if (err?.code === "ENOENT") throw new Error("Dream revision not found");
    throw new Error(`Dream revision is unreadable: ${err?.message || err}`);
  }
  if (raw?.schemaVersion !== 1 || raw?.revisionId !== revisionId || !raw?.before) {
    throw new Error("Dream revision has an invalid format");
  }
  const kind: DreamRevisionKind = raw.kind === "pre_restore" ? "pre_restore" : "dream";
  return {
    ...raw,
    kind,
    restoresRevisionId: typeof raw.restoresRevisionId === "string" ? raw.restoresRevisionId : null,
  } as DreamRevision;
}

export function listDreamRevisions(memoryDir: string): DreamRevisionSummary[] {
  const dir = revisionsDir(memoryDir);
  let files: string[];
  try {
    files = fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name.slice(0, -".json".length));
  } catch (err: any) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }

  return files
    .map((revisionId) => readDreamRevision(memoryDir, revisionId))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt)
      || right.revisionId.localeCompare(left.revisionId, "en"))
    .map(({ before, ...revision }) => ({
      ...revision,
      ...sectionCharSummary(before),
    }));
}

function normalizeSections(sections: DreamSections) {
  const dates = new Set<string>();
  const weekDays = sections.weekDays.map((entry) => {
    if (!DATE_RE.test(entry?.date || "") || dates.has(entry.date)) {
      throw new Error("Dream output contains an invalid or duplicate week date");
    }
    dates.add(entry.date);
    return { date: entry.date, body: String(entry.body || "").trim() };
  });
  return {
    facts: String(sections.facts || "").trim(),
    today: String(sections.today || "").trim(),
    weekDays,
    longterm: String(sections.longterm || "").trim(),
  };
}

function writeSectionFile(filePath: string, body: string) {
  const markdown = body ? `${body}\n` : "";
  atomicWriteSync(filePath, markdown);
  return markdown;
}

function assembleMemory(memoryDir: string, memoryMdPath: string, strictReads = false) {
  return assemble(
    path.join(memoryDir, "facts.md"),
    path.join(memoryDir, "today.md"),
    path.join(memoryDir, "week.md"),
    path.join(memoryDir, "longterm.md"),
    memoryMdPath,
    { strictReads },
  );
}

function applyAllFiles(memoryDir: string, sections: DreamSections, memoryMdPath: string, strictReads = false) {
  const normalized = normalizeSections(sections);
  const dailyDir = path.join(memoryDir, "daily");
  fs.mkdirSync(dailyDir, { recursive: true });
  const writes: Record<string, string> = {};
  for (const section of ["facts", "today", "longterm"] as const) {
    const name = `${section}.md`;
    writes[name] = writeSectionFile(path.join(memoryDir, name), normalized[section]);
  }
  for (const entry of normalized.weekDays) {
    const body = writeDailyEntryBody(dailyDir, entry.date, entry.body);
    writes[`daily/${entry.date}.md`] = body ? `## ${entry.date}\n\n${body}\n` : "";
  }
  writes["week.md"] = assembleWeekFromDaily(dailyDir, path.join(memoryDir, "week.md"), { strictReads });
  writes["memory.md"] = assembleMemory(memoryDir, memoryMdPath, strictReads);
  if (strictReads) verifyDreamFileWrites(memoryDir, memoryMdPath, writes);
  return normalized;
}

function applyDreamFiles(memoryDir: string, sections: DreamSections, memoryMdPath: string, strictReads = false) {
  const normalized = normalizeSections(sections);
  const writes = {
    "facts.md": writeSectionFile(path.join(memoryDir, "facts.md"), normalized.facts),
    "longterm.md": writeSectionFile(path.join(memoryDir, "longterm.md"), normalized.longterm),
    "memory.md": assembleMemory(memoryDir, memoryMdPath, strictReads),
  };
  if (strictReads) verifyDreamFileWrites(memoryDir, memoryMdPath, writes);
  return snapshotDreamSections(memoryDir, { strictReads });
}

function applyWithFileJournal<T>(memoryDir: string, journal: DreamFileJournal, apply: () => T): T {
  fs.mkdirSync(dreamDir(memoryDir), { recursive: true });
  // Publication and read-back must finish before the first active-file write.
  publishDreamFileJournal(pendingPath(memoryDir), journal);
  try {
    const result = apply();
    fs.rmSync(pendingPath(memoryDir), { force: true });
    return result;
  } catch (error) {
    try {
      rollbackDreamFiles(memoryDir, journal);
      fs.rmSync(pendingPath(memoryDir), { force: true });
    } catch (rollbackError) {
      throw new Error(`Dream ${journal.operation === "restore" ? "restore" : "apply"} failed and rollback also failed: ${rollbackError?.message || rollbackError}`, { cause: error });
    }
    throw error;
  }
}

export function applyDreamSections(memoryDir: string, options: {
  revision: DreamRevision;
  next: DreamSections;
  memoryMdPath?: string;
  reset?: MemoryResetToken;
}) {
  const reset = options.reset || captureMemoryReset(memoryDir);
  if (!isMemoryResetCurrent(memoryDir, reset, "compiled")) throw new Error("Dream reset generation was superseded");
  const memoryMdPath = options.memoryMdPath || path.join(memoryDir, "memory.md");
  assertDreamOutputSeparated(memoryDir, memoryMdPath);
  if (options.next.today !== options.revision.before.today
    || JSON.stringify(options.next.weekDays) !== JSON.stringify(options.revision.before.weekDays)) {
    throw new Error("Dream may not rewrite Today or Week");
  }

  assertNoPendingDreamJournal(pendingPath(memoryDir));
  normalizeSections(options.next);
  snapshotDreamSections(memoryDir, { strictReads: true });
  const journal = captureDreamFileJournal(memoryDir, {
    revisionId: options.revision.revisionId,
    operation: "dream",
    reset,
    memoryMdPath,
  });
  return applyWithFileJournal(memoryDir, journal, () => applyDreamFiles(memoryDir, options.next, memoryMdPath, true));
}

export function restoreDreamRevision(memoryDir: string, revisionId: string, memoryMdPath?: string) {
  const resolvedMemoryMdPath = memoryMdPath || path.join(memoryDir, "memory.md");
  assertDreamOutputSeparated(memoryDir, resolvedMemoryMdPath);
  const reset = captureMemoryReset(memoryDir);
  assertNoPendingDreamJournal(pendingPath(memoryDir));
  const revision = readDreamRevision(memoryDir, revisionId);
  const target = normalizeSections(revision.before);
  const current = snapshotDreamSections(memoryDir, { strictReads: true });
  if (dreamSectionsHash(current) === dreamSectionsHash(revision.before)) return current;

  // Capture absence and raw bytes before safety-revision creation or normalization writes.
  const before = captureDreamFileJournal(memoryDir, {
    revisionId: revision.revisionId,
    targetRevisionId: revision.revisionId,
    operation: "restore",
    reset,
    memoryMdPath: resolvedMemoryMdPath,
    dailyDates: target.weekDays.map(entry => entry.date),
  });
  const safetyRevision = createDreamRevision(memoryDir, {
    runId: `restore-${crypto.randomUUID()}`,
    trigger: "manual",
    before: current,
    kind: "pre_restore",
    restoresRevisionId: revision.revisionId,
    retainRevisionIds: [revision.revisionId],
  });
  return applyWithFileJournal(memoryDir, { ...before, revisionId: safetyRevision.revisionId }, () =>
    applyAllFiles(memoryDir, target, resolvedMemoryMdPath, true));
}

export function recoverPendingDreamApply(memoryDir: string, memoryMdPath?: string) {
  let pending: any;
  try {
    pending = JSON.parse(fs.readFileSync(pendingPath(memoryDir), "utf-8"));
  } catch (err: any) {
    if (err?.code === "ENOENT") return false;
    throw new Error(`Dream pending journal is unreadable: ${err?.message || err}`);
  }
  const resolvedMemoryMdPath = memoryMdPath || path.join(memoryDir, "memory.md");
  const fileJournal = pending?.schemaVersion === 2
    ? readDreamFileJournal(pending, memoryDir, resolvedMemoryMdPath)
    : null;
  if (pending?.schemaVersion !== undefined && ![1, 2].includes(pending.schemaVersion)) {
    throw new Error("Dream pending journal has an unsupported schema version");
  }
  const reset = captureMemoryReset(memoryDir);
  const current = pending?.reset
    ? pending.reset.domain === "compiled" && isMemoryResetCurrent(memoryDir, pending.reset)
    : reset.resetAt === null;
  if (!current) {
    archiveRetiredMemorySources(memoryDir, ["dream/pending-apply.json"]);
    return false;
  }
  if (fileJournal) {
    rollbackDreamFiles(memoryDir, fileJournal);
    fs.rmSync(pendingPath(memoryDir), { force: true });
    return true;
  }
  const revision = readDreamRevision(memoryDir, pending?.revisionId);
  if (pending?.operation === "dream") {
    applyDreamFiles(memoryDir, revision.before, resolvedMemoryMdPath);
  } else {
    // Older journals had no operation field and could have partially rewritten
    // any section, so their recovery must restore the complete snapshot.
    applyAllFiles(memoryDir, revision.before, resolvedMemoryMdPath);
  }
  fs.rmSync(pendingPath(memoryDir), { force: true });
  return true;
}

function pruneDreamRevisions(memoryDir: string, retainedRevisionIds = new Set<string>()) {
  const dir = revisionsDir(memoryDir);
  const files = fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => ({ name: entry.name, stat: fs.statSync(path.join(dir, entry.name)) }))
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  let remaining = files.length;
  for (const file of [...files].reverse()) {
    if (remaining <= MAX_REVISIONS) break;
    const revisionId = file.name.slice(0, -".json".length);
    if (retainedRevisionIds.has(revisionId)) continue;
    fs.rmSync(path.join(dir, file.name), { force: true });
    remaining -= 1;
  }
}
