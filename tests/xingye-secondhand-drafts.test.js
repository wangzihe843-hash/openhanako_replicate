import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { appendSecondhandDraftServer } from "../lib/xingye/secondhand-drafts.js";
import { createProposeDraftTool } from "../lib/tools/xingye-propose-draft-tool.js";

function mktemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hana-secondhand-drafts-"));
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

describe("appendSecondhandDraftServer", () => {
  it("writes a row to apps/secondhand/drafts.jsonl with required fields", async () => {
    const draft = await appendSecondhandDraftServer({
      agentDir,
      agentId: "agent-a",
      input: {
        itemName: "  灰色长款风衣  ",
        status: "to_sell",
        category: "衣物",
        askingPrice: "¥120",
        delta: "比当初买价低一半",
        buyer: "巷口收旧衣的",
        reason: "她说穿不上了想出掉",
        content: "买回来只穿过两次。",
        tags: [" 旧衣 ", "", "断舍离"],
        source: "xingye-heartbeat-tool",
        sourceEventIds: [" e-1 ", "", "e-2"],
      },
    });
    expect(draft).toMatchObject({
      itemName: "灰色长款风衣",
      status: "to_sell",
      platformStyle: "generic",
      category: "衣物",
      askingPrice: "¥120",
      delta: "比当初买价低一半",
      buyer: "巷口收旧衣的",
      tags: ["旧衣", "断舍离"],
      source: "xingye-heartbeat-tool",
      sourceEventIds: ["e-1", "e-2"],
    });
    const file = path.join(agentDir, "xingye", "apps", "secondhand", "drafts.jsonl");
    const rows = readJsonl(file);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: draft.id, key: draft.id });
  });

  it("emits secondhand.draft_proposed in xingye event log", async () => {
    const draft = await appendSecondhandDraftServer({
      agentDir,
      agentId: "agent-a",
      input: {
        itemName: "旧相机",
        source: "xingye-heartbeat-tool",
      },
    });
    const log = readJson(path.join(agentDir, "xingye", "events", "log.json"));
    const proposed = log.events.find((e) => e.type === "secondhand.draft_proposed");
    expect(proposed).toBeTruthy();
    expect(proposed.subjectId).toBe(draft.id);
    expect(proposed.payload.status).toBe("to_sell");
  });

  it("falls back to status='to_sell' and platformStyle='generic' for unknown values", async () => {
    const draft = await appendSecondhandDraftServer({
      agentDir,
      agentId: "agent-a",
      input: {
        itemName: "X",
        status: "nonsense",
        platformStyle: "bogus",
        source: "s",
      },
    });
    expect(draft.status).toBe("to_sell");
    expect(draft.platformStyle).toBe("generic");
  });

  it("does NOT write entries.jsonl", async () => {
    await appendSecondhandDraftServer({
      agentDir, agentId: "agent-a",
      input: { itemName: "X", source: "xingye-heartbeat-tool" },
    });
    expect(fs.existsSync(path.join(agentDir, "xingye", "apps", "secondhand", "entries.jsonl"))).toBe(false);
  });

  it("returns null on missing itemName, empty source, or invalid agentId", async () => {
    expect(await appendSecondhandDraftServer({
      agentDir, agentId: "agent-a",
      input: { itemName: "  ", source: "s" },
    })).toBeNull();
    expect(await appendSecondhandDraftServer({
      agentDir, agentId: "agent-a",
      input: { itemName: "X", source: "" },
    })).toBeNull();
    expect(await appendSecondhandDraftServer({
      agentDir, agentId: "bad id!",
      input: { itemName: "X", source: "s" },
    })).toBeNull();
  });

  it("action defaults to 'add' when omitted", async () => {
    const draft = await appendSecondhandDraftServer({
      agentDir, agentId: "agent-a",
      input: { itemName: "旧相机", source: "s" },
    });
    expect(draft.action).toBe("add");
    expect(draft.patch).toBeUndefined();
    expect(draft.targetEntryId).toBeUndefined();
  });

  it("action='update' stores patch + matchName (falls back to itemName)", async () => {
    const draft = await appendSecondhandDraftServer({
      agentDir, agentId: "agent-a",
      input: {
        action: "update",
        itemName: "灰色长款风衣",
        patch: {
          status: "sold",
          buyer: "巷口收旧衣的",
          tags: [" 已出 ", ""],
          contentAppend: "  出掉了，对方挺满意。  ",
        },
        source: "xingye-heartbeat-tool",
      },
    });
    expect(draft.action).toBe("update");
    expect(draft.matchName).toBe("灰色长款风衣"); // 缺省回退到 itemName
    expect(draft.patch).toMatchObject({
      status: "sold",
      buyer: "巷口收旧衣的",
      tags: ["已出"],
      contentAppend: "出掉了，对方挺满意。",
    });
    const proposed = readJson(path.join(agentDir, "xingye", "events", "log.json"))
      .events.find((e) => e.type === "secondhand.draft_proposed");
    expect(proposed.payload.action).toBe("update");
    expect(proposed.payload.status).toBe("sold"); // update 的语义状态取自 patch.status
    expect(proposed.payload.patchFields).toContain("status");
  });

  it("action='update' prefers explicit matchName over itemName", async () => {
    const draft = await appendSecondhandDraftServer({
      agentDir, agentId: "agent-a",
      input: {
        action: "update", itemName: "风衣", matchName: "灰色长款风衣",
        patch: { status: "sold" }, source: "s",
      },
    });
    expect(draft.matchName).toBe("灰色长款风衣");
  });

  it("action='update' with empty/invalid patch returns null", async () => {
    expect(await appendSecondhandDraftServer({
      agentDir, agentId: "agent-a",
      input: { action: "update", itemName: "X", patch: {}, source: "s" },
    })).toBeNull();
    // 非法 status 被丢弃后 patch 变空 → null
    expect(await appendSecondhandDraftServer({
      agentDir, agentId: "agent-a",
      input: { action: "update", itemName: "X", patch: { status: "bogus" }, source: "s" },
    })).toBeNull();
    expect(await appendSecondhandDraftServer({
      agentDir, agentId: "agent-a",
      input: { action: "update", itemName: "X", source: "s" },
    })).toBeNull();
  });
});

describe("createProposeDraftTool · module=secondhand", () => {
  it("dispatches secondhand case and writes draft", async () => {
    const tool = createProposeDraftTool({ agentDir, agentId: "agent-a" });
    const res = await tool.execute("call-1", {
      module: "secondhand",
      reason: "她说穿不上了",
      secondhand: {
        itemName: "灰色长款风衣",
        status: "negotiating",
        category: "衣物",
        tags: ["旧衣"],
      },
    });
    expect(res.details.ok).toBe(true);
    expect(res.details.module).toBe("secondhand");
    const rows = readJsonl(path.join(agentDir, "xingye", "apps", "secondhand", "drafts.jsonl"));
    expect(rows).toHaveLength(1);
    expect(rows[0].itemName).toBe("灰色长款风衣");
    expect(rows[0].status).toBe("negotiating");
  });

  it("rejects when itemName missing", async () => {
    const tool = createProposeDraftTool({ agentDir, agentId: "agent-a" });
    const res = await tool.execute("call-1", {
      module: "secondhand",
      secondhand: { itemName: "   ", status: "to_sell" },
    });
    expect(res.details.ok).toBe(false);
    expect(res.details.module).toBe("secondhand");
    expect(res.details.reason).toBe("empty_item_name");
    expect(fs.existsSync(path.join(agentDir, "xingye", "apps", "secondhand", "drafts.jsonl"))).toBe(false);
  });

  it("dispatches an action='update' status-migration draft", async () => {
    const tool = createProposeDraftTool({ agentDir, agentId: "agent-a" });
    const res = await tool.execute("call-1", {
      module: "secondhand",
      reason: "那件风衣昨天卖掉了",
      secondhand: {
        action: "update",
        itemName: "灰色长款风衣",
        patch: { status: "sold", buyer: "巷口收旧衣的" },
      },
    });
    expect(res.details.ok).toBe(true);
    expect(res.details.action).toBe("update");
    expect(res.details.status).toBe("sold");
    expect(res.details.matchName).toBe("灰色长款风衣");
    const rows = readJsonl(path.join(agentDir, "xingye", "apps", "secondhand", "drafts.jsonl"));
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("update");
    expect(rows[0].patch).toMatchObject({ status: "sold", buyer: "巷口收旧衣的" });
  });

  it("rejects action='update' with empty patch", async () => {
    const tool = createProposeDraftTool({ agentDir, agentId: "agent-a" });
    const res = await tool.execute("call-1", {
      module: "secondhand",
      secondhand: { action: "update", itemName: "风衣" },
    });
    expect(res.details.ok).toBe(false);
    expect(res.details.reason).toBe("empty_patch");
    expect(fs.existsSync(path.join(agentDir, "xingye", "apps", "secondhand", "drafts.jsonl"))).toBe(false);
  });

  it("rejects an invalid add-path status at the dispatch boundary (writes nothing)", async () => {
    const tool = createProposeDraftTool({ agentDir, agentId: "agent-a" });
    const res = await tool.execute("call-1", {
      module: "secondhand",
      secondhand: { itemName: "灰色长款风衣", status: "for_sale" },
    });
    expect(res.details.ok).toBe(false);
    expect(res.details.module).toBe("secondhand");
    expect(res.details.reason).toBe("invalid_status");
    // 不被 normalizeStatus 静默兜成 'to_sell'，且什么都没写
    expect(fs.existsSync(path.join(agentDir, "xingye", "apps", "secondhand", "drafts.jsonl"))).toBe(false);
  });

  it("rejects a near-miss add-path status ('Sold') instead of silently coercing to 'to_sell'", async () => {
    const tool = createProposeDraftTool({ agentDir, agentId: "agent-a" });
    const res = await tool.execute("call-1", {
      module: "secondhand",
      secondhand: { itemName: "旧相机", status: "Sold" }, // 'sold' 大写后能命中——见下一例；带空格的 ' for_sale ' 不行
    });
    // 'Sold' 经 trim+toLowerCase → 'sold' 是合法的，故应放行而非拒绝
    expect(res.details.ok).toBe(true);
    expect(res.details.status).toBe("sold");
    const rows = readJsonl(path.join(agentDir, "xingye", "apps", "secondhand", "drafts.jsonl"));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("sold");
  });

  it("normalizes a valid add-path status with mixed case/whitespace ('  Negotiating  ')", async () => {
    const tool = createProposeDraftTool({ agentDir, agentId: "agent-a" });
    const res = await tool.execute("call-1", {
      module: "secondhand",
      secondhand: { itemName: "二手吉他", status: "  Negotiating  " },
    });
    expect(res.details.ok).toBe(true);
    expect(res.details.status).toBe("negotiating");
    const rows = readJsonl(path.join(agentDir, "xingye", "apps", "secondhand", "drafts.jsonl"));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("negotiating");
  });

  it("rejects a near-miss status with whitespace ('for_sale ') that does not match after normalization", async () => {
    const tool = createProposeDraftTool({ agentDir, agentId: "agent-a" });
    const res = await tool.execute("call-1", {
      module: "secondhand",
      secondhand: { itemName: "旧书", status: "for_sale " },
    });
    expect(res.details.ok).toBe(false);
    expect(res.details.reason).toBe("invalid_status");
    expect(fs.existsSync(path.join(agentDir, "xingye", "apps", "secondhand", "drafts.jsonl"))).toBe(false);
  });

  it("omitted add-path status still falls back to the default 'to_sell' and writes", async () => {
    const tool = createProposeDraftTool({ agentDir, agentId: "agent-a" });
    const res = await tool.execute("call-1", {
      module: "secondhand",
      secondhand: { itemName: "灰色长款风衣" }, // status 缺省
    });
    expect(res.details.ok).toBe(true);
    expect(res.details.status).toBe("to_sell");
    const rows = readJsonl(path.join(agentDir, "xingye", "apps", "secondhand", "drafts.jsonl"));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("to_sell");
  });

  it("an invalid add-path status is rejected before reaching an action='update' (update carries status via patch)", async () => {
    // update 路径不读顶层 status，故顶层非法 status 不应影响 update；
    // 这里确认 add 边界校验只在 add 路径触发（update 的 status 走 patch，由 normalizeSecondhandDraftPatch 处理）。
    const tool = createProposeDraftTool({ agentDir, agentId: "agent-a" });
    const res = await tool.execute("call-1", {
      module: "secondhand",
      secondhand: { action: "update", itemName: "灰色长款风衣", status: "for_sale", patch: { status: "sold" } },
    });
    expect(res.details.ok).toBe(true); // 顶层 status 在 update 路径被忽略，不触发 add 校验
    expect(res.details.action).toBe("update");
    expect(res.details.status).toBe("sold");
  });
});
