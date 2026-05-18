import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { appendMemoryCandidateDraftServer } from "../lib/xingye/memory-candidate-drafts.js";
import { createProposeDraftTool } from "../lib/tools/xingye-propose-draft-tool.js";

function mktemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hana-memory-candidate-drafts-"));
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

describe("appendMemoryCandidateDraftServer", () => {
  it("writes a row to memory-candidate/drafts.jsonl with required fields", async () => {
    const draft = await appendMemoryCandidateDraftServer({
      agentDir,
      agentId: "agent-a",
      input: {
        content: "  user 怕黑——夜里走廊不会主动关灯  ",
        importance: "high",
        reason: "最近一周聊天反复出现",
        source: "xingye-heartbeat-tool",
        sourceEventIds: [" e-1 ", "", "e-2"],
      },
    });
    expect(draft).toMatchObject({
      content: "user 怕黑——夜里走廊不会主动关灯",
      importance: 3,
      importanceLevel: "high",
      target: "pinned",
      source: "xingye-heartbeat-tool",
      sourceEventIds: ["e-1", "e-2"],
    });
    const file = path.join(agentDir, "xingye", "memory-candidate", "drafts.jsonl");
    const rows = readJsonl(file);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: draft.id, key: draft.id });
  });

  it("defaults importance to medium when omitted or invalid", async () => {
    const a = await appendMemoryCandidateDraftServer({
      agentDir, agentId: "agent-a",
      input: { content: "C", source: "s" },
    });
    expect(a.importanceLevel).toBe("medium");
    expect(a.importance).toBe(2);
    const b = await appendMemoryCandidateDraftServer({
      agentDir, agentId: "agent-a",
      input: { content: "C2", importance: "ultra", source: "s" },
    });
    expect(b.importanceLevel).toBe("medium");
  });

  it("rejects empty content / empty agent / invalid agentId / missing source", async () => {
    expect(await appendMemoryCandidateDraftServer({
      agentDir, agentId: "agent-a", input: { content: "   ", source: "s" },
    })).toBeNull();
    expect(await appendMemoryCandidateDraftServer({
      agentDir, agentId: "", input: { content: "x", source: "s" },
    })).toBeNull();
    expect(await appendMemoryCandidateDraftServer({
      agentDir, agentId: "with space", input: { content: "x", source: "s" },
    })).toBeNull();
    expect(await appendMemoryCandidateDraftServer({
      agentDir, agentId: "agent-a", input: { content: "x", source: "  " },
    })).toBeNull();
  });

  it("emits memory_candidate.draft_proposed in xingye event log", async () => {
    const draft = await appendMemoryCandidateDraftServer({
      agentDir, agentId: "agent-a",
      input: { content: "C", importance: "low", reason: "R", source: "xingye-heartbeat-tool" },
    });
    const log = readJson(path.join(agentDir, "xingye", "events", "log.json"));
    const proposed = log.events.find((e) => e.type === "memory_candidate.draft_proposed");
    expect(proposed).toBeTruthy();
    expect(proposed.subjectId).toBe(draft.id);
    expect(proposed.payload.importanceLevel).toBe("low");
    expect(proposed.payload.target).toBe("pinned");
    expect(proposed.payload.reason).toBe("R");
  });
});

describe("createProposeDraftTool dispatch: module=memory_candidate", () => {
  it("rejects empty content", async () => {
    const tool = createProposeDraftTool({ agentDir, agentId: "agent-a" });
    const result = await tool.execute("call-1", {
      module: "memory_candidate",
      memory_candidate: { content: "  " },
    });
    expect(result.details.ok).toBe(false);
    expect(result.details.reason).toBe("empty_content");
  });

  it("rejects unsupported importance", async () => {
    const tool = createProposeDraftTool({ agentDir, agentId: "agent-a" });
    const result = await tool.execute("call-1", {
      module: "memory_candidate",
      memory_candidate: { content: "C", importance: "extreme" },
    });
    expect(result.details.ok).toBe(false);
    expect(result.details.reason).toBe("importance_not_allowed");
  });

  it("writes draft on happy path", async () => {
    const tool = createProposeDraftTool({ agentDir, agentId: "agent-a" });
    const result = await tool.execute("call-1", {
      module: "memory_candidate",
      reason: "R",
      memory_candidate: { content: "C", importance: "high" },
    });
    expect(result.details.ok).toBe(true);
    expect(result.details.module).toBe("memory_candidate");
    expect(result.details.importanceLevel).toBe("high");
    const rows = readJsonl(path.join(agentDir, "xingye", "memory-candidate", "drafts.jsonl"));
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe("C");
  });
});
