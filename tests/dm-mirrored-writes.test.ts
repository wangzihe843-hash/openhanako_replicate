import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appendDmMessage, getRecentMessages } from "../lib/channels/channel-store.ts";
import { createDmTool } from "../lib/tools/dm-tool.ts";
import { readPeerState } from "../lib/desk/social-awareness.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-dm-mirrors-"));
  roots.push(root);
  const agentsDir = path.join(root, "agents");
  const file = (owner: string, peer: string) => path.join(agentsDir, owner, "dm", `${peer}.md`);
  const messages = (owner: string, peer: string) => getRecentMessages(file(owner, peer), 30, undefined);
  const listAgents = () => [
    { id: "alice", name: "Alice" }, { id: "bob", name: "Bob" }, { id: "carol", name: "Carol" },
  ];
  return { agentsDir, file, messages, listAgents };
}

function defer() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

function pauseFirstAppend(targetPath: string) {
  const paused = defer();
  const release = defer();
  const append = fs.promises.appendFile.bind(fs.promises);
  let once = false;
  vi.spyOn(fs.promises, "appendFile").mockImplementation(async (filePath, data, options) => {
    await append(filePath, data, options);
    if (!once && filePath === targetPath) {
      once = true;
      paused.resolve();
      await release.promise;
    }
  });
  return { paused, release };
}

describe("mirrored DM writes", () => {
  it("keeps simultaneous opposite sends in the same order with identical timestamps in both histories", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-07T00:00:00.000Z"));
    const fixture = setup();
    const delivered: any[] = [];
    const onDmSent = (fromId: string, toId: string) => {
      delivered.push({
        fromId, toId,
        sender: fixture.messages(fromId, toId),
        recipient: fixture.messages(toId, fromId),
      });
    };
    const alice = createDmTool({ ...fixture, agentId: "alice", onDmSent });
    const bob = createDmTool({ ...fixture, agentId: "bob", onDmSent });
    const { paused, release } = pauseFirstAppend(fixture.file("alice", "bob"));
    const first = alice.execute("a", { to: "bob", message: "A opens" });
    await paused.promise;
    vi.setSystemTime(new Date("2026-09-07T00:00:02.000Z"));
    const opposite = bob.execute("b", { to: "alice", message: "B opens" });
    release.resolve();
    await Promise.all([first, opposite]);

    const fromAlice = fixture.messages("alice", "bob");
    expect(fromAlice.map((message) => message.body)).toEqual(["A opens", "B opens"]);
    expect(fixture.messages("bob", "alice")).toEqual(fromAlice);
    expect(delivered).toHaveLength(2);
    for (const delivery of delivered) expect(delivery.recipient).toEqual(delivery.sender);
    expect(readPeerState(path.join(fixture.agentsDir, "alice")).peers.bob.lastOutboundDmTurn).toBe(0);
    expect(readPeerState(path.join(fixture.agentsDir, "bob")).peers.alice.lastOutboundDmTurn).toBe(0);
  });

  it("uses the same write ordering for a passive reply racing with a new proactive send", async () => {
    const fixture = setup();
    const alice = createDmTool({ ...fixture, agentId: "alice" });
    await alice.execute("open", { to: "bob", message: "Question" });
    const { paused, release } = pauseFirstAppend(fixture.file("bob", "alice"));
    const reply = appendDmMessage({
      agentsDir: fixture.agentsDir, fromId: "bob", toId: "alice", body: "Reply", createMissing: false,
    });
    await paused.promise;
    const next = alice.execute("next", { to: "bob", message: "Next question" });
    release.resolve();
    await Promise.all([reply, next]);
    expect(fixture.messages("alice", "bob").map((message) => message.body))
      .toEqual(["Question", "Reply", "Next question"]);
    expect(fixture.messages("bob", "alice")).toEqual(fixture.messages("alice", "bob"));
  });

  it("rechecks disabled sends and aborted replies after waiting for a mirror write", async () => {
    const fixture = setup();
    let enabled = true;
    const sent = vi.fn();
    const alice = createDmTool({ ...fixture, agentId: "alice", isEnabled: () => enabled, onDmSent: sent });
    const { paused, release } = pauseFirstAppend(fixture.file("alice", "bob"));
    const first = appendDmMessage({ agentsDir: fixture.agentsDir, fromId: "alice", toId: "bob", body: "Accepted" });
    await paused.promise;
    const queued = alice.execute("queued", { to: "bob", message: "Disabled before write" });
    const controller = new AbortController();
    const reply = appendDmMessage({
      agentsDir: fixture.agentsDir, fromId: "bob", toId: "alice", body: "Aborted reply",
      createMissing: false, canWrite: () => !controller.signal.aborted,
    });
    enabled = false;
    controller.abort();
    release.resolve();
    const [, result, replyResult] = await Promise.all([first, queued, reply]);
    expect(result.details).toMatchObject({ error: "phone disabled" });
    expect(replyResult).toBeNull();
    expect(sent).not.toHaveBeenCalled();
    expect(fixture.messages("alice", "bob").map((message) => message.body)).toEqual(["Accepted"]);
    expect(fixture.messages("bob", "alice")).toEqual(fixture.messages("alice", "bob"));
  });

  it("does not recreate removed conversations for replies and releases locks after a failed append", async () => {
    const fixture = setup();
    const message = { agentsDir: fixture.agentsDir, fromId: "alice", toId: "bob", body: "Hello" };
    expect(await appendDmMessage({ ...message, createMissing: false })).toBeNull();
    expect(fs.existsSync(fixture.agentsDir)).toBe(false);
    vi.spyOn(fs.promises, "appendFile").mockRejectedValueOnce(new Error("temporary disk failure"));
    await expect(appendDmMessage(message)).rejects.toThrow("temporary disk failure");
    await appendDmMessage(message);
    await new Promise((resolve) => setImmediate(resolve));
    expect(fixture.messages("alice", "bob").map((entry) => entry.body)).toEqual(["Hello"]);
    expect(fixture.messages("bob", "alice")).toEqual(fixture.messages("alice", "bob"));
  });

  it("lets a different DM pair finish while another pair is writing", async () => {
    const fixture = setup();
    const { paused, release } = pauseFirstAppend(fixture.file("alice", "bob"));
    const first = appendDmMessage({ agentsDir: fixture.agentsDir, fromId: "alice", toId: "bob", body: "Blocked" });
    await paused.promise;
    try {
      await appendDmMessage({ agentsDir: fixture.agentsDir, fromId: "alice", toId: "carol", body: "Independent" });
      expect(fixture.messages("carol", "alice")[0].body).toBe("Independent");
    } finally {
      release.resolve();
      await first;
    }
  });
});
