import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { appendTripDraftServer } from "../lib/xingye/trips-drafts.js";
import {
  createProposeDraftTool,
  XINGYE_PROPOSE_DRAFT_SUPPORTED_MODULES,
} from "../lib/tools/xingye-propose-draft-tool.js";

function mktemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hana-trips-drafts-"));
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

const DRAFTS_REL = path.join("apps", "trips", "drafts.jsonl");
const ENTRIES_REL = path.join("apps", "trips", "entries.jsonl");

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

describe("appendTripDraftServer", () => {
  it("writes a row to apps/trips/drafts.jsonl with sanitized fields", async () => {
    const draft = await appendTripDraftServer({
      agentDir,
      agentId: "agent-a",
      input: {
        from: { name: "  北门诊所  ", meta: "后院 · 第三阶" },
        to: { name: "岑姨家" },
        chapter: "童年 · 北门",
        when: "停电夜",
        mode: "BOAT", // case-insensitive → boat
        modeLabel: "搭货车 · 徒步过哨",
        noteFrom: "x".repeat(300), // > 200 → trimmed
        reason: "聊天里反复提那条山道",
        source: "xingye-heartbeat-tool",
        sourceEventIds: ["e-1", " ", "e-2"],
      },
    });
    expect(draft).toMatchObject({
      from: { name: "北门诊所", meta: "后院 · 第三阶" },
      to: { name: "岑姨家" },
      chapter: "童年 · 北门",
      mode: "boat",
      modeLabel: "搭货车 · 徒步过哨",
      source: "xingye-heartbeat-tool",
      sourceEventIds: ["e-1", "e-2"],
    });
    expect(draft.noteFrom.length).toBeLessThanOrEqual(200);

    const rows = readJsonl(path.join(agentDir, "xingye", DRAFTS_REL));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: draft.id, key: draft.id, from: { name: "北门诊所" } });
  });

  it("defaults mode to walk and pass to — when omitted", async () => {
    const draft = await appendTripDraftServer({
      agentDir,
      agentId: "agent-a",
      input: { from: { name: "A" }, to: { name: "B" }, source: "xingye-heartbeat-tool" },
    });
    expect(draft.mode).toBe("walk");
    expect(draft.modeLabel).toBe("徒步");
    expect(draft.pass).toBe("—");
    expect(draft.chapter).toBe("行程");
  });

  it("emits a trips.draft_proposed event in xingye event log", async () => {
    const draft = await appendTripDraftServer({
      agentDir,
      agentId: "agent-a",
      input: { from: { name: "A" }, to: { name: "B" }, source: "xingye-heartbeat-tool" },
    });

    const logPath = path.join(agentDir, "xingye", "events", "log.json");
    expect(fs.existsSync(logPath)).toBe(true);
    const log = readJson(logPath);
    const proposed = log.events.find((e) => e.type === "trips.draft_proposed");
    expect(proposed).toBeTruthy();
    expect(proposed.subjectId).toBe(draft.id);
    expect(proposed.payload).toMatchObject({ draftId: draft.id, from: "A", to: "B" });
  });

  it("does NOT write entries.jsonl (drafts stay out of the published list)", async () => {
    await appendTripDraftServer({
      agentDir,
      agentId: "agent-a",
      input: { from: { name: "A" }, to: { name: "B" }, source: "xingye-heartbeat-tool" },
    });
    expect(fs.existsSync(path.join(agentDir, "xingye", ENTRIES_REL))).toBe(false);
  });

  it("returns null on invalid input (missing from/to / source / bad agentId)", async () => {
    expect(
      await appendTripDraftServer({ agentDir, agentId: "agent-a", input: { from: { name: "" }, to: { name: "B" }, source: "s" } }),
    ).toBeNull();
    expect(
      await appendTripDraftServer({ agentDir, agentId: "agent-a", input: { from: { name: "A" }, to: { name: "B" }, source: "" } }),
    ).toBeNull();
    expect(
      await appendTripDraftServer({ agentDir, agentId: "bad id!!", input: { from: { name: "A" }, to: { name: "B" }, source: "s" } }),
    ).toBeNull();
  });
});

describe("createProposeDraftTool (trips dispatch)", () => {
  it("exposes trips in SUPPORTED_MODULES and as a nested payload", () => {
    expect(XINGYE_PROPOSE_DRAFT_SUPPORTED_MODULES).toContain("trips");
    const tool = createProposeDraftTool({ agentDir, agentId: "agent-a" });
    const props = tool.parameters.properties;
    expect(Object.keys(props)).toEqual(expect.arrayContaining(["trips"]));
    expect(Object.keys(props.trips.properties)).toEqual(
      expect.arrayContaining(["from", "to", "mode", "modeLabel", "noteFrom", "noteTo"]),
    );
  });

  it("module=trips + valid from/to writes a trips draft and returns ok:true", async () => {
    const tool = createProposeDraftTool({ agentDir, agentId: "agent-a" });
    const res = await tool.execute("call-1", {
      module: "trips",
      reason: "聊到那次撤离",
      trips: {
        from: { name: "红盐码头" },
        to: { name: "城西医馆" },
        mode: "boat",
        modeLabel: "旧摆渡",
        noteFrom: "船资半钱。",
      },
    });
    expect(res.details.ok).toBe(true);
    expect(res.details.module).toBe("trips");
    expect(typeof res.details.draftId).toBe("string");

    const rows = readJsonl(path.join(agentDir, "xingye", DRAFTS_REL));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ from: { name: "红盐码头" }, to: { name: "城西医馆" }, mode: "boat" });
    expect(rows[0].source).toBe("xingye-heartbeat-tool");
  });

  it("module=trips with missing from/to rejects without writing", async () => {
    const tool = createProposeDraftTool({ agentDir, agentId: "agent-a" });
    const res = await tool.execute("call-1", { module: "trips", trips: { from: { name: "A" } } });
    expect(res.details.ok).toBe(false);
    expect(res.details.module).toBe("trips");
    expect(res.details.reason).toBe("missing_from_or_to");
    expect(fs.existsSync(path.join(agentDir, "xingye", DRAFTS_REL))).toBe(false);
  });

  it("passes reason + sourceEventIds through to the trips append helper", async () => {
    const tool = createProposeDraftTool({ agentDir, agentId: "agent-a" });
    await tool.execute("call-1", {
      module: "trips",
      reason: "这趟路她明天会想起来",
      sourceEventIds: ["evt-1", "evt-2"],
      trips: { from: { name: "A" }, to: { name: "B" } },
    });
    const rows = readJsonl(path.join(agentDir, "xingye", DRAFTS_REL));
    expect(rows[0].reason).toBe("这趟路她明天会想起来");
    expect(rows[0].sourceEventIds).toEqual(["evt-1", "evt-2"]);
  });
});
