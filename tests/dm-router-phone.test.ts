import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it, vi } from "vitest";
import { DmRouter } from "../hub/dm-router.ts";
import { getAgentPhoneProjectionPath, readAgentPhoneProjection, updateAgentPhoneProjectionMeta } from "../lib/conversations/agent-phone-projection.ts";

const { runAgentPhoneSessionMock } = vi.hoisted(() => ({
  runAgentPhoneSessionMock: vi.fn(async () => "收到 <done/>"),
}));

vi.mock("../hub/agent-executor.js", () => ({
  runAgentPhoneSession: runAgentPhoneSessionMock,
}));

vi.mock("../lib/debug-log.js", () => ({
  debugLog: () => ({ log: vi.fn(), error: vi.fn(), warn: vi.fn() }),
  createModuleLogger: () => ({
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

function writeDmFile(filePath, sender, body) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, [
    "---",
    "type: dm",
    "---",
    "",
    `### ${sender} | 2026-05-12 20:00:00`,
    "",
    body,
    "",
    "---",
    "",
  ].join("\n"), "utf-8");
}

function writeRelationshipLore(agentDir: string, agentId: string, peerId: string, peerName: string, content: string) {
  const loreDir = path.join(agentDir, "xingye", "lore");
  fs.mkdirSync(loreDir, { recursive: true });
  fs.writeFileSync(path.join(loreDir, "entries.json"), JSON.stringify({
    relation: {
      id: "relation",
      agentId,
      title: `relation-${peerId}`,
      category: "relationship",
      keywords: [peerId, peerName],
      content,
      enabled: true,
      visibility: "canonical",
      insertionMode: "keyword",
      priority: 50,
    },
  }), "utf8");
}

describe("DmRouter agent phone session", () => {
  it("re-evaluates relationship lore from each responder's own perspective after a DM reply", async () => {
    runAgentPhoneSessionMock.mockReset()
      .mockResolvedValueOnce("Bob replies")
      .mockResolvedValueOnce("Alice closes <done/>");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-dm-two-way-lore-"));
    const agentsDir = path.join(root, "agents");
    const aliceDir = path.join(agentsDir, "alice");
    const bobDir = path.join(agentsDir, "bob");
    writeDmFile(path.join(aliceDir, "dm", "bob.md"), "alice", "hi Bob");
    writeDmFile(path.join(bobDir, "dm", "alice.md"), "alice", "hi Bob");
    writeRelationshipLore(aliceDir, "alice", "bob", "Bob", "Alice 把 Bob 当作多年挚友。");
    writeRelationshipLore(bobDir, "bob", "alice", "Alice", "Bob 把 Alice 当作值得戒备的宿敌。");
    const agents = {
      alice: { id: "alice", agentDir: aliceDir, agentName: "Alice", config: { agent: { yuan: "hanako" } } },
      bob: { id: "bob", agentDir: bobDir, agentName: "Bob", config: { agent: { yuan: "ming" } } },
    } as Record<string, any>;
    const router = new DmRouter({
      hub: {
        engine: { agentsDir, getAgent: (id: string) => agents[id] || null },
        eventBus: { emit: vi.fn() },
        agentPhoneActivities: { record: vi.fn() },
      },
    });

    await router._processReply("alice", "bob");

    expect(runAgentPhoneSessionMock).toHaveBeenCalledTimes(2);
    const bobRound = (runAgentPhoneSessionMock.mock.calls as any)[0][1][0];
    const aliceRound = (runAgentPhoneSessionMock.mock.calls as any)[1][1][0];
    expect(bobRound.context.system).toContain("Bob 把 Alice 当作值得戒备的宿敌");
    expect(bobRound.context.system).not.toContain("Alice 把 Bob 当作多年挚友");
    expect(aliceRound.context.system).toContain("Alice 把 Bob 当作多年挚友");
    expect(aliceRound.context.system).not.toContain("Bob 把 Alice 当作值得戒备的宿敌");
    expect(bobRound.text).not.toContain("本轮动态角色上下文");
    expect(aliceRound.text).not.toContain("本轮动态角色上下文");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("does not start DM phone processing when the phone feature is disabled", async () => {
    runAgentPhoneSessionMock.mockClear();

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-dm-phone-disabled-"));
    const agentsDir = path.join(root, "agents");
    const aliceDir = path.join(agentsDir, "alice");
    const bobDir = path.join(agentsDir, "bob");
    writeDmFile(path.join(aliceDir, "dm", "bob.md"), "bob", "ping");
    writeDmFile(path.join(bobDir, "dm", "alice.md"), "bob", "ping");

    const router = new DmRouter({
      hub: {
        engine: {
          agentsDir,
          isChannelsEnabled: () => false,
          getAgent: (id) => ({
            id,
            agentDir: id === "alice" ? aliceDir : bobDir,
            agentName: id === "alice" ? "Alice" : "Bob",
            config: { agent: { name: id } },
            personality: `I am ${id}`,
          }),
        },
        eventBus: { emit: vi.fn() },
        agentPhoneActivities: { record: vi.fn() },
      },
    });

    await router.handleNewDm("bob", "alice");

    expect(runAgentPhoneSessionMock).not.toHaveBeenCalled();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("uses a reusable phone session and records per-agent DM activity", async () => {
    runAgentPhoneSessionMock.mockClear();
    runAgentPhoneSessionMock.mockResolvedValueOnce("收到 <done/>");

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-dm-phone-"));
    const agentsDir = path.join(root, "agents");
    const aliceDir = path.join(agentsDir, "alice");
    const bobDir = path.join(agentsDir, "bob");
    writeDmFile(path.join(aliceDir, "dm", "bob.md"), "bob", "我刚从旧城区回来");
    writeDmFile(path.join(bobDir, "dm", "alice.md"), "bob", "我刚从旧城区回来");
    fs.mkdirSync(path.join(aliceDir, "xingye", "lore"), { recursive: true });
    fs.writeFileSync(
      path.join(aliceDir, "xingye", "profile.json"),
      JSON.stringify({ displayName: "Alice", behaviorLogic: "面对老朋友先听完再回应" }),
      "utf8",
    );
    const loreEntry = (id: string, category: string, keywords: string[], content: string) => ({
      id,
      agentId: "alice",
      title: id,
      category,
      keywords,
      content,
      enabled: true,
      visibility: "canonical",
      insertionMode: "keyword",
      priority: 50,
    });
    fs.writeFileSync(
      path.join(aliceDir, "xingye", "lore", "entries.json"),
      JSON.stringify({
        bob: loreEntry("bob", "relationship", ["Bob", "bob"], "Bob 是 Alice 多年的老朋友。"),
        oldCity: loreEntry("old-city", "location", ["旧城区"], "旧城区夜里会敲三次钟。"),
      }),
      "utf8",
    );
    await updateAgentPhoneProjectionMeta({
      agentDir: aliceDir,
      agentId: "alice",
      conversationId: "dm:bob",
      conversationType: "dm",
      patch: {
        toolMode: "write",
        replyMinChars: "20",
        replyMaxChars: "80",
        modelOverrideEnabled: "true",
        modelOverrideId: "deepseek-v4-flash",
        modelOverrideProvider: "deepseek",
      },
    });

    const emit = vi.fn();
    const activityRecord = vi.fn();
    const router = new DmRouter({
      hub: {
        engine: {
          agentsDir,
          getAgent: (id) => ({
            id,
            agentDir: id === "alice" ? aliceDir : bobDir,
            agentName: id === "alice" ? "Alice" : "Bob",
            config: { agent: { name: id, yuan: id === "alice" ? "ming" : "hanako" } },
            personality: `I am ${id}`,
          }),
        },
        eventBus: { emit },
        agentPhoneActivities: { record: activityRecord },
      },
    });

    await router._processReply("bob", "alice");

    expect(runAgentPhoneSessionMock).toHaveBeenCalledOnce();
    expect((runAgentPhoneSessionMock.mock.calls as any)[0][2]).toMatchObject({
      conversationId: "dm:bob",
      conversationType: "dm",
      toolMode: "write",
      modelOverride: { id: "deepseek-v4-flash", provider: "deepseek" },
    });
    const phonePrompt = (runAgentPhoneSessionMock.mock.calls as any)[0][1][0].text;
    const phoneContext = (runAgentPhoneSessionMock.mock.calls as any)[0][1][0].context.system;
    expect(phonePrompt).toContain("Reflect");
    expect(phonePrompt).toContain("<reflect>");
    expect(phonePrompt).toContain("实际发到私聊的回复正文");
    expect(phonePrompt).toContain("优先口语化");
    expect(phonePrompt).toContain("内容很长");
    expect(phonePrompt).toContain("20");
    expect(phonePrompt).toContain("80");
    expect(phoneContext).toContain("面对老朋友先听完再回应");
    expect(phoneContext).toContain("profile 中“与用户的关系/相处模式”只描述你与用户");
    expect(phoneContext).toContain("Bob（bob）");
    expect(phoneContext).toContain("其他独立 AI agent，不是用户，也不是你自己");
    expect(phoneContext).toContain("Bob 是 Alice 多年的老朋友");
    expect(phoneContext).toContain("旧城区夜里会敲三次钟");
    expect(phonePrompt).not.toContain("本轮动态角色上下文");
    expect((runAgentPhoneSessionMock.mock.calls as any)[0][2]).not.toHaveProperty("systemAppend");
    expect(phonePrompt).not.toContain("只在能推进话题时回复");
    expect((runAgentPhoneSessionMock.mock.calls as any)[0][2]).not.toHaveProperty("maxTokens");
    expect(activityRecord.mock.calls.map((call) => call[0].state)).toEqual(
      expect.arrayContaining(["viewed", "replying", "idle"]),
    );
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      type: "dm_new_message",
      from: "alice",
      to: "bob",
    }), null);

    const projection = readAgentPhoneProjection(getAgentPhoneProjectionPath(aliceDir, "dm:bob"));
    expect(projection.meta).toMatchObject({
      agentId: "alice",
      conversationId: "dm:bob",
      conversationType: "dm",
      state: "idle",
    });

    fs.rmSync(root, { recursive: true, force: true });
  });
});
