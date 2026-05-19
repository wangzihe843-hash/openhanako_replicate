import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { createHeartbeatMock, heartbeatInstances } = vi.hoisted(() => ({
  createHeartbeatMock: vi.fn(),
  heartbeatInstances: [],
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
    createHeartbeatMock.mockImplementation(() => {
      const hb = {
        start: vi.fn(),
        stop: vi.fn().mockResolvedValue(undefined),
      };
      heartbeatInstances.push(hb);
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
});
