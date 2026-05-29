import { describe, it, expect } from "vitest";
import { createHeartbeat } from "../lib/desk/heartbeat.js";

/**
 * 集成测试：心跳 prompt 的社交软提示段。
 * 通过 captured onBeat 拿到完整 prompt 后断言关键字。
 *
 * 核心约束（对应用户诉求）：
 *  - 没触发时整段不出现（绝大多数心跳零社交开销）
 *  - 触发时点名具体的人 + 明确"可选/不强制"，不能是硬命令
 */
describe("heartbeat prompt: social staleness directive", () => {
  async function runOnceAndCapturePrompt({ socialStaleness = null } = {}) {
    let capturedPrompt = null;
    const hb = createHeartbeat({
      onBeat: async (prompt) => {
        capturedPrompt = prompt;
        return { ok: true };
      },
      getEventSummary: async () => ({
        consumed: 0,
        result: { summaryZh: null, eventCount: 0, autoDraftStaleness: null, socialStaleness },
      }),
      intervalMinutes: 31,
      locale: "zh-CN",
    });
    const res = await hb.runHeartbeatOnce({ reason: "test" });
    expect(res.status).toBe("ran");
    return capturedPrompt;
  }

  it("does NOT add social section when socialStaleness is null", async () => {
    const prompt = await runOnceAndCapturePrompt({ socialStaleness: null });
    expect(prompt).not.toContain("## 社交动态");
  });

  it("does NOT add social section when neither global nor per-peer triggers", async () => {
    const prompt = await runOnceAndCapturePrompt({
      socialStaleness: {
        shouldSocialize: false,
        overduePeerCount: 0,
        globalChatTurnsSinceLastDm: 10,
        candidatePeers: [{ peerId: "ming", name: "明", summary: "钟与共鸣", chatTurnsSinceLastDm: 10 }],
      },
    });
    expect(prompt).not.toContain("## 社交动态");
  });

  it("ADDS social section when global threshold reached, naming a candidate", async () => {
    const prompt = await runOnceAndCapturePrompt({
      socialStaleness: {
        shouldSocialize: true,
        overduePeerCount: 0,
        globalChatTurnsSinceLastDm: 85,
        candidatePeers: [{ peerId: "ming", name: "明", summary: "钟与共鸣", chatTurnsSinceLastDm: 85 }],
      },
    });
    expect(prompt).toContain("## 社交动态");
    expect(prompt).toContain("85 条对话");
    expect(prompt).toContain("明");       // 点名候选人
    expect(prompt).toContain("钟与共鸣");  // persona 话头
    expect(prompt).toContain("dm");
    // 必须是"可选"，不是硬命令
    expect(prompt).toContain("完全可选");
    expect(prompt).not.toContain("必须");
  });

  it("ADDS social section on per-peer trigger even when global not reached", async () => {
    const prompt = await runOnceAndCapturePrompt({
      socialStaleness: {
        shouldSocialize: false,
        overduePeerCount: 1,
        globalChatTurnsSinceLastDm: 20,
        candidatePeers: [{ peerId: "ming", name: "明", summary: "钟与共鸣", chatTurnsSinceLastDm: 210 }],
      },
    });
    expect(prompt).toContain("## 社交动态");
    expect(prompt).toContain("很久没联系");
    expect(prompt).toContain("明");
  });

  it("does NOT add social section when triggered but no candidates to name", async () => {
    const prompt = await runOnceAndCapturePrompt({
      socialStaleness: {
        shouldSocialize: true,
        overduePeerCount: 0,
        globalChatTurnsSinceLastDm: 85,
        candidatePeers: [],
      },
    });
    expect(prompt).not.toContain("## 社交动态");
  });
});
