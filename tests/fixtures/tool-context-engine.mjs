import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { HanaEngine } from "../../core/engine.ts";
import { EventBus } from "../../hub/event-bus.ts";
import { registerModelProvider, Type } from "../../lib/pi-sdk/index.ts";
import { SESSION_MEMORY_SCOPE_RECORD } from "../../core/session-memory-scope.ts";
import { createSessionTurnContextExtension } from "../../core/session-turn-context.ts";
import { providers, events, transport, finished } from "./tool-context-provider.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-context-engine-"));
const home = path.join(dir, "hana"), workspace = path.join(dir, "workspace"), product = path.join(dir, "product");
const agentDir = path.join(home, "agents", "fixture"), pluginDir = path.join(home, "plugins", "fixture");
for (const p of [workspace, agentDir, path.join(product, "yuan"), path.join(pluginDir, "tools")]) fs.mkdirSync(p, { recursive: true });
fs.writeFileSync(path.join(product, "yuan", "hanako.md"), "Synthetic fixture persona");
fs.writeFileSync(path.join(agentDir, "AGENTS.md"), "Synthetic fixture");
fs.writeFileSync(path.join(agentDir, "config.yaml"), JSON.stringify({ agent: { name: "Fixture" }, memory: { enabled: false },
  experience: { enabled: false }, heartbeat: { enabled: false }, desk: { home_folder: workspace } }));
fs.writeFileSync(path.join(pluginDir, "tools", "parent.js"), `
  export const name = "file_parent";
  export const description = "Synthetic nested context fixture";
  export const parameters = { type: "object", properties: {} };
  export const sessionPermission = { kind: "read" };
  export async function execute(args, ctx) { return globalThis.__hanaContextParent(null, args, ctx.signal, null, ctx); }
`);

let network = 0, current;
globalThis.fetch = async () => { network++; throw new Error("External fetch forbidden by context fixture"); };
const require = createRequire(import.meta.url);
const { BedrockRuntimeClient } = require("@aws-sdk/client-bedrock-runtime");
const originalSend = BedrockRuntimeClient.prototype.send;
// AWS's decoded send result is mocked; binary AWS transport is outside this test.
BedrockRuntimeClient.prototype.send = async () => ({ $metadata: { httpStatusCode: 200 },
  stream: (async function* () { yield* events("bedrock-converse-stream", current.parentName); })() });
const engine = new HanaEngine({ hanakoHome: home, productDir: product, agentId: "fixture" });
engine._getResolvedExternalSkillPaths = () => [];
const rows = [];
const permission = kind => ({ resolveInvocation: () => ({ action: "execute", kind, capability: "child.execute",
  target: { type: "background_task", id: current.target, label: current.target } }) });

async function parent(id, _args, signal, _update, ctx) {
  current.parentCount++;
  current.parentId = id;
  current.parentCtx = ctx;
  current.parentSignal = signal;
  current.contextSignal = ctx.signal;
  current.executeToolType = typeof ctx.executeTool;
  current.descriptors = { executeEnumerable: Object.getOwnPropertyDescriptor(ctx, "executeTool")?.enumerable,
    toolsGetter: typeof Object.getOwnPropertyDescriptor(ctx, "tools")?.get,
    modelGetter: typeof Object.getOwnPropertyDescriptor(ctx, "model")?.get };
  if (current.scenario === "scope") ctx.sessionManager.appendCustomEntry(SESSION_MEMORY_SCOPE_RECORD,
    { memoryScope: { version: 1, realm: "story", agentId: "fixture", worldId: "world", branchId: "branch", knowledge: "shared" } });
  if (current.scenario === "cancel") current.aborting = current.session.abort();
  const outcome = await ctx.executeTool("fixture_child", { value: 7 });
  current.nested = outcome;
  return { ...outcome.result, isError: outcome.isError };
}
globalThis.__hanaContextParent = parent;

try {
  await engine.init();
  await engine.initPlugins(new EventBus());
  engine.pluginManager.addTool("fixture", { name: "dynamic_parent", description: "Nested dynamic Pi tool",
    parameters: Type.Object({}), invocationStyle: "pi_tool", sessionPermission: { kind: "read" }, execute: parent });
  const snapshot = engine.agent.getToolsSnapshot.bind(engine.agent);
  engine.agent.getToolsSnapshot = (...args) => [...snapshot(...args),
    { name: "fixture_parent", label: "Parent", description: "Nested parent", _pluginId: "fixture", parameters: Type.Object({}),
      sessionPermission: { kind: "read" }, execute: parent },
    { name: "fixture_child", label: "Child", description: "Nested child", _pluginId: "fixture",
      parameters: Type.Object({ value: Type.Number() }), sessionPermission: permission("review"),
      execute: async (id, args, signal, _update, ctx) => {
        current.childCount++;
        current.childId = id;
        current.childSignal = signal;
        current.childContextSignal = ctx.signal;
        current.childSessionId = ctx.sessionId;
        current.childSessionPath = ctx.sessionPath;
        if (current.scenario === "child-error") throw new Error("synthetic child error");
        return { content: [{ type: "text", text: `child:${args.value}` }], details: { value: args.value } };
      } },
  ];
  // Supply a synthetic extension through the loader, as the installed SDK does
  // at session creation. The real runner executes both parent and child hooks.
  const extension = createSessionTurnContextExtension({ path: "context-fixture" });
  extension.handlers.set("tool_call", [async event => {
      current.hooks.push({ type: "tool_call", name: event.toolName, id: event.toolCallId, parent: event.parentToolCallId });
      if (current.scenario === "hook-block" && event.toolName === "fixture_child") return { block: true, reason: "synthetic hook denial" };
    }]);
  extension.handlers.set("tool_result", [async event => {
      current.hooks.push({ type: "tool_result", name: event.toolName, id: event.toolCallId, parent: event.parentToolCallId, isError: event.isError });
    }]);
  const getExtensions = engine._resourceLoader.getExtensions.bind(engine._resourceLoader);
  engine._resourceLoader.getExtensions = () => {
    const loaded = getExtensions();
    return { ...loaded, extensions: [...loaded.extensions, extension] };
  };
  engine._approvalGateway = { review: async () => {
    current.approvals++;
    if (current.scenario === "approval-drift") current.target = "changed-target";
    return { action: current.scenario === "deny" ? "deny" : "allow", reason: "synthetic review", reviewer: "fixture", risk: "low" };
  } };

  const cases = Object.keys(providers).map(api => ({ api, scenario: "success", parentName: "fixture_parent" }));
  for (const parentName of ["fixture_dynamic_parent", "fixture_file_parent"]) cases.push({ api: "openai-completions", scenario: "success", parentName });
  for (const scenario of ["deny", "read-only", "scope", "cancel", "approval-drift", "hook-block", "child-error"])
    cases.push({ api: "openai-completions", scenario, parentName: "fixture_parent" });
  for (const spec of cases) {
    current = { ...spec, parentCount: 0, childCount: 0, requests: 0, hooks: [], approvals: 0, target: "original-target" };
    registerModelProvider(engine.modelRegistry, "context-fixture", {
      baseUrl: "https://fixture.invalid/v1", api: spec.api, apiKey: "synthetic-only",
      models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
      streamSimple: (model, context, options) => ++current.requests > 1 ? finished(model)
        : providers[spec.api](model, context, { ...options, apiKey: "synthetic-only", region: "us-east-1", env: {}, maxRetries: 0,
          fetch: async () => transport(spec.api, spec.parentName) }),
    });
    const { session } = await engine.createSession(null, workspace, false, engine.modelRegistry.find("context-fixture", "fixture"),
      { permissionMode: spec.scenario === "read-only" ? "read_only" : "auto", focus: false });
    current.session = session;
    const observed = [];
    session.subscribe(event => { if (event.type.startsWith("tool_execution_")) observed.push(event); });
    await session.prompt("Run the isolated context fixture");
    await current.aborting;
    await session.waitForIdle();
    const parentEnd = observed.find(e => e.type === "tool_execution_end" && !e.parentToolCallId);
    const childStart = observed.find(e => e.type === "tool_execution_start" && e.parentToolCallId);
    const row = { ...spec, parentCount: current.parentCount, childCount: current.childCount, requests: current.requests,
      executeToolType: current.executeToolType, descriptors: current.descriptors,
      nested: current.nested, parentEnd, childStart, hooks: current.hooks, approvals: current.approvals,
      sessionBound: !!current.childSessionId && current.childSessionId === current.parentCtx.sessionId
        && current.childSessionPath === current.parentCtx.sessionPath,
      signals: { parent: current.parentSignal instanceof globalThis.AbortSignal, child: current.childSignal instanceof globalThis.AbortSignal,
        defaultShared: !!current.contextSignal && current.contextSignal === current.childContextSignal,
        parentAborted: current.parentSignal?.aborted, contextAborted: current.contextSignal?.aborted },
    };
    // Real installed runner invalidation must still guard captured descriptors.
    if (current.parentCtx && spec.scenario === "success") {
      session.extensionRunner.invalidate("fixture stale runner");
      try { void current.parentCtx.tools; row.staleTools = false; } catch (error) { row.staleTools = /fixture stale runner/.test(error.message); }
      try { void current.parentCtx.model; row.staleModel = false; } catch (error) { row.staleModel = /fixture stale runner/.test(error.message); }
      try { await current.parentCtx.executeTool("fixture_child", { value: 8 }); row.staleExecute = false; }
      catch (error) { row.staleExecute = /fixture stale runner/.test(error.message); }
      assert.equal(current.childCount, row.childCount);
    }
    rows.push(row);
  }
  assert.equal(network, 0);
  assert.equal(engine._computerHost, null);
  globalThis.console.log("CONTEXT_RESULTS " + JSON.stringify({ rows, network, computerHost: null }));
} finally {
  await engine.dispose();
  // This standalone fixture also owns the workspace history watcher.
  await engine.getFileHistoryService().close();
  BedrockRuntimeClient.prototype.send = originalSend;
  delete globalThis.__hanaContextParent;
  fs.rmSync(dir, { recursive: true, force: true });
}
