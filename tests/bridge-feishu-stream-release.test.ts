import os from "node:os";
import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/bridge/feishu-worker-adapter.ts", () => ({ createFeishuWorkerAdapter: vi.fn() }));
vi.mock("../lib/debug-log.ts", () => ({ debugLog: () => null, createModuleLogger: () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
import { BridgeManager } from "../lib/bridge/bridge-manager.ts";

type Mode = "edit_message" | "cardkit_stream";
function fixture(mode: Mode, missingMessageId = false) {
  const bm = new BridgeManager({ engine: { hanakoHome: os.tmpdir(), getAgent: () => null }, hub: { eventBus: { emit: vi.fn() } } });
  const state = { messageId: missingMessageId ? null : "om_synthetic", missingMessageId, cardId: "card_synthetic" };
  const active = new Set<object>();
  const start = vi.fn(async () => { active.add(state); return state; });
  const update = vi.fn(async () => undefined);
  const finish = vi.fn(async () => { active.delete(state); });
  const sendReply = vi.fn(async () => undefined);
  const release = vi.fn((owned: object) => { active.delete(owned); });
  const adapter = {
    startStreamReply: start, startRichStreamReply: start,
    updateStreamReply: update, updateRichStreamReply: update,
    finishStreamReply: finish, finishRichStreamReply: finish,
    sendReply, releaseStreamReply: release,
  };
  const input = { adapter, chatId: "synthetic", platform: "feishu", context: {}, capability: { minIntervalMs: 0, maxChars: 0 } };
  const delivery = mode === "edit_message" ? bm._createEditMessageStreamDelivery(input) : bm._createCardKitStreamDelivery(input);
  const released = () => { expect(release).toHaveBeenCalledExactlyOnceWith(state); expect(active.size).toBe(0); };
  return { bm, state, active, start, update, finish, sendReply, release, delivery, released };
}

for (const mode of ["edit_message", "cardkit_stream"] as const) {
  describe(`Feishu ${mode} stream handle ownership`, () => {
    it("releases a final-only reply without adding a business finish or fallback", async () => {
      const f = fixture(mode);
      await expect(f.delivery.finish("final")).resolves.toEqual([]);
      f.released(); expect(f.start).toHaveBeenCalledOnce();
      expect(f.finish).toHaveBeenCalledTimes(mode === "cardkit_stream" ? 1 : 0);
      expect(f.sendReply).not.toHaveBeenCalled(); await f.bm.stopAll();
    });
    it("releases a receipt-only stream when the final is empty", async () => {
      const f = fixture(mode); await f.delivery.startReceipt("working");
      await expect(f.delivery.finish("")).resolves.toEqual([]);
      f.released(); expect(f.finish).not.toHaveBeenCalled(); expect(f.sendReply).not.toHaveBeenCalled(); await f.bm.stopAll();
    });
    it.each(["finish", "fail"] as const)("releases after a known update rejection and preserves %s fallback", async terminal => {
      const f = fixture(mode); await f.delivery.startReceipt("working");
      f.update.mockRejectedValueOnce(new Error("synthetic confirmed update rejection"));
      f.delivery.onDelta("partial", "partial");
      await f.delivery[terminal]("final");
      f.released(); expect(f.finish).not.toHaveBeenCalled(); expect(f.sendReply).toHaveBeenCalledExactlyOnceWith("synthetic", "final"); await f.bm.stopAll();
    });
    it.each(["finish", "fail"] as const)("releases after an unknown update result and preserves %s rejection without sending", async terminal => {
      const f = fixture(mode); await f.delivery.startReceipt("working");
      const unknown = Object.assign(new Error("synthetic update response lost"), { deliveryUnknown: true });
      f.update.mockRejectedValueOnce(unknown); f.delivery.onDelta("partial", "partial");
      await expect(f.delivery[terminal]("final")).rejects.toBe(unknown);
      f.released(); expect(f.finish).not.toHaveBeenCalled(); expect(f.sendReply).not.toHaveBeenCalled(); await f.bm.stopAll();
    });
    it.each(["finish", "fail"] as const)("releases after a known final write rejection and preserves %s fallback", async terminal => {
      const f = fixture(mode); await f.delivery.startReceipt("working");
      f.finish.mockRejectedValueOnce(new Error("synthetic confirmed final rejection"));
      await f.delivery[terminal]("final");
      f.released(); expect(f.finish).toHaveBeenCalledOnce(); expect(f.sendReply).toHaveBeenCalledExactlyOnceWith("synthetic", "final"); await f.bm.stopAll();
    });
    it.each(["finish", "fail"] as const)("releases after an unknown final write result and preserves %s rejection", async terminal => {
      const f = fixture(mode); await f.delivery.startReceipt("working");
      const unknown = Object.assign(new Error("synthetic final response lost"), { deliveryUnknown: true });
      f.finish.mockRejectedValueOnce(unknown);
      await expect(f.delivery[terminal]("final")).rejects.toBe(unknown);
      f.released(); expect(f.finish).toHaveBeenCalledOnce(); expect(f.sendReply).not.toHaveBeenCalled(); await f.bm.stopAll();
    });
    it("releases even when the confirmed-error fallback itself has an unknown result", async () => {
      const f = fixture(mode); await f.delivery.startReceipt("working");
      f.finish.mockRejectedValueOnce(new Error("synthetic confirmed rejection"));
      const unknown = Object.assign(new Error("synthetic fallback response lost"), { deliveryUnknown: true });
      f.sendReply.mockRejectedValueOnce(unknown);
      await expect(f.delivery.finish("final")).rejects.toBe(unknown);
      f.released(); expect(f.sendReply).toHaveBeenCalledOnce(); await f.bm.stopAll();
    });
    it("waits a queued start before releasing on an empty failure message", async () => {
      const f = fixture(mode); let ready!: () => void;
      const gate = new Promise<void>(resolve => { ready = resolve; });
      f.start.mockImplementationOnce(async () => { await gate; f.active.add(f.state); return f.state; });
      f.delivery.onDelta("partial", "partial");
      let completed = false; const finishing = f.delivery.fail("   ").then(() => { completed = true; });
      await Promise.resolve(); expect(completed).toBe(false); expect(f.release).not.toHaveBeenCalled();
      ready(); await finishing;
      f.released(); expect(f.finish).not.toHaveBeenCalled(); expect(f.sendReply).not.toHaveBeenCalled(); await f.bm.stopAll();
    });
    it("does not replace an unknown delivery error when local release throws", async () => {
      const f = fixture(mode); await f.delivery.startReceipt("working");
      const unknown = Object.assign(new Error("synthetic update response lost"), { deliveryUnknown: true });
      f.update.mockRejectedValueOnce(unknown);
      f.release.mockImplementationOnce(() => { throw new Error("synthetic cleanup failure"); });
      f.delivery.onDelta("partial", "partial");
      await expect(f.delivery.finish("final")).rejects.toBe(unknown);
      expect(f.release).toHaveBeenCalledExactlyOnceWith(f.state); expect(f.sendReply).not.toHaveBeenCalled(); await f.bm.stopAll();
    });
    it("does not invent a handle or change fallback when start was rejected", async () => {
      const f = fixture(mode); f.start.mockRejectedValueOnce(new Error("synthetic confirmed start rejection"));
      await f.delivery.finish("final");
      expect(f.release).not.toHaveBeenCalled(); expect(f.active.size).toBe(0);
      expect(f.sendReply).toHaveBeenCalledExactlyOnceWith("synthetic", "final"); await f.bm.stopAll();
    });
  });
}

it("releases an ordinary missing-message-id handle without changing its fallback", async () => {
  const f = fixture("edit_message", true); await f.delivery.startReceipt("working");
  await f.delivery.finish("final");
  f.released(); expect(f.finish).not.toHaveBeenCalled(); expect(f.sendReply).toHaveBeenCalledExactlyOnceWith("synthetic", "final"); await f.bm.stopAll();
});

it("releases an ordinary oversized final without retrying it", async () => {
  const f = fixture("edit_message"); await f.delivery.startReceipt("working");
  const tooLarge = Object.assign(new Error("synthetic oversize"), { code: "FEISHU_MESSAGE_TOO_LARGE" });
  f.update.mockRejectedValueOnce(tooLarge); f.delivery.onDelta("oversized", "oversized");
  await expect(f.delivery.finish("oversized")).rejects.toBe(tooLarge);
  f.released(); expect(f.finish).not.toHaveBeenCalled(); expect(f.sendReply).not.toHaveBeenCalled(); await f.bm.stopAll();
});
