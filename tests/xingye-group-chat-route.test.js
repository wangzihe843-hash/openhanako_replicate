import fs from "fs";
import os from "os";
import path from "path";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createChannel, removeChannelMember, deleteChannel, addChannelMember } from "../lib/channels/channel-store.js";
import * as channelStore from "../lib/channels/channel-store.js";

async function buildTestApp() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hana-xy-group-chat-"));
  const agentsDir = path.join(tempRoot, "agents");
  const channelsDir = path.join(tempRoot, "channels");
  fs.mkdirSync(path.join(agentsDir, "agent-a"), { recursive: true });
  fs.mkdirSync(path.join(agentsDir, "agent-b"), { recursive: true });
  fs.mkdirSync(channelsDir, { recursive: true });

  const engine = {
    agentsDir,
    channelsDir,
    userName: "liyu",
    resolveUtilityConfig: () => null,
    resolveModelWithCredentials: () => null,
    getAgent: (id) =>
      ({
        "agent-a": { id: "agent-a", name: "Linwu", agentDir: path.join(agentsDir, "agent-a") },
        "agent-b": { id: "agent-b", name: "Hanako", agentDir: path.join(agentsDir, "agent-b") },
      })[id] || null,
    listAgents: () => [
      { id: "agent-a", name: "Linwu" },
      { id: "agent-b", name: "Hanako" },
    ],
  };

  const { createXingyeRoute } = await import("../server/routes/xingye.js");
  const app = new Hono();
  let requestSignal;
  app.use('*', async (c, next) => {
    requestSignal = c.req.raw.signal;
    await next();
  });
  app.route("/api", createXingyeRoute(engine));
  return { app, tempRoot, channelsDir, getRequestSignal: () => requestSignal };
}

describe("xingye group-chat post-as-agent route", () => {
  it.each(["member-removal", "deletion", "cancellation"])("rejects a queued agent post after %s", async (scenario) => {
    const { app, tempRoot, channelsDir, getRequestSignal } = await buildTestApp();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let entered;
    const held = new Promise((resolve) => { entered = resolve; });
    let checked;
    const prechecked = new Promise((resolve) => { checked = resolve; });
    const controller = new AbortController();
    let appendSignal;
    let lockedAbortState;
    let signalObserved;
    const observed = new Promise((resolve) => { signalObserved = resolve; });
    const append = channelStore.appendMessage;
    vi.spyOn(channelStore, 'appendMessage').mockImplementation((file, sender, text, options = {}) => {
      appendSignal = options.signal;
      signalObserved();
      // Delegate the real append. canWrite is evaluated under its real lock;
      // this records state without releasing, rejecting, or changing the write.
      return append(file, sender, text, {
        ...options,
        canWrite: () => {
          lockedAbortState = appendSignal?.aborted;
          return options.canWrite ? options.canWrite() : true;
        },
      });
    });
    let mutation;
    let response;
    try {
      await createChannel(channelsDir, { id: "crew", name: "Crew", members: ["agent-a", "agent-b"] });
      const file = path.join(channelsDir, "ch_crew.md");
      const operation = scenario === "deletion" ? "unlink" : "rename";
      const original = fs.promises[operation].bind(fs.promises);
      vi.spyOn(fs.promises, operation).mockImplementation(async (...args) => {
        if ((scenario === "deletion" ? args[0] : args[1]) === file) { entered(); await gate; }
        return original(...args);
      });
      mutation = scenario === "deletion" ? deleteChannel(file)
        : scenario === "member-removal" ? removeChannelMember(file, "agent-a") : addChannelMember(file, "agent-c");
      await held;
      const read = fs.readFileSync.bind(fs);
      vi.spyOn(fs, "readFileSync").mockImplementation((target, ...args) => {
        const result = read(target, ...args);
        if (target === file) checked();
        return result;
      });
      response = app.request("/api/xingye/group-chat/post-as-agent", {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
        body: JSON.stringify({ channelId: "ch_crew", agentId: "agent-a", body: "forbidden queued post" }),
      });
      await prechecked;
      await observed;
      if (scenario === "cancellation") {
        expect(appendSignal, 'route must forward the actual Hono Request signal').toBe(getRequestSignal());
        expect(appendSignal?.aborted, 'signal starts active while append is queued').toBe(false);
        controller.abort();
        expect(getRequestSignal()?.aborted, 'abort reaches Hono Request synchronously before lock release').toBe(true);
        expect(appendSignal?.aborted, 'queued append observes the same aborted signal').toBe(true);
      }
      release();
      await mutation;
      const res = await response;
      expect(res.status).toBe(scenario === "deletion" ? 404 : scenario === "member-removal" ? 403 : 409);
      if (scenario === "cancellation") {
        expect(lockedAbortState, 'aborted signal rejects before the canWrite callback or file open').toBeUndefined();
      }
      expect((await res.json()).ok).toBe(false);
      if (scenario === "deletion") expect(fs.existsSync(file)).toBe(false);
      else expect(fs.readFileSync(file, "utf8")).not.toContain("forbidden queued post");
    } finally {
      release();
      await Promise.allSettled([mutation, response]);
      vi.restoreAllMocks();
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("writes a message as the requested agent into an existing channel", async () => {
    const { app, tempRoot, channelsDir } = await buildTestApp();
    try {
      await createChannel(channelsDir, {
        id: "crew",
        name: "Crew",
        members: ["agent-a", "agent-b"],
        intro: "channel intro",
      });

      const res = await app.request("/api/xingye/group-chat/post-as-agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channelId: "ch_crew",
          agentId: "agent-a",
          body: "在的，我在群里。",
        }),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(typeof data.timestamp).toBe("string");
      expect(data.channelId).toBe("ch_crew");
      expect(data.agentId).toBe("agent-a");

      const channelFile = path.join(channelsDir, "ch_crew.md");
      const content = fs.readFileSync(channelFile, "utf-8");
      expect(content).toContain("### agent-a |");
      expect(content).toContain("在的，我在群里。");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects when the agent is not a member of the channel", async () => {
    const { app, tempRoot, channelsDir } = await buildTestApp();
    try {
      await createChannel(channelsDir, {
        id: "crew",
        name: "Crew",
        members: ["agent-b", "agent-c"],
        intro: "intro",
      });

      const res = await app.request("/api/xingye/group-chat/post-as-agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channelId: "ch_crew",
          agentId: "agent-a",
          body: "Hi",
        }),
      });
      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.error).toMatch(/member/i);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects missing body, channelId, or agentId", async () => {
    const { app, tempRoot } = await buildTestApp();
    try {
      const missingBody = await app.request("/api/xingye/group-chat/post-as-agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channelId: "ch_crew", agentId: "agent-a", body: "   " }),
      });
      expect(missingBody.status).toBe(400);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects when the channel does not exist", async () => {
    const { app, tempRoot } = await buildTestApp();
    try {
      const res = await app.request("/api/xingye/group-chat/post-as-agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channelId: "ch_does_not_exist",
          agentId: "agent-a",
          body: "Hi",
        }),
      });
      expect(res.status).toBe(404);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects invalid channel id that tries to escape channelsDir", async () => {
    const { app, tempRoot } = await buildTestApp();
    try {
      const res = await app.request("/api/xingye/group-chat/post-as-agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channelId: "../etc/passwd",
          agentId: "agent-a",
          body: "Hi",
        }),
      });
      expect([400, 404]).toContain(res.status);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
