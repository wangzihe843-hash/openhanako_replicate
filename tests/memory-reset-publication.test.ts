import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../core/llm-client.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("../core/llm-client.ts")>(), callText: vi.fn(),
}));

import { Agent } from "../core/agent.ts";
import { ConfigCoordinator } from "../core/config-coordinator.ts";
import { SessionCoordinator } from "../core/session-coordinator.ts";
import { SessionManifestStore } from "../core/session-manifest/store.ts";
import { flushSessionManagerSnapshot } from "../core/session-jsonl-file.ts";
import { callText } from "../core/llm-client.ts";
import { SessionManager } from "../lib/pi-sdk/index.ts";
import { SessionSummaryManager } from "../lib/memory/session-summary.ts";
import { FactStore } from "../lib/memory/fact-store.ts";
import { createMemoryTicker } from "../lib/memory/memory-ticker.ts";
import { compileToday } from "../lib/memory/compile.ts";
import {
  isCompiledResetCurrent, readCompiledResetState, writeCompiledResetMarker,
} from "../lib/memory/compiled-memory-state.ts";
import { createConfigRoute } from "../server/routes/config.ts";
import { loadLocale } from "../lib/i18n.ts";
import { ScopedDerivationStore } from "../lib/memory/scoped-derivation-store.ts";
import type { MemoryScope } from "../shared/memory-scope.ts";

const MODEL = { model: "synthetic", provider: "synthetic", api: "openai-completions", api_key: "synthetic", base_url: "https://mock.invalid" };
const OLD = "OLD_SOURCE_MARKER";
const NEW = "NEW_AFTER_RESET";
const good = (marker: string) => `### Key Facts\n- ${marker}\n\n### Timeline\n- 2026-10-15 12:00: ${marker}`;
const llm = vi.mocked(callText);
const fixtures: { root: string; ticker: ReturnType<typeof createMemoryTicker>; facts: FactStore; store: SessionManifestStore }[] = [];
const gates: (() => void)[] = [];
const observations: unknown[] = [];

function deferred<T = string>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  const gate = { promise, resolve, reject };
  gates.push(() => resolve(good("CLEANUP") as T));
  return gate;
}

function advance(ms = 1000) { vi.setSystemTime(new Date(Date.now() + ms)); }
function read(file: string) { return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null; }

// Real route/coordinator/JSONL/summary/ticker/Agent consumption. Only model
// execution is replaced; the projection reader remains synchronous and intact.
function fixture(agentId = "hana", memoryScope?: MemoryScope) {
  loadLocale("en");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-reset-publication-"));
  const agentsDir = path.join(root, "agents");
  const productDir = path.join(root, "product");
  const userDir = path.join(root, "user");
  fs.mkdirSync(path.join(productDir, "yuan"), { recursive: true });
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(path.join(productDir, "yuan", "hanako.md"), "SYNTHETIC PERSONA");
  const agent = new Agent({ id: agentId, agentsDir, productDir, userDir, channelsDir: path.join(root, "channels"), searchConfigResolver: undefined });
  fs.mkdirSync(agent.sessionDir, { recursive: true });
  fs.mkdirSync(agent.summariesDir, { recursive: true });
  fs.writeFileSync(agent.configPath, "locale: en\nagent:\n  yuan: hanako\nmemory:\n  enabled: true\nexperience:\n  enabled: false\n");
  agent.loadConfigOnly();
  agent._memoryMasterEnabled = true;
  agent._cb = { getTimezone: () => "UTC", getLocale: () => "en" };
  const manager = SessionManager.create(root, agent.sessionDir);
  const append = (text: string) => {
    manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: `${text}_REPLY` }], stopReason: "stop", timestamp: Date.now() } as Parameters<typeof manager.appendMessage>[0]);
    flushSessionManagerSnapshot(manager);
  };
  append(OLD);
  const file = manager.getSessionFile()!;
  const store = new SessionManifestStore({ dbPath: path.join(root, "manifest.db") });
  const { sessionId: id } = store.createForPath({ sessionPath: file, ownerAgentId: agentId, domain: "desktop" });
  const deps = {
    agentsDir, getAgent: () => agent, getAgentById: (key: string) => key === agentId ? agent : null,
    getAgents: () => new Map([[agentId, agent]]), listAgents: () => [agent], getActiveAgentId: () => agentId,
    getModels: () => ({}), getConfig: () => ({}), agentIdFromSessionPath: () => agentId,
    sessionManifestStore: store, emitEvent: () => {}, emitDevLog: () => {}, getPrefs: () => ({}),
    getActivityStore: () => null, getHomeCwd: () => root,
  };
  const coordinator = new SessionCoordinator(deps);
  const session = {
    sessionManager: manager, model: { id: "synthetic", provider: "synthetic" }, isStreaming: false,
    subscribe: () => () => {}, refreshContext: () => {}, agent: { replaceMessages: () => {} },
  };
  coordinator.sessions.set(id, { session, sessionPath: file, agentId });
  coordinator.setSessionBranchHead(file, { leafId: manager.getLeafId(), reason: "fixture" });
  const summaries = new SessionSummaryManager(agent.summariesDir, { agentId });
  const facts = new FactStore(agent.factsDbPath, { agentId });
  agent._summaryManager = summaries;
  agent._factStore = facts;
  const config = new ConfigCoordinator(deps);
  const app = new Hono();
  app.route("/api", createConfigRoute({
    config: {}, configPath: agent.configPath, currentAgentId: agentId, agentsDir,
    preferences: { getExperimentValue: () => undefined },
    getAgent: (key: string) => key === agentId ? agent : null,
    updateConfig: (...args: Parameters<typeof config.updateConfig>) => config.updateConfig(...args),
  }));
  const published: string[] = [];
  const calls: { operation: string; input: string }[] = [];
  const resolver: { run: () => typeof MODEL | Promise<typeof MODEL> } = { run: () => MODEL };
  const ticker = createMemoryTicker({
    agentId, agentDir: agent.agentDir, summaryManager: summaries, factStore: facts,
    getResolvedMemoryModel: () => resolver.run(),
    onCompiled: () => {
      agent._systemPrompt = agent.buildSystemPrompt({ forceMemoryEnabled: true });
      published.push(agent._systemPrompt);
    },
    sessionDir: agent.sessionDir, memoryMdPath: agent.memoryMdPath, todayMdPath: agent.todayMdPath,
    weekMdPath: agent.weekMdPath, longtermMdPath: agent.longtermMdPath, factsMdPath: agent.factsMdPath,
    getMemoryMasterEnabled: () => true, getSessionIdForPath: () => id,
    getSessionMemoryScope: () => memoryScope,
    getSessionBranchHeadForPath: () => store.getBranchHead(id),
    readSessionBranchForPath: (...args: Parameters<typeof coordinator.getSessionBranchProjection>) => coordinator.getSessionBranchProjection(...args),
    getTimezone: () => "UTC", getDreamAutoEnabled: () => false,
  });
  agent._memoryTicker = ticker;
  const memoryDir = path.dirname(agent.memoryMdPath);
  const reset = async (full: boolean) => {
    const response = await app.request(`/api/memories${full ? "" : "/compiled"}?agentId=${agentId}`, { method: "DELETE" });
    expect(response.status, await response.clone().text()).toBe(200);
  };
  const snapshot = () => ({
    today: read(agent.todayMdPath), state: read(path.join(memoryDir, "today-state.json")),
    daily: read(path.join(memoryDir, "daily-state.json")), memory: read(agent.memoryMdPath),
    coldSummary: new SessionSummaryManager(agent.summariesDir, { agentId }).getSummary(id),
    prompt: agent.buildSystemPrompt({ forceMemoryEnabled: true }), cachedPrompt: agent._systemPrompt,
    reset: readCompiledResetState(memoryDir), health: ticker.getHealthStatus() as Record<string, unknown>, published: [...published],
    calls: calls.map((call) => ({ ...call })),
  });
  const install = (handler?: (call: { operation: string; input: string }) => Promise<string> | undefined) => {
    llm.mockImplementation((options) => {
      const context = options.usageContext as { source?: { operation?: string } };
      const call = { operation: context?.source?.operation || "", input: JSON.stringify(options.messages) };
      calls.push(call);
      const result = handler?.(call);
      if (result !== undefined) return result;
      const marker = call.input.includes(OLD) ? OLD : NEW;
      if (call.operation.startsWith("rolling_summary")) return Promise.resolve(good(marker));
      if (call.operation.includes("fact")) return Promise.resolve("[]");
      return Promise.resolve(`${marker} compiled`);
    });
  };
  const f = { root, agent, file, store, summaries, facts, ticker, calls, published, resolver, memoryDir, append, reset, snapshot, install };
  fixtures.push(f);
  install();
  return f;
}

function expectClean(f: ReturnType<typeof fixture>) {
  const s = f.snapshot();
  expect(s.today || "").not.toContain(OLD);
  expect(s.memory || "").not.toContain(OLD);
  expect(s.prompt).not.toContain(OLD);
  expect(s.cachedPrompt || "").not.toContain(OLD);
  return s;
}

function holdCompile(f: ReturnType<typeof fixture>) {
  const result = deferred();
  const entered = deferred<void>();
  let held = false;
  f.install((call) => {
    if (call.operation === "compile_today" && !held) {
      held = true; entered.resolve(); return result.promise;
    }
  });
  return { result, entered };
}

beforeEach(() => {
  llm.mockReset();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-15T12:00:00.000Z"));
});
afterEach(async () => {
  for (const release of gates.splice(0)) release();
  for (const f of fixtures.splice(0)) {
    await f.ticker.stop(); f.facts.close(); f.store.close();
    if (!process.env.REVIEW_EVIDENCE) fs.rmSync(f.root, { recursive: true, force: true });
  }
  vi.restoreAllMocks(); vi.useRealTimers();
});
afterAll(() => {
  if (process.env.REVIEW_EVIDENCE) fs.writeFileSync(path.join(process.env.REVIEW_EVIDENCE, "reset-publication-observations.json"), JSON.stringify(observations, null, 2));
});

for (const full of [false, true]) {
  for (const timing of ["pending", "resolve-then-reset", "reset-then-resolve", "completed"] as const) {
    it(`real reset fences compile and next consumers: full=${full}, ${timing}`, async () => {
      const f = fixture(); const gate = holdCompile(f);
      const work = f.ticker.flushSessionAndCompile(f.file);
      await gate.entered.promise;
      if (timing === "completed") { gate.result.resolve(`${OLD} compiled`); await work; }
      advance();
      if (timing === "resolve-then-reset") gate.result.resolve(`${OLD} compiled`);
      const resetting = f.reset(full);
      if (timing === "reset-then-resolve") gate.result.resolve(`${OLD} compiled`);
      await resetting;
      const reset = expectClean(f);
      gate.result.resolve(`${OLD} compiled`); await work;
      const drained = expectClean(f);
      expect(drained.coldSummary).toBeNull();
      expect(drained.state).toBe(reset.state);
      expect(drained.published).toEqual(reset.published);
      await compileToday(f.summaries, f.agent.todayMdPath, MODEL);
      expectClean(f);
      const callStart = f.calls.length;
      advance(); f.append(NEW);
      await f.ticker.flushSessionAndCompile(f.file);
      const fresh = expectClean(f);
      expect(fresh.prompt).toContain(NEW);
      expect(f.calls.slice(callStart).map((call) => call.input).join("\n")).not.toContain(OLD);
      observations.push({ full, timing, reset, drained, fresh });
    });
  }

  it(`new compile and user edit survive old completion and repeated reset: full=${full}`, async () => {
    const f = fixture(); const gate = holdCompile(f);
    const old = f.ticker.flushSessionAndCompile(f.file);
    await gate.entered.promise; advance(); await f.reset(full);
    const first = readCompiledResetState(f.memoryDir);
    await f.reset(full); // Same wall-clock millisecond, distinct reset identity.
    expect(readCompiledResetState(f.memoryDir).resetAt).toBe(first.resetAt);
    expect(isCompiledResetCurrent(f.memoryDir, first)).toBe(false);
    advance(); f.append(NEW);
    await f.ticker.flushSessionAndCompile(f.file);
    const fresh = expectClean(f);
    fs.appendFileSync(f.agent.todayMdPath, "\nUSER_EDIT_AFTER_RESET");
    const edited = f.snapshot();
    gate.result.resolve(`${OLD} compiled`); await old;
    const drained = expectClean(f);
    expect(drained.today).toBe(edited.today);
    expect(drained.state).toBe(fresh.state);
    expect(drained.memory).toBe(fresh.memory);
    expect(drained.published).toEqual(fresh.published);
    observations.push({ full, timing: "new-before-old", fresh, drained });
  });

  it(`reset during aggregate model resolution never starts an obsolete compile: full=${full}`, async () => {
    const f = fixture();
    await f.ticker.flushSession(f.file);
    const model = deferred<typeof MODEL>(); const entered = deferred<void>();
    let resolutions = 0;
    f.resolver.run = () => {
      if (++resolutions === 2) { entered.resolve(); return model.promise; }
      return MODEL;
    };
    const work = f.ticker.flushSessionAndCompile(f.file);
    await entered.promise; advance(); await f.reset(full);
    const reset = f.snapshot();
    model.resolve(MODEL); await work;
    const drained = expectClean(f);
    expect(drained.calls).toEqual(reset.calls);
    expect(drained.published).toEqual(reset.published);
    observations.push({ full, timing: "model-resolution", reset, drained });
  });

  it(`daily compile reset leaves its checkpoint incomplete and permits retry: full=${full}`, async () => {
    const f = fixture(); await f.ticker.flushSession(f.file);
    const gate = holdCompile(f); const work = f.ticker.tick();
    await gate.entered.promise; advance(); await f.reset(full);
    const reset = f.snapshot();
    gate.result.resolve(`${OLD} compiled`); await work;
    const drained = expectClean(f);
    expect(JSON.parse(drained.daily!).completedSteps.compileToday).toBeUndefined();
    expect(drained.state).toBe(reset.state);
    advance(); f.append(NEW); await f.ticker.flushSession(f.file); await f.ticker.tick();
    const fresh = expectClean(f);
    expect(JSON.parse(fresh.daily!).completedSteps.compileToday).toEqual(expect.any(String));
    expect(JSON.parse(fresh.daily!).resetRevision).toBe(fresh.reset.revision);
    expect(fresh.prompt).toContain(NEW);
    observations.push({ full, timing: "daily", reset, drained, fresh });
  });
}

it("a same-millisecond reset invalidates completed daily checkpoints", async () => {
  const f = fixture(); advance(); await f.reset(false); await f.ticker.tick();
  const first = JSON.parse(f.snapshot().daily!);
  await f.reset(false); await f.ticker.tick();
  const second = JSON.parse(f.snapshot().daily!);
  expect(second.resetAt).toBe(first.resetAt);
  expect(second.resetRevision).not.toBe(first.resetRevision);
  expect(second.dailyCompletedAt).toEqual(expect.any(String));
});

it("reset in one agent leaves another agent's in-flight publication valid", async () => {
  const a = fixture("agent-a"); const b = fixture("agent-b");
  const gate = holdCompile(b); const work = b.ticker.flushSessionAndCompile(b.file);
  await gate.entered.promise; advance(); await a.reset(true);
  gate.result.resolve(`${OLD} agent-b`); await work;
  expectClean(a);
  expect(b.snapshot().prompt).toContain(`${OLD} agent-b`);
  expect(b.published.at(-1)).toContain(`${OLD} agent-b`);
});

for (const output of ["reject", "empty", "dangling-think"] as const) {
  it(`normal compile ${output} keeps retry and output semantics`, async () => {
    const f = fixture(); await f.ticker.flushSession(f.file);
    const before = f.snapshot();
    f.install((call) => {
      if (call.operation !== "compile_today") return;
      if (output === "reject") return Promise.reject(new Error("synthetic model failure"));
      return Promise.resolve(output === "empty" ? "" : "<think>unfinished");
    });
    if (output === "empty") {
      await expect(compileToday(f.summaries, f.agent.todayMdPath, MODEL)).resolves.toBe("compiled");
      expect(read(f.agent.todayMdPath)).toBe("");
      expect(f.snapshot().state).not.toBeNull();
    } else {
      await expect(compileToday(f.summaries, f.agent.todayMdPath, MODEL)).rejects.toThrow();
      expect(f.snapshot().today).toBe(before.today);
      expect(f.snapshot().state).toBe(before.state);
      f.install(); await f.ticker.flushSessionAndCompile(f.file);
      expect(f.snapshot().prompt).toContain(OLD);
    }
  });
}

for (const state of [null, "{broken-json"]) {
  it(`reset fences pending compile with missing/corrupt state: ${state}`, async () => {
    const f = fixture();
    if (state !== null) fs.writeFileSync(path.join(f.memoryDir, "today-state.json"), state);
    const gate = holdCompile(f); const work = f.ticker.flushSessionAndCompile(f.file);
    await gate.entered.promise; advance(); await f.reset(false);
    const afterReset = f.snapshot();
    gate.result.resolve(`${OLD} compiled`); await work;
    expectClean(f); expect(f.snapshot().state).toBe(afterReset.state);
  });
}

for (const target of ["today.md", "today-state.json"]) {
  it(`compile write failure at ${target} is retryable without a false publication`, async () => {
    const f = fixture();
    const rename = fs.renameSync;
    const spy = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (to === path.join(f.memoryDir, target)) throw new Error("synthetic write failure");
      return rename(from, to);
    });
    await f.ticker.flushSessionAndCompile(f.file);
    expect(f.published).toEqual([]);
    expect(f.ticker.getHealthStatus()).toMatchObject({ compileToday: { failCount: 1 } });
    spy.mockRestore();
    await f.ticker.flushSessionAndCompile(f.file);
    expect(f.published.at(-1)).toContain(OLD);
    expect(f.ticker.getHealthStatus()).toMatchObject({ compileToday: { failCount: 0 } });
  });
}

it("a failed reset marker write preserves the identity and the valid in-flight job", async () => {
  const f = fixture(); const gate = holdCompile(f);
  const work = f.ticker.flushSessionAndCompile(f.file); await gate.entered.promise;
  const previous = readCompiledResetState(f.memoryDir);
  const rename = fs.renameSync;
  const spy = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (to === path.join(f.memoryDir, "reset.json")) throw new Error("synthetic marker failure");
    return rename(from, to);
  });
  expect(() => writeCompiledResetMarker(f.memoryDir)).toThrow("synthetic marker failure");
  expect(isCompiledResetCurrent(f.memoryDir, previous)).toBe(true);
  spy.mockRestore(); gate.result.resolve(`${OLD} compiled`); await work;
  expect(f.snapshot().prompt).toContain(OLD);
});

it("stop drains an in-flight compile; reset still fences that draining result", async () => {
  const f = fixture(); const gate = holdCompile(f);
  const work = f.ticker.tick(); await gate.entered.promise;
  const stopping = f.ticker.stop(); advance(); await f.reset(false);
  gate.result.resolve(`${OLD} compiled`); await work; await stopping;
  expectClean(f);
});

it("concurrent compiles in the same reset generation still publish normally", async () => {
  const f = fixture(); await f.ticker.flushSession(f.file);
  const a = deferred(); const b = deferred(); let calls = 0;
  f.install((call) => call.operation === "compile_today" ? (++calls === 1 ? a.promise : b.promise) : undefined);
  const first = compileToday(f.summaries, f.agent.todayMdPath, MODEL);
  const second = compileToday(f.summaries, f.agent.todayMdPath, MODEL);
  b.resolve(`${OLD} second`); await expect(second).resolves.toBe("compiled");
  a.resolve(`${OLD} first`); await expect(first).resolves.toBe("compiled");
  expect(f.snapshot().today).toBe(`${OLD} first`);
  expect(f.snapshot().state).not.toBeNull();
});

for (const full of [false, true]) {
  for (const aborted of [false, true]) {
    it(`old model failure cannot overwrite new generation health or data: full=${full}, aborted=${aborted}`, async () => {
      const f = fixture(); const gate = holdCompile(f);
      const work = f.ticker.flushSessionAndCompile(f.file);
      await gate.entered.promise; advance(); await f.reset(full);
      advance(); f.append(NEW); await f.ticker.flushSessionAndCompile(f.file);
      const fresh = expectClean(f);
      const error = new Error(aborted ? "synthetic cancellation" : "synthetic model failure");
      if (aborted) error.name = "AbortError";
      gate.result.reject(error); await work;
      const drained = expectClean(f);
      expect(drained.today).toBe(fresh.today);
      expect(drained.state).toBe(fresh.state);
      expect(drained.health.compileToday).toEqual(fresh.health.compileToday);
      expect(drained.published).toEqual(fresh.published);
      observations.push({ full, timing: aborted ? "late-cancellation" : "late-failure", fresh, drained });
    });
  }

  it(`daily scoped model cannot complete the old reset checkpoint: full=${full}`, async () => {
    const scope: MemoryScope = { version: 1, agentId: "hana", realm: "reality", knowledge: "shared" };
    const f = fixture("hana", scope); await f.ticker.flushSession(f.file);
    const entered = deferred<void>(); const result = deferred(); let held = false;
    f.install((call) => {
      if (call.operation === "compile_daily" && !held) { held = true; entered.resolve(); return result.promise; }
    });
    const work = f.ticker.tick(); await entered.promise;
    advance(); await f.reset(full); const reset = f.snapshot();
    result.resolve(`${OLD} scoped`); await work;
    const drained = expectClean(f);
    expect(JSON.parse(drained.daily!).dailyCompletedAt).toBeNull();
    expect(new ScopedDerivationStore(f.memoryDir, { agentId: "hana" }).readCompiledContext(scope)).toBe("");
    advance(); f.append(NEW); await f.ticker.flushSession(f.file); await f.ticker.tick();
    const fresh = expectClean(f);
    expect(JSON.parse(fresh.daily!).resetRevision).toBe(fresh.reset.revision);
    expect(JSON.parse(fresh.daily!).dailyCompletedAt).toEqual(expect.any(String));
    observations.push({ full, timing: "daily-scoped", reset, drained, fresh });
  });

  for (const phase of ["model-resolution", "scoped-model"] as const) {
    it(`reset fences scoped publication continuation: full=${full}, ${phase}`, async () => {
      const scope: MemoryScope = { version: 1, agentId: "hana", realm: "story", worldId: "world", branchId: "branch", knowledge: "shared" };
      const f = fixture("hana", scope);
      const entered = deferred<void>(); const result = deferred(); const model = deferred<typeof MODEL>();
      let resolutions = 0; let held = false;
      f.resolver.run = () => {
        if (phase === "model-resolution" && ++resolutions === 3) { entered.resolve(); return model.promise; }
        return MODEL;
      };
      f.install((call) => {
        if (phase === "scoped-model" && call.operation === "compile_daily" && !held) {
          held = true; entered.resolve(); return result.promise;
        }
      });
      const work = f.ticker.flushSessionAndCompile(f.file);
      await entered.promise; advance(); await f.reset(full);
      const reset = f.snapshot();
      model.resolve(MODEL); result.resolve(`${OLD} scoped`); await work;
      const drained = expectClean(f);
      expect(drained.published).toEqual(reset.published);
      expect(new ScopedDerivationStore(f.memoryDir, { agentId: "hana" }).readCompiledContext(scope)).toBe("");
      const callStart = f.calls.length; advance(); f.append(NEW);
      await f.ticker.flushSessionAndCompile(f.file);
      const context = new ScopedDerivationStore(f.memoryDir, { agentId: "hana" }).readCompiledContext(scope);
      expect(context).toContain(NEW); expect(context).not.toContain(OLD);
      expect(f.calls.slice(callStart).map((call) => call.input).join("\n")).not.toContain(OLD);
      observations.push({ full, timing: phase, reset, drained, context });
    });
  }
}
