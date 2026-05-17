import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { appendMailDraftServer } from "../lib/xingye/mail-drafts.js";
import { createProposeDraftTool } from "../lib/tools/xingye-propose-draft-tool.js";

function mktemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hana-mail-drafts-"));
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

describe("appendMailDraftServer", () => {
  it("writes a row to apps/mail/drafts.jsonl with subject/body/to fields", async () => {
    const draft = await appendMailDraftServer({
      agentDir,
      agentId: "agent-a",
      input: {
        subject: "  给妈妈  ",
        body: "好久没回家。",
        toAddress: "mom@hana.mail",
        toName: "妈妈",
        reason: "晚饭聊到母亲生日",
        source: "xingye-heartbeat-tool",
        sourceEventIds: [" e-1 ", "", "e-2"],
      },
    });
    expect(draft).toMatchObject({
      subject: "给妈妈",
      body: "好久没回家。",
      toAddress: "mom@hana.mail",
      toName: "妈妈",
      source: "xingye-heartbeat-tool",
      sourceEventIds: ["e-1", "e-2"],
    });
    const file = path.join(agentDir, "xingye", "apps", "mail", "drafts.jsonl");
    const rows = readJsonl(file);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: draft.id, key: draft.id });
  });

  it("emits mail.draft_proposed in xingye event log", async () => {
    const draft = await appendMailDraftServer({
      agentDir,
      agentId: "agent-a",
      input: {
        subject: "试探",
        body: "你最近好吗？",
        source: "xingye-heartbeat-tool",
      },
    });
    const log = readJson(path.join(agentDir, "xingye", "events", "log.json"));
    const proposed = log.events.find((e) => e.type === "mail.draft_proposed");
    expect(proposed).toBeTruthy();
    expect(proposed.subjectId).toBe(draft.id);
    expect(proposed.payload.hasBody).toBe(true);
  });

  it("allows subject-only or body-only drafts (but not both empty)", async () => {
    /** subject 单独有 → 允许。 */
    const subjectOnly = await appendMailDraftServer({
      agentDir,
      agentId: "agent-a",
      input: { subject: "便条", body: "", source: "s" },
    });
    expect(subjectOnly).not.toBeNull();

    /** body 单独有 → 允许。 */
    const bodyOnly = await appendMailDraftServer({
      agentDir,
      agentId: "agent-a",
      input: { subject: "  ", body: "只想说一句话。", source: "s" },
    });
    expect(bodyOnly).not.toBeNull();

    /** 两个都空 → 拒绝。 */
    const both = await appendMailDraftServer({
      agentDir,
      agentId: "agent-a",
      input: { subject: "  ", body: "   ", source: "s" },
    });
    expect(both).toBeNull();
  });

  it("does NOT write messages.jsonl", async () => {
    await appendMailDraftServer({
      agentDir,
      agentId: "agent-a",
      input: { subject: "S", body: "B", source: "xingye-heartbeat-tool" },
    });
    expect(fs.existsSync(path.join(agentDir, "xingye", "apps", "mail", "messages.jsonl"))).toBe(false);
  });

  it("returns null on missing source or invalid agentId", async () => {
    expect(await appendMailDraftServer({
      agentDir, agentId: "agent-a",
      input: { subject: "S", body: "B", source: "" },
    })).toBeNull();
    expect(await appendMailDraftServer({
      agentDir, agentId: "bad agent id!",
      input: { subject: "S", body: "B", source: "s" },
    })).toBeNull();
  });
});

describe("createProposeDraftTool · module=mail", () => {
  it("dispatches mail case and writes draft", async () => {
    const tool = createProposeDraftTool({ agentDir, agentId: "agent-a" });
    const res = await tool.execute("call-1", {
      module: "mail",
      reason: "母亲节",
      mail: {
        subject: "给妈妈",
        body: "好想你。",
        toAddress: "mom@hana.mail",
      },
    });
    expect(res.details.ok).toBe(true);
    expect(res.details.module).toBe("mail");
    const rows = readJsonl(path.join(agentDir, "xingye", "apps", "mail", "drafts.jsonl"));
    expect(rows).toHaveLength(1);
    expect(rows[0].subject).toBe("给妈妈");
    expect(rows[0].body).toBe("好想你。");
  });

  it("rejects when subject and body both empty", async () => {
    const tool = createProposeDraftTool({ agentDir, agentId: "agent-a" });
    const res = await tool.execute("call-1", {
      module: "mail",
      mail: { subject: "   ", body: "   " },
    });
    expect(res.details.ok).toBe(false);
    expect(res.details.module).toBe("mail");
    expect(res.details.reason).toBe("empty_subject_and_body");
    expect(fs.existsSync(path.join(agentDir, "xingye", "apps", "mail", "drafts.jsonl"))).toBe(false);
  });
});
