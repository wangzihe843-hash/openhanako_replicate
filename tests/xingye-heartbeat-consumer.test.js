import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Scheduler } from "../hub/scheduler.js";
import {
  pruneConsumedEvents,
  pruneOrphanDedupeKeys,
  XINGYE_HEARTBEAT_CONSUMER_ID,
} from "../lib/xingye/heartbeat-consumer.js";

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
    // 中文摘要：渲染端 PhoneHome 直接显示这条；按 TYPE_ORDER_ZH 排序，秘密空间在短信之后。
    expect(result.summaryZh).toBe("自上次巡检以来：短信×1、秘密空间新增×1（共 2 条）");
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

  /**
   * 回归：renderer 端在 desktop/src/react/xingye/xingye-event-log.ts 已新增 15 种事件类型
   * （journal/schedule/mail/file/mm_chat/divination/shopping/reading_notes/moments 各 1-2 种），
   * 同时 renderer 端的 heartbeat consumer 用 consumerName='heartbeat'，与服务端 'xingye.heartbeat'
   * 互不覆盖。这条用例固定下面两个跨端契约：
   *   1. 服务端 SUGGESTION_BY_TYPE 没覆盖的新类型会落回兜底建议、不被丢弃；
   *   2. 服务端写回 consumedBy 时保留 renderer 端已写的 'heartbeat' 键。
   */
  it("server-side consumer tolerates new renderer event types and preserves the renderer's consumedBy key", async () => {
    const newTypeEvent = {
      id: "evt-new-1",
      agentId: "agent-a",
      type: "journal.entry_appended", // renderer 端 2026-05 新增类型，未在 SUGGESTION_BY_TYPE 中
      source: "xingye-journal-store",
      subjectId: "j-1",
      createdAt: "2026-05-16T00:00:00.000Z",
      payload: { entryId: "j-1", dayKey: "2026-05-16", title: "今天" },
      // 模拟 renderer 端 heartbeat consumer 已先消费过：
      consumedBy: { heartbeat: "2026-05-16T00:00:01.000Z" },
    };
    const moodEvent = {
      id: "evt-new-2",
      agentId: "agent-a",
      type: "mm_chat.turns_appended",
      source: "xingye-mm-chat-store",
      subjectId: "sess-1",
      createdAt: "2026-05-16T00:00:02.000Z",
      payload: { sessionId: "sess-1", count: 3, lastRole: "ai" },
    };
    const logPath = writeEventLog(fixture.agentsDir, "agent-a", [newTypeEvent, moodEvent]);

    const heartbeat = fixture.scheduler.getHeartbeat("agent-a");
    expect(heartbeat.triggerNow()).toBe(true);

    const resultPath = path.join(fixture.agentsDir, "agent-a", "xingye", "heartbeat", "result.json");
    await waitFor(() => fs.existsSync(resultPath));

    const result = readJson(resultPath);
    // 服务端 consumer 用 'xingye.heartbeat'，仍把这两条视为未消费（独立追踪）。
    expect(result.eventCount).toBe(2);
    expect(result.consumedEventIds).toEqual(["evt-new-1", "evt-new-2"]);
    expect(result.eventTypes).toEqual(
      expect.arrayContaining(["journal.entry_appended", "mm_chat.turns_appended"]),
    );
    // 兜底建议出现一次（去重后），新类型没引发崩溃。
    expect(result.suggestedActions).toEqual(
      expect.arrayContaining([
        "Review the Xingye event and decide whether a future suggestion is needed.",
      ]),
    );

    await waitFor(() => readJson(logPath).events.every((event) => event.consumedBy?.["xingye.heartbeat"]));
    const persisted = readJson(logPath).events;
    const j = persisted.find((event) => event.id === "evt-new-1");
    // 服务端写回时既加上自己的 key，也保留 renderer 已写的 'heartbeat' 键。
    expect(j.consumedBy["xingye.heartbeat"]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(j.consumedBy.heartbeat).toBe("2026-05-16T00:00:01.000Z");
    const m = persisted.find((event) => event.id === "evt-new-2");
    expect(m.consumedBy["xingye.heartbeat"]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(m.consumedBy.heartbeat).toBeUndefined();
  });

  /**
   * 回归 D：consumer summary 必须在 buildHeartbeatContext 之前跑完，让 summaryZh 出现在
   * 发给 agent 的 patrol prompt 里。修复前 consumer 在 onBeat 内部跑，事件被标记 consumed
   * 但 prompt 完全看不到，agent 无法基于事件 notify 用户。
   */
  it("includes the Xingye summaryZh and notify-suppression hint in the patrol prompt", async () => {
    const events = [
      {
        id: "evt-prompt-1",
        agentId: "agent-a",
        type: "phone.sms_appended",
        source: "phone",
        subjectId: "contact-1",
        createdAt: "2026-05-17T00:00:00.000Z",
        payload: { contactId: "contact-1", body: "hello" },
      },
      {
        id: "evt-prompt-2",
        agentId: "agent-a",
        type: "secret_space.record_deleted",
        source: "secret-space",
        subjectId: "dream-1",
        createdAt: "2026-05-17T00:01:00.000Z",
        payload: { recordId: "dream-1" },
      },
    ];
    writeEventLog(fixture.agentsDir, "agent-a", events);

    const heartbeat = fixture.scheduler.getHeartbeat("agent-a");
    await heartbeat.beat();

    const calls = fixture.engine.executeIsolated.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const prompt = calls[0][0];
    // 类型聚合摘要（按 TYPE_ORDER_ZH：短信在秘密空间删除前）
    expect(prompt).toContain("自上次巡检以来：短信×1、秘密空间删除×1（共 2 条）");
    // notify 抑制提示出现
    expect(prompt).toContain("小手机事件");
    expect(prompt).toContain("秘密空间删除");
  });

  /**
   * 回归 D：没有未消费事件时，prompt 里不应该出现「小手机事件」段，避免空段污染。
   */
  it("omits the Xingye event section when there is nothing to consume", async () => {
    writeEventLog(fixture.agentsDir, "agent-a", []);

    const heartbeat = fixture.scheduler.getHeartbeat("agent-a");
    await heartbeat.beat();

    const calls = fixture.engine.executeIsolated.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const prompt = calls[0][0];
    expect(prompt).not.toContain("小手机事件");
    expect(prompt).not.toContain("自上次巡检以来");
  });

  // 回归 #4：跨 agent 事件被静默丢弃，atomicWriteJson 会把 foreign 事件直接抹掉。
  // 修复后应当 warn 出来，便于排查迁移 / 复制粘贴造成的污染。
  it("warns when the log contains events for a different agentId", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const foreignEvent = {
      id: "evt-foreign-1",
      agentId: "agent-b",
      type: "phone.sms_appended",
      source: "phone",
      subjectId: "contact-x",
      createdAt: "2026-05-13T00:00:00.000Z",
      payload: { contactId: "contact-x" },
    };
    const ownEvent = {
      id: "evt-own-1",
      agentId: "agent-a",
      type: "phone.sms_appended",
      source: "phone",
      subjectId: "contact-y",
      createdAt: "2026-05-13T00:01:00.000Z",
      payload: { contactId: "contact-y" },
    };
    writeEventLog(fixture.agentsDir, "agent-a", [foreignEvent, ownEvent]);

    const heartbeat = fixture.scheduler.getHeartbeat("agent-a");
    expect(heartbeat.triggerNow()).toBe(true);

    const resultPath = path.join(fixture.agentsDir, "agent-a", "xingye", "heartbeat", "result.json");
    await waitFor(() => fs.existsSync(resultPath));

    // 只消费了自己的事件
    const result = readJson(resultPath);
    expect(result.eventCount).toBe(1);
    expect(result.consumedEventIds).toEqual(["evt-own-1"]);

    // warn 提示有 1 条 foreign 被丢
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("dropping 1 foreign event"),
    );

    warnSpy.mockRestore();
  });
});

describe("xingye event retention (pure functions)", () => {
  // 回归 #10：events/log.json 单调膨胀风险。consumer 跑过且超出 retention 窗口的事件
  // 应当被 prune；未消费 / 仍在窗口内的事件保留。
  it("pruneConsumedEvents 删除 consumed 超过 retentionMs 的事件，保留未消费的", () => {
    const nowIso = "2026-05-17T00:00:00.000Z";
    const events = [
      {
        // 8 天前消费过 → 应被 prune
        id: "old-consumed",
        type: "phone.sms_appended",
        consumedBy: { [XINGYE_HEARTBEAT_CONSUMER_ID]: "2026-05-09T00:00:00.000Z" },
      },
      {
        // 1 天前消费过 → 应保留
        id: "recent-consumed",
        type: "phone.sms_appended",
        consumedBy: { [XINGYE_HEARTBEAT_CONSUMER_ID]: "2026-05-16T00:00:00.000Z" },
      },
      {
        // 8 天前生成但从未被 patrol 消费 → 应保留（让 consumer 自己负责）
        id: "old-unconsumed",
        type: "phone.sms_appended",
        createdAt: "2026-05-09T00:00:00.000Z",
      },
      {
        // 仅被 renderer 端 heartbeat 消费（不同 consumer key）→ 等价于未被 patrol 消费 → 保留
        id: "renderer-only",
        type: "phone.sms_appended",
        consumedBy: { heartbeat: "2026-05-09T00:00:00.000Z" },
      },
    ];

    const pruned = pruneConsumedEvents(events, nowIso);
    expect(pruned.map((e) => e.id).sort()).toEqual(
      ["recent-consumed", "old-unconsumed", "renderer-only"].sort(),
    );
  });

  it("pruneConsumedEvents 容忍非法时间字符串：保守保留", () => {
    const nowIso = "2026-05-17T00:00:00.000Z";
    const events = [
      {
        id: "garbage-consumed-at",
        consumedBy: { [XINGYE_HEARTBEAT_CONSUMER_ID]: "not-a-date" },
      },
      {
        id: "clean",
        consumedBy: { [XINGYE_HEARTBEAT_CONSUMER_ID]: "2026-05-16T00:00:00.000Z" },
      },
    ];
    expect(pruneConsumedEvents(events, nowIso).map((e) => e.id))
      .toEqual(["garbage-consumed-at", "clean"]);
  });

  it("pruneOrphanDedupeKeys 清理指向已删事件的 key", () => {
    const events = [{ id: "e1" }, { id: "e2" }];
    const dedupeKeys = {
      "key:e1": "e1",
      "key:e2": "e2",
      "key:gone": "e3", // 孤儿
    };
    expect(pruneOrphanDedupeKeys(dedupeKeys, events)).toEqual({
      "key:e1": "e1",
      "key:e2": "e2",
    });
  });

  it("pruneOrphanDedupeKeys 输入空对象返回空对象", () => {
    expect(pruneOrphanDedupeKeys(null, [])).toEqual({});
    expect(pruneOrphanDedupeKeys({}, [])).toEqual({});
  });
});

describe("xingye heartbeat history.jsonl retention", () => {
  // 回归 #10：history.jsonl 无截断会单调膨胀。学原生 cron-store「runs.jsonl 超过 500 行截到 300」
  // 模式，writeHeartbeatResult 后会跑 trimHistoryFile，保证不会无限增长。
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

  it("trims history.jsonl when it exceeds 500 lines", async () => {
    const events = [{
      id: "evt-trim-1",
      agentId: "agent-a",
      type: "phone.sms_appended",
      source: "phone",
      subjectId: "x",
      createdAt: "2026-05-13T00:00:00.000Z",
      payload: { contactId: "x" },
    }];
    writeEventLog(fixture.agentsDir, "agent-a", events);

    const historyPath = path.join(fixture.agentsDir, "agent-a", "xingye", "heartbeat", "history.jsonl");
    fs.mkdirSync(path.dirname(historyPath), { recursive: true });
    // 预填 600 行假历史
    const fakeLines = Array.from({ length: 600 }, (_, i) => JSON.stringify({ filler: i })).join("\n") + "\n";
    fs.writeFileSync(historyPath, fakeLines, "utf-8");

    const heartbeat = fixture.scheduler.getHeartbeat("agent-a");
    await heartbeat.beat();

    const lines = fs.readFileSync(historyPath, "utf-8").trim().split("\n");
    // 截到 300 + 新写入的 1 行
    expect(lines.length).toBeLessThanOrEqual(301);
    expect(lines.length).toBeGreaterThan(0);
    // 最新一行是 consumer 写的 result（含 consumerId）
    expect(lines[lines.length - 1]).toContain("xingye.heartbeat");
  });
});
