import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../core/llm-client.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("../core/llm-client.ts")>(), callText: vi.fn(),
}));

import { Agent } from "../core/agent.ts";
import { ConfigCoordinator } from "../core/config-coordinator.ts";
import { callText } from "../core/llm-client.ts";
import { ChannelRouter } from "../hub/channel-router.ts";
import { createChannel, appendMessage, readBookmarks } from "../lib/channels/channel-store.ts";
import { createChannelTicker } from "../lib/channels/channel-ticker.ts";
import { loadLocale } from "../lib/i18n.ts";
import { FactStore } from "../lib/memory/fact-store.ts";
import { createMemorySearchTool } from "../lib/memory/memory-search.ts";
import { createConfigRoute } from "../server/routes/config.ts";

type Reset = "none" | "compiled" | "full";
const MODEL = { utility: "synthetic", api_key: "synthetic", base_url: "https://mock.invalid", api: "openai-completions" };
const DECISION = { replied: false, passed: true };
const llm = vi.mocked(callText);
const fixtures: { root: string; facts: FactStore; ticker: ReturnType<typeof createChannelTicker> }[] = [];
const pending: Promise<void>[] = [];
const releases: (() => void)[] = [];

function deferred<T>(fallback: T) {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  releases.push(() => resolve(fallback));
  return { promise, resolve, reject };
}

function advance() { vi.setSystemTime(new Date(Date.now() + 1000)); }
function rows(store: FactStore) { return store.db.prepare("SELECT * FROM facts ORDER BY id").all(); }
function commits(store: FactStore) { return store.db.prepare("SELECT * FROM session_fact_commits ORDER BY session_id").all(); }
function indexed(store: FactStore, word: string) {
  // Query FTS directly as well as search_memory, so LIKE fallback cannot hide a broken index.
  return store.db.prepare("SELECT rowid FROM facts_fts WHERE facts_fts MATCH ? ORDER BY rowid").all(word);
}
async function search(store: FactStore, word: string) {
  return JSON.stringify(await createMemorySearchTool(store, { agentId: "hana" }).execute("atomic-search", { query: word }));
}
function expectReopened(f: Awaited<ReturnType<typeof fixture>>) {
  const reopened = new FactStore(f.agent.factsDbPath, { agentId: "hana" });
  try {
    expect(rows(reopened)).toEqual(rows(f.facts));
    expect(commits(reopened)).toEqual(commits(f.facts));
    for (const word of ["oldcedar", "newbirch", "importedmaple"]) {
      expect(indexed(reopened, word)).toEqual(indexed(f.facts, word));
    }
  } finally { reopened.close(); }
}

async function fixture(resetMode: Reset = "none", count = 3) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "channel-atomic-"));
  const agentsDir = path.join(root, "agents");
  const channelsDir = path.join(root, "channels");
  const productDir = path.join(root, "product");
  const userDir = path.join(root, "user");
  fs.mkdirSync(path.join(productDir, "yuan"), { recursive: true });
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(path.join(productDir, "yuan", "hanako.md"), "Synthetic persona");
  const agent = new Agent({ id: "hana", agentsDir, productDir, userDir, channelsDir, searchConfigResolver: undefined });
  fs.mkdirSync(path.dirname(agent.memoryMdPath), { recursive: true });
  fs.mkdirSync(agent.summariesDir, { recursive: true });
  fs.writeFileSync(agent.configPath, "locale: en\nagent:\n  name: Hana\n  yuan: hanako\nmemory:\n  enabled: true\nexperience:\n  enabled: false\n");
  agent.loadConfigOnly();
  agent._memoryMasterEnabled = true;
  agent._cb = { getTimezone: () => "UTC", getLocale: () => "en" };
  const facts = new FactStore(agent.factsDbPath, { agentId: "hana" });
  agent._factStore = facts;
  const config = new ConfigCoordinator({
    getAgent: () => agent, getAgentById: () => agent, getActiveAgentId: () => "hana", getModels: () => ({}),
  });
  const resolver = vi.fn(async () => MODEL);
  const engine = {
    agentsDir, channelsDir, userName: "Synthetic user", getAgent: () => agent,
    resolveUtilityConfigFresh: resolver,
    updateConfig: (...args: Parameters<typeof config.updateConfig>) => config.updateConfig(...args),
  };
  const app = new Hono();
  app.route("/api", createConfigRoute(engine));
  const reset = async (mode: Exclude<Reset, "none">) => {
    advance();
    const response = await app.request(`/api/memories${mode === "compiled" ? "/compiled" : ""}?agentId=hana`, { method: "DELETE" });
    expect(response.status, await response.clone().text()).toBe(200);
  };
  const router = new ChannelRouter({ hub: { engine, eventBus: { emit: () => {} } } });
  const channel = await createChannel(channelsDir, { id: "atomic", members: ["hana", "other"] });
  const executeCheck = vi.fn(async () => DECISION);
  const ticker = createChannelTicker({
    agentsDir, channelsDir, getAgentOrder: () => ["hana"], executeCheck,
    captureMemoryContext: (id) => router._captureMemoryContext(id),
    onMemorySummarize: (id, name, payload) => router._memorySummarize(id, name, payload),
  });
  const deliver = () => {
    const work = ticker.triggerImmediate(channel.id);
    pending.push(work);
    return work;
  };
  const append = async (text = "newbirch decision") => {
    advance();
    return appendMessage(channel.filePath, "user", text);
  };
  const sessionId = `channel-${channel.id}`;
  const f = { root, agent, facts, channel, sessionId, ticker, router, app, resolver, executeCheck, reset, append, deliver };
  fixtures.push(f);
  await append("ancientraw transcript");
  if (resetMode !== "none") await reset(resetMode);
  await append("oldcedar decision");
  llm.mockResolvedValueOnce("oldcedar durable decision");
  await deliver();
  expect(facts.getBySession(sessionId)).toHaveLength(1);
  for (let i = 1; i < count; i++) {
    facts.importAll([{
      fact: `oldcedar additional ${i}`, tags: ["snapshot", channel.id], session_id: sessionId,
      time: `2026-10-14T12:0${i}`, sourceRevision: `revision-${i}`,
      sourceDependencies: [{ sessionId: "source", revision: `source-${i}` }],
    }]);
  }
  facts.commitSessionRevision(sessionId, "existing-checkpoint", []);
  // All are outside the captured readable set, including rows in the same session.
  facts.importAll([
    { fact: "protected other session", tags: [], session_id: "other-session", sourceDependencies: [{ sessionId }] },
    { fact: "protected other agent", tags: [], session_id: sessionId, memoryScope: { agentId: "other", realm: "legacy" } },
    { fact: "protected other scope", tags: [], session_id: sessionId, memoryScope: { agentId: "hana", realm: "reality" } },
    { fact: "protected stale fact", tags: [], session_id: sessionId, sourceStatus: "stale" },
  ]);
  return f;
}

async function holdModel(f: Awaited<ReturnType<typeof fixture>>) {
  const entered = deferred<void>(undefined);
  const reply = deferred("newbirch merged decision");
  llm.mockImplementationOnce(async () => {
    expect(f.facts.db.inTransaction).toBe(false);
    entered.resolve();
    return reply.promise;
  });
  const message = await f.append();
  const work = f.deliver();
  await entered.promise;
  return { reply, work, message };
}

function importDuringModel(f: Awaited<ReturnType<typeof fixture>>) {
  // A separate real connection must be able to commit while the model is pending.
  const writer = new FactStore(f.agent.factsDbPath, { agentId: "hana" });
  try {
    writer.importAll([{
      fact: "importedmaple explicit new fact", tags: ["import"], session_id: f.sessionId,
      sourceRevision: "import-revision", sourceDependencies: [{ sessionId: "import-source", revision: "r1" }],
    }]);
  } finally { writer.close(); }
}

beforeEach(() => {
  loadLocale("en");
  llm.mockReset();
  llm.mockResolvedValue("newbirch merged decision");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-15T12:00:00.000Z"));
});

afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await Promise.allSettled(pending.splice(0));
  for (const f of fixtures.splice(0)) {
    await f.ticker.stop();
    f.facts.close();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe.each<Reset>(["none", "compiled", "full"])("channel atomic replacement after %s reset", (mode) => {
  it.each([
    { fault: "insert", count: 1 },
    { fault: "insert", count: 3 },
    { fault: "first-delete", count: 3 },
    { fault: "middle-delete", count: 3 },
  ])("rolls back $fault with $count previous facts", async ({ fault, count }) => {
    const f = await fixture(mode, count);
    const captured = f.facts.getBySession(f.sessionId);
    const before = rows(f.facts);
    const beforeCommits = commits(f.facts);
    const beforeIndex = indexed(f.facts, "oldcedar");
    expect(beforeIndex).toHaveLength(count);
    const gate = await holdModel(f);
    const rawTranscript = fs.readFileSync(f.channel.filePath, "utf8");
    const seen: number[] = [];
    const transactions: boolean[] = [];
    const failId = fault === "first-delete" ? captured[0].id : fault === "middle-delete" ? captured[1].id : -1;
    f.facts.db.function("atomic_delete_seen", (id: number) => {
      seen.push(id); transactions.push(f.facts.db.inTransaction); return 0;
    });
    f.facts.db.exec(`CREATE TEMP TRIGGER atomic_delete_fault BEFORE DELETE ON facts BEGIN
      SELECT atomic_delete_seen(old.id);
      SELECT CASE WHEN old.id = ${failId} THEN RAISE(FAIL, 'atomic delete fault') END;
    END;`);
    if (fault === "insert") {
      f.facts.db.exec("CREATE TEMP TRIGGER atomic_insert_fault BEFORE INSERT ON facts BEGIN SELECT RAISE(FAIL, 'atomic insert fault'); END;");
    }
    gate.reply.resolve("newbirch merged decision");
    await gate.work;
    expect(seen).toEqual(captured.slice(0, fault === "first-delete" ? 1 : fault === "middle-delete" ? 2 : count).map(fact => fact.id));
    expect(rows(f.facts), "a failed replacement must preserve every original row and metadata").toEqual(before);
    expect(transactions.every(Boolean)).toBe(true);
    expect(f.facts.db.inTransaction).toBe(false);
    expect(commits(f.facts)).toEqual(beforeCommits);
    expect(indexed(f.facts, "oldcedar")).toEqual(beforeIndex);
    expect(indexed(f.facts, "newbirch")).toEqual([]);
    expect(await search(f.facts, "oldcedar")).toContain("oldcedar");
    expectReopened(f);
    expect(fs.readFileSync(f.channel.filePath, "utf8")).toBe(rawTranscript);
    const bookmarks = path.join(f.agent.agentDir, "channels.md");
    expect(readBookmarks(bookmarks).get(f.channel.id)).toBe(gate.message.timestamp);
    f.facts.db.exec("DROP TRIGGER atomic_delete_fault; DROP TRIGGER IF EXISTS atomic_insert_fault;");
    const calls = llm.mock.calls.length;
    await f.deliver();
    expect(llm).toHaveBeenCalledTimes(calls);
    expect(rows(f.facts)).toEqual(before);
    await f.append("newbirch later event");
    await f.deliver();
    expect(llm).toHaveBeenCalledTimes(calls + 1);
    expect(f.facts.getBySession(f.sessionId).map(fact => fact.fact)).toEqual([`[#${f.channel.id}] newbirch merged decision`]);
    expect(rows(f.facts).filter(row => row.fact.startsWith("protected"))).toEqual(before.filter(row => row.fact.startsWith("protected")));
    expect(commits(f.facts)).toEqual(beforeCommits);
    expect(indexed(f.facts, "oldcedar")).toEqual([]);
    expect(indexed(f.facts, "newbirch")).toHaveLength(1);
    expect(await search(f.facts, "newbirch")).toContain("newbirch");
    expectReopened(f);
  });

  it.each(["newbirch merged decision", "NO_MEMORY"])("preserves concurrent imports when the model returns %s", async (summary) => {
    const f = await fixture(mode);
    const oldIds = new Set(f.facts.getBySession(f.sessionId).map(fact => fact.id));
    const beforeCommits = commits(f.facts);
    const gate = await holdModel(f);
    importDuringModel(f);
    const preserved = rows(f.facts).filter(row => !oldIds.has(row.id));
    gate.reply.resolve(summary);
    await gate.work;
    expect(rows(f.facts).filter(row => preserved.some(old => old.id === row.id))).toEqual(preserved);
    expect(rows(f.facts).filter(row => oldIds.has(row.id))).toHaveLength(summary === "NO_MEMORY" ? oldIds.size : 0);
    expect(f.facts.getBySession(f.sessionId)).toHaveLength(summary === "NO_MEMORY" ? 4 : 2);
    expect(commits(f.facts)).toEqual(beforeCommits);
    expect(indexed(f.facts, "oldcedar")).toHaveLength(summary === "NO_MEMORY" ? 3 : 0);
    expect(indexed(f.facts, "newbirch")).toHaveLength(summary === "NO_MEMORY" ? 0 : 1);
    expect(indexed(f.facts, "importedmaple")).toHaveLength(1);
    expect(await search(f.facts, "importedmaple")).toContain("importedmaple");
    expectReopened(f);
  });
});

describe.each<Reset>(["none", "compiled", "full"])("incremental channel memory after %s reset", mode => {
  it.each([
    { summary: "NO_MEMORY", failed: false },
    { summary: "无记忆", failed: false },
    { summary: "```text\nNO_MEMORY\n```", failed: false },
    { summary: "[]", failed: false },
    { summary: "[ \n ]", failed: false },
    { summary: "```json\n[]\n```", failed: false },
    { summary: "", failed: true },
    { summary: "  \n ", failed: true },
    { summary: "```text\n\n```", failed: true },
    { summary: '{"facts":', failed: true },
    { summary: '```json\n{"facts":\n```', failed: true },
    { summary: '{"facts":[]}', failed: true },
    { summary: '["newbirch structured output"]', failed: true },
  ])("preserves facts and FTS without DML for $summary (failed=$failed)", async ({ summary, failed }) => {
    const f = await fixture(mode);
    const gate = await holdModel(f);
    importDuringModel(f);
    f.facts.importAll([{ fact: "otherchannel durable fact", tags: ["other"], session_id: "channel-other" }]);
    const before = rows(f.facts);
    const beforeCommits = commits(f.facts);
    const beforeIndex = indexed(f.facts, "oldcedar");
    const transcript = fs.readFileSync(f.channel.filePath, "utf8");
    const replace = vi.spyOn(f.facts, "replaceByIds");
    const error = vi.spyOn(console, "error");
    // Even an attempted mutation fails this contract; a swallowed DB error cannot pass.
    f.facts.db.exec(`CREATE TEMP TRIGGER noop_delete BEFORE DELETE ON facts BEGIN SELECT RAISE(FAIL, 'unexpected delete'); END;
      CREATE TEMP TRIGGER noop_insert BEFORE INSERT ON facts BEGIN SELECT RAISE(FAIL, 'unexpected insert'); END;`);
    gate.reply.resolve(summary);
    await gate.work;
    expect(replace).not.toHaveBeenCalled();
    expect(rows(f.facts)).toEqual(before);
    expect(commits(f.facts)).toEqual(beforeCommits);
    expect(indexed(f.facts, "oldcedar")).toEqual(beforeIndex);
    expect(indexed(f.facts, "newbirch")).toEqual([]);
    expect(indexed(f.facts, "otherchannel")).toHaveLength(1);
    expect(await search(f.facts, "oldcedar")).toContain("oldcedar");
    expect(await search(f.facts, "importedmaple")).toContain("importedmaple");
    expect(error).toHaveBeenCalledTimes(failed ? 1 : 0);
    if (failed) expect(error.mock.calls[0][0]).toContain("记忆摘要失败");
    expectReopened(f);
    expect(fs.readFileSync(f.channel.filePath, "utf8")).toBe(transcript);
    expect(readBookmarks(path.join(f.agent.agentDir, "channels.md")).get(f.channel.id)).toBe(gate.message.timestamp);
    const calls = llm.mock.calls.length;
    await f.deliver();
    expect(llm).toHaveBeenCalledTimes(calls);
    expect(f.executeCheck).toHaveBeenCalledTimes(2);
    expect(rows(f.facts)).toEqual(before);
    f.facts.db.exec("DROP TRIGGER noop_delete; DROP TRIGGER noop_insert;");
  });
});

it.each(["Error", "AbortError"])("preserves facts when the model rejects with %s", async name => {
  const f = await fixture();
  const gate = await holdModel(f);
  importDuringModel(f);
  const before = rows(f.facts);
  gate.reply.reject(Object.assign(new Error("synthetic model rejection"), { name }));
  await gate.work;
  expect(rows(f.facts)).toEqual(before);
  expectReopened(f);
});

it.each(["delivery", "resolver", "model"])("full reset fences a task waiting at %s", async phase => {
  const f = await fixture();
  const entered = deferred<void>(undefined);
  const delivery = deferred(DECISION);
  const resolver = deferred(MODEL);
  const model = deferred("oldcedar obsolete result");
  if (phase === "delivery") f.executeCheck.mockImplementationOnce(() => { entered.resolve(); return delivery.promise; });
  if (phase === "resolver") f.resolver.mockImplementationOnce(() => { entered.resolve(); return resolver.promise; });
  if (phase === "model") llm.mockImplementationOnce(() => { entered.resolve(); return model.promise; });
  await f.append();
  const work = f.deliver();
  await entered.promise;
  await f.reset("full");
  importDuringModel(f);
  const fresh = rows(f.facts);
  const attempted: string[] = [];
  f.facts.db.function("atomic_obsolete_dml", () => { attempted.push("write"); return 0; });
  f.facts.db.exec(`CREATE TEMP TRIGGER obsolete_delete BEFORE DELETE ON facts BEGIN SELECT atomic_obsolete_dml(); END;
    CREATE TEMP TRIGGER obsolete_insert BEFORE INSERT ON facts BEGIN SELECT atomic_obsolete_dml(); END;`);
  delivery.resolve(DECISION); resolver.resolve(MODEL); model.resolve("oldcedar obsolete result");
  await work;
  expect(attempted).toEqual([]);
  expect(rows(f.facts)).toEqual(fresh);
  f.facts.db.exec("DROP TRIGGER obsolete_delete; DROP TRIGGER obsolete_insert;");
  await f.append(); await f.deliver();
  expect(indexed(f.facts, "newbirch")).toHaveLength(1);
  expectReopened(f);
});

it("compiled reset allows a pending facts task to replace only its captured IDs", async () => {
  const f = await fixture();
  const gate = await holdModel(f);
  await f.reset("compiled");
  importDuringModel(f);
  gate.reply.resolve("newbirch merged decision");
  await gate.work;
  expect(indexed(f.facts, "oldcedar")).toEqual([]);
  expect(indexed(f.facts, "newbirch")).toHaveLength(1);
  expect(indexed(f.facts, "importedmaple")).toHaveLength(1);
  expectReopened(f);
});

it("rejects a changed channel source prefix before replacing any facts", async () => {
  const f = await fixture("full");
  const gate = await holdModel(f);
  const before = rows(f.facts);
  const raw = fs.readFileSync(f.channel.filePath, "utf8");
  fs.writeFileSync(f.channel.filePath, raw.replace("ancientraw", "changedraw"));
  gate.reply.resolve("newbirch merged decision");
  await gate.work;
  expect(rows(f.facts)).toEqual(before);
  expectReopened(f);
});
