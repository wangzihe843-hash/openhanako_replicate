import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Scheduler } from "../hub/scheduler.js";

function mktemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hana-xingye-hb-"));
}

function writeEventLog(agentsDir, agentId, events) {
  const logPath = path.join(agentsDir, agentId, "xingye", "events", "log.json");
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(
    logPath,
    JSON.stringify({ version: 1, events, dedupeKeys: {} }, null, 2),
    "utf-8",
  );
  return logPath;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

async function waitFor(predicate) {
  const started = Date.now();
  while (Date.now() - started < 1000) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for condition");
}

function createSchedulerFixture() {
  const tempRoot = mktemp();
  const agentsDir = path.join(tempRoot, "agents");
  const workspaceDir = path.join(tempRoot, "workspace");
  fs.mkdirSync(path.join(agentsDir, "agent-a", "desk"), { recursive: true });
  fs.mkdirSync(path.join(agentsDir, "agent-b", "desk"), { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });

  const activities = [];
  const agents = new Map([
    ["agent-a", {
      id: "agent-a",
      agentName: "Agent A",
      deskDir: path.join(agentsDir, "agent-a", "desk"),
      deskManager: {},
      cronStore: {},
      config: { desk: { heartbeat_enabled: false } },
    }],
    ["agent-b", {
      id: "agent-b",
      agentName: "Agent B",
      deskDir: path.join(agentsDir, "agent-b", "desk"),
      deskManager: {},
      cronStore: {},
      config: { desk: { heartbeat_enabled: false } },
    }],
  ]);

  const engine = {
    agentsDir,
    agents,
    getAgent: (agentId) => agents.get(agentId) || null,
    getHomeCwd: () => workspaceDir,
    getHeartbeatMaster: () => false,
    executeIsolated: vi.fn(async () => ({ sessionPath: null })),
    summarizeActivity: vi.fn(),
    getActivityStore: () => ({ add: (entry) => activities.push(entry) }),
    emitDevLog: vi.fn(),
  };
  const eventBus = { emit: vi.fn() };
  const scheduler = new Scheduler({ hub: { engine, eventBus } });
  scheduler.startAgentHeartbeat("agent-a", agents.get("agent-a"));
  scheduler.startAgentHeartbeat("agent-b", agents.get("agent-b"));

  return { tempRoot, agentsDir, scheduler, engine, eventBus, activities };
}

describe("Xingye heartbeat event consumer", () => {
  let fixture;

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    fixture = createSchedulerFixture();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (fixture?.scheduler) await fixture.scheduler.stopHeartbeat();
    if (fixture?.tempRoot) fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
    fixture = null;
  });

  it("manual heartbeat trigger consumes only current agent Xingye events once and records suggestions", async () => {
    const firstEvent = {
      id: "evt-a-1",
      agentId: "agent-a",
      type: "phone.sms_appended",
      source: "phone",
      subjectId: "contact-1",
      createdAt: "2026-05-13T00:00:00.000Z",
      payload: { contactId: "contact-1", body: "hello" },
    };
    const secondEvent = {
      id: "evt-a-2",
      agentId: "agent-a",
      type: "secret_space.record_appended",
      source: "secret-space",
      subjectId: "dream-1",
      createdAt: "2026-05-13T00:01:00.000Z",
      payload: { category: "dream", recordId: "dream-1" },
    };
    const otherAgentEvent = {
      id: "evt-b-1",
      agentId: "agent-b",
      type: "phone.contact_changed",
      source: "phone",
      subjectId: "contact-b",
      createdAt: "2026-05-13T00:02:00.000Z",
      payload: { contactId: "contact-b" },
    };
    const agentALogPath = writeEventLog(fixture.agentsDir, "agent-a", [firstEvent, secondEvent]);
    const agentBLogPath = writeEventLog(fixture.agentsDir, "agent-b", [otherAgentEvent]);

    const heartbeat = fixture.scheduler.getHeartbeat("agent-a");
    expect(heartbeat).toBeTruthy();
    expect(heartbeat.triggerNow()).toBe(true);

    const resultPath = path.join(fixture.agentsDir, "agent-a", "xingye", "heartbeat", "result.json");
    const historyPath = path.join(fixture.agentsDir, "agent-a", "xingye", "heartbeat", "history.jsonl");
    await waitFor(() => fs.existsSync(resultPath));

    const result = readJson(resultPath);
    expect(result).toMatchObject({
      version: 1,
      consumerId: "xingye.heartbeat",
      agentId: "agent-a",
      eventCount: 2,
      consumedEventIds: ["evt-a-1", "evt-a-2"],
    });
    expect(result.summary).toContain("2");
    expect(result.observations).toEqual(expect.arrayContaining([
      expect.stringContaining("phone.sms_appended"),
      expect.stringContaining("secret_space.record_appended"),
    ]));
    expect(result.suggestedActions.length).toBeGreaterThan(0);

    await waitFor(() => readJson(agentALogPath).events.every((event) => event.consumedBy?.["xingye.heartbeat"]));
    let agentALog = readJson(agentALogPath);
    expect(agentALog.events.map((event) => event.consumedBy?.["xingye.heartbeat"])).toEqual([
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    ]);
    expect(readJson(agentBLogPath).events[0].consumedBy).toBeUndefined();
    expect(fs.readFileSync(historyPath, "utf-8").trim().split(/\r?\n/)).toHaveLength(1);

    await heartbeat.beat();
    expect(fs.readFileSync(historyPath, "utf-8").trim().split(/\r?\n/)).toHaveLength(1);

    agentALog.events.push({
      id: "evt-a-3",
      agentId: "agent-a",
      type: "relationship_state.suggested",
      source: "relationship-state",
      subjectId: "state-1",
      createdAt: "2026-05-13T00:03:00.000Z",
      payload: { mood: "curious" },
    });
    fs.writeFileSync(agentALogPath, JSON.stringify(agentALog, null, 2), "utf-8");

    await heartbeat.beat();

    const nextResult = readJson(resultPath);
    expect(nextResult.eventCount).toBe(1);
    expect(nextResult.consumedEventIds).toEqual(["evt-a-3"]);
    expect(fs.readFileSync(historyPath, "utf-8").trim().split(/\r?\n/)).toHaveLength(2);
    agentALog = readJson(agentALogPath);
    expect(agentALog.events.find((event) => event.id === "evt-a-3").consumedBy["xingye.heartbeat"]).toMatch(
      /^\d{4}-\d{2}-\d{2}T/,
    );
  });
});
