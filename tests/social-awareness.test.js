import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SOCIAL_GLOBAL_STALENESS_THRESHOLD,
  SOCIAL_PER_PEER_STALENESS_THRESHOLD,
  resolvePeerStatePath,
  readPeerState,
  recordOutboundDm,
  syncPeerStateUserTurns,
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
function makeChatEvents(count, baseIso = "2026-05-01T00:00:00.000Z", idPrefix = "chat") {
  const baseMs = Date.parse(baseIso);
  return Array.from({ length: count }, (_, i) => ({
    id: `${idPrefix}-${i}`,
    type: "recent_chat.observed",
    createdAt: new Date(baseMs + i * 60_000).toISOString(),
  }));
}

describe("peer-state read/record", () => {
  it("returns empty shell when file missing", () => {
    const state = readPeerState(tmpDir);
    expect(state).toEqual({
      version: 2,
      userTurnCount: 0,
      countedRecentChatEventIds: [],
      lastOutboundDmAt: null,
      lastOutboundDmTurn: null,
      peers: {},
    });
  });

  it("returns empty shell on corrupt json without throwing", () => {
    const p = resolvePeerStatePath(tmpDir);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "{ not json", "utf-8");
    expect(readPeerState(tmpDir)).toEqual({
      version: 2,
      userTurnCount: 0,
      countedRecentChatEventIds: [],
      lastOutboundDmAt: null,
      lastOutboundDmTurn: null,
      peers: {},
    });
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

  it("resets only the target peer's turn gap when sending to different peers", () => {
    syncPeerStateUserTurns({ agentDir: tmpDir, events: makeChatEvents(80) });
    recordOutboundDm({ agentDir: tmpDir, peerId: "agent-2", nowIso: "2026-05-10T00:00:00.000Z" });
    syncPeerStateUserTurns({ agentDir: tmpDir, events: makeChatEvents(90) });
    recordOutboundDm({ agentDir: tmpDir, peerId: "agent-3", nowIso: "2026-05-11T00:00:00.000Z" });

    const state = readPeerState(tmpDir);
    expect(state.userTurnCount).toBe(90);
    expect(state.peers["agent-2"].lastOutboundDmTurn).toBe(80);
    expect(state.peers["agent-3"].lastOutboundDmTurn).toBe(90);
    expect(state.userTurnCount - state.peers["agent-2"].lastOutboundDmTurn).toBe(10);
    expect(state.userTurnCount - state.peers["agent-3"].lastOutboundDmTurn).toBe(0);
  });

  it("keeps cumulative user turns after old event ids are pruned", () => {
    syncPeerStateUserTurns({
      agentDir: tmpDir,
      events: makeChatEvents(40, "2026-04-01T00:00:00.000Z", "old"),
    });
    const currentLog = makeChatEvents(40, "2026-05-01T00:00:00.000Z", "new");
    syncPeerStateUserTurns({ agentDir: tmpDir, events: currentLog });
    syncPeerStateUserTurns({ agentDir: tmpDir, events: currentLog });

    const state = readPeerState(tmpDir);
    expect(state.userTurnCount).toBe(80);
    expect(state.countedRecentChatEventIds).toHaveLength(40);
    expect(computeSocialStaleness({
      events: currentLog,
      peerState: state,
      peers: [{ id: "family", relationshipKnown: true }],
    }).candidatePeers[0].chatTurnsSinceLastDm).toBe(80);
  });

  it.each([
    { label: "v1 missing", version: 1, baseline: undefined },
    { label: "v2 null", version: 2, baseline: null },
    { label: "v2 empty", version: 2, baseline: "" },
    { label: "v2 whitespace", version: 2, baseline: "  " },
  ])("migrates $label timestamp baselines once and preserves gaps after event pruning", ({ version, baseline }) => {
    const events = makeChatEvents(100);
    const recentDmAt = events[98].createdAt;
    const olderDmAt = events[39].createdAt;
    const statePath = resolvePeerStatePath(tmpDir);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({
      version,
      ...(version === 2 ? {
        userTurnCount: 100,
        countedRecentChatEventIds: events.map((event) => event.id),
        lastOutboundDmTurn: baseline,
      } : {}),
      lastOutboundDmAt: recentDmAt,
      peers: {
        ming: { lastOutboundDmAt: recentDmAt, ...(version === 2 ? { lastOutboundDmTurn: baseline } : {}) },
        xiaoman: { lastOutboundDmAt: olderDmAt, ...(version === 2 ? { lastOutboundDmTurn: baseline } : {}) },
      },
    }), "utf-8");

    expect(readPeerState(tmpDir).lastOutboundDmTurn).toBeNull();
    expect(readPeerState(tmpDir).peers.ming.lastOutboundDmTurn).toBeNull();
    const peers = [
      { id: "ming", relationshipKnown: true },
      { id: "xiaoman", relationshipKnown: true },
    ];
    const staleness = (log) => computeSocialStaleness({ events: log, peerState: readPeerState(tmpDir), peers });

    // Retrying the same observations, including a duplicate id, cannot move the
    // migrated baselines or count the last chat turn twice.
    syncPeerStateUserTurns({ agentDir: tmpDir, events: [...events, events[99]] });
    syncPeerStateUserTurns({ agentDir: tmpDir, events });
    expect(readPeerState(tmpDir)).toMatchObject({
      userTurnCount: 100,
      lastOutboundDmTurn: 99,
      peers: {
        ming: { lastOutboundDmTurn: 99 },
        xiaoman: { lastOutboundDmTurn: 40 },
      },
    });
    expect(staleness(events)).toMatchObject({
      globalChatTurnsSinceLastDm: 1,
      shouldSocialize: false,
      overduePeerCount: 0,
    });

    syncPeerStateUserTurns({ agentDir: tmpDir, events: [] });
    expect(staleness([]).globalChatTurnsSinceLastDm).toBe(1);
    const laterEvents = makeChatEvents(40, "2026-05-10T00:00:00.000Z", "later");
    syncPeerStateUserTurns({ agentDir: tmpDir, events: laterEvents });
    expect(staleness(laterEvents)).toMatchObject({
      globalChatTurnsSinceLastDm: 41,
      shouldSocialize: false,
      overduePeerCount: 1,
      candidatePeers: [expect.objectContaining({ peerId: "xiaoman", chatTurnsSinceLastDm: 100 })],
    });
  });

  it("recordOutboundDm returns null on bad input (no throw)", () => {
    expect(recordOutboundDm({ agentDir: "", peerId: "ming" })).toBeNull();
    expect(recordOutboundDm({ agentDir: tmpDir, peerId: "" })).toBeNull();
  });

  it("migrates a timestamp before retained history without resetting its known elapsed turns", () => {
    const statePath = resolvePeerStatePath(tmpDir);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({
      version: 1,
      lastOutboundDmAt: "2026-04-01T00:00:00.000Z",
      peers: { ming: { lastOutboundDmAt: "2026-04-01T00:00:00.000Z" } },
    }), "utf-8");
    const retained = makeChatEvents(90);
    syncPeerStateUserTurns({ agentDir: tmpDir, events: retained });
    syncPeerStateUserTurns({ agentDir: tmpDir, events: [] });
    expect(computeSocialStaleness({
      events: [],
      peerState: readPeerState(tmpDir),
      peers: [{ id: "ming", relationshipKnown: true }],
    })).toMatchObject({
      globalChatTurnsSinceLastDm: 90,
      overduePeerCount: 1,
      candidatePeers: [expect.objectContaining({ peerId: "ming", chatTurnsSinceLastDm: 90 })],
    });
  });

  it("ignores invalid event dates and does not treat an invalid DM timestamp as a valid baseline", () => {
    const statePath = resolvePeerStatePath(tmpDir);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({
      version: 1,
      lastOutboundDmAt: "invalid",
      peers: { ming: { lastOutboundDmAt: "invalid" } },
    }), "utf-8");
    const events = [
      ...makeChatEvents(3),
      { id: "bad-date", type: "recent_chat.observed", createdAt: "invalid" },
      { id: "no-date", type: "recent_chat.observed" },
    ];
    syncPeerStateUserTurns({ agentDir: tmpDir, events });
    const state = readPeerState(tmpDir);
    expect(state.userTurnCount).toBe(3);
    expect(state.lastOutboundDmAt).toBeNull();
    expect(state.lastOutboundDmTurn).toBeNull();
    expect(state.countedRecentChatEventIds).toEqual(["chat-0", "chat-1", "chat-2"]);
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

  it("does not let the global threshold bypass peer fallback intervals", () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ id: `a${i}`, name: `A${i}` }));
    const out = computeSocialStaleness({
      events: makeChatEvents(SOCIAL_GLOBAL_STALENESS_THRESHOLD),
      peerState: { lastOutboundDmAt: null, peers: {} },
      peers: many,
      perPeerThreshold: SOCIAL_GLOBAL_STALENESS_THRESHOLD + 50,
    });
    expect(out.shouldSocialize).toBe(true);
    expect(out.candidatePeers).toEqual([]);
  });

  it("waits for a custom per-DM interval before nominating that peer", () => {
    const peer = {
      id: "patient-friend",
      relationshipKnown: true,
      socialFallbackTurnInterval: 120,
    };
    const at80 = computeSocialStaleness({
      events: makeChatEvents(80),
      peerState: { lastOutboundDmAt: null, peers: {} },
      peers: [peer],
    });
    expect(at80.shouldSocialize).toBe(true);
    expect(at80.overduePeerCount).toBe(0);
    expect(at80.candidatePeers).toEqual([]);

    const at120 = computeSocialStaleness({
      events: makeChatEvents(120),
      peerState: { lastOutboundDmAt: null, peers: {} },
      peers: [peer],
    });
    expect(at120.overduePeerCount).toBe(1);
    expect(at120.candidatePeers[0].peerId).toBe("patient-friend");
  });

  it("includes every peer whose own relationship interval is overdue", () => {
    const many = Array.from({ length: 5 }, (_, i) => ({
      id: `a${i}`,
      name: `A${i}`,
      relationshipKnown: true,
    }));
    const out = computeSocialStaleness({
      events: makeChatEvents(SOCIAL_PER_PEER_STALENESS_THRESHOLD),
      peerState: { lastOutboundDmAt: null, peers: {} },
      peers: many,
    });
    expect(out.overduePeerCount).toBe(5);
    expect(out.candidatePeers).toHaveLength(5);
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
      globalThreshold: 1,
      perPeerThreshold: 1,
    });
    expect(out.candidatePeers[0].peerId).toBe("ming"); // 更久 → 排前
    expect(out.candidatePeers[0].chatTurnsSinceLastDm)
      .toBeGreaterThan(out.candidatePeers[1].chatTurnsSinceLastDm);
  });

  it("gives established relationships an 80-chat fallback and excludes unrelated peers", () => {
    const events = makeChatEvents(80);
    const out = computeSocialStaleness({
      events,
      peerState: { lastOutboundDmAt: null, peers: {} },
      peers: [
        {
          id: "rival",
          name: "情敌",
          relationshipKnown: true,
          relationshipLore: "你们都已发现彼此在意同一个人。",
        },
        { id: "stranger", name: "陌生同事", relationshipKnown: false },
      ],
    });

    expect(SOCIAL_PER_PEER_STALENESS_THRESHOLD).toBe(80);
    expect(out.shouldSocialize).toBe(true);
    expect(out.overduePeerCount).toBe(1);
    expect(out.relationshipPeerCount).toBe(1);
    expect(out.candidatePeers).toHaveLength(1);
    expect(out.candidatePeers[0]).toMatchObject({
      peerId: "rival",
      relationshipKnown: true,
      relationshipLore: "你们都已发现彼此在意同一个人。",
    });
  });

  it("has no fallback interaction when every peer is unrelated", () => {
    const out = computeSocialStaleness({
      events: makeChatEvents(500),
      peerState: { lastOutboundDmAt: null, peers: {} },
      peers: [
        { id: "a", relationshipKnown: false },
        { id: "b", relationshipKnown: false },
      ],
    });
    expect(out.shouldSocialize).toBe(false);
    expect(out.overduePeerCount).toBe(0);
    expect(out.relationshipPeerCount).toBe(0);
    expect(out.candidatePeers).toEqual([]);
  });

  it("supports per-DM enable/disable overrides and independent intervals", () => {
    const out = computeSocialStaleness({
      events: makeChatEvents(40),
      peerState: { lastOutboundDmAt: null, peers: {} },
      peers: [
        {
          id: "close-friend",
          relationshipKnown: true,
          socialFallbackMode: "auto",
          socialFallbackTurnInterval: 30,
        },
        {
          id: "manual-contact",
          relationshipKnown: false,
          socialFallbackMode: "enabled",
          socialFallbackTurnInterval: 40,
        },
        {
          id: "muted-rival",
          relationshipKnown: true,
          socialFallbackMode: "disabled",
          socialFallbackTurnInterval: 10,
        },
      ],
    });
    expect(out.fallbackPeerCount).toBe(2);
    expect(out.relationshipPeerCount).toBe(1);
    expect(out.overduePeerCount).toBe(2);
    expect(out.candidatePeers.map((peer) => peer.peerId).sort()).toEqual([
      "close-friend",
      "manual-contact",
    ]);
    expect(out.candidatePeers.find((peer) => peer.peerId === "close-friend").fallbackThreshold).toBe(30);
    expect(out.candidatePeers.find((peer) => peer.peerId === "manual-contact").fallbackThreshold).toBe(40);
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
