import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";

// Run the real nested shutdown function with isolated host I/O. This does not
// import server/index.ts (which would start the full application).
const source = fs.readFileSync(new URL("../server/index.ts", import.meta.url), "utf8");
const parsed = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true);
const functions = new Map<string, string>();
let shutdown = "";
const find = (node: ts.Node) => {
  if (ts.isFunctionDeclaration(node) && node.name) {
    functions.set(node.name.text, node.getText(parsed));
    if (node.name.text === "gracefulShutdown") shutdown = node.getText(parsed);
  }
  ts.forEachChild(node, find);
};
find(parsed);
if (!shutdown) throw new Error("Missing server gracefulShutdown implementation");
const runnable = ts.transpileModule(shutdown.replace('await import("../lib/browser/browser-manager.ts")', "browserModule"), {
  compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
}).outputText;
function fixture(stopAll: () => unknown, options: { suspend?: () => Promise<void>; flushThrows?: boolean } = {}) {
  const events: string[] = [];
  const exit = vi.fn((code: number) => { events.push(`exit:${code}`); });
  const dispose = vi.fn(async () => { events.push("hub disposed"); });
  const context = vm.createContext({
    _shutting: false, bridgeStopping: false, bridgeManagerInitPromise: null, setTimeout, clearTimeout, Date,
    log: { log: vi.fn(), error: vi.fn(), warn: vi.fn() }, dlog: { log: vi.fn(), error: vi.fn() },
    process: { exit }, server: { close: () => events.push("http closed") },
    browserModule: { BrowserManager: { instance: () => ({ runningSessions: options.suspend ? ["synthetic"] : [], suspendForSession: options.suspend }) } },
    bridgeManager: { shutdown: () => { events.push("bridge stop"); return stopAll(); } },
    engine: { deferredResults: { dispose: () => { events.push("deferred disposed"); if (options.flushThrows) throw new Error("synthetic flush failure"); } } },
    workflowActivityStore: { flush: () => events.push("activity flushed") },
    hub: { dispose }, fs: { unlinkSync: () => events.push("discovery removed") }, path: { join: () => "synthetic" }, hanakoHome: "synthetic",
  });
  vm.runInContext(runnable, context);
  return { run: () => context.gracefulShutdown() as Promise<void>, events, exit, dispose };
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
afterEach(() => { vi.useRealTimers(); });

describe("Server waits owned bridge resources before exit", () => {
  it("waits the actual bridge stop promise before cleanup and successful exit", async () => {
    const gate = deferred(); const f = fixture(() => gate.promise); const running = f.run();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(f.events).toEqual(["http closed", "bridge stop"]); expect(f.exit).not.toHaveBeenCalled();
    gate.resolve(); await running;
    expect(f.events).toEqual(["http closed", "bridge stop", "deferred disposed", "activity flushed", "hub disposed", "discovery removed", "exit:0"]);
  });
  it("invalidates existing bindings before waiting for browser suspension", async () => {
    const browser = deferred(); const bridge = deferred();
    const f = fixture(() => bridge.promise, { suspend: () => browser.promise });
    const running = f.run();
    expect(f.events).toContain("bridge stop");
    expect(f.exit).not.toHaveBeenCalled();
    bridge.resolve(); browser.resolve(); await running;
    expect(f.exit).toHaveBeenCalledExactlyOnceWith(0);
  });
  it("continues other cleanup after failed bridge teardown and exits with failure", async () => {
    const f = fixture(() => Promise.reject(new Error("synthetic worker exit failure")));
    await f.run();
    expect(f.events).toContain("activity flushed"); expect(f.dispose).toHaveBeenCalledOnce();
    expect(f.exit).toHaveBeenCalledExactlyOnceWith(1);
  });
  it("continues hub cleanup after a failed deferred flush and exits with failure", async () => {
    const f = fixture(() => Promise.resolve(), { flushThrows: true });
    await f.run(); expect(f.dispose).toHaveBeenCalledOnce(); expect(f.exit).toHaveBeenCalledExactlyOnceWith(1);
  });
  it("shares the original 15-second shutdown budget with preceding browser cleanup", async () => {
    vi.useFakeTimers(); const browser = deferred(); const bridge = deferred();
    const f = fixture(() => bridge.promise, { suspend: () => browser.promise }); const running = f.run();
    await vi.advanceTimersByTimeAsync(14_000); expect(f.exit).not.toHaveBeenCalled();
    browser.resolve(); await vi.advanceTimersByTimeAsync(0);
    expect(f.events).toContain("bridge stop");
    await vi.advanceTimersByTimeAsync(1_000); expect(f.exit).toHaveBeenCalledExactlyOnceWith(1);
    bridge.resolve(); await running;
  });
});


describe("Server bridge initialization during shutdown", () => {
  it("does not create or autoStart a binding after the pending import resolves during shutdown", async () => {
    let resolve!: (value: unknown) => void;
    const bridgeModule = new Promise(yes => { resolve = yes; });
    const autoStart = vi.fn();
    const construct = vi.fn();
    class BridgeManager { constructor() { construct(); } autoStart = autoStart; }
    const context = vm.createContext({
      bridgeStopping: false, bridgeManager: null, bridgeManagerInitPromise: null, bridgeManagerInitError: null,
      bridgeAutoStartRequested: false, bridgeAutoStartDone: false, bridgeModule,
      engine: { agents: new Map() }, hub: {},
      log: { log: vi.fn(), error: vi.fn() }, dlog: { log: vi.fn(), error: vi.fn() },
    });
    const initialization = [functions.get("runBridgeAutoStart"), functions.get("startBridgeManager")].join("\n")
      .replace('await import("../lib/bridge/bridge-manager.ts")', "await bridgeModule");
    vm.runInContext(ts.transpileModule(initialization, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText, context);
    const starting = context.startBridgeManager({ autoStart: true });
    context.bridgeStopping = true;
    resolve({ BridgeManager }); await starting;
    expect(construct).not.toHaveBeenCalled(); expect(autoStart).not.toHaveBeenCalled();
    expect(context.bridgeManager).toBeNull();
    await expect(context.startBridgeManager({ autoStart: true })).resolves.toBeNull();
    expect(construct).not.toHaveBeenCalled();
  });
});
