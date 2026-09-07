import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DmRouter } from "../hub/dm-router.ts";
import { appendMessage, getRecentMessages } from "../lib/channels/channel-store.ts";

const { runPhone } = vi.hoisted(() => ({ runPhone: vi.fn() }));
vi.mock("../hub/agent-executor.js", () => ({ runAgentPhoneSession: runPhone }));
vi.mock("../lib/debug-log.js", () => ({
  debugLog: () => null,
  createModuleLogger: () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const roots: string[] = [];
beforeEach(() => { runPhone.mockReset(); });
afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function setup({ onRelease = () => {} }: { onRelease?: () => void } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dm-pair-serialization-"));
  roots.push(root);
  const agentsDir = path.join(root, "agents");
  const handlers = new Set<{ handler: (reason: string) => void; meta: any }>();
  let enabled = true;
  const router = new DmRouter({ hub: {
    engine: {
      agentsDir,
      isChannelsEnabled: () => enabled,
      getAgent: (id: string) => ({ id, agentDir: path.join(agentsDir, id), agentName: id, config: {} }),
      registerAgentPhoneAbortHandler: (handler: (reason: string) => void, meta: any) => {
        const entry = { handler, meta };
        handlers.add(entry);
        return () => { handlers.delete(entry); onRelease(); };
      },
    },
    eventBus: { emit: vi.fn() },
    agentPhoneActivities: { record: vi.fn() },
  } });
  const file = (owner: string, peer: string) => path.join(agentsDir, owner, "dm", `${peer}.md`);
  const send = async (from: string, to: string, body: string) => {
    for (const [owner, peer] of [[from, to], [to, from]]) {
      const target = file(owner, peer);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (!fs.existsSync(target)) fs.writeFileSync(target, `---\npeer: ${peer}\n---\n`, "utf8");
      await appendMessage(target, from, body);
    }
    return { completion: router.handleNewDm(from, to) };
  };
  const abort = (reason: string, filter: Record<string, string> = {}) => {
    for (const entry of [...handlers]) {
      if (Object.entries(filter).every(([key, value]) => entry.meta[key] === value)) entry.handler(reason);
    }
  };
  return { router, send, file, handlers, abort, setEnabled: (value: boolean) => { enabled = value; } };
}

function deferSessions() {
  const calls: Array<{ agentId: string; text: string; options: any; resolve: (text: string) => void; reject: (error: Error) => void }> = [];
  const active = new Map<string, number>();
  const maximum = new Map<string, number>();
  runPhone.mockImplementation((agentId, rounds, options) => {
    const key = `${agentId}/${options.conversationId}`;
    active.set(key, (active.get(key) || 0) + 1);
    maximum.set(key, Math.max(maximum.get(key) || 0, active.get(key)!));
    return new Promise<string>((resolve, reject) => {
      calls.push({ agentId, text: rounds[0].text, options, resolve, reject });
    }).finally(() => { active.set(key, active.get(key)! - 1); });
  });
  const until = (count: number) => vi.waitFor(() => expect(calls).toHaveLength(count));
  return { calls, maximum, until };
}

describe("DM pair serialization", () => {
  it("serializes opposite notifications through role swaps and consumes the queued direction once", async () => {
    const fixture = setup();
    const { calls, maximum, until } = deferSessions();
    const first = await fixture.send("alice", "bob", "Alice opens");
    await until(1);
    const opposite = await fixture.send("bob", "alice", "Bob also opens");
    expect(calls).toHaveLength(1);
    calls[0].resolve("Bob replies");
    await until(2);
    expect(calls.map((call) => [call.agentId, call.options.conversationId])).toEqual([
      ["bob", "dm:alice"], ["alice", "dm:bob"],
    ]);
    expect(calls[1].text).toContain("Bob also opens");
    calls[1].resolve("Alice closes <done/>");
    await Promise.all([first.completion, opposite.completion]);
    expect(calls).toHaveLength(2);
    expect([...maximum.values()]).toEqual([1, 1]);
    for (const [owner, peer] of [["alice", "bob"], ["bob", "alice"]]) {
      const messages = getRecentMessages(fixture.file(owner, peer), 20, undefined);
      expect(messages.filter((message) => message.body === "Bob replies")).toHaveLength(1);
      expect(messages.filter((message) => message.body === "Alice closes")).toHaveLength(1);
    }
    expect(fixture.router._processing.size).toBe(0);
    expect(fixture.handlers.size).toBe(0);
  });

  it("replays same-direction messages arriving after prompt capture even when an older reply is now last", async () => {
    const fixture = setup();
    const { calls, maximum, until } = deferSessions();
    const first = await fixture.send("alice", "bob", "First question");
    await until(1);
    const second = await fixture.send("alice", "bob", "Second question during inference");
    calls[0].resolve("Answer to first <done/>");
    await until(2);
    expect(calls[1].agentId).toBe("bob");
    expect(calls[1].text).toContain("Second question during inference");
    calls[1].resolve("Answer to second <done/>");
    await Promise.all([first.completion, second.completion]);
    expect(maximum.get("bob/dm:alice")).toBe(1);
    expect(calls).toHaveLength(2);
  });

  it("deduplicates repeated notifications, coalesces bursts, and accepts new messages inside cooldown", async () => {
    const fixture = setup();
    const { calls, until } = deferSessions();
    const first = await fixture.send("alice", "bob", "First");
    await until(1);
    const duplicate = fixture.router.handleNewDm("alice", "bob");
    const second = await fixture.send("alice", "bob", "Second");
    const third = await fixture.send("alice", "bob", "Third");
    calls[0].resolve("[NO_REPLY]");
    await until(2);
    expect(calls[1].text).toContain("Second");
    expect(calls[1].text).toContain("Third");
    calls[1].resolve("[NO_REPLY]");
    await Promise.all([first.completion, duplicate, second.completion, third.completion]);
    await fixture.router.handleNewDm("alice", "bob");
    expect(calls).toHaveLength(2);
    const fourth = await fixture.send("alice", "bob", "Fresh message inside cooldown");
    await until(3);
    calls[2].resolve("Final <done/>");
    await fourth.completion;
    expect(calls).toHaveLength(3);
  });

  it("lets different peer pairs run independently with separate recipient conversations", async () => {
    const fixture = setup();
    const { calls, until } = deferSessions();
    const first = await fixture.send("bob", "alice", "Bob opens");
    const other = await fixture.send("carol", "alice", "Carol opens");
    await until(2);
    expect(calls.map((call) => call.options.conversationId).sort()).toEqual(["dm:bob", "dm:carol"]);
    calls.forEach((call) => call.resolve("Done <done/>"));
    await Promise.all([first.completion, other.completion]);
    expect(fixture.router._processing.size).toBe(0);
  });

  it.each(["dm-reset", "channels-disabled"])("cancels queued and late replies on %s and releases the pair after teardown", async (reason) => {
    const fixture = setup();
    const { calls, until } = deferSessions();
    const first = await fixture.send("alice", "bob", "First");
    await until(1);
    const pending = await fixture.send("bob", "alice", "Queued reverse direction");
    if (reason === "channels-disabled") fixture.setEnabled(false);
    fixture.abort(reason, reason === "dm-reset" ? { agentId: "alice", conversationId: "dm:bob" } : {});
    expect(calls[0].options.signal.aborted).toBe(true);
    expect(fixture.router._processing.size).toBe(1);
    calls[0].resolve("Late reply must be discarded <done/>");
    await Promise.all([first.completion, pending.completion]);
    expect(calls).toHaveLength(1);
    expect(getRecentMessages(fixture.file("bob", "alice"), 20, undefined).some((message) => message.body.includes("Late reply"))).toBe(false);
    expect(fixture.router._processing.size).toBe(0);
    expect(fixture.router._cooldowns.size).toBe(0);
    expect(fixture.handlers.size).toBe(0);
    fixture.setEnabled(true);
    const fresh = await fixture.send("alice", "bob", "Fresh after reset");
    await until(2);
    expect(calls[1].options.signal.aborted).toBe(false);
    calls[1].resolve("Fresh reply <done/>");
    await fresh.completion;
  });

  it("aborts timed-out work but holds the pair until that SDK session finishes unwinding", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fixture = setup();
    const { calls, maximum, until } = deferSessions();
    const first = await fixture.send("alice", "bob", "Slow request");
    await until(1);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(calls[0].options.signal.aborted).toBe(true);
    const fresh = await fixture.send("alice", "bob", "New message while abort unwinds");
    expect(calls).toHaveLength(1);
    expect(fixture.router._processing.size).toBe(1);
    calls[0].resolve("Stale reply <done/>");
    await until(2);
    expect(calls[1].text).toContain("New message while abort unwinds");
    expect(calls[1].options.signal.aborted).toBe(false);
    calls[1].resolve("Fresh reply <done/>");
    await Promise.all([first.completion, fresh.completion]);
    expect(maximum.get("bob/dm:alice")).toBe(1);
    expect(fixture.router._processing.size).toBe(0);
    expect(fixture.handlers.size).toBe(0);
  });

  it("cleans up a failed prompt and still delivers an independently queued message", async () => {
    const fixture = setup();
    const { calls, until } = deferSessions();
    const first = await fixture.send("alice", "bob", "First request");
    await until(1);
    const second = await fixture.send("bob", "alice", "Independent message");
    calls[0].reject(new Error("provider failure"));
    await until(2);
    expect(calls[1].agentId).toBe("alice");
    calls[1].resolve("Recovered <done/>");
    await Promise.all([first.completion, second.completion]);
    expect(fixture.router._processing.size).toBe(0);
    expect(fixture.handlers.size).toBe(0);
  });

  it("keeps notifications arriving between worker cleanup and promise settlement", async () => {
    let sentDuringCleanup = false;
    let lateCompletion: Promise<void>;
    const fixture = setup({ onRelease: () => {
      if (sentDuringCleanup) return;
      sentDuringCleanup = true;
      for (const [owner, peer] of [["alice", "bob"], ["bob", "alice"]]) {
        fs.appendFileSync(fixture.file(owner, peer), "\n### alice | 2026-09-07 12:00:00\n\nArrived during cleanup\n\n---\n", "utf8");
      }
      lateCompletion = fixture.router.handleNewDm("alice", "bob");
    } });
    const { calls, until } = deferSessions();
    const first = await fixture.send("alice", "bob", "Initial message");
    await until(1);
    calls[0].resolve("[NO_REPLY]");
    await until(2);
    expect(calls[1].text).toContain("Arrived during cleanup");
    calls[1].resolve("Handled <done/>");
    await Promise.all([first.completion, lateCompletion]);
    expect(fixture.router._processing.size).toBe(0);
  });

  it("releases partial abort registrations when pair initialization fails", async () => {
    const fixture = setup();
    const register = fixture.router._engine.registerAgentPhoneAbortHandler;
    let registrations = 0;
    fixture.router._engine.registerAgentPhoneAbortHandler = (...args: any[]) => {
      registrations++;
      if (registrations === 2) throw new Error("registration failed");
      return register(...args);
    };
    const first = await fixture.send("alice", "bob", "Initial message");
    await expect(first.completion).resolves.toBeUndefined();
    expect(runPhone).not.toHaveBeenCalled();
    expect(fixture.handlers.size).toBe(0);
    expect(fixture.router._processing.size).toBe(0);
  });
});
