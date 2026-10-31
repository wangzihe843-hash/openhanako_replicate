import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/bridge/telegram-adapter.ts", () => ({ createTelegramAdapter: vi.fn() }));
vi.mock("../lib/bridge/feishu-worker-adapter.ts", () => ({ createFeishuWorkerAdapter: vi.fn() }));
vi.mock("../lib/bridge/dingtalk-adapter.ts", () => ({ createDingTalkAdapter: vi.fn() }));
vi.mock("../lib/bridge/qq-adapter.ts", () => ({ createQQAdapter: vi.fn() }));
vi.mock("../lib/bridge/wechat-adapter.ts", () => ({ createWechatAdapter: vi.fn() }));
vi.mock("../lib/debug-log.ts", () => ({ debugLog: () => null, createModuleLogger: () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock("../core/llm-client.ts", () => ({ callText: vi.fn() }));

import { BridgeManager } from "../lib/bridge/bridge-manager.ts";
import { createTelegramAdapter } from "../lib/bridge/telegram-adapter.ts";
import { createFeishuWorkerAdapter as createFeishuAdapter } from "../lib/bridge/feishu-worker-adapter.ts";
import { SlashCommandDispatcher } from "../core/slash-command-dispatcher.ts";
import { RcStateStore } from "../core/slash-commands/rc-state.ts";
import { bridgeCommands } from "../core/slash-commands/bridge-commands.ts";
import { callText } from "../core/llm-client.ts";

type SyntheticReply = { text: string | null; error?: string; toolMedia?: string[] };
type SyntheticSession = { path: string; agentId: string; title?: string; modified?: Date; messageCount?: number };
type SyntheticCommand = Pick<(typeof bridgeCommands)[number], "permission" | "handler">;
type SyntheticAgent = { id: string; agentName?: string; sessionDir: string; config: { bridge: { telegram: { owner: string }; feishu?: { owner: string } } } };
const reply: SyntheticReply = { text: "synthetic reply", toolMedia: [] };
const cleanup: Array<() => void> = [];
const managers: BridgeManager[] = [];
function deferred<T>(fallback: T) {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  cleanup.push(() => resolve(fallback));
  return { promise, resolve, reject };
}
function fixture({ attached = true } = {}) {
  const rcState = new RcStateStore();
  const initialEngine = {
    rcState, hanakoHome: os.tmpdir(), agentName: "Synthetic", currentAgentId: "a",
    getAgent: vi.fn((id: string): SyntheticAgent => ({ id, sessionDir: os.tmpdir(), config: { bridge: { telegram: { owner: "owner" }, feishu: { owner: "owner" } } } })),
    getBridgeReceiptEnabled: vi.fn(() => false),
    isBridgeSessionStreaming: vi.fn(() => false), isSessionStreaming: vi.fn(() => false),
    steerBridgeSession: vi.fn(() => false), ensureSessionLoaded: vi.fn(async () => ({})), emitEvent: vi.fn(),
  };
  const engine: typeof initialEngine & {
    slashDispatcher?: SlashCommandDispatcher;
    listSessions?: ReturnType<typeof vi.fn>;
    resolveUtilityConfigFresh?: ReturnType<typeof vi.fn>;
    loopController?: { targetFromSessionRef: ReturnType<typeof vi.fn>; start: ReturnType<typeof vi.fn> };
  } = initialEngine;
  const hub = { send: vi.fn(async (_text: string, _opts: { onDelta: (delta: string, accumulated: string) => void }) => reply), subscribe: vi.fn(() => vi.fn()), eventBus: { emit: vi.fn() } };
  const registry = { lookup: vi.fn((name: string): SyntheticCommand | undefined => bridgeCommands.find(c => c.name === name)) };
  engine.slashDispatcher = new SlashCommandDispatcher({ engine, hub, registry });
  const bm = new BridgeManager({ engine, hub }); managers.push(bm);
  const start = (platform = "telegram", agentId = "a", overrides: Record<string, unknown> = {}) => {
    const initialAdapter = {
      sendReply: vi.fn(async () => {}), stop: vi.fn(),
      mediaCapabilities: { inputModes: ["remote_url"], supportedKinds: ["image"] },
      ...overrides,
    };
    const adapter = initialAdapter as typeof initialAdapter & Record<string, unknown>;
    const factory = vi.mocked(platform === "telegram" ? createTelegramAdapter : createFeishuAdapter, { partial: true });
    factory.mockReturnValueOnce(adapter);
    bm.startPlatform(platform, { token: "SYNTHETIC_ONLY", appId: "synthetic", appSecret: "synthetic" }, agentId);
    const hooks = factory.mock.calls.at(-1)![0] as Parameters<typeof createTelegramAdapter>[0];
    const key = `${platform === "telegram" ? "tg" : "fs"}_dm_owner@${agentId}`;
    if (attached && !rcState.isAttached(key)) rcState.attach(key, `/synthetic/${platform}-${agentId}.jsonl`);
    const send = (text: string, extra: Record<string, unknown> = {}) => hooks.onMessage({ text, sessionKey: key, agentId, userId: "owner", chatId: "owner", isGroup: false, ...extra });
    return { adapter, hooks, send, key, platform, agentId };
  };
  return { bm, hub, engine, registry, rcState, start };
}
function drained(f: ReturnType<typeof fixture>) {
  expect(f.bm._pending.size).toBe(0);
  expect(f.bm._processing.size).toBe(0);
  expect(f.bm._processingOwners?.size ?? 0).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
}
const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

describe("Bridge binding lifetime through public adapter callbacks", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); });
  afterEach(async () => {
    for (const resolve of cleanup.splice(0)) resolve();
    await tick(200);
    for (const bm of managers.splice(0)) bm.stopAll();
    vi.clearAllTimers(); vi.restoreAllMocks(); vi.useRealTimers();
  });

  it("drops callbacks invoked after restart, including attempts to enter another agent", async () => {
    const f = fixture(); const old = f.start(); const other = f.start("telegram", "b"); const fresh = f.start();
    await old.send("late"); await old.send("wrong-agent", { agentId: "b", sessionKey: other.key });
    old.hooks.onStatus?.("error", "old status");
    expect(f.bm.getStatus("a").telegram.status).toBe("connecting");
    fresh.hooks.onStatus?.("connected");
    expect(f.bm.getStatus("a").telegram.status).toBe("connected");
    await fresh.send("fresh"); await other.send("other"); await tick(2000);
    expect(f.hub.send.mock.calls.map(c => c[0])).toEqual(["fresh", "other"]);
    expect(old.adapter.sendReply).not.toHaveBeenCalled(); expect(fresh.adapter.sendReply).toHaveBeenCalledOnce(); drained(f);
  });

  it.each(["reply", "throw"])("a stopped dispatcher %s cannot reply or clear the replacement buffer", async outcome => {
    const f = fixture(); const old = f.start(); const gate = deferred({ reply: "old command" });
    f.registry.lookup.mockReturnValue({ permission: "owner", handler: () => gate.promise });
    const work = old.send("/held"); await tick();
    const fresh = f.start(); await fresh.send("fresh");
    if (outcome === "throw") gate.reject(new Error("synthetic dispatcher failure")); else gate.resolve({ reply: "old command" });
    await work; expect(f.bm._pending.size).toBe(1); await tick(2000);
    expect(f.hub.send.mock.calls.map(c => c[0])).toEqual(["fresh"]);
    expect(old.adapter.sendReply).not.toHaveBeenCalled(); expect(fresh.adapter.sendReply).toHaveBeenCalledOnce(); drained(f);
  });

  it("does not start a known slash handler queued before stop", async () => {
    const f = fixture(); const old = f.start(); const handler = vi.fn(async () => ({ reply: "obsolete" }));
    f.registry.lookup.mockReturnValue({ permission: "owner", handler });
    const work = old.send("/queued"); f.bm.stopPlatform("telegram", "a"); await work;
    expect(handler).not.toHaveBeenCalled(); expect(old.adapter.sendReply).not.toHaveBeenCalled(); drained(f);
  });

  it("does not recreate RC selection state after the listing await", async () => {
    const f = fixture({ attached: false }); const old = f.start(); const listing = deferred<SyntheticSession[]>([]);
    f.engine.listSessions = vi.fn(() => listing.promise);
    const work = old.send("/rc"); await tick(); f.bm.stopAll();
    listing.resolve([{ path: "/synthetic/session", agentId: "a", title: "Synthetic", modified: new Date(), messageCount: 2 }]); await work;
    expect(f.rcState.isPending(old.key)).toBe(false); expect(old.adapter.sendReply).not.toHaveBeenCalled(); drained(f);
  });

  it("does not attach an old RC numeric selection after restart", async () => {
    const f = fixture({ attached: false }); const old = f.start(); const lookup = deferred<SyntheticSession[]>([]);
    f.rcState.setPending(old.key, { type: "rc-select", options: [{ path: "/synthetic/old", title: "Old" }] });
    f.engine.listSessions = vi.fn(() => lookup.promise);
    const work = old.send("1"); await tick(); const fresh = f.start();
    f.rcState.setPending(fresh.key, { type: "rc-select", options: [{ path: "/synthetic/new", title: "New" }] });
    lookup.resolve([{ path: "/synthetic/old", agentId: "a" }]); await work;
    expect(f.rcState.getAttachment(old.key)).toBeFalsy();
    expect(f.rcState.getPending(fresh.key)?.options[0].path).toBe("/synthetic/new");
    expect(old.adapter.sendReply).not.toHaveBeenCalled(); drained(f);
  });

  it("does not schedule a slash loop after target resolution crosses stop", async () => {
    const f = fixture(); const old = f.start(); const target = deferred({ sessionKey: old.key });
    f.engine.loopController = { targetFromSessionRef: vi.fn(() => target.promise), start: vi.fn(async () => {}) };
    const work = old.send("/loop synthetic task"); await tick(); f.bm.stopPlatform("telegram", "a");
    target.resolve({ sessionKey: old.key }); await work;
    expect(f.engine.loopController.start).not.toHaveBeenCalled(); expect(old.adapter.sendReply).not.toHaveBeenCalled(); drained(f);
  });

  it.each(["config", "fallback"])("stops RC summary %s continuation before another model call", async stage => {
    const f = fixture({ attached: false }); const old = f.start();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-lifetime-"));
    const file = path.join(dir, "synthetic.jsonl");
    fs.writeFileSync(file, JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "Synthetic only" }] } }) + "\n");
    cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    f.rcState.setPending(old.key, { type: "rc-select", options: [{ path: file, title: "Synthetic" }] });
    f.engine.listSessions = vi.fn(async () => [{ path: file, agentId: "a" }]);
    const config = { utility: "synthetic", utility_large: "synthetic-large", base_url: "https://synthetic.invalid", api: "openai", large_base_url: "https://synthetic.invalid", large_api: "openai" };
    const gate = deferred<unknown>(stage === "config" ? config : null);
    f.engine.resolveUtilityConfigFresh = vi.fn(async () => stage === "config" ? gate.promise : config);
    vi.mocked(callText).mockImplementation(() => gate.promise as ReturnType<typeof callText>);
    const work = old.send("1"); await tick();
    expect(f.engine.resolveUtilityConfigFresh).toHaveBeenCalledOnce();
    const repliesBeforeStop = old.adapter.sendReply.mock.calls.length;
    f.bm.stopAll(); gate.resolve(stage === "config" ? config : null); await work;
    expect(callText).toHaveBeenCalledTimes(stage === "config" ? 0 : 1);
    expect(f.rcState.getAttachment(old.key)).toBeFalsy();
    expect(old.adapter.sendReply).toHaveBeenCalledTimes(repliesBeforeStop); drained(f);
  });

  it("stops RC idle polling after invalidation without attaching or polling again", async () => {
    const f = fixture({ attached: false }); const old = f.start();
    f.rcState.setPending(old.key, { type: "rc-select", options: [{ path: "/synthetic/session", title: "Synthetic" }] });
    f.engine.listSessions = vi.fn(async () => [{ path: "/synthetic/session", agentId: "a" }]);
    f.engine.isSessionStreaming.mockReturnValue(true);
    cleanup.push(() => f.engine.isSessionStreaming.mockReturnValue(false));
    const work = old.send("1"); await tick(); expect(vi.getTimerCount()).toBe(1);
    f.bm.stopPlatform("telegram", "a"); await tick(200);
    expect(vi.getTimerCount()).toBe(0); await work;
    expect(f.rcState.getAttachment(old.key)).toBeFalsy(); drained(f);
  });

  it.each(["success", "failure"])("attachment %s after deletion cannot start a turn or the next download", async outcome => {
    const f = fixture({ attached: false }); const download = deferred(Buffer.from("synthetic"));
    const old = f.start("telegram", "a", { downloadFileByRef: vi.fn(() => download.promise) });
    await old.send("old", { attachments: [{ type: "file", platformRef: "one", filename: "one.txt" }, { type: "file", platformRef: "two", filename: "two.txt" }] });
    await tick(2000); f.bm.stopPlatform("telegram", "a"); f.engine.getAgent.mockReturnValue(null);
    expect(f.bm.getStatus("a")).toEqual({});
    if (outcome === "failure") download.reject(new Error("synthetic download failure")); else download.resolve(Buffer.from("synthetic"));
    await tick(5000); expect(old.adapter.downloadFileByRef).toHaveBeenCalledOnce();
    expect(f.hub.send).not.toHaveBeenCalled(); expect(old.adapter.sendReply).not.toHaveBeenCalled(); drained(f);
  });

  it("an old missing-session result cannot detach the new attachment", async () => {
    const f = fixture(); const old = f.start(); const exists = deferred<null>(null);
    f.engine.ensureSessionLoaded.mockImplementationOnce(() => exists.promise);
    await old.send("old"); await tick(2000); const fresh = f.start();
    f.rcState.detach(old.key); f.rcState.attach(fresh.key, "/synthetic/new");
    exists.resolve(null); await tick();
    expect(f.rcState.getAttachment(fresh.key)?.desktopSessionPath).toBe("/synthetic/new");
    expect(f.hub.send).not.toHaveBeenCalled(); expect(old.adapter.sendReply).not.toHaveBeenCalled(); drained(f);
  });

  it.each([true, false])("receipt creation cannot start a stopped turn (attached=%s)", async attached => {
    const f = fixture({ attached }); const receipt = deferred<{ messageId: string }>({ messageId: "old" });
    f.engine.getBridgeReceiptEnabled.mockReturnValue(true);
    const old = f.start("telegram", "a", {
      streamingCapabilities: { mode: "edit_message" },
      startStreamReply: vi.fn(() => receipt.promise), updateStreamReply: vi.fn(async () => {}), finishStreamReply: vi.fn(async () => {}),
    });
    f.engine.getAgent.mockReturnValue({ id: "a", agentName: "Synthetic", sessionDir: os.tmpdir(), config: { bridge: { telegram: { owner: "owner" } } } });
    await old.send("old"); await tick(2000); expect(old.adapter.startStreamReply).toHaveBeenCalledOnce();
    f.bm.stopAll(); receipt.resolve({ messageId: "old" }); await tick(5000);
    expect(f.hub.send).not.toHaveBeenCalled(); expect(old.adapter.finishStreamReply).not.toHaveBeenCalled(); drained(f);
  });

  it.each(["success", "result-error", "throw", "abort"])("suppresses old turn %s and lets the new generation drain once", async outcome => {
    const f = fixture(); const old = f.start(); const held = deferred<SyntheticReply>(reply); const next = deferred(reply);
    f.hub.send.mockImplementationOnce(() => held.promise).mockImplementationOnce(() => next.promise);
    await old.send("old"); await tick(2000); const fresh = f.start();
    await fresh.send("fresh"); await tick(2000); expect(f.hub.send).toHaveBeenCalledOnce();
    if (outcome === "throw" || outcome === "abort") held.reject(Object.assign(new Error("synthetic"), { name: outcome === "abort" ? "AbortError" : "Error" }));
    else held.resolve(outcome === "result-error" ? { text: null, error: "synthetic" } : reply);
    await tick(500); expect(f.hub.send).toHaveBeenCalledTimes(2);
    expect(f.bm._processing.has(fresh.key)).toBe(true); expect(old.adapter.sendReply).not.toHaveBeenCalled();
    await fresh.send("during-new"); await tick(5000); expect(f.hub.send).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
    next.resolve(reply); await tick(500); expect(f.hub.send.mock.calls.map(c => c[0])).toEqual(["old", "fresh", "during-new"]);
    expect(fresh.adapter.sendReply).toHaveBeenCalledTimes(2); drained(f);
  });

  it("a queued old timer callback cannot consume or retime fresh messages", async () => {
    const f = fixture(); const old = f.start(); const timers = vi.spyOn(globalThis, "setTimeout");
    await old.send("old"); const callback = timers.mock.calls.find(c => c[1] === 2000)![0] as () => void;
    await tick(1500); const fresh = f.start(); await fresh.send("fresh"); callback();
    await tick(500); expect(f.hub.send).not.toHaveBeenCalled(); await tick(1500);
    expect(f.hub.send.mock.calls.map(c => c[0])).toEqual(["fresh"]); drained(f);
  });

  it("rebuilds group queues independently while preserving serialization", async () => {
    const f = fixture({ attached: false }); const old = f.start(); const held = deferred(reply);
    f.hub.send.mockImplementationOnce(() => held.promise);
    const group = { sessionKey: "tg_group_one@a", isGroup: true };
    await old.send("old", group); await tick();
    const fresh = f.start(); await fresh.send("fresh", group);
    await fresh.send("other-channel", { sessionKey: "tg_group_two@a", isGroup: true }); await tick();
    expect(f.hub.send).toHaveBeenCalledTimes(2);
    held.resolve(reply); await tick();
    expect(f.hub.send.mock.calls.map(c => c[0].replace(/^<t>[^<]+<\/t> /, ""))).toEqual(["old", "other-channel", "fresh"]);
    expect(old.adapter.sendReply).not.toHaveBeenCalled(); expect(fresh.adapter.sendReply).toHaveBeenCalledTimes(2); drained(f);
  });

  it("a late flush rejection does not release the new owner's lock", async () => {
    const f = fixture(); const old = f.start(); const envelope = deferred<void>(undefined); const turn = deferred(reply);
    vi.spyOn(f.bm, "_flushPending").mockImplementationOnce(() => envelope.promise);
    await old.send("old"); await tick(2000); const fresh = f.start();
    f.hub.send.mockImplementationOnce(() => turn.promise); await fresh.send("fresh"); await tick(2000);
    envelope.reject(new Error("synthetic late flush rejection")); await tick();
    expect(f.bm._processing.has(fresh.key)).toBe(true); await fresh.send("next"); await tick(5000);
    expect(f.hub.send).toHaveBeenCalledOnce(); turn.resolve(reply); await tick(500);
    expect(f.hub.send.mock.calls.map(c => c[0])).toEqual(["fresh", "next"]); drained(f);
  });

  it("stopping during receipt teardown preserves the new owner and other channels", async () => {
    const f = fixture(); const old = f.start(); const other = f.start("feishu", "a"); const teardown = deferred<void>(undefined); const next = deferred(reply);
    vi.spyOn(f.bm, "_startLlmWaitingReceipt").mockResolvedValueOnce({ mode: "none", stop: () => teardown.promise });
    await old.send("old"); await tick(2000); const fresh = f.start();
    f.hub.send.mockImplementation(async text => text === "fresh" ? next.promise : reply);
    await fresh.send("fresh"); await other.send("other"); await tick(2000);
    teardown.resolve(); await tick(500); expect(f.bm._processing.has(fresh.key)).toBe(true);
    expect(f.hub.send.mock.calls.map(c => c[0])).toEqual(["old", "other", "fresh"]);
    next.resolve(reply); await tick(); drained(f);
  });

  it("clears typing refresh on stop while the old Hub call is unresolved", async () => {
    const f = fixture(); const held = deferred(reply);
    f.engine.getBridgeReceiptEnabled.mockReturnValue(true);
    const old = f.start("telegram", "a", { receiptCapabilities: { mode: "native_typing", refreshIntervalMs: 500 }, sendTypingIndicator: vi.fn(async () => {}) });
    f.hub.send.mockImplementationOnce(() => held.promise); await old.send("old"); await tick(2000);
    expect(old.adapter.sendTypingIndicator).toHaveBeenCalledOnce(); f.bm.stopAll();
    expect(vi.getTimerCount()).toBe(0); await tick(5000); expect(old.adapter.sendTypingIndicator).toHaveBeenCalledOnce();
    held.resolve(reply); await tick(); expect(old.adapter.sendReply).not.toHaveBeenCalled(); drained(f);
  });

  it.each(["success", "failure"])("a draft final-send %s cannot send its follow-up after stop", async outcome => {
    const f = fixture(); const draft = deferred<void>(undefined);
    const old = f.start("telegram", "a", { streamingCapabilities: { mode: "draft" }, sendDraft: vi.fn(() => draft.promise) });
    await old.send("old"); await tick(2000); expect(old.adapter.sendDraft).toHaveBeenCalledOnce(); f.bm.stopAll();
    if (outcome === "failure") draft.reject(new Error("synthetic draft failure")); else draft.resolve();
    await tick(); expect(old.adapter.sendReply).not.toHaveBeenCalled(); drained(f);
  });

  it("drops queued stream updates and fallback after an in-flight send fails during stop", async () => {
    const f = fixture(); const held = deferred(reply); const stream = deferred<{ messageId: string }>({ messageId: "old" });
    const old = f.start("telegram", "a", { streamingCapabilities: { mode: "edit_message", minIntervalMs: 0 }, startStreamReply: vi.fn(() => stream.promise), updateStreamReply: vi.fn(async () => {}), finishStreamReply: vi.fn(async () => {}) });
    f.hub.send.mockImplementationOnce(() => held.promise); await old.send("old"); await tick(2000);
    const opts = f.hub.send.mock.calls[0][1]; opts.onDelta("first", "first"); await tick(); opts.onDelta("second", "second");
    f.bm.stopAll(); stream.reject(new Error("synthetic stream failure")); opts.onDelta("late", "late"); held.resolve(reply); await tick();
    expect(old.adapter.updateStreamReply).not.toHaveBeenCalled(); expect(old.adapter.finishStreamReply).not.toHaveBeenCalled(); expect(old.adapter.sendReply).not.toHaveBeenCalled(); drained(f);
  });

  it("stops remaining media and failure notices after a media await", async () => {
    const f = fixture(); const media = deferred<void>(undefined); const old = f.start("telegram", "a", { sendMedia: vi.fn(() => media.promise) });
    f.hub.send.mockResolvedValueOnce({ text: "images", toolMedia: ["https://synthetic.invalid/one.png", "https://synthetic.invalid/two.png"] });
    await old.send("old"); await tick(2000); expect(old.adapter.sendMedia).toHaveBeenCalledOnce(); f.bm.stopAll();
    media.reject(new Error("synthetic media failure")); await tick();
    expect(old.adapter.sendMedia).toHaveBeenCalledOnce(); expect(old.adapter.sendReply).toHaveBeenCalledTimes(1); drained(f);
  });

  it("a stopped loop turn releases only its owner and drains fresh inbound", async () => {
    const f = fixture({ attached: false }); const old = f.start("feishu"); const held = deferred(reply);
    f.hub.send.mockImplementationOnce(() => held.promise);
    const work = f.bm.executeLoopTurn("feishu_dm_owner@a", "loop", { agentId: "a" });
    const fresh = f.start("feishu"); await fresh.send("fresh", { sessionKey: "feishu_dm_owner@a" }); await tick(2000);
    held.resolve(reply); await work; await tick(500);
    expect(old.adapter.sendReply).not.toHaveBeenCalled(); expect(fresh.adapter.sendReply).toHaveBeenCalledOnce();
    expect(f.hub.send).toHaveBeenCalledTimes(2); drained(f);
  });
});
