import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("../core/llm-client.ts", () => ({ callText: vi.fn() }));
import { callText } from "../core/llm-client.ts";
import { FactStore } from "../lib/memory/fact-store.ts";
import { SessionSummaryManager } from "../lib/memory/session-summary.ts";
import { processDirtySessions } from "../lib/memory/deep-memory.ts";

const dirs: string[] = [], stores: FactStore[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) { if (store.db.open) store.close(); }
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const model = { model: "test", api: "openai-completions", api_key: "unused", base_url: "http://unused.invalid" };
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deep-memory-commit-")); dirs.push(dir);
  const db = path.join(dir, "facts.db"), summaries = path.join(dir, "summaries");
  const manager = new SessionSummaryManager(summaries), store = new FactStore(db); stores.push(store);
  manager.saveSummary("s1", { session_id: "s1", summary: "First summary", snapshot: "", updated_at: "2026-09-09T00:00:00Z" });
  vi.mocked(callText).mockReset().mockResolvedValue(JSON.stringify([{ fact: "Tea preference", tags: ["preference"] }]));
  return { dir, db, summaries, manager, store };
}
it("B03 retries after marker write failure and restart without duplicating a committed revision", async () => {
  const f = fixture();
  f.store.add({ fact: "Tea preference", tags: [], session_id: "s2" });
  const rename = fs.renameSync;
  const failure = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (String(to).endsWith(path.join("summaries", "s1.json"))) throw new Error("marker rename failed");
    return rename(from, to);
  });
  await processDirtySessions(f.manager, f.store, model);
  expect(f.store.getBySession("s1")).toHaveLength(1);
  expect(f.manager.getDirtySessions()).toHaveLength(1);
  failure.mockRestore();
  f.store.close();
  const reopened = new FactStore(f.db); stores.push(reopened);
  const manager = new SessionSummaryManager(f.summaries);
  vi.mocked(callText).mockRejectedValue(new Error("retry must not call the model"));
  await processDirtySessions(manager, reopened, model);
  expect(reopened.getBySession("s1")).toHaveLength(1);
  expect(reopened.getBySession("s2")).toHaveLength(1);
  expect(manager.getDirtySessions()).toHaveLength(0);
  expect(callText).toHaveBeenCalledTimes(1);
});

it("B03 continues from the committed summary when it advances before JSON acknowledgement", async () => {
  const f = fixture();
  const marker = vi.spyOn(f.manager, "markProcessedIfCurrent").mockImplementationOnce(() => { throw new Error("marker failed"); });
  await processDirtySessions(f.manager, f.store, model);
  marker.mockRestore();
  f.manager.saveSummary("s1", {
    ...f.manager.getSummary("s1"), summary: "New source content", updated_at: "2026-09-10T00:00:00Z",
  });
  vi.mocked(callText).mockImplementationOnce(async (request: any) => {
    expect(request.messages[0].content).toContain("First summary");
    expect(request.messages[0].content).toContain("New source content");
    return JSON.stringify([{ fact: "A second source fact", tags: [] }]);
  });
  await processDirtySessions(f.manager, f.store, model);
  expect(f.store.getBySession("s1").map(fact => fact.fact).sort()).toEqual(["A second source fact", "Tea preference"]);
  expect(f.manager.getSummary("s1").snapshot).toBe("New source content");
});

it("B03 rolls facts and receipt back together and never skips repeated commit failures", async () => {
  const f = fixture();
  f.store.db.exec("CREATE TRIGGER reject_commit BEFORE INSERT ON session_fact_commits BEGIN SELECT RAISE(ABORT, 'receipt failed'); END;");
  for (let attempt = 0; attempt < 4; attempt++) {
    await processDirtySessions(f.manager, f.store, model);
    expect(f.store.size).toBe(0);
    expect(f.store.getSessionCommitRevision("s1")).toBeNull();
    expect(f.manager.getDirtySessions()).toHaveLength(1);
  }
  f.store.db.exec("DROP TRIGGER reject_commit");
  await processDirtySessions(f.manager, f.store, model);
  expect(f.store.size).toBe(1);
  expect(f.manager.getDirtySessions()).toHaveLength(0);
});

it("B03 preserves branch replacement rollback, retry IDs, FTS and other fact sources", async () => {
  const f = fixture();
  await processDirtySessions(f.manager, f.store, model);
  f.store.add({ fact: "Tea preference", tags: [], session_id: "s2" });
  const originalRevision = f.store.getSessionCommitRevision("s1");
  f.manager.saveSummary("s1", {
    ...f.manager.getSummary("s1"), summary: "Sibling branch", factReplacementRequired: true,
    cursor: { coveredLeafId: "b", lineageHash: "branch-b" }, updated_at: "2026-09-10T00:00:00Z",
  });
  const options = { getCurrentBranchProjection: () => ({ rootLineageHash: "root", prefixHashes: { b: "branch-b" } }) };
  vi.mocked(callText).mockResolvedValue(JSON.stringify([{ fact: "Siblingfact", tags: [] }]));
  f.store.db.exec("CREATE TRIGGER reject_commit BEFORE INSERT ON session_fact_commits BEGIN SELECT RAISE(ABORT, 'receipt failed'); END;");
  await processDirtySessions(f.manager, f.store, model, options);
  expect(f.store.getBySession("s1").map(f => f.fact)).toEqual(["Tea preference"]);
  expect(f.store.getSessionCommitRevision("s1")).toBe(originalRevision);
  f.store.db.exec("DROP TRIGGER reject_commit");
  const marker = vi.spyOn(f.manager, "markProcessedIfCurrent").mockImplementationOnce(() => { throw new Error("marker failed"); });
  await processDirtySessions(f.manager, f.store, model, options);
  const committed = f.store.getBySession("s1");
  expect(committed.map(f => f.fact)).toEqual(["Siblingfact"]);
  marker.mockRestore();
  await processDirtySessions(f.manager, f.store, model, options);
  expect(f.store.getBySession("s1")).toEqual(committed);
  expect(f.store.getBySession("s2")).toHaveLength(1);
  expect(f.store.searchFullText("Siblingfact", 10)).toHaveLength(1);
  expect(f.manager.getDirtySessions()).toHaveLength(0);
});

it("B03 commits empty branch replacements and resets receipts on explicit invalidation", async () => {
  const f = fixture();
  await processDirtySessions(f.manager, f.store, model);
  f.manager.saveSummary("s1", {
    ...f.manager.getSummary("s1"), summary: "", factReplacementRequired: true,
    cursor: { coveredLeafId: "b", lineageHash: "branch-b" }, updated_at: "2026-09-10T00:00:00Z",
  });
  const calls = vi.mocked(callText).mock.calls.length;
  await processDirtySessions(f.manager, f.store, model, {
    getCurrentBranchProjection: () => ({ rootLineageHash: "root", prefixHashes: { b: "branch-b" } }),
  });
  expect(f.store.getBySession("s1")).toEqual([]);
  expect(callText).toHaveBeenCalledTimes(calls);
  expect(f.store.getSessionCommitRevision("s1")).not.toBeNull();
  f.store.deleteBySession("s1");
  expect(f.store.getSessionCommitRevision("s1")).toBeNull();
  f.store.commitSessionRevision("s1", "revision-a", [{ fact: "Restored fact", tags: [] }]);
  f.store.replaceBySession("s1", []);
  expect(f.store.getSessionCommitRevision("s1")).toBeNull();
  f.store.commitSessionRevision("s1", "revision-b", [{ fact: "Restored fact", tags: [] }]);
  f.store.clearAll();
  expect(f.store.getSessionCommitRevision("s1")).toBeNull();
});

it("B03 keeps the summary dirty when a fact transaction fails, then retries", async () => {
  const f = fixture();
  const failedInsert = vi.spyOn(f.store, "add").mockImplementationOnce(() => { throw new Error("insert failed"); });
  await processDirtySessions(f.manager, f.store, model);
  expect(f.store.size).toBe(0);
  expect(f.manager.getDirtySessions()).toHaveLength(1);
  failedInsert.mockRestore();
  await processDirtySessions(f.manager, f.store, model);
  expect(f.store.getBySession("s1")).toHaveLength(1);
  expect(f.manager.getDirtySessions()).toHaveLength(0);
});


it("B03 does not count repeated DB failures toward the next extraction failure", async () => {
  const f = fixture();
  const insert = vi.spyOn(f.store, "add").mockImplementation(() => { throw new Error("DB unavailable"); });
  for (let attempt = 0; attempt < 3; attempt++) await processDirtySessions(f.manager, f.store, model);
  insert.mockRestore();
  vi.mocked(callText).mockResolvedValueOnce("not JSON");
  await processDirtySessions(f.manager, f.store, model);
  expect(f.store.size).toBe(0);
  expect(f.manager.getDirtySessions()).toHaveLength(1);
  expect(f.manager.getSummary("s1").snapshot).toBe("");
  await processDirtySessions(f.manager, f.store, model);
  expect(f.store.size).toBe(1);
  expect(f.manager.getDirtySessions()).toHaveLength(0);
});

it("B03 does not count repeated ack failures toward a newer summary's first extraction failure", async () => {
  const f = fixture();
  const ack = vi.spyOn(f.manager, "markProcessedIfCurrent").mockImplementation(() => { throw new Error("ack unavailable"); });
  for (let attempt = 0; attempt < 3; attempt++) await processDirtySessions(f.manager, f.store, model);
  expect(f.store.size).toBe(1);
  ack.mockRestore();
  f.manager.saveSummary("s1", {
    ...f.manager.getSummary("s1"), summary: "New uncommitted content", updated_at: "2026-09-11T00:00:00Z",
  });
  vi.mocked(callText).mockResolvedValueOnce("not JSON");
  await processDirtySessions(f.manager, f.store, model);
  expect(f.manager.getDirtySessions()).toHaveLength(1);
  expect(f.manager.getSummary("s1").snapshot).toBe("");
  vi.mocked(callText).mockResolvedValueOnce(JSON.stringify([{ fact: "New fact after recovery", tags: [] }]));
  await processDirtySessions(f.manager, f.store, model);
  expect(f.store.getBySession("s1").map(fact => fact.fact).sort()).toEqual(["New fact after recovery", "Tea preference"]);
  expect(f.manager.getDirtySessions()).toHaveLength(0);
});


it("B03 still skips only after three consecutive extraction failures for one revision", async () => {
  const f = fixture();
  vi.mocked(callText).mockResolvedValue("not JSON");
  for (let attempt = 0; attempt < 2; attempt++) {
    await processDirtySessions(f.manager, f.store, model);
    expect(f.manager.getDirtySessions()).toHaveLength(1);
  }
  await processDirtySessions(f.manager, f.store, model);
  expect(f.manager.getDirtySessions()).toHaveLength(0);
  expect(f.store.size).toBe(0);
});

it("B03 gives a new source revision its own extraction retry budget", async () => {
  const f = fixture();
  vi.mocked(callText).mockResolvedValue("not JSON");
  for (let attempt = 0; attempt < 2; attempt++) await processDirtySessions(f.manager, f.store, model);
  f.manager.saveSummary("s1", {
    ...f.manager.getSummary("s1"), summary: "Different source", updated_at: "2026-09-12T00:00:00Z",
  });
  await processDirtySessions(f.manager, f.store, model);
  expect(f.manager.getDirtySessions()).toHaveLength(1);
  vi.mocked(callText).mockResolvedValue(JSON.stringify([{ fact: "New revision fact", tags: [] }]));
  await processDirtySessions(f.manager, f.store, model);
  expect(f.store.size).toBe(1);
  expect(f.manager.getDirtySessions()).toHaveLength(0);
});
