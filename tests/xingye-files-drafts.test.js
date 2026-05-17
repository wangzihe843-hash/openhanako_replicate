import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { appendFilesDraftServer } from "../lib/xingye/files-drafts.js";
import { createProposeDraftTool } from "../lib/tools/xingye-propose-draft-tool.js";

function mktemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hana-files-drafts-"));
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

describe("appendFilesDraftServer", () => {
  it("writes a row to files/drafts.jsonl with sanitized fields", async () => {
    const draft = await appendFilesDraftServer({
      agentDir,
      agentId: "agent-a",
      input: {
        title: "  师父说过的几句话  ",
        body: "「不必逞强，慢一点没事。」",
        summary: "整理师父反复说过的三句话。",
        folderHint: "  人际关系  ",
        tags: [" 师父 ", "", "家训"],
        reason: "晚上聊到师父",
        source: "xingye-heartbeat-tool",
        sourceEventIds: [" e-1 ", "", "e-2"],
      },
    });
    expect(draft).toMatchObject({
      title: "师父说过的几句话",
      summary: "整理师父反复说过的三句话。",
      folderHint: "人际关系",
      tags: ["师父", "家训"],
      source: "xingye-heartbeat-tool",
      sourceEventIds: ["e-1", "e-2"],
    });
    const file = path.join(agentDir, "xingye", "files", "drafts.jsonl");
    const rows = readJsonl(file);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: draft.id, key: draft.id });
  });

  it("emits file.draft_proposed in xingye event log", async () => {
    const draft = await appendFilesDraftServer({
      agentDir,
      agentId: "agent-a",
      input: {
        title: "诊所街区笔记",
        body: "街口的便利店在装修。",
        folderHint: "线索与发现",
        source: "xingye-heartbeat-tool",
      },
    });
    const log = readJson(path.join(agentDir, "xingye", "events", "log.json"));
    const proposed = log.events.find((e) => e.type === "file.draft_proposed");
    expect(proposed).toBeTruthy();
    expect(proposed.subjectId).toBe(draft.id);
    expect(proposed.payload.folderHint).toBe("线索与发现");
    expect(proposed.payload.hasBody).toBe(true);
  });

  it("allows body to be empty (title-only draft)", async () => {
    const draft = await appendFilesDraftServer({
      agentDir,
      agentId: "agent-a",
      input: {
        title: "稍后整理",
        body: "",
        source: "xingye-heartbeat-tool",
      },
    });
    expect(draft).not.toBeNull();
    expect(draft.body).toBe("");
  });

  it("does NOT write entries.jsonl", async () => {
    await appendFilesDraftServer({
      agentDir,
      agentId: "agent-a",
      input: { title: "T", body: "B", source: "xingye-heartbeat-tool" },
    });
    expect(fs.existsSync(path.join(agentDir, "xingye", "files", "entries.jsonl"))).toBe(false);
  });

  it("returns null on missing title, empty source, or invalid agentId", async () => {
    expect(await appendFilesDraftServer({
      agentDir, agentId: "agent-a",
      input: { title: "  ", body: "B", source: "s" },
    })).toBeNull();
    expect(await appendFilesDraftServer({
      agentDir, agentId: "agent-a",
      input: { title: "T", body: "B", source: "" },
    })).toBeNull();
    expect(await appendFilesDraftServer({
      agentDir, agentId: "bad id!",
      input: { title: "T", body: "B", source: "s" },
    })).toBeNull();
  });
});

describe("createProposeDraftTool · module=files", () => {
  it("dispatches files case and writes draft", async () => {
    const tool = createProposeDraftTool({ agentDir, agentId: "agent-a" });
    const res = await tool.execute("call-1", {
      module: "files",
      reason: "归档师父的几句家训",
      files: {
        title: "师父说过的几句话",
        body: "「不必逞强。」",
        folderHint: "人际关系",
        tags: ["师父"],
      },
    });
    expect(res.details.ok).toBe(true);
    expect(res.details.module).toBe("files");
    expect(res.details.folderHint).toBe("人际关系");
    const rows = readJsonl(path.join(agentDir, "xingye", "files", "drafts.jsonl"));
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("师父说过的几句话");
  });

  it("rejects when title missing", async () => {
    const tool = createProposeDraftTool({ agentDir, agentId: "agent-a" });
    const res = await tool.execute("call-1", {
      module: "files",
      files: { title: "   ", body: "B" },
    });
    expect(res.details.ok).toBe(false);
    expect(res.details.module).toBe("files");
    expect(res.details.reason).toBe("empty_title");
    expect(fs.existsSync(path.join(agentDir, "xingye", "files", "drafts.jsonl"))).toBe(false);
  });
});
