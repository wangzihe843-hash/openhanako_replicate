import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserManager } from "../lib/browser/browser-manager.ts";

type Command = { id: string; cmd: string; params: { sessionPath?: string } };
class BrowserHost extends EventEmitter {
  readyState = 1;
  commands: Command[] = [];
  rejectSession: string | null = null;
  silent = false;
  send(payload: string) {
    const command = JSON.parse(payload) as Command;
    this.commands.push(command);
    if (this.silent) return;
    this.emit("message", JSON.stringify({
      type: "browser-result", id: command.id,
      ...(command.params.sessionPath === this.rejectSession
        ? { error: "host refused command" }
        : { result: {} }),
    }));
  }
}

let home: string;
let manager: BrowserManager;
let host: BrowserHost;
const session = "/sessions/lifecycle-a.json";
const second = "/sessions/lifecycle-b.json";
const url = "https://example.test/retained";
const coldFile = () => path.join(home, "user", "browser-sessions.json");
function track(sp = session) {
  manager._setSessionEntry(sp, {
    running: true, url, activeTabId: "t1", tabs: [{ tabId: "t1", url }],
  });
  manager._touchLru(sp);
}
function blockWrites() {
  fs.mkdirSync(`${coldFile()}.tmp`);
}
function unblockWrites() {
  fs.rmdirSync(`${coldFile()}.tmp`);
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "hana-browser-lifecycle-"));
  fs.mkdirSync(path.join(home, "user"));
  BrowserManager.setHanakoHome(home);
  // Vitest's fork worker exposes process.send; select the production WS branch
  // only during construction, then restore the worker's IPC channel immediately.
  const send = process.send;
  try {
    process.send = undefined;
    manager = new BrowserManager();
  } finally {
    process.send = send;
  }
  host = new BrowserHost();
  manager.setWsTransport(host);
  track();
});
afterEach(() => {
  clearInterval(manager._idleSweepTimer);
  manager.setWsTransport(null);
  vi.useRealTimers();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("E06 browser lifecycle failures through WS transport", () => {
  it("retains running state, LRU and cold record on rejected close, then retries", async () => {
    manager._saveColdWorkspace(session, manager._getSessionEntry(session));
    const saved = fs.readFileSync(coldFile(), "utf8");
    host.rejectSession = session;
    await expect(manager.close(session)).rejects.toThrow("host refused");
    expect(manager.isRunning(session)).toBe(true);
    expect(manager._lruOrder).toContain(session);
    expect(fs.readFileSync(coldFile(), "utf8")).toBe(saved);
    host.rejectSession = null;
    await manager.close(session);
    expect(manager._getSessionEntry(session)).toBeNull();
    expect(manager.getBrowserSessionStates()[session]).toBeUndefined();
  });

  it("keeps a suspended record when destroyView fails, then retries", async () => {
    await manager.suspendForSession(session);
    host.rejectSession = session;
    await expect(manager.closeBrowserForSession(session)).rejects.toThrow("host refused");
    expect(manager.getBrowserSessionStates()[session]).toMatchObject({ running: false, resumable: true });
    host.rejectSession = null;
    await manager.closeBrowserForSession(session);
    expect(manager.getBrowserSessionStates()[session]).toBeUndefined();
  });

  it("returns a failed suspension without losing tracking and retries after host recovery", async () => {
    host.rejectSession = session;
    expect(await manager.suspendForSession(session)).toBe(false);
    expect(manager.isRunning(session)).toBe(true);
    expect(manager._lruOrder).toContain(session);
    host.rejectSession = null;
    expect(await manager.suspendForSession(session)).toBe(true);
    expect(manager._getSessionEntry(session)).toBeNull();
    expect(manager.getBrowserSessionStates()[session]).toMatchObject({ running: false, resumable: true });
  });

  it("does not detach or discard live state when atomic persistence fails", async () => {
    blockWrites();
    expect(await manager.suspendForSession(session)).toBe(false);
    expect(host.commands.some(command => command.cmd === "suspend")).toBe(false);
    expect(manager.isRunning(session)).toBe(true);
    expect(manager._lruOrder).toContain(session);
    expect(fs.existsSync(coldFile())).toBe(false);
    const restarted = new BrowserManager();
    expect(restarted.getBrowserSessionStates()[session]).toBeUndefined();
    unblockWrites();
    expect(await manager.suspendForSession(session)).toBe(true);
    expect(restarted.getBrowserSessionStates()[session]).toMatchObject({ resumable: true });
  });

  it("reports failed writes explicitly and can retry the same snapshot", () => {
    blockWrites();
    expect(manager._saveColdState({ [session]: url })).toBe(false);
    unblockWrites();
    expect(manager._saveColdState({ [session]: url })).toBe(true);
  });

  it("does not claim a confirmed closed host is running or resumable when cold deletion fails", async () => {
    manager._saveColdWorkspace(session, manager._getSessionEntry(session));
    blockWrites();
    await expect(manager.close(session)).rejects.toThrow("persist");
    expect(manager.isRunning(session)).toBe(false);
    expect(manager._lruOrder).not.toContain(session);
    expect(manager.getBrowserSessionStates()[session]).toMatchObject({ running: false, resumable: false });
    expect(manager.resumeReadinessForSession(session).canResume).toBe(false);
    unblockWrites();
    manager.setWsTransport(null);
    await manager.closeBrowserForSession(session);
    expect(manager.getBrowserSessionStates()[session]).toBeUndefined();
  });

  it("retains uncertainty on disconnect and accepts an absent-view acknowledgement after reconnect", async () => {
    manager.setWsTransport(null);
    await expect(manager.close(session)).rejects.toThrow();
    expect(await manager.suspendForSession(session)).toBe(false);
    expect(manager.isRunning(session)).toBe(true);
    manager.setWsTransport(host);
    // The real host returns {} when close/destroyView finds no workspace.
    await manager.close(session);
    expect(manager._getSessionEntry(session)).toBeNull();
  });

  it("retains state after a real command timeout and accepts a retry", async () => {
    vi.useFakeTimers();
    host.silent = true;
    const closing = expect(manager.close(session)).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(30_000);
    await closing;
    expect(manager.isRunning(session)).toBe(true);
    expect(manager._lruOrder).toContain(session);
    expect(manager._pending.size).toBe(0);
    host.silent = false;
    await manager.close(session);
    expect(manager._getSessionEntry(session)).toBeNull();
  });

  it("clears the pending timer when transport.send throws synchronously", async () => {
    vi.useFakeTimers();
    const send = vi.spyOn(host, "send").mockImplementation(() => { throw new Error("send failed"); });
    await expect(manager.close(session)).rejects.toThrow("send failed");
    expect(manager._pending.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(manager.isRunning(session)).toBe(true);
    send.mockRestore();
    await manager.close(session);
  });

  it("continues a shutdown-style suspension loop after one failure", async () => {
    track(second);
    host.rejectSession = session;
    const results: boolean[] = [];
    for (const sp of manager.runningSessions) results.push(await manager.suspendForSession(sp));
    expect(results).toEqual([false, true]);
    expect(manager.isRunning(session)).toBe(true);
    expect(manager.isRunning(second)).toBe(false);
  });

  it("tries the next LRU candidate after failure", async () => {
    track(second);
    host.rejectSession = session;
    expect(await manager._evictLru()).toBe(true);
    expect(manager.isRunning(session)).toBe(true);
    expect(manager.isRunning(second)).toBe(false);
    expect(host.commands.filter(command => command.cmd === "suspend").map(command => command.params.sessionPath))
      .toEqual([session, second]);
  });

  it.each(["launch", "resumeForSession", "resumeForSessionIfAvailable"] as const)(
    "%s refuses capacity growth when every eviction fails", async method => {
      for (let index = 0; index < 4; index++) track(`/sessions/capacity-${index}.json`);
      manager._saveColdState({ [second]: url });
      const suspend = vi.spyOn(manager, "suspendForSession").mockResolvedValue(false);
      await expect(manager[method](second)).rejects.toThrow("Browser limit reached");
      expect(suspend).toHaveBeenCalledTimes(5);
      expect(manager.runningSessions).toHaveLength(5);
      expect(host.commands.some(command => command.cmd === "launch" || command.cmd === "resume")).toBe(false);
    },
  );

  it("does not discard fork cleanup state after persistence failure", () => {
    manager._saveColdState({ [second]: url });
    blockWrites();
    expect(() => manager.discardForkedSessionState({ sessionPath: second })).toThrow("persist");
    expect(manager.getBrowserSessionStates()[second]).toMatchObject({ resumable: true });
    unblockWrites();
    expect(manager.discardForkedSessionState({ sessionPath: second })).toEqual({ discarded: true });
  });
});
