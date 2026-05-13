import fs from "fs";
import os from "os";
import path from "path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

describe("xingye storage route", () => {
  it("read write list stays under agent xingye root", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hana-xingye-stor-"));
    try {
      const agentsDir = path.join(tempRoot, "agents");
      fs.mkdirSync(path.join(agentsDir, "agent-a"), { recursive: true });

      const agent = { id: "agent-a", name: "A" };
      const engine = {
        agentsDir,
        currentAgentId: "agent-a",
        getAgent: (id) => (id === "agent-a" ? agent : null),
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
          relativePath: "lore/hello.txt",
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
          relativePath: "lore/hello.txt",
        }),
      });
      expect(read.status).toBe(200);
      const readJson = await read.json();
      expect(readJson.encoding).toBe("utf8");
      expect(readJson.content).toBe("hello-xingye");

      const abs = path.join(agentsDir, "agent-a", "xingye", "lore", "hello.txt");
      expect(fs.existsSync(abs)).toBe(true);

      const list = await app.request("/api/xingye/storage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "list",
          agentId: "agent-a",
          relativePath: "lore",
        }),
      });
      expect(list.status).toBe(200);
      const listJson = await list.json();
      expect(listJson.entries.some((e) => e.name === "hello.txt")).toBe(true);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("keeps agent storage isolated and independent from workspace", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hana-xingye-stor-"));
    try {
      const agentsDir = path.join(tempRoot, "agents");
      fs.mkdirSync(path.join(agentsDir, "agent-a"), { recursive: true });
      fs.mkdirSync(path.join(agentsDir, "agent-b"), { recursive: true });
      const agents = new Map([
        ["agent-a", { id: "agent-a", name: "A" }],
        ["agent-b", { id: "agent-b", name: "B" }],
      ]);
      let workspace = path.join(tempRoot, "ws-1");
      const engine = {
        agentsDir,
        currentAgentId: "agent-a",
        getAgent: (id) => agents.get(id) || null,
        getHomeCwd: () => workspace,
      };
      const { createXingyeStorageRoute } = await import("../server/routes/xingye-storage.js");
      const app = new Hono();
      app.route("/api", createXingyeStorageRoute(engine));

      const writeA = await app.request("/api/xingye/storage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "writeJson",
          agentId: "agent-a",
          relativePath: "moments/posts.json",
          data: { postA: { content: "agent A moment" } },
        }),
      });
      expect(writeA.status).toBe(200);

      workspace = path.join(tempRoot, "ws-2");

      const readA = await app.request("/api/xingye/storage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "readJson",
          agentId: "agent-a",
          relativePath: "moments/posts.json",
        }),
      });
      expect(await readA.json()).toMatchObject({ ok: true, data: { postA: { content: "agent A moment" } } });

      const readB = await app.request("/api/xingye/storage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "readJson",
          agentId: "agent-b",
          relativePath: "moments/posts.json",
        }),
      });
      expect(await readB.json()).toMatchObject({ ok: true, data: null, missing: true });
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("smoke: phone/sms-threads.json writeJson readJson isolation and disk path", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hana-xingye-stor-"));
    try {
      const agentsDir = path.join(tempRoot, "agents");
      fs.mkdirSync(path.join(agentsDir, "agent-a"), { recursive: true });
      fs.mkdirSync(path.join(agentsDir, "agent-b"), { recursive: true });
      const agents = new Map([
        ["agent-a", { id: "agent-a", name: "A" }],
        ["agent-b", { id: "agent-b", name: "B" }],
      ]);
      const engine = {
        agentsDir,
        getAgent: (id) => agents.get(id) || null,
      };
      const { createXingyeStorageRoute } = await import("../server/routes/xingye-storage.js");
      const app = new Hono();
      app.route("/api", createXingyeStorageRoute(engine));

      const threadsPayload = {
        threads: {
          "thread-1": { peerId: "peer-1", lastSnippet: "hello" },
        },
      };

      const writeA = await app.request("/api/xingye/storage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "writeJson",
          agentId: "agent-a",
          relativePath: "phone/sms-threads.json",
          data: threadsPayload,
        }),
      });
      expect(writeA.status).toBe(200);

      const readA = await app.request("/api/xingye/storage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "readJson",
          agentId: "agent-a",
          relativePath: "phone/sms-threads.json",
        }),
      });
      expect(await readA.json()).toMatchObject({ ok: true, data: threadsPayload });

      const readB = await app.request("/api/xingye/storage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "readJson",
          agentId: "agent-b",
          relativePath: "phone/sms-threads.json",
        }),
      });
      expect(await readB.json()).toMatchObject({ ok: true, data: null, missing: true });

      const abs = path.join(agentsDir, "agent-a", "xingye", "phone", "sms-threads.json");
      expect(fs.existsSync(abs)).toBe(true);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("smoke: lore/entries.json missing then writeJson readJson isolation and disk path", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hana-xingye-stor-"));
    try {
      const agentsDir = path.join(tempRoot, "agents");
      fs.mkdirSync(path.join(agentsDir, "agent-a"), { recursive: true });
      fs.mkdirSync(path.join(agentsDir, "agent-b"), { recursive: true });
      const agents = new Map([
        ["agent-a", { id: "agent-a", name: "A" }],
        ["agent-b", { id: "agent-b", name: "B" }],
      ]);
      const engine = {
        agentsDir,
        getAgent: (id) => agents.get(id) || null,
      };
      const { createXingyeStorageRoute } = await import("../server/routes/xingye-storage.js");
      const app = new Hono();
      app.route("/api", createXingyeStorageRoute(engine));

      const readMissing = await app.request("/api/xingye/storage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "readJson",
          agentId: "agent-a",
          relativePath: "lore/entries.json",
        }),
      });
      expect(readMissing.status).toBe(200);
      expect(await readMissing.json()).toMatchObject({ ok: true, data: null, missing: true });

      const entriesPayload = {
        entries: {
          "entry-1": { title: "note", body: "minimal" },
        },
      };

      const writeA = await app.request("/api/xingye/storage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "writeJson",
          agentId: "agent-a",
          relativePath: "lore/entries.json",
          data: entriesPayload,
        }),
      });
      expect(writeA.status).toBe(200);

      const readA = await app.request("/api/xingye/storage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "readJson",
          agentId: "agent-a",
          relativePath: "lore/entries.json",
        }),
      });
      expect(await readA.json()).toMatchObject({ ok: true, data: entriesPayload });

      const readB = await app.request("/api/xingye/storage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "readJson",
          agentId: "agent-b",
          relativePath: "lore/entries.json",
        }),
      });
      expect(await readB.json()).toMatchObject({ ok: true, data: null, missing: true });

      const abs = path.join(agentsDir, "agent-a", "xingye", "lore", "entries.json");
      expect(fs.existsSync(abs)).toBe(true);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("supports jsonl append and list under agent scope", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hana-xingye-stor-"));
    try {
      const agentsDir = path.join(tempRoot, "agents");
      fs.mkdirSync(path.join(agentsDir, "agent-a"), { recursive: true });
      const engine = {
        agentsDir,
        getAgent: (id) => (id === "agent-a" ? { id, name: "A" } : null),
      };
      const { createXingyeStorageRoute } = await import("../server/routes/xingye-storage.js");
      const app = new Hono();
      app.route("/api", createXingyeStorageRoute(engine));

      await app.request("/api/xingye/storage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "appendJsonl",
          agentId: "agent-a",
          relativePath: "secret-space/dream.jsonl",
          data: { id: "dream-1" },
        }),
      });
      await fs.promises.appendFile(
        path.join(agentsDir, "agent-a", "xingye", "secret-space", "dream.jsonl"),
        "not-json\n",
      );
      await app.request("/api/xingye/storage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "appendJsonl",
          agentId: "agent-a",
          relativePath: "secret-space/dream.jsonl",
          data: { id: "dream-2" },
        }),
      });

      const list = await app.request("/api/xingye/storage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "listJsonl",
          agentId: "agent-a",
          relativePath: "secret-space/dream.jsonl",
        }),
      });
      expect(await list.json()).toMatchObject({ ok: true, records: [{ id: "dream-1" }, { id: "dream-2" }] });
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("returns an error for missing agentId or unknown agent", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hana-xingye-stor-"));
    try {
      const agentsDir = path.join(tempRoot, "agents");
      fs.mkdirSync(path.join(agentsDir, "agent-a"), { recursive: true });
      const engine = {
        agentsDir,
        getAgent: (id) => (id === "agent-a" ? { id, name: "A" } : null),
      };
      const { createXingyeStorageRoute } = await import("../server/routes/xingye-storage.js");
      const app = new Hono();
      app.route("/api", createXingyeStorageRoute(engine));

      const missing = await app.request("/api/xingye/storage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "readJson", relativePath: "profile.json" }),
      });
      expect(missing.status).toBe(400);

      const unknown = await app.request("/api/xingye/storage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "readJson", agentId: "missing", relativePath: "profile.json" }),
      });
      expect(unknown.status).toBe(404);

      const unsafe = await app.request("/api/xingye/storage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "readJson", agentId: "../agent-a", relativePath: "profile.json" }),
      });
      expect(unsafe.status).toBe(400);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("allows list at root but requires non-empty paths for read and write", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hana-xingye-stor-"));
    try {
      const agentsDir = path.join(tempRoot, "agents");
      fs.mkdirSync(path.join(agentsDir, "agent-a"), { recursive: true });
      const engine = {
        agentsDir,
        getAgent: (id) => (id === "agent-a" ? { id, name: "A" } : null),
      };
      const { createXingyeStorageRoute } = await import("../server/routes/xingye-storage.js");
      const app = new Hono();
      app.route("/api", createXingyeStorageRoute(engine));

      const listRoot = await app.request("/api/xingye/storage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "list", agentId: "agent-a", relativePath: "" }),
      });
      expect(listRoot.status).toBe(200);

      const readRoot = await app.request("/api/xingye/storage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "read", agentId: "agent-a", relativePath: "" }),
      });
      expect(readRoot.status).toBe(400);

      const writeRoot = await app.request("/api/xingye/storage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "write", agentId: "agent-a", relativePath: "", content: "x" }),
      });
      expect(writeRoot.status).toBe(400);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects path traversal in relativePath", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hana-xingye-stor-"));
    try {
      const agentsDir = path.join(tempRoot, "agents");
      fs.mkdirSync(path.join(agentsDir, "agent-a"), { recursive: true });
      const agent = { id: "agent-a", name: "A" };
      const engine = {
        agentsDir,
        currentAgentId: "agent-a",
        getAgent: (id) => (id === "agent-a" ? agent : null),
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

      const encoded = await app.request("/api/xingye/storage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "write",
          agentId: "agent-a",
          relativePath: "%2e%2e/outside.txt",
          content: "x",
        }),
      });
      expect(encoded.status).toBe(400);

      const doubleEncoded = await app.request("/api/xingye/storage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "write",
          agentId: "agent-a",
          relativePath: "%252e%252e/outside.txt",
          content: "x",
        }),
      });
      expect(doubleEncoded.status).toBe(400);

      const absolute = await app.request("/api/xingye/storage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "write",
          agentId: "agent-a",
          relativePath: path.join(tempRoot, "outside.txt"),
          content: "x",
        }),
      });
      expect(absolute.status).toBe(400);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects symlink escape from agent scope", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hana-xingye-stor-"));
    try {
      const agentsDir = path.join(tempRoot, "agents");
      const outside = path.join(tempRoot, "outside");
      const xingyeRoot = path.join(agentsDir, "agent-a", "xingye");
      fs.mkdirSync(xingyeRoot, { recursive: true });
      fs.mkdirSync(outside, { recursive: true });
      const linkPath = path.join(xingyeRoot, "linked-out");
      try {
        fs.symlinkSync(outside, linkPath, "junction");
      } catch (error) {
        if (error?.code === "EPERM" || error?.code === "EACCES") return;
        throw error;
      }
      const engine = {
        agentsDir,
        getAgent: (id) => (id === "agent-a" ? { id, name: "A" } : null),
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
          relativePath: "linked-out/escape.txt",
          content: "x",
        }),
      });
      expect(res.status).toBe(400);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
