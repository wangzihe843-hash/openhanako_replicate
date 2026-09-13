import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkConfigYaml } from "../lib/compat/checks/config-yaml.ts";
import { checkFactsDb, IncompleteCompatRecoveryError } from "../lib/compat/checks/facts-db.ts";
import { runCompatChecks } from "../lib/compat/index.ts";

const database = vi.hoisted(() => ({
  queryError: null as Error | null,
  closeError: null as Error | null,
  closed: false,
}));
vi.mock("better-sqlite3", () => ({
  default: class {
    prepare() { return { get: () => { if (database.queryError) throw database.queryError; return { count: 0 }; } }; }
    close() { database.closed = true; if (database.closeError) throw database.closeError; }
  },
}));

let tempRoot: string;
let agentDir: string;
const ioError = () => Object.assign(new Error("injected I/O failure"), { code: "EACCES" });
beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "compat-recovery-"));
  agentDir = path.join(tempRoot, "home", "agents", "hana");
  fs.mkdirSync(path.join(agentDir, "memory"), { recursive: true });
  database.queryError = null;
  database.closeError = null;
  database.closed = false;
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});
function invalidConfig(withTemplate = true) {
  fs.writeFileSync(path.join(agentDir, "config.yaml"), "unparseable source");
  if (withTemplate) {
    fs.mkdirSync(path.join(tempRoot, "lib"), { recursive: true });
    fs.writeFileSync(path.join(tempRoot, "lib", "config.example.yaml"), "agent:\n  name: Hana\n");
  }
}
function corruptDatabase() {
  const dbPath = path.join(agentDir, "memory", "facts.db");
  for (const ext of ["", "-wal", "-shm"]) fs.writeFileSync(dbPath + ext, "retained " + (ext || "main"));
  database.queryError = Object.assign(new Error("file is not a database"), { code: "SQLITE_NOTADB" });
  return dbPath;
}

describe("config recovery", () => {
  it("never overwrites a configuration when its backup cannot be created", () => {
    invalidConfig();
    vi.spyOn(fs, "renameSync").mockImplementation(() => { throw ioError(); });
    expect(() => checkConfigYaml({ agentDir })).toThrow("injected");
    expect(fs.readFileSync(path.join(agentDir, "config.yaml"), "utf8")).toBe("unparseable source");
    expect(fs.readdirSync(agentDir).filter(file => file.includes(".bak-"))).toHaveLength(0);
  });
  it("does not treat permission errors reading config as corruption", () => {
    invalidConfig();
    const read = fs.readFileSync;
    vi.spyOn(fs, "readFileSync").mockImplementation((...args: Parameters<typeof fs.readFileSync>) => {
      if (String(args[0]) === path.join(agentDir, "config.yaml")) throw ioError();
      return read(...args);
    });
    const rename = vi.spyOn(fs, "renameSync");
    expect(() => checkConfigYaml({ agentDir })).toThrow("injected");
    expect(rename).not.toHaveBeenCalled();
  });
  it("keeps a real backup when template publication fails and does not report success", () => {
    invalidConfig();
    const write = fs.writeFileSync;
    vi.spyOn(fs, "writeFileSync").mockImplementation((...args: Parameters<typeof fs.writeFileSync>) => {
      if (String(args[0]) === path.join(agentDir, "config.yaml.tmp")) throw ioError();
      return write(...args);
    });
    expect(() => checkConfigYaml({ agentDir })).toThrow("injected");
    const backups = fs.readdirSync(agentDir).filter(file => file.includes(".bak-"));
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(agentDir, backups[0]), "utf8")).toBe("unparseable source");
  });
  it("rebuilds only after a successful backup", () => {
    invalidConfig();
    expect(checkConfigYaml({ agentDir })?.fixed).toBe(true);
    expect(fs.readFileSync(path.join(agentDir, "config.yaml"), "utf8")).toContain("name: Hana");
    const backups = fs.readdirSync(agentDir).filter(file => file.includes(".bak-"));
    expect(fs.readFileSync(path.join(agentDir, backups[0]), "utf8")).toBe("unparseable source");
  });
  it("reports backed-up fallback truthfully when no template exists", () => {
    invalidConfig(false);
    expect(checkConfigYaml({ agentDir })?.fixed).toBe(true);
    expect(fs.existsSync(path.join(agentDir, "config.yaml"))).toBe(false);
    expect(fs.readdirSync(agentDir).filter(file => file.includes(".bak-"))).toHaveLength(1);
  });
  it("allows a genuinely absent config", () => {
    expect(checkConfigYaml({ agentDir })).toBeUndefined();
  });
});

describe("facts database recovery", () => {
  it("closes a failed query before moving a complete main/WAL/SHM set", async () => {
    const dbPath = corruptDatabase();
    const rename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((source, target) => {
      expect(database.closed).toBe(true);
      return rename(source, target);
    });
    expect((await checkFactsDb({ agentDir, log: () => {} }))?.fixed).toBe(true);
    const files = fs.readdirSync(path.dirname(dbPath));
    expect(files).toHaveLength(3);
    const main = files.find(file => !file.endsWith("-wal") && !file.endsWith("-shm"));
    expect(main).toBeDefined();
    for (const ext of ["", "-wal", "-shm"]) {
      expect(fs.existsSync(dbPath + ext)).toBe(false);
      expect(fs.readFileSync(path.join(path.dirname(dbPath), main! + ext), "utf8")).toBe("retained " + (ext || "main"));
    }
  });
  it("rolls back sidecars if the main file cannot be moved, retaining all originals", async () => {
    const dbPath = corruptDatabase();
    const rename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((source, target) => {
      if (String(source) === dbPath) throw ioError();
      return rename(source, target);
    });
    const log = vi.fn();
    await expect(checkFactsDb({ agentDir, log })).rejects.toThrow("injected");
    expect(log).not.toHaveBeenCalled();
    for (const ext of ["", "-wal", "-shm"]) expect(fs.readFileSync(dbPath + ext, "utf8")).toBe("retained " + (ext || "main"));
    expect(fs.readdirSync(path.dirname(dbPath))).toHaveLength(3);
  });
  it("stops and restores an earlier sidecar if a later sidecar move fails", async () => {
    const dbPath = corruptDatabase();
    const rename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((source, target) => {
      if (String(source) === dbPath + "-shm") throw ioError();
      return rename(source, target);
    });
    await expect(checkFactsDb({ agentDir })).rejects.toThrow("injected");
    for (const ext of ["", "-wal", "-shm"]) expect(fs.existsSync(dbPath + ext)).toBe(true);
  });
  it("does not back up a transient database error", async () => {
    const dbPath = corruptDatabase();
    database.queryError = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    const rename = vi.spyOn(fs, "renameSync");
    await expect(checkFactsDb({ agentDir })).rejects.toThrow("locked");
    expect(database.closed).toBe(true);
    expect(rename).not.toHaveBeenCalled();
    expect(fs.existsSync(dbPath)).toBe(true);
  });
  it("does not move an open database when closing fails", async () => {
    corruptDatabase();
    database.closeError = ioError();
    const rename = vi.spyOn(fs, "renameSync");
    await expect(checkFactsDb({ agentDir })).rejects.toThrow("injected");
    expect(rename).not.toHaveBeenCalled();
  });
  it("prevents initialization after a failed rollback instead of hiding the incomplete set", async () => {
    const dbPath = corruptDatabase();
    const rename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((source, target) => {
      if (String(source) === dbPath || String(source).includes(".bak-")) throw ioError();
      return rename(source, target);
    });
    await expect(runCompatChecks({ agentDir, hanakoHome: path.join(tempRoot, "home"), log: () => {} }))
      .rejects.toBeInstanceOf(IncompleteCompatRecoveryError);
    expect(fs.readFileSync(dbPath, "utf8")).toBe("retained main");
    expect(fs.readdirSync(path.dirname(dbPath)).filter(file => file.includes(".bak-"))).toHaveLength(2);
  });

  it.each(["corrupt", "healthy", "missing"])("keeps incomplete backups blocked across a retry with a %s live database", async (state) => {
    const dbPath = corruptDatabase();
    const rename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((source, target) => {
      if (String(source) === dbPath || String(source).includes(".bak-")) throw ioError();
      return rename(source, target);
    });
    await expect(runCompatChecks({ agentDir, hanakoHome: path.join(tempRoot, "home"), log: () => {} }))
      .rejects.toBeInstanceOf(IncompleteCompatRecoveryError);
    vi.restoreAllMocks();
    if (state === "healthy") database.queryError = null;
    if (state === "missing") fs.unlinkSync(dbPath);
    database.closed = false;
    const backupFiles = fs.readdirSync(path.dirname(dbPath));
    await expect(runCompatChecks({ agentDir, hanakoHome: path.join(tempRoot, "home"), log: () => {} }))
      .rejects.toBeInstanceOf(IncompleteCompatRecoveryError);
    expect(database.closed).toBe(false);
    expect(fs.readdirSync(path.dirname(dbPath))).toEqual(backupFiles);

    // Explicitly restore the retained set, as required by the recovery error.
    for (const file of backupFiles.filter(name => name.includes(".bak-"))) {
      const ext = file.endsWith("-wal") ? "-wal" : "-shm";
      fs.renameSync(path.join(path.dirname(dbPath), file), dbPath + ext);
    }
    if (state === "missing") fs.writeFileSync(dbPath, "retained main");
    database.queryError = Object.assign(new Error("file is not a database"), { code: "SQLITE_NOTADB" });
    expect((await checkFactsDb({ agentDir, log: () => {} }))?.fixed).toBe(true);
    const completed = fs.readdirSync(path.dirname(dbPath)).filter(file => file.includes(".bak-"));
    const main = completed.find(file => !file.endsWith("-wal") && !file.endsWith("-shm"));
    expect(completed).toHaveLength(3);
    expect(completed).toEqual(expect.arrayContaining([main, main + "-wal", main + "-shm"]));
    // A complete historic backup is not an unfinished recovery.
    await expect(checkFactsDb({ agentDir })).resolves.toBeUndefined();
  });

  it.each(["rolled-back", "busy", "close"])("keeps ordinary %s failures nonfatal at the compat runner", async (failureKind) => {
    const dbPath = corruptDatabase();
    if (failureKind === "busy") database.queryError = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    if (failureKind === "close") database.closeError = ioError();
    if (failureKind === "rolled-back") {
      const rename = fs.renameSync;
      vi.spyOn(fs, "renameSync").mockImplementation((source, target) => {
        if (String(source) === dbPath) throw ioError();
        return rename(source, target);
      });
    }
    await expect(runCompatChecks({ agentDir, hanakoHome: path.join(tempRoot, "home"), log: () => {} })).resolves.toBeUndefined();
    for (const ext of ["", "-wal", "-shm"]) expect(fs.existsSync(dbPath + ext)).toBe(true);
  });
});
