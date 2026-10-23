import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/bridge/telegram-adapter.ts", () => ({ createTelegramAdapter: vi.fn() }));
vi.mock("../lib/bridge/feishu-adapter.ts", () => ({ createFeishuAdapter: vi.fn() }));
vi.mock("../lib/bridge/dingtalk-adapter.ts", () => ({ createDingTalkAdapter: vi.fn() }));
vi.mock("../lib/bridge/qq-adapter.ts", () => ({ createQQAdapter: vi.fn() }));
vi.mock("../lib/bridge/wechat-adapter.ts", () => ({ createWechatAdapter: vi.fn() }));
vi.mock("../lib/debug-log.ts", () => ({ debugLog: () => null, createModuleLogger: () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock("../core/llm-client.ts", () => ({ callText: vi.fn() }));

import { BridgeManager } from "../lib/bridge/bridge-manager.ts";
import { createTelegramAdapter } from "../lib/bridge/telegram-adapter.ts";
import { createSlashSystem } from "../core/slash-commands/index.ts";
import type { SlashCommandDispatcher } from "../core/slash-command-dispatcher.ts";
import { RcStateStore } from "../core/slash-commands/rc-state.ts";

const key = "tg_dm_owner@a";
const compactResult = { tokensBefore: 10, tokensAfter: 5 };
const cleanup: Array<() => void> = [];
const managers: BridgeManager[] = [];
function deferred<T>(fallback: T) {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  cleanup.push(() => resolve(fallback));
  return { promise, resolve, reject };
}

function fixture() {
  const engine = {
    hanakoHome: os.tmpdir(), agentName: "Synthetic", currentAgentId: "a",
    slashDispatcher: null as SlashCommandDispatcher | null,
    rcState: new RcStateStore(),
    getAgent: vi.fn((id: string) => ({ id, sessionDir: os.tmpdir(), config: { bridge: { telegram: { owner: "owner" } } } })),
    getBridgeReceiptEnabled: vi.fn(() => false),
    isBridgeSessionStreaming: vi.fn(() => false), isSessionStreaming: vi.fn(() => false),
    steerBridgeSession: vi.fn(() => false), ensureSessionLoaded: vi.fn(async () => ({})), emitEvent: vi.fn(),
    compactBridgeSession: vi.fn(async () => compactResult),
    compactDesktopSession: vi.fn(async () => compactResult),
    freshCompactBridgeSession: vi.fn(async () => compactResult),
    abortBridgeSession: vi.fn(async () => true),
    bridgeSessionManager: {
      readIndex: vi.fn(() => ({ [key]: {} })), writeIndex: vi.fn(),
    },
    getRuntimeContext: () => ({ studioId: "synthetic-studio" }),
    automationSuggestionStore: { apply: vi.fn(async () => ({ ok: true, suggestion: { title: "Synthetic" } })) },
    confirmStore: { get: vi.fn(() => ({})), resolve: vi.fn(() => true) },
    listSessions: vi.fn(async () => [{ path: "/synthetic/current.jsonl", agentId: "a", title: "Synthetic", modified: 0 }]),
    loopController: {
      targetFromSessionRef: vi.fn(async () => ({ sessionKey: key })),
      start: vi.fn(async () => {}), stop: vi.fn(async () => {}),
      pause: vi.fn(async () => {}), resume: vi.fn(async () => {}),
      statusForTarget: vi.fn(() => null),
    },
  };
  const hub = {
    send: vi.fn(async () => ({ text: "synthetic reply", toolMedia: [] })),
    subscribe: vi.fn(() => vi.fn()), eventBus: { emit: vi.fn() },
  };
  // Real registry (including aliases), dispatcher and sessionOps; only external endpoints are synthetic.
  const system = createSlashSystem({ engine, hub });
  engine.slashDispatcher = system.dispatcher;
  engine.rcState = system.rcState;
  const bm = new BridgeManager({ engine, hub }); managers.push(bm);
  function start(sendReply = vi.fn(async () => {})) {
    const adapter = { sendReply, stop: vi.fn() };
    vi.mocked(createTelegramAdapter, { partial: true }).mockReturnValueOnce(adapter);
    bm.startPlatform("telegram", { token: "SYNTHETIC_ONLY" }, "a");
    const hooks = vi.mocked(createTelegramAdapter).mock.calls.at(-1)![0];
    const send = (text: string) => hooks.onMessage({ text, sessionKey: key, agentId: "a", userId: "owner", chatId: "owner", isGroup: false });
    return { adapter, send };
  }
  return { bm, engine, hub, start, rcState: system.rcState };
}

type Fixture = ReturnType<typeof fixture>;
const cases = [
  { command: "compact", attached: false, endpoint: "compactBridgeSession" },
  { command: "fresh-compact", attached: false, endpoint: "freshCompactBridgeSession" },
  { command: "freshcompact", attached: false, endpoint: "freshCompactBridgeSession" },
  { command: "compact", attached: true, endpoint: "compactDesktopSession" },
] as const;
function attach(f: Fixture, attached: boolean) {
  if (attached) f.rcState.attach(key, "/synthetic/desktop.jsonl");
}
const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);
function drained(f: Fixture) {
  expect(f.bm._pending.size).toBe(0);
  expect(f.bm._processing.size).toBe(0);
  expect(f.bm._processingOwners?.size ?? 0).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
}

describe("Bridge slash operation admission across binding lifetimes", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); });
  afterEach(async () => {
    for (const resolve of cleanup.splice(0)) resolve();
    await tick(200);
    for (const bm of managers.splice(0)) bm.stopAll();
    vi.clearAllTimers(); vi.restoreAllMocks(); vi.useRealTimers();
  });

  for (const spec of cases) {
    for (const transition of ["stop", "stopAll", "replace"] as const) {
      it.each(["resolve", "reject"])(`${spec.command} (${spec.endpoint}) does not start after ${transition} while receipt awaits %s`, async outcome => {
        const f = fixture(); const receipt = deferred<void>(undefined);
        const old = f.start(vi.fn(() => receipt.promise)); attach(f, spec.attached);
        const work = old.send("/" + spec.command); await tick();
        expect(old.adapter.sendReply).toHaveBeenCalledOnce();
        expect(f.engine[spec.endpoint]).not.toHaveBeenCalled();
        if (transition === "replace") f.start();
        else if (transition === "stopAll") f.bm.stopAll();
        else f.bm.stopPlatform("telegram", "a");
        if (outcome === "resolve") receipt.resolve(); else receipt.reject(new Error("synthetic receipt failure"));
        await work;
        expect(f.engine[spec.endpoint]).not.toHaveBeenCalled();
        expect(old.adapter.sendReply).toHaveBeenCalledOnce();
        // A new binding must still admit this same command through the real facade.
        const fresh = f.start(); attach(f, spec.attached);
        await fresh.send("/" + spec.command);
        expect(f.engine[spec.endpoint]).toHaveBeenCalledOnce();
        expect(fresh.adapter.sendReply).toHaveBeenCalledTimes(2);
        expect(f.hub.send).not.toHaveBeenCalled(); drained(f);
      });
    }

    it(`${spec.command} (${spec.endpoint}) proceeds when a current binding's receipt rejects`, async () => {
      const f = fixture();
      const active = f.start(vi.fn(async () => {}).mockRejectedValueOnce(new Error("synthetic receipt failure")));
      attach(f, spec.attached); await active.send("/" + spec.command);
      expect(f.engine[spec.endpoint]).toHaveBeenCalledOnce();
      expect(active.adapter.sendReply).toHaveBeenCalledTimes(2); drained(f);
    });

    it.each(["resolve", "reject"])(`${spec.command} (${spec.endpoint}) already started before replacement may %s without another old reply`, async outcome => {
      const f = fixture(); const operation = deferred(compactResult);
      f.engine[spec.endpoint].mockImplementationOnce(() => operation.promise);
      const old = f.start(); attach(f, spec.attached);
      const work = old.send("/" + spec.command); await tick();
      expect(f.engine[spec.endpoint]).toHaveBeenCalledOnce();
      const fresh = f.start(); attach(f, spec.attached);
      await fresh.send("/" + spec.command);
      expect(f.engine[spec.endpoint]).toHaveBeenCalledTimes(2);
      if (outcome === "resolve") operation.resolve(compactResult); else operation.reject(new Error("synthetic operation failure"));
      await work;
      expect(f.engine[spec.endpoint]).toHaveBeenCalledTimes(2);
      expect(old.adapter.sendReply).toHaveBeenCalledOnce();
      expect(fresh.adapter.sendReply).toHaveBeenCalledTimes(2); drained(f);
    });
  }

  it.each(["start", "stop", "pause", "resume"] as const)("loop %s target await cannot mutate the replacement lifecycle", async action => {
    const f = fixture(); const target = deferred({ sessionKey: key });
    f.engine.loopController.targetFromSessionRef.mockImplementationOnce(() => target.promise);
    const old = f.start(); const text = action === "start" ? "/loop synthetic task" : "/loop " + action;
    const work = old.send(text); await tick();
    expect(f.engine.loopController[action]).not.toHaveBeenCalled();
    const fresh = f.start(); await fresh.send(text);
    expect(f.engine.loopController[action]).toHaveBeenCalledOnce();
    target.resolve({ sessionKey: key }); await work;
    expect(f.engine.loopController[action]).toHaveBeenCalledOnce();
    expect(old.adapter.sendReply).not.toHaveBeenCalled();
    expect(fresh.adapter.sendReply).toHaveBeenCalledOnce(); drained(f);
  });

  it("RC listing continuation cannot overwrite a new binding's pending selection", async () => {
    const f = fixture(); const listing = deferred<Awaited<ReturnType<typeof f.engine.listSessions>>>([]);
    f.engine.listSessions.mockImplementationOnce(() => listing.promise);
    const old = f.start(); const work = old.send("/rc"); await tick();
    const fresh = f.start(); await fresh.send("/rc");
    const pending = f.rcState.getPending(key);
    expect(pending?.options[0].path).toBe("/synthetic/current.jsonl");
    listing.resolve([{ path: "/synthetic/old.jsonl", agentId: "a", title: "Old", modified: 0 }]); await work;
    expect(f.rcState.getPending(key)).toBe(pending);
    expect(old.adapter.sendReply).not.toHaveBeenCalled();
    expect(fresh.adapter.sendReply).toHaveBeenCalledOnce(); drained(f);
  });

  const immediateCommands = ["stop", "new", "reset", "exitrc", "apply", "confirm synthetic", "reject synthetic"];
  it.each(immediateCommands)("/%s is blocked before old handler entry and allowed for the replacement", async command => {
    const f = fixture();
    const reset = vi.spyOn(f.rcState, "reset");
    const endpoint = command === "stop" ? f.engine.abortBridgeSession
      : command === "new" || command === "reset" ? f.engine.bridgeSessionManager.writeIndex
        : command === "exitrc" ? reset
          : command === "apply" ? f.engine.automationSuggestionStore.apply : f.engine.confirmStore.resolve;
    const old = f.start();
    const work = old.send("/" + command);
    // No timer flush: invalidate the binding before the dispatcher's handler microtask.
    const fresh = f.start(); await work;
    expect(endpoint).not.toHaveBeenCalled();
    await old.send("/" + command);
    expect(endpoint).not.toHaveBeenCalled();
    await fresh.send("/" + command);
    expect(endpoint).toHaveBeenCalledOnce();
    expect(old.adapter.sendReply).not.toHaveBeenCalled(); drained(f);
  });
});
