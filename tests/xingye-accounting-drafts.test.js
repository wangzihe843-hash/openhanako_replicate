import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { appendAccountingDraftServer } from "../lib/xingye/accounting-drafts.js";
import { createProposeDraftTool } from "../lib/tools/xingye-propose-draft-tool.js";

function mktemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hana-accounting-drafts-"));
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

describe("appendAccountingDraftServer", () => {
  it("writes a row to apps/accounting/drafts.jsonl with required fields", async () => {
    const draft = await appendAccountingDraftServer({
      agentDir,
      agentId: "agent-a",
      input: {
        title: "  五月薪俸  ",
        direction: "income",
        amount: 5000,
        currency: "¥",
        imaginedAmount: "¥5000（这个月足额发了）",
        category: "工资",
        counterparty: "东家",
        occurredAt: "2026-05-26",
        reason: "她在厨房说今天工资发下来了",
        content: "比上个月多 200，可能是端午加班补的。",
        source: "xingye-heartbeat-tool",
        sourceEventIds: [" e-1 ", "", "e-2"],
      },
    });
    expect(draft).toMatchObject({
      title: "五月薪俸",
      direction: "income",
      amount: 5000,
      currency: "¥",
      imaginedAmount: "¥5000（这个月足额发了）",
      category: "工资",
      counterparty: "东家",
      source: "xingye-heartbeat-tool",
      sourceEventIds: ["e-1", "e-2"],
    });
    // occurredAt 是 ISO 字符串
    expect(typeof draft.occurredAt).toBe("string");
    expect(draft.occurredAt).toMatch(/^2026-05-26T/);
    const file = path.join(agentDir, "xingye", "apps", "accounting", "drafts.jsonl");
    const rows = readJsonl(file);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: draft.id, key: draft.id });
  });

  it("emits accounting.draft_proposed in xingye event log", async () => {
    const draft = await appendAccountingDraftServer({
      agentDir,
      agentId: "agent-a",
      input: {
        title: "巷口面摊午饭",
        direction: "expense",
        amount: 18,
        currency: "¥",
        source: "xingye-heartbeat-tool",
      },
    });
    const log = readJson(path.join(agentDir, "xingye", "events", "log.json"));
    const proposed = log.events.find((e) => e.type === "accounting.draft_proposed");
    expect(proposed).toBeTruthy();
    expect(proposed.subjectId).toBe(draft.id);
    expect(proposed.payload.direction).toBe("expense");
    expect(proposed.payload.amount).toBe(18);
    expect(proposed.payload.currency).toBe("¥");
  });

  it("falls back to direction='expense' for unknown values", async () => {
    const draft = await appendAccountingDraftServer({
      agentDir,
      agentId: "agent-a",
      input: {
        title: "X",
        direction: "nonsense",
        amount: 100,
        source: "s",
      },
    });
    expect(draft.direction).toBe("expense");
  });

  it("rounds amount to 2 decimal places", async () => {
    const draft = await appendAccountingDraftServer({
      agentDir,
      agentId: "agent-a",
      input: {
        title: "咖啡",
        amount: 18.567,
        source: "s",
      },
    });
    expect(draft.amount).toBe(18.57);
  });

  it("drops occurredAt when unparseable", async () => {
    const draft = await appendAccountingDraftServer({
      agentDir,
      agentId: "agent-a",
      input: {
        title: "X",
        amount: 1,
        occurredAt: "三天前",
        source: "s",
      },
    });
    expect(draft.occurredAt).toBeUndefined();
  });

  it("does NOT write entries.jsonl", async () => {
    await appendAccountingDraftServer({
      agentDir, agentId: "agent-a",
      input: { title: "X", amount: 1, source: "xingye-heartbeat-tool" },
    });
    expect(fs.existsSync(path.join(agentDir, "xingye", "apps", "accounting", "entries.jsonl"))).toBe(false);
  });

  it("returns null on missing title, empty source, invalid agentId, or invalid amount", async () => {
    // missing title
    expect(await appendAccountingDraftServer({
      agentDir, agentId: "agent-a",
      input: { title: "  ", amount: 1, source: "s" },
    })).toBeNull();
    // empty source
    expect(await appendAccountingDraftServer({
      agentDir, agentId: "agent-a",
      input: { title: "X", amount: 1, source: "" },
    })).toBeNull();
    // invalid agentId
    expect(await appendAccountingDraftServer({
      agentDir, agentId: "bad id!",
      input: { title: "X", amount: 1, source: "s" },
    })).toBeNull();
    // negative amount
    expect(await appendAccountingDraftServer({
      agentDir, agentId: "agent-a",
      input: { title: "X", amount: -1, source: "s" },
    })).toBeNull();
    // NaN amount
    expect(await appendAccountingDraftServer({
      agentDir, agentId: "agent-a",
      input: { title: "X", amount: NaN, source: "s" },
    })).toBeNull();
  });
});

describe("createProposeDraftTool · module=accounting", () => {
  it("dispatches accounting case and writes draft", async () => {
    const tool = createProposeDraftTool({ agentDir, agentId: "agent-a" });
    const res = await tool.execute("call-1", {
      module: "accounting",
      reason: "她在厨房说今天工资发下来了",
      accounting: {
        title: "五月薪俸",
        direction: "income",
        amount: 5000,
        currency: "¥",
        category: "工资",
        counterparty: "东家",
      },
    });
    expect(res.details.ok).toBe(true);
    expect(res.details.module).toBe("accounting");
    const rows = readJsonl(path.join(agentDir, "xingye", "apps", "accounting", "drafts.jsonl"));
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("五月薪俸");
    expect(rows[0].direction).toBe("income");
    expect(rows[0].amount).toBe(5000);
  });

  it("rejects when title missing", async () => {
    const tool = createProposeDraftTool({ agentDir, agentId: "agent-a" });
    const res = await tool.execute("call-1", {
      module: "accounting",
      accounting: { title: "   ", direction: "expense", amount: 10 },
    });
    expect(res.details.ok).toBe(false);
    expect(res.details.module).toBe("accounting");
    expect(res.details.reason).toBe("empty_title");
    expect(fs.existsSync(path.join(agentDir, "xingye", "apps", "accounting", "drafts.jsonl"))).toBe(false);
  });

  it("rejects when amount is missing / negative / non-numeric", async () => {
    const tool = createProposeDraftTool({ agentDir, agentId: "agent-a" });
    const r1 = await tool.execute("call-1", {
      module: "accounting",
      accounting: { title: "X", direction: "expense" },
    });
    expect(r1.details.ok).toBe(false);
    expect(r1.details.reason).toBe("invalid_amount");
    const r2 = await tool.execute("call-2", {
      module: "accounting",
      accounting: { title: "X", direction: "expense", amount: -50 },
    });
    expect(r2.details.ok).toBe(false);
    expect(r2.details.reason).toBe("invalid_amount");
  });
});
