import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const diagnostics = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn(), log: vi.fn() }));
vi.mock("../lib/debug-log.ts", () => ({
  debugLog: () => diagnostics,
  createModuleLogger: () => diagnostics,
}));

import { BridgeManager } from "../lib/bridge/bridge-manager.ts";
import { MediaDeliveryService } from "../lib/bridge/media-delivery-service.ts";
import { NotificationService } from "../lib/notifications/notification-service.ts";
import { createNotifyTool } from "../lib/tools/notify-tool.ts";
import { LoopController } from "../lib/loop/loop-controller.ts";
import { LoopStore } from "../lib/loop/loop-store.ts";
import { loadLocale } from "../lib/i18n.ts";
import { unknownDeliveryFailure } from "../shared/errors.ts";

const TTL = 10 * 60 * 1000;
const managers: BridgeManager[] = [];
const directories: string[] = [];
const unknownError = () => Object.assign(new Error("response lost; token=private-synthetic"), {
  deliveryUnknown: true,
  code: "ECONNRESET",
  status: 502,
  log_id: "synthetic-request-id",
  phase: "response",
  operation: "sendReply",
  config: { appSecret: "private-synthetic" },
  cause: new Error("private-synthetic"),
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function manager() {
  const markDelivered = vi.fn();
  const agent = { id: "a", config: { bridge: { feishu: { owner: "owner" }, telegram: { owner: "owner" } } } };
  const engine = {
    hanakoHome: os.tmpdir(), currentAgentId: "a", getAgent: () => agent,
    getBridgeIndex: () => ({ "fs_dm_owner@a": { userId: "owner", chatId: "chat" } }),
    deferredResults: { markDelivered },
  };
  const bm = new BridgeManager({ engine, hub: { eventBus: { emit: vi.fn() } } });
  managers.push(bm);
  return { bm, markDelivered };
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const bm of managers.splice(0)) await bm.stopAll();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  loadLocale("zh");
  vi.clearAllMocks();
});

function bind(bm: BridgeManager, platform: string, sendReply: (...args: unknown[]) => Promise<unknown>) {
  bm._platforms.set(`${platform}:a`, { platform, agentId: "a", status: "connected", adapter: { sendReply, stop: vi.fn() } });
}

const target = { platform: "feishu", agentId: "a", userId: "owner", chatId: "chat", sessionKey: "fs_dm_owner@a" };
const proactiveOptions = { contextPolicy: "none", deliveryTarget: target };

describe("proactive delivery uncertainty", () => {
  it("retains safe diagnostic fields and an unknown tombstone for the original TTL", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    const { bm } = manager();
    const send = vi.fn().mockRejectedValueOnce(unknownError()).mockResolvedValue(undefined);
    bind(bm, "feishu", send);
    const options = { ...proactiveOptions, idempotencyKey: "unknown-key" };
    const first = await bm.sendProactive("same body", "a", options);
    expect(first).toMatchObject({ ok: false, error: "delivery_unknown", deliveryUnknown: true,
      deliveries: [{ status: "unknown", failure: { code: "ECONNRESET", status: 502, log_id: "synthetic-request-id", phase: "response", operation: "sendReply", retryable: false } }] });
    expect(JSON.stringify(first)).not.toContain("private-synthetic");
    expect(first?.failure).not.toHaveProperty("config");
    expect(first?.failure).not.toHaveProperty("cause");
    clock.mockReturnValue(1000 + TTL);
    const repeated = await bm.sendProactive("same body", "a", options);
    expect(repeated).toEqual({ ...first, skipped: true });
    expect(repeated?.ok).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    clock.mockReturnValue(1000 + TTL + 1);
    expect(await bm.sendProactive("same body", "a", options)).toMatchObject({ platform: "feishu" });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it.each(["feishu", "telegram"])("explicit fan-out preserves unknown plus sent facts when %s is uncertain", async (uncertainPlatform) => {
    const { bm } = manager();
    const feishu = vi.fn().mockImplementation(async () => { if (uncertainPlatform === "feishu") throw unknownError(); });
    const telegram = vi.fn().mockImplementation(async () => { if (uncertainPlatform === "telegram") throw unknownError(); });
    bind(bm, "feishu", feishu);
    bind(bm, "telegram", telegram);
    const options = { bridgePlatforms: ["feishu", "telegram"], contextPolicy: "none", idempotencyKey: "fan-out" };
    const first = await bm.sendProactive("fan out", "a", options);
    expect(first).toMatchObject({ ok: false, deliveryUnknown: true, error: "delivery_unknown" });
    expect(first?.deliveries.map((delivery) => [delivery.platform, delivery.status])).toEqual([
      ["feishu", uncertainPlatform === "feishu" ? "unknown" : "sent"],
      ["telegram", uncertainPlatform === "telegram" ? "unknown" : "sent"],
    ]);
    expect(await bm.sendProactive("fan out", "a", options)).toMatchObject({ ok: false, deliveryUnknown: true, skipped: true });
    expect(feishu).toHaveBeenCalledTimes(1);
    expect(telegram).toHaveBeenCalledTimes(1);
  });

  it("retains explicit fan-out for confirmed rejections and successful targets", async () => {
    const { bm } = manager();
    const first = vi.fn().mockRejectedValue(Object.assign(new Error("confirmed rejected"), { code: 230001 }));
    const second = vi.fn().mockResolvedValue(undefined);
    bind(bm, "feishu", first);
    bind(bm, "telegram", second);
    const result = await bm.sendProactive("fan out", "a", { bridgePlatforms: ["feishu", "telegram"], contextPolicy: "none" });
    expect(result).toMatchObject({ platform: "telegram", deliveries: [{ status: "failed" }, { status: "sent" }] });
    expect(result).not.toHaveProperty("deliveryUnknown");
  });

  it("allows a confirmed rejection to retry under the same key", async () => {
    const { bm } = manager();
    const send = vi.fn().mockRejectedValueOnce(Object.assign(new Error("confirmed rejected"), { code: 230001 })).mockResolvedValue(undefined);
    bind(bm, "feishu", send);
    const options = { ...proactiveOptions, idempotencyKey: "known-retry" };
    expect(await bm.sendProactive("body", "a", options)).toMatchObject({ ok: false, error: "send_failed" });
    expect(await bm.sendProactive("body", "a", options)).toMatchObject({ platform: "feishu" });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("does not confuse a new key or unkeyed message with an uncertain earlier message", async () => {
    const { bm } = manager();
    const send = vi.fn().mockRejectedValue(unknownError());
    bind(bm, "feishu", send);
    await bm.sendProactive("same body", "a", { ...proactiveOptions, idempotencyKey: "old" });
    await bm.sendProactive("same body", "a", { ...proactiveOptions, idempotencyKey: "new" });
    await bm.sendProactive("same body", "a", proactiveOptions);
    await bm.sendProactive("same body", "a", proactiveOptions);
    expect(send).toHaveBeenCalledTimes(4);
  });

  it("coalesces a pending write beyond the TTL and starts the tombstone TTL on settlement", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    const { bm } = manager();
    const pending = deferred<void>();
    const send = vi.fn().mockReturnValue(pending.promise);
    bind(bm, "feishu", send);
    const options = { ...proactiveOptions, idempotencyKey: "pending" };
    const first = bm.sendProactive("slow", "a", options);
    await Promise.resolve();
    clock.mockReturnValue(1000 + TTL + 1);
    const repeated = bm.sendProactive("slow", "a", options);
    pending.reject(unknownError());
    const results = await Promise.all([first, repeated]);
    expect(results[0]).toEqual(results[1]);
    clock.mockReturnValue(1000 + TTL * 2);
    expect(await bm.sendProactive("slow", "a", options)).toMatchObject({ ok: false, deliveryUnknown: true, skipped: true });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("does not leave a synchronously rejected request stuck in the idempotency cache", async () => {
    const { bm } = manager();
    const send = vi.fn().mockResolvedValue(undefined);
    bind(bm, "feishu", send);
    await expect(bm.sendProactive("body", "a", { bridgePlatforms: ["unsupported"], idempotencyKey: "validation" })).rejects.toThrow("unsupported");
    expect(await bm.sendProactive("body", "a", { ...proactiveOptions, idempotencyKey: "validation" })).toMatchObject({ platform: "feishu" });
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("notification callers preserve unknown outcomes", () => {
  it("does not turn a repeated uncertain notification into successful or skipped delivery facts", async () => {
    const { bm } = manager();
    const send = vi.fn().mockRejectedValue(unknownError());
    bind(bm, "feishu", send);
    const service = new NotificationService({ getBridgeManager: () => bm });
    const payload = { title: "notice", body: "same", channels: ["bridge_owner"], idempotencyKey: "notice-key" };
    const first = await service.notify(payload, { agentId: "a" });
    const repeated = await service.notify(payload, { agentId: "a" });
    expect(first).toMatchObject({ ok: false, deliveryUnknown: true, error: "delivery_unknown", deliveries: [{ status: "unknown", bridgeDeliveries: [{ status: "unknown" }] }] });
    expect(repeated).toEqual({ ...first, skipped: true });
    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(repeated)).not.toContain("private-synthetic");
    await service.notify({ ...payload, idempotencyKey: "other-notice-key" }, { agentId: "a" });
    await service.notify({ ...payload, idempotencyKey: undefined }, { agentId: "a" });
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("retains explicit desktop fan-out after an unknown bridge channel without claiming complete success", async () => {
    const { bm } = manager();
    bind(bm, "feishu", vi.fn().mockRejectedValue(unknownError()));
    const desktop = vi.fn();
    const service = new NotificationService({ getBridgeManager: () => bm, emitDesktop: desktop });
    const result = await service.notify({ title: "notice", body: "body", channels: ["bridge_owner", "desktop"] }, { agentId: "a" });
    expect(result).toMatchObject({ ok: false, deliveryUnknown: true, deliveries: [{ channel: "bridge_owner", status: "unknown" }, { channel: "desktop", status: "sent" }] });
    expect(desktop).toHaveBeenCalledTimes(1);
  });

  it("propagates thrown unknown diagnostics and coalesces a pending notification beyond TTL", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    const pending = deferred<unknown>();
    const sendProactive = vi.fn().mockReturnValue(pending.promise);
    const service = new NotificationService({ getBridgeManager: () => ({ sendProactive }) });
    const payload = { title: "slow", body: "notice", channels: ["bridge_owner"] };
    const first = service.notify(payload, { idempotencyKey: "context-key" });
    await Promise.resolve();
    clock.mockReturnValue(1000 + TTL + 1);
    const second = service.notify(payload, { idempotencyKey: "context-key" });
    pending.reject(unknownError());
    const results = await Promise.all([first, second]);
    expect(results[0]).toEqual(results[1]);
    clock.mockReturnValue(1000 + TTL * 2);
    expect(await service.notify(payload, { idempotencyKey: "context-key" })).toMatchObject({ ok: false, deliveryUnknown: true, skipped: true });
    expect(sendProactive).toHaveBeenCalledTimes(1);
    expect(sendProactive).toHaveBeenCalledWith("slow\n\nnotice", null, { contextPolicy: "record_when_delivered", idempotencyKey: "context-key:bridge_owner" });
  });

  it("allows retry after a confirmed notification rejection", async () => {
    const sendProactive = vi.fn().mockResolvedValueOnce({ ok: false, error: "send_failed", deliveries: [{ status: "failed", error: "confirmed rejected" }] })
      .mockResolvedValue({ platform: "feishu", deliveries: [{ status: "sent" }] });
    const service = new NotificationService({ getBridgeManager: () => ({ sendProactive }) });
    const payload = { title: "notice", body: "body", channels: ["bridge_owner"], idempotencyKey: "known" };
    expect(await service.notify(payload)).toMatchObject({ ok: false });
    expect(await service.notify(payload)).toMatchObject({ ok: true });
    expect(sendProactive).toHaveBeenCalledTimes(2);
  });

  it.each(["result", "throw"])("notify tool describes %s uncertainty without a failure or automatic replay", async (mode) => {
    loadLocale("en");
    const failure = unknownDeliveryFailure(unknownError());
    const onNotify = vi.fn().mockImplementation(async () => {
      if (mode === "throw") throw unknownError();
      return { ok: false, deliveryUnknown: true, error: "delivery_unknown", failure, deliveries: [{ status: "unknown" }] };
    });
    const tool = createNotifyTool({ onNotify });
    const result = await tool.execute("synthetic-call", { title: "notice", body: "body" }, undefined, undefined, {});
    expect(result.details).toMatchObject({ sent: false, deliveryUnknown: true, failure: { code: "ECONNRESET", retryable: false } });
    expect(result.content[0].text).toMatch(/outcome.*unknown/i);
    expect(result.content[0].text).toMatch(/verify.*do not automatically resend/i);
    expect(result.content[0].text).not.toMatch(/failed|sent successfully/i);
    expect(JSON.stringify(result)).not.toContain("private-synthetic");
    expect(onNotify).toHaveBeenCalledTimes(1);
  });
});

describe("loop notices observe uncertainty without replay", () => {
  it.each(["pause-result", "pause-throw", "reset-result", "reset-throw"])("records a neutral diagnostic for %s without changing persisted loop semantics", async (mode) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "u15-loop-unknown-"));
    directories.push(directory);
    const store = new LoopStore(path.join(directory, "state.json"));
    const recordNotice = vi.fn().mockImplementation(async () => {
      if (mode.endsWith("throw")) throw unknownError();
      return { ok: false, deliveryUnknown: true, failure: unknownDeliveryFailure(unknownError()) };
    });
    const warn = vi.fn();
    const controller = new LoopController({
      store, recordNotice, log: { ...console, warn }, hasLiveBackgroundWork: () => false,
      deliverLoopMessage: async () => ({ mode: "triggerTurn" }), isTargetMidStream: () => false,
      isTargetRunnable: () => true, resolveSessionIdForPath: () => "sid", resolveTargetFromSessionRef: async () => null,
    });
    await controller.start({ kind: "bridge", sessionId: "sid", sessionKey: "fs_dm_owner@a", agentId: "a" }, "watch");
    if (mode.startsWith("pause")) await controller._pause("sid", "budget", "paused");
    else await controller._stopForReset("sid");
    expect(recordNotice).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/delivery outcome unknown.*verify before retry/);
    expect(warn.mock.calls[0][0]).not.toMatch(/notice failed|private-synthetic/);
    const saved = store.get("sid");
    expect(saved.status).toBe(mode.startsWith("pause") ? "paused" : "stopped");
    expect(saved).not.toHaveProperty("noticeDelivery");
    expect(saved).not.toHaveProperty("deliveryUnknown");
    await controller.onTurnEnd("/synthetic/loop.jsonl");
    expect(recordNotice).toHaveBeenCalledTimes(1);
  });
});

describe("unknown diagnostics stay bounded to safe fields", () => {
  it("redacts credentials and signed media URLs without traversing arbitrary fields", () => {
    const error = unknownError();
    Object.defineProperty(error, "headers", { get: () => { throw new Error("must not read"); } });
    error.message = "Bearer private-synthetic; https://synthetic.invalid/file?X-Amz-Signature=private-synthetic";
    const failure = unknownDeliveryFailure(error);
    expect(failure).toMatchObject({ deliveryUnknown: true, code: "ECONNRESET", status: 502, retryable: false });
    expect(JSON.stringify(failure)).not.toContain("private-synthetic");
    expect(failure).not.toHaveProperty("headers");
    expect(unknownDeliveryFailure(new Error("confirmed rejected"))).toBeNull();
  });

  it("suppresses a false media failure write and exposes its diagnostic outcome", async () => {
    const service = new MediaDeliveryService();
    const adapter = { sendReply: vi.fn() };
    expect(await service.sendFailureNotice(adapter, "chat", unknownError())).toMatchObject({ status: "unknown", deliveryUnknown: true, failure: { code: "ECONNRESET" } });
    expect(adapter.sendReply).not.toHaveBeenCalled();
    expect(diagnostics.warn).toHaveBeenCalledWith("bridge", expect.stringContaining("delivery outcome unknown"));
  });
});

function deferredMediaHarness() {
  const { bm, markDelivered } = manager();
  const adapter = { sendReply: vi.fn().mockResolvedValue(undefined) };
  vi.spyOn(bm, "_mediaItemsFromDeferredResult").mockReturnValue([{ type: "remote_url", url: "https://synthetic.invalid/image.png" }]);
  vi.spyOn(bm, "_resolveDeferredResultDeliveryTarget").mockReturnValue({
    adapter, platform: "feishu", chatId: "chat", sessionKey: "fs_dm_owner@a", isGroup: false, agentId: "a", replyContext: null,
  });
  const send = vi.spyOn(bm, "_sendMediaItem");
  return { bm, markDelivered, send, adapter };
}

describe("deferred results preserve uncertain delivery", () => {
  it("retains the same task's unknown media outcome and allows a distinct task", async () => {
    const { bm, send, adapter, markDelivered } = deferredMediaHarness();
    send.mockRejectedValueOnce(unknownError()).mockResolvedValue(undefined);
    const event = { type: "deferred_result", status: "success", taskId: "task-1" };
    const first = await bm._handleDeferredResultMediaEvent(event, "/synthetic/session.jsonl");
    const repeated = await bm._handleDeferredResultMediaEvent(event, "/synthetic/session.jsonl");
    expect(send).toHaveBeenCalledTimes(1);
    expect(adapter.sendReply).not.toHaveBeenCalled();
    expect(markDelivered).not.toHaveBeenCalled();
    expect(first).toMatchObject({ ok: false, deliveryUnknown: true });
    expect(repeated).toMatchObject({ ok: false, deliveryUnknown: true });
    expect(await bm._handleDeferredResultMediaEvent({ ...event, taskId: "task-2" }, "/synthetic/session.jsonl")).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
    expect(markDelivered).toHaveBeenCalledExactlyOnceWith("task-2");
  });

  it("keeps an uncertain deferred failure notice from being sent again", async () => {
    const { bm, adapter, markDelivered } = deferredMediaHarness();
    adapter.sendReply.mockRejectedValueOnce(unknownError()).mockResolvedValue(undefined);
    const event = { type: "deferred_result", status: "failed", taskId: "failed-task", reason: "synthetic failure" };
    const first = await bm._handleDeferredResultMediaEvent(event, "/synthetic/session.jsonl");
    const repeated = await bm._handleDeferredResultMediaEvent(event, "/synthetic/session.jsonl");
    expect(adapter.sendReply).toHaveBeenCalledTimes(1);
    expect(markDelivered).not.toHaveBeenCalled();
    expect(first).toMatchObject({ ok: false, deliveryUnknown: true });
    expect(repeated).toMatchObject({ ok: false, deliveryUnknown: true });
  });

  it("retains an unknown failure notice after a definite media rejection", async () => {
    const { bm, send, adapter, markDelivered } = deferredMediaHarness();
    send.mockRejectedValue(new Error("confirmed rejected"));
    adapter.sendReply.mockRejectedValue(unknownError());
    const event = { type: "deferred_result", status: "success", taskId: "notice-task" };
    const first = await bm._handleDeferredResultMediaEvent(event, "/synthetic/session.jsonl");
    await bm._handleDeferredResultMediaEvent(event, "/synthetic/session.jsonl");
    expect(first).toMatchObject({ deliveryUnknown: true });
    expect(send).toHaveBeenCalledTimes(1);
    expect(adapter.sendReply).toHaveBeenCalledTimes(1);
    expect(markDelivered).not.toHaveBeenCalled();
  });

  it("allows retry for a definitely rejected deferred item", async () => {
    const { bm, send, markDelivered } = deferredMediaHarness();
    send.mockRejectedValueOnce(new Error("confirmed rejected")).mockResolvedValue(undefined);
    const event = { type: "deferred_result", status: "success", taskId: "known-task" };
    expect(await bm._handleDeferredResultMediaEvent(event, "/synthetic/session.jsonl")).toBe(false);
    expect(await bm._handleDeferredResultMediaEvent(event, "/synthetic/session.jsonl")).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
    expect(markDelivered).toHaveBeenCalledExactlyOnceWith("known-task");
  });

  it("does not expire pending deferred media when the original TTL passes", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    const { bm, send } = deferredMediaHarness();
    const pending = deferred<void>();
    send.mockReturnValue(pending.promise);
    const event = { type: "deferred_result", status: "success", taskId: "slow-task" };
    const first = bm._handleDeferredResultMediaEvent(event, "/synthetic/session.jsonl");
    await Promise.resolve();
    clock.mockReturnValue(1000 + TTL + 1);
    const repeated = bm._handleDeferredResultMediaEvent(event, "/synthetic/session.jsonl");
    await Promise.resolve();
    pending.resolve();
    await Promise.all([first, repeated]);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
