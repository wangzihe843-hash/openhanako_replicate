import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  appendPhoneContactDraftServer,
  PHONE_CONTACT_DRAFT_ALLOWED_ACTIONS,
  PHONE_CONTACT_DRAFT_ALLOWED_FACTIONS,
} from "../lib/xingye/phone-contact-drafts.js";
import { createProposeDraftTool } from "../lib/tools/xingye-propose-draft-tool.js";

function mktemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hana-phone-contact-drafts-"));
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

describe("appendPhoneContactDraftServer · action=update", () => {
  it("writes a row to phone-contact/drafts.jsonl with normalized patch fields (default action=update)", async () => {
    const draft = await appendPhoneContactDraftServer({
      agentDir,
      agentId: "agent-a",
      input: {
        targetType: "virtual_contact",
        targetId: "vc-1",
        displayName: "  楼下小卖部老板娘  ",
        patch: {
          remark: "  楼下小卖部老板娘 / 周末才在  ",
          impression: "她每次接话都比我快半拍，我现在懒得搭。",
          relationshipHint: "  利益往来  ",
          tags: ["需要观察", "需要观察", "  ", "亲近的人"],
          faction: "中立",
        },
        reason: " 最近聊天反复出现 ",
        source: "xingye-heartbeat-tool",
        sourceEventIds: [" e-1 ", "", "e-2"],
      },
    });
    expect(draft).toMatchObject({
      action: "update",
      targetType: "virtual_contact",
      targetId: "vc-1",
      displayName: "楼下小卖部老板娘",
      patch: {
        remark: "楼下小卖部老板娘 / 周末才在",
        impression: "她每次接话都比我快半拍，我现在懒得搭。",
        relationshipHint: "利益往来",
        tags: ["需要观察", "亲近的人"],
        faction: "中立",
      },
      reason: "最近聊天反复出现",
      source: "xingye-heartbeat-tool",
      sourceEventIds: ["e-1", "e-2"],
    });
    const file = path.join(agentDir, "xingye", "phone-contact", "drafts.jsonl");
    const rows = readJsonl(file);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: draft.id, key: draft.id, action: "update" });
  });

  it("rejects when patch is empty after normalization (no eligible field)", async () => {
    const out = await appendPhoneContactDraftServer({
      agentDir,
      agentId: "agent-a",
      input: {
        action: "update",
        targetType: "agent",
        targetId: "a-1",
        patch: { remark: "   ", impression: "", tags: [] },
        source: "s",
      },
    });
    expect(out).toBeNull();
  });

  it("ignores disallowed patch fields (status / displayName / shortBio etc.)", async () => {
    const draft = await appendPhoneContactDraftServer({
      agentDir, agentId: "agent-a",
      input: {
        targetType: "user",
        targetId: "__user__",
        patch: {
          remark: "尊重边界",
          status: "blocked",
          displayName: "should-not-rename",
          shortBio: "should-not-set",
          linkedAgentId: "evil",
        },
        source: "s",
      },
    });
    expect(draft).not.toBeNull();
    expect(Object.keys(draft.patch).sort()).toEqual(["remark"]);
  });

  it("requires targetId for action=update", async () => {
    expect(await appendPhoneContactDraftServer({
      agentDir, agentId: "agent-a",
      input: { action: "update", targetType: "virtual_contact", patch: { remark: "r" }, source: "s" },
    })).toBeNull();
  });
});

describe("appendPhoneContactDraftServer · action=add (virtual_contact only)", () => {
  it("writes a row with normalized contact fields", async () => {
    const draft = await appendPhoneContactDraftServer({
      agentDir, agentId: "agent-a",
      input: {
        action: "add",
        targetType: "virtual_contact",
        contact: {
          displayName: "  夜班护士张姐  ",
          kind: "coworker",
          shortBio: "重症监护夜班轮值",
          impression: "话不多，但每次交接班都把单子核对干净。",
          tags: ["同伴", "需要观察"],
          faction: "中立",
          status: "active",
          generatedReason: "近期对话两次提到她交接班",
        },
        reason: "最近聊天两次提到她",
        source: "xingye-heartbeat-tool",
      },
    });
    expect(draft).toMatchObject({
      action: "add",
      targetType: "virtual_contact",
      displayName: "夜班护士张姐",
      contact: {
        displayName: "夜班护士张姐",
        kind: "coworker",
        shortBio: "重症监护夜班轮值",
        tags: ["同伴", "需要观察"],
        faction: "中立",
        status: "active",
      },
    });
  });

  it("rejects add for user / agent (security skip)", async () => {
    expect(await appendPhoneContactDraftServer({
      agentDir, agentId: "agent-a",
      input: { action: "add", targetType: "user", contact: { displayName: "x", kind: "friend" }, source: "s" },
    })).toBeNull();
    expect(await appendPhoneContactDraftServer({
      agentDir, agentId: "agent-a",
      input: { action: "add", targetType: "agent", contact: { displayName: "x", kind: "friend" }, source: "s" },
    })).toBeNull();
  });

  it("rejects add when contact.displayName missing", async () => {
    expect(await appendPhoneContactDraftServer({
      agentDir, agentId: "agent-a",
      input: { action: "add", targetType: "virtual_contact", contact: { kind: "friend" }, source: "s" },
    })).toBeNull();
  });

  it("normalizes unknown kind to 'unknown'", async () => {
    const draft = await appendPhoneContactDraftServer({
      agentDir, agentId: "agent-a",
      input: {
        action: "add",
        targetType: "virtual_contact",
        contact: { displayName: "X", kind: "wizard" },
        source: "s",
      },
    });
    expect(draft.contact.kind).toBe("unknown");
  });
});

describe("appendPhoneContactDraftServer · action=block/delete/restore (virtual_contact only)", () => {
  for (const action of ["block", "delete", "restore"]) {
    it(`writes a ${action} row with targetId`, async () => {
      const draft = await appendPhoneContactDraftServer({
        agentDir, agentId: "agent-a",
        input: { action, targetType: "virtual_contact", targetId: "vc-1", reason: `${action} reason`, source: "s" },
      });
      expect(draft).toMatchObject({ action, targetType: "virtual_contact", targetId: "vc-1" });
    });

    it(`writes a ${action} row with matchName fallback`, async () => {
      const draft = await appendPhoneContactDraftServer({
        agentDir, agentId: "agent-a",
        input: { action, targetType: "virtual_contact", matchName: "  老王  ", source: "s" },
      });
      expect(draft).toMatchObject({ action, targetType: "virtual_contact", matchName: "老王" });
    });

    it(`rejects ${action} on user (security skip)`, async () => {
      expect(await appendPhoneContactDraftServer({
        agentDir, agentId: "agent-a",
        input: { action, targetType: "user", targetId: "__user__", source: "s" },
      })).toBeNull();
    });

    it(`rejects ${action} on agent (security skip)`, async () => {
      expect(await appendPhoneContactDraftServer({
        agentDir, agentId: "agent-a",
        input: { action, targetType: "agent", targetId: "a-1", source: "s" },
      })).toBeNull();
    });

    it(`rejects ${action} when neither targetId nor matchName given`, async () => {
      expect(await appendPhoneContactDraftServer({
        agentDir, agentId: "agent-a",
        input: { action, targetType: "virtual_contact", source: "s" },
      })).toBeNull();
    });
  }
});

describe("appendPhoneContactDraftServer · misc", () => {
  it("rejects unknown action", async () => {
    expect(await appendPhoneContactDraftServer({
      agentDir, agentId: "agent-a",
      input: { action: "vaporize", targetType: "virtual_contact", targetId: "vc-1", patch: { remark: "x" }, source: "s" },
    })).toBeNull();
  });

  it("rejects empty agentId / invalid agentId / missing source", async () => {
    expect(await appendPhoneContactDraftServer({
      agentDir, agentId: "", input: { targetType: "user", targetId: "__user__", patch: { remark: "r" }, source: "s" },
    })).toBeNull();
    expect(await appendPhoneContactDraftServer({
      agentDir, agentId: "with space", input: { targetType: "user", targetId: "__user__", patch: { remark: "r" }, source: "s" },
    })).toBeNull();
    expect(await appendPhoneContactDraftServer({
      agentDir, agentId: "agent-a", input: { targetType: "user", targetId: "__user__", patch: { remark: "r" }, source: " " },
    })).toBeNull();
  });

  it("emits phone_contact.draft_proposed with action + targetType in payload", async () => {
    const draft = await appendPhoneContactDraftServer({
      agentDir, agentId: "agent-a",
      input: {
        action: "block",
        targetType: "virtual_contact",
        targetId: "vc-1",
        reason: "明确拒绝往来",
        source: "xingye-heartbeat-tool",
      },
    });
    const log = readJson(path.join(agentDir, "xingye", "events", "log.json"));
    const proposed = log.events.find((e) => e.type === "phone_contact.draft_proposed");
    expect(proposed).toBeTruthy();
    expect(proposed.subjectId).toBe(draft.id);
    expect(proposed.payload.action).toBe("block");
    expect(proposed.payload.targetType).toBe("virtual_contact");
    expect(proposed.payload.targetId).toBe("vc-1");
    expect(proposed.payload.reason).toBe("明确拒绝往来");
  });

  it("exposes the closed enums", () => {
    expect([...PHONE_CONTACT_DRAFT_ALLOWED_FACTIONS]).toEqual(["自己人", "中立", "对立", "未知"]);
    expect([...PHONE_CONTACT_DRAFT_ALLOWED_ACTIONS]).toEqual(["update", "add", "block", "delete", "restore"]);
  });
});

describe("createProposeDraftTool dispatch: module=phone_contact", () => {
  it("rejects missing payload", async () => {
    const tool = createProposeDraftTool({ agentDir, agentId: "agent-a" });
    const result = await tool.execute("call-1", { module: "phone_contact" });
    expect(result.details.ok).toBe(false);
    expect(result.details.reason).toBe("missing_payload");
  });

  it("rejects bad targetType", async () => {
    const tool = createProposeDraftTool({ agentDir, agentId: "agent-a" });
    const result = await tool.execute("call-1", {
      module: "phone_contact",
      phone_contact: { targetType: "channel", targetId: "x", patch: { remark: "r" } },
    });
    expect(result.details.ok).toBe(false);
    expect(result.details.reason).toBe("target_type_not_allowed");
  });

  it("rejects bad action", async () => {
    const tool = createProposeDraftTool({ agentDir, agentId: "agent-a" });
    const result = await tool.execute("call-1", {
      module: "phone_contact",
      phone_contact: { action: "vaporize", targetType: "virtual_contact", targetId: "vc-1" },
    });
    expect(result.details.ok).toBe(false);
    expect(result.details.reason).toBe("action_not_allowed");
  });

  it("rejects add for user / agent", async () => {
    const tool = createProposeDraftTool({ agentDir, agentId: "agent-a" });
    for (const targetType of ["user", "agent"]) {
      const result = await tool.execute(`call-add-${targetType}`, {
        module: "phone_contact",
        phone_contact: { action: "add", targetType, contact: { displayName: "x", kind: "friend" } },
      });
      expect(result.details.ok).toBe(false);
      expect(result.details.reason).toBe("action_not_allowed_for_target_type");
    }
  });

  it("rejects block/delete/restore for user / agent", async () => {
    const tool = createProposeDraftTool({ agentDir, agentId: "agent-a" });
    for (const targetType of ["user", "agent"]) {
      for (const action of ["block", "delete", "restore"]) {
        const result = await tool.execute(`call-${action}-${targetType}`, {
          module: "phone_contact",
          phone_contact: { action, targetType, targetId: targetType === "user" ? "__user__" : "a-1" },
        });
        expect(result.details.ok).toBe(false);
        expect(result.details.reason).toBe("action_not_allowed_for_target_type");
      }
    }
  });

  it("rejects update without targetId", async () => {
    const tool = createProposeDraftTool({ agentDir, agentId: "agent-a" });
    const result = await tool.execute("call-1", {
      module: "phone_contact",
      phone_contact: { action: "update", targetType: "virtual_contact", patch: { remark: "r" } },
    });
    expect(result.details.ok).toBe(false);
    expect(result.details.reason).toBe("missing_target_id");
  });

  it("rejects update without patch", async () => {
    const tool = createProposeDraftTool({ agentDir, agentId: "agent-a" });
    const result = await tool.execute("call-1", {
      module: "phone_contact",
      phone_contact: { action: "update", targetType: "user", targetId: "__user__" },
    });
    expect(result.details.ok).toBe(false);
    expect(result.details.reason).toBe("missing_patch");
  });

  it("rejects add without contact", async () => {
    const tool = createProposeDraftTool({ agentDir, agentId: "agent-a" });
    const result = await tool.execute("call-1", {
      module: "phone_contact",
      phone_contact: { action: "add", targetType: "virtual_contact" },
    });
    expect(result.details.ok).toBe(false);
    expect(result.details.reason).toBe("missing_contact");
  });

  it("rejects block/delete/restore without targetId AND without matchName", async () => {
    const tool = createProposeDraftTool({ agentDir, agentId: "agent-a" });
    for (const action of ["block", "delete", "restore"]) {
      const result = await tool.execute(`call-${action}`, {
        module: "phone_contact",
        phone_contact: { action, targetType: "virtual_contact" },
      });
      expect(result.details.ok).toBe(false);
      expect(result.details.reason).toBe("missing_target_identifier");
    }
  });

  it("writes update draft on happy path (user contact)", async () => {
    const tool = createProposeDraftTool({ agentDir, agentId: "agent-a" });
    const result = await tool.execute("call-1", {
      module: "phone_contact",
      reason: "user 最近主动留下来等吃完饭——我现在觉得不用再绕弯讲了。",
      phone_contact: {
        action: "update",
        targetType: "user",
        targetId: "__user__",
        displayName: "user",
        patch: {
          impression: "她最近会主动留下，我开始放松一些。",
          tags: ["尊重边界", "愿意配合"],
        },
      },
    });
    expect(result.details.ok).toBe(true);
    expect(result.details.action).toBe("update");
    expect(result.details.patchFields.sort()).toEqual(["impression", "tags"]);
  });

  it("writes add draft on happy path (virtual_contact)", async () => {
    const tool = createProposeDraftTool({ agentDir, agentId: "agent-a" });
    const result = await tool.execute("call-1", {
      module: "phone_contact",
      reason: "近期聊天两次提到她",
      phone_contact: {
        action: "add",
        targetType: "virtual_contact",
        contact: {
          displayName: "夜班护士张姐",
          kind: "coworker",
          impression: "话不多但每次交接班把单子核对干净",
          tags: ["同伴"],
          faction: "中立",
          generatedReason: "聊天里两次出现",
        },
      },
    });
    expect(result.details.ok).toBe(true);
    expect(result.details.action).toBe("add");
    expect(result.details.hasContact).toBe(true);
  });

  it("writes block draft on happy path (virtual_contact, with matchName fallback)", async () => {
    const tool = createProposeDraftTool({ agentDir, agentId: "agent-a" });
    const result = await tool.execute("call-1", {
      module: "phone_contact",
      reason: "她最近反复半夜骚扰电话，明确拒绝过仍打来",
      phone_contact: {
        action: "block",
        targetType: "virtual_contact",
        matchName: "前同事陈姐",
      },
    });
    expect(result.details.ok).toBe(true);
    expect(result.details.action).toBe("block");
    expect(result.details.matchName).toBe("前同事陈姐");
  });
});
