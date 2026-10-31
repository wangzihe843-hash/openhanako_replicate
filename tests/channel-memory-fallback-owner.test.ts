import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../core/llm-client.ts", async original => ({
  ...await original<typeof import("../core/llm-client.ts")>(), callText: vi.fn(),
}));
import { Agent } from "../core/agent.ts";
import { callText } from "../core/llm-client.ts";
import { ChannelRouter } from "../hub/channel-router.ts";
import { FactStore } from "../lib/memory/fact-store.ts";
import { writeCompiledResetMarker } from "../lib/memory/compiled-memory-state.ts";
import { loadLocale } from "../lib/i18n.ts";

const llm = vi.mocked(callText);
const cleanup: (() => void)[] = [];
const scope = (agentId: string, realm = "legacy", extra = {}) => ({ version: 1, agentId, realm, knowledge: "shared", ...extra });
const rows = (store: FactStore) => store.db.prepare("SELECT * FROM facts ORDER BY id").all();
const fts = (store: FactStore) => store.db.prepare("SELECT rowid, fact FROM facts_fts ORDER BY rowid").all();
beforeEach(() => { loadLocale("en"); llm.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) close(); });

function fixture(mode: "runtime" | "missing-instance" | "disposed-runtime", sharedDatabase = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "channel-fallback-owner-"));
  const agentsDir = path.join(root, "agents");
  const stores: FactStore[] = [];
  const agents = new Map<string, Agent>();
  const open = (agentId: string, dbPath = path.join(agentsDir, agentId, "memory", "facts.db")) => {
    const store = new FactStore(dbPath, { agentId }); stores.push(store); return store;
  };
  for (const id of ["hana", "lin"]) {
    const agent = new Agent({ id, agentsDir, productDir: path.join(root, "product"), userDir: path.join(root, "user"), channelsDir: path.join(root, "channels"), searchConfigResolver: undefined });
    fs.mkdirSync(path.dirname(agent.memoryMdPath), { recursive: true });
    fs.writeFileSync(agent.configPath, `agent:\n  name: ${id}\nmemory:\n  enabled: true\n`);
    agent.loadConfigOnly();
    agent._memoryMasterEnabled = true;
    if (sharedDatabase && id === "lin") agent.memoryMdPath = agents.get("hana")!.memoryMdPath;
    const facts = open(id, path.join(path.dirname(agent.memoryMdPath), "facts.db"));
    agent._factStore = facts;
    if (mode === "disposed-runtime") agent.disposeInBackground();
    agents.set(id, agent);
  }
  const engine = {
    agentsDir, channelsDir: path.join(root, "channels"),
    getAgent: (id: string) => mode === "missing-instance" ? null : agents.get(id),
    resolveUtilityConfigFresh: vi.fn(async () => ({ utility: "synthetic", api_key: "synthetic", base_url: "https://mock.invalid", api: "openai-completions" })),
  };
  const router = new ChannelRouter({ hub: { engine, eventBus: { emit: vi.fn() } } });
  const run = (agentId = "hana", channel = "crew") => router._memorySummarize(agentId, channel, {
    messages: [{ sender: "user", body: "花子决定周六见面", timestamp: "2026-10-31 12:00:00" }],
  });
  cleanup.push(() => { for (const store of stores) if (store.db.open) store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, agentsDir, agents, engine, router, run, open };
}

it.each(["runtime", "missing-instance", "disposed-runtime"] as const)("persists a queryable summary with the requested owner and channel source via %s", async mode => {
  const f = fixture(mode);
  llm.mockResolvedValue("花子决定周六见面");
  const close = vi.spyOn(FactStore.prototype, "close");
  await f.run();
  expect(llm).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledTimes(mode === "runtime" ? 0 : 1);
  const own = f.open("hana"), other = f.open("lin", own.db.name);
  expect(path.resolve(own.db.name)).toBe(path.join(f.agentsDir, "hana", "memory", "facts.db"));
  const raw = rows(own);
  expect(raw).toHaveLength(1);
  expect(JSON.parse(raw[0].memory_scope).agentId).toBe("hana");
  expect(JSON.parse(raw[0].memory_scope)).toEqual(scope("hana"));
  expect(raw[0].session_id).toBe("channel-crew");
  expect(JSON.parse(raw[0].tags)).toEqual(["channel", "crew"]);
  expect(own.getBySession("channel-crew").map(row => row.fact)).toEqual(["[#crew] 花子决定周六见面"]);
  expect(own.searchFullText("周六见面")).toHaveLength(1);
  expect(other.getBySession("channel-crew")).toEqual([]);
  expect(other.searchFullText("周六见面")).toEqual([]);
});

it("keeps the same group in different agents' physical stores separately queryable during fallback", async () => {
  const f = fixture("missing-instance");
  llm.mockResolvedValueOnce("hanacedar chose Saturday").mockResolvedValueOnce("linbirch chose Sunday");
  await f.run("hana"); await f.run("lin");
  const hana = f.open("hana"), lin = f.open("lin");
  expect(hana.db.name).not.toBe(lin.db.name);
  expect(hana.getBySession("channel-crew").map(row => row.fact)).toEqual(["[#crew] hanacedar chose Saturday"]);
  expect(lin.getBySession("channel-crew").map(row => row.fact)).toEqual(["[#crew] linbirch chose Sunday"]);
  expect(hana.searchFullText("linbirch")).toEqual([]);
  expect(lin.searchFullText("hanacedar")).toEqual([]);
});

it.each(["runtime", "disposed-runtime"] as const)("preserves legacy, other-owner, realm and story boundaries even in a deliberately shared database via %s", async mode => {
  const f = fixture(mode, true), own = f.open("hana");
  const protectedEntries = [
    { fact: "legacycedar old explicit legacy", memoryScope: scope("__legacy__") },
    { fact: "lincedar other owner", memoryScope: scope("lin") },
    { fact: "realitycedar other realm", memoryScope: scope("hana", "reality") },
    { fact: "storycedar other world", memoryScope: scope("hana", "story", { worldId: "w", branchId: "b" }) },
    { fact: "authorcedar hidden knowledge", memoryScope: scope("hana", "legacy", { knowledge: "author" }) },
    { fact: "othergroupcedar other source", session_id: "channel-other" },
  ];
  own.importAll(protectedEntries.map(entry => ({ session_id: "channel-crew", tags: [], ...entry })));
  own.add({ fact: "oldhanacedar existing owner", tags: [], session_id: "channel-crew" });
  const before = rows(own).filter(row => !row.fact.startsWith("oldhanacedar"));
  llm.mockResolvedValueOnce("newhanabirch chose Saturday").mockResolvedValueOnce("newlinbirch chose Sunday");
  await f.run("hana");
  expect(llm.mock.calls[0][0].messages[0].content).toContain("oldhanacedar");
  for (const entry of protectedEntries.slice(0, 5)) expect(llm.mock.calls[0][0].messages[0].content).not.toContain(entry.fact);
  await f.run("lin");
  // Lin replaces only Lin's captured row; every other protected row is byte-for-byte intact.
  expect(rows(own).filter(row => before.some(old => old.id === row.id))).toEqual(before.filter(row => !row.fact.startsWith("lincedar")));
  expect(own.getBySession("channel-crew").map(row => row.fact)).toEqual(["[#crew] newhanabirch chose Saturday"]);
  const lin = f.open("lin", own.db.name);
  expect(lin.getBySession("channel-crew").map(row => row.fact)).toEqual(["[#crew] newlinbirch chose Sunday"]);
  expect(rows(own).filter(row => JSON.parse(row.memory_scope).agentId === "__legacy__")).toEqual(before.filter(row => row.fact.startsWith("legacycedar")));
  expect(own.searchFullText("newlinbirch")).toEqual([]);
  expect(lin.searchFullText("newhanabirch")).toEqual([]);
});

it.each(["NO_MEMORY", "[true,]", ""])("keeps existing owner and legacy rows and FTS unchanged for fallback output %j", async output => {
  const f = fixture("missing-instance"), own = f.open("hana");
  own.importAll([
    { fact: "oldcedar own summary", session_id: "channel-crew", tags: [] },
    { fact: "legacycedar old summary", session_id: "channel-crew", tags: [], memoryScope: scope("__legacy__") },
  ]);
  const before = rows(own), index = fts(own), error = vi.spyOn(console, "error").mockImplementation(() => {});
  llm.mockResolvedValue(output); await f.run();
  expect(rows(own)).toEqual(before); expect(fts(own)).toEqual(index);
  expect(error).toHaveBeenCalledTimes(output === "NO_MEMORY" ? 0 : 1);
});

it("repeated completed fallback summaries replace their own previous row and keep legacy rows", async () => {
  const f = fixture("missing-instance"), own = f.open("hana");
  own.add({ fact: "legacycedar old summary", session_id: "channel-crew", tags: [], memoryScope: scope("__legacy__") });
  const legacy = rows(own);
  llm.mockResolvedValue("newbirch chose Saturday");
  await f.run(); await f.run();
  expect(own.getBySession("channel-crew")).toHaveLength(1);
  expect(rows(own).filter(row => JSON.parse(row.memory_scope).agentId === "__legacy__")).toEqual(legacy);
  expect(fts(own)).toHaveLength(2);
});

it("rejects a late fallback result after a memory reset and closes its temporary store", async () => {
  const f = fixture("missing-instance"), own = f.open("hana");
  own.add({ fact: "oldcedar own summary", session_id: "channel-crew", tags: [] });
  const before = rows(own), index = fts(own);
  let release!: (value: string) => void, entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  llm.mockImplementation(async () => { entered(); return new Promise(resolve => { release = resolve; }); });
  const close = vi.spyOn(FactStore.prototype, "close"), work = f.run();
  await ready;
  try { writeCompiledResetMarker(path.join(f.agentsDir, "hana", "memory"), new Date().toISOString(), { kind: "full" }); }
  finally { release("latebirch chose Saturday"); }
  await work;
  expect(rows(own)).toEqual(before); expect(fts(own)).toEqual(index);
  expect(close).toHaveBeenCalledOnce();
});

it.each(["model-error", "insert-error"])("preserves rows and FTS and closes the fallback store after %s", async fault => {
  const f = fixture("missing-instance"), own = f.open("hana");
  own.importAll([
    { fact: "oldcedar own summary", session_id: "channel-crew", tags: [] },
    { fact: "legacycedar old summary", session_id: "channel-crew", tags: [], memoryScope: scope("__legacy__") },
  ]);
  const before = rows(own), index = fts(own);
  if (fault === "model-error") llm.mockRejectedValue(new Error("synthetic model failure"));
  else {
    own.db.exec("CREATE TRIGGER reject_summary BEFORE INSERT ON facts WHEN NEW.fact LIKE '%newfailcedar%' BEGIN SELECT RAISE(ABORT, 'synthetic insert failure'); END");
    llm.mockResolvedValue("newfailcedar chose Saturday");
  }
  const close = vi.spyOn(FactStore.prototype, "close"), error = vi.spyOn(console, "error").mockImplementation(() => {});
  await f.run();
  expect(rows(own)).toEqual(before); expect(fts(own)).toEqual(index);
  expect(close).toHaveBeenCalledOnce(); expect(error).toHaveBeenCalledOnce();
});
