import { describe, it, expect } from "vitest";
import { createHeartbeat } from "../lib/desk/heartbeat.js";

describe("heartbeat optional expression policy", () => {
  async function capture({ locale = "zh-CN", events = true, available = true, overdue = true } = {}) {
    let prompt;
    const staleness = { lastAutoDraftAt: null, chatTurnsSinceLastDraft: 73, mustPropose: overdue };
    const hb = createHeartbeat({
      onBeat: async value => { prompt = value; },
      getEventSummary: async () => events
        ? { consumed: 1, result: { summaryZh: "最近对话 ×1", eventCount: 1, consumedEventIds: ["source-one"], observations: ["recent_chat.observed"], autoDraftStaleness: staleness } }
        : { consumed: 0, skipped: true, autoDraftStaleness: staleness },
      getProposeDraftAvailable: () => available,
      locale,
    });
    expect((await hb.runHeartbeatOnce()).status).toBe("ran");
    return prompt;
  }

  it.each([true, false])("turn counts never force a draft (new events: %s)", async events => {
    const prompt = await capture({ events });
    expect(prompt).toContain("73 条用户对话");
    expect(prompt).toContain("保持沉默");
    expect(prompt).not.toContain("必须主动产出");
    expect(prompt).not.toContain("本轮**必须**");
    expect(prompt).not.toContain("今天没什么特别的事");
  });

  it("preserves source and pending-confirmation boundaries", async () => {
    const prompt = await capture();
    expect(prompt).toContain("待确认草稿");
    expect(prompt).toContain("sourceEventIds");
    expect(prompt).toContain("source-one");
    expect(prompt).toContain("已完成任务不因剧情切换重新提醒");
    expect(prompt).toContain("候选已过期或已表达");
    expect(prompt).toContain("关系或场景不合适、用户正忙时保持沉默");
  });

  it("does not advertise unavailable tools", async () => {
    const prompt = await capture({ available: false });
    expect(prompt).not.toContain("xingye_propose_draft");
    expect(prompt).not.toContain("## 主动表达评估");
  });

  it("does not add the count reminder before the threshold", async () => {
    expect(await capture({ overdue: false })).not.toContain("73 条用户对话");
  });

  it("allows silence in English without events", async () => {
    const prompt = await capture({ locale: "en-US", events: false });
    expect(prompt).toContain("Stay silent");
    expect(prompt).not.toContain("source-one");
    expect(prompt).toContain("73 user chat turns");
    expect(prompt).not.toContain("MUST");
    expect(prompt).not.toContain("Required: produce a draft");
  });
});
