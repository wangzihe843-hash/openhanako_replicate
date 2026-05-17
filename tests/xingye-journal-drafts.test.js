import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { appendJournalDraftServer } from "../lib/xingye/journal-drafts.js";
import {
  createProposeDraftTool,
  XINGYE_PROPOSE_DRAFT_SUPPORTED_MODULES,
} from "../lib/tools/xingye-propose-draft-tool.js";

function mktemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hana-journal-drafts-"));
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
let agentsDir;
let agentDir;

beforeEach(() => {
  tempRoot = mktemp();
  agentsDir = path.join(tempRoot, "agents");
  agentDir = path.join(agentsDir, "agent-a");
  fs.mkdirSync(agentDir, { recursive: true });
});

afterEach(() => {
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
});

describe("appendJournalDraftServer", () => {
  it("writes a row to journal/drafts.jsonl with sanitized fields", async () => {
    const draft = await appendJournalDraftServer({
      agentDir,
      agentId: "agent-a",
      input: {
        title: "  小灯塔的下午  ",
        body: "海风把灯影吹得有点歪。",
        dayKey: "2026-05-17",
        mood: "想他".repeat(20), // > 24 chars → should be trimmed
        reason: "聊天里反复出现",
        source: "xingye-heartbeat-tool",
        sourceEventIds: ["e-1", " ", "e-2"],
      },
    });
    expect(draft).toMatchObject({
      title: "小灯塔的下午",
      body: "海风把灯影吹得有点歪。",
      dayKey: "2026-05-17",
      source: "xingye-heartbeat-tool",
      sourceEventIds: ["e-1", "e-2"],
    });
    expect(draft.mood.length).toBeLessThanOrEqual(24);

    const draftsPath = path.join(agentDir, "xingye", "journal", "drafts.jsonl");
    const rows = readJsonl(draftsPath);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: draft.id, key: draft.id, body: draft.body });
  });

  it("emits a journal.draft_proposed event in xingye event log", async () => {
    const draft = await appendJournalDraftServer({
      agentDir,
      agentId: "agent-a",
      input: { body: "moment", source: "xingye-heartbeat-tool" },
    });

    const logPath = path.join(agentDir, "xingye", "events", "log.json");
    expect(fs.existsSync(logPath)).toBe(true);
    const log = readJson(logPath);
    const proposed = log.events.find((e) => e.type === "journal.draft_proposed");
    expect(proposed).toBeTruthy();
    expect(proposed.subjectId).toBe(draft.id);
    expect(proposed.payload.draftId).toBe(draft.id);
  });

  it("does NOT write entries.jsonl (drafts must stay out of the published list)", async () => {
    await appendJournalDraftServer({
      agentDir,
      agentId: "agent-a",
      input: { body: "moment", source: "xingye-heartbeat-tool" },
    });
    const entriesPath = path.join(agentDir, "xingye", "journal", "entries.jsonl");
    expect(fs.existsSync(entriesPath)).toBe(false);
  });

  it("returns null on invalid input (empty body / missing source / bad agentId)", async () => {
    expect(
      await appendJournalDraftServer({ agentDir, agentId: "agent-a", input: { body: "  ", source: "s" } }),
    ).toBeNull();
    expect(
      await appendJournalDraftServer({ agentDir, agentId: "agent-a", input: { body: "ok", source: "" } }),
    ).toBeNull();
    expect(
      await appendJournalDraftServer({ agentDir, agentId: "bad id!!", input: { body: "ok", source: "s" } }),
    ).toBeNull();
  });
});

describe("createProposeDraftTool (dispatch)", () => {
  it("declares xingye_propose_draft with module enum + per-module nested payloads", () => {
    const tool = createProposeDraftTool({ agentDir, agentId: "agent-a" });
    expect(tool.name).toBe("xingye_propose_draft");
    /** @ts-ignore — pi-sdk Type.Object has `.properties` */
    const props = tool.parameters.properties;
    expect(Object.keys(props)).toEqual(
      expect.arrayContaining(["module", "reason", "sourceEventIds", "journal"]),
    );
    /** journal payload nests its own fields. */
    expect(Object.keys(props.journal.properties)).toEqual(
      expect.arrayContaining(["title", "body", "dayKey", "mood"]),
    );
  });

  it("exports SUPPORTED_MODULES for invariant checks", () => {
    expect(XINGYE_PROPOSE_DRAFT_SUPPORTED_MODULES).toContain("journal");
  });

  it("module=journal + valid body writes a journal draft and returns ok:true", async () => {
    const tool = createProposeDraftTool({ agentDir, agentId: "agent-a" });
    const res = await tool.execute("call-1", {
      module: "journal",
      reason: "recent chat 提到灯塔",
      journal: {
        body: "今天遇到了一件很小的事，但让我想起灯塔。",
        title: "灯塔",
      },
    });
    expect(res.details.ok).toBe(true);
    expect(res.details.module).toBe("journal");
    expect(typeof res.details.draftId).toBe("string");

    const rows = readJsonl(path.join(agentDir, "xingye", "journal", "drafts.jsonl"));
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toBe("今天遇到了一件很小的事，但让我想起灯塔。");
    expect(rows[0].title).toBe("灯塔");
    expect(rows[0].source).toBe("xingye-heartbeat-tool");
  });

  it("module=journal with empty body rejects without writing", async () => {
    const tool = createProposeDraftTool({ agentDir, agentId: "agent-a" });
    const res = await tool.execute("call-1", { module: "journal", journal: { body: "   " } });
    expect(res.details.ok).toBe(false);
    expect(res.details.module).toBe("journal");
    expect(res.details.reason).toBe("empty_body");
    expect(fs.existsSync(path.join(agentDir, "xingye", "journal", "drafts.jsonl"))).toBe(false);
  });

  it("module=journal with missing journal payload object rejects", async () => {
    const tool = createProposeDraftTool({ agentDir, agentId: "agent-a" });
    const res = await tool.execute("call-1", { module: "journal" });
    expect(res.details.ok).toBe(false);
    expect(res.details.reason).toBe("empty_body");
  });

  it("unknown module name rejects without writing", async () => {
    const tool = createProposeDraftTool({ agentDir, agentId: "agent-a" });
    /** module value not in SUPPORTED_MODULES — schema enum prevents normal callers, */
    /** but defense-in-depth at execute(): unknown string still rejects cleanly. */
    const res = await tool.execute("call-1", {
      module: "definitely-not-a-real-module",
      journal: { body: "x" },
    });
    expect(res.details.ok).toBe(false);
    expect(res.details.reason).toBe("unsupported_module");
    expect(fs.existsSync(path.join(agentDir, "xingye", "journal", "drafts.jsonl"))).toBe(false);
  });

  it("passes reason + sourceEventIds through to the journal append helper", async () => {
    const tool = createProposeDraftTool({ agentDir, agentId: "agent-a" });
    await tool.execute("call-1", {
      module: "journal",
      reason: "感觉这件事她明天会想起来",
      sourceEventIds: ["evt-1", "evt-2"],
      journal: { body: "灯影在水面上一闪一闪。" },
    });
    const rows = readJsonl(path.join(agentDir, "xingye", "journal", "drafts.jsonl"));
    expect(rows[0].reason).toBe("感觉这件事她明天会想起来");
    expect(rows[0].sourceEventIds).toEqual(["evt-1", "evt-2"]);
  });
});
