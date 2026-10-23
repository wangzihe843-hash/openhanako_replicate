import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/bridge/telegram-adapter.ts", () => ({ createTelegramAdapter: vi.fn() }));
vi.mock("../lib/bridge/feishu-adapter.ts", () => ({ createFeishuAdapter: vi.fn() }));
vi.mock("../lib/bridge/dingtalk-adapter.ts", () => ({ createDingTalkAdapter: vi.fn() }));
vi.mock("../lib/bridge/qq-adapter.ts", () => ({ createQQAdapter: vi.fn() }));
vi.mock("../lib/bridge/wechat-adapter.ts", () => ({ createWechatAdapter: vi.fn() }));
const logger = vi.hoisted(() => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("../lib/debug-log.ts", () => ({ debugLog: () => logger, createModuleLogger: () => logger }));

import { BridgeManager } from "../lib/bridge/bridge-manager.ts";
import { RcStateStore } from "../core/slash-commands/rc-state.ts";

const cleanups: Array<() => void> = [];
const managers: BridgeManager[] = [];
const reply = { text: "synthetic reply", toolMedia: [] };
function deferred<T>(cleanupValue: T) {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  cleanups.push(() => resolve(cleanupValue));
  return { promise, resolve, reject };
}

function fixture({ attached = true } = {}) {
  const rcState = new RcStateStore();
  const adapter = { sendReply: vi.fn(async () => {}), stop: vi.fn() };
  const unsubscribe = vi.fn();
  const active = new Map<string, number>();
  const peaks = new Map<string, number>();
  const generate = vi.fn(async (_text: string, _identity: string) => reply);
  const hub = {
    subscribe: vi.fn(() => unsubscribe),
    eventBus: { emit: vi.fn() },
    send: vi.fn(async (text: string, opts: Record<string, unknown>) => {
      const identity = String(opts.sessionPath || opts.sessionKey);
      const count = (active.get(identity) || 0) + 1;
      active.set(identity, count);
      peaks.set(identity, Math.max(peaks.get(identity) || 0, count));
      try { return await generate(text, identity); }
      finally { active.set(identity, count - 1); }
    }),
  };
  const engine = {
    rcState,
    getAgent: vi.fn((id: string) => ({ id, agentName: id, sessionDir: os.tmpdir(), config: { bridge: { telegram: { owner: "owner" } } } })),
    getBridgeReceiptEnabled: () => false,
    isBridgeSessionStreaming: vi.fn(() => false),
    steerBridgeSession: vi.fn(() => false),
    ensureSessionLoaded: vi.fn(async () => ({})),
    emitEvent: vi.fn(),
    slashDispatcher: { tryDispatch: vi.fn(async () => ({ handled: false })) },
    agentName: "synthetic", hanakoHome: os.tmpdir(), currentAgentId: "a",
  };
  const bm = new BridgeManager({ engine, hub });
  managers.push(bm);
  for (const agentId of ["a", "b"]) {
    bm._platforms.set(`telegram:${agentId}`, { platform: "telegram", agentId, adapter, status: "connected" });
    if (attached) rcState.attach(`tg_dm_owner@${agentId}`, `/synthetic/${agentId}.jsonl`);
  }
  bm.blockStreaming = false;
  const inbound = (text: string, agentId = "a", group = false) => bm._handleMessage("telegram", {
    text, agentId, sessionKey: `tg_${group ? "group" : "dm"}_owner@${agentId}`,
    userId: "owner", chatId: "owner", isGroup: group,
  });
  const texts = () => hub.send.mock.calls.map(([text]) => text.replace(/^<t>[^<]+<\/t> /, ""));
  return { bm, adapter, hub, generate, engine, rcState, inbound, texts, active, peaks, unsubscribe };
}

async function startHeld(f: ReturnType<typeof fixture>) {
  const gate = deferred(reply);
  f.generate.mockImplementationOnce(() => gate.promise);
  await f.inbound("first");
  await vi.advanceTimersByTimeAsync(2000);
  expect(f.hub.send).toHaveBeenCalledTimes(1);
  expect(f.bm._processing.has("tg_dm_owner@a")).toBe(true);
  return gate;
}

function drained(f: ReturnType<typeof fixture>) {
  expect(f.bm._pending.size).toBe(0);
  expect(f.bm._processing.size).toBe(0);
  expect([...f.active.values()].every(n => n === 0)).toBe(true);
  expect([...f.peaks.values()].every(n => n === 1)).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
}

describe("BridgeManager pending queue drain", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); });
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    await vi.advanceTimersByTimeAsync(0);
    for (const bm of managers.splice(0)) {
      // Also clean the intentionally failing, unpatched baseline fixtures.
      for (const key of bm._pending.keys()) bm._clearPending(key);
      bm.stopAll();
    }
    vi.clearAllTimers(); vi.restoreAllMocks(); vi.useRealTimers();
  });

  it.each(["success", "failure", "abort", "busy", "result-error"])(
    "RC resumes after an expired debounce and %s without another inbound event", async outcome => {
      const f = fixture(); const gate = await startHeld(f);
      await f.inbound("second");
      await vi.advanceTimersByTimeAsync(2000);
      expect(f.hub.send).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      if (outcome === "failure") gate.reject(new Error("synthetic failure"));
      else if (outcome === "abort") gate.reject(Object.assign(new Error("cancelled"), { name: "AbortError" }));
      else if (outcome === "busy") gate.reject(new Error("session_busy"));
      else if (outcome === "result-error") gate.resolve({ ...reply, text: "", error: "synthetic result failure" } as typeof reply);
      else gate.resolve(reply);
      await vi.advanceTimersByTimeAsync(500);
      expect(f.texts()).toEqual(["first", "second"]);
      expect(f.adapter.sendReply).toHaveBeenCalledTimes(outcome === "abort" ? 1 : 2);
      expect(logger.error.mock.calls.length > 0).toBe(!["success", "abort"].includes(outcome));
      drained(f);
      await vi.advanceTimersByTimeAsync(20000);
      expect(f.hub.send).toHaveBeenCalledTimes(2);
    },
  );

  it("keeps a still-armed debounce from delivering the same batch twice", async () => {
    const f = fixture(); const gate = await startHeld(f);
    await f.inbound("second"); gate.resolve(reply);
    await vi.advanceTimersByTimeAsync(2500);
    expect(f.texts()).toEqual(["first", "second"]); drained(f);
  });

  it("coalesces a burst once while repeated busy flushes leave the owner's lock intact", async () => {
    const f = fixture(); const gate = await startHeld(f);
    const schedule = vi.spyOn(f.bm, "_schedulePendingFlush");
    await f.inbound("second"); await f.inbound("third");
    await vi.advanceTimersByTimeAsync(2000);
    await Promise.all(Array.from({ length: 5 }, () => f.bm._flushPending("tg_dm_owner@a")));
    expect(f.bm._processing.has("tg_dm_owner@a")).toBe(true);
    expect(f.hub.send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20000);
    expect(vi.getTimerCount()).toBe(0); // No polling loop while busy.
    gate.resolve(reply); await vi.advanceTimersByTimeAsync(500);
    expect(f.texts()).toEqual(["first", "second\nthird"]);
    expect(schedule.mock.calls.filter(([, delay]) => delay === 500)).toHaveLength(1);
    drained(f);
  });

  it("waits for receipt teardown before unlocking and draining reentrant input", async () => {
    const f = fixture(); const stopping = deferred(undefined);
    const stop = vi.fn(() => stopping.promise);
    vi.spyOn(f.bm, "_startLlmWaitingReceipt").mockResolvedValueOnce({ mode: "none", stop });
    await f.inbound("first"); await vi.advanceTimersByTimeAsync(2000);
    expect(stop).toHaveBeenCalledOnce();
    await f.inbound("second"); await vi.advanceTimersByTimeAsync(2000);
    expect(f.bm._processing.has("tg_dm_owner@a")).toBe(true);
    expect(f.hub.send).toHaveBeenCalledTimes(1);
    stopping.resolve(undefined); await vi.advanceTimersByTimeAsync(500);
    expect(f.texts()).toEqual(["first", "second"]); drained(f);
  });

  it("drains after stale attachment returns without routing the rejected batch twice", async () => {
    const f = fixture(); const exists = deferred(false);
    vi.spyOn(f.bm, "_desktopSessionStillExists").mockImplementationOnce(() => exists.promise);
    await f.inbound("first"); await vi.advanceTimersByTimeAsync(2000);
    await f.inbound("second"); await vi.advanceTimersByTimeAsync(2000);
    exists.resolve(false); await vi.advanceTimersByTimeAsync(500);
    expect(f.rcState.getAttachment("tg_dm_owner@a")).toBeNull();
    expect(f.texts()).toEqual(["second"]);
    expect(f.hub.send.mock.calls[0][1]).toMatchObject({ sessionKey: "tg_dm_owner@a" });
    expect(f.adapter.sendReply).toHaveBeenCalledTimes(2); drained(f);
  });

  it.each(["success", "failure", "abort"])("ordinary bridge %s still drains exactly once", async outcome => {
    const f = fixture({ attached: false }); const gate = await startHeld(f);
    await f.inbound("second"); await vi.advanceTimersByTimeAsync(2000);
    if (outcome === "success") gate.resolve(reply);
    else gate.reject(Object.assign(new Error("synthetic"), { name: outcome === "abort" ? "AbortError" : "Error" }));
    await vi.advanceTimersByTimeAsync(500);
    expect(f.texts()).toEqual(["first", "second"]); drained(f);
  });

  it("an attachment-resolution failure preserves the next independent batch", async () => {
    const f = fixture(); const resolving = deferred({ images: [], textNotes: "", inboundFiles: [] });
    vi.spyOn(f.bm, "_resolveAttachments").mockImplementationOnce(() => resolving.promise);
    await f.inbound("first"); await vi.advanceTimersByTimeAsync(2000);
    await f.inbound("second"); await vi.advanceTimersByTimeAsync(2000);
    resolving.reject(new Error("synthetic attachment failure"));
    await vi.advanceTimersByTimeAsync(500);
    expect(f.texts()).toEqual(["second"]); expect(logger.error).toHaveBeenCalled(); drained(f);
  });

  it("the direct RC helper owns its own drain when alreadyLocked is false", async () => {
    const f = fixture(); const gate = deferred(reply);
    f.generate.mockImplementationOnce(() => gate.promise);
    const work = f.bm._flushAttachedDesktopSession({
      sessionKey: "tg_dm_owner@a", desktopSessionPath: "/synthetic/a.jsonl", platform: "telegram",
      chatId: "owner", agentId: "a", text: "first", images: [], inboundFiles: [],
    });
    await vi.advanceTimersByTimeAsync(0);
    await f.inbound("second"); await vi.advanceTimersByTimeAsync(2000);
    gate.resolve(reply); await work; await vi.advanceTimersByTimeAsync(500);
    expect(f.texts()).toEqual(["first", "second"]); drained(f);
  });

  it.each(["stopPlatform", "stopAll", "slash-stop"])("%s cancels buffered input without resurrecting it", async action => {
    const f = fixture(); const gate = await startHeld(f);
    await f.inbound("second"); await vi.advanceTimersByTimeAsync(2000);
    if (action === "stopPlatform") f.bm.stopPlatform("telegram", "a");
    else if (action === "stopAll") { f.bm.stopAll(); expect(f.unsubscribe).toHaveBeenCalledOnce(); }
    else { f.engine.slashDispatcher.tryDispatch.mockResolvedValueOnce({ handled: true }); await f.inbound("/stop"); }
    gate.reject(Object.assign(new Error("shutdown"), { name: "AbortError" }));
    await vi.advanceTimersByTimeAsync(10000);
    expect(f.texts()).toEqual(["first"]); drained(f);
  });

  it.each(["stopPlatform", "stopAll"])("%s removes an armed debounce before the first send", async action => {
    const f = fixture(); await f.inbound("never-send");
    if (action === "stopPlatform") f.bm.stopPlatform("telegram", "a"); else f.bm.stopAll();
    await vi.advanceTimersByTimeAsync(10000);
    expect(f.hub.send).not.toHaveBeenCalled(); drained(f);
  });

  it("stopping one platform binding preserves the other channel's queued input", async () => {
    const f = fixture();
    await f.inbound("discard-a"); await f.inbound("keep-b", "b");
    f.bm.stopPlatform("telegram", "a"); await vi.advanceTimersByTimeAsync(2500);
    expect(f.texts()).toEqual(["keep-b"]);
    expect(f.hub.send.mock.calls[0][1]).toMatchObject({ sessionPath: "/synthetic/b.jsonl" }); drained(f);
  });

  it("drains different RC channels independently without crossing locks or batches", async () => {
    const f = fixture(); const a = deferred(reply); const b = deferred(reply);
    f.generate.mockImplementationOnce(() => a.promise).mockImplementationOnce(() => b.promise);
    await f.inbound("a1"); await f.inbound("b1", "b"); await vi.advanceTimersByTimeAsync(2000);
    await f.inbound("a2"); await f.inbound("b2", "b"); await vi.advanceTimersByTimeAsync(2000);
    a.resolve(reply); await vi.advanceTimersByTimeAsync(500);
    expect(f.texts()).toEqual(["a1", "b1", "a2"]);
    expect(f.bm._processing.has("tg_dm_owner@b")).toBe(true);
    b.resolve(reply); await vi.advanceTimersByTimeAsync(500);
    expect(f.texts()).toEqual(["a1", "b1", "a2", "b2"]);
    expect(f.hub.send.mock.calls.map(([, o]) => o.sessionPath)).toEqual([
      "/synthetic/a.jsonl", "/synthetic/b.jsonl", "/synthetic/a.jsonl", "/synthetic/b.jsonl",
    ]); drained(f);
  });

  it("group batches remain serial and a stopped binding drops its queued group batch", async () => {
    const f = fixture(); const a = deferred(reply); const b = deferred(reply);
    f.generate.mockImplementationOnce(() => a.promise).mockImplementationOnce(() => b.promise);
    await f.inbound("a1", "a", true); await vi.advanceTimersByTimeAsync(0);
    await f.inbound("b1", "b", true); await vi.advanceTimersByTimeAsync(0);
    await f.inbound("a2", "a", true); await f.inbound("b2", "b", true);
    f.bm.stopPlatform("telegram", "a");
    a.resolve(reply); b.resolve(reply); await vi.advanceTimersByTimeAsync(0);
    expect(f.texts()).toEqual(["a1", "b1", "b2"]); drained(f);
  });
});
