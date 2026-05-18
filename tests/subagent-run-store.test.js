import fs from "fs";
import os from "os";
import path from "path";
import { beforeEach, describe, expect, it } from "vitest";
import { SubagentRunStore } from "../lib/subagent-run-store.js";

describe("SubagentRunStore", () => {
  let tempDir;
  let storePath;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-subagent-runs-"));
    storePath = path.join(tempDir, "subagent-runs.json");
  });

  it("persists taskId to child session mapping independently of deferred delivery state", () => {
    const store = new SubagentRunStore(storePath);

    store.register("subagent-1", {
      parentSessionPath: "/agents/hana/sessions/parent.jsonl",
      summary: "校准脚本",
      requestedAgentId: "hanako",
      requestedAgentNameSnapshot: "小花",
    });
    store.attachSession("subagent-1", "/agents/hana/subagent-sessions/child.jsonl", {
      executorAgentId: "hanako",
      executorAgentNameSnapshot: "小花",
      executorMetaVersion: 1,
    });
    store.resolve("subagent-1", "完成摘要");

    const restored = new SubagentRunStore(storePath);
    expect(restored.query("subagent-1")).toMatchObject({
      taskId: "subagent-1",
      parentSessionPath: "/agents/hana/sessions/parent.jsonl",
      childSessionPath: "/agents/hana/subagent-sessions/child.jsonl",
      status: "resolved",
      summary: "完成摘要",
      requestedAgentId: "hanako",
      executorAgentId: "hanako",
      executorAgentNameSnapshot: "小花",
    });
  });
});
