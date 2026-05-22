import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { appendSecondhandDraftServer } from "../lib/xingye/secondhand-drafts.js";
import { createProposeDraftTool } from "../lib/tools/xingye-propose-draft-tool.js";

function mktemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hana-secondhand-drafts-"));
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

describe("appendSecondhandDraftServer", () => {
  it("writes a row to apps/secondhand/drafts.jsonl with required fields", async () => {
    const draft = await appendSecondhandDraftServer({
      agentDir,
      agentId: "agent-a",
      input: {
        itemName: "  灰色长款风衣  ",
        status: "to_sell",
        category: "衣物",
        askingPrice: "¥120",
        delta: "比当初买价低一半",
        buyer: "巷口收旧衣的",
        reason: "她说穿不上了想出掉",
        content: "买回来只穿过两次。",
        tags: [" 旧衣 ", "", "断舍离"],
        source: "xingye-heartbeat-tool",
        sourceEventIds: [" e-1 ", "", "e-2"],
      },
    });
    expect(draft).toMatchObject({
      itemName: "灰色长款风衣",
      status: "to_sell",
      platformStyle: "generic",
      category: "衣物",
      askingPrice: "¥120",
      delta: "比当初买价低一半",
      buyer: "巷口收旧衣的",
      tags: ["旧衣", "断舍离"],
      source: "xingye-heartbeat-tool",
      sourceEventIds: ["e-1", "e-2"],
    });
    const file = path.join(agentDir, "xingye", "apps", "secondhand", "drafts.jsonl");
    const rows = readJsonl(file);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: draft.id, key: draft.id });
  });

  it("emits secondhand.draft_proposed in xingye event log", async () => {
    const draft = await appendSecondhandDraftServer({
      agentDir,
      agentId: "agent-a",
      input: {
        itemName: "旧相机",
        source: "xingye-heartbeat-tool",
      },
    });
    const log = readJson(path.join(agentDir, "xingye", "events", "log.json"));
    const proposed = log.events.find((e) => e.type === "secondhand.draft_proposed");
    expect(proposed).toBeTruthy();
    expect(proposed.subjectId).toBe(draft.id);
    expect(proposed.payload.status).toBe("to_sell");
  });

  it("falls back to status='to_sell' and platformStyle='generic' for unknown values", async () => {
    const draft = await appendSecondhandDraftServer({
      agentDir,
      agentId: "agent-a",
      input: {
        itemName: "X",
        status: "nonsense",
        platformStyle: "bogus",
        source: "s",
      },
    });
    expect(draft.status).toBe("to_sell");
    expect(draft.platformStyle).toBe("generic");
  });

  it("does NOT write entries.jsonl", async () => {
    await appendSecondhandDraftServer({
      agentDir, agentId: "agent-a",
      input: { itemName: "X", source: "xingye-heartbeat-tool" },
    });
    expect(fs.existsSync(path.join(agentDir, "xingye", "apps", "secondhand", "entries.jsonl"))).toBe(false);
  });

  it("returns null on missing itemName, empty source, or invalid agentId", async () => {
    expect(await appendSecondhandDraftServer({
      agentDir, agentId: "agent-a",
      input: { itemName: "  ", source: "s" },
    })).toBeNull();
    expect(await appendSecondhandDraftServer({
      agentDir, agentId: "agent-a",
      input: { itemName: "X", source: "" },
    })).toBeNull();
    expect(await appendSecondhandDraftServer({
      agentDir, agentId: "bad id!",
      input: { itemName: "X", source: "s" },
    })).toBeNull();
  });
});

describe("createProposeDraftTool · module=secondhand", () => {
  it("dispatches secondhand case and writes draft", async () => {
    const tool = createProposeDraftTool({ agentDir, agentId: "agent-a" });
    const res = await tool.execute("call-1", {
      module: "secondhand",
      reason: "她说穿不上了",
      secondhand: {
        itemName: "灰色长款风衣",
        status: "negotiating",
        category: "衣物",
        tags: ["旧衣"],
      },
    });
    expect(res.details.ok).toBe(true);
    expect(res.details.module).toBe("secondhand");
    const rows = readJsonl(path.join(agentDir, "xingye", "apps", "secondhand", "drafts.jsonl"));
    expect(rows).toHaveLength(1);
    expect(rows[0].itemName).toBe("灰色长款风衣");
    expect(rows[0].status).toBe("negotiating");
  });

  it("rejects when itemName missing", async () => {
    const tool = createProposeDraftTool({ agentDir, agentId: "agent-a" });
    const res = await tool.execute("call-1", {
      module: "secondhand",
      secondhand: { itemName: "   ", status: "to_sell" },
    });
    expect(res.details.ok).toBe(false);
    expect(res.details.module).toBe("secondhand");
    expect(res.details.reason).toBe("empty_item_name");
    expect(fs.existsSync(path.join(agentDir, "xingye", "apps", "secondhand", "drafts.jsonl"))).toBe(false);
  });
});
