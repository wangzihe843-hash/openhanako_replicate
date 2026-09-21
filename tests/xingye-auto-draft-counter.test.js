import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendXingyeEvent, appendXingyeEventOnce } from "../lib/xingye/events.js";
import { runXingyeHeartbeatConsumer, XINGYE_HEARTBEAT_CONSUMER_ID } from "../lib/xingye/heartbeat-consumer.js";

let root;
let agentDir;
let logPath;
let clock;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "xingye-draft-counter-"));
  agentDir = path.join(root, "agents", "agent-a");
  logPath = path.join(agentDir, "xingye", "events", "log.json");
  clock = "2026-01-01T01:00:00.000Z";
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

const readLog = () => JSON.parse(fs.readFileSync(logPath, "utf8"));
const append = (id, createdAt, type = "recent_chat.observed", extra = {}) => appendXingyeEvent({
  agentDir,
  agentId: "agent-a",
  input: { id, createdAt, type, source: "regression-test", payload: {}, ...extra },
});
async function consume(consumer = runXingyeHeartbeatConsumer) {
  const output = await consumer({ agentDir, agentId: "agent-a", now: () => new Date(clock) });
  return output.result?.autoDraftStaleness ?? output.autoDraftStaleness;
}

describe("durable auto-draft progress", () => {
  it("crosses the threshold across retention windows and restart without keeping old events", async () => {
    for (let cycle = 0; cycle < 4; cycle += 1) {
      const base = Date.parse("2026-01-01T00:00:00.000Z") + cycle * 8 * 86_400_000;
      clock = new Date(base + 60_000).toISOString();
      for (let turn = 0; turn < 20; turn += 1) {
        await append("cycle-" + cycle + "-" + turn, new Date(base + turn * 1000).toISOString());
      }
      const result = await consume();
      expect(result.chatTurnsSinceLastDraft).toBe((cycle + 1) * 20);
      expect(result.mustPropose).toBe(cycle >= 2);
      expect(readLog().autoDraftState.userTurnCount).toBe((cycle + 1) * 20);
      expect(readLog().events).toHaveLength(20);
    }
    vi.resetModules();
    const restarted = await import("../lib/xingye/heartbeat-consumer.js");
    expect((await consume(restarted.runXingyeHeartbeatConsumer)).chatTurnsSinceLastDraft).toBe(80);
    clock = "2026-03-01T00:00:00.000Z";
    expect((await consume()).mustPropose).toBe(true);
    expect(readLog().events).toEqual([]);
    expect(readLog().dedupeKeys).toEqual({});
    expect((await consume()).chatTurnsSinceLastDraft).toBe(80);
  });

  it.each(["draft-first", "chat-first"])("uses strict event-time baselines without dropping late or same-millisecond chats: %s", async (order) => {
    const before = "2026-01-01T00:00:01.000Z";
    const draftAt = "2026-01-01T00:00:02.000Z";
    const after = "2026-01-01T00:00:03.000Z";
    if (order === "chat-first") {
      await append("latest", after);
      await consume();
    }
    await append("draft", draftAt, "journal.draft_proposed");
    await consume();
    if (order === "draft-first") {
      await append("latest", after);
      await consume();
    }
    await append("same-ms", draftAt);
    await append("late-before", before);
    await append("late-after", "2026-01-01T00:00:02.500Z");
    const result = await consume();
    expect(result).toMatchObject({ lastAutoDraftAt: draftAt, chatTurnsSinceLastDraft: 2 });
    expect(readLog().autoDraftState).toMatchObject({ userTurnCount: 4, lastAutoDraftTurn: 2, baselineUncertain: false });
    expect((await consume()).chatTurnsSinceLastDraft).toBe(2);
    await append("older-draft", before, "mail.draft_proposed");
    expect((await consume()).chatTurnsSinceLastDraft).toBe(2);
  });

  it("retains progress for a late draft predating pruned chats until a fresh draft resets the baseline", async () => {
    await append("one", "2026-01-01T00:00:01.000Z");
    await append("two", "2026-01-01T00:00:03.000Z");
    await consume();
    clock = "2026-01-10T00:00:00.000Z";
    await consume();
    expect(readLog().events).toEqual([]);
    await append("late-draft", "2026-01-01T00:00:02.000Z", "journal.draft_proposed");
    expect((await consume()).chatTurnsSinceLastDraft).toBe(2);
    expect(readLog().autoDraftState.baselineUncertain).toBe(true);
    await append("late-chat", "2026-01-01T00:00:02.500Z");
    expect((await consume()).chatTurnsSinceLastDraft).toBe(3);

    await append("fresh-draft", clock, "journal.draft_proposed");
    expect((await consume()).chatTurnsSinceLastDraft).toBe(0);
    expect(readLog().autoDraftState).toMatchObject({ userTurnCount: 3, lastAutoDraftTurn: 3, baselineUncertain: false });
    await append("new-chat", "2026-01-10T00:00:01.000Z");
    expect((await consume()).chatTurnsSinceLastDraft).toBe(1);
  });

  it("deduplicates repeated IDs and receipt-bearing replay even after the original log is pruned", async () => {
    const input = { id: "replay", type: "recent_chat.observed", source: "test", payload: {}, createdAt: clock };
    await appendXingyeEventOnce({ agentDir, agentId: "agent-a", input, dedupeKey: "turn" });
    await appendXingyeEventOnce({ agentDir, agentId: "agent-a", input, dedupeKey: "turn" });
    await append("replay", clock);
    expect((await consume()).chatTurnsSinceLastDraft).toBe(1);
    const counted = readLog().events[0];
    await appendXingyeEvent({ agentDir, agentId: "agent-a", input: counted });
    expect((await consume()).chatTurnsSinceLastDraft).toBe(1);
    clock = "2026-02-01T00:00:00.000Z";
    await consume();
    expect(readLog().events).toEqual([]);
    await appendXingyeEvent({ agentDir, agentId: "agent-a", input: counted });
    expect((await consume()).chatTurnsSinceLastDraft).toBe(1);
    expect(readLog().autoDraftState.userTurnCount).toBe(1);
  });

  it("migrates already-consumed legacy arrays as a retained-history lower bound", async () => {
    const legacy = [
      { id: "old-1", agentId: "agent-a", type: "recent_chat.observed", source: "test", payload: {}, createdAt: clock },
      { id: "old-2", agentId: "agent-a", type: "recent_chat.observed", source: "test", payload: {}, createdAt: clock },
    ].map(event => ({ ...event, consumedBy: { [XINGYE_HEARTBEAT_CONSUMER_ID]: clock } }));
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, JSON.stringify(legacy));
    clock = "2026-02-01T00:00:00.000Z";
    expect((await consume()).chatTurnsSinceLastDraft).toBe(2);
    expect(readLog().autoDraftState.userTurnCount).toBe(2);
    expect(readLog().events).toEqual([]);
    expect((await consume()).chatTurnsSinceLastDraft).toBe(2);
  });

  it("does not advance receipts or progress when the counter document cannot be committed", async () => {
    await append("one", clock);
    const before = fs.readFileSync(logPath, "utf8");
    const rename = fs.promises.rename.bind(fs.promises);
    vi.spyOn(fs.promises, "rename").mockImplementation(async (source, destination) => {
      if (destination === logPath) throw new Error("simulated counter commit failure");
      return rename(source, destination);
    });
    await expect(consume()).rejects.toThrow("simulated counter commit failure");
    expect(fs.readFileSync(logPath, "utf8")).toBe(before);
    vi.restoreAllMocks();
    expect((await consume()).chatTurnsSinceLastDraft).toBe(1);
    expect((await consume()).chatTurnsSinceLastDraft).toBe(1);
  });

  it("fails without replacing an invalid persisted counter", async () => {
    await append("one", clock);
    const log = readLog();
    log.autoDraftState = { version: 99, userTurnCount: 400 };
    fs.writeFileSync(logPath, JSON.stringify(log));
    const before = fs.readFileSync(logPath, "utf8");
    await expect(consume()).rejects.toThrow("invalid Xingye auto-draft counter state");
    expect(fs.readFileSync(logPath, "utf8")).toBe(before);
  });
});
