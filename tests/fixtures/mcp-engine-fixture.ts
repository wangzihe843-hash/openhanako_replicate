import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { HanaEngine } from "../../core/engine.ts";
import { SessionExecutionRegistry } from "../../lib/session-execution-registry.ts";
import {
  createAgentSession, createModelRegistry, registerModelProvider, AuthStorage,
  DefaultResourceLoader, SettingsManager, SessionManager,
} from "../../lib/pi-sdk/index.ts";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { harness } from "./mcp-http-fixture.ts";

export function makeEngine(h: Awaited<ReturnType<typeof harness>>, {
  deferred = true, permission = "operate", sessionId = "fixture-session",
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-http-engine-"));
  const agentDir = path.join(dir, "agents", "fixture-agent");
  const workspace = path.join(dir, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  const sessionPath = path.join(dir, "sessions", `${sessionId}.jsonl`);
  // Keep buildTools and every wrapper real without starting unrelated services
  // or loading user configuration. Only assembly inputs are local fixtures.
  const engine = Object.create(HanaEngine.prototype);
  const agent = { id: "fixture-agent", agentDir, config: {
    mcp: { connectors: { remote: { enabled: true, tools: { write: true, unused: true } } } },
  }, tools: [] };
  engine.hanakoHome = dir;
  engine.getAgent = () => agent;
  engine._agentMgr = { agent };
  engine._mcp = h.manager;
  engine._pluginManager = null;
  const getConfig = h.manager.getConfig.bind(h.manager);
  h.manager.getConfig = () => ({ ...getConfig(), deferEnabled: deferred, deferThreshold: 1 });
  if (deferred) {
    const catalog = h.manager.getCatalogEntries.bind(h.manager);
    h.manager.getCatalogEntries = () => {
      const entries = catalog();
      return [...entries, { ...entries[0], name: "remote_unused", toolName: "unused" }];
    };
    const all = h.manager.getAllTools.bind(h.manager);
    h.manager.getAllTools = () => [...all(), { ...h.tool, name: "mcp_remote_unused" }];
  }
  engine._prefs = { getFileBackup: () => ({ enabled: false }), getBuiltinToolDeferEnabled: () => false };
  engine._readPreferences = () => ({ sandbox: true });
  engine._confirmStore = null;
  engine._emitEvent = () => {};
  engine.getSessionPermissionMode = () => permission;
  engine.getSessionAllowedInvocationCapabilities = () => [];
  engine.getSessionIdForPath = () => sessionId;
  const executionRegistry = new SessionExecutionRegistry();
  engine._sessionExecutions = executionRegistry;
  const built = engine.buildTools(workspace, [], {
    agentDir, workspace, getSessionPath: () => sessionPath,
    getSessionId: () => sessionId, getPermissionMode: () => permission,
  });
  const tool = built.customTools.find((entry) => entry.name === (deferred ? "mcp_call" : h.tool.name));
  assert.ok(tool);
  return {
    engine, tool, dir, workspace, sessionId, registry: executionRegistry,
    args: (values) => deferred ? { server: "remote", tool: "remote_write", arguments: values } : values,
    dispose: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

// Real Hana session-options + installed Pi AgentSession/Agent. Only the model's
// stream is synthetic; no LLM endpoint, extension or user file is accessed.
export async function sdkSession(e: ReturnType<typeof makeEngine>, args = {}) {
  const registry = await createModelRegistry(AuthStorage.inMemory());
  const requests = [], events = [];
  registerModelProvider(registry, "mcp-http-test", {
    baseUrl: "https://fixture.invalid/v1", api: "openai-completions", apiKey: "fixture-only",
    models: [{ id: "mock", name: "Mock", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 4096 }],
    streamSimple: (model, context) => {
      requests.push(structuredClone(context));
      const first = requests.length === 1;
      const message: AssistantMessage & { stopReason: "toolUse" | "stop" } = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
        usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 5,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        content: first ? [{ type: "toolCall", id: "fixture-call", name: e.tool.name, arguments: e.args(args) }]
          : [{ type: "text", text: "done" }],
        stopReason: first ? "toolUse" : "stop",
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: message.stopReason, message });
      stream.end(message);
      return stream;
    },
  });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
  const resourceLoader = new DefaultResourceLoader({
    cwd: e.workspace, agentDir: e.dir, settingsManager, systemPrompt: "Local MCP fixture",
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd: e.workspace, agentDir: e.dir, modelRegistry: registry, model: registry.find("mcp-http-test", "mock"),
    resourceLoader, settingsManager, sessionManager: SessionManager.inMemory(e.workspace), tools: [], customTools: [e.tool],
  });
  session.subscribe((event) => events.push(event));
  const outcome = () => ({
    event: events.find((event) => event.type === "tool_execution_end"),
    canonical: session.agent.state.messages.find((message) => message.role === "toolResult"),
    provider: requests[1]?.messages?.find((message) => message.role === "toolResult"),
  });
  return { session, requests, events, outcome,
    async run() { await session.prompt("Execute the local fixture"); return outcome(); },
    dispose: () => session.dispose(),
  };
}
