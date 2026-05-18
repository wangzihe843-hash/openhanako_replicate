import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  appendPhoneContactDraftServer,
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

describe("appendPhoneContactDraftServer", () => {
  it("writes a row to phone-contact/drafts.jsonl with normalized patch fields", async () => {
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
    expect(rows[0]).toMatchObject({ id: draft.id, key: draft.id });
  });

  it("rejects when patch is empty after normalization (no eligible field)", async () => {
    const out = await appendPhoneContactDraftServer({
      agentDir,
      agentId: "agent-a",
      input: {
        targetType: "agent",
        targetId: "a-1",
        patch: { remark: "   ", impression: "", tags: [] },
        source: "s",
      },
    });
    expect(out).toBeNull();
  });

  it("drops disallowed faction values (no patch left → null)", async () => {
    const out = await appendPhoneContactDraftServer({
      agentDir,
      agentId: "agent-a",
      input: {
        targetType: "agent",
        targetId: "a-1",
        patch: { faction: "搞笑" },
        source: "s",
      },
    });
    expect(out).toBeNull();
  });

  it("rejects unknown targetType", async () => {
    expect(await appendPhoneContactDraftServer({
      agentDir, agentId: "agent-a",
      input: {
        targetType: "channel", targetId: "x", patch: { remark: "r" }, source: "s",
      },
    })).toBeNull();
  });

  it("rejects empty agentId / invalid agentId / missing source / missing targetId", async () => {
    expect(await appendPhoneContactDraftServer({
      agentDir, agentId: "", input: { targetType: "user", targetId: "__user__", patch: { remark: "r" }, source: "s" },
    })).toBeNull();
    expect(await appendPhoneContactDraftServer({
      agentDir, agentId: "with space", input: { targetType: "user", targetId: "__user__", patch: { remark: "r" }, source: "s" },
    })).toBeNull();
    expect(await appendPhoneContactDraftServer({
      agentDir, agentId: "agent-a", input: { targetType: "user", targetId: "__user__", patch: { remark: "r" }, source: " " },
    })).toBeNull();
    expect(await appendPhoneContactDraftServer({
      agentDir, agentId: "agent-a", input: { targetType: "user", targetId: " ", patch: { remark: "r" }, source: "s" },
    })).toBeNull();
  });

  it("ignores disallowed patch fields (status / displayName / shortBio etc.) — only the 5 whitelisted fields land in stored patch", async () => {
    const draft = await appendPhoneContactDraftServer({
      agentDir, agentId: "agent-a",
      input: {
        targetType: "user",
        targetId: "__user__",
        patch: {
          remark: "尊重边界",
          status: "blocked",         // disallowed — should be ignored
          displayName: "should-not-rename",
          shortBio: "should-not-set",
          linkedAgentId: "evil",
          kind: "stranger",
          avatarDataUrl: "data:bad",
        },
        source: "s",
      },
    });
    expect(draft).not.toBeNull();
    expect(Object.keys(draft.patch).sort()).toEqual(["remark"]);
  });

  it("emits phone_contact.draft_proposed with patchFields in payload", async () => {
    const draft = await appendPhoneContactDraftServer({
      agentDir, agentId: "agent-a",
      input: {
        targetType: "virtual_contact", targetId: "vc-1",
        patch: { impression: "I", faction: "自己人" },
        reason: "R", source: "xingye-heartbeat-tool",
      },
    });
    const log = readJson(path.join(agentDir, "xingye", "events", "log.json"));
    const proposed = log.events.find((e) => e.type === "phone_contact.draft_proposed");
    expect(proposed).toBeTruthy();
    expect(proposed.subjectId).toBe(draft.id);
    expect(proposed.payload.targetType).toBe("virtual_contact");
    expect(proposed.payload.targetId).toBe("vc-1");
    expect(proposed.payload.patchFields.sort()).toEqual(["faction", "impression"]);
    expect(proposed.payload.reason).toBe("R");
  });

  it("exposes the closed faction enum", () => {
    expect([...PHONE_CONTACT_DRAFT_ALLOWED_FACTIONS]).toEqual(["自己人", "中立", "对立", "未知"]);
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

  it("rejects missing targetId", async () => {
    const tool = createProposeDraftTool({ agentDir, agentId: "agent-a" });
    const result = await tool.execute("call-1", {
      module: "phone_contact",
      phone_contact: { targetType: "user", targetId: "  ", patch: { remark: "r" } },
    });
    expect(result.details.ok).toBe(false);
    expect(result.details.reason).toBe("missing_target_id");
  });

  it("rejects missing patch object", async () => {
    const tool = createProposeDraftTool({ agentDir, agentId: "agent-a" });
    const result = await tool.execute("call-1", {
      module: "phone_contact",
      phone_contact: { targetType: "user", targetId: "__user__" },
    });
    expect(result.details.ok).toBe(false);
    expect(result.details.reason).toBe("missing_patch");
  });

  it("rejects empty-after-normalize patch (validation_failed)", async () => {
    const tool = createProposeDraftTool({ agentDir, agentId: "agent-a" });
    const result = await tool.execute("call-1", {
      module: "phone_contact",
      phone_contact: { targetType: "agent", targetId: "a-1", patch: { tags: [], faction: "搞笑" } },
    });
    expect(result.details.ok).toBe(false);
    expect(result.details.reason).toBe("validation_failed");
  });

  it("writes draft on happy path (user contact, agent-视角 impression)", async () => {
    const tool = createProposeDraftTool({ agentDir, agentId: "agent-a" });
    const result = await tool.execute("call-1", {
      module: "phone_contact",
      reason: "user 最近主动留下来等吃完饭——我现在觉得不用再绕弯讲了。",
      phone_contact: {
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
    expect(result.details.module).toBe("phone_contact");
    expect(result.details.targetType).toBe("user");
    expect(result.details.targetId).toBe("__user__");
    expect(result.details.patchFields.sort()).toEqual(["impression", "tags"]);
    const rows = readJsonl(path.join(agentDir, "xingye", "phone-contact", "drafts.jsonl"));
    expect(rows).toHaveLength(1);
    expect(rows[0].patch.impression).toBe("她最近会主动留下，我开始放松一些。");
    expect(rows[0].patch.tags).toEqual(["尊重边界", "愿意配合"]);
  });
});
