import fs from "fs";
import os from "os";
import path from "path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createChannel } from "../lib/channels/channel-store.js";

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
  app.route("/api", createXingyeRoute(engine));
  return { app, tempRoot, channelsDir };
}

describe("xingye group-chat post-as-agent route", () => {
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
