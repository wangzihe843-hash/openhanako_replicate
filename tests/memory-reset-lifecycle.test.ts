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
import {
  readCompiledResetState,
} from "../lib/memory/compiled-memory-state.ts";
import { createConfigRoute } from "../server/routes/config.ts";
import { loadLocale } from "../lib/i18n.ts";
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
  const f = { root, agent, file, store, coordinator, manager, app, summaries, facts, ticker, calls, published, resolver, memoryDir, append, reset, snapshot, install };
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
  if (process.env.REVIEW_EVIDENCE) fs.writeFileSync(path.join(process.env.REVIEW_EVIDENCE, `${process.env.REVIEW_VARIANT}-${process.env.REVIEW_LABEL}-observations.json`), JSON.stringify(observations, null, 2));
});


import Database from 'better-sqlite3';
import {createMemorySearchTool} from '../lib/memory/memory-search.ts';
import {writeEditableFactsSection, writeDailyEntryBody} from '../lib/memory/compile.ts';
import {createDreamRevision,applyDreamSections,snapshotDreamSections} from '../lib/memory/dream/revision-store.ts';
import {createMemoryDreamRunner} from '../lib/memory/dream/runner.ts';
function allState(f: ReturnType<typeof fixture>) {
  return {
    ...f.snapshot(), root: f.root,
    factsText: read(f.agent.factsMdPath), longterm: read(f.agent.longtermMdPath), week: read(f.agent.weekMdPath),
    factsState: read(path.join(f.memoryDir, 'editable-facts-state.json')),
    dailyFiles: fs.existsSync(path.join(f.memoryDir,'daily')) ? Object.fromEntries(fs.readdirSync(path.join(f.memoryDir,'daily')).map(name=>[name,read(path.join(f.memoryDir,'daily',name))])) : {},
    factsDb: f.agent.factStore?.exportAll(),
    pendingDream: read(path.join(f.memoryDir,'dream','pending-apply.json')),
    weekBackup: read(path.join(f.memoryDir,'week.md.migrated.bak')),
  };
}
function note(kind:string,full:boolean, phases:Record<string,unknown>) {
  observations.push({variant:process.env.REVIEW_VARIANT,kind,full,...phases});
}
function preserveCold(f:ReturnType<typeof fixture>,kind:string,full:boolean){
  if(process.env.REVIEW_VARIANT!=='candidate')return;
  const root=path.join(process.env.REVIEW_EVIDENCE!,`cold-${kind}-${full}`);
  const memory=path.join(root,'agents','hana','memory');
  fs.mkdirSync(memory,{recursive:true});
  fs.cpSync(f.memoryDir,memory,{recursive:true,filter:(src)=>!path.basename(src).includes('.db')});
  fs.copyFileSync(f.agent.configPath,path.join(root,'agents','hana','config.yaml'));
  fs.writeFileSync(path.join(root,'fixture.json'),JSON.stringify({root,kind,full,productDir:path.join(f.root,'product'),userDir:path.join(f.root,'user')}));
}
function hold(f:ReturnType<typeof fixture>,operation:string,nth=1) {
  const entered=deferred<void>(),reply=deferred();let count=0;
  f.install(c=> {if(c.operation===operation && ++count===nth){entered.resolve();return reply.promise;}});
  return {entered,reply};
}
async function seedCompletedDaily(f:ReturnType<typeof fixture>) {
  await f.ticker.flushSessionAndCompile(f.file);
  vi.setSystemTime(new Date('2026-10-16T12:00:00.000Z'));
  await f.ticker.tick();
  expect(read(path.join(f.memoryDir,'daily','2026-10-15.md'))).toContain(OLD);
}
for (const full of [false,true]) {
  it(`daily in flight: full=${full}`,async()=>{
    const f=fixture();await f.ticker.flushSessionAndCompile(f.file);
    vi.setSystemTime(new Date('2026-10-16T12:00:00.000Z'));
    const g=hold(f,'compile_daily');const work=f.ticker.tick();await g.entered.promise;
    const before=allState(f);advance();await f.reset(full);const reset=allState(f);
    g.reply.resolve(`${OLD} daily late`);await work;const drained=allState(f);
    await f.ticker.tick();const resumed=allState(f);note('daily-in-flight',full,{before,reset,drained,resumed});
    expect(reset.prompt).not.toContain(OLD);
    expect(resumed.memory,'obsolete daily result must not reappear').not.toContain(OLD);
  });
  it(`facts in flight and newer user edit: full=${full}`,async()=>{
    const f=fixture();await f.ticker.flushSessionAndCompile(f.file);
    advance();f.append(`${OLD}_UPDATED`);await f.ticker.flushSession(f.file);
    const g=hold(f,'compile_editable_facts');const work=f.ticker.tick();await g.entered.promise;
    const before=allState(f);advance();await f.reset(full);const reset=allState(f);
    const response=await f.app.request(`/api/memories/compiled/facts?agentId=hana`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({facts:NEW})});
    expect(response.status).toBe(200);const fresh=allState(f);
    g.reply.resolve(`${OLD} facts late`);await work;const drained=allState(f);
    await f.ticker.tick();const resumed=allState(f);note('facts-in-flight-new-edit',full,{before,reset,fresh,drained,resumed});
    expect(reset.prompt).not.toContain(OLD);expect(fresh.factsText).toContain(NEW);
    expect(resumed.factsText,'old facts writer must not replace new edit').not.toContain(OLD);
  });
  it(`longterm from migration: full=${full}`,async()=>{
    const f=fixture();await seedCompletedDaily(f);
    vi.setSystemTime(new Date('2026-10-17T12:00:00.000Z'));
    const g=hold(f,'compile_longterm');const work=f.ticker.tick();await g.entered.promise;
    const before=allState(f);advance();await f.reset(full);const reset=allState(f);
    g.reply.resolve(`${OLD} migration late`);await work;const drained=allState(f);
    await f.ticker.tick();const resumed=allState(f);note('longterm-migration-in-flight',full,{before,reset,drained,resumed});
    expect(reset.prompt).not.toContain(OLD);
    expect(resumed.longterm,'migration result must not revive old memory').not.toContain(OLD);
  });
  it(`longterm from rolling and deletion of newer source: full=${full}`,async()=>{
    const f=fixture();await seedCompletedDaily(f);
    vi.setSystemTime(new Date('2026-10-23T12:00:00.000Z'));
    // First fold is the legacy-week migration; the second is the actual daily batch.
    const g=hold(f,'compile_longterm',2);const work=f.ticker.tick();await g.entered.promise;
    const before=allState(f);advance();await f.reset(full);const reset=allState(f);
    // Reset now archives old daily entries. PUT edits existing dates only, so
    // materialize an explicitly restored/new source with the real file writer.
    writeDailyEntryBody(path.join(f.memoryDir,'daily'),'2026-10-15',NEW);
    const fresh=allState(f);
    g.reply.resolve(`${OLD} roll late`);await work;const drained=allState(f);
    expect(read(path.join(f.memoryDir,'daily','2026-10-15.md')),'old fold must not delete a new source').toContain(NEW);
    await f.ticker.tick();const resumed=allState(f);note('longterm-roll-new-source',full,{before,reset,fresh,drained,resumed});
    expect(reset.prompt).not.toContain(OLD);
    expect(resumed.longterm,'old fold result must not reappear').not.toContain(OLD);
    expect(resumed.longterm,'the new fold may consume the new source').toContain(NEW);
  });
  it(`completed daily retained by reset: full=${full}`,async()=>{
    const f=fixture();await seedCompletedDaily(f);const before=allState(f);
    advance();await f.reset(full);const reset=allState(f);
    preserveCold(f,'daily',full);
    // No old request remains. Normal next tick alone reads the retained source.
    await f.ticker.tick();const resumed=allState(f);note('completed-daily-retained',full,{before,reset,resumed});
    expect(reset.prompt).not.toContain(OLD);expect(resumed.memory).not.toContain(OLD);
  });
  it(`dormant editable-facts upgrade source: full=${full}`,async()=>{
    const f=fixture();
    // Synthetic upgrade fixture: an agent with a legacy file before its first migration.
    // The active ticker is stopped; GET performs the real supported lazy migration.
    await f.ticker.stop();
    fs.writeFileSync(path.join(f.memoryDir,'editable-facts.md'),`${OLD} legacy facts`);
    advance();await f.reset(full);const reset=allState(f);
    const response=await f.app.request('/api/memories/compiled?agentId=hana');
    expect(response.status).toBe(200);const returned=await response.json();
    // A later ordinary explicit today write assembles current facts without copying old text itself.
    await f.app.request('/api/memories/compiled/today?agentId=hana',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({today:NEW})});
    const resumed=allState(f);note('legacy-editable-migration',full,{reset,returned,resumed});
    expect(returned.sections.facts).not.toContain(OLD);
  });
  it(`pending Dream apply recovery after successful reset: full=${full}`,async()=>{
    const f=fixture();writeEditableFactsSection(f.memoryDir,`${OLD} resident facts`);
    const before=snapshotDreamSections(f.memoryDir);
    const revision=createDreamRevision(f.memoryDir,{runId:'synthetic-failed-apply',trigger:'manual',before});
    const rename=fs.renameSync;
    let factsWrites=0;
    const fail=vi.spyOn(fs,'renameSync').mockImplementation((from,to)=>{
      // Commit Facts first, fail the next apply step, then fail its compensation.
      // Rejecting the first write leaves no changed file to compensate.
      if(String(to)===f.agent.longtermMdPath || String(to)===f.agent.factsMdPath && ++factsWrites===2)
        throw Object.assign(new Error('synthetic EIO during apply and rollback'),{code:'EIO'});
      return rename(from,to);
    });
    expect(()=>applyDreamSections(f.memoryDir,{revision,next:{...before,facts:`${OLD} organized`}})).toThrow('rollback also failed');
    fail.mockRestore();expect(read(path.join(f.memoryDir,'dream','pending-apply.json'))).not.toBeNull();
    advance();await f.reset(full);const reset=allState(f);
    preserveCold(f,'dream',full);
    // New runner simulates a cold object. Recovery occurs before any provider call.
    const runner=createMemoryDreamRunner({memoryDir:f.memoryDir,memoryMdPath:f.agent.memoryMdPath,
      getResolvedMemoryModel:async()=>{throw new Error('synthetic stop after recovery, no model');},
      getLogicalDate:()=> '2026-10-15',onCompiled:()=>{f.agent._systemPrompt=f.agent.buildSystemPrompt({forceMemoryEnabled:true});f.published.push(f.agent._systemPrompt);}});
    runner.start({trigger:'automatic'});await runner.stop();const resumed=allState(f);
    note('dream-pending-recovery',full,{before,reset,resumed,dreamStatus:runner.getStatus()});
    expect(reset.prompt).not.toContain(OLD);expect(resumed.memory,'automatic recovery must honor reset').not.toContain(OLD);
  });
  it(`deep facts extraction uses revision guard: full=${full}`,async()=>{
    const f=fixture();await f.ticker.flushSession(f.file);
    const g=hold(f,'extract_facts');const work=f.ticker.tick();await g.entered.promise;
    advance();await f.reset(full);const reset=allState(f);
    g.reply.resolve(JSON.stringify([{fact:`${OLD} stale fact`,tags:[],time:null}]));await work;
    const drained=allState(f);note('deep-facts-guard',full,{reset,drained});
    expect(JSON.stringify(drained.factsDb)).not.toContain(OLD);expect(drained.coldSummary).toBeNull();
  });
  it(`explicit writes imports and restore remain valid: full=${full}`,async()=>{
    const f=fixture();writeEditableFactsSection(f.memoryDir,OLD);
    const revision=createDreamRevision(f.memoryDir,{runId:'explicit-restore',trigger:'manual',before:snapshotDreamSections(f.memoryDir)});
    advance();await f.reset(full);
    const edit=await f.app.request('/api/memories/compiled/facts?agentId=hana',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({facts:NEW})});
    expect(edit.status).toBe(200);expect(f.snapshot().prompt).toContain(NEW);
    const imported=await f.app.request('/api/memories/import?agentId=hana',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({facts:[{fact:NEW}]})});
    expect(imported.status).toBe(200);expect(JSON.stringify(f.facts.exportAll())).toContain(NEW);
    await f.ticker.restoreDreamRevision(revision.revisionId);const restored=allState(f);
    expect(restored.prompt).toContain(OLD);note('explicit-new-operations',full,{restored});
  });
}
it('full reset before first v1 migration cannot be undone by later init',async()=>{
  const f=fixture();await f.ticker.stop();
  const db=new Database(path.join(f.memoryDir,'memories.db'));
  db.exec('CREATE TABLE memories(content TEXT,tags TEXT,date TEXT,created_at TEXT)');
  db.prepare('INSERT INTO memories VALUES (?,?,?,?)').run(OLD,'[]','2026-10-15',new Date().toISOString());db.close();
  advance();await f.reset(true);const reset=allState(f);
  // Stop init after the real migration, before tools/providers are initialized.
  const modelBoundary={get utility(){throw new Error('synthetic boundary after v1 migration');}};
  await expect(f.agent.init(()=>{},modelBoundary)).rejects.toThrow('synthetic boundary after v1 migration');
  const restored=f.agent.factStore.exportAll();
  const retrieval=await createMemorySearchTool(f.agent.factStore,{agentId:'hana'}).execute('synthetic-search',{query:OLD});
  note('v1-first-init-after-full-reset',true,{reset,restored,retrieval,migrationMarker:read(path.join(f.memoryDir,'.v2-migrated'))});
  f.agent.factStore.close();
  expect(JSON.stringify(restored)).not.toContain(OLD);
});

for(const full of [false,true])for(const phase of ['compile_today','rolling_summary']){
 it(`unreadable reset marker must fail closed ${phase} full=${full}`,async()=>{
  const f=fixture();const entered=deferred<void>(),reply=deferred();let held=false;
  f.install(c=>{if(c.operation===phase&&!held){held=true;entered.resolve();return reply.promise;}});
  const work=f.ticker.flushSessionAndCompile(f.file);await entered.promise;
  advance();await f.reset(full);const reset=f.snapshot();expect(reset.prompt).not.toContain(OLD);
  advance();const readOriginal=fs.readFileSync;
  const marker=path.join(f.memoryDir,'reset.json');
  const fault=vi.spyOn(fs,'readFileSync').mockImplementation((p,...args)=>{
   if(String(p)===marker)throw Object.assign(new Error('synthetic EACCES reading durable reset marker'),{code:'EACCES'});
   return Reflect.apply(readOriginal, fs, [p, ...args]);
  });
  reply.resolve(phase==='rolling_summary'?good(OLD):`${OLD} delayed`);await work.catch(error=>expect(String(error)).toContain("reset marker is unreadable"));fault.mockRestore();
  const drained=f.snapshot();observations.push({variant:process.env.REVIEW_VARIANT,phase,full,reset,drained});
  expect(drained.memory,'an unreadable existing marker is not proof of no reset').not.toContain(OLD);
 });
}

import {ChannelRouter} from '../hub/channel-router.ts';
import {createChannelTicker} from '../lib/channels/channel-ticker.ts';
import {createChannel,appendMessage} from '../lib/channels/channel-store.ts';
function routerFor(f:ReturnType<typeof fixture>){
 return new ChannelRouter({hub:{engine:{agentsDir:path.join(f.root,'agents'),channelsDir:path.join(f.root,'channels'),userName:'Synthetic user',getAgent:(id:string)=>id==='hana'?f.agent:null,usageLedger:null,resolveUtilityConfigFresh:async()=>({utility:'synthetic',api_key:'synthetic',base_url:'https://mock.invalid',api:'openai-completions'})},eventBus:{emit:()=>{}}}});
}
async function retrieval(f:ReturnType<typeof fixture>){
 return createMemorySearchTool(f.facts,{agentId:'hana'}).execute('synthetic-search',{query:OLD});
}
for(const full of [false,true]){
 it(`${full?'RED':'GREEN'} channel model started before ${full?'full':'compiled'} reset`,async()=>{
  const f=fixture();await f.ticker.stop();const router=routerFor(f);const entered=deferred<void>(),held=deferred();
  f.install(call=>{if(call.operation==='channel_memory_summary'){entered.resolve();return held.promise;}});
  const pending=router._memorySummarize('hana','ch_review',{messages:[{sender:'user',body:OLD,timestamp:'2026-10-15 12:00:00'}],replyContent:''});
  await entered.promise;advance();await f.reset(full);const clean=f.facts.exportAll();held.resolve(OLD+' durable channel fact');await pending;
  const result=await retrieval(f);observations.push({name:'channel-inflight-model',full,root:f.root,clean,facts:f.facts.exportAll(),retrieval:result,calls:f.calls});
  if(full)expect(JSON.stringify(result)).not.toContain(OLD);else expect(JSON.stringify(result)).toContain(OLD);
 });
}
for(const schedule of ['queued-before-reset','unread-after-reset','new-after-reset','same-second-new-after-reset'] as const){
 it(`${schedule.includes('new-after')?'GREEN':'RED'} channel ${schedule} uses real delivery and writer`,async()=>{
  const f=fixture();await f.ticker.stop();const router=routerFor(f);
  const channel=await createChannel(path.join(f.root,'channels'),{id:'review',members:['hana','synthetic-other']});
  const isNew=schedule.includes('new-after');
  if(!isNew)await appendMessage(channel.filePath,'user',OLD);
  const entered=deferred<void>(),held=deferred<{replied:boolean;passed:boolean}>();
  const checks:unknown[]=[];
  const ticker=createChannelTicker({channelsDir:path.join(f.root,'channels'),agentsDir:path.join(f.root,'agents'),getAgentOrder:()=>['hana'],executeCheck:async(...args)=>{checks.push(args.slice(0,3));if(schedule==='queued-before-reset'){entered.resolve();return held.promise;}return {replied:false,passed:true};},onMemorySummarize:(id,name,payload)=>router._memorySummarize(id,name,payload),random:()=>0});
  let pending:Promise<void>|undefined;
  try{
   if(schedule==='queued-before-reset'){
    pending=ticker.triggerImmediate(channel.id);await entered.promise;advance();await f.reset(true);held.resolve({replied:false,passed:true});await pending;
   }else{
    if(schedule!=='same-second-new-after-reset')advance();await f.reset(true);
    if(isNew){if(schedule!=='same-second-new-after-reset')advance();await appendMessage(channel.filePath,'user',NEW);}
    await (isNew?ticker.triggerImmediate(channel.id):ticker.triggerReminder(channel.id));
   }
  }finally{held.resolve({replied:false,passed:true});await pending;await ticker.stop();}
  const result=await retrieval(f);const facts=f.facts.exportAll();observations.push({name:schedule,full:true,root:f.root,facts,retrieval:result,checks,calls:f.calls});
  if(isNew)expect(JSON.stringify(facts)).toContain(NEW);else expect(JSON.stringify(result)).not.toContain(OLD);
 });
}

const dream=vi.hoisted(()=>({atomize:vi.fn(),dedupe:vi.fn(),optimize:vi.fn(),compose:vi.fn(),verify:vi.fn()}));
vi.mock('../lib/memory/dream/model-runner.ts',()=>({
 atomizeDreamMemory:(...a:unknown[])=>dream.atomize(...a),dedupeDreamMemory:(...a:unknown[])=>dream.dedupe(...a),
 optimizeDreamMemory:(...a:unknown[])=>dream.optimize(...a),composeDreamMemory:(...a:unknown[])=>dream.compose(...a),
 verifyDreamSections:(...a:unknown[])=>dream.verify(...a),dreamModelId:()=> 'synthetic',
}));
beforeEach(()=>{
 for(const mock of Object.values(dream))mock.mockReset();
 dream.atomize.mockResolvedValue({sourceBlocks:[],units:[]});
 dream.dedupe.mockResolvedValue({units:[],groups:[]});
 dream.optimize.mockImplementation(async()=>({operations:[],mergedCount:0,forgottenCount:0}));
 dream.compose.mockImplementation(async({current,optimization})=>({...optimization,sections:{...current,facts:`${current.facts} OLD_JOB_REWRITE`}}));
});
for(const full of [false,true])for(const aba of [false,true]){
 it(`${aba?'BOUNDARY ABA':'GREEN'} Dream final hash guard full=${full}`,async()=>{
  const f=fixture();writeEditableFactsSection(f.memoryDir,`${OLD} resident facts`);
  const entered=deferred<void>(),reply=deferred<unknown>();
  dream.verify.mockImplementation(()=>{entered.resolve();return reply.promise;});
  f.ticker.startDream();await entered.promise;advance();await f.reset(full);
  if(aba){
   // Explicit new input deliberately recreates identical pre-reset resident text.
   const response=await f.app.request('/api/memories/compiled/facts?agentId=hana',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({facts:`${OLD} resident facts`})});
   expect(response.status).toBe(200);
  }
  const reset=f.snapshot();reply.resolve({ok:true,insufficientCompression:false});
  await vi.waitFor(()=>expect(f.ticker.getDreamStatus().status).not.toBe('running'));
  const drained=f.snapshot();const status=f.ticker.getDreamStatus();
  observations.push({full,aba,reset,drained,status});
  if(aba)expect(drained.memory,'old Dream may not rewrite a recreated new generation').not.toContain('OLD_JOB_REWRITE');
  else{expect(status.lastRun?.errorCode).toBe('dream_memory_changed');expectClean(f);}
 });
}

import {
  captureMemoryReset, isMemoryResetCurrent, readMemoryResetMarker,
} from '../lib/memory/compiled-memory-state.ts';
import {
  compileDaily, compileEditableFacts, compileLongterm, rollDailyWindow, migrateLegacyWeekToLongterm,
} from '../lib/memory/compile.ts';
import { recoverPendingDreamApply, restoreDreamRevision } from '../lib/memory/dream/revision-store.ts';
import { getNewMessages, getRecentMessages, parseChannel, readBookmarks } from '../lib/channels/channel-store.ts';

function archivedFiles(memoryDir: string) {
  const root = path.join(memoryDir, 'reset-archive');
  return fs.existsSync(root) ? fs.readdirSync(root, { recursive: true }).map(String)
    .filter(name => fs.statSync(path.join(root, name)).isFile())
    .map(name => ({ name, body: fs.readFileSync(path.join(root, name), 'utf8') })) : [];
}

function matchesArchivedSource(archiveName: string, sourceName: string, pathApi = path) {
  // Recursive readdir names use native separators; require the complete source
  // path directly beneath one retired generation, not an arbitrary suffix.
  const [generation] = archiveName.split(pathApi.sep);
  return /^retired-.+$/.test(generation) && archiveName === pathApi.join(generation, sourceName);
}

it.each(['posix', 'win32'] as const)('matches complete archive source paths on %s', (platform) => {
  const pathApi = path[platform];
  for (const source of ['daily/2026-10-14.md', 'daily/2026-10-14.md.fingerprint', 'editable-facts.md', 'dream/pending-apply.json']) {
    const native = (name: string) => name.replaceAll('/', pathApi.sep);
    const expected = [`retired-first/${source}`, `retired-second/${source}`].map(native);
    const names = [
      ...expected,
      ...[
        source, `retired-/${source}`, `unrelated/${source}`, `not-retired-first/${source}`,
        `retired-first/nested/${source}`, `retired-first/not${source}`, `retired-first/${source}.bak`,
        ...(source.includes('/') ? [`retired-first/${path.posix.basename(source)}`] : []),
      ].map(native),
    ];
    expect(names.filter(name => matchesArchivedSource(name, source, pathApi))).toEqual(expected);
  }
});

it('keeps literal POSIX backslashes distinct from archive source separators', () => {
  expect(matchesArchivedSource(String.raw`retired-first/daily\2026-10-14.md`, 'daily/2026-10-14.md', path.posix)).toBe(false);
});

for (const full of [false, true]) {
  it(`archives recoverable sources and preserves unrelated data full=${full}`, async () => {
    const f = fixture(); await f.ticker.stop();
    const sources = {
      'daily/2026-10-14.md': 'MANUAL DAILY exact bytes\n',
      'daily/2026-10-14.md.fingerprint': 'fingerprint bytes',
      'editable-facts.md': 'UNMIGRATED USER CONTENT\n',
      'dream/pending-apply.json': '{"unconsumed":"journal bytes"}',
    };
    const retained = {
      'memories.db': 'V1 SOURCE untouched', 'pinned.md': 'PINNED',
      'daily/readme.md': 'NOT A DATED DAILY', 'dream/revisions/retained.json': 'REVISION',
      'editable-facts.md.bak': 'EXISTING BACKUP', 'week.md.migrated.bak': 'EXISTING WEEK BACKUP',
    };
    for (const [name, body] of Object.entries({ ...sources, ...retained })) {
      fs.mkdirSync(path.dirname(path.join(f.memoryDir, name)), { recursive: true });
      fs.writeFileSync(path.join(f.memoryDir, name), body);
    }
    const session = fs.readFileSync(f.file);
    f.facts.add({ fact: OLD, tags: [], session_id: 'imported' });
    advance(); await f.reset(full);
    for (const [name, body] of Object.entries(sources)) {
      expect(read(path.join(f.memoryDir, name))).toBeNull();
      expect(archivedFiles(f.memoryDir).filter(entry => matchesArchivedSource(entry.name, name)).map(entry => entry.body)).toEqual([body]);
    }
    for (const [name, body] of Object.entries(retained)) expect(read(path.join(f.memoryDir, name))).toBe(body);
    expect(fs.readFileSync(f.file).equals(session)).toBe(true);
    expect(JSON.stringify(f.facts.exportAll()).includes(OLD)).toBe(!full);
    // A second reset cannot overwrite the first archive, even at the same clock time.
    writeDailyEntryBody(path.join(f.memoryDir, 'daily'), '2026-10-14', NEW);
    const secondDaily = fs.readFileSync(path.join(f.memoryDir, 'daily/2026-10-14.md'), 'utf8');
    await f.reset(full);
    const dailyArchives = archivedFiles(f.memoryDir).filter(entry => matchesArchivedSource(entry.name, 'daily/2026-10-14.md'));
    expect(dailyArchives).toHaveLength(2);
    expect(dailyArchives.map(entry => entry.body).sort()).toEqual([sources['daily/2026-10-14.md'], secondDaily].sort());
    expect(read(path.join(f.memoryDir, 'daily/2026-10-14.md'))).toBeNull();
    // Recover one archived file only by an explicit restore/edit; ordinary assembly never reads archives.
    const restored = dailyArchives.find(entry => entry.body === sources['daily/2026-10-14.md'])!;
    writeDailyEntryBody(path.join(f.memoryDir, 'daily'), '2026-10-14', restored.body);
    expect(read(path.join(f.memoryDir, 'daily/2026-10-14.md'))).toContain('MANUAL DAILY');
  });

  it(`archive failure fails reset, keeps bytes, and retry converges full=${full}`, async () => {
    const f = fixture(); await f.ticker.stop();
    fs.writeFileSync(path.join(f.memoryDir, 'editable-facts.md'), OLD);
    const before = captureMemoryReset(f.memoryDir);
    const rename = fs.renameSync;
    const failure = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to).includes(`${path.sep}reset-archive${path.sep}`)) throw new Error('synthetic archive EIO');
      return rename(from, to);
    });
    const response = await f.app.request(`/api/memories${full ? '' : '/compiled'}?agentId=hana`, { method: 'DELETE' });
    expect(response.status).toBe(500);
    expect(await response.text()).toContain('archive EIO');
    expect(read(path.join(f.memoryDir, 'editable-facts.md'))).toBe(OLD);
    expect(isMemoryResetCurrent(f.memoryDir, before)).toBe(false);
    failure.mockRestore(); await f.reset(full);
    expect(read(path.join(f.memoryDir, 'editable-facts.md'))).toBeNull();
    expect(archivedFiles(f.memoryDir).some(entry => entry.body === OLD)).toBe(true);
  });

  it(`late daily error cannot change a newer generation checkpoint or health full=${full}`, async () => {
    const f = fixture(); await f.ticker.flushSessionAndCompile(f.file);
    vi.setSystemTime(new Date('2026-10-16T12:00:00.000Z'));
    const g = hold(f, 'compile_daily'); const work = f.ticker.tick(); await g.entered.promise;
    advance(); await f.reset(full); advance(); f.append(NEW);
    await f.ticker.flushSessionAndCompile(f.file);
    const fresh = allState(f);
    g.reply.reject(Object.assign(new Error('late cancellation'), { name: 'AbortError' })); await work;
    const drained = allState(f);
    expect(drained.daily).toBe(fresh.daily);
    expect(drained.health.compileDaily).toEqual(fresh.health.compileDaily);
    expectClean(f);
  });

  it(`first post-reset summary remains eligible for facts compilation full=${full}`, async () => {
    const f = fixture(); await f.reset(full); advance(); f.append(NEW);
    await f.ticker.flushSession(f.file);
    f.install(call => call.operation === 'compile_editable_facts' ? Promise.resolve(NEW) : undefined);
    expect(await compileEditableFacts(f.summaries, f.agent.factsMdPath, MODEL)).toBe('compiled');
    expect(read(f.agent.factsMdPath)).toContain(NEW);
    expect(f.calls.filter(c => c.operation === 'compile_editable_facts').at(-1)?.input).toContain(NEW);
  });
}

it('full-reset fields survive repeated compiled resets; tokens bind directory and domain', async () => {
  const f = fixture(), other = fixture();
  await f.reset(true);
  const marker = readMemoryResetMarker(f.memoryDir)!;
  const full = captureMemoryReset(f.memoryDir, 'facts');
  const compiled = captureMemoryReset(f.memoryDir);
  await f.reset(false); await f.reset(false);
  expect(readMemoryResetMarker(f.memoryDir)).toMatchObject({
    factsResetAt: marker.factsResetAt, factsResetRevision: marker.factsResetRevision,
    channelSources: marker.channelSources, v1Retired: true,
  });
  expect(isMemoryResetCurrent(f.memoryDir, full, 'facts')).toBe(true);
  expect(isMemoryResetCurrent(f.memoryDir, compiled, 'compiled')).toBe(false);
  expect(isMemoryResetCurrent(other.memoryDir, full, 'facts')).toBe(false);
  expect(await compileLongterm(OLD, f.agent.longtermMdPath, MODEL, { reset: full })).toBe('superseded');
});

for (const raw of ['{broken', '{}', '{"compiledResetAt":"bad"}', '{"compiledResetAt":123}',
  '{"compiledResetAt":"2026-10-15T12:00:00Z","factsResetAt":"bad"}']) {
  it(`malformed reset marker blocks writes and can recover: ${raw}`, async () => {
    const f = fixture(); await f.ticker.stop();
    fs.writeFileSync(path.join(f.memoryDir, 'reset.json'), raw);
    await expect(compileLongterm(OLD, f.agent.longtermMdPath, MODEL)).rejects.toThrow(/reset marker/);
    expect(read(f.agent.longtermMdPath) || '').not.toContain(OLD);
    fs.writeFileSync(path.join(f.memoryDir, 'reset.json'), JSON.stringify({ compiledResetAt: '2026-10-15T12:00:00.000Z', resetRevision: 2 }));
    expect(await compileLongterm(NEW, f.agent.longtermMdPath, MODEL)).toBe('compiled');
    expect(read(f.agent.longtermMdPath)).toContain(NEW);
  });
}

for (const writer of ['daily', 'facts', 'longterm']) for (const full of [false, true]) for (const outcome of ['empty', 'reject', 'abort']) {
  it(`${writer} direct late ${outcome} preserves new files full=${full}`, async () => {
    const f = fixture(); await f.ticker.flushSessionAndCompile(f.file);
    advance(); f.append(`${OLD}_REVISION`); await f.ticker.flushSession(f.file);
    const operation = { daily: 'compile_daily', facts: 'compile_editable_facts', longterm: 'compile_longterm' }[writer]!;
    const gate = hold(f, operation);
    const work = (writer === 'daily' ? compileDaily(f.summaries, path.join(f.memoryDir, 'daily'), '2026-10-15', MODEL)
      : writer === 'facts' ? compileEditableFacts(f.summaries, f.agent.factsMdPath, MODEL)
      : compileLongterm(OLD, f.agent.longtermMdPath, MODEL)).then(value => value, error => error);
    await gate.entered.promise; advance(); await f.reset(full);
    const target = writer === 'daily' ? path.join(f.memoryDir, 'daily/2026-10-15.md')
      : writer === 'facts' ? f.agent.factsMdPath : f.agent.longtermMdPath;
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, NEW);
    fs.writeFileSync(`${target}.fingerprint`, 'NEW fingerprint');
    const state = read(path.join(f.memoryDir, 'editable-facts-state.json'));
    if (outcome === 'empty') gate.reply.resolve('');
    else gate.reply.reject(Object.assign(new Error(`synthetic ${outcome}`), { name: outcome === 'abort' ? 'AbortError' : 'Error' }));
    const result = await work;
    if (outcome === 'empty') expect(result).toBe('superseded'); else expect(result).toBeInstanceOf(Error);
    expect(read(target)).toBe(NEW); expect(read(`${target}.fingerprint`)).toBe('NEW fingerprint');
    expect(read(path.join(f.memoryDir, 'editable-facts-state.json'))).toBe(state);
  });
}

for (const step of [1, 2, 3, 4, 5, 6]) {
  it(`daily resolver frontier ${step} retains the task generation`, async () => {
    const f = fixture(); await f.ticker.flushSessionAndCompile(f.file);
    // Match the synthetic clock so startup recovery does not add an earlier resolver.
    fs.utimesSync(f.file, new Date(Date.now()), new Date(Date.now()));
    const entered = deferred<void>(), reply = deferred<typeof MODEL>(); let resolutions = 0;
    f.resolver.run = () => ++resolutions === step ? (entered.resolve(), reply.promise) : MODEL;
    const work = f.ticker.tick(); await entered.promise; advance(); await f.reset(true);
    const state = read(path.join(f.memoryDir, 'daily-state.json')); const offset = f.calls.length;
    reply.resolve(MODEL); await work;
    expect(read(path.join(f.memoryDir, 'daily-state.json'))).toBe(state);
    expect(f.calls.slice(offset).every(call => !call.input.includes(OLD))).toBe(true);
    expectClean(f);
  });
}

for (const kind of ['roll', 'week']) {
  it(`${kind} cleanup keeps a source edited during the model await and never overwrites archives`, async () => {
    const f = fixture(); await f.ticker.stop();
    const target = kind === 'roll' ? path.join(f.memoryDir, 'daily/2026-09-01.md') : f.agent.weekMdPath;
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, OLD);
    fs.writeFileSync(`${target}.fingerprint`, 'original-fp');
    fs.writeFileSync(`${f.agent.weekMdPath}.migrated.bak`, 'EXISTING BACKUP');
    const gate = hold(f, 'compile_longterm');
    const work = kind === 'roll' ? rollDailyWindow(path.join(f.memoryDir, 'daily'), f.agent.longtermMdPath, MODEL)
      : migrateLegacyWeekToLongterm(f.memoryDir, f.agent.longtermMdPath, MODEL);
    await gate.entered.promise; fs.writeFileSync(target, NEW); gate.reply.resolve('folded old');
    expect((await work).superseded).toBe(true);
    expect(read(target)).toBe(NEW); expect(read(`${target}.fingerprint`)).toBe('original-fp');
    expect(read(`${f.agent.weekMdPath}.migrated.bak`)).toBe('EXISTING BACKUP');
  });
}

it('successful repeated week migration retains each existing backup', async () => {
  const f = fixture(); await f.ticker.stop();
  fs.writeFileSync(f.agent.weekMdPath, NEW); fs.writeFileSync(`${f.agent.weekMdPath}.migrated.bak`, OLD);
  await migrateLegacyWeekToLongterm(f.memoryDir, f.agent.longtermMdPath, MODEL);
  expect(read(`${f.agent.weekMdPath}.migrated.bak`)).toBe(OLD);
  expect(archivedFiles(f.memoryDir).some(entry => entry.body === NEW)).toBe(true);
  expect(read(f.agent.weekMdPath)).toBeNull();
});

for (const marker of ['none', 'timestamp', 'current', 'stale']) {
  it(`Dream recovery validates ${marker} journal identity`, async () => {
    const f = fixture(); await f.ticker.stop();
    if (marker === 'current') await f.reset(false);
    writeEditableFactsSection(f.memoryDir, OLD);
    const before = snapshotDreamSections(f.memoryDir);
    const revision = createDreamRevision(f.memoryDir, { runId: 'recoverable', trigger: 'manual', before });
    const rename = fs.renameSync;
    let factsWrites = 0;
    const failure = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to) === f.agent.longtermMdPath || String(to) === f.agent.factsMdPath && ++factsWrites === 2)
        throw new Error('synthetic apply and rollback failure');
      return rename(from, to);
    });
    expect(() => applyDreamSections(f.memoryDir, { revision, next: { ...before, facts: 'ORGANIZED' } })).toThrow('rollback also failed');
    failure.mockRestore(); const journalPath = path.join(f.memoryDir, 'dream/pending-apply.json');
    // Identity-less compatibility uses an actual v1 journal, not an invalid v2.
    const journal = marker === 'none' || marker === 'timestamp'
      ? { schemaVersion: 1, revisionId: revision.revisionId, operation: 'dream' }
      : JSON.parse(read(journalPath)!);
    if (marker === 'timestamp') fs.writeFileSync(path.join(f.memoryDir, 'reset.json'), JSON.stringify({ compiledResetAt: new Date().toISOString() }));
    if (marker === 'stale') { await f.reset(false); fs.writeFileSync(journalPath, JSON.stringify(journal)); }
    else fs.writeFileSync(journalPath, JSON.stringify(journal));
    fs.writeFileSync(f.agent.factsMdPath, NEW);
    const permitted = marker === 'none' || marker === 'current';
    expect(recoverPendingDreamApply(f.memoryDir)).toBe(permitted);
    expect(read(f.agent.factsMdPath)).toContain(permitted ? OLD : NEW);
    expect(read(journalPath)).toBeNull();
    if (!permitted) expect(archivedFiles(f.memoryDir).some(entry => matchesArchivedSource(entry.name, 'dream/pending-apply.json'))).toBe(true);
    restoreDreamRevision(f.memoryDir, revision.revisionId);
    expect(read(f.agent.factsMdPath)).toContain(OLD);
  });
}

for (const phase of ['resolver', 'atomize', 'dedupe', 'optimize', 'compose', 'verify', 'repair']) {
  it(`Dream reset at ${phase} cannot publish or replace current state`, async () => {
    const f = fixture(); writeEditableFactsSection(f.memoryDir, OLD);
    dream.verify.mockResolvedValue({ insufficientCompression: false });
    const entered = deferred<void>(), result = deferred<unknown>();
    if (phase === 'resolver') f.resolver.run = () => (entered.resolve(), result.promise.then(() => MODEL));
    else if (phase === 'repair') {
      dream.verify.mockResolvedValueOnce({ insufficientCompression: true, compressionFeedback: 'compress' });
      dream.compose.mockImplementation(async ({ current, optimization, compressionRepair }) => {
        if (compressionRepair) { entered.resolve(); return result.promise; }
        return { ...optimization, sections: { ...current, facts: 'DREAM CHANGE' } };
      });
    } else dream[phase].mockImplementation(() => (entered.resolve(), result.promise));
    f.ticker.startDream(); await entered.promise; advance(); await f.reset(true);
    const statePath = path.join(f.memoryDir, 'dream/state.json'); const state = read(statePath);
    result.resolve(phase === 'resolver' ? MODEL : { sourceBlocks: [], units: [], groups: [], operations: [], paragraphs: [], insufficientCompression: false });
    await vi.waitFor(() => expect(f.ticker.getDreamStatus().status).not.toBe('running'));
    expect(read(statePath)).toBe(state); expectClean(f);
  });
}

it('a fresh Dream after reset can organize explicitly restored memory', async () => {
  const f = fixture(); await f.reset(true); writeEditableFactsSection(f.memoryDir, NEW);
  dream.verify.mockResolvedValue({ insufficientCompression: false });
  f.ticker.startDream(); await vi.waitFor(() => expect(f.ticker.getDreamStatus().status).not.toBe('running'));
  expect(f.ticker.getDreamStatus().lastRun?.status).toBe('succeeded');
  expect(read(f.agent.factsMdPath)).toContain(NEW);
});

for (const resetKind of ['none', 'compiled', 'full']) {
  it(`v1 dynamic import frontier respects ${resetKind} reset`, async () => {
    const f = fixture(); await f.ticker.stop();
    const oldPath = path.join(f.memoryDir, 'memories.db');
    const db = new Database(oldPath); db.exec('CREATE TABLE memories(content TEXT,tags TEXT,date TEXT,created_at TEXT)');
    db.prepare('INSERT INTO memories VALUES (?,?,?,?)').run(OLD, '[]', '2026-10-15', new Date().toISOString()); db.close();
    const bytes = fs.readFileSync(oldPath);
    const entered = deferred<void>(), release = deferred<void>();
    const work = f.agent.init((message: string) => {
      if (message.includes('开始迁移')) {
        vi.doMock('better-sqlite3', async () => { entered.resolve(); await release.promise; return { default: Database }; });
      }
    }, { get utility() { throw new Error('synthetic post-migration stop'); } }).catch(error => error);
    try {
      await entered.promise;
      if (resetKind !== 'none') { advance(); await f.reset(resetKind === 'full'); }
      release.resolve(); expect(String(await work)).toContain('synthetic post-migration stop');
      const facts = JSON.stringify(f.agent.factStore.exportAll());
      expect(facts.includes(OLD)).toBe(resetKind !== 'full');
      expect(fs.readFileSync(oldPath).equals(bytes)).toBe(true);
      expect(read(path.join(f.memoryDir, '.v2-migrated')) !== null).toBe(resetKind !== 'full');
    } finally { release.resolve(); await work; vi.doUnmock('better-sqlite3'); f.agent.factStore?.close(); }
  });
}

for (const change of ['edit', 'reorder', 'truncate']) {
  it(`channel ${change} of a reset prefix blocks only automatic memory until an explicit new reset`, async () => {
    const f = fixture(); await f.ticker.stop(); const router = routerFor(f);
    const channel = await createChannel(path.join(f.root, 'channels'), { id: 'source', members: ['hana', 'other'] });
    await appendMessage(channel.filePath, 'user', 'PREFIX FIRST');
    await appendMessage(channel.filePath, 'other', 'PREFIX SECOND');
    await f.reset(true);
    const original = fs.readFileSync(channel.filePath, 'utf8');
    if (change === 'edit') fs.writeFileSync(channel.filePath, original.replace('PREFIX FIRST', 'REWRITTEN'));
    else {
      const blocks = original.split(/(?=^### )/m); const header = blocks.shift()!;
      fs.writeFileSync(channel.filePath, header + (change === 'truncate' ? blocks.slice(0, 1) : blocks.reverse()).join(''));
    }
    await appendMessage(channel.filePath, 'user', NEW);
    const callsBefore = f.calls.length;
    await router._memorySummarize('hana', channel.id, { messages: getRecentMessages(channel.filePath, 20, 'hana', { includeMemorySource: true }), replyContent: '' });
    expect(f.calls.length).toBe(callsBefore); expect(f.facts.exportAll()).toHaveLength(0);
    expect(parseChannel(fs.readFileSync(channel.filePath, 'utf8')).messages.at(-1)?.body).toBe(NEW);
    await f.reset(true); advance(); await appendMessage(channel.filePath, 'user', NEW + '_AFTER_NEW_BOUNDARY');
    await router._memorySummarize('hana', channel.id, { messages: getRecentMessages(channel.filePath, 20, 'hana', { includeMemorySource: true }), replyContent: '' });
    expect(JSON.stringify(f.facts.exportAll())).toContain(NEW);
  });
}

it('mixed channel windows retain original ordinals across self filtering and identical same-second appends', async () => {
  const f = fixture(); await f.ticker.stop(); const router = routerFor(f);
  const channel = await createChannel(path.join(f.root, 'channels'), { id: 'mixed', members: ['hana', 'other'] });
  for (let i = 0; i < 24; i++) await appendMessage(channel.filePath, i % 2 ? 'hana' : 'user', `${OLD}_${i}`);
  await appendMessage(channel.filePath, 'user', 'IDENTICAL EVENT');
  await f.reset(true); // no time advance: next identical body is a distinct append in the same second
  await appendMessage(channel.filePath, 'user', 'IDENTICAL EVENT');
  await appendMessage(channel.filePath, 'other', NEW);
  await appendMessage(channel.filePath, 'hana', 'SELF EXCLUDED');
  const before = fs.readFileSync(channel.filePath);
  const messages = getRecentMessages(channel.filePath, 20, 'hana', { includeMemorySource: true });
  await router._memorySummarize('hana', channel.id, { messages, replyContent: '' });
  const input = f.calls.filter(call => call.operation === 'channel_memory_summary').at(-1)!.input;
  expect(input).not.toContain(OLD); expect(input).not.toContain('SELF EXCLUDED'); expect(input).toContain(NEW);
  expect(input.match(/IDENTICAL EVENT/g)).toHaveLength(1);
  expect(fs.readFileSync(channel.filePath).equals(before)).toBe(true);
  expect(getRecentMessages(channel.filePath, 1, 'hana')[0]).not.toHaveProperty('memorySource');
});

for (const frontier of ['resolver', 'bookmark', 'empty-response']) for (const full of [false, true]) {
  it(`channel ${frontier} carries its original task across full=${full}`, async () => {
    const f = fixture(); await f.ticker.stop(); const router = routerFor(f);
    const channel = await createChannel(path.join(f.root, 'channels'), { id: 'await', members: ['hana', 'other'] });
    await appendMessage(channel.filePath, 'user', OLD);
    const entered = deferred<void>(), release = deferred<string>();
    const engine = router._engine;
    if (frontier === 'resolver') {
      const resolve = engine.resolveUtilityConfigFresh;
      engine.resolveUtilityConfigFresh = async (...args: unknown[]) => { entered.resolve(); await release.promise; return resolve(...args); };
    } else if (frontier === 'bookmark') {
      const rename = fs.promises.rename;
      vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
        if (String(to) === path.join(f.agent.agentDir, 'channels.md')) { entered.resolve(); await release.promise; }
        return rename(from, to);
      });
    } else f.install(call => {
      if (call.operation === 'channel_memory_summary') { entered.resolve(); return release.promise; }
    });
    const ticker = createChannelTicker({
      channelsDir: path.join(f.root, 'channels'), agentsDir: path.join(f.root, 'agents'), getAgentOrder: () => ['hana'],
      executeCheck: async () => ({ replied: false, passed: true }),
      captureMemoryContext: id => router._captureMemoryContext(id),
      onMemorySummarize: (id, name, payload) => router._memorySummarize(id, name, payload),
    });
    const work = ticker.triggerImmediate(channel.id);
    try {
      await entered.promise; advance(); await f.reset(full);
      const fresh = f.facts.add({ fact: NEW, tags: [], session_id: `channel-${channel.id}` });
      release.resolve(frontier === 'empty-response' ? 'NO_MEMORY' : ''); await work;
      const facts = JSON.stringify(f.facts.exportAll());
      if (full) { expect(facts).toContain(NEW); expect(facts).not.toContain(OLD); }
      else if (frontier !== 'empty-response') expect(facts).toContain(OLD);
      expect(readBookmarks(path.join(f.agent.agentDir, 'channels.md')).has(channel.id)).toBe(true);
      void fresh;
    } finally { release.resolve('NO_MEMORY'); await work; await ticker.stop(); }
  });
}

it('a post-reset channel source edited during its summary await cannot replace newer facts', async () => {
  const f = fixture(); await f.ticker.stop(); const router = routerFor(f);
  const channel = await createChannel(path.join(f.root, 'channels'), { id: 'edited-new', members: ['hana', 'other'] });
  await f.reset(true); await appendMessage(channel.filePath, 'user', NEW);
  const gate = hold(f, 'channel_memory_summary');
  const work = router._memorySummarize('hana', channel.id, { messages: getNewMessages(channel.filePath, null, 'hana', { includeMemorySource: true }), replyContent: '' });
  await gate.entered.promise;
  f.facts.add({ fact: 'NEWER EXPLICIT FACT', tags: [], session_id: `channel-${channel.id}` });
  fs.writeFileSync(channel.filePath, fs.readFileSync(channel.filePath, 'utf8').replace(NEW, 'EDITED INPUT'));
  gate.reply.resolve('NO_MEMORY'); await work;
  expect(JSON.stringify(f.facts.exportAll())).toContain('NEWER EXPLICIT FACT');
});

it('full reset isolation permits another home and a new channel, but rejects unproved legacy payloads', async () => {
  const f = fixture(), other = fixture(); await f.ticker.stop(); await other.ticker.stop();
  const router = routerFor(f), secondRouter = routerFor(other);
  await f.reset(true); await f.reset(false);
  await router._memorySummarize('hana', 'unknown', OLD);
  expect(f.facts.exportAll()).toHaveLength(0);
  await secondRouter._memorySummarize('hana', 'unknown', OLD);
  expect(JSON.stringify(other.facts.exportAll())).toContain(OLD);
  const channel = await createChannel(path.join(f.root, 'channels'), { id: 'brand-new', members: ['hana', 'other'] });
  await appendMessage(channel.filePath, 'user', NEW);
  await router._memorySummarize('hana', channel.id, { messages: getNewMessages(channel.filePath, null, 'hana', { includeMemorySource: true }), replyContent: '' });
  expect(JSON.stringify(f.facts.exportAll())).toContain(NEW);
});

it('durable full reset prepares a separate-process v1 and channel consumer without deleting originals', async () => {
  const f = fixture(); await f.ticker.stop();
  const db = new Database(path.join(f.memoryDir, 'memories.db'));
  db.exec('CREATE TABLE memories(content TEXT,tags TEXT,date TEXT,created_at TEXT)');
  db.prepare('INSERT INTO memories VALUES (?,?,?,?)').run(OLD, '[]', '2026-10-15', new Date().toISOString()); db.close();
  const channel = await createChannel(path.join(f.root, 'channels'), { id: 'cold', members: ['hana', 'other'] });
  await appendMessage(channel.filePath, 'user', OLD);
  await f.reset(true); await f.reset(false); await f.reset(false);
  expect(readMemoryResetMarker(f.memoryDir)?.v1Retired).toBe(true);
  if (process.env.REVIEW_EVIDENCE) {
    const root = path.join(process.env.REVIEW_EVIDENCE, 'cold-full-boundaries');
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
    fs.cpSync(f.memoryDir, path.join(root, 'agents/hana/memory'), { recursive: true, filter: source => !path.basename(source).startsWith('facts.db') });
    fs.cpSync(path.join(f.root, 'channels'), path.join(root, 'channels'), { recursive: true });
    fs.copyFileSync(f.agent.configPath, path.join(root, 'agents/hana/config.yaml'));
    fs.writeFileSync(path.join(root, 'fixture.json'), JSON.stringify({ pid: process.pid, root, productDir: path.join(f.root, 'product'), userDir: path.join(f.root, 'user') }));
  }
});

for (const full of [false, true]) {
  it(`channel fallback DB import respects full=${full}`, async () => {
    const f = fixture(); await f.ticker.stop(); const router = routerFor(f);
    router._engine.getAgent = () => null;
    const channel = await createChannel(path.join(f.root, 'channels'), { id: 'fallback', members: ['hana', 'other'] });
    await appendMessage(channel.filePath, 'user', OLD);
    const entered = deferred<void>(), release = deferred<void>();
    vi.doMock('../lib/memory/fact-store.ts', async () => {
      entered.resolve(); await release.promise; return { FactStore };
    });
    const work = router._memorySummarize('hana', channel.id, { messages: getRecentMessages(channel.filePath, 20, 'hana', { includeMemorySource: true }), replyContent: '' });
    try {
      await entered.promise; advance(); await f.reset(full);
      f.facts.add({ fact: NEW, tags: [], session_id: `channel-${channel.id}` });
      release.resolve(); await work;
      const facts = JSON.stringify(f.facts.exportAll());
      expect(facts.includes(OLD)).toBe(!full);
      if (full) expect(f.calls.some(call => call.operation === 'channel_memory_summary')).toBe(false);
      expect(facts).toContain(NEW);
    } finally { release.resolve(); await work; vi.doUnmock('../lib/memory/fact-store.ts'); }
  });
}

for (const writer of ['daily', 'facts', 'longterm']) {
  it(`${writer} three generations drain out of order without replacing the newest body or state`, async () => {
    const f = fixture(); await f.ticker.flushSessionAndCompile(f.file);
    advance(); f.append(OLD + '_UPDATED'); await f.ticker.flushSession(f.file);
    const operation = { daily: 'compile_daily', facts: 'compile_editable_facts', longterm: 'compile_longterm' }[writer]!;
    const launch = async (text: string) => {
      const gate = hold(f, operation);
      const job = writer === 'daily' ? compileDaily(f.summaries, path.join(f.memoryDir, 'daily'), '2026-10-15', MODEL)
        : writer === 'facts' ? compileEditableFacts(f.summaries, f.agent.factsMdPath, MODEL)
        : compileLongterm(text, f.agent.longtermMdPath, MODEL);
      await gate.entered.promise; return { ...gate, job };
    };
    const first = await launch(OLD);
    await f.reset(true); advance(); f.append(NEW + '_FIRST'); await f.ticker.flushSession(f.file);
    const second = await launch(NEW + '_FIRST');
    await f.reset(true); advance(); f.append(NEW + '_LATEST'); await f.ticker.flushSession(f.file);
    const latest = await launch(NEW + '_LATEST');
    latest.reply.resolve(NEW + '_LATEST'); expect(await latest.job).toBe('compiled');
    const state = allState(f);
    first.reply.resolve(OLD); expect(await first.job).toBe('superseded');
    second.reply.resolve(NEW + '_FIRST'); expect(await second.job).toBe('superseded');
    const after = allState(f);
    expect(after.dailyFiles).toEqual(state.dailyFiles); expect(after.factsText).toBe(state.factsText);
    expect(after.factsState).toBe(state.factsState); expect(after.longterm).toBe(state.longterm);
  });
}

it('a new reply after reset may become memory while its older delivered messages stay excluded', async () => {
  const f = fixture(); await f.ticker.stop(); const router = routerFor(f);
  const channel = await createChannel(path.join(f.root, 'channels'), { id: 'new-reply', members: ['hana', 'other'] });
  await appendMessage(channel.filePath, 'user', OLD); await f.reset(true);
  await router._memorySummarize('hana', channel.id, {
    messages: getRecentMessages(channel.filePath, 20, 'hana', { includeMemorySource: true }),
    memoryContext: router._captureMemoryContext('hana'), replyContent: NEW,
  });
  const input = f.calls.find(call => call.operation === 'channel_memory_summary')!.input;
  expect(input).not.toContain(OLD); expect(input).toContain(NEW);
  expect(JSON.stringify(f.facts.exportAll())).toContain(NEW);
});
