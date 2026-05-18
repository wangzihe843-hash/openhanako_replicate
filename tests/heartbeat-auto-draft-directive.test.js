import { describe, it, expect } from "vitest";
import { createHeartbeat } from "../lib/desk/heartbeat.js";

/**
 * 集成测试：心跳 prompt 在「距离上次 auto-draft 已经 ≥ 阈值条用户对话」时，
 * 必须追加「必须主动产出」directive。本测试通过 captured onBeat 拿到完整 prompt，
 * 然后断言关键字。
 *
 * 不直接调 buildHeartbeatContext（它是模块内部函数），避免暴露内部 API。
 */
describe("heartbeat prompt: auto-draft staleness directive", () => {
  async function runOnceAndCapturePrompt({ autoDraftStaleness, summaryZh = null, eventCount = 0 } = {}) {
    let capturedPrompt = null;
    const hb = createHeartbeat({
      onBeat: async (prompt) => {
        capturedPrompt = prompt;
        return { ok: true };
      },
      /** 模拟 consumer 已经跑过、把 staleness 算好挂在 result 上的返回形态。 */
      getEventSummary: async () => ({
        consumed: eventCount,
        result: { summaryZh, eventCount, autoDraftStaleness },
      }),
      intervalMinutes: 31,
      locale: "zh-CN",
    });
    const res = await hb.runHeartbeatOnce({ reason: "test" });
    expect(res.status).toBe("ran");
    return capturedPrompt;
  }

  it("does NOT add the directive when mustPropose=false", async () => {
    const prompt = await runOnceAndCapturePrompt({
      autoDraftStaleness: { lastAutoDraftAt: "2026-05-17T00:00:00.000Z", chatTurnsSinceLastDraft: 12, mustPropose: false },
      summaryZh: "自上次巡检以来：日记新增（手动）×1（共 1 条）",
      eventCount: 1,
    });
    expect(prompt).not.toContain("必须主动产出");
    expect(prompt).not.toContain("12 条用户对话");
  });

  it("does NOT add the directive when autoDraftStaleness is null (consumer didn't compute)", async () => {
    const prompt = await runOnceAndCapturePrompt({
      autoDraftStaleness: null,
      summaryZh: "自上次巡检以来：日记新增（手动）×1（共 1 条）",
      eventCount: 1,
    });
    expect(prompt).not.toContain("必须主动产出");
  });

  it("ADDS the directive with chat-turn count when mustPropose=true", async () => {
    const prompt = await runOnceAndCapturePrompt({
      autoDraftStaleness: { lastAutoDraftAt: "2026-04-01T00:00:00.000Z", chatTurnsSinceLastDraft: 73, mustPropose: true },
      summaryZh: "自上次巡检以来：最近对话×3（共 3 条）",
      eventCount: 3,
    });
    expect(prompt).toContain("## 必须主动产出");
    expect(prompt).toContain("73 条用户对话");
    expect(prompt).toContain("xingye_propose_draft");
    /** 列出全部 11 个模块名让 agent 选（与 SUPPORTED_MODULES in lib/tools/xingye-propose-draft-tool.js 同步） */
    expect(prompt).toContain("journal");
    expect(prompt).toContain("schedule");
    expect(prompt).toContain("moments");
    expect(prompt).toContain("mail");
    expect(prompt).toContain("shopping");
    expect(prompt).toContain("files");
    expect(prompt).toContain("secret_space");
    expect(prompt).toContain("reading_notes");
    expect(prompt).toContain("divination");
    expect(prompt).toContain("memory_candidate");
    expect(prompt).toContain("relationship_state");
    /** 解释这是系统约束不是用户在催 */
    expect(prompt).toContain("系统层面");
  });

  it("ADDS directive even when there are no new events this round (staleness is historical)", async () => {
    /**
     * skipped:true 路径——consumer 没有新事件可消费但仍计算 staleness 并通过顶层
     * autoDraftStaleness 带回。directive 应当仍然挂出来，避免 agent 在长时间无
     * 新事件期间永远不被推一把。
     */
    let capturedPrompt = null;
    const hb = createHeartbeat({
      onBeat: async (prompt) => { capturedPrompt = prompt; return { ok: true }; },
      getEventSummary: async () => ({
        consumed: 0,
        skipped: true,
        autoDraftStaleness: { lastAutoDraftAt: null, chatTurnsSinceLastDraft: 55, mustPropose: true },
      }),
      intervalMinutes: 31,
      locale: "zh-CN",
    });
    const res = await hb.runHeartbeatOnce({ reason: "test-skipped" });
    expect(res.status).toBe("ran");
    expect(capturedPrompt).toContain("## 必须主动产出");
    expect(capturedPrompt).toContain("55 条用户对话");
  });

  it("renders English directive when locale is en", async () => {
    let capturedPrompt = null;
    const hb = createHeartbeat({
      onBeat: async (prompt) => { capturedPrompt = prompt; return { ok: true }; },
      getEventSummary: async () => ({
        consumed: 0,
        skipped: true,
        autoDraftStaleness: { lastAutoDraftAt: null, chatTurnsSinceLastDraft: 60, mustPropose: true },
      }),
      intervalMinutes: 31,
      locale: "en-US",
    });
    await hb.runHeartbeatOnce({ reason: "test-en" });
    expect(capturedPrompt).toContain("## Required: produce a draft this round");
    expect(capturedPrompt).toContain("60 user chat turns");
    expect(capturedPrompt).toContain("MUST");
    expect(capturedPrompt).toContain("xingye_propose_draft");
  });
});
