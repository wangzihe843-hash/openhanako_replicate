import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { appendShoppingDraftServer } from "../lib/xingye/shopping-drafts.js";
import { createProposeDraftTool } from "../lib/tools/xingye-propose-draft-tool.js";

function mktemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hana-shopping-drafts-"));
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf-8")
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

let tempRoot;
let agentDir;

beforeEach(() => {
  tempRoot = mktemp();
  agentDir = path.join(tempRoot, "agents", "agent-a");
  fs.mkdirSync(agentDir, { recursive: true });
});

afterEach(() => {
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
});

describe("appendShoppingDraftServer", () => {
  it("writes a row to apps/shopping/drafts.jsonl with required fields", async () => {
    const draft = await appendShoppingDraftServer({
      agentDir,
      agentId: "agent-a",
      input: {
        itemName: "  《长安的荔枝》  ",
        status: "wanted",
        category: "书",
        imaginedPrice: "便宜但她最近不太敢花钱",
        reason: "她在旧书店摸了三次没买",
        content: "解放路那家旧书店还有两本。",
        tags: [" 小说 ", "", "想读"],
        source: "xingye-heartbeat-tool",
        sourceEventIds: [" e-1 ", "", "e-2"],
      },
    });
    expect(draft).toMatchObject({
      itemName: "《长安的荔枝》",
      status: "wanted",
      platformStyle: "generic",
      category: "书",
      tags: ["小说", "想读"],
      source: "xingye-heartbeat-tool",
      sourceEventIds: ["e-1", "e-2"],
    });
    const file = path.join(agentDir, "xingye", "apps", "shopping", "drafts.jsonl");
    const rows = readJsonl(file);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: draft.id, key: draft.id });
  });

  it("emits shopping.draft_proposed in xingye event log", async () => {
    const draft = await appendShoppingDraftServer({
      agentDir,
      agentId: "agent-a",
      input: {
        itemName: "灰色风衣",
        source: "xingye-heartbeat-tool",
      },
    });
    const log = readJson(path.join(agentDir, "xingye", "events", "log.json"));
    const proposed = log.events.find((e) => e.type === "shopping.draft_proposed");
    expect(proposed).toBeTruthy();
    expect(proposed.subjectId).toBe(draft.id);
    expect(proposed.payload.status).toBe("wanted");
  });

  it("falls back to status='wanted' and platformStyle='generic' for unknown values", async () => {
    const draft = await appendShoppingDraftServer({
      agentDir,
      agentId: "agent-a",
      input: {
        itemName: "X",
        status: "nonsense",
        platformStyle: "bogus",
        source: "s",
      },
    });
    expect(draft.status).toBe("wanted");
    expect(draft.platformStyle).toBe("generic");
  });

  it("does NOT write entries.jsonl", async () => {
    await appendShoppingDraftServer({
      agentDir, agentId: "agent-a",
      input: { itemName: "X", source: "xingye-heartbeat-tool" },
    });
    expect(fs.existsSync(path.join(agentDir, "xingye", "apps", "shopping", "entries.jsonl"))).toBe(false);
  });

  it("returns null on missing itemName, empty source, or invalid agentId", async () => {
    expect(await appendShoppingDraftServer({
      agentDir, agentId: "agent-a",
      input: { itemName: "  ", source: "s" },
    })).toBeNull();
    expect(await appendShoppingDraftServer({
      agentDir, agentId: "agent-a",
      input: { itemName: "X", source: "" },
    })).toBeNull();
    expect(await appendShoppingDraftServer({
      agentDir, agentId: "bad id!",
      input: { itemName: "X", source: "s" },
    })).toBeNull();
  });
});

describe("createProposeDraftTool · module=shopping", () => {
  it("dispatches shopping case and writes draft", async () => {
    const tool = createProposeDraftTool({ agentDir, agentId: "agent-a" });
    const res = await tool.execute("call-1", {
      module: "shopping",
      reason: "她摸了三次",
      shopping: {
        itemName: "《长安的荔枝》",
        status: "hesitating",
        category: "书",
        tags: ["小说"],
      },
    });
    expect(res.details.ok).toBe(true);
    expect(res.details.module).toBe("shopping");
    const rows = readJsonl(path.join(agentDir, "xingye", "apps", "shopping", "drafts.jsonl"));
    expect(rows).toHaveLength(1);
    expect(rows[0].itemName).toBe("《长安的荔枝》");
    expect(rows[0].status).toBe("hesitating");
  });

  it("rejects when itemName missing", async () => {
    const tool = createProposeDraftTool({ agentDir, agentId: "agent-a" });
    const res = await tool.execute("call-1", {
      module: "shopping",
      shopping: { itemName: "   ", status: "wanted" },
    });
    expect(res.details.ok).toBe(false);
    expect(res.details.module).toBe("shopping");
    expect(res.details.reason).toBe("empty_item_name");
    expect(fs.existsSync(path.join(agentDir, "xingye", "apps", "shopping", "drafts.jsonl"))).toBe(false);
  });

  it("rejects invalid status at dispatch (no silent coercion to wanted)", async () => {
    const tool = createProposeDraftTool({ agentDir, agentId: "agent-a" });
    const res = await tool.execute("call-1", {
      module: "shopping",
      shopping: { itemName: "灰色风衣", status: "nonsense" },
    });
    expect(res.details.ok).toBe(false);
    expect(res.details.module).toBe("shopping");
    expect(res.details.reason).toBe("invalid_status");
    expect(fs.existsSync(path.join(agentDir, "xingye", "apps", "shopping", "drafts.jsonl"))).toBe(false);
  });

  it("allows omitted status (legitimately falls back to wanted) but normalizes provided casing", async () => {
    const tool = createProposeDraftTool({ agentDir, agentId: "agent-a" });
    /** 缺省 status 是合法的，回退 'wanted'。 */
    const omitted = await tool.execute("call-omit", {
      module: "shopping",
      shopping: { itemName: "《长安的荔枝》" },
    });
    expect(omitted.details.ok).toBe(true);
    expect(omitted.details.status).toBe("wanted");
    /** 大小写 / 空白归一后命中的合法值放行。 */
    const cased = await tool.execute("call-cased", {
      module: "shopping",
      shopping: { itemName: "灰色风衣", status: "  Ordered  " },
    });
    expect(cased.details.ok).toBe(true);
    expect(cased.details.status).toBe("ordered");
    const rows = readJsonl(path.join(agentDir, "xingye", "apps", "shopping", "drafts.jsonl"));
    expect(rows).toHaveLength(2);
  });
});
