import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { appendRelationshipStateDraftServer } from "../lib/xingye/relationship-state-drafts.js";
import { createProposeDraftTool } from "../lib/tools/xingye-propose-draft-tool.js";

function mktemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hana-relationship-state-drafts-"));
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

describe("appendRelationshipStateDraftServer", () => {
  it("writes a row with normalized deltas + mood + summary + reasonText", async () => {
    const draft = await appendRelationshipStateDraftServer({
      agentDir,
      agentId: "agent-a",
      input: {
        affectionDelta: 5,
        trustDelta: 3,
        loyaltyDelta: 0,
        jealousyDelta: 0,
        corruptionDelta: 0,
        mood: " 想他 ",
        stateSummary: "  她今天主动留下来  ",
        reasonText: "  晚饭后她没走  ",
        source: "xingye-heartbeat-tool",
        sourceEventIds: ["e-1"],
      },
    });
    expect(draft).toMatchObject({
      affectionDelta: 5,
      trustDelta: 3,
      mood: "想他",
      stateSummary: "她今天主动留下来",
      reasonText: "晚饭后她没走",
    });
    const file = path.join(agentDir, "xingye", "relationship-state", "drafts.jsonl");
    const rows = readJsonl(file);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(draft.id);
  });

  it("clamps deltas into bounds (affection -100..150, others -100..100)", async () => {
    const draft = await appendRelationshipStateDraftServer({
      agentDir, agentId: "agent-a",
      input: { affectionDelta: 999, trustDelta: -999, source: "s" },
    });
    expect(draft.affectionDelta).toBe(150);
    expect(draft.trustDelta).toBe(-100);
  });

  it("falls back from reason to reasonText when reasonText absent", async () => {
    const draft = await appendRelationshipStateDraftServer({
      agentDir, agentId: "agent-a",
      input: { affectionDelta: 1, reason: "from top-level reason", source: "s" },
    });
    expect(draft.reasonText).toBe("from top-level reason");
  });

  it("rejects when all deltas are zero AND mood is empty", async () => {
    const result = await appendRelationshipStateDraftServer({
      agentDir, agentId: "agent-a",
      input: {
        affectionDelta: 0, trustDelta: 0, loyaltyDelta: 0, jealousyDelta: 0, corruptionDelta: 0,
        source: "s",
      },
    });
    expect(result).toBeNull();
  });

  it("accepts mood-only (no deltas)", async () => {
    const draft = await appendRelationshipStateDraftServer({
      agentDir, agentId: "agent-a",
      input: { mood: "警惕", source: "s" },
    });
    expect(draft).toBeTruthy();
    expect(draft.mood).toBe("警惕");
  });

  it("rejects invalid agentId / missing source", async () => {
    expect(await appendRelationshipStateDraftServer({
      agentDir, agentId: "with space", input: { affectionDelta: 1, source: "s" },
    })).toBeNull();
    expect(await appendRelationshipStateDraftServer({
      agentDir, agentId: "agent-a", input: { affectionDelta: 1, source: "" },
    })).toBeNull();
  });

  it("emits relationship_state.draft_proposed in event log", async () => {
    const draft = await appendRelationshipStateDraftServer({
      agentDir, agentId: "agent-a",
      input: { affectionDelta: 5, mood: "想他", source: "xingye-heartbeat-tool" },
    });
    const log = readJson(path.join(agentDir, "xingye", "events", "log.json"));
    const proposed = log.events.find((e) => e.type === "relationship_state.draft_proposed");
    expect(proposed).toBeTruthy();
    expect(proposed.subjectId).toBe(draft.id);
    expect(proposed.payload.affectionDelta).toBe(5);
    expect(proposed.payload.hasMood).toBe(true);
  });
});

describe("createProposeDraftTool dispatch: module=relationship_state", () => {
  it("rejects missing payload", async () => {
    const tool = createProposeDraftTool({ agentDir, agentId: "agent-a" });
    const result = await tool.execute("call-1", { module: "relationship_state" });
    expect(result.details.ok).toBe(false);
    expect(result.details.reason).toBe("missing_payload");
  });

  it("rejects when no delta is non-zero and mood empty", async () => {
    const tool = createProposeDraftTool({ agentDir, agentId: "agent-a" });
    const result = await tool.execute("call-1", {
      module: "relationship_state",
      relationship_state: { affectionDelta: 0, mood: "  " },
    });
    expect(result.details.ok).toBe(false);
    expect(result.details.reason).toBe("no_change");
  });

  it("writes draft on happy path with mood + deltas", async () => {
    const tool = createProposeDraftTool({ agentDir, agentId: "agent-a" });
    const result = await tool.execute("call-1", {
      module: "relationship_state",
      reason: "R",
      relationship_state: {
        affectionDelta: 5, trustDelta: 3,
        mood: "想他",
        stateSummary: "她今天主动留下来",
        reasonText: "晚饭后她没走",
      },
    });
    expect(result.details.ok).toBe(true);
    expect(result.details.module).toBe("relationship_state");
    const rows = readJsonl(path.join(agentDir, "xingye", "relationship-state", "drafts.jsonl"));
    expect(rows).toHaveLength(1);
    expect(rows[0].mood).toBe("想他");
    expect(rows[0].reasonText).toBe("晚饭后她没走");
  });
});
