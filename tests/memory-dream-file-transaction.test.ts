import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyDreamSections, createDreamRevision, readDreamRevision,
  recoverPendingDreamApply, restoreDreamRevision, snapshotDreamSections,
} from "../lib/memory/dream/revision-store.ts";
import { captureMemoryReset, writeCompiledResetMarker } from "../lib/memory/compiled-memory-state.ts";
import { createMemoryDreamRunner } from "../lib/memory/dream/runner.ts";

// All mutations and cleanup belong to this test's mkdtemp directory.
vi.mock("../core/llm-client.ts", () => ({ callText: () => { throw new Error("No model allowed"); } }));

const oldDay = "daily/2026-10-17.md";
const currentDay = "daily/2026-10-18.md";
const steps = ["facts.md", "today.md", "longterm.md", oldDay, "week.md", "memory.md"];
const independent = [currentDay, "daily/2026-09-01.md", `${currentDay}.fingerprint`,
  "today-state.json", "editable-facts-state.json", "daily-state.json", "reset.json", "scoped-derivations.v1.json"];
let dir: string;

function write(name: string, value: string | Buffer) {
  const target = path.join(dir, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, value);
}

function image() {
  return Object.fromEntries([...steps, ...independent].map(name => {
    try { return [name, fs.readFileSync(path.join(dir, name)).toString("base64")]; }
    catch (error) { if (error?.code === "ENOENT") return [name, null]; throw error; }
  }));
}

function targetRevision() {
  return createDreamRevision(dir, {
    runId: "synthetic-target", trigger: "manual",
    before: { facts: "HISTORICAL_FACTS", today: "HISTORICAL_TODAY", longterm: "HISTORICAL_LONGTERM",
      weekDays: [{ date: "2026-10-17", body: "HISTORICAL_DAY" }] },
  });
}

function journalPath() { return path.join(dir, "dream/pending-apply.json"); }
function journal() { return JSON.parse(fs.readFileSync(journalPath(), "utf8")); }

function leavePreparedJournal(operation: "dream" | "restore" = "restore") {
  const revision = targetRevision();
  const rename = fs.renameSync;
  const spy = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
    rename(from, to);
    if (String(to) === journalPath()) throw new Error("synthetic stop after journal publication");
  });
  try {
    expect(() => operation === "restore" ? restoreDreamRevision(dir, revision.revisionId)
      : applyDreamSections(dir, { revision: { ...revision, before: snapshotDreamSections(dir) },
        next: { ...snapshotDreamSections(dir), facts: "DREAM_FACTS", longterm: "DREAM_LONGTERM" } }))
      .toThrow("synthetic stop after journal publication");
  } finally { spy.mockRestore(); }
  return revision;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-file-transaction-"));
  write("facts.md", "## Current Facts\r\n\r\nCURRENT_FACTS  \r\n");
  write("today.md", "CURRENT_TODAY\r\n\r\n");
  write("longterm.md", "  CURRENT_LONGTERM  \n\n");
  write("week.md", "## 2026-10-18\r\n\r\nCURRENT_DAY  \r\n");
  write("memory.md", Buffer.from([0x43, 0x55, 0x52, 0xff, 0x0d, 0x0a]));
  write(currentDay, "## 2026-10-18\r\n\r\nCURRENT_DAY  \r\n");
  write("daily/2026-09-01.md", "OLDER_PENDING_FOLD\n");
  for (const name of independent.slice(2).filter(name => name !== "reset.json")) write(name, `INDEPENDENT:${name}\n`);
});

afterEach(context => {
  vi.restoreAllMocks();
  if (context.task.result?.state === "fail") console.error(`Preserved failed synthetic fixture: ${dir}`);
  else fs.rmSync(dir, { recursive: true, force: true });
});

describe("Dream new file transactions", () => {
  it("runner preflight preserves absent Facts when model resolution fails before application", async () => {
    fs.unlinkSync(path.join(dir, "facts.md")); const before = image();
    const runner = createMemoryDreamRunner({ memoryDir: dir, memoryMdPath: path.join(dir, "memory.md"),
      getLogicalDate: () => "2026-10-24", getResolvedMemoryModel: async () => { throw new Error("synthetic stop before model"); } });
    runner.start(); await runner.stop();
    expect(runner.getStatus().lastRun?.error).toBe("synthetic stop before model");
    expect(image()).toEqual(before); expect(fs.existsSync(journalPath())).toBe(false);
  });

  it("runner preflight propagates read errors before resolving a model", async () => {
    const before = image(); const read = fs.readFileSync;
    const spy = vi.spyOn(fs, "readFileSync").mockImplementation((...args: Parameters<typeof fs.readFileSync>) => {
      if (String(args[0]) === path.join(dir, "facts.md")) throw Object.assign(new Error("synthetic runner read failure"), { code: "EIO" });
      return read(...args);
    });
    const resolver = vi.fn(async () => { throw new Error("must not resolve"); });
    const runner = createMemoryDreamRunner({ memoryDir: dir, memoryMdPath: path.join(dir, "memory.md"),
      getLogicalDate: () => "2026-10-24", getResolvedMemoryModel: resolver });
    runner.start(); await runner.stop(); spy.mockRestore();
    expect(runner.getStatus().lastRun?.error).toBe("synthetic runner read failure");
    expect(resolver).not.toHaveBeenCalled(); expect(image()).toEqual(before);
  });

  it.each(steps)("A regression: rollback preserves bytes and absence after %s fails", name => {
    const revision = targetRevision();
    const before = image();
    const rename = fs.renameSync;
    let failed = false;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (!failed && String(to) === path.join(dir, name)) { failed = true; throw new Error("synthetic write failure"); }
      return rename(from, to);
    });
    expect(() => restoreDreamRevision(dir, revision.revisionId)).toThrow("synthetic write failure");
    expect(failed).toBe(true);
    expect(image()).toEqual(before);
    expect(fs.existsSync(journalPath())).toBe(false);
  });

  it.each(["facts.md", "today.md", "longterm.md", "week.md", "memory.md"])(
    "A regression: rollback preserves an originally absent %s", name => {
      const revision = targetRevision();
      fs.unlinkSync(path.join(dir, name));
      const before = image();
      const rename = fs.renameSync;
      let failed = false;
      vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
        if (!failed && String(to) === path.join(dir, "memory.md")) { failed = true; throw new Error("synthetic write failure"); }
        return rename(from, to);
      });
      expect(() => restoreDreamRevision(dir, revision.revisionId)).toThrow("synthetic write failure");
      expect(image()).toEqual(before);
    });

  it.each(Array.from({ length: steps.length + 1 }, (_, index) => index))(
    "A regression: crash cut %i recovers exact files and repeated recovery is a no-op", cut => {
      const before = image();
      leavePreparedJournal();
      for (const name of steps.slice(0, cut)) write(name, `PARTIAL_TARGET:${name}\n`);
      expect(recoverPendingDreamApply(dir)).toBe(true);
      expect(image()).toEqual(before);
      expect(recoverPendingDreamApply(dir)).toBe(false);
      expect(image()).toEqual(before);
    });

  it("A regression: double failure retains evidence and permits exact retry", () => {
    const revision = targetRevision();
    const before = image();
    const rename = fs.renameSync;
    let factsWrites = 0;
    const spy = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to) === path.join(dir, "facts.md") && ++factsWrites === 2) throw new Error("synthetic rollback failure");
      if (String(to) === path.join(dir, "week.md")) throw new Error("synthetic apply failure");
      return rename(from, to);
    });
    expect(() => restoreDreamRevision(dir, revision.revisionId)).toThrow("rollback also failed");
    const pending = fs.readFileSync(journalPath());
    expect(pending.length).toBeGreaterThan(0);
    spy.mockRestore();
    expect(recoverPendingDreamApply(dir)).toBe(true);
    expect(image()).toEqual(before);
  });

  it.each([0, 1, 2, 3])("A regression: Dream crash cut %i only rolls back its own files", cut => {
    const before = image();
    leavePreparedJournal("dream");
    for (const name of ["facts.md", "longterm.md", "memory.md"].slice(0, cut)) write(name, `DREAM_PARTIAL:${name}\n`);
    expect(recoverPendingDreamApply(dir)).toBe(true);
    expect(image()).toEqual(before);
  });

  it.each(["facts.md", "longterm.md", "memory.md"])("A regression: failed Dream %s restores raw bytes without touching Today or daily", name => {
    const before = image(); const current = snapshotDreamSections(dir);
    const revision = createDreamRevision(dir, { runId: "synthetic-dream", trigger: "manual", before: current });
    const rename = fs.renameSync; let failed = false;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (!failed && String(to) === path.join(dir, name)) { failed = true; throw new Error("synthetic Dream failure"); }
      return rename(from, to);
    });
    expect(() => applyDreamSections(dir, { revision, next: { ...current, facts: "DREAM_FACTS", longterm: "DREAM_LONGTERM" } }))
      .toThrow("synthetic Dream failure");
    expect(image()).toEqual(before);
  });

  it("A regression: journal removal failure compensates and remains retryable", () => {
    const revision = targetRevision(); const before = image(); const remove = fs.rmSync; let failed = false;
    vi.spyOn(fs, "rmSync").mockImplementation((target, options) => {
      if (!failed && String(target) === journalPath()) { failed = true; throw new Error("synthetic journal removal failure"); }
      return remove(target, options);
    });
    expect(() => restoreDreamRevision(dir, revision.revisionId)).toThrow("synthetic journal removal failure");
    expect(image()).toEqual(before); expect(fs.existsSync(journalPath())).toBe(false);
    expect(recoverPendingDreamApply(dir)).toBe(false);
  });

  it.each(steps)("replays idempotently after recovery itself stops at %s", name => {
    const before = image(); leavePreparedJournal(); const pending = fs.readFileSync(journalPath());
    for (const file of steps) write(file, `PARTIAL:${file}`);
    const rename = fs.renameSync; const unlink = fs.unlinkSync;
    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      rename(from, to);
      if (String(to) === path.join(dir, name)) throw new Error("synthetic recovery stop");
    });
    const unlinkSpy = vi.spyOn(fs, "unlinkSync").mockImplementation(target => {
      unlink(target);
      if (String(target) === path.join(dir, name)) throw new Error("synthetic recovery stop");
    });
    expect(() => recoverPendingDreamApply(dir)).toThrow("synthetic recovery stop");
    expect(fs.readFileSync(journalPath())).toEqual(pending);
    renameSpy.mockRestore(); unlinkSpy.mockRestore();
    expect(recoverPendingDreamApply(dir)).toBe(true); expect(image()).toEqual(before);
  });

  it("binds and restores a caller-supplied compiled output without touching the default output", () => {
    const revision = targetRevision(); const before = image(); const output = path.join(dir, "custom/compiled.md");
    write("custom/compiled.md", "CUSTOM_RAW\r\n\r\n");
    const customBefore = fs.readFileSync(output); const rename = fs.renameSync;
    const spy = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      rename(from, to);
      if (String(to) === journalPath()) throw new Error("synthetic stop");
    });
    expect(() => restoreDreamRevision(dir, revision.revisionId, output)).toThrow("synthetic stop");
    spy.mockRestore(); write("custom/compiled.md", "PARTIAL_CUSTOM"); write(oldDay, "PARTIAL_DAY");
    expect(() => recoverPendingDreamApply(dir)).toThrow("invalid format");
    expect(fs.readFileSync(output, "utf8")).toBe("PARTIAL_CUSTOM"); expect(fs.existsSync(journalPath())).toBe(true);
    expect(recoverPendingDreamApply(dir, output)).toBe(true);
    expect(fs.readFileSync(output)).toEqual(customBefore); expect(image()).toEqual(before);
  });

  it("does not write bodies when journal publication fails", () => {
    const revision = targetRevision(); const before = image(); const rename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to) === journalPath()) throw new Error("synthetic journal failure");
      return rename(from, to);
    });
    expect(() => restoreDreamRevision(dir, revision.revisionId)).toThrow("synthetic journal failure");
    expect(image()).toEqual(before);
    expect(fs.existsSync(journalPath())).toBe(false);
  });

  it("does not write bodies or discard evidence when journal read-back fails", () => {
    const revision = targetRevision(); const before = image(); const rename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      rename(from, to);
      if (String(to) === journalPath()) fs.writeFileSync(journalPath(), "{synthetic corrupt journal");
    });
    expect(() => restoreDreamRevision(dir, revision.revisionId)).toThrow("journal write verification failed");
    expect(image()).toEqual(before);
    expect(fs.readFileSync(journalPath(), "utf8")).toBe("{synthetic corrupt journal");
  });

  it.each(["facts.md", "memory.md", currentDay])("propagates before-image/input read errors for %s", name => {
    const revision = targetRevision(); const before = image(); const read = fs.readFileSync;
    const spy = vi.spyOn(fs, "readFileSync").mockImplementation((...args: Parameters<typeof fs.readFileSync>) => {
      if (String(args[0]) === path.join(dir, name)) throw Object.assign(new Error("synthetic read failure"), { code: "EIO" });
      return read(...args);
    });
    expect(() => restoreDreamRevision(dir, revision.revisionId)).toThrow("synthetic read failure");
    spy.mockRestore(); expect(image()).toEqual(before); expect(fs.existsSync(journalPath())).toBe(false);
  });

  it("propagates daily listing errors before body writes", () => {
    const revision = targetRevision(); const before = image(); const readdir = fs.readdirSync;
    const spy = vi.spyOn(fs, "readdirSync").mockImplementation((...args: Parameters<typeof fs.readdirSync>) => {
      if (String(args[0]) === path.join(dir, "daily")) throw Object.assign(new Error("synthetic listing failure"), { code: "EIO" });
      return readdir(...args);
    });
    expect(() => restoreDreamRevision(dir, revision.revisionId)).toThrow("synthetic listing failure");
    spy.mockRestore(); expect(image()).toEqual(before);
  });

  it("rolls back a strict assembly read failure instead of treating it as empty", () => {
    const revision = targetRevision(); const before = image(); const read = fs.readFileSync; let count = 0;
    const spy = vi.spyOn(fs, "readFileSync").mockImplementation((...args: Parameters<typeof fs.readFileSync>) => {
      if (String(args[0]) === path.join(dir, currentDay) && ++count === 2) throw Object.assign(new Error("synthetic assembly read failure"), { code: "EIO" });
      return read(...args);
    });
    expect(() => restoreDreamRevision(dir, revision.revisionId)).toThrow("synthetic assembly read failure");
    spy.mockRestore(); expect(image()).toEqual(before); expect(fs.existsSync(journalPath())).toBe(false);
  });

  it("verifies writes and compensates a silently missing file replacement", () => {
    const revision = targetRevision(); const before = image(); const rename = fs.renameSync; let dropped = false;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (!dropped && String(to) === path.join(dir, "facts.md")) { dropped = true; return; }
      return rename(from, to);
    });
    expect(() => restoreDreamRevision(dir, revision.revisionId)).toThrow("Dream write verification failed: facts.md");
    expect(image()).toEqual(before); expect(fs.existsSync(journalPath())).toBe(false);
  });

  it("verifies compensation and retains the journal when restored bytes differ", () => {
    const revision = targetRevision(); const before = image(); const rename = fs.renameSync; let factsWrites = 0;
    const spy = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to) === path.join(dir, "week.md")) throw new Error("synthetic apply failure");
      rename(from, to);
      if (String(to) === path.join(dir, "facts.md") && ++factsWrites === 2) write("facts.md", "SYNTHETIC_BAD_ROLLBACK");
    });
    expect(() => restoreDreamRevision(dir, revision.revisionId)).toThrow("rollback verification failed: facts.md");
    expect(fs.existsSync(journalPath())).toBe(true);
    spy.mockRestore(); expect(recoverPendingDreamApply(dir)).toBe(true); expect(image()).toEqual(before);
  });

  it("keeps an unfinished journal intact and never prunes its evidence to start another operation", () => {
    const target = leavePreparedJournal(); const pending = fs.readFileSync(journalPath()); const before = image();
    expect(() => restoreDreamRevision(dir, target.revisionId)).toThrow("pending journal must be recovered");
    const current = snapshotDreamSections(dir);
    expect(() => applyDreamSections(dir, { revision: { ...target, before: current }, next: { ...current, facts: "NEW" } }))
      .toThrow("pending journal must be recovered");
    expect(fs.readFileSync(journalPath())).toEqual(pending); expect(image()).toEqual(before);
  });

  it("recovers without the referenced historical or safety revision", () => {
    const before = image(); const target = leavePreparedJournal(); const pending = journal();
    for (const id of [target.revisionId, pending.revisionId]) fs.unlinkSync(path.join(dir, "dream/revisions", `${id}.json`));
    write(oldDay, "PARTIAL_CREATED_DAY");
    expect(recoverPendingDreamApply(dir)).toBe(true); expect(image()).toEqual(before);
  });

  it.each(["hash", "missing-file", "duplicate", "path", "base64", "output"])("rejects a malformed new journal (%s) without changing bodies", kind => {
    leavePreparedJournal(); const pending = journal(); const before = image();
    expect(pending.schemaVersion).toBe(2);
    if (kind === "hash") pending.beforeHash = "bad";
    if (kind === "missing-file") pending.beforeFiles.pop();
    if (kind === "duplicate") pending.beforeFiles.push(pending.beforeFiles[0]);
    if (kind === "path") pending.beforeFiles[0].name = "../outside.md";
    if (kind === "base64") pending.beforeFiles[0].base64 = "not base64!";
    if (kind === "output") pending.memoryMdPath = path.join(dir, "wrong-output.md");
    write("dream/pending-apply.json", JSON.stringify(pending)); const bytes = fs.readFileSync(journalPath());
    expect(() => recoverPendingDreamApply(dir)).toThrow("invalid format");
    expect(image()).toEqual(before); expect(fs.readFileSync(journalPath())).toEqual(bytes);
  });

  it("keeps new stale-reset journal bytes in the existing retirement archive", () => {
    leavePreparedJournal(); const bytes = fs.readFileSync(journalPath());
    writeCompiledResetMarker(dir, "2026-10-24T00:00:00.000Z"); const before = image();
    expect(recoverPendingDreamApply(dir)).toBe(false); expect(image()).toEqual(before);
    const archive = fs.readdirSync(path.join(dir, "reset-archive"))[0];
    expect(fs.readFileSync(path.join(dir, "reset-archive", archive, "dream/pending-apply.json"))).toEqual(bytes);
  });

  it("retains legacy v1 recovery semantics without inventing file absence", () => {
    const revision = targetRevision();
    write("dream/pending-apply.json", JSON.stringify({ schemaVersion: 1, revisionId: revision.revisionId,
      operation: "restore", reset: captureMemoryReset(dir) }));
    expect(recoverPendingDreamApply(dir)).toBe(true);
    expect(fs.existsSync(path.join(dir, currentDay))).toBe(true);
    expect(fs.existsSync(path.join(dir, oldDay))).toBe(true);
  });

  it("keeps revision v1 and successful restore's historical collection behavior", () => {
    const revision = targetRevision(); const before = image();
    expect(readDreamRevision(dir, revision.revisionId).schemaVersion).toBe(1);
    restoreDreamRevision(dir, revision.revisionId);
    const after = image();
    for (const name of independent) expect(after[name]).toBe(before[name]);
    expect(fs.existsSync(path.join(dir, oldDay))).toBe(true);
    expect(snapshotDreamSections(dir).weekDays.map(entry => entry.date)).toContain("2026-10-18");
  });
});
