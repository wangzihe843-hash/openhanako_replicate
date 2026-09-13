/**
 * Check facts.db and quarantine a corrupt database with its WAL/SHM files.
 */
import fs from "fs";
import path from "path";
import { randomUUID } from "node:crypto";
import { t } from "../../i18n.ts";
import { createModuleLogger } from "../../debug-log.ts";

/** A partially rolled-back backup must not be followed by automatic database creation. */
export class IncompleteCompatRecoveryError extends Error {
  constructor(cause: AggregateError) {
    super("Compatibility recovery is incomplete; restore the retained backup files before retrying.", { cause });
    this.name = "IncompleteCompatRecoveryError";
  }
}

const moduleLog = createModuleLogger("compat");

// New groups move sidecars first and the main file last. Orphan UUID-named
// sidecars survive an incomplete rollback; check before any later DB open.
function assertCompleteRecoveryGroups(memoryDir: string): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(memoryDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new IncompleteCompatRecoveryError(new AggregateError([error], "Cannot inspect database recovery files"));
  }
  const groups = new Set(entries.flatMap(name => {
    const match = /^(facts[.]db[.]bak-\d+-[0-9a-f-]{36})-(?:wal|shm)$/.exec(name);
    return match ? [match[1]] : [];
  }));
  for (const group of groups) {
    if (!fs.existsSync(path.join(memoryDir, group))) {
      throw new IncompleteCompatRecoveryError(new AggregateError(
        [new Error('Incomplete database backup group: ' + group)],
        "Restore the retained sidecars before retrying database initialization",
      ));
    }
  }
}

export async function checkFactsDb({ agentDir, log }: { agentDir: string; log?: (message: string) => void }) {
  const dbPath = path.join(agentDir, "memory", "facts.db");
  assertCompleteRecoveryGroups(path.dirname(dbPath));
  if (!fs.existsSync(dbPath)) return;

  let Database;
  try {
    Database = (await import("better-sqlite3")).default;
  } catch {
    return; // A missing native binding is not evidence of database corruption.
  }

  let problem: unknown;
  let db: InstanceType<typeof Database> | undefined;
  try {
    db = new Database(dbPath, { readonly: true });
    db.prepare("SELECT COUNT(*) FROM facts").get();
  } catch (error) {
    problem = error;
  } finally {
    // Release a failed query's handle before attempting any Windows rename.
    // If closing itself fails, do not quarantine a database that may still be open.
    db?.close();
  }
  if (!problem) return;
  const failure = problem as { code?: string; message?: string };
  const isCorrupt = failure.code === "SQLITE_CORRUPT" || failure.code === "SQLITE_NOTADB"
    || (failure.code === "SQLITE_ERROR" && /no such table: facts\b/.test(failure.message || ""));
  if (!isCorrupt) throw problem;

  const backupPath = dbPath + `.bak-${Date.now()}-${randomUUID()}`;
  const moved: { source: string; backup: string }[] = [];
  try {
    // Move the main file last: an early sidecar failure must not invite creation of a new DB.
    for (const ext of ["-wal", "-shm", ""]) {
      const source = dbPath + ext;
      if (ext && !fs.existsSync(source)) continue;
      const backup = backupPath + ext;
      fs.renameSync(source, backup);
      moved.push({ source, backup });
    }
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    for (const { source, backup } of moved.reverse()) {
      try {
        if (fs.existsSync(source)) throw new Error(`Refusing to overwrite a recreated database file: ${source}`);
        fs.renameSync(backup, source);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length) {
      throw new IncompleteCompatRecoveryError(new AggregateError([error, ...rollbackErrors], "Database backup rollback failed"));
    }
    throw error;
  }

  const corruptMsg = `facts.db 损坏 (${failure.message})，已备份到 ${path.basename(backupPath)}`;
  if (log) log(`  [compat] ${corruptMsg}`); else moduleLog.log(corruptMsg);
  return { fixed: true, message: t("error.compatFactsCorrupted") };
}
