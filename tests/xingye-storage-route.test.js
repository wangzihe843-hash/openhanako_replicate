import fs from "fs";
import os from "os";
import path from "path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

describe("xingye storage route", () => {
  it("read write list stays under workspace .xingye", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hana-xingye-stor-"));
    try {
      const workspace = path.join(tempRoot, "ws");
      fs.mkdirSync(workspace, { recursive: true });

      const agent = { id: "agent-a", name: "A" };
      const engine = {
        currentAgentId: "agent-a",
        getAgent: (id) => (id === "agent-a" ? agent : null),
        getHomeCwd: (id) => (id === "agent-a" ? workspace : null),
      };

      const { createXingyeStorageRoute } = await import("../server/routes/xingye-storage.js");
      const app = new Hono();
      app.route("/api", createXingyeStorageRoute(engine));

      const write = await app.request("/api/xingye/storage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "write",
          agentId: "agent-a",
          relativePath: "v1/data/hello.txt",
          content: "hello-xingye",
        }),
      });
      expect(write.status).toBe(200);

      const read = await app.request("/api/xingye/storage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "read",
          agentId: "agent-a",
          relativePath: "v1/data/hello.txt",
        }),
      });
      expect(read.status).toBe(200);
      const readJson = await read.json();
      expect(readJson.encoding).toBe("utf8");
      expect(readJson.content).toBe("hello-xingye");

      const abs = path.join(workspace, ".xingye", "v1", "data", "hello.txt");
      expect(fs.existsSync(abs)).toBe(true);

      const list = await app.request("/api/xingye/storage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "list",
          agentId: "agent-a",
          relativePath: "v1/data",
        }),
      });
      expect(list.status).toBe(200);
      const listJson = await list.json();
      expect(listJson.entries.some((e) => e.name === "hello.txt")).toBe(true);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects path traversal in relativePath", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hana-xingye-stor-"));
    try {
      const workspace = path.join(tempRoot, "ws");
      fs.mkdirSync(workspace, { recursive: true });
      const agent = { id: "agent-a", name: "A" };
      const engine = {
        currentAgentId: "agent-a",
        getAgent: (id) => (id === "agent-a" ? agent : null),
        getHomeCwd: () => workspace,
      };
      const { createXingyeStorageRoute } = await import("../server/routes/xingye-storage.js");
      const app = new Hono();
      app.route("/api", createXingyeStorageRoute(engine));

      const res = await app.request("/api/xingye/storage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "write",
          agentId: "agent-a",
          relativePath: "../outside.txt",
          content: "x",
        }),
      });
      expect(res.status).toBe(400);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
