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

import { Scheduler } from "../hub/scheduler.js";

describe("Scheduler heartbeat defaults", () => {
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
  function startSingleAgentHeartbeat(config) {
    const root = "/tmp/hana-heartbeat-propose-draft";
    const agent = {
      id: "agent-pd",
      agentName: "Agent PD",
      deskDir: path.join(root, "agents", "agent-pd", "desk"),
      config,
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
    return { agent, scheduler };
  }

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
