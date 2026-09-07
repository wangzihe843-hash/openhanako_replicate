import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const probe = vi.hoisted(() => ({ requests: [] as any[], sessions: [] as any[] }));

// Keep the installed SDK's session, extension runner and message conversion real.
// Replace only the provider stream, so these tests cannot call a remote model.
vi.mock("../lib/pi-sdk/index.js", async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    createAgentSession: async (options: any) => {
      const result = await actual.createAgentSession(options);
      probe.sessions.push(result.session);
      result.session.agent.streamFn = async (model: any, context: any) => {
        probe.requests.push(JSON.parse(JSON.stringify(context)));
        const message = {
          role: "assistant", content: [{ type: "text", text: "reply" }],
          api: model.api, provider: model.provider, model: model.id,
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "stop", timestamp: Date.now(),
        };
        return {
          async *[Symbol.asyncIterator]() { yield { type: "done", reason: "stop", message }; },
          result: async () => message,
        };
      };
      return result;
    },
  };
});

import { runAgentPhoneSession } from "../hub/agent-executor.ts";
import { buildXingyeAgentPhoneTurnContext } from "../shared/xingye-phone-context.js";
import { readAgentPhoneRuntime, updateAgentPhoneRuntime } from "../lib/conversations/agent-phone-runtime.ts";
import { SessionCoordinator } from "../core/session-coordinator.ts";
import { SessionManager } from "../lib/pi-sdk/index.ts";
import { applySessionTurnSystemContext } from "../core/session-turn-context.ts";

const roots: string[] = [];

afterEach(() => {
  probe.requests.length = 0;
  probe.sessions.length = 0;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(conversationType = "dm") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "phone-xingye-provider-"));
  roots.push(root);
  const agentDir = path.join(root, "agents", "alice");
  fs.mkdirSync(agentDir, { recursive: true });
  const model = {
    id: "local-test", name: "Local test", provider: "local-test", api: "openai-completions",
    baseUrl: "http://127.0.0.1:1", reasoning: false, input: ["text"], contextWindow: 128000,
    maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const agent = {
    id: "alice", agentDir, agentName: "Alice", tools: [], personality: "PERSONALITY ONLY",
    systemPrompt: "LEGACY GENERAL BASE", config: {},
    buildPhoneSystemPrompt: vi.fn(() => "FROZEN PHONE BASE"),
  };
  const engine = {
    getAgent: () => agent,
    getHomeCwd: () => root,
    createSessionContext: () => ({
      authStorage: {},
      modelRegistry: {
        getApiKeyAndHeaders: async () => ({ apiKey: "local-test-placeholder" }),
        hasConfiguredAuth: () => true,
        find: () => model,
      },
      resolveModel: () => model,
      buildTools: () => ({ tools: [], customTools: [] }),
      getSkillsForAgent: () => ({ skills: [], diagnostics: [] }),
      resourceLoader: {
        getExtensions: () => ({ extensions: [], errors: [], runtime: {
          flagValues: new Map(), pendingProviderRegistrations: [], invalidate: () => {},
        } }),
        getPrompts: () => ({ prompts: [], diagnostics: [] }),
        getAppendSystemPrompt: () => ["FROZEN APPENDIX"],
        getAgentsFiles: () => ({ agentsFiles: [] }),
      },
    }),
  };
  const conversationId = conversationType === "dm" ? "dm:bob" : "ch_friends";
  const options = { engine, conversationId, conversationType };
  function write(relative: string, value: any) {
    const file = path.join(agentDir, "xingye", relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value), "utf8");
  }
  const entry = (id: string, content: string, extra = {}) => ({
    id, agentId: "alice", title: id, content, category: "location", keywords: ["clock"],
    insertionMode: "always", enabled: true, visibility: "canonical", priority: 50, ...extra,
  });
  async function deliver(text: string, overrides: any = {}) {
    const context = buildXingyeAgentPhoneTurnContext({
      agentId: "alice", agentDir, hanakoHome: root, agentName: "Alice", locale: "en",
      messageText: text, peerRefs: [{ id: "bob", name: "Bob" }],
    });
    await runAgentPhoneSession("alice", [{ text, context: { system: context }, capture: true }],
      { ...options, ...overrides });
    return probe.requests.at(-1);
  }
  return { root, agentDir, agent, write, entry, deliver, options };
}

describe("Phone Xingye context at the installed SDK provider boundary", () => {
  it.each(["dm", "channel"])("%s sends current role context once and respects edits, disabling and deletion", async (surface) => {
    const f = fixture(surface);
    f.write("profile.json", { displayName: "Alice", gender: "female", relationshipLabel: "OLD RELATIONSHIP" });
    f.write("lore/entries.json", {
      tower: f.entry("tower", "OLD ALWAYS"),
      weather: f.entry("weather", "TOPICAL CLOCK", { insertionMode: "keyword" }),
      bob: f.entry("bob", "BOB FRIEND", { category: "relationship", insertionMode: "keyword", keywords: ["bob"] }),
    });
    const first = await f.deliver("first clock message");
    expect(first.systemPrompt).toContain("OLD ALWAYS");
    expect(first.systemPrompt.split("OLD ALWAYS")).toHaveLength(2);
    expect(first.systemPrompt).toContain("OLD RELATIONSHIP");
    expect(first.systemPrompt).toContain("TOPICAL CLOCK");
    expect(first.systemPrompt).toContain("BOB FRIEND");
    expect(first.messages.some((m: any) => m.role === "system")).toBe(false);
    expect(JSON.stringify(first.messages)).not.toContain("OLD ALWAYS");

    const oldRuntime = readAgentPhoneRuntime(f.agentDir, f.options.conversationId);
    f.agent.buildPhoneSystemPrompt.mockReturnValue("CHANGED GENERAL BASE");
    f.write("profile.json", { displayName: "Alice", gender: "male", relationshipLabel: "NEW RELATIONSHIP" });
    f.write("lore/entries.json", { tower: f.entry("tower", "NEW ALWAYS") });
    const changed = await f.deliver("second message");
    expect(changed.systemPrompt).toContain("FROZEN PHONE BASE");
    expect(changed.systemPrompt).not.toContain("CHANGED GENERAL BASE");
    expect(changed.systemPrompt).toContain("NEW ALWAYS");
    expect(changed.systemPrompt).toContain("NEW RELATIONSHIP");
    expect(changed.systemPrompt).toContain("Gender: male");
    expect(changed.systemPrompt).not.toContain("OLD ALWAYS");
    expect(changed.systemPrompt).not.toContain("OLD RELATIONSHIP");
    expect(changed.systemPrompt).not.toContain("TOPICAL CLOCK");
    expect(changed.systemPrompt).not.toContain("BOB FRIEND");

    f.write("profile.json", { displayName: "Alice", gender: "unspecified", relationshipLabel: "" });
    f.write("lore/entries.json", { tower: f.entry("tower", "NEW ALWAYS", { enabled: false }) });
    const disabled = await f.deliver("third message");
    expect(disabled.systemPrompt).not.toContain("NEW ALWAYS");
    expect(disabled.systemPrompt).not.toContain("NEW RELATIONSHIP");
    expect(disabled.systemPrompt).not.toContain("Gender:");
    f.write("lore/entries.json", {});
    const deleted = await f.deliver("fourth message");
    expect(deleted.systemPrompt).not.toContain("NEW ALWAYS");
    expect(JSON.stringify(deleted.messages)).toContain("first clock message");
    expect(JSON.stringify(deleted.messages)).not.toContain("OLD ALWAYS");
    const runtime = readAgentPhoneRuntime(f.agentDir, f.options.conversationId);
    expect(runtime.phoneSessionFile).toBe(oldRuntime.phoneSessionFile);
    expect(runtime.promptSnapshot).toEqual(oldRuntime.promptSnapshot);
    expect(f.agent.buildPhoneSystemPrompt).toHaveBeenCalledOnce();
  });

  it("migrates the unversioned base once without resetting history or other frozen snapshot fields", async () => {
    const f = fixture();
    await f.deliver("history before migration");
    const oldRuntime = readAgentPhoneRuntime(f.agentDir, f.options.conversationId);
    const legacySnapshot = {
      ...oldRuntime.promptSnapshot,
      systemPrompt: "LEGACY STAR PROFILE AND LORE",
      appendSystemPrompt: ["OLD FROZEN APPENDIX"],
      skillsResult: { skills: [], diagnostics: [{ message: "frozen diagnostic" }] },
      agentsFilesResult: { agentsFiles: [{ path: "old.md", content: "FROZEN AGENT RULE" }] },
    };
    await updateAgentPhoneRuntime({
      agentDir: f.agentDir, agentId: "alice", conversationId: f.options.conversationId, conversationType: "dm",
      patch: { promptSnapshot: legacySnapshot, xingyePhonePromptVersion: null },
    });
    f.agent.buildPhoneSystemPrompt.mockReturnValue("MIGRATED PHONE BASE\n# 星野核心设定\nUser-authored heading stays.");
    const migrated = await f.deliver("history after migration");
    expect(migrated.systemPrompt).toContain("MIGRATED PHONE BASE");
    expect(migrated.systemPrompt).toContain("# 星野核心设定\nUser-authored heading stays.");
    expect(migrated.systemPrompt).not.toContain("LEGACY STAR PROFILE AND LORE");
    expect(migrated.systemPrompt).toContain("OLD FROZEN APPENDIX");
    expect(JSON.stringify(migrated.messages)).toContain("history before migration");
    const runtime = readAgentPhoneRuntime(f.agentDir, f.options.conversationId);
    expect(runtime.phoneSessionFile).toBe(oldRuntime.phoneSessionFile);
    expect(runtime.xingyePhonePromptVersion).toBe(1);
    expect(runtime.promptSnapshot.appendSystemPrompt).toEqual(legacySnapshot.appendSystemPrompt);
    expect(runtime.promptSnapshot.skillsResult).toEqual(legacySnapshot.skillsResult);
    expect(runtime.promptSnapshot.agentsFilesResult).toEqual(legacySnapshot.agentsFilesResult);
    const buildCount = f.agent.buildPhoneSystemPrompt.mock.calls.length;
    f.agent.buildPhoneSystemPrompt.mockReturnValue("DO NOT REBUILD AGAIN");
    expect((await f.deliver("after migration again")).systemPrompt).toContain("MIGRATED PHONE BASE");
    expect(f.agent.buildPhoneSystemPrompt).toHaveBeenCalledTimes(buildCount);
  });

  it("noMemory keeps the personality base during migration and accepts only explicit turn context", async () => {
    const f = fixture();
    f.write("profile.json", { displayName: "Alice", shortBio: "CURRENT ROLE" });
    const first = await f.deliver("plain", { noMemory: true });
    expect(first.systemPrompt).toContain("PERSONALITY ONLY");
    expect(first.systemPrompt).not.toContain("GENERAL BASE");
    expect(first.systemPrompt).toContain("CURRENT ROLE");
    expect(f.agent.buildPhoneSystemPrompt).not.toHaveBeenCalled();
    await updateAgentPhoneRuntime({
      agentDir: f.agentDir, agentId: "alice", conversationId: f.options.conversationId, conversationType: "dm",
      patch: { xingyePhonePromptVersion: null, promptSnapshot: { version: 1, systemPrompt: "OLD GENERAL MEMORY" } },
    });
    const migrated = await f.deliver("again", { noMemory: true });
    expect(migrated.systemPrompt).toContain("PERSONALITY ONLY");
    expect(migrated.systemPrompt).not.toContain("OLD GENERAL MEMORY");
    expect(f.agent.buildPhoneSystemPrompt).not.toHaveBeenCalled();
  });
});

describe("ordinary session turn context at the installed SDK provider boundary", () => {
  it("uses the shared system hook, resets between turns and keeps cache guards active", async () => {
    const f = fixture();
    const ctx = f.options.engine.createSessionContext();
    const agent: any = {
      ...f.agent, sessionDir: path.join(f.agentDir, "sessions"), sessionMemoryEnabled: true,
      setMemoryEnabled: vi.fn(), buildSystemPrompt: () => "MAIN BASE", getToolsSnapshot: () => [],
    };
    fs.mkdirSync(agent.sessionDir, { recursive: true });
    const model = ctx.resolveModel();
    const coordinator = new SessionCoordinator({
      agentsDir: path.dirname(f.agentDir), getAgent: () => agent, getActiveAgentId: () => "alice",
      getModels: () => ({ currentModel: model, availableModels: [model], authStorage: ctx.authStorage,
        modelRegistry: ctx.modelRegistry, resolveThinkingLevel: () => "off" }),
      getResourceLoader: () => ({ ...ctx.resourceLoader, getSystemPrompt: () => "MAIN BASE" }),
      getSkills: () => null, buildTools: () => ({ tools: [], customTools: [] }), emitEvent: () => {},
      getHomeCwd: () => f.root, agentIdFromSessionPath: () => "alice", switchAgentOnly: async () => {},
      getConfig: () => ({}), getPrefs: () => ({ getThinkingLevel: () => "off" }),
      getAgents: () => new Map(), getActivityStore: () => null, getAgentById: () => agent, listAgents: () => [],
    } as any);
    await coordinator.createSession(null, f.root, true);
    let session = probe.sessions.at(-1);
    const sessionPath = session.sessionManager.getSessionFile();
    try {
      await coordinator.promptSession(sessionPath, "one", {
        context: { system: "FIRST SYSTEM", beforeUser: "BEFORE ONE", afterUser: "AFTER ONE" },
      });
      const first = probe.requests.at(-1);
      expect(first.systemPrompt).toContain("FIRST SYSTEM");
      expect(JSON.stringify(first.messages)).toContain("BEFORE ONE");
      expect(JSON.stringify(first.messages)).toContain("AFTER ONE");
      expect(JSON.stringify(session.messages)).not.toContain("FIRST SYSTEM");
      expect(JSON.stringify(session.messages)).not.toContain("BEFORE ONE");
      await coordinator.promptSession(sessionPath, "two", { context: { system: "SECOND SYSTEM" } });
      expect(probe.requests.at(-1).systemPrompt).toContain("SECOND SYSTEM");
      expect(probe.requests.at(-1).systemPrompt).not.toContain("FIRST SYSTEM");
      await coordinator.closeSession(sessionPath);
      await coordinator.createSession(SessionManager.open(sessionPath, agent.sessionDir), f.root, true, null, { restore: true });
      session = probe.sessions.at(-1);
      await coordinator.promptSession(sessionPath, "three", {});
      expect(probe.requests.at(-1).systemPrompt).not.toContain("SECOND SYSTEM");
      expect(probe.requests.at(-1).systemPrompt).toContain("MAIN BASE");
      expect(JSON.stringify(probe.requests.at(-1).messages)).toContain("one");
      const lastRequest = probe.requests.at(-1);
      await expect(session.agent.streamFn(model, {
        ...lastRequest, systemPrompt: `${lastRequest.systemPrompt}\nUNAUTHORIZED DRIFT`,
      }, {})).rejects.toThrow(/Cache prefix contract violated/);
      await expect(session.agent.streamFn({ ...model, baseUrl: "http://127.0.0.1:2" }, lastRequest, {}))
        .rejects.toThrow(/Cache prefix contract violated/);
      await expect(session.agent.streamFn(model, {
        ...lastRequest, tools: [{ name: "unexpected", description: "unexpected", parameters: { type: "object" } }],
      }, {})).rejects.toThrow(/Cache prefix contract violated/);
      // An authorized turn suffix must not mask other prompt/model/tool drift.
      const allowedContext = { system: "AUTHORIZED CURRENT TURN", metadata: { source: "test" } };
      (coordinator as any)._setRuntimeValueForPath((coordinator as any)._turnContextBySession, sessionPath, allowedContext);
      try {
        const authorized = { ...lastRequest, systemPrompt: applySessionTurnSystemContext(lastRequest.systemPrompt, allowedContext) };
        await expect(session.agent.streamFn(model, authorized, {})).resolves.toBeDefined();
        await expect(session.agent.streamFn(model, { ...authorized, systemPrompt: `${authorized.systemPrompt}\nUNAUTHORIZED DRIFT` }, {}))
          .rejects.toThrow(/Cache prefix contract violated/);
        await expect(session.agent.streamFn({ ...model, baseUrl: "http://127.0.0.1:2" }, authorized, {}))
          .rejects.toThrow(/Cache prefix contract violated/);
        await expect(session.agent.streamFn(model, {
          ...authorized, tools: [{ name: "unexpected", description: "unexpected", parameters: { type: "object" } }],
        }, {})).rejects.toThrow(/Cache prefix contract violated/);
      } finally {
        (coordinator as any)._deleteRuntimeValueForPath((coordinator as any)._turnContextBySession, sessionPath);
      }
    } finally {
      await coordinator.closeAllSessions();
    }
  });
});
