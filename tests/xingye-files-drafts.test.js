import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { appendFilesDraftServer, normalizeFilesDraftPatch } from "../lib/xingye/files-drafts.js";
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

describe("normalizeFilesDraftPatch", () => {
  it("returns null on non-object", () => {
    expect(normalizeFilesDraftPatch(null)).toBeNull();
    expect(normalizeFilesDraftPatch("x")).toBeNull();
    expect(normalizeFilesDraftPatch([])).toBeNull();
  });

  it("returns null when no allowed field is present", () => {
    expect(normalizeFilesDraftPatch({})).toBeNull();
    expect(normalizeFilesDraftPatch({ folderId: "f1", source: "s" })).toBeNull();
    expect(normalizeFilesDraftPatch({ tags: [] })).toBeNull();
    expect(normalizeFilesDraftPatch({ bodyAppend: "   " })).toBeNull();
  });

  it("keeps title / bodyAppend / summary / tags only", () => {
    const patch = normalizeFilesDraftPatch({
      title: "  new title  ",
      bodyAppend: "  追加段落  ",
      summary: "新摘要",
      tags: [" t1 ", "", "t2"],
      folderId: "ignored",
      source: "ignored",
    });
    expect(patch).toEqual({
      title: "new title",
      bodyAppend: "追加段落",
      summary: "新摘要",
      tags: ["t1", "t2"],
    });
  });
});

describe("appendFilesDraftServer · action='update'", () => {
  it("writes update draft with targetEntryId + patch.bodyAppend", async () => {
    const draft = await appendFilesDraftServer({
      agentDir,
      agentId: "agent-a",
      input: {
        action: "update",
        targetEntryId: "fil-abc",
        patch: { bodyAppend: "今天又听到一句：「先稳住自己」。" },
        reason: "再聊师父",
        source: "xingye-heartbeat-tool",
      },
    });
    expect(draft).not.toBeNull();
    expect(draft.action).toBe("update");
    expect(draft.targetEntryId).toBe("fil-abc");
    expect(draft.patch).toEqual({ bodyAppend: "今天又听到一句：「先稳住自己」。" });
    const rows = readJsonl(path.join(agentDir, "xingye", "files", "drafts.jsonl"));
    expect(rows[0].action).toBe("update");
  });

  it("update path emits event with action + patchFields", async () => {
    const draft = await appendFilesDraftServer({
      agentDir, agentId: "agent-a",
      input: {
        action: "update", matchTitle: "师父的话",
        patch: { summary: "新摘要", tags: ["师父"] },
        source: "xingye-heartbeat-tool",
      },
    });
    const log = readJson(path.join(agentDir, "xingye", "events", "log.json"));
    const proposed = log.events.find((e) => e.type === "file.draft_proposed" && e.subjectId === draft.id);
    expect(proposed.payload.action).toBe("update");
    expect(proposed.payload.matchTitle).toBe("师父的话");
    expect(proposed.payload.patchFields.sort()).toEqual(["summary", "tags"]);
  });

  it("update requires targetEntryId OR matchTitle", async () => {
    expect(await appendFilesDraftServer({
      agentDir, agentId: "agent-a",
      input: { action: "update", patch: { summary: "x" }, source: "s" },
    })).toBeNull();
  });

  it("update requires non-empty patch", async () => {
    expect(await appendFilesDraftServer({
      agentDir, agentId: "agent-a",
      input: { action: "update", targetEntryId: "fil-x", patch: {}, source: "s" },
    })).toBeNull();
    expect(await appendFilesDraftServer({
      agentDir, agentId: "agent-a",
      input: { action: "update", targetEntryId: "fil-x", source: "s" },
    })).toBeNull();
  });

  it("missing action defaults to 'add' (back-compat for old callers)", async () => {
    const draft = await appendFilesDraftServer({
      agentDir, agentId: "agent-a",
      input: { title: "T", body: "B", source: "s" },
    });
    expect(draft.action).toBe("add");
  });

  it("invalid action value falls back to 'add'", async () => {
    const draft = await appendFilesDraftServer({
      agentDir, agentId: "agent-a",
      input: { action: "block", title: "T", source: "s" },
    });
    expect(draft.action).toBe("add");
  });
});

describe("createProposeDraftTool · module=files action='update'", () => {
  it("dispatches update + emits structured details", async () => {
    const tool = createProposeDraftTool({ agentDir, agentId: "agent-a" });
    const res = await tool.execute("call-1", {
      module: "files",
      reason: "再聊师父",
      files: {
        action: "update",
        targetEntryId: "fil-abc",
        patch: { bodyAppend: "今天又听到一句：「先稳住自己」。" },
      },
    });
    expect(res.details.ok).toBe(true);
    expect(res.details.action).toBe("update");
    expect(res.details.targetEntryId).toBe("fil-abc");
    expect(res.details.patchFields).toEqual(["bodyAppend"]);
    const rows = readJsonl(path.join(agentDir, "xingye", "files", "drafts.jsonl"));
    expect(rows[0]).toMatchObject({ action: "update", targetEntryId: "fil-abc" });
  });

  it("rejects update without targetEntryId / matchTitle", async () => {
    const tool = createProposeDraftTool({ agentDir, agentId: "agent-a" });
    const res = await tool.execute("call-1", {
      module: "files",
      files: { action: "update", patch: { summary: "x" } },
    });
    expect(res.details.ok).toBe(false);
    expect(res.details.reason).toBe("missing_target_identifier");
    expect(fs.existsSync(path.join(agentDir, "xingye", "files", "drafts.jsonl"))).toBe(false);
  });

  it("rejects update without patch", async () => {
    const tool = createProposeDraftTool({ agentDir, agentId: "agent-a" });
    const res = await tool.execute("call-1", {
      module: "files",
      files: { action: "update", targetEntryId: "fil-x" },
    });
    expect(res.details.ok).toBe(false);
    expect(res.details.reason).toBe("missing_patch");
    expect(fs.existsSync(path.join(agentDir, "xingye", "files", "drafts.jsonl"))).toBe(false);
  });
});
