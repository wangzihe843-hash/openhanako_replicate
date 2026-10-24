import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyDreamSections, createDreamRevision, recoverPendingDreamApply,
  restoreDreamRevision, snapshotDreamSections,
} from "../lib/memory/dream/revision-store.ts";
import { captureDreamFileJournal, publishDreamFileJournal } from "../lib/memory/dream/file-transaction.ts";
import { captureMemoryReset, writeCompiledResetMarker } from "../lib/memory/compiled-memory-state.ts";

vi.mock("../core/llm-client.ts", () => ({ callText: () => { throw new Error("No model allowed"); } }));

let root: string;
let memoryDir: string;
const file = (name: string) => path.join(memoryDir, name);
const pending = () => file("dream/pending-apply.json");

function write(target: string, body: string | Buffer) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, body);
}

function images() {
  const result: Record<string, string> = {};
  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(target);
      // Atomic-write scratch files are outside the existing byte/absence contract.
      else if (entry.name.endsWith(".tmp")) continue;
      else result[path.relative(root, target)] = fs.readFileSync(target).toString("base64");
    }
  };
  visit(root);
  return result;
}

function currentRevision() {
  const before = snapshotDreamSections(memoryDir, { strictReads: true });
  return createDreamRevision(memoryDir, { runId: "output-separation", trigger: "manual", before });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "dream-output-separation-"));
  memoryDir = path.join(root, "memory");
  for (const name of ["facts.md", "today.md", "week.md", "longterm.md", "daily/2026-10-24.md",
    "daily/2026-09-01.md", "daily/2026-09-01.md.fingerprint", "today-state.json",
    "editable-facts-state.json", "daily-state.json", "longterm.md.fingerprint", "dream/state.json",
    "summaries/owned.json", "reset-archive/retired-owned/today.md"]) write(file(name), `ORIGINAL:${name}\r\n\r\n`);
  write(file("memory.md"), Buffer.from([0xff, 0x00, 0x0d, 0x0a]));
  writeCompiledResetMarker(memoryDir, "2026-10-24T00:00:00.000Z");
});

afterEach(context => {
  vi.restoreAllMocks();
  if (context.task.result?.state === "fail") console.error(`Preserved output-separation fixture: ${root}`);
  else fs.rmSync(root, { recursive: true, force: true });
});

describe("Dream compiled output separation", () => {
  it.each([
    "facts.md", "longterm.md", "today.md", "week.md", "daily/2026-09-01.md",
    "daily/2099-01-01.md.fingerprint", "dream/pending-apply.json", "dream/pending-apply.json.tmp",
    "dream/state.json", "dream/revisions/future.json", "reset.json", "today-state.json",
    "editable-facts-state.json", "daily-state.json", "longterm.md.fingerprint",
    "summaries/owned.json", "reset-archive/retired-owned/today.md", "memory.md.tmp",
    "today.md.tmp", "nested/../week.md",
  ])("rejects apply output %s before journal or file writes", name => {
    const revision = currentRevision(); const before = images();
    const rename = vi.spyOn(fs, "renameSync");
    expect(() => applyDreamSections(memoryDir, {
      revision, next: { ...revision.before, facts: "ORGANIZED" }, memoryMdPath: `${memoryDir}/${name}`,
    })).toThrow(/overlap/);
    expect(rename).not.toHaveBeenCalled(); expect(images()).toEqual(before);
    expect(fs.existsSync(pending())).toBe(false);
  });

  it.each(["today.md", "daily/2099-01-01.md", "dream/pending-apply.json"])(
    "rejects restore output %s even when the selected revision is current", name => {
      const revision = currentRevision(); const before = images();
      expect(() => restoreDreamRevision(memoryDir, revision.revisionId, file(name))).toThrow(/overlap/);
      expect(images()).toEqual(before); expect(fs.existsSync(pending())).toBe(false);
    });

  it.each(["week.md", "daily/2026-09-01.md", "dream/pending-apply.json"])(
    "capture itself rejects output %s", name => {
      const before = images();
      expect(() => captureDreamFileJournal(memoryDir, { revisionId: "owned", operation: "dream",
        reset: captureMemoryReset(memoryDir), memoryMdPath: file(name) })).toThrow(/overlap/);
      expect(images()).toEqual(before);
    });

  it.each(["today.md", "week.md", "daily/2026-09-01.md", "dream/pending-apply.json",
    "dream/state.json", "reset.json", "today-state.json", "nested/../week.md"])(
    "v2 reader rejects conflicting output %s and preserves all evidence", name => {
      const journal = captureDreamFileJournal(memoryDir, { revisionId: "missing-revision", operation: "dream",
        reset: captureMemoryReset(memoryDir), memoryMdPath: file("memory.md") });
      journal.memoryMdPath = path.resolve(file(name));
      publishDreamFileJournal(pending(), journal);
      const before = images(); const bytes = fs.readFileSync(pending());
      const rename = vi.spyOn(fs, "renameSync"); const unlink = vi.spyOn(fs, "unlinkSync");
      expect(() => recoverPendingDreamApply(memoryDir, journal.memoryMdPath)).toThrow(/overlap/);
      expect(rename).not.toHaveBeenCalled(); expect(unlink).not.toHaveBeenCalled();
      expect(images()).toEqual(before); expect(fs.readFileSync(pending())).toEqual(bytes);
    });

  it.each(["memory.md", "custom/compiled.md", "custom/today.md", "../exports/aggregate.md"])(
    "keeps ordinary configurable output %s usable and exactly compensable", name => {
      const output = file(name); write(output, "RAW_OUTPUT\r\n\r\n");
      const revision = currentRevision(); const today = fs.readFileSync(file("today.md"));
      applyDreamSections(memoryDir, { revision, next: { ...revision.before, facts: "ORGANIZED" }, memoryMdPath: output });
      expect(fs.readFileSync(output, "utf8")).toContain("ORGANIZED");
      expect(fs.readFileSync(file("today.md"))).toEqual(today);
      const nextRevision = currentRevision(); const before = images(); const rename = fs.renameSync; let failed = false;
      vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
        if (!failed && String(to) === path.resolve(output)) { failed = true; throw new Error("synthetic output failure"); }
        return rename(from, to);
      });
      expect(() => applyDreamSections(memoryDir, { revision: nextRevision,
        next: { ...nextRevision.before, facts: "SECOND" }, memoryMdPath: output })).toThrow("synthetic output failure");
      expect(failed).toBe(true); expect(images()).toEqual(before); expect(fs.existsSync(pending())).toBe(false);
    });

  it.runIf(process.platform === "darwin" || process.platform === "win32")(
    "rejects platform case aliases of the owning directory and input name", () => {
      const revision = currentRevision(); const before = images();
      expect(() => applyDreamSections(memoryDir, { revision, next: { ...revision.before, facts: "ORGANIZED" },
        memoryMdPath: path.join(memoryDir.toUpperCase(), "TODAY.MD") })).toThrow(/overlap/);
      expect(images()).toEqual(before);
    });

  it("prevents the independent journal-alias double-failure setup before either write", () => {
    const revision = currentRevision(); const before = images(); const read = fs.readFileSync; const rename = fs.renameSync;
    let factsWrites = 0;
    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to) === file("facts.md") && ++factsWrites === 2) throw new Error("independent compensation EIO");
      return rename(from, to);
    });
    vi.spyOn(fs, "readFileSync").mockImplementation((...args: Parameters<typeof fs.readFileSync>) => {
      if (String(args[0]) === file("today.md") && fs.existsSync(pending())
        && !read(pending(), "utf8").startsWith("{")) throw new Error("independent after-assembly EIO");
      return read(...args);
    });
    expect(() => applyDreamSections(memoryDir, { revision, next: { ...revision.before, facts: "ORGANIZED" },
      memoryMdPath: pending() })).toThrow(/overlap/);
    expect(factsWrites).toBe(0); expect(renameSpy).not.toHaveBeenCalled();
    expect(images()).toEqual(before); expect(fs.existsSync(pending())).toBe(false);
  });
});
