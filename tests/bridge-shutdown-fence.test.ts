import fs from "node:fs";
import os from "node:os";
import vm from "node:vm";
import ts from "typescript";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const factory = vi.hoisted(() => vi.fn());
vi.mock("../lib/bridge/feishu-worker-adapter.ts", () => ({ createFeishuWorkerAdapter: factory }));
vi.mock("../lib/debug-log.ts", () => ({ debugLog: () => null, createModuleLogger: () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
import { BridgeManager } from "../lib/bridge/bridge-manager.ts";
import { createBridgeRoute } from "../server/routes/bridge.ts";

type Config = { enabled?: boolean; appId?: string; appSecret?: string };
const credentials = { appId: "synthetic", appSecret: "synthetic" };
const configuration = { platform: "feishu", enabled: true, credentials };
const managers: BridgeManager[] = [];
function fixture() {
  const bridge: Record<string, Config> = {};
  const agent = { id: "a", config: { bridge }, updateConfig: vi.fn((patch: { bridge: Record<string, Config> }) => { Object.assign(bridge, patch.bridge); }) };
  const engine = { hanakoHome: os.tmpdir(), currentAgentId: "a", getAgent: () => agent };
  const bm = new BridgeManager({ engine, hub: { eventBus: { emit: vi.fn() } } }); managers.push(bm);
  return { bm, engine, agent };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function configuredApp(engine: ReturnType<typeof fixture>["engine"], ref: unknown) {
  const app = new Hono(); app.route("/api", createBridgeRoute(engine, ref)); return app;
}
const post = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(configuration) };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
beforeEach(() => { factory.mockReset(); factory.mockImplementation(() => ({ stop: vi.fn() })); });
afterEach(async () => { await Promise.allSettled(managers.splice(0).map(bm => bm.stopAll())); });

// Exercise exactly the server's closure and ref object, without importing or
// starting the whole server; only browser/filesystem/process host I/O is fake.
const source = fs.readFileSync(new URL("../server/index.ts", import.meta.url), "utf8");
const parsed = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true);
let shutdownSource = "", refSource = "";
function visit(node: ts.Node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === "gracefulShutdown") shutdownSource = node.getText(parsed);
  if (ts.isVariableDeclaration(node) && node.name.getText(parsed) === "bridgeManagerRef") refSource = node.initializer.getText(parsed);
  ts.forEachChild(node, visit);
}
visit(parsed);
const compile = (code: string) => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText;
function serverFixture(bm: BridgeManager, browser: Promise<void>, hubDisposal = Promise.resolve()) {
  const exit = vi.fn();
  const context = vm.createContext({
    _shutting: false, bridgeStopping: false, bridgeManager: bm, bridgeManagerInitPromise: null, bridgeManagerInitError: null,
    startBridgeManager: () => bm, setTimeout, clearTimeout, Date,
    log: { log: vi.fn(), warn: vi.fn(), error: vi.fn() }, dlog: { log: vi.fn(), error: vi.fn() },
    server: { close: vi.fn() }, process: { exit },
    browserModule: { BrowserManager: { instance: () => ({ runningSessions: ["synthetic"], suspendForSession: () => browser }) } },
    engine: { deferredResults: { dispose: vi.fn() } }, workflowActivityStore: { flush: vi.fn() }, hub: { dispose: vi.fn(() => hubDisposal) },
    fs: { unlinkSync: vi.fn() }, path: { join: () => "synthetic" }, hanakoHome: "synthetic",
  });
  vm.runInContext(compile(shutdownSource.replace('await import("../lib/browser/browser-manager.ts")', "browserModule")), context);
  const ref = vm.runInContext(compile(`(${refSource})`), context);
  return { context, exit, ref, run: () => context.gracefulShutdown() as Promise<void> };
}

describe("Bridge terminal shutdown creation fence", () => {
  it.each(["direct", "config", "automatic"] as const)("rejects %s creation during and after shutdown without reviving entries", async entry => {
    const { bm } = fixture(); const exit = deferred<void>();
    factory.mockReturnValueOnce({ stop: () => exit.promise }); bm.startPlatform("feishu", credentials, "a");
    const stopping = bm.shutdown(); expect(bm.isShuttingDown()).toBe(true);
    const create = () => {
      if (entry === "direct") return bm.startPlatform("feishu", credentials, "a");
      if (entry === "config") return bm.startPlatformFromConfig("feishu", { enabled: true, ...credentials }, "a");
      return bm.autoStart(new Map([["a", { config: { bridge: { feishu: { enabled: true, ...credentials } } } }]]));
    };
    for (const operation of [create, () => bm.startPlatformFromConfig("dingtalk", { enabled: true }, "a")]) {
      expect(operation).toThrow(expect.objectContaining({ code: "BRIDGE_MANAGER_SHUTTING_DOWN" }));
    }
    expect(factory).toHaveBeenCalledOnce(); expect(bm.getStatus(undefined)).toEqual({});
    expect(bm.shutdown()).toBe(stopping); exit.resolve(); await stopping;
    await bm.stopAll(); expect(create).toThrow(expect.objectContaining({ code: "BRIDGE_MANAGER_SHUTTING_DOWN" }));
    expect(factory).toHaveBeenCalledOnce();
  });
  it("retains ordinary stopAll restart semantics and isolates another manager", async () => {
    const first = fixture(), other = fixture();
    first.bm.startPlatform("feishu", credentials, "a"); await first.bm.stopAll();
    first.bm.startPlatform("feishu", credentials, "a"); expect(factory).toHaveBeenCalledTimes(2);
    await first.bm.shutdown(); other.bm.startPlatform("feishu", credentials, "a");
    expect(factory).toHaveBeenCalledTimes(3); expect(other.bm.getStatus("a").feishu.status).toBe("connecting");
  });
  it("keeps failed shutdown rejected, drains every binding, and never reopens creation", async () => {
    const { bm } = fixture(); const exit = deferred<void>();
    const failedStop = vi.fn(() => { throw new Error("synthetic failed exit"); });
    const pendingStop = vi.fn(() => exit.promise);
    factory.mockReturnValueOnce({ stop: failedStop }).mockReturnValueOnce({ stop: pendingStop });
    bm.startPlatform("feishu", credentials, "a"); bm.startPlatform("feishu", credentials, "b");
    const stopping = bm.shutdown(); let settled = false; void stopping.catch(() => { settled = true; });
    expect(failedStop).toHaveBeenCalledOnce(); expect(pendingStop).toHaveBeenCalledOnce();
    await tick(); expect(settled).toBe(false);
    expect(() => bm.startPlatform("feishu", credentials, "c")).toThrow(expect.objectContaining({ code: "BRIDGE_MANAGER_SHUTTING_DOWN" }));
    exit.resolve(); await expect(stopping).rejects.toThrow("Bridge teardown failed"); expect(bm.shutdown()).toBe(stopping);
  });
  it("shares the complete drain with a shutdown requested from a synchronous status observer", async () => {
    const { bm } = fixture(); const exit = deferred<void>();
    factory.mockReturnValueOnce({ stop: vi.fn() }).mockReturnValueOnce({ stop: () => exit.promise });
    bm.startPlatform("feishu", credentials, "a"); bm.startPlatform("feishu", credentials, "b");
    let reentered: Promise<void> | undefined;
    bm._hub.eventBus.emit.mockImplementation(() => { reentered ??= bm.shutdown(); });
    const stopping = bm.shutdown();
    try {
      expect(reentered).toBe(stopping);
      let settled = false; void reentered.then(() => { settled = true; });
      await tick(); expect(settled).toBe(false);
    } finally { exit.resolve(); await stopping; }
  });
});

describe("Bridge configuration requests while server shutdown drains", () => {
  it("rejects an already accepted body resumed during browser suspension without persisting or constructing", async () => {
    const { bm, engine, agent } = fixture(); const browser = deferred<void>(); const server = serverFixture(bm, browser.promise);
    const app = configuredApp(engine, server.ref);
    let body!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(controller) { body = controller; } });
    const init: RequestInit & { duplex: "half" } = { method: "POST", headers: post.headers, body: stream, duplex: "half" };
    const request = app.request(new Request("http://local/api/bridge/config?agentId=a", init)); await tick();
    const stopping = server.run();
    try {
      body.enqueue(new TextEncoder().encode(post.body)); body.close(); const response = await request;
      expect(response.status).toBe(503); expect(factory).not.toHaveBeenCalled(); expect(agent.updateConfig).not.toHaveBeenCalled();
      expect(bm.getStatus(undefined)).toEqual({}); expect(server.exit).not.toHaveBeenCalled();
    } finally { browser.resolve(); await stopping; }
    expect(server.exit).toHaveBeenCalledExactlyOnceWith(0);
  });
  it("does not expose an existing manager as ready after the server begins closing", async () => {
    const { bm } = fixture(); const browser = deferred<void>(); const server = serverFixture(bm, browser.promise);
    expect(server.ref.get()).toBe(bm); expect(server.ref.getState()).toMatchObject({ ready: true });
    const stopping = server.run();
    try {
      expect(server.ref.get()).toBeNull();
      expect(server.ref.getState()).toMatchObject({ ready: false, initializing: false, shuttingDown: true });
    } finally { browser.resolve(); await stopping; }
  });
  it("rejects a previously accepted body resumed during hub disposal without persisting or constructing", async () => {
    const { bm, engine, agent } = fixture(); const hub = deferred<void>(); const server = serverFixture(bm, Promise.resolve(), hub.promise);
    const app = configuredApp(engine, server.ref);
    let body!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(controller) { body = controller; } });
    const init: RequestInit & { duplex: "half" } = { method: "POST", headers: post.headers, body: stream, duplex: "half" };
    const request = app.request(new Request("http://local/api/bridge/config?agentId=a", init)); await tick();
    const stopping = server.run(); await tick();
    try {
      expect(server.context.hub.dispose).toHaveBeenCalledOnce(); expect(server.exit).not.toHaveBeenCalled();
      body.enqueue(new TextEncoder().encode(post.body)); body.close(); const response = await request;
      expect(response.status).toBe(503); expect(factory).not.toHaveBeenCalled(); expect(agent.updateConfig).not.toHaveBeenCalled();
      expect(bm.getStatus(undefined)).toEqual({}); expect(server.exit).not.toHaveBeenCalled();
    } finally { hub.resolve(); await stopping; }
    expect(server.exit).toHaveBeenCalledExactlyOnceWith(0);
  });
  it("rejects disabled configuration writes through a stale shutdown manager reference", async () => {
    const { bm, engine, agent } = fixture(); await bm.shutdown();
    const app = configuredApp(engine, { get: () => bm, getState: () => ({ ready: true }) });
    const response = await app.request("/api/bridge/config?agentId=a", { ...post, body: JSON.stringify({ ...configuration, enabled: false }) });
    expect(response.status).toBe(503); expect(agent.updateConfig).not.toHaveBeenCalled(); expect(factory).not.toHaveBeenCalled();
  });
  it("rejects a stale existing-manager ref even when its ensureReady returns the closed instance", async () => {
    const { bm, engine, agent } = fixture(); await bm.shutdown();
    const ensureReady = vi.fn(() => bm);
    const app = configuredApp(engine, { get: () => bm, ensureReady, getState: () => ({ ready: true }) });
    const response = await app.request("/api/bridge/config?agentId=a", post);
    expect(response.status).toBe(503); expect(ensureReady).not.toHaveBeenCalled();
    expect(agent.updateConfig).not.toHaveBeenCalled(); expect(factory).not.toHaveBeenCalled();
  });
  it("waits for availability before persisting and rejects a late ensureReady result", async () => {
    const { bm, engine, agent } = fixture(); const available = deferred<BridgeManager>(); let closing = false;
    const ensureReady = vi.fn(() => available.promise);
    const app = configuredApp(engine, { get: () => null, ensureReady, getState: () => ({ ready: false, initializing: !closing, shuttingDown: closing }) });
    const request = app.request("/api/bridge/config?agentId=a", post); await tick();
    try {
      expect(ensureReady).toHaveBeenCalledOnce(); expect(agent.updateConfig).not.toHaveBeenCalled();
      closing = true; await bm.shutdown();
    } finally { available.resolve(bm); }
    expect((await request).status).toBe(503); expect(agent.updateConfig).not.toHaveBeenCalled(); expect(factory).not.toHaveBeenCalled();
  });
  it("preserves normal configuration save and binding creation before shutdown", async () => {
    const { bm, engine, agent } = fixture(); const app = configuredApp(engine, bm);
    const response = await app.request("/api/bridge/config?agentId=a", post);
    expect(response.status).toBe(200); expect(agent.updateConfig).toHaveBeenCalledOnce(); expect(factory).toHaveBeenCalledOnce();
    expect(agent.config.bridge.feishu).toMatchObject({ enabled: true, ...credentials });
  });
  it.each(["null", "rejection"] as const)("preserves configuration saving on ordinary manager initialization %s", async outcome => {
    const { engine, agent } = fixture();
    const ensureReady = vi.fn(async () => {
      if (outcome === "rejection") throw new Error("synthetic initialization failure");
      return null;
    });
    const app = configuredApp(engine, { get: () => null, ensureReady, getState: () => ({ ready: false, initializing: false, error: "synthetic initialization failure" }) });
    const response = await app.request("/api/bridge/config?agentId=a", post);
    expect(response.status).toBe(503); expect(agent.updateConfig).toHaveBeenCalledOnce(); expect(factory).not.toHaveBeenCalled();
    expect(agent.config.bridge.feishu).toMatchObject({ enabled: true, ...credentials });
  });
  it("rejects a closed lazy result even when the manager reference and server state are stale", async () => {
    const { bm, engine, agent } = fixture(); await bm.shutdown();
    const app = configuredApp(engine, { get: () => null, ensureReady: async () => bm, getState: () => ({ ready: false, initializing: false }) });
    const response = await app.request("/api/bridge/config?agentId=a", post);
    expect(response.status).toBe(503); expect(agent.updateConfig).not.toHaveBeenCalled(); expect(factory).not.toHaveBeenCalled();
  });
});
