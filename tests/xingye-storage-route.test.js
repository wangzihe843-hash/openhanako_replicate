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

  it("writeJson lore/entries.json syncs always stable lore into lore-memory.md", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hana-xingye-stor-"));
    try {
      const agentsDir = path.join(tempRoot, "agents");
      fs.mkdirSync(path.join(agentsDir, "agent-a"), { recursive: true });
      const agents = new Map([["agent-a", { id: "agent-a", name: "A" }]]);
      const engine = {
        agentsDir,
        /** Intentionally wrong: route must derive hanakoHome from agentsDir only. */
        hanakoHome: path.join(tempRoot, "wrong-hanako-home"),
        getAgent: (id) => agents.get(id) || null,
      };
      expect("hanakoHome" in engine).toBe(true);
      expect("agentsHome" in engine).toBe(false);

      const { createXingyeStorageRoute } = await import("../server/routes/xingye-storage.js");
      const { readXingyeStableLoreMemoryForPromptSync } = await import("../shared/xingye-lore-memory-file.js");
      const app = new Hono();
      app.route("/api", createXingyeStorageRoute(engine));

      const stableEntry = {
        id: "lore-bg-1",
        agentId: "agent-a",
        title: "Origin",
        content: "Stable summary for core prompt.",
        category: "background",
        insertionMode: "always",
        enabled: true,
        visibility: "canonical",
        updatedAt: "2026-01-02T00:00:00.000Z",
        priority: 10,
      };

      const writeA = await app.request("/api/xingye/storage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "writeJson",
          agentId: "agent-a",
          relativePath: "lore/entries.json",
          data: { "lore-bg-1": stableEntry },
        }),
      });
      expect(writeA.status).toBe(200);

      const wrongLoreMemory = path.join(tempRoot, "wrong-hanako-home", "agents", "agent-a", "xingye", "lore-memory.md");
      expect(fs.existsSync(wrongLoreMemory)).toBe(false);

      const loreMemoryPath = path.join(agentsDir, "agent-a", "xingye", "lore-memory.md");
      expect(fs.existsSync(loreMemoryPath)).toBe(true);
      const md = fs.readFileSync(loreMemoryPath, "utf8");
      expect(md).toContain("<!-- xingye-lore:id=lore-bg-1");
      expect(md).toContain("Stable summary for core prompt.");

      const hanakoHome = path.dirname(agentsDir);
      const promptSlice = readXingyeStableLoreMemoryForPromptSync({
        hanakoHome,
        agentId: "agent-a",
        maxChars: 4000,
      }).trim();
      expect(promptSlice.length).toBeGreaterThan(0);
      expect(promptSlice).toContain("Stable summary for core prompt.");

      const keywordOnly = {
        id: "lore-kw-1",
        agentId: "agent-a",
        title: "Side note",
        content: "Keyword only body.",
        category: "location",
        keywords: ["observatory"],
        insertionMode: "keyword",
        enabled: true,
        visibility: "canonical",
        updatedAt: "2026-01-03T00:00:00.000Z",
        priority: 5,
      };

      const writeKw = await app.request("/api/xingye/storage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "writeJson",
          agentId: "agent-a",
          relativePath: "lore\\entries.json",
          data: { "lore-kw-1": keywordOnly },
        }),
      });
      expect(writeKw.status).toBe(200);

      const mdAfter = fs.readFileSync(loreMemoryPath, "utf8");
      expect(mdAfter).not.toContain("<!-- xingye-lore:id=lore-bg-1");
      expect(mdAfter).not.toContain("Stable summary for core prompt.");

      const promptAfter = readXingyeStableLoreMemoryForPromptSync({
        hanakoHome,
        agentId: "agent-a",
        maxChars: 4000,
      }).trim();
      expect(promptAfter).toBe("");
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

  it("deleteJsonlRecord removes one JSONL row by key without reordering the rest", async () => {
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
          relativePath: "secret-space/draft_reply.jsonl",
          data: { key: "k1", id: "k1", body: "a" },
        }),
      });
      await app.request("/api/xingye/storage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "appendJsonl",
          agentId: "agent-a",
          relativePath: "secret-space/draft_reply.jsonl",
          data: { key: "k2", id: "k2", body: "b" },
        }),
      });

      const miss = await app.request("/api/xingye/storage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "deleteJsonlRecord",
          agentId: "agent-a",
          relativePath: "secret-space/draft_reply.jsonl",
          recordId: "nope",
        }),
      });
      expect(miss.status).toBe(200);
      expect(await miss.json()).toMatchObject({ ok: true, deleted: false });

      const abs = path.join(agentsDir, "agent-a", "xingye", "secret-space", "draft_reply.jsonl");
      const before = fs.readFileSync(abs, "utf8");

      const hit = await app.request("/api/xingye/storage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "deleteJsonlRecord",
          agentId: "agent-a",
          relativePath: "secret-space/draft_reply.jsonl",
          recordId: "k1",
        }),
      });
      expect(hit.status).toBe(200);
      expect(await hit.json()).toMatchObject({ ok: true, deleted: true });

      const list = await app.request("/api/xingye/storage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "listJsonl",
          agentId: "agent-a",
          relativePath: "secret-space/draft_reply.jsonl",
        }),
      });
      const listJson = await list.json();
      expect(listJson.records).toEqual([{ key: "k2", id: "k2", body: "b" }]);

      const after = fs.readFileSync(abs, "utf8");
      expect(after.trim()).toBe(JSON.stringify({ key: "k2", id: "k2", body: "b" }));
      expect(before.split("\n").filter(Boolean).length).toBe(2);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("writeJsonl replaces one app entries file under the selected agent only", async () => {
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

      const writeA = await app.request("/api/xingye/storage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "writeJsonl",
          agentId: "agent-a",
          relativePath: "apps/divination/entries.jsonl",
          records: [{ id: "entry-2", title: "second" }],
        }),
      });
      expect(writeA.status).toBe(200);

      const listA = await app.request("/api/xingye/storage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "listJsonl",
          agentId: "agent-a",
          relativePath: "apps/divination/entries.jsonl",
        }),
      });
      expect(await listA.json()).toMatchObject({ ok: true, records: [{ id: "entry-2", title: "second" }] });

      const listB = await app.request("/api/xingye/storage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "listJsonl",
          agentId: "agent-b",
          relativePath: "apps/divination/entries.jsonl",
        }),
      });
      expect(await listB.json()).toMatchObject({ ok: true, records: [] });

      const abs = path.join(agentsDir, "agent-a", "xingye", "apps", "divination", "entries.jsonl");
      expect(fs.existsSync(abs)).toBe(true);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("deleteJsonlRecord matches numeric ids and synthetic secret-space keys like draft_reply-1", async () => {
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
          relativePath: "secret-space/draft_reply.jsonl",
          data: { id: 9001, body: "num-id-body", summary: "num-id-sum", kind: "draft_reply" },
        }),
      });

      const delNum = await app.request("/api/xingye/storage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "deleteJsonlRecord",
          agentId: "agent-a",
          relativePath: "secret-space/draft_reply.jsonl",
          recordId: "9001",
        }),
      });
      expect(delNum.status).toBe(200);
      expect(await delNum.json()).toMatchObject({ ok: true, deleted: true });

      await app.request("/api/xingye/storage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "appendJsonl",
          agentId: "agent-a",
          relativePath: "secret-space/draft_reply.jsonl",
          data: { body: "anon-a", summary: "sa", kind: "draft_reply" },
        }),
      });
      await app.request("/api/xingye/storage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "appendJsonl",
          agentId: "agent-a",
          relativePath: "secret-space/draft_reply.jsonl",
          data: { body: "anon-b", summary: "sb", kind: "draft_reply" },
        }),
      });

      const delSynth = await app.request("/api/xingye/storage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "deleteJsonlRecord",
          agentId: "agent-a",
          relativePath: "secret-space/draft_reply.jsonl",
          recordId: "draft_reply-1",
        }),
      });
      expect(delSynth.status).toBe(200);
      expect(await delSynth.json()).toMatchObject({ ok: true, deleted: true });

      const list = await app.request("/api/xingye/storage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "listJsonl",
          agentId: "agent-a",
          relativePath: "secret-space/draft_reply.jsonl",
        }),
      });
      const listJson = await list.json();
      expect(listJson.records).toEqual([
        { body: "anon-a", summary: "sa", kind: "draft_reply" },
      ]);
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

  it("allows the reserved __user__ scope even though it is not a registered agent", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hana-xingye-stor-"));
    try {
      const agentsDir = path.join(tempRoot, "agents");
      fs.mkdirSync(agentsDir, { recursive: true });
      // engine 里没有任何角色 —— __user__（用户本人）必须仍能读写，否则用户发不了朋友圈。
      const engine = {
        agentsDir,
        getAgent: () => null,
      };
      const { createXingyeStorageRoute } = await import("../server/routes/xingye-storage.js");
      const app = new Hono();
      app.route("/api", createXingyeStorageRoute(engine));

      const append = await app.request("/api/xingye/storage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "appendJsonl",
          agentId: "__user__",
          relativePath: "apps/moments/posts.jsonl",
          data: { id: "moment-1", content: "用户发的第一条朋友圈" },
        }),
      });
      expect(append.status).toBe(200);

      const list = await app.request("/api/xingye/storage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "listJsonl",
          agentId: "__user__",
          relativePath: "apps/moments/posts.jsonl",
        }),
      });
      expect(await list.json()).toMatchObject({
        ok: true,
        records: [{ id: "moment-1", content: "用户发的第一条朋友圈" }],
      });

      const abs = path.join(agentsDir, "__user__", "xingye", "apps", "moments", "posts.jsonl");
      expect(fs.existsSync(abs)).toBe(true);

      // 真正不存在的角色仍然 404 —— 豁免只针对保留的 __user__。
      const unknown = await app.request("/api/xingye/storage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "listJsonl",
          agentId: "ghost-agent",
          relativePath: "apps/moments/posts.jsonl",
        }),
      });
      expect(unknown.status).toBe(404);
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

  it("appendEventLog persists events through the lock-wrapped append helper", async () => {
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

      const append = async (payload) =>
        app.request("/api/xingye/storage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "appendEventLog",
            agentId: "agent-a",
            relativePath: "events/log.json",
            ...payload,
          }),
        });

      const first = await append({
        event: {
          type: "moment.created",
          source: "renderer",
          createdAt: "2026-01-01T00:00:00.000Z",
          payload: { id: "older" },
        },
      });
      expect(first.status).toBe(200);
      const firstJson = await first.json();
      expect(firstJson.ok).toBe(true);
      expect(firstJson.event).toMatchObject({
        agentId: "agent-a",
        type: "moment.created",
        payload: { id: "older" },
      });
      expect(typeof firstJson.event.id).toBe("string");

      const second = await append({
        event: {
          type: "moment.draft_proposed",
          source: "renderer",
          createdAt: "2026-01-02T00:00:00.000Z",
          payload: { id: "newer" },
        },
      });
      expect(second.status).toBe(200);

      // 两条都在；落盘文件是 events.js 的 {version, events, dedupeKeys} schema 且按 createdAt 升序。
      const abs = path.join(agentsDir, "agent-a", "xingye", "events", "log.json");
      const onDisk = JSON.parse(fs.readFileSync(abs, "utf8"));
      expect(onDisk.version).toBe(1);
      expect(onDisk.events.map((e) => e.payload.id)).toEqual(["older", "newer"]);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("appendEventLog serializes with server-originated appends so no event is dropped", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hana-xingye-stor-"));
    try {
      const agentsDir = path.join(tempRoot, "agents");
      const targetAgentDir = path.join(agentsDir, "agent-a");
      fs.mkdirSync(targetAgentDir, { recursive: true });
      const engine = {
        agentsDir,
        getAgent: (id) => (id === "agent-a" ? { id, name: "A" } : null),
      };
      const { createXingyeStorageRoute } = await import("../server/routes/xingye-storage.js");
      // 服务端进程内 append（pinned 工具 / heartbeat consumer 用的那条路径）。
      const { appendXingyeEvent } = await import("../lib/xingye/events.js");
      const app = new Hono();
      app.route("/api", createXingyeStorageRoute(engine));

      const routeAppend = (payload) =>
        app.request("/api/xingye/storage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "appendEventLog",
            agentId: "agent-a",
            relativePath: "events/log.json",
            event: payload,
          }),
        });

      // 渲染端 append 与服务端 append 同时打出去；两者共用 lib/xingye/events.js 的 per-agent 锁，
      // 串行化后两条都应保留——这正是裸 readJson+writeJson 会丢事件的场景。
      await Promise.all([
        routeAppend({
          type: "moment.draft_proposed",
          source: "renderer",
          createdAt: "2026-01-01T00:00:01.000Z",
          payload: { id: "renderer-evt" },
        }),
        appendXingyeEvent({
          agentDir: targetAgentDir,
          agentId: "agent-a",
          input: {
            type: "pinned_memory.changed",
            source: "server",
            createdAt: "2026-01-01T00:00:02.000Z",
            payload: { id: "server-evt" },
          },
        }),
      ]);

      const abs = path.join(targetAgentDir, "xingye", "events", "log.json");
      const onDisk = JSON.parse(fs.readFileSync(abs, "utf8"));
      const ids = onDisk.events.map((e) => e.payload.id).sort();
      expect(ids).toEqual(["renderer-evt", "server-evt"]);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("appendEventLog dedupeKey returns the existing event instead of appending twice", async () => {
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

      const append = () =>
        app.request("/api/xingye/storage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "appendEventLog",
            agentId: "agent-a",
            relativePath: "events/log.json",
            dedupeKey: "dk-1",
            event: {
              type: "secret_space.record_appended",
              source: "renderer",
              subjectId: "dream-1",
              payload: { recordId: "dream-1" },
            },
          }),
        });

      const firstJson = await (await append()).json();
      const secondJson = await (await append()).json();
      expect(secondJson.event.id).toBe(firstJson.event.id);

      const abs = path.join(agentsDir, "agent-a", "xingye", "events", "log.json");
      const onDisk = JSON.parse(fs.readFileSync(abs, "utf8"));
      expect(onDisk.events).toHaveLength(1);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("markEventConsumed stamps only the named consumer under the lock", async () => {
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

      const appended = await (await app.request("/api/xingye/storage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "appendEventLog",
          agentId: "agent-a",
          relativePath: "events/log.json",
          event: { type: "moment.created", source: "renderer", payload: { id: "m1" } },
        }),
      })).json();

      const mark = await app.request("/api/xingye/storage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "markEventConsumed",
          agentId: "agent-a",
          relativePath: "events/log.json",
          eventId: appended.event.id,
          consumer: "heartbeat",
        }),
      });
      expect(mark.status).toBe(200);
      const markJson = await mark.json();
      expect(Object.keys(markJson.event.consumedBy)).toEqual(["heartbeat"]);

      const abs = path.join(agentsDir, "agent-a", "xingye", "events", "log.json");
      const onDisk = JSON.parse(fs.readFileSync(abs, "utf8"));
      expect(onDisk.events[0].consumedBy.heartbeat).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(onDisk.events[0].consumedBy.moments).toBeUndefined();
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("appendEventLog and markEventConsumed reject non event-log paths and bad input", async () => {
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

      const wrongPath = await app.request("/api/xingye/storage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "appendEventLog",
          agentId: "agent-a",
          relativePath: "moments/posts.json",
          event: { type: "moment.created", source: "renderer", payload: {} },
        }),
      });
      expect(wrongPath.status).toBe(400);

      const noEvent = await app.request("/api/xingye/storage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "appendEventLog",
          agentId: "agent-a",
          relativePath: "events/log.json",
        }),
      });
      expect(noEvent.status).toBe(400);

      const badConsumer = await app.request("/api/xingye/storage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "markEventConsumed",
          agentId: "agent-a",
          relativePath: "events/log.json",
          eventId: "x",
        }),
      });
      expect(badConsumer.status).toBe(400);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
