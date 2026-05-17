import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { appendScheduleDraftServer } from "../lib/xingye/schedule-drafts.js";
import { createProposeDraftTool } from "../lib/tools/xingye-propose-draft-tool.js";

function mktemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hana-schedule-drafts-"));
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

describe("appendScheduleDraftServer", () => {
  it("writes a row to schedule/drafts.jsonl with required fields", async () => {
    const draft = await appendScheduleDraftServer({
      agentDir,
      agentId: "agent-a",
      input: {
        title: "  陪我去诊所  ",
        dateLabel: "明天上午",
        content: "她说会陪我一起。",
        timeText: "上午",
        category: "约定",
        reason: "晚饭时她答应明天上午",
        source: "xingye-heartbeat-tool",
        sourceEventIds: [" e-1 ", "", "e-2"],
      },
    });
    expect(draft).toMatchObject({
      title: "陪我去诊所",
      dateLabel: "明天上午",
      content: "她说会陪我一起。",
      timeText: "上午",
      category: "约定",
      source: "xingye-heartbeat-tool",
      sourceEventIds: ["e-1", "e-2"],
    });
    const file = path.join(agentDir, "xingye", "schedule", "drafts.jsonl");
    const rows = readJsonl(file);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: draft.id, key: draft.id });
  });

  it("emits schedule.draft_proposed in xingye event log", async () => {
    const draft = await appendScheduleDraftServer({
      agentDir,
      agentId: "agent-a",
      input: {
        title: "晚自习",
        dateLabel: "今晚",
        content: "8 点开始",
        source: "xingye-heartbeat-tool",
      },
    });
    const log = readJson(path.join(agentDir, "xingye", "events", "log.json"));
    const proposed = log.events.find((e) => e.type === "schedule.draft_proposed");
    expect(proposed).toBeTruthy();
    expect(proposed.subjectId).toBe(draft.id);
  });

  it("does NOT write entries.jsonl", async () => {
    await appendScheduleDraftServer({
      agentDir,
      agentId: "agent-a",
      input: { title: "T", dateLabel: "D", content: "C", source: "xingye-heartbeat-tool" },
    });
    expect(fs.existsSync(path.join(agentDir, "xingye", "schedule", "entries.jsonl"))).toBe(false);
  });

  it("returns null on missing required field (title/dateLabel/content) or empty source", async () => {
    expect(await appendScheduleDraftServer({
      agentDir, agentId: "agent-a",
      input: { title: "", dateLabel: "D", content: "C", source: "s" },
    })).toBeNull();
    expect(await appendScheduleDraftServer({
      agentDir, agentId: "agent-a",
      input: { title: "T", dateLabel: " ", content: "C", source: "s" },
    })).toBeNull();
    expect(await appendScheduleDraftServer({
      agentDir, agentId: "agent-a",
      input: { title: "T", dateLabel: "D", content: "", source: "s" },
    })).toBeNull();
    expect(await appendScheduleDraftServer({
      agentDir, agentId: "agent-a",
      input: { title: "T", dateLabel: "D", content: "C", source: "" },
    })).toBeNull();
  });
});

describe("createProposeDraftTool · module=schedule", () => {
  it("dispatches schedule case and writes draft", async () => {
    const tool = createProposeDraftTool({ agentDir, agentId: "agent-a" });
    const res = await tool.execute("call-1", {
      module: "schedule",
      reason: "她答应明天陪我",
      schedule: {
        title: "陪我去诊所",
        dateLabel: "明天上午",
        content: "带社保卡",
      },
    });
    expect(res.details.ok).toBe(true);
    expect(res.details.module).toBe("schedule");
    const rows = readJsonl(path.join(agentDir, "xingye", "schedule", "drafts.jsonl"));
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("陪我去诊所");
  });

  it("rejects when any of title/dateLabel/content missing", async () => {
    const tool = createProposeDraftTool({ agentDir, agentId: "agent-a" });
    const res = await tool.execute("call-1", {
      module: "schedule",
      schedule: { title: "x", dateLabel: "D" },
    });
    expect(res.details.ok).toBe(false);
    expect(res.details.module).toBe("schedule");
    expect(res.details.reason).toBe("missing_required_fields");
    expect(fs.existsSync(path.join(agentDir, "xingye", "schedule", "drafts.jsonl"))).toBe(false);
  });
});
