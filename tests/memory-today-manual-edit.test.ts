import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../core/llm-client.ts", () => ({ callText: vi.fn() }));

import { callText } from "../core/llm-client.ts";
import { loadLocale } from "../lib/i18n.ts";
import { compileToday, writeTodaySection } from "../lib/memory/compile.ts";
import { clearCompiledMemoryArtifacts, writeCompiledResetMarker } from "../lib/memory/compiled-memory-state.ts";
import { SessionSummaryManager } from "../lib/memory/session-summary.ts";

const MODEL = { model: "synthetic", api: "openai-completions", api_key: "synthetic", base_url: "https://fixture.invalid" };
const DAY = "2026-10-21";
const OLD = `${DAY}T11:00:00.000Z`;
const NEXT = `${DAY}T12:00:00.000Z`;
const llm = vi.mocked(callText);
const roots: string[] = [];
const releases: (() => void)[] = [];
const jobs: Promise<unknown>[] = [];

function deferred() {
  let resolve!: (value: string) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
  releases.push(() => resolve("cleanup"));
  return { promise, resolve, reject };
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "today-manual-edit-"));
  roots.push(root);
  const memoryDir = path.join(root, "memory");
  fs.mkdirSync(memoryDir);
  const output = path.join(memoryDir, "today.md");
  const statePath = path.join(memoryDir, "today-state.json");
  fs.writeFileSync(output, "ORIGINAL_BASE\n");
  fs.writeFileSync(statePath, JSON.stringify({ schemaVersion: 1, logicalDate: DAY, lastCompiledSummaryUpdatedAt: OLD, updatedAt: OLD }) + "\n");
  const summariesDir = path.join(root, "summaries");
  const save = (updated = NEXT, day = DAY) => {
    new SessionSummaryManager(summariesDir).saveSummary("session-a", {
      session_id: "session-a", created_at: `${day}T10:00:00.000Z`, updated_at: updated,
      summary: `### Key Facts\n- none\n\n### Timeline\n- ${day} 12:00: RETRYABLE_DELTA`,
    });
  };
  save();
  const start = (file = output) => {
    // Cold source reader and real body/state publication; only callText is fake.
    const job = compileToday(new SessionSummaryManager(summariesDir), file, MODEL);
    jobs.push(job); void job.catch(() => {});
    return job;
  };
  const snapshot = () => ({ body: fs.readFileSync(output, "utf8"), state: fs.readFileSync(statePath, "utf8") });
  return { root, memoryDir, output, statePath, save, start, snapshot };
}

beforeEach(() => {
  loadLocale("en");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(`${DAY}T13:00:00.000Z`));
  llm.mockReset();
  llm.mockResolvedValue("RETRIED_WITH_MANUAL_BASE");
});

afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await Promise.allSettled(jobs.splice(0));
  vi.restoreAllMocks(); vi.useRealTimers();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

for (const [name, edits] of [
  ["different text", ["AUTHORITATIVE_USER_EDIT"]],
  ["same text", ["ORIGINAL_BASE"]],
  ["edit and revert", ["INTERMEDIATE", "ORIGINAL_BASE"]],
  ["empty", [""]],
  ["normalization to same text", ["## Today\n\nORIGINAL_BASE"]],
] as const) {
  it(`keeps the real saved body and exact watermark after a pending compile: ${name}`, async () => {
    const f = fixture(); const gate = deferred(); llm.mockReturnValueOnce(gate.promise);
    const work = f.start();
    expect(llm).toHaveBeenCalledOnce();
    expect(JSON.stringify(llm.mock.calls[0][0].messages)).toContain("ORIGINAL_BASE");
    const state = f.snapshot().state;
    for (const edit of edits) writeTodaySection(f.memoryDir, edit);
    const saved = f.snapshot();
    expect(saved.state).toBe(state);
    gate.resolve("STALE_COMPILE");
    expect({ result: await work, ...f.snapshot() }).toEqual({ result: "superseded", ...saved });
    expect(fs.readFileSync(path.join(f.memoryDir, "memory.md"), "utf8")).not.toContain("STALE_COMPILE");
    expect(await f.start()).toBe("compiled");
    const input = JSON.stringify(llm.mock.calls[1][0].messages);
    expect(input).toContain("RETRYABLE_DELTA");
    if (saved.body.trim()) expect(input).toContain(saved.body.trim());
    else expect(input).not.toContain("ORIGINAL_BASE");
    expect(JSON.parse(f.snapshot().state).lastCompiledSummaryUpdatedAt).toBe(NEXT);
    expect(f.snapshot().body).toBe("RETRIED_WITH_MANUAL_BASE");
  });
}

it("fences a resolved model result before the compile continuation runs", async () => {
  const f = fixture(); const gate = deferred(); llm.mockReturnValueOnce(gate.promise);
  const work = f.start(); gate.resolve("STALE_COMPILE");
  writeTodaySection(f.memoryDir, "SAVED_IN_SAME_TURN"); const saved = f.snapshot();
  expect(await work).toBe("superseded"); expect(f.snapshot()).toEqual(saved);
});

for (const order of [[0, 1], [1, 0]]) {
  it(`preserves ordinary compile completion order and matching watermarks: ${order}`, async () => {
    const f = fixture(); const gates = [deferred(), deferred()];
    llm.mockReturnValueOnce(gates[0].promise).mockReturnValueOnce(gates[1].promise);
    const first = f.start(); f.save(`${DAY}T12:30:00.000Z`); const second = f.start();
    const work = [first, second]; const watermarks = [NEXT, `${DAY}T12:30:00.000Z`];
    for (const i of order) {
      gates[i].resolve(`COMPILED_${i}`); expect(await work[i]).toBe("compiled");
      expect(f.snapshot().body).toBe(`COMPILED_${i}`);
      expect(JSON.parse(f.snapshot().state).lastCompiledSummaryUpdatedAt).toBe(watermarks[i]);
    }
  });
  it(`invalidates every pre-save compile without invalidating a post-save compile: ${order}`, async () => {
    const f = fixture(); const gates = [deferred(), deferred()];
    llm.mockReturnValueOnce(gates[0].promise).mockReturnValueOnce(gates[1].promise);
    const work = [f.start(), f.start()];
    writeTodaySection(f.memoryDir, "NEW_MANUAL_BASE");
    expect(await f.start()).toBe("compiled"); const fresh = f.snapshot();
    expect(JSON.stringify(llm.mock.calls[2][0].messages)).toContain("NEW_MANUAL_BASE");
    for (const i of order) {
      gates[i].resolve(`STALE_${i}`); expect(await work[i]).toBe("superseded"); expect(f.snapshot()).toEqual(fresh);
    }
  });
}

it("does not invalidate another memory directory", async () => {
  const a = fixture(); const b = fixture(); const ga = deferred(); const gb = deferred();
  llm.mockReturnValueOnce(ga.promise).mockReturnValueOnce(gb.promise);
  const wa = a.start(); const wb = b.start(); writeTodaySection(a.memoryDir, "ONLY_A");
  const saved = a.snapshot(); gb.resolve("B_COMPILED"); ga.resolve("A_STALE");
  expect(await wb).toBe("compiled"); expect(await wa).toBe("superseded");
  expect(a.snapshot()).toEqual(saved); expect(b.snapshot().body).toBe("B_COMPILED");
});

for (const alias of ["relative", "symlink-directory"]) {
  it(`matches the same target through a ${alias} alias`, async () => {
    const f = fixture(); const gate = deferred(); llm.mockReturnValueOnce(gate.promise);
    const link = path.join(f.root, "alias");
    if (alias === "symlink-directory") fs.symlinkSync(f.memoryDir, link, "dir");
    const output = alias === "relative" ? path.relative(process.cwd(), f.output) : path.join(link, "today.md");
    const work = f.start(output); writeTodaySection(f.memoryDir, "CANONICAL_SAVE"); const saved = f.snapshot();
    gate.resolve("STALE"); expect(await work).toBe("superseded"); expect(f.snapshot()).toEqual(saved);
  });
}

it("does not invalidate a valid compile when the manual body rename fails", async () => {
  const f = fixture(); const gate = deferred(); llm.mockReturnValueOnce(gate.promise); const work = f.start();
  const before = f.snapshot(); const rename = fs.renameSync;
  const spy = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (to === f.output) throw new Error("synthetic manual rename failure");
    return rename(from, to);
  });
  expect(() => writeTodaySection(f.memoryDir, "UNCOMMITTED_EDIT")).toThrow("synthetic manual rename failure");
  expect(f.snapshot()).toEqual(before); spy.mockRestore(); gate.resolve("VALID_COMPILE");
  expect(await work).toBe("compiled"); expect(f.snapshot().body).toBe("VALID_COMPILE");
});

it("protects the committed edit even if subsequent memory.md assembly fails", async () => {
  const f = fixture(); const gate = deferred(); llm.mockReturnValueOnce(gate.promise); const work = f.start();
  const rename = fs.renameSync;
  const spy = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (to === path.join(f.memoryDir, "memory.md")) throw new Error("synthetic assembly failure");
    return rename(from, to);
  });
  expect(() => writeTodaySection(f.memoryDir, "COMMITTED_BODY")).toThrow("synthetic assembly failure");
  const saved = f.snapshot(); expect(saved.body).toBe("COMMITTED_BODY\n"); spy.mockRestore();
  gate.resolve("STALE"); expect(await work).toBe("superseded"); expect(f.snapshot()).toEqual(saved);
});

it("retains manual bytes after a model failure and retries the unconsumed delta", async () => {
  const f = fixture(); const gate = deferred(); llm.mockReturnValueOnce(gate.promise); const work = f.start();
  writeTodaySection(f.memoryDir, "RETRY_BASE"); const saved = f.snapshot();
  const error = new Error("synthetic model failure"); gate.reject(error);
  await expect(work).rejects.toBe(error); expect(f.snapshot()).toEqual(saved);
  expect(await f.start()).toBe("compiled");
  expect(JSON.stringify(llm.mock.calls[1][0].messages)).toContain("RETRY_BASE");
  expect(JSON.stringify(llm.mock.calls[1][0].messages)).toContain("RETRYABLE_DELTA");
});

it("keeps reset fencing after a manual save and permits a fresh generation", async () => {
  const f = fixture(); const gate = deferred(); llm.mockReturnValueOnce(gate.promise); const work = f.start();
  writeTodaySection(f.memoryDir, "MANUAL_BEFORE_RESET");
  writeCompiledResetMarker(f.memoryDir, `${DAY}T12:01:00.000Z`); clearCompiledMemoryArtifacts(f.memoryDir);
  const files = fs.readdirSync(f.memoryDir).sort(); const resetSnapshot = f.snapshot();
  gate.resolve("STALE"); expect(await work).toBe("superseded");
  expect(fs.readdirSync(f.memoryDir).sort()).toEqual(files);
  expect(f.snapshot()).toEqual(resetSnapshot); expect(f.snapshot().body).toBe("");
  f.save(`${DAY}T12:30:00.000Z`); expect(await f.start()).toBe("compiled");
  expect(JSON.parse(f.snapshot().state).lastCompiledSummaryUpdatedAt).toBe(`${DAY}T12:30:00.000Z`);
});

it("does not tie the manual fence to a date that can change while a compile waits", async () => {
  const f = fixture(); const gate = deferred(); llm.mockReturnValueOnce(gate.promise); const work = f.start();
  vi.setSystemTime(new Date("2026-10-22T13:00:00.000Z"));
  writeTodaySection(f.memoryDir, "SAVED_AFTER_DAY_CHANGE"); const saved = f.snapshot();
  vi.setSystemTime(new Date(`${DAY}T13:00:00.000Z`));
  gate.resolve("YESTERDAY_RESULT"); expect(await work).toBe("superseded"); expect(f.snapshot()).toEqual(saved);
});

it("preserves the existing day rollover on the next compile after a superseded job", async () => {
  const f = fixture(); const gate = deferred(); llm.mockReturnValueOnce(gate.promise); const work = f.start();
  writeTodaySection(f.memoryDir, "YESTERDAY_MANUAL"); const saved = f.snapshot();
  vi.setSystemTime(new Date("2026-10-22T13:00:00.000Z")); gate.resolve("STALE");
  expect(await work).toBe("superseded"); expect(f.snapshot()).toEqual(saved);
  f.save("2026-10-22T12:00:00.000Z", "2026-10-22");
  expect(await f.start()).toBe("compiled");
  expect(JSON.stringify(llm.mock.calls[1][0].messages)).not.toContain("YESTERDAY_MANUAL");
  expect(JSON.parse(f.snapshot().state)).toMatchObject({logicalDate: "2026-10-22", lastCompiledSummaryUpdatedAt: "2026-10-22T12:00:00.000Z"});
});

it("preserves existing no-delta behavior after a successful manual save", async () => {
  const f = fixture(); await f.start(); writeTodaySection(f.memoryDir, "LATEST_MANUAL"); const saved = f.snapshot();
  expect(await f.start()).toBe("compiled"); expect(f.snapshot()).toEqual(saved); expect(llm).toHaveBeenCalledOnce();
});
