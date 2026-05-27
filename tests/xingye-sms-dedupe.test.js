/**
 * lib/xingye/sms-dedupe.js 的纯函数单测。
 *
 * 与渲染端 desktop/src/react/xingye/xingye-sms-dedupe.test.ts 行为对齐——
 * 两边都用 normalize + bigramJaccard / exact-match 判同对方近 24h 内的重复，
 * 阈值同步（0.7 / 24h）。本套测试 cover server 端独有的 JS 实现细节。
 */
import { describe, expect, it } from "vitest";

import {
  detectSmsDraftDuplicate,
  SMS_DUPLICATE_JACCARD_THRESHOLD,
  SMS_DUPLICATE_SAME_DAY_WINDOW_MS,
} from "../lib/xingye/sms-dedupe.js";

const NOW = new Date("2026-05-27T12:00:00.000Z");

function draft(partial) {
  return {
    id: partial.id ?? "d-x",
    targetType: "virtual_contact",
    targetId: "vc-linwu",
    matchName: undefined,
    content: "占位",
    createdAt: "2026-05-27T10:00:00.000Z",
    ...partial,
  };
}

describe("常量", () => {
  it("阈值与渲染端 ts 同步", () => {
    expect(SMS_DUPLICATE_JACCARD_THRESHOLD).toBe(0.7);
    expect(SMS_DUPLICATE_SAME_DAY_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
  });
});

describe("detectSmsDraftDuplicate", () => {
  it("同对方 exact_dup → kind=exact_dup", () => {
    const existing = [draft({ id: "d1", content: "在吗？" })];
    const r = detectSmsDraftDuplicate(
      { targetType: "virtual_contact", targetId: "vc-linwu", content: "在吗？" },
      existing,
      NOW,
    );
    expect(r.kind).toBe("exact_dup");
    expect(r.draft.id).toBe("d1");
  });

  it("normalize：全角问号 vs 半角问号视为同", () => {
    const existing = [draft({ id: "d1", content: "在吗?" })];
    const r = detectSmsDraftDuplicate(
      { targetType: "virtual_contact", targetId: "vc-linwu", content: "在吗？" },
      existing,
      NOW,
    );
    expect(r.kind).toBe("exact_dup");
  });

  it("normalize：包裹符号「」/《》 删掉后判等", () => {
    const existing = [draft({ id: "d1", content: "「上次的事」谢了" })];
    const r = detectSmsDraftDuplicate(
      { targetType: "virtual_contact", targetId: "vc-linwu", content: "上次的事谢了" },
      existing,
      NOW,
    );
    expect(r.kind).toBe("exact_dup");
  });

  it("bigram ≥ 0.7 → similar", () => {
    /** 长串单字替换：18 字差 1 字，Jaccard ≈ 0.88，越过 0.7 阈值。 */
    const existing = [draft({ id: "d1", content: "明天下午一起去诊所看望陈阿姨好吗？" })];
    const r = detectSmsDraftDuplicate(
      { targetType: "virtual_contact", targetId: "vc-linwu", content: "明天下午一起去诊所看望陈阿姨好不？" },
      existing,
      NOW,
    );
    expect(r.kind).toBe("similar");
    if (r.kind === "similar") {
      expect(r.score).toBeGreaterThanOrEqual(SMS_DUPLICATE_JACCARD_THRESHOLD);
    }
  });

  it("跨 targetId 不算重", () => {
    const existing = [draft({ id: "d1", content: "在吗？", targetId: "vc-linwu" })];
    const r = detectSmsDraftDuplicate(
      { targetType: "virtual_contact", targetId: "vc-master", content: "在吗？" },
      existing,
      NOW,
    );
    expect(r.kind).toBe("unique");
  });

  it("matchName 维度也分桶（同 matchName 走判重）", () => {
    const existing = [draft({ id: "d1", content: "在吗？", targetId: undefined, matchName: "苏师姐" })];
    const r = detectSmsDraftDuplicate(
      { targetType: "virtual_contact", matchName: "苏师姐", content: "在吗？" },
      existing,
      NOW,
    );
    expect(r.kind).toBe("exact_dup");
  });

  it("24h 窗口外的旧草稿放过", () => {
    /** 25h 前的旧草稿，不参与判重。 */
    const old = draft({
      id: "d-old",
      content: "在吗？",
      createdAt: new Date(NOW.getTime() - 25 * 60 * 60 * 1000).toISOString(),
    });
    const r = detectSmsDraftDuplicate(
      { targetType: "virtual_contact", targetId: "vc-linwu", content: "在吗？" },
      [old],
      NOW,
    );
    expect(r.kind).toBe("unique");
  });

  it("空 content → unique（短路）", () => {
    const existing = [draft({ id: "d1", content: "在吗？" })];
    const r = detectSmsDraftDuplicate(
      { targetType: "virtual_contact", targetId: "vc-linwu", content: "  " },
      existing,
      NOW,
    );
    expect(r.kind).toBe("unique");
  });

  it("无 targetId 也无 matchName → unique（让上层拒绝）", () => {
    const existing = [draft({ id: "d1", content: "在吗？" })];
    const r = detectSmsDraftDuplicate(
      { targetType: "virtual_contact", content: "在吗？" },
      existing,
      NOW,
    );
    expect(r.kind).toBe("unique");
  });

  it("existing 含 createdAt 解析失败的旧行 → 也参与判重（不过滤）", () => {
    /** 解析不出 timestamp 时按"放过窗口"处理（最稳）；同对方同句仍判 exact_dup。 */
    const bad = draft({ id: "d-bad", content: "在吗？", createdAt: "not-a-date" });
    const r = detectSmsDraftDuplicate(
      { targetType: "virtual_contact", targetId: "vc-linwu", content: "在吗？" },
      [bad],
      NOW,
    );
    expect(r.kind).toBe("exact_dup");
  });
});
