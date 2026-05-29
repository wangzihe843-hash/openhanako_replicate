import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SOCIAL_GLOBAL_STALENESS_THRESHOLD,
  SOCIAL_PER_PEER_STALENESS_THRESHOLD,
  SOCIAL_CANDIDATE_COUNT,
  resolvePeerStatePath,
  readPeerState,
  recordOutboundDm,
  computeSocialStaleness,
  formatSocialCandidateLines,
  resolveSocialThresholds,
} from "../lib/desk/social-awareness.js";
import {
  DEFAULT_SOCIAL_GLOBAL_THRESHOLD,
  DEFAULT_SOCIAL_PER_PEER_THRESHOLD,
  SOCIAL_THRESHOLD_MIN,
  SOCIAL_THRESHOLD_MAX,
} from "../shared/default-workspace-constants.js";

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "social-awareness-"));
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

/** 造 recent_chat.observed 事件流，时间戳从 base 起每条 +1 分钟。 */
function makeChatEvents(count, baseIso = "2026-05-01T00:00:00.000Z") {
  const baseMs = Date.parse(baseIso);
  return Array.from({ length: count }, (_, i) => ({
    type: "recent_chat.observed",
    createdAt: new Date(baseMs + i * 60_000).toISOString(),
  }));
}

describe("peer-state read/record", () => {
  it("returns empty shell when file missing", () => {
    const state = readPeerState(tmpDir);
    expect(state).toEqual({ version: 1, lastOutboundDmAt: null, peers: {} });
  });

  it("returns empty shell on corrupt json without throwing", () => {
    const p = resolvePeerStatePath(tmpDir);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "{ not json", "utf-8");
    expect(readPeerState(tmpDir)).toEqual({ version: 1, lastOutboundDmAt: null, peers: {} });
  });

  it("recordOutboundDm writes global + per-peer timestamps", () => {
    const at = "2026-05-10T12:00:00.000Z";
    const state = recordOutboundDm({ agentDir: tmpDir, peerId: "ming", nowIso: at });
    expect(state.lastOutboundDmAt).toBe(at);
    expect(state.peers.ming.lastOutboundDmAt).toBe(at);
    // round-trips through disk
    const reread = readPeerState(tmpDir);
    expect(reread.lastOutboundDmAt).toBe(at);
    expect(reread.peers.ming.lastOutboundDmAt).toBe(at);
  });

  it("recordOutboundDm keeps other peers, updates global to latest", () => {
    recordOutboundDm({ agentDir: tmpDir, peerId: "ming", nowIso: "2026-05-10T00:00:00.000Z" });
    recordOutboundDm({ agentDir: tmpDir, peerId: "xiaoman", nowIso: "2026-05-11T00:00:00.000Z" });
    const state = readPeerState(tmpDir);
    expect(state.peers.ming.lastOutboundDmAt).toBe("2026-05-10T00:00:00.000Z");
    expect(state.peers.xiaoman.lastOutboundDmAt).toBe("2026-05-11T00:00:00.000Z");
    expect(state.lastOutboundDmAt).toBe("2026-05-11T00:00:00.000Z"); // 最新那条
  });

  it("recordOutboundDm returns null on bad input (no throw)", () => {
    expect(recordOutboundDm({ agentDir: "", peerId: "ming" })).toBeNull();
    expect(recordOutboundDm({ agentDir: tmpDir, peerId: "" })).toBeNull();
  });
});

describe("computeSocialStaleness — global", () => {
  const peers = [{ id: "ming", name: "明", summary: "钟与共鸣" }];

  it("does not socialize when no peers exist (even if many chat turns)", () => {
    const out = computeSocialStaleness({
      events: makeChatEvents(SOCIAL_GLOBAL_STALENESS_THRESHOLD + 50),
      peerState: { lastOutboundDmAt: null, peers: {} },
      peers: [],
    });
    expect(out.shouldSocialize).toBe(false);
    expect(out.candidatePeers).toEqual([]);
  });

  it("does not socialize below threshold", () => {
    const out = computeSocialStaleness({
      events: makeChatEvents(SOCIAL_GLOBAL_STALENESS_THRESHOLD - 1),
      peerState: { lastOutboundDmAt: null, peers: {} },
      peers,
    });
    expect(out.shouldSocialize).toBe(false);
    expect(out.globalChatTurnsSinceLastDm).toBe(SOCIAL_GLOBAL_STALENESS_THRESHOLD - 1);
  });

  it("socializes at/above threshold when never DM'd anyone", () => {
    const out = computeSocialStaleness({
      events: makeChatEvents(SOCIAL_GLOBAL_STALENESS_THRESHOLD),
      peerState: { lastOutboundDmAt: null, peers: {} },
      peers,
    });
    expect(out.shouldSocialize).toBe(true);
    expect(out.candidatePeers[0].peerId).toBe("ming");
    expect(out.candidatePeers[0].neverContacted).toBe(true);
  });

  it("only counts chat turns AFTER the last outbound DM", () => {
    // 100 条对话，第 50 条时刻发过 dm；之后只剩 ~50 条 < 阈值(80) → 不该社交
    const events = makeChatEvents(100);
    const dmAt = events[49].createdAt; // 第 50 条之后发的
    const out = computeSocialStaleness({
      events,
      peerState: { lastOutboundDmAt: dmAt, peers: { ming: { lastOutboundDmAt: dmAt } } },
      peers,
    });
    expect(out.globalChatTurnsSinceLastDm).toBe(50);
    expect(out.shouldSocialize).toBe(false);
  });
});

describe("computeSocialStaleness — per-peer", () => {
  const peers = [
    { id: "ming", name: "明", summary: "钟与共鸣" },
    { id: "xiaoman", name: "小满", summary: "爱烘焙" },
  ];

  it("flags a peer overdue past per-peer threshold; recent peer not overdue", () => {
    const events = makeChatEvents(SOCIAL_PER_PEER_STALENESS_THRESHOLD + 5);
    // xiaoman 刚联系过（在倒数第 2 条对话时），ming 从没联系
    const recentDmAt = events[events.length - 2].createdAt;
    const out = computeSocialStaleness({
      events,
      peerState: {
        lastOutboundDmAt: recentDmAt,
        peers: { xiaoman: { lastOutboundDmAt: recentDmAt } },
      },
      peers,
    });
    expect(out.overduePeerCount).toBe(1); // 只有 ming
    // 候选里 ming 排第一（最久没联系）
    expect(out.candidatePeers[0].peerId).toBe("ming");
    const xiaoman = out.candidatePeers.find(p => p.peerId === "xiaoman");
    if (xiaoman) expect(xiaoman.chatTurnsSinceLastDm).toBeLessThan(SOCIAL_PER_PEER_STALENESS_THRESHOLD);
  });

  it("caps candidatePeers at SOCIAL_CANDIDATE_COUNT", () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ id: `a${i}`, name: `A${i}` }));
    const out = computeSocialStaleness({
      events: makeChatEvents(SOCIAL_GLOBAL_STALENESS_THRESHOLD),
      peerState: { lastOutboundDmAt: null, peers: {} },
      peers: many,
    });
    expect(out.candidatePeers.length).toBe(SOCIAL_CANDIDATE_COUNT);
  });

  it("ranks most-overdue first", () => {
    const events = makeChatEvents(300);
    // ming 很久前联系过（第10条后），xiaoman 最近联系过（第250条后）
    const out = computeSocialStaleness({
      events,
      peerState: {
        lastOutboundDmAt: events[249].createdAt,
        peers: {
          ming: { lastOutboundDmAt: events[9].createdAt },
          xiaoman: { lastOutboundDmAt: events[249].createdAt },
        },
      },
      peers,
    });
    expect(out.candidatePeers[0].peerId).toBe("ming"); // 更久 → 排前
    expect(out.candidatePeers[0].chatTurnsSinceLastDm)
      .toBeGreaterThan(out.candidatePeers[1].chatTurnsSinceLastDm);
  });
});

describe("resolveSocialThresholds (config-driven)", () => {
  it("falls back to defaults when desk is missing/empty", () => {
    expect(resolveSocialThresholds(undefined)).toEqual({
      globalThreshold: DEFAULT_SOCIAL_GLOBAL_THRESHOLD,
      perPeerThreshold: DEFAULT_SOCIAL_PER_PEER_THRESHOLD,
    });
    expect(resolveSocialThresholds({})).toEqual({
      globalThreshold: DEFAULT_SOCIAL_GLOBAL_THRESHOLD,
      perPeerThreshold: DEFAULT_SOCIAL_PER_PEER_THRESHOLD,
    });
  });

  it("reads explicit config values", () => {
    const out = resolveSocialThresholds({ social_global_threshold: 120, social_per_peer_threshold: 300 });
    expect(out).toEqual({ globalThreshold: 120, perPeerThreshold: 300 });
  });

  it("clamps out-of-range / garbage values to [MIN, MAX] or default", () => {
    // 太小 → MIN
    expect(resolveSocialThresholds({ social_global_threshold: 0 }).globalThreshold).toBe(SOCIAL_THRESHOLD_MIN);
    // 太大 → MAX
    expect(resolveSocialThresholds({ social_per_peer_threshold: 999999 }).perPeerThreshold).toBe(SOCIAL_THRESHOLD_MAX);
    // 非数字 → default
    expect(resolveSocialThresholds({ social_global_threshold: "abc" }).globalThreshold).toBe(DEFAULT_SOCIAL_GLOBAL_THRESHOLD);
  });

  it("config threshold actually drives computeSocialStaleness", () => {
    const peers = [{ id: "ming", name: "明" }];
    const events = makeChatEvents(30);
    const { globalThreshold } = resolveSocialThresholds({ social_global_threshold: 25 });
    // 30 条对话 ≥ 自定义阈值 25 → 应社交（默认 80 则不会）
    const out = computeSocialStaleness({
      events,
      peerState: { lastOutboundDmAt: null, peers: {} },
      peers,
      globalThreshold,
    });
    expect(out.shouldSocialize).toBe(true);
  });
});

describe("formatSocialCandidateLines", () => {
  it("renders name(id) with persona hint", () => {
    const lines = formatSocialCandidateLines(
      [{ peerId: "ming", name: "明", summary: "钟与共鸣", chatTurnsSinceLastDm: 90 }],
      true,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("明");
    expect(lines[0]).toContain("ming");
    expect(lines[0]).toContain("钟与共鸣");
    expect(lines[0].startsWith("- ")).toBe(true);
  });

  it("omits persona when no summary", () => {
    const lines = formatSocialCandidateLines([{ peerId: "ming", name: "ming", chatTurnsSinceLastDm: 90 }], false);
    expect(lines[0]).toBe("- ming");
  });

  it("handles non-array input", () => {
    expect(formatSocialCandidateLines(null, true)).toEqual([]);
  });

  it("marks never-contacted candidates so the agent doesn't fake a reunion", () => {
    const lines = formatSocialCandidateLines(
      [{ peerId: "ming", name: "明", summary: "钟与共鸣", chatTurnsSinceLastDm: 250, neverContacted: true }],
      true,
    );
    expect(lines[0]).toContain("还没联系过");
  });

  it("does not add the never-contacted marker when the peer has been contacted", () => {
    const lines = formatSocialCandidateLines(
      [{ peerId: "ming", name: "明", summary: "钟与共鸣", chatTurnsSinceLastDm: 90, neverContacted: false }],
      true,
    );
    expect(lines[0]).not.toContain("还没联系过");
  });
});
