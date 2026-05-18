import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { appendReadingNoteDraftServer } from "../lib/xingye/reading-notes-drafts.js";
import { createProposeDraftTool } from "../lib/tools/xingye-propose-draft-tool.js";

function mktemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hana-reading-notes-drafts-"));
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

describe("appendReadingNoteDraftServer", () => {
  it("writes a row to apps/reading_notes/drafts.jsonl with required fields", async () => {
    const draft = await appendReadingNoteDraftServer({
      agentDir,
      agentId: "agent-a",
      input: {
        title: " 关于「不必逞强」一段 ",
        body: "  这一段我反复读了三遍，想起了师父。  ",
        noteType: "reading_note",
        bookHint: "  《xx》  ",
        quoteText: "  不必逞强。  ",
        reason: "晚上聊到师父",
        source: "xingye-heartbeat-tool",
        sourceEventIds: [" e-1 ", "", "e-2"],
      },
    });
    expect(draft).toMatchObject({
      title: "关于「不必逞强」一段",
      body: "这一段我反复读了三遍，想起了师父。",
      noteType: "reading_note",
      bookHint: "《xx》",
      quoteText: "不必逞强。",
      source: "xingye-heartbeat-tool",
      sourceEventIds: ["e-1", "e-2"],
    });
    const file = path.join(agentDir, "xingye", "apps", "reading_notes", "drafts.jsonl");
    const rows = readJsonl(file);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: draft.id, key: draft.id });
  });

  it("emits reading_notes.draft_proposed in xingye event log", async () => {
    const draft = await appendReadingNoteDraftServer({
      agentDir,
      agentId: "agent-a",
      input: {
        title: "T",
        body: "B",
        source: "xingye-heartbeat-tool",
      },
    });
    const log = readJson(path.join(agentDir, "xingye", "events", "log.json"));
    const proposed = log.events.find((e) => e.type === "reading_notes.draft_proposed");
    expect(proposed).toBeTruthy();
    expect(proposed.subjectId).toBe(draft.id);
    expect(proposed.payload.noteType).toBe("reading_note");
    expect(proposed.payload.hasQuote).toBe(false);
  });

  it("defaults noteType to 'reading_note' for missing / unknown values", async () => {
    const a = await appendReadingNoteDraftServer({
      agentDir, agentId: "agent-a",
      input: { title: "T", body: "B", source: "s" },
    });
    expect(a.noteType).toBe("reading_note");

    const b = await appendReadingNoteDraftServer({
      agentDir, agentId: "agent-a",
      input: { title: "T", body: "B", noteType: "want_to_read", source: "s" },
    });
    /** want_to_read 是用户标的，巡检不准用 → fallback */
    expect(b.noteType).toBe("reading_note");
  });

  it("accepts 'question' noteType (TA 的提问也算合法草稿)", async () => {
    const draft = await appendReadingNoteDraftServer({
      agentDir, agentId: "agent-a",
      input: { title: "T", body: "B", noteType: "question", source: "s" },
    });
    expect(draft.noteType).toBe("question");
  });

  it("does NOT write entries.jsonl", async () => {
    await appendReadingNoteDraftServer({
      agentDir, agentId: "agent-a",
      input: { title: "T", body: "B", source: "xingye-heartbeat-tool" },
    });
    expect(fs.existsSync(path.join(agentDir, "xingye", "apps", "reading_notes", "entries.jsonl"))).toBe(false);
  });

  it("returns null on missing title / body / source or invalid agentId", async () => {
    expect(await appendReadingNoteDraftServer({
      agentDir, agentId: "agent-a",
      input: { title: "  ", body: "B", source: "s" },
    })).toBeNull();
    expect(await appendReadingNoteDraftServer({
      agentDir, agentId: "agent-a",
      input: { title: "T", body: "   ", source: "s" },
    })).toBeNull();
    expect(await appendReadingNoteDraftServer({
      agentDir, agentId: "agent-a",
      input: { title: "T", body: "B", source: "" },
    })).toBeNull();
    expect(await appendReadingNoteDraftServer({
      agentDir, agentId: "bad id!",
      input: { title: "T", body: "B", source: "s" },
    })).toBeNull();
  });
});

describe("createProposeDraftTool · module=reading_notes", () => {
  it("dispatches reading_notes case and writes draft", async () => {
    const tool = createProposeDraftTool({ agentDir, agentId: "agent-a" });
    const res = await tool.execute("call-1", {
      module: "reading_notes",
      reason: "她读到这一段沉默了很久",
      reading_notes: {
        title: "关于「不必逞强」",
        body: "想起师父说过的那句话。",
        noteType: "reading_note",
        bookHint: "某本散文集",
        quoteText: "不必逞强。",
      },
    });
    expect(res.details.ok).toBe(true);
    expect(res.details.module).toBe("reading_notes");
    expect(res.details.noteType).toBe("reading_note");
    const rows = readJsonl(path.join(agentDir, "xingye", "apps", "reading_notes", "drafts.jsonl"));
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("关于「不必逞强」");
    expect(rows[0].bookHint).toBe("某本散文集");
  });

  it("rejects when title or body missing", async () => {
    const tool = createProposeDraftTool({ agentDir, agentId: "agent-a" });
    const res = await tool.execute("call-1", {
      module: "reading_notes",
      reading_notes: { title: "   ", body: "B" },
    });
    expect(res.details.ok).toBe(false);
    expect(res.details.reason).toBe("missing_required_fields");
    expect(fs.existsSync(path.join(agentDir, "xingye", "apps", "reading_notes", "drafts.jsonl"))).toBe(false);
  });
});
