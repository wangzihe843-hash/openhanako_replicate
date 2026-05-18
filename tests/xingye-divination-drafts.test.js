import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { appendDivinationDraftServer } from "../lib/xingye/divination-drafts.js";
import { createProposeDraftTool } from "../lib/tools/xingye-propose-draft-tool.js";

function mktemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hana-divination-drafts-"));
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

describe("appendDivinationDraftServer", () => {
  it("writes a row to apps/divination/drafts.jsonl with required fields", async () => {
    const draft = await appendDivinationDraftServer({
      agentDir,
      agentId: "agent-a",
      input: {
        agentQuestion: " 我是不是把师父那句话听岔了？ ",
        content: "  心里浮出一棵被风吹歪的小树，但根没动。  ",
        themeHint: "  关系  ",
        reason: "晚上反复想起",
        source: "xingye-heartbeat-tool",
        sourceEventIds: [" e-1 ", "", "e-2"],
      },
    });
    expect(draft).toMatchObject({
      agentQuestion: "我是不是把师父那句话听岔了？",
      content: "心里浮出一棵被风吹歪的小树，但根没动。",
      themeHint: "关系",
      source: "xingye-heartbeat-tool",
      sourceEventIds: ["e-1", "e-2"],
    });
    const file = path.join(agentDir, "xingye", "apps", "divination", "drafts.jsonl");
    const rows = readJsonl(file);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: draft.id, key: draft.id });
  });

  it("emits divination.draft_proposed in xingye event log", async () => {
    const draft = await appendDivinationDraftServer({
      agentDir,
      agentId: "agent-a",
      input: {
        agentQuestion: "Q",
        content: "C",
        source: "xingye-heartbeat-tool",
      },
    });
    const log = readJson(path.join(agentDir, "xingye", "events", "log.json"));
    const proposed = log.events.find((e) => e.type === "divination.draft_proposed");
    expect(proposed).toBeTruthy();
    expect(proposed.subjectId).toBe(draft.id);
    expect(proposed.payload.agentQuestion).toBe("Q");
    expect(proposed.payload.themeHint).toBe(null);
  });

  it("does NOT write entries.jsonl", async () => {
    await appendDivinationDraftServer({
      agentDir, agentId: "agent-a",
      input: { agentQuestion: "Q", content: "C", source: "xingye-heartbeat-tool" },
    });
    expect(fs.existsSync(path.join(agentDir, "xingye", "apps", "divination", "entries.jsonl"))).toBe(false);
  });

  it("returns null on missing agentQuestion / content / source or invalid agentId", async () => {
    expect(await appendDivinationDraftServer({
      agentDir, agentId: "agent-a",
      input: { agentQuestion: "  ", content: "C", source: "s" },
    })).toBeNull();
    expect(await appendDivinationDraftServer({
      agentDir, agentId: "agent-a",
      input: { agentQuestion: "Q", content: "   ", source: "s" },
    })).toBeNull();
    expect(await appendDivinationDraftServer({
      agentDir, agentId: "agent-a",
      input: { agentQuestion: "Q", content: "C", source: "" },
    })).toBeNull();
    expect(await appendDivinationDraftServer({
      agentDir, agentId: "bad id!",
      input: { agentQuestion: "Q", content: "C", source: "s" },
    })).toBeNull();
  });
});

describe("createProposeDraftTool · module=divination", () => {
  it("dispatches divination case and writes draft", async () => {
    const tool = createProposeDraftTool({ agentDir, agentId: "agent-a" });
    const res = await tool.execute("call-1", {
      module: "divination",
      reason: "晚上反复想起师父那句话",
      divination: {
        agentQuestion: "我有没有听岔？",
        content: "心里浮出一棵被风吹歪的小树。",
        themeHint: "关系",
      },
    });
    expect(res.details.ok).toBe(true);
    expect(res.details.module).toBe("divination");
    expect(res.details.agentQuestion).toBe("我有没有听岔？");
    const rows = readJsonl(path.join(agentDir, "xingye", "apps", "divination", "drafts.jsonl"));
    expect(rows).toHaveLength(1);
    expect(rows[0].agentQuestion).toBe("我有没有听岔？");
    expect(rows[0].themeHint).toBe("关系");
  });

  it("rejects when agentQuestion or content missing", async () => {
    const tool = createProposeDraftTool({ agentDir, agentId: "agent-a" });
    const res = await tool.execute("call-1", {
      module: "divination",
      divination: { agentQuestion: "Q", content: "  " },
    });
    expect(res.details.ok).toBe(false);
    expect(res.details.reason).toBe("missing_required_fields");
    expect(fs.existsSync(path.join(agentDir, "xingye", "apps", "divination", "drafts.jsonl"))).toBe(false);
  });
});
