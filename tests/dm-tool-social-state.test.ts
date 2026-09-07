import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { createDmTool } from "../lib/tools/dm-tool.ts";
import {
  computeSocialStaleness,
  readPeerState,
  recordOutboundDm,
  syncPeerStateUserTurns,
} from "../lib/desk/social-awareness.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function chatEvents(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `chat-${i}`,
    agentId: "agent-a",
    type: "recent_chat.observed",
    source: "desktop-session-submit",
    createdAt: new Date(Date.parse("2026-07-01T00:00:00.000Z") + i * 60_000).toISOString(),
    payload: { turnIndex: i },
  }));
}

function writeEventLog(agentDir: string, events: unknown[]) {
  const filePath = path.join(agentDir, "xingye", "events", "log.json");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ version: 1, events, dedupeKeys: {} }), "utf8");
}

describe("dm tool social fallback baseline", () => {
  it("syncs pending user turns before resetting only the target peer", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-dm-social-"));
    roots.push(root);
    const agentsDir = path.join(root, "agents");
    const agentDir = path.join(agentsDir, "agent-a");
    fs.mkdirSync(path.join(agentsDir, "agent-b"), { recursive: true });
    fs.mkdirSync(path.join(agentsDir, "agent-c"), { recursive: true });

    syncPeerStateUserTurns({ agentDir, events: chatEvents(40) });
    recordOutboundDm({ agentDir, peerId: "agent-c", nowIso: "2026-07-01T01:00:00.000Z" });
    writeEventLog(agentDir, chatEvents(79));

    const tool = createDmTool({
      agentId: "agent-a",
      agentsDir,
      listAgents: () => [
        { id: "agent-a", name: "Agent A" },
        { id: "agent-b", name: "Agent B" },
        { id: "agent-c", name: "Agent C" },
      ],
    });
    await tool.execute("call-1", { to: "agent-b", message: "hello" });

    let state = readPeerState(agentDir);
    expect(state.userTurnCount).toBe(79);
    expect(state.peers["agent-b"].lastOutboundDmTurn).toBe(79);
    expect(state.peers["agent-c"].lastOutboundDmTurn).toBe(40);

    syncPeerStateUserTurns({ agentDir, events: chatEvents(80) });
    state = readPeerState(agentDir);
    const out = computeSocialStaleness({
      events: chatEvents(80),
      peerState: state,
      peers: [
        { id: "agent-b", relationshipKnown: true },
        { id: "agent-c", relationshipKnown: true },
      ],
      globalThreshold: 1_000,
      perPeerThreshold: 1,
    });
    const byId = Object.fromEntries(out.candidatePeers.map((peer: any) => [peer.peerId, peer]));
    expect(byId["agent-b"].chatTurnsSinceLastDm).toBe(1);
    expect(byId["agent-c"].chatTurnsSinceLastDm).toBe(40);
  });
});
