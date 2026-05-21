import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Scheduler } from "../hub/scheduler.js";
import {
  computeAutoDraftStaleness,
  pruneConsumedEvents,
  pruneOrphanDedupeKeys,
  summarizeXingyeEventsForHeartbeatZh,
  XINGYE_AUTO_DRAFT_STALENESS_THRESHOLD,
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
    /**
     * 中文摘要：渲染端 PhoneHome 直接显示这条；按 TYPE_ORDER_ZH 排序，秘密空间
     * 在短信之后。
     *
     * secret_space.record_appended 是 origin-aware 类型 → 走「（自动/手动）」拆分；
     * 这里事件 payload 没有 origin 字段且 recordId 不带 from-draft- 前缀，
     * fallback 归为「手动」。phone.sms_appended 不在 ORIGIN_AWARE_TYPES 里，
     * 沿用旧格式不带后缀。
     */
    expect(result.summaryZh).toBe("自上次巡检以来：短信×1、秘密空间新增（手动）×1（共 2 条）");
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

describe("summarizeXingyeEventsForHeartbeatZh: origin-aware grouping", () => {
  it("returns empty string for empty / invalid input", () => {
    expect(summarizeXingyeEventsForHeartbeatZh([])).toBe("");
    expect(summarizeXingyeEventsForHeartbeatZh(null)).toBe("");
    expect(summarizeXingyeEventsForHeartbeatZh([{ /* no type */ }])).toBe("");
  });

  it("does NOT split origin for non-origin-aware types (draft_* / *_deleted / etc)", () => {
    const events = [
      { type: "journal.draft_proposed", payload: { origin: "auto" } },
      { type: "journal.draft_proposed", payload: { origin: "auto" } },
      { type: "journal.entry_deleted", payload: {} },
    ];
    const summary = summarizeXingyeEventsForHeartbeatZh(events);
    /** No 「（自动）」 / 「（手动）」 decoration on these types. */
    expect(summary).toContain("日记草稿提议×2");
    expect(summary).toContain("日记删除×1");
    expect(summary).not.toContain("（自动）");
    expect(summary).not.toContain("（手动）");
  });

  it("splits origin-aware types by payload.origin into auto / 手动 buckets", () => {
    const events = [
      {
        type: "journal.entry_appended",
        subjectId: "from-draft-d-1",
        payload: { entryId: "from-draft-d-1", origin: "auto" },
      },
      {
        type: "journal.entry_appended",
        subjectId: "j-random-1",
        payload: { entryId: "j-random-1", origin: "user" },
      },
      {
        type: "journal.entry_appended",
        subjectId: "j-random-2",
        payload: { entryId: "j-random-2", origin: "user" },
      },
    ];
    const summary = summarizeXingyeEventsForHeartbeatZh(events);
    expect(summary).toBe("自上次巡检以来：日记新增（自动）×1、日记新增（手动）×2（共 3 条）");
  });

  it("falls back to id-prefix heuristic when payload.origin is missing (backward compat with pre-commit events)", () => {
    /**
     * 历史事件 payload 没写 origin 字段，consumer 用 subjectId / payload.entryId 的
     * `from-draft-` 前缀回填——保证在 7 天 retention 窗口内的旧事件也能正确归类。
     */
    const events = [
      {
        type: "schedule.entry_appended",
        subjectId: "from-draft-sched-old-1",
        payload: { entryId: "from-draft-sched-old-1" },
      },
      {
        type: "schedule.entry_appended",
        subjectId: "sched-random-old",
        payload: { entryId: "sched-random-old" },
      },
    ];
    const summary = summarizeXingyeEventsForHeartbeatZh(events);
    expect(summary).toContain("日程新增（自动）×1");
    expect(summary).toContain("日程新增（手动）×1");
  });

  it("mixes origin-aware and non-origin-aware events in a single summary correctly", () => {
    const events = [
      { type: "mail.messages_appended", payload: { firstMessageId: "from-draft-m-1", origin: "auto" } },
      { type: "mail.messages_appended", payload: { firstMessageId: "m-inbox-1", origin: "user" } },
      { type: "mail.draft_proposed", payload: { draftId: "d-1" } },
      { type: "phone.sms_appended", payload: { /* not origin-aware */ } },
    ];
    const summary = summarizeXingyeEventsForHeartbeatZh(events);
    expect(summary).toContain("邮件（自动）×1");
    expect(summary).toContain("邮件（手动）×1");
    expect(summary).toContain("邮件草稿提议×1");
    expect(summary).toContain("短信×1");
    expect(summary).toContain("共 4 条");
  });

  it("sorts buckets stably: TYPE_ORDER first, then auto before user within same type", () => {
    const events = [
      { type: "schedule.entry_appended", payload: { origin: "user" } },
      { type: "journal.entry_appended", payload: { origin: "user" } },
      { type: "journal.entry_appended", payload: { origin: "auto" } },
    ];
    const summary = summarizeXingyeEventsForHeartbeatZh(events);
    /**
     * Expected order: journal first (TYPE_ORDER puts journal before schedule),
     * and within journal: auto before user (alphabetical bucket key).
     */
    const journalAutoIdx = summary.indexOf("日记新增（自动）");
    const journalUserIdx = summary.indexOf("日记新增（手动）");
    const scheduleUserIdx = summary.indexOf("日程新增（手动）");
    expect(journalAutoIdx).toBeLessThan(journalUserIdx);
    expect(journalUserIdx).toBeLessThan(scheduleUserIdx);
  });

  it("treats invalid payload.origin values by falling back to id-prefix / 'user'", () => {
    const events = [
      { type: "moment.created", subjectId: "p-1", payload: { postId: "p-1", origin: "bogus" } },
      { type: "moment.created", subjectId: "from-draft-d-x", payload: { postId: "from-draft-d-x", origin: 123 } },
    ];
    const summary = summarizeXingyeEventsForHeartbeatZh(events);
    expect(summary).toContain("朋友圈新增（自动）×1");
    expect(summary).toContain("朋友圈新增（手动）×1");
  });

  it("labels news / interview events with registered Chinese labels and origin split", () => {
    const events = [
      { type: "news.entry_appended", payload: { entryId: "from-draft-n-1", origin: "auto" } },
      { type: "news.entry_appended", payload: { entryId: "n-manual-1", origin: "user" } },
      { type: "news.draft_proposed", payload: { draftId: "nd-1" } },
      { type: "interview.entry_appended", payload: { recordId: "from-draft-iv-1", origin: "auto" } },
      { type: "interview.draft_proposed", payload: { draftId: "ivd-1" } },
    ];
    const summary = summarizeXingyeEventsForHeartbeatZh(events);
    /** news / interview entry types are origin-aware → split into 自动/手动. */
    expect(summary).toContain("报纸新增（自动）×1");
    expect(summary).toContain("报纸新增（手动）×1");
    expect(summary).toContain("报纸草稿提议×1");
    expect(summary).toContain("独家专访新增（自动）×1");
    expect(summary).toContain("独家专访草稿提议×1");
    /** No raw event-type strings leak into the summary. */
    expect(summary).not.toContain("news.entry_appended");
    expect(summary).not.toContain("interview.");
  });
});

describe("computeAutoDraftStaleness", () => {
  /** 构造一个 recent_chat.observed 事件（时间从 base 开始递增 i 分钟）。 */
  function chat(i, base = "2026-05-17T00:00:00.000Z") {
    const ms = Date.parse(base) + i * 60_000;
    return {
      id: `chat-${i}`,
      agentId: "a",
      type: "recent_chat.observed",
      source: "desktop-session-submit",
      createdAt: new Date(ms).toISOString(),
      payload: { turnIndex: i },
    };
  }
  /** 构造一个 *.draft_proposed 事件。 */
  function draftProposed(module, atIso) {
    return {
      id: `dp-${module}-${atIso}`,
      agentId: "a",
      type: `${module}.draft_proposed`,
      source: "xingye-heartbeat-tool",
      createdAt: atIso,
      payload: { module },
    };
  }

  it("empty / invalid input → all zeros, mustPropose=false", () => {
    expect(computeAutoDraftStaleness([])).toEqual({
      lastAutoDraftAt: null,
      chatTurnsSinceLastDraft: 0,
      mustPropose: false,
    });
    expect(computeAutoDraftStaleness(null)).toEqual({
      lastAutoDraftAt: null,
      chatTurnsSinceLastDraft: 0,
      mustPropose: false,
    });
  });

  it("no draft history: chat count = total chats; mustPropose only if count ≥ threshold", () => {
    const chats49 = Array.from({ length: 49 }, (_, i) => chat(i));
    const r1 = computeAutoDraftStaleness(chats49);
    expect(r1).toEqual({
      lastAutoDraftAt: null,
      chatTurnsSinceLastDraft: 49,
      mustPropose: false,
    });

    const chats50 = Array.from({ length: 50 }, (_, i) => chat(i));
    const r2 = computeAutoDraftStaleness(chats50);
    expect(r2.chatTurnsSinceLastDraft).toBe(50);
    expect(r2.mustPropose).toBe(true);
  });

  it("counts only chats AFTER the latest draft_proposed (strict >, not ≥)", () => {
    const events = [
      chat(0), // 00:00
      chat(1), // 00:01
      draftProposed("journal", "2026-05-17T00:02:00.000Z"), // 00:02
      chat(3), // 00:03  ← counted
      chat(4), // 00:04  ← counted
      chat(5), // 00:05  ← counted
    ];
    const r = computeAutoDraftStaleness(events);
    expect(r.lastAutoDraftAt).toBe("2026-05-17T00:02:00.000Z");
    expect(r.chatTurnsSinceLastDraft).toBe(3);
    expect(r.mustPropose).toBe(false);
  });

  it("uses the LATEST draft_proposed across all modules (not the earliest)", () => {
    const events = [
      draftProposed("journal", "2026-05-17T00:00:00.000Z"),
      chat(1),
      chat(2),
      draftProposed("schedule", "2026-05-17T00:03:00.000Z"),
      chat(10),
      chat(11),
    ];
    const r = computeAutoDraftStaleness(events);
    expect(r.lastAutoDraftAt).toBe("2026-05-17T00:03:00.000Z");
    /** chat(1) chat(2) are before the schedule draft → excluded; chat(10) chat(11) → counted. */
    expect(r.chatTurnsSinceLastDraft).toBe(2);
  });

  it("triggers mustPropose at exactly threshold (≥, not >)", () => {
    /** Use a custom threshold of 5 for clarity. */
    const events = [
      draftProposed("journal", "2026-05-17T00:00:00.000Z"),
      chat(1), chat(2), chat(3), chat(4), chat(5),
    ];
    expect(computeAutoDraftStaleness(events, 5).mustPropose).toBe(true);
    expect(computeAutoDraftStaleness(events, 6).mustPropose).toBe(false);
  });

  it("ignores non-recent_chat.observed events when counting (mail/phone/etc don't trip threshold)", () => {
    const events = [
      draftProposed("moments", "2026-05-17T00:00:00.000Z"),
      ...Array.from({ length: 60 }, (_, i) => ({
        id: `sms-${i}`,
        agentId: "a",
        type: "phone.sms_appended",
        source: "phone",
        createdAt: new Date(Date.parse("2026-05-17T00:00:00.000Z") + (i + 1) * 60_000).toISOString(),
        payload: {},
      })),
    ];
    const r = computeAutoDraftStaleness(events);
    expect(r.chatTurnsSinceLastDraft).toBe(0);
    expect(r.mustPropose).toBe(false);
  });

  it("default threshold export matches expected value (50)", () => {
    expect(XINGYE_AUTO_DRAFT_STALENESS_THRESHOLD).toBe(50);
  });

  it("ignores events with unparseable createdAt", () => {
    const events = [
      { id: "bad-1", type: "journal.draft_proposed", createdAt: "not-a-date" },
      { id: "good-1", type: "journal.draft_proposed", createdAt: "2026-05-17T00:00:00.000Z" },
      { id: "chat-1", type: "recent_chat.observed", createdAt: "2026-05-17T00:01:00.000Z" },
      { id: "chat-bad", type: "recent_chat.observed", createdAt: "garbage" },
    ];
    const r = computeAutoDraftStaleness(events);
    expect(r.lastAutoDraftAt).toBe("2026-05-17T00:00:00.000Z");
    expect(r.chatTurnsSinceLastDraft).toBe(1);
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
