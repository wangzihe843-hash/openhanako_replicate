import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  appendSecretSpaceDraftServer,
  SECRET_SPACE_DRAFT_ALLOWED_CATEGORIES,
} from "../lib/xingye/secret-space-drafts.js";
import { createProposeDraftTool } from "../lib/tools/xingye-propose-draft-tool.js";

function mktemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hana-ss-drafts-"));
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

describe("SECRET_SPACE_DRAFT_ALLOWED_CATEGORIES", () => {
  it("only includes the safe text-only subset", () => {
    /** 与 desktop 端 xingye-secret-space-drafts.ts 的常量保持同步。 */
    expect([...SECRET_SPACE_DRAFT_ALLOWED_CATEGORIES]).toEqual(["state", "dream", "saved_item"]);
  });
});

describe("appendSecretSpaceDraftServer", () => {
  it("writes a row to secret-space/drafts.jsonl with required fields", async () => {
    const draft = await appendSecretSpaceDraftServer({
      agentDir,
      agentId: "agent-a",
      input: {
        category: "dream",
        title: "  站台等车  ",
        body: "  车一直没来。雨开始下，但伞撑不开。  ",
        tags: [" 车 ", "", "雨"],
        reason: "早上聊到昨夜的梦",
        source: "xingye-heartbeat-tool",
        sourceEventIds: [" e-1 ", "", "e-2"],
      },
    });
    expect(draft).toMatchObject({
      category: "dream",
      title: "站台等车",
      body: "车一直没来。雨开始下，但伞撑不开。",
      tags: ["车", "雨"],
      source: "xingye-heartbeat-tool",
      sourceEventIds: ["e-1", "e-2"],
    });
    const file = path.join(agentDir, "xingye", "secret-space", "drafts.jsonl");
    const rows = readJsonl(file);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: draft.id, key: draft.id });
  });

  it("emits secret_space.draft_proposed in xingye event log", async () => {
    const draft = await appendSecretSpaceDraftServer({
      agentDir,
      agentId: "agent-a",
      input: {
        category: "state",
        body: "今晚听她说完那句话，胸口像被人轻轻按住。",
        source: "xingye-heartbeat-tool",
      },
    });
    const log = readJson(path.join(agentDir, "xingye", "events", "log.json"));
    const proposed = log.events.find((e) => e.type === "secret_space.draft_proposed");
    expect(proposed).toBeTruthy();
    expect(proposed.subjectId).toBe(draft.id);
    expect(proposed.payload.category).toBe("state");
  });

  it("rejects disallowed categories (draft_reply / unsent_moment / memory_fragment / anything else)", async () => {
    for (const banned of ["draft_reply", "unsent_moment", "memory_fragment", "nonsense", ""]) {
      const result = await appendSecretSpaceDraftServer({
        agentDir,
        agentId: "agent-a",
        input: { category: banned, body: "x", source: "s" },
      });
      expect(result).toBeNull();
    }
  });

  it("does NOT write secret-space/{category}.jsonl", async () => {
    await appendSecretSpaceDraftServer({
      agentDir,
      agentId: "agent-a",
      input: { category: "state", body: "x", source: "xingye-heartbeat-tool" },
    });
    expect(fs.existsSync(path.join(agentDir, "xingye", "secret-space", "state.jsonl"))).toBe(false);
  });

  it("returns null on empty body, empty source, or invalid agentId", async () => {
    expect(await appendSecretSpaceDraftServer({
      agentDir, agentId: "agent-a",
      input: { category: "state", body: "  ", source: "s" },
    })).toBeNull();
    expect(await appendSecretSpaceDraftServer({
      agentDir, agentId: "agent-a",
      input: { category: "state", body: "x", source: "" },
    })).toBeNull();
    expect(await appendSecretSpaceDraftServer({
      agentDir, agentId: "bad id!",
      input: { category: "state", body: "x", source: "s" },
    })).toBeNull();
  });
});

describe("createProposeDraftTool · module=secret_space", () => {
  it("dispatches secret_space case and writes draft", async () => {
    const tool = createProposeDraftTool({ agentDir, agentId: "agent-a" });
    const res = await tool.execute("call-1", {
      module: "secret_space",
      reason: "她转述老师的一句话",
      secret_space: {
        category: "saved_item",
        title: "老师讲过的一句话",
        body: "「不要把日子过成一道证明题。」",
        tags: ["句子"],
      },
    });
    expect(res.details.ok).toBe(true);
    expect(res.details.module).toBe("secret_space");
    expect(res.details.category).toBe("saved_item");
    const rows = readJsonl(path.join(agentDir, "xingye", "secret-space", "drafts.jsonl"));
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toBe("「不要把日子过成一道证明题。」");
  });

  it("rejects disallowed category at the tool boundary", async () => {
    const tool = createProposeDraftTool({ agentDir, agentId: "agent-a" });
    const res = await tool.execute("call-1", {
      module: "secret_space",
      secret_space: { category: "memory_fragment", body: "x" },
    });
    expect(res.details.ok).toBe(false);
    expect(res.details.reason).toBe("category_not_allowed");
    expect(fs.existsSync(path.join(agentDir, "xingye", "secret-space", "drafts.jsonl"))).toBe(false);
  });

  it("rejects when body missing for allowed category", async () => {
    const tool = createProposeDraftTool({ agentDir, agentId: "agent-a" });
    const res = await tool.execute("call-1", {
      module: "secret_space",
      secret_space: { category: "dream", body: "   " },
    });
    expect(res.details.ok).toBe(false);
    expect(res.details.reason).toBe("empty_body");
  });
});
