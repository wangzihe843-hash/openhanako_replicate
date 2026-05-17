import { describe, it, expect, vi } from "vitest";
import { createHeartbeat } from "../lib/desk/heartbeat.js";

// 回归 #3：_doBeat catch 分支会做 `err.xingyeConsumed = xingyeConsumed` 的属性挂载，
// 如果 onBeat 抛了非对象（例如 throw "boom" / throw null），原实现会再抛一个 TypeError
// 把真正的错误吞掉。修复后应当容忍非对象 err、保留原始 reason，且 payload 仍能 salvage。

describe("heartbeat _doBeat resilience to non-object errors", () => {
  it("tolerates onBeat throwing a string and still returns failed status", async () => {
    const hb = createHeartbeat({
      onBeat: async () => { throw "string-error"; },
      // 让 catch 分支命中 `if (xingyeConsumed && ...)` 这条路径
      getEventSummary: async () => ({ consumed: 1, result: { summaryZh: "x", eventCount: 1 } }),
      intervalMinutes: 31,
    });

    const res = await hb.runHeartbeatOnce({ reason: "test-primitive" });
    expect(res.status).toBe("failed");
    // reason 应当是原始的 "string-error"，不是 "Cannot create property xingyeConsumed on string"
    expect(res.reason).toBe("string-error");
  });

  it("tolerates onBeat throwing null without masking the original failure", async () => {
    const hb = createHeartbeat({
      onBeat: async () => { throw null; },
      getEventSummary: async () => ({ consumed: 1, result: { summaryZh: "x" } }),
      intervalMinutes: 31,
    });

    const res = await hb.runHeartbeatOnce({ reason: "test-null" });
    expect(res.status).toBe("failed");
    expect(res.reason).not.toContain("Cannot");
  });

  it("still attaches xingyeConsumed to an Error onBeat threw (existing behavior preserved)", async () => {
    // 验证修复没有破坏正常 Error 路径上的 salvage 行为
    const xingyeConsumed = { consumed: 2, result: { summaryZh: "evt", eventCount: 2 } };
    const hb = createHeartbeat({
      onBeat: async () => { throw new Error("real-failure"); },
      getEventSummary: async () => xingyeConsumed,
      intervalMinutes: 31,
    });

    const res = await hb.runHeartbeatOnce({ reason: "test-error" });
    expect(res.status).toBe("failed");
    expect(res.reason).toBe("real-failure");
    // payload 仍带回 xingyeConsumed，UI 能读到 summaryZh
    expect(res.payload?.xingyeConsumed).toEqual(xingyeConsumed);
  });

  it("tolerates a frozen Error (assignment silently no-ops without throwing)", async () => {
    const frozen = Object.freeze(new Error("frozen-error"));
    const hb = createHeartbeat({
      onBeat: async () => { throw frozen; },
      getEventSummary: async () => ({ consumed: 1, result: { summaryZh: "x" } }),
      intervalMinutes: 31,
    });

    // 不应该因为给 frozen err 挂属性而抛 TypeError（strict mode 下属性赋值会 throw）
    const res = await hb.runHeartbeatOnce({ reason: "test-frozen" });
    expect(res.status).toBe("failed");
    expect(res.reason).toBe("frozen-error");
  });
});
