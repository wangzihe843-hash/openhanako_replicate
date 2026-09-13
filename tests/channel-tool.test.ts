import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createChannel, appendMessage, removeChannelMember, deleteChannel, addChannelMember } from "../lib/channels/channel-store.ts";
import { createChannelTool } from "../lib/tools/channel-tool.ts";
import { resolveToolInvocationPermission } from "../lib/permission/tool-invocation-permission.ts";

function mktemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hana-channel-tool-test-"));
}

describe("channel tool membership contract", () => {
  let tmpDir;
  let channelsDir;
  let agentsDir;

  beforeEach(() => {
    tmpDir = mktemp();
    channelsDir = path.join(tmpDir, "channels");
    agentsDir = path.join(tmpDir, "agents");
    fs.mkdirSync(channelsDir, { recursive: true });
    fs.mkdirSync(agentsDir, { recursive: true });
    for (const id of ["alice", "bob", "charlie"]) {
      fs.mkdirSync(path.join(agentsDir, id), { recursive: true });
    }
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it.each(["member-removal", "deletion", "cancellation", "disabled"])("rejects a queued post after %s without onPost notification", async (scenario) => {
    const { id, filePath } = await createChannel(channelsDir, {
      id: "queued", name: "Queued", members: ["alice", "bob", "charlie"],
    } as any);
    const onPost = vi.fn();
    const controller = new AbortController();
    let enabled = true;
    const tool = createChannelTool({ channelsDir, agentsDir, agentId: "alice", onPost, isEnabled: () => enabled } as any);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const held = new Promise<void>((resolve) => { entered = resolve; });
    const pause = async (target) => { if (target === filePath) { entered(); await gate; } };
    const rename = fs.promises.rename.bind(fs.promises);
    const unlink = fs.promises.unlink.bind(fs.promises);
    vi.spyOn(fs.promises, "rename").mockImplementation(async (from, to) => {
      await pause(to);
      return rename(from, to);
    });
    vi.spyOn(fs.promises, "unlink").mockImplementation(async (target) => {
      await pause(target);
      return unlink(target);
    });
    let mutation;
    let pending;
    try {
      mutation = scenario === "deletion" ? deleteChannel(filePath)
        : scenario === "member-removal" ? removeChannelMember(filePath, "alice") : addChannelMember(filePath, "dora");
      await held;
      // execute reaches append synchronously; the old member list passes its
      // precheck, but the append is queued behind the locked mutation.
      pending = tool.execute("queued-post", { action: "post", channel: id, content: "forbidden late post" }, controller.signal)
        .then(() => null, (error) => error);
      if (scenario === "cancellation") controller.abort();
      if (scenario === "disabled") enabled = false;
      release();
      await mutation;
      expect(await pending).toMatchObject({
        code: scenario === "deletion" ? "channel_not_found" : scenario === "member-removal" ? "channel_not_member" : "channel_write_cancelled",
        status: scenario === "deletion" ? 404 : scenario === "member-removal" ? 403 : 409,
      });
      expect(onPost).not.toHaveBeenCalled();
      if (scenario === "deletion") expect(fs.existsSync(filePath)).toBe(false);
      else {
        expect(fs.readFileSync(filePath, "utf8")).not.toContain("forbidden late post");
        const remaining = createChannelTool({ channelsDir, agentsDir, agentId: "bob", onPost } as any);
        const result = await remaining.execute("allowed-post", { action: "post", channel: id, content: "allowed reply" });
        expect(result.details).toMatchObject({ action: "post", channel: id });
        expect(onPost).toHaveBeenCalledOnce();
        expect(fs.readFileSync(filePath, "utf8")).toContain("allowed reply");
      }
    } finally {
      release();
      await Promise.allSettled([mutation, pending]);
      vi.restoreAllMocks();
    }
  });

  it("does not direct the model to the removed dm tool", () => {
    const tool = createChannelTool({
      channelsDir,
      agentsDir,
      agentId: "alice",
      listAgents: () => [],
      isEnabled: () => true,
    } as any);

    expect(tool.description).not.toMatch(/\bdm tool\b/i);
    expect(tool.description).toContain("cannot read or send one-on-one Agent Phone conversations");
  });

  it("rejects create when fewer than two unique agent members would be present", async () => {
    const tool = createChannelTool({
      channelsDir,
      agentsDir,
      agentId: "alice",
      listAgents: () => [],
      isEnabled: () => true,
    } as any);

    const result = await tool.execute("call-1", {
      action: "create",
      name: "solo",
      members: ["alice"],
    });

    expect(result.details).toMatchObject({
      action: "create",
      error: expect.stringMatching(/at least 2/i),
    });
    expect(fs.readdirSync(channelsDir)).toEqual([]);
  });

  it("rejects create when a requested member has no agent directory", async () => {
    const tool = createChannelTool({
      channelsDir,
      agentsDir,
      agentId: "alice",
      listAgents: () => [],
      isEnabled: () => true,
    } as any);

    const result = await tool.execute("call-missing-member", {
      action: "create",
      name: "mixed",
      members: ["bob", "ghost"],
    });

    expect(result.details).toMatchObject({
      action: "create",
      error: "Agent not found: ghost",
    });
    expect(fs.readdirSync(channelsDir)).toEqual([]);
  });

  it("delegates create to the host channel lifecycle when available", async () => {
    const createChannelEntry = vi.fn(async ({ members }) => ({
      id: "ch_delegated",
      members,
    }));
    const tool = createChannelTool({
      channelsDir,
      agentsDir,
      agentId: "alice",
      listAgents: () => [],
      isEnabled: () => true,
      createChannelEntry,
    } as any);

    const result = await tool.execute("call-delegated-create", {
      action: "create",
      name: "delegated",
      members: ["bob"],
      intro: "hello",
    });

    expect(createChannelEntry).toHaveBeenCalledWith({
      name: "delegated",
      members: ["alice", "bob"],
      intro: "hello",
      addUserBookmark: true,
    });
    expect(result.details).toMatchObject({
      action: "create",
      channel: "ch_delegated",
      members: ["alice", "bob"],
    });
  });

  it("rejects read when the agent is not a channel member", async () => {
    const { id } = await createChannel(channelsDir, {
      id: "team",
      name: "Team",
      members: ["bob", "charlie"],
    } as any);
    await appendMessage(path.join(channelsDir, `${id}.md`), "bob", "secret");

    const tool = createChannelTool({
      channelsDir,
      agentsDir,
      agentId: "alice",
      listAgents: () => [],
      isEnabled: () => true,
    } as any);

    const result = await tool.execute("call-2", {
      action: "read",
      channel: id,
    });

    expect(result.details).toMatchObject({
      action: "read",
      error: "not a member",
    });
    expect(result.content[0].text).not.toContain("secret");
  });

  it("lists joined channels with ids and display names", async () => {
    const { id } = await createChannel(channelsDir, {
      id: "team",
      name: "工作群",
      members: ["alice", "bob"],
    } as any);

    const tool = createChannelTool({
      channelsDir,
      agentsDir,
      agentId: "alice",
      listAgents: () => [],
      isEnabled: () => true,
    } as any);

    const result = await tool.execute("call-3", { action: "list" });

    expect(result.details).toMatchObject({
      action: "list",
      channels: [
        expect.objectContaining({ id, name: "工作群", members: ["alice", "bob"] }),
      ],
    });
    expect(result.content[0].text).toContain("ch_team");
    expect(result.content[0].text).toContain("工作群");
    expect(result.content[0].text).toContain("alice, bob");
  });

  it("resolves a unique display name for read and post", async () => {
    const { id } = await createChannel(channelsDir, {
      id: "team",
      name: "工作群",
      members: ["alice", "bob"],
    } as any);
    await appendMessage(path.join(channelsDir, `${id}.md`), "bob", "hello by name");

    const tool = createChannelTool({
      channelsDir,
      agentsDir,
      agentId: "alice",
      listAgents: () => [],
      isEnabled: () => true,
    } as any);

    const readResult = await tool.execute("call-4", {
      action: "read",
      channel: "工作群",
    });
    expect(readResult.details).toMatchObject({ action: "read", channel: id, messageCount: 1 });
    expect(readResult.content[0].text).toContain("hello by name");

    const postResult = await tool.execute("call-5", {
      action: "post",
      channel: "工作群",
      content: "reply by display name",
    });
    expect(postResult.details).toMatchObject({ action: "post", channel: id });

    const confirm = await tool.execute("call-6", {
      action: "read",
      channel: id,
    });
    expect(confirm.content[0].text).toContain("reply by display name");
  });

  it("reports ambiguous display names instead of guessing", async () => {
    await createChannel(channelsDir, {
      id: "team-a",
      name: "工作群",
      members: ["alice", "bob"],
    } as any);
    await createChannel(channelsDir, {
      id: "team-b",
      name: "工作群",
      members: ["alice", "charlie"],
    } as any);

    const tool = createChannelTool({
      channelsDir,
      agentsDir,
      agentId: "alice",
      listAgents: () => [],
      isEnabled: () => true,
    } as any);

    const result = await tool.execute("call-7", {
      action: "read",
      channel: "工作群",
    });

    expect(result.details).toMatchObject({
      action: "read",
      error: "ambiguous channel name",
      matches: ["ch_team-a", "ch_team-b"],
    });
    expect(result.content[0].text).toContain("工作群");
    expect(result.content[0].text).toContain("ch_team-a");
    expect(result.content[0].text).toContain("ch_team-b");
  });

  it("classifies list/read as read while preserving stable reviewer targets for post/create", async () => {
    const { id } = await createChannel(channelsDir, {
      id: "team",
      name: "工作群",
      members: ["alice", "bob"],
    } as any);
    const tool = createChannelTool({
      channelsDir,
      agentsDir,
      agentId: "alice",
      listAgents: () => [],
      isEnabled: () => true,
    } as any);

    const list = resolveToolInvocationPermission(tool, { action: "list" });
    const read = resolveToolInvocationPermission(tool, {
      action: "read",
      channel: "工作群",
    });
    const post = resolveToolInvocationPermission(tool, {
      action: "post",
      channel: "工作群",
      content: "hello",
    });
    const createFirst = resolveToolInvocationPermission(tool, {
      action: "create",
      name: "New Team",
      members: ["charlie", "bob"],
    });
    const createReordered = resolveToolInvocationPermission(tool, {
      action: "create",
      name: "New Team",
      members: ["bob", "charlie"],
    });

    expect(list).toMatchObject({
      ok: true,
      descriptor: {
        action: "list",
        kind: "read",
        capability: "channel.list",
      },
    });
    expect(read).toMatchObject({
      ok: true,
      descriptor: {
        action: "read",
        kind: "read",
        capability: "channel.read",
        target: { type: "channel", id, label: "工作群" },
      },
    });
    expect(post).toMatchObject({
      ok: true,
      descriptor: {
        action: "post",
        kind: "review",
        capability: "channel.post",
        target: { type: "channel", id, label: "工作群" },
      },
    });
    expect(createFirst).toMatchObject({
      ok: true,
      descriptor: {
        action: "create",
        kind: "review",
        capability: "channel.create",
        target: { type: "channel_draft", label: "New Team" },
      },
    });
    expect(createFirst.ok && createFirst.source === "descriptor" ? createFirst.targetKey : null)
      .toBe(createReordered.ok && createReordered.source === "descriptor" ? createReordered.targetKey : null);
  });
});
