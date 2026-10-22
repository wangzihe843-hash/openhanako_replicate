import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { constants } from "node:os";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import * as runtime from "../scripts/dev-web-runtime.js";

const scriptUrl = new URL("../scripts/dev-web.js", import.meta.url);
const source = fs.readFileSync(scriptUrl, "utf8")
  .replace(/^#![^\n]*\n/, "")
  .replace(/^import\b[\s\S]*?;\r?\n/gm, "")
  .replaceAll("import.meta.url", "scriptUrl");

class Child extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kill = vi.fn((_signal: string) => true);
  constructor(public pid: number | undefined) { super(); }
  exit(code: number | null, signal: NodeJS.Signals | null = null) {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }
  close() { this.emit("close", this.exitCode, this.signalCode); }
}

function harness({ ready = true, throwAt = 0, platform = "darwin" } = {}) {
  const server = new Child(41001);
  const vite = new Child(41002);
  const processStub = Object.assign(new EventEmitter(), {
    env: { HANA_TOKEN: "synthetic-owner" },
    execPath: process.execPath,
    platform,
    exitCode: undefined as number | undefined,
    stdout: { write: vi.fn() },
  });
  const spawn = vi.fn(() => {
    if (spawn.mock.calls.length === throwAt) throw new Error("synthetic spawn throw");
    return spawn.mock.calls.length === 1 ? server : vite;
  });
  const record = { pid: server.pid, port: 4567, token: "synthetic-owner" };
  const fsStub = {
    mkdirSync: vi.fn(),
    readFileSync: vi.fn(() => {
      if (!ready) throw new Error("synthetic pending record");
      return JSON.stringify(record);
    }),
  };
  const consoleStub = { error: vi.fn(), warn: vi.fn() };
  // Execute the full launcher body. Only OS process creation, data I/O, and helper
  // compilation are intercepted; no service, user data, or listening port exists.
  const startup: Promise<void> = vm.runInNewContext("(async () => {\n" + source + "\n})()", {
    scriptUrl: scriptUrl.href, fileURLToPath, path, randomBytes,
    constants: { signals: { ...constants.signals, SIGBREAK: 21 } },
    fs: fsStub, spawn, process: processStub, console: consoleStub,
    setTimeout, clearTimeout, Date,
    applyDevEnvironment: (env: NodeJS.ProcessEnv) => env,
    resolveHanakoHome: () => "/synthetic-only/no-io",
    ensureWindowsSandboxHelper: vi.fn(),
    ...runtime,
  }, { filename: fileURLToPath(scriptUrl) });
  return { server, vite, process: processStub, spawn, startup, fs: fsStub, console: consoleStub, record };
}

describe("dev-web child lifecycle", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it.each(["server", "vite"] as const)("propagates %s exit 7 and stops its owned peer", async (role) => {
    const h = harness(); await h.startup;
    h[role].exit(7);
    const peer = role === "server" ? h.vite : h.server;
    expect(h.process.exitCode).toBe(7);
    expect(peer.kill.mock.calls).toEqual([["SIGTERM"]]);
    expect(h[role].kill).not.toHaveBeenCalled();
    peer.exit(null, "SIGTERM"); peer.close(); h[role].close();
    expect(h.process.exitCode).toBe(7);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, 1])("preserves an ordinary Vite exit %i", async (code) => {
    const h = harness(); await h.startup;
    h.vite.exit(code); h.vite.close();
    h.server.exit(null, "SIGTERM"); h.server.close();
    expect(h.process.exitCode ?? 0).toBe(code);
    expect(h.server.kill.mock.calls).toEqual([["SIGTERM"]]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["SIGINT", "SIGTERM", "SIGKILL"] as const)("reports child %s as a signal exit status and stops its peer safely", async (signal) => {
    const h = harness(); await h.startup;
    h.vite.exit(null, signal);
    expect(h.process.exitCode).toBe(128 + constants.signals[signal]);
    expect(h.server.kill.mock.calls).toEqual([["SIGTERM"]]);
  });

  it.each(["SIGINT", "SIGTERM"] as const)("preserves parent %s through expected child exits and repeated interruption", async (signal) => {
    const h = harness(); await h.startup;
    h.process.emit(signal); h.process.emit("SIGTERM");
    for (const child of [h.server, h.vite]) {
      expect(child.kill.mock.calls).toEqual([[signal]]);
      child.exit(null, signal); child.close();
    }
    expect(h.process.exitCode).toBe(128 + constants.signals[signal]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("registers the Windows SIGBREAK branch (synthetic only)", async () => {
    const h = harness({ platform: "win32" }); await h.startup;
    h.process.emit("SIGBREAK");
    expect(h.process.exitCode).toBe(149);
    expect(h.server.kill.mock.calls).toEqual([["SIGBREAK"]]);
    expect(h.vite.kill.mock.calls).toEqual([["SIGBREAK"]]);
  });

  it("handles Vite ENOENT without throwing or abandoning the already started server", async () => {
    const h = harness(); await h.startup;
    h.vite.pid = undefined;
    const err = Object.assign(new Error("synthetic Vite ENOENT"), { code: "ENOENT" });
    expect(() => h.vite.emit("error", err)).not.toThrow();
    h.vite.close();
    expect(h.process.exitCode).toBe(1);
    expect(h.console.error).toHaveBeenCalledWith(expect.stringContaining("synthetic Vite ENOENT"));
    expect(h.server.kill.mock.calls).toEqual([["SIGTERM"]]);
    expect(h.vite.kill).not.toHaveBeenCalled();
  });

  it("handles server ENOENT before readiness without starting Vite or signaling a missing PID", async () => {
    const h = harness({ ready: false }); h.server.pid = undefined;
    expect(() => h.server.emit("error", new Error("synthetic server ENOENT"))).not.toThrow();
    h.server.close();
    await vi.advanceTimersByTimeAsync(200); await h.startup;
    expect(h.process.exitCode).toBe(1);
    expect(h.spawn).toHaveBeenCalledTimes(1);
    expect(h.server.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, 7])("does not start Vite when server exits %i before readiness", async (code) => {
    const h = harness({ ready: false });
    h.server.exit(code); h.server.close();
    await vi.advanceTimersByTimeAsync(200); await h.startup;
    expect(h.process.exitCode).toBe(code || 1);
    expect(h.spawn).toHaveBeenCalledTimes(1);
    expect(h.server.kill).not.toHaveBeenCalled();
  });

  it("does not start Vite after interrupting readiness, even if an owned record arrives", async () => {
    const h = harness({ ready: false });
    h.process.emit("SIGINT");
    h.fs.readFileSync.mockImplementation(() => JSON.stringify(h.record));
    await vi.advanceTimersByTimeAsync(200); await h.startup;
    expect(h.spawn).toHaveBeenCalledTimes(1);
    expect(h.process.exitCode).toBe(130);
    expect(h.console.error).not.toHaveBeenCalled();
  });

  it("blocks a queued Vite startup continuation after shutdown", async () => {
    const h = harness();
    h.process.emit("SIGTERM");
    await h.startup;
    expect(h.spawn).toHaveBeenCalledTimes(1);
    expect(h.process.exitCode).toBe(143);
  });

  it.each([1, 2])("handles synchronous spawn failure at child %i", async (throwAt) => {
    const h = harness({ throwAt }); await h.startup;
    expect(h.process.exitCode).toBe(1);
    expect(h.console.error).toHaveBeenCalledWith(expect.stringContaining("synthetic spawn throw"));
    expect(h.server.kill).toHaveBeenCalledTimes(throwAt === 2 ? 1 : 0);
    expect(h.vite.kill).not.toHaveBeenCalled();
  });

  it("cleans its server on a readiness timeout", async () => {
    const h = harness({ ready: false });
    await vi.advanceTimersByTimeAsync(90_000); await h.startup;
    expect(h.process.exitCode).toBe(1);
    expect(h.spawn).toHaveBeenCalledTimes(1);
    expect(h.server.kill.mock.calls).toEqual([["SIGTERM"]]);
    expect(h.console.error).toHaveBeenCalledWith(expect.stringContaining("Timed out"));
  });

  it("keeps the first failure under concurrent error/exit and reentrant shutdown", async () => {
    const h = harness(); await h.startup;
    h.vite.exit(7);
    expect(() => h.vite.emit("error", new Error("late error"))).not.toThrow();
    h.process.emit("SIGINT"); h.server.exit(9); h.vite.close(); h.server.close();
    expect(h.process.exitCode).toBe(7);
    expect(h.server.kill.mock.calls).toEqual([["SIGTERM"]]);
    expect(h.vite.kill).not.toHaveBeenCalled();
    expect(h.console.error).toHaveBeenCalledWith(expect.stringContaining("late error"));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not let a subsequent exit 0 overwrite a startup error", async () => {
    const h = harness(); await h.startup;
    h.vite.emit("error", new Error("launch failure"));
    h.vite.exit(0); h.server.exit(0); h.vite.close(); h.server.close();
    expect(h.process.exitCode).toBe(1);
  });

  it("does not hide a peer failure after the first child exits cleanly", async () => {
    const h = harness(); await h.startup;
    h.vite.exit(0); h.server.exit(7);
    expect(h.process.exitCode).toBe(7);
  });

  it("does not hide a cleanup error after a clean exit", async () => {
    const h = harness(); await h.startup;
    h.vite.exit(0); h.server.emit("error", new Error("cleanup failed"));
    expect(h.process.exitCode).toBe(1);
    expect(h.console.error).toHaveBeenCalledWith(expect.stringContaining("cleanup failed"));
    expect(h.server.kill).toHaveBeenCalledTimes(1);
  });

  it("retains child ownership through close, escalating only a still live child after grace", async () => {
    const h = harness(); await h.startup;
    h.vite.exit(0); h.vite.close();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(h.server.kill.mock.calls).toEqual([["SIGTERM"]]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.server.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
    expect(h.process.exitCode).toBe(1);
    h.server.exit(null, "SIGKILL"); h.server.close();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.server.kill).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not signal an exited child while waiting for a delayed close", async () => {
    const h = harness(); await h.startup;
    h.vite.exit(7); h.vite.close(); h.server.exit(null, "SIGTERM");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.server.kill.mock.calls).toEqual([["SIGTERM"]]);
    h.server.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears all grace timers when children close", async () => {
    const h = harness(); await h.startup;
    h.process.emit("SIGTERM");
    for (const child of [h.server, h.vite]) { child.exit(null, "SIGTERM"); child.close(); }
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5_001);
    expect(h.server.kill).toHaveBeenCalledTimes(1);
    expect(h.vite.kill).toHaveBeenCalledTimes(1);
  });

  it.each(["throws", "returns false"])("reports a child kill that %s and still cleans the other child", async (mode) => {
    const h = harness(); await h.startup;
    h.server.kill.mockImplementation(() => { if (mode === "throws") throw new Error("synthetic EPERM"); return false; });
    expect(() => h.process.emit("SIGTERM")).not.toThrow();
    expect(h.console.error).toHaveBeenCalled();
    expect(h.vite.kill.mock.calls).toEqual([["SIGTERM"]]);
    expect(h.process.exitCode).toBe(143);
  });

  it("never adopts or signals a PID from an unrelated server-info record", async () => {
    const h = harness({ ready: false });
    h.fs.readFileSync.mockImplementation(() => JSON.stringify({ pid: 99001, token: "other-owner", port: 1234 }));
    await vi.advanceTimersByTimeAsync(200);
    h.process.emit("SIGINT");
    h.server.exit(null, "SIGINT"); h.server.close();
    await vi.advanceTimersByTimeAsync(200); await h.startup;
    expect(h.spawn).toHaveBeenCalledTimes(1);
    expect(h.server.kill.mock.calls).toEqual([["SIGINT"]]);
    expect(h.vite.kill).not.toHaveBeenCalled();
    expect(h.process.exitCode).toBe(130);
  });
});
