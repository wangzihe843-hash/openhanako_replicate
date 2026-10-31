import os from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";

const factories = vi.hoisted(() => ({ feishu: vi.fn(), telegram: vi.fn() }));
vi.mock("../lib/bridge/feishu-adapter.ts", () => ({ createFeishuAdapter: factories.feishu }));
vi.mock("../lib/bridge/feishu-worker-adapter.ts", () => ({ createFeishuWorkerAdapter: factories.feishu }));
vi.mock("../lib/bridge/telegram-adapter.ts", () => ({ createTelegramAdapter: factories.telegram }));
vi.mock("../lib/debug-log.ts", () => ({ debugLog: () => null, createModuleLogger: () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
import { BridgeManager } from "../lib/bridge/bridge-manager.ts";

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function manager() {
  return new BridgeManager({
    engine: { hanakoHome: os.tmpdir(), getAgent: () => null },
    hub: { eventBus: { emit: vi.fn() } },
  });
}
const credentials = { appId: "synthetic", appSecret: "synthetic", token: "synthetic" };

beforeEach(() => { factories.feishu.mockReset(); factories.telegram.mockReset(); });

describe("Bridge owned adapter teardown", () => {
  it.each(["feishu", "telegram"])("invalidates %s synchronously and waits its asynchronous stop", async platform => {
    const bm = manager(); const exit = deferred();
    const factory = platform === "feishu" ? factories.feishu : factories.telegram;
    factory.mockReturnValue({ stop: vi.fn(() => exit.promise) });
    bm.startPlatform(platform, credentials, "a");
    const hooks = factory.mock.calls[0][0];
    const drain = bm.stopPlatform(platform, "a");
    expect(bm.getStatus("a")[platform]).toBeUndefined();
    hooks.onStatus("connected");
    expect(bm.getStatus("a")[platform]).toBeUndefined();
    expect(drain).toBeInstanceOf(Promise);
    let settled = false; void Promise.resolve(drain).then(() => { settled = true; });
    await Promise.resolve(); expect(settled).toBe(false);
    expect(bm.stopPlatform(platform, "a")).toBe(drain);
    exit.resolve(); await drain; expect(settled).toBe(true);
    await bm.stopAll();
  });

  it("passes the old exit barrier across secret changes and stop/start/stop without sharing managers", async () => {
    const bm = manager(); const other = manager(); const exit = deferred();
    factories.feishu.mockReturnValueOnce({ stop: vi.fn(() => exit.promise) })
      .mockReturnValue({ stop: vi.fn() });
    bm.startPlatform("feishu", credentials, "a");
    bm.startPlatform("feishu", { ...credentials, appSecret: "replacement" }, "a");
    const wait = factories.feishu.mock.calls[1][0].waitForPreviousExit;
    expect(wait).toBeInstanceOf(Promise);
    other.startPlatform("feishu", credentials, "a");
    const isolatedWait = factories.feishu.mock.calls[2][0].waitForPreviousExit;
    let isolatedSettled = false;
    void Promise.resolve(isolatedWait).then(() => { isolatedSettled = true; });
    let settled = false;
    const drain = bm.stopAll(); void Promise.resolve(drain).then(() => { settled = true; });
    await Promise.resolve(); await Promise.resolve();
    expect(isolatedSettled).toBe(true); expect(settled).toBe(false);
    exit.resolve(); await wait; await drain; await other.stopAll();
  });

  it("drains all platforms and retains a failed exit barrier for replacement and later shutdown", async () => {
    const bm = manager(); const failure = new Error("synthetic worker did not exit"); const exit = deferred();
    const failedStop = vi.fn(() => { throw failure; });
    const otherStop = vi.fn(() => exit.promise);
    factories.feishu.mockReturnValueOnce({ stop: failedStop }).mockReturnValue({ stop: vi.fn() });
    factories.telegram.mockReturnValue({ stop: otherStop });
    bm.startPlatform("feishu", credentials, "a"); bm.startPlatform("telegram", credentials, "b");
    const drain = bm.stopAll();
    expect(failedStop).toHaveBeenCalledOnce(); expect(otherStop).toHaveBeenCalledOnce();
    expect(bm.getStatus(undefined)).toEqual({});
    let settled = false; void Promise.resolve(drain).catch(() => { settled = true; });
    await Promise.resolve(); expect(settled).toBe(false);
    exit.resolve(); await expect(drain).rejects.toThrow("teardown");
    bm.startPlatform("feishu", credentials, "a");
    await expect(factories.feishu.mock.calls[1][0].waitForPreviousExit).rejects.toBe(failure);
    await expect(bm.stopAll()).rejects.toThrow("teardown");
  });
});

describe("Feishu stream delivery with an unknown remote result", () => {
  const modes = ["edit_message", "cardkit_stream"] as const;
  const stages = ["receipt", "start", "update", "finish", "fail_finish", "fallback"] as const;
  for (const mode of modes) {
    it.each(stages)(`${mode} keeps an unknown %s terminal across queued snapshots, fail and finish`, async stage => {
      const bm = manager(); const unknown = Object.assign(new Error("synthetic response lost"), { deliveryUnknown: true });
      const start = vi.fn().mockResolvedValue({ messageId: "om_synthetic", cardId: "card_synthetic" });
      const update = vi.fn().mockResolvedValue(undefined);
      const finish = vi.fn().mockResolvedValue(undefined);
      const sendReply = vi.fn().mockResolvedValue(undefined);
      const adapter = {
        startStreamReply: start, startRichStreamReply: start,
        updateStreamReply: update, updateRichStreamReply: update,
        finishStreamReply: finish, finishRichStreamReply: finish, sendReply,
      };
      const input = { adapter, chatId: "synthetic", platform: "feishu", context: {}, capability: { minIntervalMs: 0, maxChars: 0 } };
      const delivery = mode === "edit_message" ? bm._createEditMessageStreamDelivery(input) : bm._createCardKitStreamDelivery(input);
      if (stage === "receipt" || stage === "start") start.mockRejectedValueOnce(unknown);
      if (stage === "update") update.mockRejectedValueOnce(unknown);
      if (stage === "finish" || stage === "fail_finish") finish.mockRejectedValueOnce(unknown);
      if (stage === "fallback") { start.mockRejectedValue(new Error("synthetic confirmed rejection")); sendReply.mockRejectedValueOnce(unknown); }
      if (stage === "receipt") await delivery.startReceipt("working");
      if (["update", "finish", "fail_finish"].includes(stage)) await delivery.startReceipt("working");
      if (stage === "start" || stage === "update") {
        delivery.onDelta("first", "first"); delivery.onDelta("second", "second");
      }
      if (stage === "fail_finish") await expect(delivery.fail("failed")).rejects.toBe(unknown);
      else await expect(delivery.finish("final")).rejects.toBe(unknown);
      const previousCalls = [start.mock.calls.length, update.mock.calls.length, finish.mock.calls.length, sendReply.mock.calls.length];
      delivery.onDelta("late", "late");
      await expect(delivery.fail("later failure")).rejects.toBe(unknown);
      await expect(delivery.finish("later final")).rejects.toBe(unknown);
      expect([start.mock.calls.length, update.mock.calls.length, finish.mock.calls.length, sendReply.mock.calls.length]).toEqual(previousCalls);
      expect(sendReply).toHaveBeenCalledTimes(stage === "fallback" ? 1 : 0);
      if (stage === "start") expect(start).toHaveBeenCalledOnce();
      if (stage === "update") expect(update).toHaveBeenCalledOnce();
      await bm.stopAll();
    });

    it(`${mode} preserves fallback for an explicitly rejected platform write`, async () => {
      const bm = manager(); const rejected = Object.assign(new Error("synthetic rejected"), { code: 230001 });
      const adapter = {
        startStreamReply: vi.fn().mockRejectedValue(rejected), startRichStreamReply: vi.fn().mockRejectedValue(rejected),
        updateStreamReply: vi.fn(), updateRichStreamReply: vi.fn(), finishStreamReply: vi.fn(), finishRichStreamReply: vi.fn(),
        sendReply: vi.fn().mockResolvedValue(undefined),
      };
      const input = { adapter, chatId: "synthetic", platform: "feishu", context: {}, capability: { minIntervalMs: 0, maxChars: 0 } };
      const delivery = mode === "edit_message" ? bm._createEditMessageStreamDelivery(input) : bm._createCardKitStreamDelivery(input);
      await expect(delivery.finish("final")).resolves.toEqual([]);
      expect(adapter.sendReply).toHaveBeenCalledExactlyOnceWith("synthetic", "final");
      await bm.stopAll();
    });
  }

  it("does not fallback or retry an unknown CardKit finish of the last nonempty snapshot", async () => {
    const bm = manager(); const unknown = Object.assign(new Error("synthetic result lost"), { deliveryUnknown: true });
    const adapter = {
      startRichStreamReply: vi.fn().mockResolvedValue({ cardId: "card_synthetic" }), updateRichStreamReply: vi.fn(),
      finishRichStreamReply: vi.fn().mockRejectedValue(unknown), sendReply: vi.fn(),
    };
    const delivery = bm._createCardKitStreamDelivery({ adapter, chatId: "synthetic", platform: "feishu", context: {}, capability: { minIntervalMs: 0 } });
    delivery.onDelta("partial", "partial");
    await expect(delivery.finish("")).rejects.toBe(unknown);
    await expect(delivery.finish("final")).rejects.toBe(unknown);
    expect(adapter.finishRichStreamReply).toHaveBeenCalledOnce(); expect(adapter.sendReply).not.toHaveBeenCalled();
    await bm.stopAll();
  });
});

describe("Feishu RC session terminal delivery", () => {
  it("does not send a new failure notice after the streamed write result is unknown", async () => {
    const bm = manager();
    bm.engine.getBridgeReceiptEnabled = () => false;
    bm._hub.send = vi.fn().mockResolvedValue({ text: "synthetic final", toolMedia: [] });
    const unknown = Object.assign(new Error("synthetic response lost"), { deliveryUnknown: true });
    const adapter = {
      streamingCapabilities: { mode: "edit_message", scopes: ["dm"], minIntervalMs: 0, maxChars: 0 },
      startStreamReply: vi.fn().mockRejectedValue(unknown), updateStreamReply: vi.fn(), finishStreamReply: vi.fn(),
      sendReply: vi.fn().mockResolvedValue(undefined), stop: vi.fn(),
    };
    bm._platforms.set("feishu:a", { adapter, platform: "feishu", agentId: "a", status: "connected" });
    await bm._flushAttachedDesktopSession({
      sessionKey: "fs_dm_synthetic@a", desktopSessionPath: "/synthetic/session", platform: "feishu", chatId: "synthetic",
      agentId: "a", text: "synthetic input", images: [], inboundFiles: [],
    });
    expect(adapter.startStreamReply).toHaveBeenCalledOnce();
    expect(adapter.sendReply).not.toHaveBeenCalled();
    expect(bm._processing.size).toBe(0);
    await bm.stopAll();
  });
});
