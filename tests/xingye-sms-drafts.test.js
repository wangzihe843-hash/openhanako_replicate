import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  appendSmsDraftServer,
  SMS_DRAFT_ALLOWED_TARGET_TYPES,
} from "../lib/xingye/sms-drafts.js";
import { createProposeDraftTool } from "../lib/tools/xingye-propose-draft-tool.js";

function mktemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hana-sms-drafts-"));
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

describe("SMS_DRAFT_ALLOWED_TARGET_TYPES", () => {
  it("only allows agent / virtual_contact (NOT user)", () => {
    /** 与 desktop 端 xingye-sms-drafts.ts 的常量保持同步。
     * 不允许 user：agent 不应绕过 user 直接发短信；想跟 user 说话走正常对话。 */
    expect([...SMS_DRAFT_ALLOWED_TARGET_TYPES]).toEqual(["agent", "virtual_contact"]);
  });
});

describe("appendSmsDraftServer", () => {
  it("writes a row to apps/sms/drafts.jsonl with targetType/targetId/content fields", async () => {
    const draft = await appendSmsDraftServer({
      agentDir,
      agentId: "agent-a",
      input: {
        targetType: "virtual_contact",
        targetId: "vc-nurse-li",
        displayName: "李护士",
        content: "  李姐今天换班吗？  ",
        reason: "聊到诊所换班",
        source: "xingye-heartbeat-tool",
        sourceEventIds: [" e-1 ", "", "e-2"],
      },
    });
    expect(draft).toMatchObject({
      targetType: "virtual_contact",
      targetId: "vc-nurse-li",
      displayName: "李护士",
      content: "李姐今天换班吗？",
      source: "xingye-heartbeat-tool",
      sourceEventIds: ["e-1", "e-2"],
    });
    const file = path.join(agentDir, "xingye", "apps", "sms", "drafts.jsonl");
    const rows = readJsonl(file);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: draft.id, key: draft.id });
  });

  it("accepts matchName when targetId not provided", async () => {
    const draft = await appendSmsDraftServer({
      agentDir,
      agentId: "agent-a",
      input: {
        targetType: "agent",
        matchName: "苏师姐",
        displayName: "苏师姐",
        content: "之前那件事，等回去再当面说一下。",
        source: "xingye-heartbeat-tool",
      },
    });
    expect(draft).not.toBeNull();
    expect(draft.matchName).toBe("苏师姐");
    expect(draft.targetId).toBeUndefined();
  });

  it("emits sms.draft_proposed in xingye event log", async () => {
    const draft = await appendSmsDraftServer({
      agentDir,
      agentId: "agent-a",
      input: {
        targetType: "virtual_contact",
        targetId: "vc-x",
        content: "今晚一起吃饭吗？",
        source: "xingye-heartbeat-tool",
      },
    });
    const log = readJson(path.join(agentDir, "xingye", "events", "log.json"));
    const proposed = log.events.find((e) => e.type === "sms.draft_proposed");
    expect(proposed).toBeTruthy();
    expect(proposed.subjectId).toBe(draft.id);
    expect(proposed.payload.targetType).toBe("virtual_contact");
    expect(proposed.payload.targetId).toBe("vc-x");
  });

  it("rejects targetType=user (agent should not bypass user)", async () => {
    const result = await appendSmsDraftServer({
      agentDir,
      agentId: "agent-a",
      input: {
        targetType: "user",
        targetId: "__user__",
        content: "hi",
        source: "s",
      },
    });
    expect(result).toBeNull();
  });

  it("rejects unknown targetType", async () => {
    for (const banned of ["other", "", "USER"]) {
      const result = await appendSmsDraftServer({
        agentDir,
        agentId: "agent-a",
        input: { targetType: banned, targetId: "x", content: "y", source: "s" },
      });
      expect(result).toBeNull();
    }
  });

  it("requires targetId or matchName (at least one)", async () => {
    const result = await appendSmsDraftServer({
      agentDir,
      agentId: "agent-a",
      input: {
        targetType: "virtual_contact",
        content: "hi",
        source: "s",
      },
    });
    expect(result).toBeNull();
  });

  it("rejects empty content, empty source, or invalid agentId", async () => {
    expect(await appendSmsDraftServer({
      agentDir, agentId: "agent-a",
      input: { targetType: "agent", targetId: "x", content: "  ", source: "s" },
    })).toBeNull();
    expect(await appendSmsDraftServer({
      agentDir, agentId: "agent-a",
      input: { targetType: "agent", targetId: "x", content: "y", source: "" },
    })).toBeNull();
    expect(await appendSmsDraftServer({
      agentDir, agentId: "bad id!",
      input: { targetType: "agent", targetId: "x", content: "y", source: "s" },
    })).toBeNull();
  });

  it("truncates content beyond 240 chars", async () => {
    const huge = "测".repeat(300);
    const draft = await appendSmsDraftServer({
      agentDir,
      agentId: "agent-a",
      input: {
        targetType: "virtual_contact",
        targetId: "vc-x",
        content: huge,
        source: "s",
      },
    });
    expect(draft.content.length).toBe(240);
  });

  describe("dedupe (24h 同对方 exact_dup)", () => {
    it("命中 exact_dup → 不写新行，返回原草稿 + duplicateOf", async () => {
      const first = await appendSmsDraftServer({
        agentDir,
        agentId: "agent-a",
        input: {
          targetType: "virtual_contact",
          targetId: "vc-linwu",
          content: "在吗？",
          source: "s",
        },
      });
      expect(first.duplicateOf).toBeUndefined();

      const second = await appendSmsDraftServer({
        agentDir,
        agentId: "agent-a",
        input: {
          targetType: "virtual_contact",
          targetId: "vc-linwu",
          content: "在吗？",
          source: "s",
        },
      });
      expect(second.duplicateOf).toBe(first.id);
      expect(second.id).toBe(first.id);

      /** 文件只有一行——dup 没追加。 */
      const rows = readJsonl(path.join(agentDir, "xingye", "apps", "sms", "drafts.jsonl"));
      expect(rows).toHaveLength(1);
    });

    it("normalize 后相同（全角/标点）也算 exact_dup", async () => {
      const first = await appendSmsDraftServer({
        agentDir,
        agentId: "agent-a",
        input: {
          targetType: "virtual_contact",
          targetId: "vc-linwu",
          content: "在吗?",
          source: "s",
        },
      });
      const second = await appendSmsDraftServer({
        agentDir,
        agentId: "agent-a",
        input: {
          targetType: "virtual_contact",
          targetId: "vc-linwu",
          content: "在吗？", // 全角问号
          source: "s",
        },
      });
      expect(second.duplicateOf).toBe(first.id);
    });

    it("跨对方不算重（同句话给不同对方各写一条）", async () => {
      await appendSmsDraftServer({
        agentDir, agentId: "agent-a",
        input: { targetType: "virtual_contact", targetId: "vc-linwu", content: "在吗？", source: "s" },
      });
      const second = await appendSmsDraftServer({
        agentDir, agentId: "agent-a",
        input: { targetType: "virtual_contact", targetId: "vc-master", content: "在吗？", source: "s" },
      });
      expect(second.duplicateOf).toBeUndefined();
      const rows = readJsonl(path.join(agentDir, "xingye", "apps", "sms", "drafts.jsonl"));
      expect(rows).toHaveLength(2);
    });
  });
});

describe("createProposeDraftTool · module=sms", () => {
  it("dispatches sms case and writes draft (targetType=virtual_contact + targetId)", async () => {
    const tool = createProposeDraftTool({ agentDir, agentId: "agent-a" });
    const res = await tool.execute("call-1", {
      module: "sms",
      reason: "聊到诊所换班",
      sms: {
        targetType: "virtual_contact",
        targetId: "vc-nurse-li",
        displayName: "李护士",
        content: "李姐今天换班吗？我下午想过去一趟。",
      },
    });
    expect(res.details.ok).toBe(true);
    expect(res.details.module).toBe("sms");
    expect(res.details.targetType).toBe("virtual_contact");
    expect(res.details.targetId).toBe("vc-nurse-li");
    const rows = readJsonl(path.join(agentDir, "xingye", "apps", "sms", "drafts.jsonl"));
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe("李姐今天换班吗？我下午想过去一趟。");
  });

  it("dispatches sms case with matchName fallback (targetType=agent)", async () => {
    const tool = createProposeDraftTool({ agentDir, agentId: "agent-a" });
    const res = await tool.execute("call-1", {
      module: "sms",
      sms: {
        targetType: "agent",
        matchName: "苏师姐",
        displayName: "苏师姐",
        content: "之前那件事是我没考虑周全。",
      },
    });
    expect(res.details.ok).toBe(true);
    expect(res.details.matchName).toBe("苏师姐");
    expect(res.details.targetId).toBeNull();
  });

  it("rejects targetType=user at the tool boundary", async () => {
    const tool = createProposeDraftTool({ agentDir, agentId: "agent-a" });
    const res = await tool.execute("call-1", {
      module: "sms",
      sms: { targetType: "user", targetId: "__user__", content: "hi" },
    });
    expect(res.details.ok).toBe(false);
    expect(res.details.reason).toBe("target_type_not_allowed");
    expect(fs.existsSync(path.join(agentDir, "xingye", "apps", "sms", "drafts.jsonl"))).toBe(false);
  });

  it("rejects when neither targetId nor matchName provided", async () => {
    const tool = createProposeDraftTool({ agentDir, agentId: "agent-a" });
    const res = await tool.execute("call-1", {
      module: "sms",
      sms: { targetType: "virtual_contact", content: "hi" },
    });
    expect(res.details.ok).toBe(false);
    expect(res.details.reason).toBe("missing_target_identifier");
  });

  it("rejects when content is empty", async () => {
    const tool = createProposeDraftTool({ agentDir, agentId: "agent-a" });
    const res = await tool.execute("call-1", {
      module: "sms",
      sms: { targetType: "agent", targetId: "x", content: "   " },
    });
    expect(res.details.ok).toBe(false);
    expect(res.details.reason).toBe("empty_content");
  });
});
