import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../core/llm-client.ts", () => ({ callText: vi.fn() }));
vi.mock("../lib/i18n.ts", () => ({ getLocale: () => "en" }));

import { callText } from "../core/llm-client.ts";
import { SessionSummaryManager } from "../lib/memory/session-summary.ts";
import {
  clearCompiledMemoryArtifacts,
  clearCompiledSummarySources,
  readCompiledResetAt,
  writeCompiledResetMarker,
} from "../lib/memory/compiled-memory-state.ts";
import { readCompiledMemorySnapshot } from "../lib/memory/compiled-memory-snapshot.ts";
import { readCurrentSessionBranch } from "../lib/session-jsonl.ts";

const MODEL = { model: "mock-model", api: "openai-completions", api_key: "mock-key", base_url: "https://mock.invalid" };
const STORY = { version: 1 as const, agentId: "a", realm: "story" as const, worldId: "world", branchId: "main", knowledge: "shared" as const };
const MALFORMED = "STALE_DRAFT_MARKER without required section headings";
const summary = (text: string) => `### Key Facts\n- ${text}\n\n### Timeline\n- 2026-10-01: ${text}`;
const STALE_REPAIR = summary("STALE_REPAIR_MARKER");
const FRESH = summary("FRESH_SUMMARY_MARKER");
const llm = vi.mocked(callText);
const roots: string[] = [];

function deferred() {
  let resolve!: (text: string) => void;
  const promise = new Promise<string>((release) => { resolve = release; });
  return { promise, resolve };
}

function entry(id: string, parentId: string | null, text: string, second = 1) {
  return { type: "message", id, parentId, timestamp: `2026-10-01T10:00:${String(second).padStart(2, "0")}.000Z`, message: { role: "user", content: text } };
}

function fixture(scoped = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-summary-lifecycle-"));
  roots.push(root);
  const sessionPath = path.join(root, "session.jsonl");
  const summariesDir = path.join(root, "summaries");
  const memoryScope = scoped ? STORY : undefined;
  fs.writeFileSync(sessionPath, [
    { type: "session", version: 3, id: "session", timestamp: "2026-10-01T10:00:00.000Z", cwd: root },
    entry("u1", null, "Original source"),
  ].map((value) => JSON.stringify(value)).join("\n") + "\n");
  const reopen = () => new SessionSummaryManager(summariesDir, { agentId: "a" });
  const manager = reopen();
  const append = (value: ReturnType<typeof entry>) => fs.appendFileSync(sessionPath, JSON.stringify(value) + "\n");
  const read = () => readCurrentSessionBranch(sessionPath, { since: readCompiledResetAt(root) });
  const run = (reader = manager) => {
    const projection = read();
    return reader.rollingSummary("session", projection.messages, MODEL, {
      projection, revalidateProjection: read, memoryScope, returnResult: true,
    });
  };
  return { root, summariesDir, memoryScope, manager, append, read, run, reopen };
}

type Fixture = ReturnType<typeof fixture>;
const invalidations = [
  { name: "reset", reason: "reset_watermark", scoped: false, invalidate(f: Fixture) {
    // Same durable operations as DELETE /memories/compiled.
    writeCompiledResetMarker(f.root, "2026-10-01T10:00:02.000Z");
    clearCompiledMemoryArtifacts(f.root);
    clearCompiledSummarySources(f.summariesDir, f.manager);
    f.append(entry("u2", "u1", "Post-reset source", 3));
  } },
  { name: "sibling branch", reason: "branch_changed", scoped: false, invalidate(f: Fixture) {
    f.append(entry("sibling", null, "Replacement branch", 3));
    f.manager.invalidateSession("session");
  } },
  { name: "scoped source", reason: "source_changed", scoped: true, invalidate(f: Fixture) {
    f.manager.invalidateSession("session");
  } },
];

beforeEach(() => { llm.mockReset(); });
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function expectNoStaleState(f: Fixture) {
  expect(f.manager.getSummary("session")).toBeNull();
  expect(fs.readdirSync(f.summariesDir)).toEqual([]);
  const reopened = f.reopen();
  expect(reopened.getSummary("session")).toBeNull();
  expect(reopened.getAllSummaries()).toEqual([]);
  expect(reopened.scopedDerivationStore.listArtifacts(f.memoryScope)).toEqual([]);
  expect(JSON.stringify(readCompiledMemorySnapshot(f.root, { memoryScope: f.memoryScope, agentId: "a" }))).not.toMatch(/STALE_/);
  return reopened;
}

async function expectCleanNextPrompt(f: Fixture, reopened: SessionSummaryManager) {
  llm.mockResolvedValueOnce(FRESH);
  const next = await f.run(reopened);
  const request = llm.mock.calls.at(-1)[0];
  expect(JSON.stringify(request)).not.toMatch(/STALE_/);
  expect(next).toMatchObject({ changed: true, summary: FRESH });
  expect(f.reopen().getSummary("session").summary).toBe(FRESH);
}

describe("rolling summary lifecycle around format repair", () => {
  it.each(invalidations)("skips repair after $name while the initial request is pending", async (scenario) => {
    const f = fixture(scenario.scoped);
    const initial = deferred();
    llm.mockImplementationOnce(() => initial.promise).mockResolvedValue(STALE_REPAIR);

    const pending = f.run();
    expect(llm).toHaveBeenCalledOnce();
    scenario.invalidate(f);
    initial.resolve(MALFORMED);
    const result = await pending;
    const callsBeforeNextRun = llm.mock.calls.length;

    expect(result).toMatchObject({ changed: false, data: null, reason: scenario.reason });
    const reopened = expectNoStaleState(f);
    await expectCleanNextPrompt(f, reopened);
    // Keep this last so a baseline failure still verifies persistence and reuse.
    expect(callsBeforeNextRun).toBe(1);
  });

  it.each(invalidations)("retains the final fence after $name while repair is pending", async (scenario) => {
    const f = fixture(scenario.scoped);
    const repair = deferred();
    llm.mockResolvedValueOnce(MALFORMED).mockImplementationOnce(() => repair.promise);

    const pending = f.run();
    await vi.waitFor(() => expect(llm).toHaveBeenCalledTimes(2));
    scenario.invalidate(f);
    repair.resolve(STALE_REPAIR);
    const result = await pending;

    expect(result).toMatchObject({ changed: false, data: null, reason: scenario.reason });
    const reopened = expectNoStaleState(f);
    await expectCleanNextPrompt(f, reopened);
  });

  it.each([false, true])("repairs a current malformed draft and persists it across reopen (scoped=%s)", async (scoped) => {
    const f = fixture(scoped);
    const initial = deferred();
    llm.mockImplementationOnce(() => initial.promise).mockResolvedValueOnce(FRESH);
    const pending = f.run();
    initial.resolve(MALFORMED);
    const result = await pending;

    expect(result).toMatchObject({ changed: true, summary: FRESH });
    expect(llm).toHaveBeenCalledTimes(2);
    expect(llm.mock.calls[1][0].usageContext).toMatchObject({ source: { operation: "rolling_summary_repair" } });
    expect(JSON.stringify(llm.mock.calls[1][0].messages)).toContain(MALFORMED);
    expect(f.reopen().getSummary("session").summary).toBe(FRESH);
  });

  it.each([MALFORMED, FRESH])("returns an empty string after scoped invalidation with an existing summary (output=%s)", async (output) => {
    const f = fixture(true);
    llm.mockResolvedValueOnce(summary("STALE_PREVIOUS_SUMMARY_MARKER"));
    await f.run();
    f.append(entry("u2", "u1", "New source", 3));
    const projection = f.read();
    const initial = deferred();
    llm.mockReset().mockImplementationOnce(() => initial.promise).mockResolvedValueOnce(FRESH);

    // Exercise the default string API, not just the structured result path.
    const pending = f.manager.rollingSummary("session", projection.messages, MODEL, {
      projection, revalidateProjection: f.read, memoryScope: STORY,
    });
    expect(llm).toHaveBeenCalledOnce();
    f.manager.invalidateSession("session");
    initial.resolve(output);

    expect(await pending).toBe("");
    expect(llm).toHaveBeenCalledOnce();
    expectNoStaleState(f);
  });

  it.each([false, true])("accepts an in-flight same-branch append and leaves its delta for the next run (scoped=%s)", async (scoped) => {
    const f = fixture(scoped);
    const original = f.read();
    const initial = deferred();
    llm.mockImplementationOnce(() => initial.promise).mockResolvedValueOnce(FRESH);
    const pending = f.run();
    f.append(entry("u2", "u1", "APPENDED_DELTA_MARKER", 3));
    initial.resolve(MALFORMED);
    const result = await pending;

    expect(result).toMatchObject({ changed: true, data: { cursor: { coveredLeafId: "u1", lineageHash: original.lineageHash } } });
    expect(llm).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(llm.mock.calls[1][0].messages)).not.toContain("APPENDED_DELTA_MARKER");
    const reopened = f.reopen();
    llm.mockResolvedValueOnce(FRESH);
    const next = await f.run(reopened);
    expect(next.mode).toBe("append");
    expect(JSON.stringify(llm.mock.calls[2][0].messages)).toContain("APPENDED_DELTA_MARKER");
    expect(JSON.stringify(llm.mock.calls[2][0].messages)).not.toContain("Original source");
    expect(f.reopen().getSummary("session").cursor.coveredLeafId).toBe("u2");
  });
});
