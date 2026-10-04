import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../core/llm-client.ts", () => ({ callText: vi.fn() }));
import { ScopedDerivationStore, hashScopedSourceMessage } from "../lib/memory/scoped-derivation-store.ts";
import { SessionSummaryManager } from "../lib/memory/session-summary.ts";
import { compileScopedMemory, compileEditableFacts, compileToday } from "../lib/memory/compile.ts";
import { clearCompiledMemoryArtifacts } from "../lib/memory/compiled-memory-state.ts";
import { readCompiledMemorySnapshot } from "../lib/memory/compiled-memory-snapshot.ts";
import { callText } from "../core/llm-client.ts";
import { FactStore } from "../lib/memory/fact-store.ts";
import { processDirtySessions } from "../lib/memory/deep-memory.ts";
import { invalidateSessionDerivedStateSync } from "../lib/memory/session-derived-state.ts";

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const story = { version: 1 as const, agentId: "a", realm: "story" as const, worldId: "world", branchId: "main", knowledge: "shared" as const };
const reality = { version: 1 as const, agentId: "a", realm: "reality" as const, knowledge: "shared" as const };
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scoped-derivations-")); dirs.push(dir);
  const store = new ScopedDerivationStore(dir, { agentId: "a" });
  const manager = new SessionSummaryManager(path.join(dir, "summaries"), { agentId: "a", scopedDerivationStore: store });
  return { dir, store, manager };
}
function chain(store, scope, sessionId, text) {
  const dependency = store.registerSource({ sessionId, memoryScope: scope, revision: `${text}-v1` });
  let artifact = store.commitArtifact({ kind: "summary", slot: sessionId, memoryScope: scope, body: text, dependencies: [dependency] });
  for (const kind of ["day", "week", "longterm"] as const) {
    artifact = store.commitArtifact({ kind, slot: sessionId, memoryScope: scope, body: text, dependencies: [store.artifactDependency(artifact)] });
  }
  return dependency;
}
const message = (entryId, content, timestamp = "2026-09-10T12:00:00Z") => ({ entryId, role: "user", content, timestamp });
const compact = async (input: string) => input;
function seedEntries(f, messages, memoryScope = story as typeof story | typeof reality) {
  const dependency = f.store.syncSessionSourceSnapshot("session", memoryScope, messages);
  f.manager.saveSummary("session", {
    session_id: "session", memoryScope, sourceDependencies: [dependency],
    summary: "### Key Facts\n\nSome source facts\n\n### Timeline\n\n- 2026-09-10: Source events",
    updated_at: "2026-09-10T12:00:00Z", snapshot: "",
  });
}

describe("scoped derivation dependency fences", () => {
  it("invalidates A's full DAG after edit, preserves B/reality, and survives restart", () => {
    const { dir, store } = fixture();
    chain(store, story, "A", "deleted story A");
    chain(store, story, "B", "retained story B");
    chain(store, reality, "R", "real history");
    fs.writeFileSync(path.join(dir, "memory.md"), "old mixed aggregate, including A");
    store.registerSource({ sessionId: "A", memoryScope: story, revision: "edited-A" });
    const restarted = new ScopedDerivationStore(dir, { agentId: "a" });
    expect(restarted.readCompiledContext(story)).not.toContain("deleted story A");
    expect(restarted.readCompiledContext(story)).toContain("retained story B");
    expect(restarted.readCompiledContext(reality)).toContain("real history");
    expect(fs.readFileSync(path.join(dir, "memory.md"), "utf8")).toBe("old mixed aggregate, including A");
    const aHistory = restarted.listArtifacts(story, { includeInvalid: true }).filter((artifact) => artifact.slot === "A");
    expect(aHistory).toHaveLength(4);
    expect(aHistory.every((artifact) => artifact.status === "stale")).toBe(true);
  });

  it.each([story, reality].flatMap(memoryScope => ([
    ["facts", 1600], ["today", 1800], ["week", 2200], ["longterm", 2400],
  ] as const).map(([kind, limit]) => ({ realm: memoryScope.realm, memoryScope, kind, limit }))))(
    "scrubs cold-reopened $realm $kind context before clipping without rewriting cached evidence", ({ memoryScope, kind, limit }) => {
    const f = fixture();
    const secret = "sk-SYNTHETICOLDCACHEKEY1234567890";
    const dependency = f.store.registerSource({ sessionId: "old-cache", memoryScope, revision: "original-source-v1" });
    // The old key straddles the context limit. Scrubbing after clipping would
    // expose its prefix because the truncated value no longer matches policy.
    const body = `${"x".repeat(limit - 20)} ${secret}`;
    const artifact = f.store.commitArtifact({ kind, slot: "old-cache", memoryScope, body, dependencies: [dependency] });
    const originalBytes = fs.readFileSync(f.store.manifestPath, "utf8");
    const reopened = new ScopedDerivationStore(f.dir, { agentId: "a" });
    const context = reopened.readCompiledContext(memoryScope);
    expect(context).toContain("[REDACTED]");
    expect(context).not.toContain("sk-SYNTHETIC");
    const snapshot = readCompiledMemorySnapshot(f.dir, { memoryScope });
    expect(snapshot[kind]).toContain("[REDACTED]");
    expect(JSON.stringify(snapshot)).not.toContain(secret);
    expect(reopened.getArtifact(kind, "old-cache", memoryScope)).toEqual(artifact);
    expect(reopened.getSourceDependency("old-cache")).toEqual(dependency);
    expect(fs.readFileSync(f.store.manifestPath, "utf8")).toBe(originalBytes);
  });

  it("never reactivates old writes when the same source revision is restored", () => {
    const { store } = fixture();
    const old = chain(store, story, "A", "old A");
    store.invalidateSource("A");
    const fresh = store.registerSource({ sessionId: "A", memoryScope: story, revision: old.revision });
    expect(fresh.generation).toBeGreaterThan(old.generation);
    expect(store.commitArtifact({ kind: "facts", slot: "stale", memoryScope: story, body: "old write", dependencies: [old] })).toBeNull();
    expect(store.readCompiledContext(story)).toBe("");
  });

  it("denies cross-world, branch, agent, author, and other-character context", () => {
    const { store } = fixture();
    chain(store, story, "shared", "shared event");
    chain(store, { ...story, knowledge: "author" }, "author", "author secret");
    chain(store, { ...story, knowledge: "character", characterId: "alice" }, "alice", "alice secret");
    chain(store, { ...story, knowledge: "character", characterId: "bob" }, "bob", "bob secret");
    expect(store.readCompiledContext({ ...story, characterId: "alice" })).toContain("alice secret");
    expect(store.readCompiledContext({ ...story, characterId: "alice" })).not.toMatch(/bob secret|author secret/);
    expect(store.readCompiledContext({ ...story, viewpoint: "author" })).toMatch(/author secret/);
    for (const scope of [reality, { ...story, worldId: "other" }, { ...story, branchId: "other" }, { ...story, agentId: "other" }, undefined]) {
      expect(store.readCompiledContext(scope)).toBe("");
    }
  });

  it("does not accept an artifact whose dependencies belong to another scope", () => {
    const { store } = fixture();
    const dependency = store.registerSource({ sessionId: "A", memoryScope: story, revision: "v1" });
    expect(store.commitArtifact({ kind: "facts", slot: "A", memoryScope: reality, body: "leak", dependencies: [dependency] })).toBeNull();
    expect(store.commitArtifact({ kind: "facts", slot: "empty", memoryScope: story, body: "unproven", dependencies: [] })).toBeNull();
  });

  it("reset invalidates scoped context without deleting historical artifacts", () => {
    const { dir, store } = fixture(); chain(store, story, "A", "story history");
    clearCompiledMemoryArtifacts(dir);
    expect(new ScopedDerivationStore(dir).readCompiledContext(story)).toBe("");
    expect(store.listArtifacts(story, { includeInvalid: true })).toHaveLength(4);
  });
});

describe("entry-granular scoped compilation", () => {
  it.each([["story", story], ["reality", reality]] as const)("scrubs %s source shards and model output without changing raw provenance", async (_realm, memoryScope) => {
    const f = fixture();
    const inputSecret = "sk-SYNTHETICINPUTONLY1234567890";
    const outputSecret = "sk-SYNTHETICOUTPUTONLY1234567890";
    const messages = [
      message("today", `A key ${inputSecret}`, "2026-10-01T12:00:00Z"),
      message("week", [{ type: "text", text: `Another key ${inputSecret}` }], "2026-09-30T12:00:00Z"),
      message("old", `An older key ${inputSecret}`),
    ];
    seedEntries(f, messages, memoryScope);
    const originalSummary = f.manager.getSummary("session");
    const originalSnapshots = f.store.getSessionSourceSnapshots("session", memoryScope);
    const compact = vi.fn(async (input: string) => `${input}\nGenerated key ${outputSecret}`);
    await compileScopedMemory(f.manager, f.store, {}, { referenceDate: "2026-10-01", compact });
    expect(compact).toHaveBeenCalled();
    for (const [input] of compact.mock.calls) {
      expect(input).not.toContain(inputSecret);
      expect(input).not.toContain(outputSecret);
      expect(input).toContain("[REDACTED]");
    }
    for (const artifact of f.store.listArtifacts(memoryScope)) {
      expect(artifact.body).not.toContain(inputSecret);
      expect(artifact.body).not.toContain(outputSecret);
    }
    const restarted = new ScopedDerivationStore(f.dir, { agentId: "a" });
    expect(restarted.readCompiledContext(memoryScope)).toContain("[REDACTED]");
    expect(restarted.readCompiledContext(memoryScope)).not.toMatch(/SYNTHETICINPUT|SYNTHETICOUTPUT/);
    expect(restarted.getSessionSourceSnapshots("session", memoryScope)).toEqual(originalSnapshots);
    for (const { dependency, message: raw } of originalSnapshots) {
      expect(dependency.hash).toBe(hashScopedSourceMessage(raw));
      expect(JSON.stringify(raw)).toContain(inputSecret);
    }
    expect(f.manager.getSummary("session")).toEqual(originalSummary);
  });

  it("scrubs explicitly registered aggregate input without rewriting its source summary", async () => {
    const f = fixture();
    const secret = "sk-SYNTHETICAGGREGATEONLY1234567890";
    const dependency = f.store.registerSource({ sessionId: "import", memoryScope: story, revision: "import-v1" });
    const rawSummary = `### Key Facts\n\nKey ${secret}\n\n### Timeline\n\n- 2026-10-01: Key ${secret}`;
    f.manager.saveSummary("import", { session_id: "import", memoryScope: story, sourceDependencies: [dependency], summary: rawSummary, updated_at: "2026-10-01T12:00:00Z" });
    const compact = vi.fn(async (input: string) => input);
    await compileScopedMemory(f.manager, f.store, {}, { referenceDate: "2026-10-01", compact });
    expect(compact.mock.calls.every(([input]) => !input.includes(secret))).toBe(true);
    expect(f.store.listArtifacts(story).every(artifact => !artifact.body.includes(secret))).toBe(true);
    expect(f.manager.getSummary("import").summary).toBe(rawSummary);
    expect(f.store.getSourceDependency("import")).toEqual(dependency);
  });

  it("supersedes unsafe cached output without re-extracting unchanged sources", async () => {
    const f = fixture();
    seedEntries(f, [message("A", "Ordinary fact")]);
    const compact = vi.fn(async (input: string) => input);
    await compileScopedMemory(f.manager, f.store, {}, { referenceDate: "2026-10-01", compact });
    const artifact = f.store.listArtifacts(story, { kind: "facts" })[0];
    const secret = "sk-SYNTHETICCACHEONLY1234567890";
    f.store.commitArtifact({ ...artifact, body: `Cached key ${secret}` });
    compact.mockClear();
    await compileScopedMemory(f.manager, f.store, {}, { referenceDate: "2026-10-01", compact });
    expect(compact).not.toHaveBeenCalled();
    expect(f.store.readCompiledContext(story)).not.toContain(secret);
    expect(f.store.listArtifacts(story, { kind: "facts" })[0].body).toBe("Cached key [REDACTED]");
  });

  it("batches an entire source snapshot in one atomic write and writes nothing on an unchanged refresh", () => {
    const f = fixture();
    const rename = vi.spyOn(fs, "renameSync");
    const messages = Array.from({ length: 150 }, (_, index) => message(`entry-${index}`, `value-${index}`));
    f.store.syncSessionSourceSnapshot("session", story, messages);
    expect(rename.mock.calls.filter(([, target]) => target === f.store.manifestPath)).toHaveLength(1);
    const before = f.store.getSourceDependency("session", "entry-149");
    rename.mockClear();
    f.store.syncSessionSourceSnapshot("session", story, messages);
    expect(rename.mock.calls.filter(([, target]) => target === f.store.manifestPath)).toHaveLength(0);
    expect(f.store.getSourceDependency("session", "entry-149")).toEqual(before);
  });

  it("retracts A while retaining B from the same session, including after restart", async () => {
    const f = fixture();
    const a = message("A", "RetiredPromiseA"), b = message("B", "RetainedPromiseB");
    seedEntries(f, [a, b]);
    await compileScopedMemory(f.manager, f.store, {}, { referenceDate: "2026-09-13", compact });
    expect(f.store.readCompiledContext(story)).toContain("RetiredPromiseA");
    await compileScopedMemory(f.manager, f.store, {}, { referenceDate: "2026-10-01", compact });
    expect(f.store.readCompiledSections(story).longterm).toContain("RetainedPromiseB");
    f.store.syncSessionSourceSnapshot("session", story, [b]);
    const restarted = new ScopedDerivationStore(f.dir, { agentId: "a" });
    expect(restarted.readCompiledContext(story)).not.toContain("RetiredPromiseA");
    expect(restarted.readCompiledContext(story)).toContain("RetainedPromiseB");
    const invalidA = restarted.listArtifacts(story, { includeInvalid: true })
      .filter((artifact) => artifact.body.includes("RetiredPromiseA"));
    expect(invalidA.length).toBeGreaterThan(3);
    expect(invalidA.every((artifact) => artifact.status !== "active")).toBe(true);
  });

  it("editing A and appending C preserve unchanged B and reject stale A compilation", async () => {
    const f = fixture();
    const a = message("A", "OldAText"), b = message("B", "GoodBText");
    seedEntries(f, [a, b]);
    let release: (value: string) => void;
    let entered: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    let first = true;
    const pending = compileScopedMemory(f.manager, f.store, {}, { referenceDate: "2026-10-01", compact: async (input) => {
      if (first) { first = false; entered(); return new Promise<string>((resolve) => { release = resolve; }); }
      return input;
    } });
    await waiting;
    f.store.syncSessionSourceSnapshot("session", story, [message("A", "NewAText"), b, message("C", "AddedCText")]);
    release("OldAText");
    await pending;
    expect(f.store.readCompiledContext(story)).not.toContain("OldAText");
    expect(f.store.readCompiledContext(story)).toContain("GoodBText");
    // New entries have no compiled claims until they pass through compilation.
    expect(f.store.readCompiledContext(story)).not.toContain("AddedCText");
  });

  it("ignores custom expression candidates and retains raw transcript content", async () => {
    const f = fixture();
    const messages = [message("B", "AdoptedSource"), { entryId: "candidate", type: "custom", customType: "hana-dialogue-variant-v1", content: "UnadoptedSecret" }];
    seedEntries(f, messages);
    await compileScopedMemory(f.manager, f.store, {}, { referenceDate: "2026-10-01", compact });
    expect(f.store.readCompiledContext(story)).toContain("AdoptedSource");
    expect(f.store.readCompiledContext(story)).not.toContain("UnadoptedSecret");
    expect(messages[0].content).toBe("AdoptedSource");
  });

  it("scoped snapshot reads exclude untouched mixed legacy aggregates", async () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.dir, "memory.md"), "## Key Facts\n\nLegacyMixedSecret");
    fs.writeFileSync(path.join(f.dir, "facts.md"), "LegacyMixedSecret");
    seedEntries(f, [message("B", "ScopedSource")]);
    await compileScopedMemory(f.manager, f.store, {}, { referenceDate: "2026-10-01", compact });
    expect(JSON.stringify(readCompiledMemorySnapshot(f.dir, { memoryScope: story }))).not.toContain("LegacyMixedSecret");
    expect(readCompiledMemorySnapshot(f.dir).facts).toBe("LegacyMixedSecret");
    expect(fs.readFileSync(path.join(f.dir, "facts.md"), "utf8")).toBe("LegacyMixedSecret");
  });
});

describe("summary boundary provenance", () => {
  it("stale async summary cannot restore invalidated sources or scoped artifacts", async () => {
    const f = fixture();
    let release;
    vi.spyOn(f.manager, "_callRollingLLM").mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const pending = f.manager.rollingSummary("session", [message("A", "old text")], {}, { memoryScope: story, returnResult: true });
    f.manager.invalidateSession("session");
    release("### Key Facts\n\n- OldStoryFact\n\n### Timeline\n\n- 2026-09-10: OldStoryFact");
    const result = await pending;
    expect(result.reason).toBe("source_changed");
    expect(f.manager.getSummary("session")).toBeNull();
    expect(f.store.readCompiledContext(story)).toBe("");
  });

  it("never feeds a legacy reflection snapshot to explicit story summarization", async () => {
    const f = fixture();
    const llm = vi.spyOn(f.manager, "_callRollingLLM").mockResolvedValue("### Key Facts\n\n- fact\n\n### Timeline\n\n- 2026-09-10: event");
    await f.manager.rollingSummary("session", [message("A", "text")], {}, { memoryScope: story, memoryReflectionSnapshot: { existingMemory: "LegacySecret" } });
    expect(llm.mock.calls[0][4].memoryReflectionSnapshot).toBeUndefined();
    expect(f.manager.getSummary("session").memoryScope).toEqual(story);
    expect(f.manager.getSummary("session").sourceDependencies).toHaveLength(1);
  });

  it("legacy compilers do not consume explicit story summaries", async () => {
    const f = fixture();
    vi.mocked(callText).mockClear();
    seedEntries(f, [message("A", "StoryOnlySecret")]);
    await compileToday(f.manager, path.join(f.dir, "today.md"), {});
    await compileEditableFacts(f.manager, path.join(f.dir, "facts.md"), {});
    expect(callText).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(f.dir, "facts.md"), "utf8")).not.toContain("StoryOnlySecret");
  });
});


describe("entry-granular deep fact extraction", () => {
  it.each([["story", story], ["reality", reality]] as const)("scrubs %s extraction input and cache output before persistence", async (_realm, memoryScope) => {
    const f = fixture();
    const facts = new FactStore(path.join(f.dir, "facts.db"), { agentId: "a" });
    const inputSecret = "sk-SYNTHETICDEEPINPUT1234567890";
    const outputSecret = "sk-SYNTHETICDEEPOUTPUT1234567890";
    const model = { model: "test", api: "openai-completions", api_key: "unused", base_url: "http://unused.invalid" };
    vi.mocked(callText).mockReset().mockResolvedValue(JSON.stringify([{ fact: `Generated key ${outputSecret}`, tags: ["key", outputSecret], extra: { detail: "password: syntheticonlypassword12345" } }]));
    try {
      seedEntries(f, [message("A", `Original key ${inputSecret}`)], memoryScope);
      const originalSnapshots = f.store.getSessionSourceSnapshots("session", memoryScope);
      await processDirtySessions(f.manager, facts, model);
      expect(callText).toHaveBeenCalledOnce();
      expect(JSON.stringify(vi.mocked(callText).mock.calls[0][0].messages)).not.toContain(inputSecret);
      expect(f.store.listArtifacts(memoryScope, { kind: "deep-facts" })[0].body).not.toContain(outputSecret);
      expect(JSON.parse(f.store.listArtifacts(memoryScope, { kind: "deep-facts" })[0].body)[0]).toMatchObject({
        fact: "Generated key [REDACTED]", tags: ["key", "[REDACTED]"], extra: { detail: "[REDACTED]" },
      });
      expect(facts.getBySession("session", memoryScope)[0].fact).toBe("Generated key [REDACTED]");
      expect(f.store.getSessionSourceSnapshots("session", memoryScope)).toEqual(originalSnapshots);
      seedEntries(f, [message("A", `Original key ${inputSecret}`)], memoryScope);
      await processDirtySessions(f.manager, facts, model);
      expect(callText).toHaveBeenCalledOnce();
    } finally { facts.close(); }
  });

  it("sanitizes an existing deep-facts receipt before reuse without changing its source fence", async () => {
    const f = fixture();
    const facts = new FactStore(path.join(f.dir, "facts.db"), { agentId: "a" });
    const secret = "sk-SYNTHETICDEEPCACHE1234567890";
    const model = { model: "test", api: "openai-completions", api_key: "unused", base_url: "http://unused.invalid" };
    vi.mocked(callText).mockReset().mockRejectedValue(new Error("cached source must not be extracted again"));
    try {
      seedEntries(f, [message("A", "Ordinary source")]);
      const [{ dependency }] = f.store.getSessionSourceSnapshots("session", story);
      f.store.commitArtifact({ kind: "deep-facts", slot: JSON.stringify(["session", "A"]), memoryScope: story,
        body: JSON.stringify([{ fact: `Cached key ${secret}`, tags: [secret] }]), dependencies: [dependency] });
      await processDirtySessions(f.manager, facts, model);
      expect(callText).not.toHaveBeenCalled();
      const [receipt] = f.store.listArtifacts(story, { kind: "deep-facts" });
      expect(JSON.parse(receipt.body)).toEqual([{ fact: "Cached key [REDACTED]", tags: ["[REDACTED]"] }]);
      expect(receipt.dependencies).toEqual([dependency]);
      expect(f.store.getSourceDependency("session", "A")).toEqual(dependency);
      expect(facts.getBySession("session", story)[0]).toMatchObject({ fact: "Cached key [REDACTED]", tags: ["[REDACTED]"] });
      expect(f.manager.getDirtySessions()).toHaveLength(0);
    } finally { facts.close(); }
  });

  it("search retains same-session B after A is retracted and uses cached B on rebuild", async () => {
    const f = fixture();
    const facts = new FactStore(path.join(f.dir, "facts.db"), { agentId: "a" });
    const a = message("A", "Ametariver"), b = message("B", "Bmetariver");
    const model = { model: "test", api: "openai-completions", api_key: "unused", base_url: "http://unused.invalid" };
    vi.mocked(callText).mockReset().mockImplementation(async (request) => {
      const text = String(request.messages[0].content);
      return JSON.stringify([{ fact: text.includes("Ametariver") ? "Ametariver" : "Bmetariver", tags: ["metariver"] }]);
    });
    try {
      seedEntries(f, [a, b]);
      await processDirtySessions(f.manager, facts, model);
      expect(facts.searchByTags(["metariver"], null, 20, null, story)).toHaveLength(2);
      expect(facts.getBySession("session", story).every((fact) => fact.sourceDependencies[0].entryId)).toBe(true);
      expect(callText).toHaveBeenCalledTimes(2);
      invalidateSessionDerivedStateSync({ sessionId: "session", summaryManager: f.manager, factStore: facts,
        scopedDerivationStore: f.store, preserveSourceEntries: true, sourceMessages: [b], memoryScope: story });
      expect(facts.searchFullText("Ametariver", 20, { memoryScope: story })).toHaveLength(0);
      expect(facts.searchFullText("Bmetariver", 20, { memoryScope: story })).toHaveLength(1);
      seedEntries(f, [b]);
      await processDirtySessions(f.manager, facts, model);
      expect(callText).toHaveBeenCalledTimes(2);
      expect(facts.searchByTags(["metariver"], null, 20, null, story).map((fact) => fact.fact)).toEqual(["Bmetariver"]);
      facts.close();
      const reopened = new FactStore(path.join(f.dir, "facts.db"), { agentId: "a" });
      try { expect(reopened.searchFullText("Ametariver", 20, { memoryScope: story })).toHaveLength(0);
        expect(reopened.searchFullText("Bmetariver", 20, { memoryScope: story })).toHaveLength(1); }
      finally { reopened.close(); }
    } finally { if (facts.db.open) facts.close(); }
  });

  it("reuses an empty extraction receipt and detects source changes even with unchanged summary text", async () => {
    const f = fixture();
    const facts = new FactStore(path.join(f.dir, "facts.db"), { agentId: "a" });
    const model = { model: "test", api: "openai-completions", api_key: "unused", base_url: "http://unused.invalid" };
    vi.mocked(callText).mockReset().mockResolvedValue("[]");
    try {
      seedEntries(f, [message("A", "empty")]);
      await processDirtySessions(f.manager, facts, model);
      expect(f.manager.getDirtySessions()).toHaveLength(0);
      seedEntries(f, [message("A", "empty")]);
      await processDirtySessions(f.manager, facts, model);
      expect(callText).toHaveBeenCalledTimes(1);
      const old = f.manager.getSummary("session");
      const dependency = f.store.syncSessionSourceSnapshot("session", story, [message("A", "changed")]);
      f.manager.saveSummary("session", { ...old, sourceDependencies: [dependency] });
      expect(f.manager.getDirtySessions()).toHaveLength(1);
      await processDirtySessions(f.manager, facts, model);
      expect(callText).toHaveBeenCalledTimes(2);
    } finally { facts.close(); }
  });
});

describe("scoped invalidation compensation", () => {
  it.each([false, true])("restores summary, DAG, and real fact provenance after a failed fact transaction (preserve entries: %s)", async (preserveSourceEntries) => {
    const f = fixture();
    const facts = new FactStore(path.join(f.dir, "facts.db"), { agentId: "a" });
    const a = message("A", "RollbackA"), b = message("B", "RollbackB");
    try {
      seedEntries(f, [a, b]);
      f.manager.markProcessed("session");
      await compileScopedMemory(f.manager, f.store, {}, { referenceDate: "2026-10-01", compact });
      for (const { dependency, message: source } of f.store.getSessionSourceSnapshots("session", story)) {
        facts.add({ fact: source.content, tags: ["rollback"], session_id: "session", memoryScope: story, sourceDependencies: [dependency] });
      }
      const beforeSummary = JSON.parse(JSON.stringify(f.manager.getSummary("session")));
      const beforeToken = f.store.getSourceDependency("session", "A");
      const beforeArtifact = f.store.listArtifacts(story, { kind: "longterm" }).find((artifact) => artifact.body.includes("RollbackA"));
      const beforeContext = f.store.readCompiledContext(story);
      // Both operations are actual FactStore transactions; their failure occurs
      // after the real summary file and manifest have already been invalidated.
      facts.db.exec(preserveSourceEntries
        ? "CREATE TRIGGER reject_fact_change BEFORE UPDATE OF source_status ON facts BEGIN SELECT RAISE(ABORT, 'disk failure'); END;"
        : "CREATE TRIGGER reject_fact_change BEFORE DELETE ON facts BEGIN SELECT RAISE(ABORT, 'disk failure'); END;");
      expect(() => invalidateSessionDerivedStateSync({
        sessionId: "session", summaryManager: f.manager, factStore: facts, scopedDerivationStore: f.store,
        preserveSourceEntries, sourceMessages: preserveSourceEntries ? [b] : undefined, memoryScope: story,
      })).toThrow("disk failure");
      facts.db.exec("DROP TRIGGER reject_fact_change;");
      expect(f.manager.getSummary("session").summary).toBe(beforeSummary.summary);
      expect(f.manager.getDirtySessions()).toHaveLength(0);
      expect(f.store.readCompiledContext(story)).toBe(beforeContext);
      expect(facts.searchByTags(["rollback"], null, 20, null, story)).toHaveLength(2);
      // The next real prompt refresh must not discard facts that survived rollback.
      f.store.syncSessionSourceSnapshot("session", story, [a, b]);
      expect(facts.invalidateSourceEntries("session", f.store.getSessionDependencies("session", story))).toBe(0);
      expect(facts.searchByTags(["rollback"], null, 20, null, story)).toHaveLength(2);
      expect(f.store.getSourceDependency("session", "A").generation).toBe(beforeToken.generation);
      expect(f.store.getSourceDependency("session", "A").writeFence).toBeGreaterThan(beforeToken.writeFence);
      expect(f.store.commitArtifact({ kind: "facts", slot: "stale-source", memoryScope: story, body: "stale", dependencies: [beforeToken] })).toBeNull();
      expect(f.store.commitArtifact({ kind: "facts", slot: "stale-artifact", memoryScope: story, body: "stale", dependencies: [f.store.artifactDependency(beforeArtifact)] })).toBeNull();
      expect(() => f.manager.saveSummary("session", beforeSummary)).toThrow("source changed");
      const reopened = new ScopedDerivationStore(f.dir, { agentId: "a" });
      const summaryReader = new SessionSummaryManager(path.join(f.dir, "summaries"), { agentId: "a", scopedDerivationStore: reopened });
      expect(reopened.readCompiledContext(story)).toBe(beforeContext);
      expect(summaryReader.getAllSummaries()).toHaveLength(1);
    } finally { facts.close(); }
  });

  it("refuses rollback when another writer changes the manifest during the failing fact operation", () => {
    const f = fixture(); seedEntries(f, [message("A", "OriginalA")]);
    let concurrentToken;
    const factStore = { deleteBySession() {
      concurrentToken = f.store.registerSource({ sessionId: "concurrent", memoryScope: story, revision: "new-authoritative-source" });
      throw new Error("disk failure");
    } };
    expect(() => invalidateSessionDerivedStateSync({ sessionId: "session", summaryManager: f.manager, factStore, scopedDerivationStore: f.store }))
      .toThrow("refusing to overwrite newer provenance");
    expect(f.store.getSourceDependency("concurrent")).toEqual(concurrentToken);
    expect(f.manager.getSummary("session")).toBeNull();
  });
});
