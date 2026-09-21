import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { heartbeatQuietReason } from "../shared/heartbeat-policy.ts";
import { createHeartbeat } from "../lib/desk/heartbeat.ts";

function testHeartbeat(options: Partial<Parameters<typeof createHeartbeat>[0]>) {
  return createHeartbeat({
    getDeskFiles: undefined, getWorkspacePath: undefined, getAgentName: undefined,
    registryPath: undefined, onBeat: undefined, onJianBeat: undefined,
    getEventSummary: undefined, intervalMinutes: undefined, emitDevLog: undefined,
    overwatchPath: undefined, locale: undefined, getProposeDraftAvailable: undefined,
    getDmAvailable: undefined, ...options,
  });
}

const at = (hours: number, minutes = 0) => new Date(2026, 8, 21, hours, minutes);
describe("heartbeat quiet hours", () => {
  it.each([
    [22, 59, null], [23, 0, "quiet-hours"], [0, 0, "quiet-hours"],
    [7, 59, "quiet-hours"], [8, 0, null],
  ])("handles overnight interval at %s:%s", (hours, minutes, expected) => {
    expect(heartbeatQuietReason({ enabled: true, start: "23:00", end: "08:00" }, at(Number(hours), Number(minutes)))).toBe(expected);
  });
  it("uses inclusive start and exclusive end for a same-day interval", () => {
    const quiet = { enabled: true, start: "09:30", end: "12:00" };
    expect(heartbeatQuietReason(quiet, at(9, 29))).toBeNull();
    expect(heartbeatQuietReason(quiet, at(9, 30))).toBe("quiet-hours");
    expect(heartbeatQuietReason(quiet, at(12))).toBeNull();
  });
  it("defaults off and blocks malformed enabled configuration", () => {
    expect(heartbeatQuietReason(undefined)).toBeNull();
    expect(heartbeatQuietReason({ enabled: false })).toBeNull();
    expect(heartbeatQuietReason({ enabled: true, start: "24:00", end: "08:00" })).toBe("invalid-quiet-hours");
    expect(heartbeatQuietReason({ enabled: true, start: "08:00", end: "08:00" })).toBe("invalid-quiet-hours");
  });
  it("checks quiet hours before consuming any events or running work", async () => {
    const getEventSummary = vi.fn();
    const onBeat = vi.fn();
    const hb = testHeartbeat({ getEventSummary, onBeat, getSkipReason: () => "quiet-hours" });
    expect(await hb.runHeartbeatOnce()).toEqual({ status: "skipped", reason: "quiet-hours" });
    expect(await hb.beat()).toMatchObject({ skipped: "quiet-hours" });
    expect(hb.triggerNow()).toBe(false);
    expect(getEventSummary).not.toHaveBeenCalled();
    expect(onBeat).not.toHaveBeenCalled();
  });
  it("rechecks pause after async file collection and before consuming events", async () => {
    let release!: () => void;
    const files = new Promise<void>(resolve => { release = resolve; });
    const getEventSummary = vi.fn();
    const onBeat = vi.fn();
    const hb = testHeartbeat({ getDeskFiles: async () => { await files; return []; }, getEventSummary, onBeat });
    const run = hb.runHeartbeatOnce();
    const stopped = hb.stop();
    release();
    expect(await run).toMatchObject({ status: "skipped", reason: "paused" });
    await stopped;
    expect(getEventSummary).not.toHaveBeenCalled();
    expect(onBeat).not.toHaveBeenCalled();
  });
  it("keeps explicit manual patrols available after stopping automatic patrols", async () => {
    const onBeat = vi.fn(async () => ({ manual: true }));
    const hb = testHeartbeat({ onBeat });
    await hb.stop();
    expect(await hb.beat()).toMatchObject({ skipped: "paused" });
    expect(await hb.runHeartbeatOnce()).toMatchObject({ status: "ran", payload: { manual: true } });
    expect(onBeat).toHaveBeenCalledOnce();
    await hb.stop();
  });

  it("aborts in-flight work and suppresses a late successful result after pause", async () => {
    let started!: () => void;
    let finish!: () => void;
    let signal: AbortSignal;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const onSkipped = vi.fn();
    const hb = testHeartbeat({ onSkipped, onBeat: async (_prompt, extra) => { signal = extra.signal; started(); await pending; return { stale: true }; } });
    const run = hb.runHeartbeatOnce();
    await ready;
    const stopped = hb.stop();
    expect(signal!.aborted).toBe(true);
    finish();
    expect(await run).toEqual({ status: "skipped", reason: "paused" });
    expect(onSkipped).toHaveBeenCalledWith("paused");
    await stopped;
    expect(hb.getSkipReason()).toBeNull();
    expect(await hb.beat()).toMatchObject({ skipped: "paused" });
    hb.start();
    // Restart clears the prior cancellation; direct beat bypasses manual cooldown.
    expect(await hb.beat()).toMatchObject({ ok: true, payload: { stale: true } });
    await hb.stop();
  });
  it.each(["pause", "quiet", "timeout"])("preserves cancellation outcome during Jian execution: %s", async mode => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "heartbeat-jian-policy-"));
    fs.writeFileSync(path.join(root, "jian.md"), "Inspect this task.");
    vi.useFakeTimers();
    let reached!: () => void;
    let finish!: () => void;
    let signal: AbortSignal;
    let blocked: string | null = null;
    const ready = new Promise<void>(resolve => { reached = resolve; });
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const hb = testHeartbeat({ getWorkspacePath: () => root, getSkipReason: () => blocked,
      onBeat: async () => ({ ok: true }),
      onJianBeat: async (_prompt, _cwd, tools) => { signal = tools.signal; reached(); await pending; },
    });
    try {
      const run = hb.runHeartbeatOnce();
      await ready;
      if (mode === "pause") { const stopping = hb.stop(); finish(); await stopping; }
      if (mode === "quiet") { blocked = "quiet-hours"; await vi.advanceTimersByTimeAsync(1000); finish(); }
      if (mode === "timeout") await vi.advanceTimersByTimeAsync(300_000);
      expect(signal!.aborted).toBe(true);
      expect(await run).toMatchObject(mode === "timeout"
        ? { status: "failed", reason: expect.stringContaining("5min") }
        : { status: "skipped", reason: mode === "pause" ? "paused" : "quiet-hours" });
    } finally { finish(); await hb.stop(); vi.useRealTimers(); fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("aborts real execution on timeout while reporting a failure", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal;
    const onSkipped = vi.fn();
    const hb = testHeartbeat({ onSkipped, onBeat: (_prompt, extra) => {
      signal = extra.signal;
      return new Promise(() => {});
    } });
    try {
      const run = hb.runHeartbeatOnce();
      await vi.advanceTimersByTimeAsync(300_000);
      expect(signal!.aborted).toBe(true);
      expect(await run).toMatchObject({ status: "failed", reason: expect.stringContaining("5min") });
      expect(onSkipped).toHaveBeenCalledWith("timeout");
    } finally { await hb.stop(); vi.useRealTimers(); }
  });

  it("aborts when an active patrol crosses into quiet hours", async () => {
    vi.useFakeTimers();
    let blocked: string | null = null;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    let calls = 0;
    const hb = testHeartbeat({ getSkipReason: () => blocked, onBeat: (_prompt, extra) => {
      calls += 1;
      if (calls > 1) return Promise.resolve({ resumed: true });
      return new Promise((_resolve, reject) => {
        extra.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
        started();
      });
    } });
    try {
      const run = hb.runHeartbeatOnce();
      await ready;
      blocked = "quiet-hours";
      await vi.advanceTimersByTimeAsync(1000);
      expect(await run).toEqual({ status: "skipped", reason: "quiet-hours" });
      blocked = null;
      // Move beyond the manual cooldown; the previous aborted controller must not stick.
      await vi.advanceTimersByTimeAsync(120_000);
      expect(await hb.runHeartbeatOnce()).toMatchObject({ status: "ran", payload: { resumed: true } });
      expect(calls).toBe(2);
    } finally { await hb.stop(); vi.useRealTimers(); }
  });
});
