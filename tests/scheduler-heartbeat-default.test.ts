import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { createHeartbeatMock, heartbeatInstances, heartbeatOptions } = vi.hoisted(() => ({
  createHeartbeatMock: vi.fn(),
  heartbeatInstances: [],
  heartbeatOptions: [],
}));

vi.mock("../lib/desk/heartbeat.js", () => ({
  HEARTBEAT_ACTIVITY_DIR: ".hana-heartbeat",
  createHeartbeat: createHeartbeatMock,
}));

vi.mock("../lib/desk/cron-scheduler.js", () => ({
  createCronScheduler: vi.fn(() => ({
    start: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("../lib/fresh-compact/daily-scheduler.js", () => ({
  createFreshCompactDailyScheduler: vi.fn(() => ({
    start: vi.fn(),
    stop: vi.fn(),
  })),
}));

vi.mock("../hub/fresh-compact-maintainer.js", () => ({
  FreshCompactMaintainer: vi.fn().mockImplementation(function () {
    this.runDaily = vi.fn();
  }),
}));

import { Scheduler } from "../hub/scheduler.ts";

describe("Scheduler heartbeat defaults", () => {
  it.each(["resolve", "reject"])("waits for Jian execution and forwards its %s outcome", async outcome => {
    let resolveWork: () => void;
    let rejectWork: (error: Error) => void;
    const work = new Promise<void>((resolve, reject) => { resolveWork = resolve; rejectWork = reject; });
    const agent = { id: "audit-jian", agentName: "Audit", deskDir: "/mock/desk", config: { desk: {} } };
    const scheduler = new Scheduler({ hub: { engine: {
      agents: new Map([[agent.id, agent]]), getHeartbeatMaster: () => true,
      getHomeCwd: () => "/mock/workspace", emitDevLog: vi.fn(),
    } } });
    scheduler._executeActivityForAgent = vi.fn(() => work);
    scheduler.startHeartbeat();
    const callback = heartbeatOptions[heartbeatOptions.length - 1].onJianBeat;
    let completed = false;
    let observedError: unknown = null;
    const observed = Promise.resolve(callback("prompt", "/mock/workspace", {})).then(
      () => { completed = true; },
      error => { completed = true; observedError = error; },
    );
    // Observe whether the caller has completed before the executor does.
    await Promise.resolve();
    const completedEarly = completed;
    const failure = new Error("simulated Jian execution failure");
    // Handle the executor independently too, so the unfixed callback cannot
    // produce an unhandled rejection when the regression is run before the fix.
    const drainedWork = work.catch(() => {});
    if (outcome === "resolve") resolveWork(); else rejectWork(failure);
    await Promise.all([observed, drainedWork]);
    expect(completedEarly).toBe(false);
    expect(observedError).toBe(outcome === "reject" ? failure : null);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    heartbeatInstances.length = 0;
    heartbeatOptions.length = 0;
    createHeartbeatMock.mockImplementation((opts) => {
      const hb = {
        start: vi.fn(),
        stop: vi.fn().mockResolvedValue(undefined),
      };
      heartbeatInstances.push(hb);
      heartbeatOptions.push(opts);
      return hb;
    });
  });

  it("creates heartbeat handles for config-only agents but starts only explicit opt-in patrols", () => {
    const root = "/tmp/hana-heartbeat-default";
    const optedIn = {
      id: "opted-in",
      agentName: "Opted In",
      deskDir: path.join(root, "agents", "opted-in", "desk"),
      config: { desk: { heartbeat_enabled: true, heartbeat_interval: 31 } },
    };
    const implicitOff = {
      id: "implicit-off",
      agentName: "Implicit Off",
      deskDir: path.join(root, "agents", "implicit-off", "desk"),
      config: { desk: {} },
    };
    const engine = {
      agents: new Map([
        [optedIn.id, optedIn],
        [implicitOff.id, implicitOff],
      ]),
      getHeartbeatMaster: () => true,
      getHomeCwd: (agentId) => path.join(root, "home", agentId),
      emitDevLog: vi.fn(),
    };

    const scheduler = new Scheduler({ hub: { engine } });
    scheduler.startHeartbeat();

    expect(createHeartbeatMock).toHaveBeenCalledTimes(2);
    expect(heartbeatInstances[0].start).toHaveBeenCalledOnce();
    expect(heartbeatInstances[1].start).not.toHaveBeenCalled();
  });

  it("passes Jian-scoped custom tools into heartbeat isolated execution", () => {
    const root = "/tmp/hana-heartbeat-jian-tools";
    const agent = {
      id: "agent-a",
      agentName: "Agent A",
      deskDir: path.join(root, "agents", "agent-a", "desk"),
      config: { desk: { heartbeat_enabled: true, heartbeat_interval: 31 } },
    };
    const engine = {
      agents: new Map([[agent.id, agent]]),
      getHeartbeatMaster: () => true,
      getHomeCwd: () => path.join(root, "home", agent.id),
      emitDevLog: vi.fn(),
    };
    const scheduler = new Scheduler({ hub: { engine } });
    scheduler._executeActivityForAgent = vi.fn();
    scheduler.startHeartbeat();

    const scopedTool = { name: "jian_update_status", execute: vi.fn() };
    const cwd = path.join(root, "desk", "task-a");
    heartbeatOptions[0].onJianBeat("jian prompt", cwd, { customTools: [scopedTool] });

    expect(scheduler._executeActivityForAgent).toHaveBeenCalledWith(
      "agent-a",
      "jian prompt",
      "heartbeat",
      expect.any(String),
      {
        cwd,
        extraCustomTools: [scopedTool],
      },
    );
  });

  // 镜像 executeIsolated 的两道过滤（core/session-coordinator.js executeIsolated +
  // core/tool-availability.js）：getProposeDraftAvailable 决定巡检里能否硬指挥 xingye_propose_draft。
  function startSingleAgentHeartbeat(config, { channelsEnabled = true, tools = [{ name: "dm" }] } = {}) {
    const root = "/tmp/hana-heartbeat-propose-draft";
    const agent = {
      id: "agent-pd",
      agentName: "Agent PD",
      deskDir: path.join(root, "agents", "agent-pd", "desk"),
      config,
      getToolsSnapshot: () => tools,
    };
    const engine = {
      agents: new Map([[agent.id, agent]]),
      getHeartbeatMaster: () => true,
      getHomeCwd: () => path.join(root, "home", agent.id),
      emitDevLog: vi.fn(),
      isChannelsEnabled: () => channelsEnabled,
      getAgent: () => agent,
    };
    const scheduler = new Scheduler({ hub: { engine } });
    scheduler._executeActivityForAgent = vi.fn();
    scheduler.startHeartbeat();
    return { agent, scheduler, engine };
  }

  it.each([
    { label: "default opt-out", config: {}, channelsEnabled: true, expected: false },
    { label: "Phone disabled", config: { tools: { disabled: [] } }, channelsEnabled: false, expected: false },
    { label: "agent disabled", config: { tools: { disabled: ["dm"] } }, channelsEnabled: true, expected: false },
    { label: "patrol whitelist excludes DM", config: { tools: { disabled: [] }, desk: { patrol_tools: ["notify"] } }, channelsEnabled: true, expected: false },
    { label: "empty patrol whitelist", config: { tools: { disabled: [] }, desk: { patrol_tools: [] } }, channelsEnabled: true, expected: false },
    { label: "enabled DM", config: { tools: { disabled: [] }, desk: { patrol_tools: ["dm"] } }, channelsEnabled: true, expected: true },
  ])("gates social instructions using the runtime tool rules: $label", async ({ config, channelsEnabled, expected }) => {
    startSingleAgentHeartbeat(config, { channelsEnabled });
    expect(await heartbeatOptions[0].getDmAvailable()).toBe(expected);
  });

  it("requires a registered DM tool and refreshes agent and Phone settings for every check", async () => {
    const { agent, engine } = startSingleAgentHeartbeat({ tools: { disabled: [] } });
    const getAvailable = heartbeatOptions[0].getDmAvailable;
    expect(await getAvailable()).toBe(true);
    agent.config = { tools: { disabled: ["dm"] } };
    expect(await getAvailable()).toBe(false);
    agent.config = { tools: { disabled: [] } };
    engine.isChannelsEnabled = () => false;
    expect(await getAvailable()).toBe(false);
    engine.isChannelsEnabled = () => true;
    agent.getToolsSnapshot = () => [];
    expect(await getAvailable()).toBe(false);
  });

  it("forwards both star events and the upstream patrol log tool to the primary heartbeat", async () => {
    const { scheduler } = startSingleAgentHeartbeat({ tools: { disabled: [] } });
    const consumed = { consumed: 1, result: { eventCount: 1, summaryZh: "one event" } };
    const patrolLogTool = { name: "patrol_update_log", execute: vi.fn() };
    await heartbeatOptions[0].onBeat("patrol", { xingyeConsumed: consumed, customTools: [patrolLogTool] });
    expect(scheduler._executeActivityForAgent).toHaveBeenCalledWith("agent-pd", "patrol", "heartbeat", null, {
      xingyeConsumed: consumed, extraCustomTools: [patrolLogTool],
    });
  });

  it("forwards cancellation to both patrol execution paths", async () => {
    const { scheduler } = startSingleAgentHeartbeat({ desk: { heartbeat_enabled: true } });
    const signal = new AbortController().signal;
    await heartbeatOptions[0].onBeat("main", { signal });
    await heartbeatOptions[0].onJianBeat("jian", "/workspace/jian", { signal });
    expect(vi.mocked(scheduler._executeActivityForAgent).mock.calls).toHaveLength(2);
    for (const call of vi.mocked(scheduler._executeActivityForAgent).mock.calls) expect(call[4].signal).toBe(signal);
  });

  it("reads quiet-hour configuration on every check", () => {
    const { agent } = startSingleAgentHeartbeat({ desk: { heartbeat_enabled: true } });
    const check = heartbeatOptions[0].getSkipReason;
    expect(check()).toBeNull();
    agent.config.desk.heartbeat_quiet_hours = { enabled: true, start: "invalid", end: "08:00" };
    expect(check()).toBe("invalid-quiet-hours");
    agent.config.desk.heartbeat_quiet_hours.enabled = false;
    expect(check()).toBeNull();
  });

  it.each(["execution", "summary"])("suppresses completion publication after cancellation during %s", async stage => {
    let release!: () => void;
    let reached!: () => void;
    const ready = new Promise<void>(resolve => { reached = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    const controller = new AbortController();
    const engine = {
      agentsDir: "/tmp/heartbeat-cancel", agents: new Map(),
      getAgent: () => ({ agentName: "Agent A" }),
      executeIsolated: vi.fn(async () => {
        if (stage === "execution") { reached(); await pending; }
        return { sessionPath: "/tmp/heartbeat-cancel/session.jsonl" };
      }),
      summarizeActivity: vi.fn(async () => { reached(); await pending; return "late summary"; }),
      getActivityStore: vi.fn(), deliverNotification: vi.fn(), emitDevLog: vi.fn(),
      getNotificationPreferences: () => ({ patrolCompletion: "always" }),
    };
    const eventBus = { emit: vi.fn() };
    const scheduler = new Scheduler({ hub: { engine, eventBus } });
    const run = scheduler._executeActivityForAgent("agent-a", "patrol", "heartbeat", null, { signal: controller.signal });
    await ready;
    controller.abort();
    release();
    await run;
    expect(engine.getActivityStore).not.toHaveBeenCalled();
    expect(engine.deliverNotification).not.toHaveBeenCalled();
    expect(eventBus.emit).not.toHaveBeenCalled();
  });

  it("keeps master pause strict and per-agent automatic opt-out compatible with manual patrols", () => {
    const { engine, scheduler } = startSingleAgentHeartbeat({ desk: { heartbeat_enabled: false } });
    const check = heartbeatOptions[0].getSkipReason;
    expect(check()).toBeNull();
    engine.getHeartbeatMaster = () => false;
    expect(check()).toBe("paused");
    engine.getHeartbeatMaster = () => true;
    expect(check()).toBeNull();
    scheduler._hub.eventBus = { emit: vi.fn() };
    heartbeatOptions[0].onSkipped("quiet-hours");
    expect(scheduler._hub.eventBus.emit).toHaveBeenCalledWith({ type: "heartbeat_skipped", agentId: "agent-pd", reason: "quiet-hours" }, null);
  });

  it("wires getProposeDraftAvailable into the createHeartbeat call", () => {
    startSingleAgentHeartbeat({ desk: { heartbeat_enabled: true } });
    expect(typeof heartbeatOptions[0].getProposeDraftAvailable).toBe("function");
  });

  it("getProposeDraftAvailable returns false when tools.disabled includes xingye_propose_draft", () => {
    startSingleAgentHeartbeat({
      desk: { heartbeat_enabled: true },
      tools: { disabled: ["xingye_propose_draft"] },
    });
    expect(heartbeatOptions[0].getProposeDraftAvailable()).toBe(false);
  });

  it("getProposeDraftAvailable returns false when desk.patrol_tools is a finite list excluding it", () => {
    startSingleAgentHeartbeat({
      desk: { heartbeat_enabled: true, patrol_tools: ["notify", "current_status"] },
    });
    expect(heartbeatOptions[0].getProposeDraftAvailable()).toBe(false);
  });

  it("getProposeDraftAvailable returns true when patrol_tools is a finite list including it", () => {
    startSingleAgentHeartbeat({
      desk: { heartbeat_enabled: true, patrol_tools: ["notify", "xingye_propose_draft"] },
    });
    expect(heartbeatOptions[0].getProposeDraftAvailable()).toBe(true);
  });

  it("getProposeDraftAvailable returns false for a malformed non-'*' string patrol_tools (镜像 session 端 new Set(string) 拆字)", () => {
    // 误配成纯字符串 'notify'：session 端 new Set('notify') 拆成 {n,o,t,i,f,y}，工具被丢；
    // 回调用 new Set(patrol) 同样判出不含 xingye_propose_draft → false，与会话过滤一致。
    startSingleAgentHeartbeat({
      desk: { heartbeat_enabled: true, patrol_tools: "notify" },
    });
    expect(heartbeatOptions[0].getProposeDraftAvailable()).toBe(false);
  });

  it("getProposeDraftAvailable returns true for falsy-but-defined patrol_tools ('' / null), mirroring the `||` fallthrough to '*'", () => {
    // session-coordinator: `opts.toolFilter || patrol_tools || PATROL_TOOLS_DEFAULT('*')` —
    // '' 和 null 都是 falsy，短路落到 '*' → 放行全部 → 工具实际可用。回调若仅排除 undefined，
    // 会把 '' / null 喂给 new Set('')（空集）误判成"不可用"，与真实会话分叉。守卫用真值判断后对齐。
    startSingleAgentHeartbeat({ desk: { heartbeat_enabled: true, patrol_tools: "" } });
    expect(heartbeatOptions[0].getProposeDraftAvailable()).toBe(true);

    startSingleAgentHeartbeat({ desk: { heartbeat_enabled: true, patrol_tools: null } });
    expect(heartbeatOptions[1].getProposeDraftAvailable()).toBe(true);
  });

  it("getProposeDraftAvailable returns false for empty-array patrol_tools (truthy 有限白名单 → 不含该工具)", () => {
    // [] 是 truthy，session 端 `[] || '*'` → [] → new Set([]).has(name) = false → 工具被丢；
    // 回调同样按 new Set([]) 判定 → false，与会话过滤一致（区别于 falsy 的 '' / null）。
    startSingleAgentHeartbeat({ desk: { heartbeat_enabled: true, patrol_tools: [] } });
    expect(heartbeatOptions[0].getProposeDraftAvailable()).toBe(false);
  });

  it("getProposeDraftAvailable returns true for default/undefined/'*' patrol_tools when tool enabled", () => {
    // undefined patrol_tools + no tools.disabled → available
    const { scheduler: s1 } = startSingleAgentHeartbeat({ desk: { heartbeat_enabled: true } });
    expect(heartbeatOptions[0].getProposeDraftAvailable()).toBe(true);
    void s1;

    // '*' patrol_tools (= 与 chat 一致，全部放行) → available
    startSingleAgentHeartbeat({ desk: { heartbeat_enabled: true, patrol_tools: "*" } });
    expect(heartbeatOptions[1].getProposeDraftAvailable()).toBe(true);

    // 显式 tools.disabled: [] (全开) → available
    startSingleAgentHeartbeat({ desk: { heartbeat_enabled: true }, tools: { disabled: [] } });
    expect(heartbeatOptions[2].getProposeDraftAvailable()).toBe(true);
  });

  it("getProposeDraftAvailable reads agent.config fresh per beat (no snapshot)", () => {
    const { agent } = startSingleAgentHeartbeat({ desk: { heartbeat_enabled: true } });
    const cb = heartbeatOptions[0].getProposeDraftAvailable;
    expect(cb()).toBe(true);
    // 配置在两次 beat 之间变化：回调必须现读，不能用初始化时的快照
    agent.config = { desk: { heartbeat_enabled: true }, tools: { disabled: ["xingye_propose_draft"] } };
    expect(cb()).toBe(false);
  });
});
