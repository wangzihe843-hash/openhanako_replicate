import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { appendMomentDraftServer } from "../lib/xingye/moments-drafts.js";
import { createProposeDraftTool } from "../lib/tools/xingye-propose-draft-tool.js";

function mktemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hana-moments-drafts-"));
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

describe("appendMomentDraftServer", () => {
  it("writes a row to apps/moments/drafts.jsonl (note: under apps/ prefix)", async () => {
    const draft = await appendMomentDraftServer({
      agentDir,
      agentId: "agent-a",
      input: {
        content: "晚风从灯塔后面绕过来。",
        reason: "她笑了",
        source: "xingye-heartbeat-tool",
      },
    });
    expect(draft).toMatchObject({
      content: "晚风从灯塔后面绕过来。",
      reason: "她笑了",
      source: "xingye-heartbeat-tool",
    });
    const file = path.join(agentDir, "xingye", "apps", "moments", "drafts.jsonl");
    const rows = readJsonl(file);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: draft.id, key: draft.id });
  });

  it("clamps content to 280 codepoints with ellipsis", async () => {
    const long = "字".repeat(400);
    const draft = await appendMomentDraftServer({
      agentDir, agentId: "agent-a",
      input: { content: long, source: "xingye-heartbeat-tool" },
    });
    expect([...draft.content].length).toBeLessThanOrEqual(281); // 280 + ellipsis
    expect(draft.content.endsWith("…")).toBe(true);
  });

  it("emits moment.draft_proposed in xingye event log", async () => {
    const draft = await appendMomentDraftServer({
      agentDir, agentId: "agent-a",
      input: { content: "x", source: "xingye-heartbeat-tool" },
    });
    const log = readJson(path.join(agentDir, "xingye", "events", "log.json"));
    const proposed = log.events.find((e) => e.type === "moment.draft_proposed");
    expect(proposed).toBeTruthy();
    expect(proposed.subjectId).toBe(draft.id);
  });

  it("does NOT write posts.jsonl", async () => {
    await appendMomentDraftServer({
      agentDir, agentId: "agent-a",
      input: { content: "x", source: "xingye-heartbeat-tool" },
    });
    expect(fs.existsSync(path.join(agentDir, "xingye", "apps", "moments", "posts.jsonl"))).toBe(false);
  });

  it("returns null on empty content or missing source", async () => {
    expect(await appendMomentDraftServer({
      agentDir, agentId: "agent-a",
      input: { content: "   ", source: "s" },
    })).toBeNull();
    expect(await appendMomentDraftServer({
      agentDir, agentId: "agent-a",
      input: { content: "x", source: "" },
    })).toBeNull();
  });
});

describe("createProposeDraftTool · module=moments", () => {
  it("dispatches moments case and writes draft", async () => {
    const tool = createProposeDraftTool({ agentDir, agentId: "agent-a" });
    const res = await tool.execute("call-1", {
      module: "moments",
      reason: "她笑得很自然",
      moments: { content: "晚风从灯塔后面绕过来。" },
    });
    expect(res.details.ok).toBe(true);
    expect(res.details.module).toBe("moments");
    const rows = readJsonl(path.join(agentDir, "xingye", "apps", "moments", "drafts.jsonl"));
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe("晚风从灯塔后面绕过来。");
  });

  it("rejects when moments.content is empty", async () => {
    const tool = createProposeDraftTool({ agentDir, agentId: "agent-a" });
    const res = await tool.execute("call-1", {
      module: "moments",
      moments: { content: "   " },
    });
    expect(res.details.ok).toBe(false);
    expect(res.details.module).toBe("moments");
    expect(res.details.reason).toBe("empty_content");
  });
});
