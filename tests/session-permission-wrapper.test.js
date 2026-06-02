import { describe, expect, it, vi } from "vitest";
import { wrapWithSessionPermission } from "../lib/tools/session-permission-wrapper.js";

const ctx = {
  sessionManager: { getSessionFile: () => "/tmp/session.jsonl" },
};

function makeTool(name = "write") {
  return {
    name,
    execute: vi.fn(async () => ({
      content: [{ type: "text", text: "executed" }],
      details: { executed: true },
    })),
  };
}

describe("session permission wrapper", () => {
  it("blocks side-effect tools in read-only mode", async () => {
    const tool = makeTool("write");
    const [wrapped] = wrapWithSessionPermission([tool], {
      getPermissionMode: () => "read_only",
    });

    const result = await wrapped.execute("call-1", { path: "x" }, null, null, ctx);

    expect(tool.execute).not.toHaveBeenCalled();
    expect(result.details.errorCode).toBe("ACTION_BLOCKED_BY_READ_ONLY");
  });

  it("asks before running side-effect tools in ask mode", async () => {
    const tool = makeTool("write");
    const emitted = [];
    const confirmStore = {
      create: vi.fn(() => ({
        confirmId: "confirm-tool-1",
        promise: Promise.resolve({ action: "confirmed" }),
      })),
    };
    const [wrapped] = wrapWithSessionPermission([tool], {
      getPermissionMode: () => "ask",
      getConfirmStore: () => confirmStore,
      emitEvent: (event, sessionPath) => emitted.push({ event, sessionPath }),
    });

    const result = await wrapped.execute("call-1", { path: "x" }, null, null, ctx);

    expect(confirmStore.create).toHaveBeenCalledWith(
      "tool_action_approval",
      expect.objectContaining({ toolName: "write" }),
      "/tmp/session.jsonl",
    );
    expect(emitted[0]).toMatchObject({
      sessionPath: "/tmp/session.jsonl",
      event: {
        type: "session_confirmation",
        request: {
          type: "session_confirmation",
          kind: "tool_action_approval",
          status: "pending",
        },
      },
    });
    expect(tool.execute).toHaveBeenCalledOnce();
    expect(result.details.executed).toBe(true);
  });

  it("does not run side-effect tools when ask mode is rejected", async () => {
    const tool = makeTool("write");
    const confirmStore = {
      create: vi.fn(() => ({
        confirmId: "confirm-tool-1",
        promise: Promise.resolve({ action: "rejected" }),
      })),
    };
    const [wrapped] = wrapWithSessionPermission([tool], {
      getPermissionMode: () => "ask",
      getConfirmStore: () => confirmStore,
      emitEvent: vi.fn(),
    });

    const result = await wrapped.execute("call-1", { path: "x" }, null, null, ctx);

    expect(tool.execute).not.toHaveBeenCalled();
    expect(result.details.confirmed).toBe(false);
  });

  // ---- 甲（Codex 式）端到端：permissionContext 透传到 classify ----

  it("subagent 上下文拦 subagent 工具（防自递归），即便 operate 全放行也拦，真实工具不执行", async () => {
    const tool = makeTool("subagent");
    const [wrapped] = wrapWithSessionPermission([tool], {
      getPermissionMode: () => "operate", // 即便最宽松的 operate
      permissionContext: { isSubagent: true },
    });
    const result = await wrapped.execute("call-1", { task: "递归" }, null, null, ctx);
    expect(tool.execute).not.toHaveBeenCalled();
    expect(result.details.errorCode).toBe("ACTION_BLOCKED_IN_SUBAGENT");
  });

  it("subagent 上下文 + read-only：write 被拦、read 放行（探索者只读档的执行层证明）", async () => {
    const write = makeTool("write");
    const read = makeTool("read");
    const [wWrite, wRead] = wrapWithSessionPermission([write, read], {
      getPermissionMode: () => "read_only",
      permissionContext: { isSubagent: true },
    });
    const wr = await wWrite.execute("c1", { path: "x" }, null, null, ctx);
    const rd = await wRead.execute("c2", { path: "x" }, null, null, ctx);
    expect(write.execute).not.toHaveBeenCalled();
    expect(wr.details.errorCode).toBe("ACTION_BLOCKED_BY_READ_ONLY");
    expect(read.execute).toHaveBeenCalledOnce();
    expect(rd.details.executed).toBe(true);
  });

  it("对照：无 permissionContext 时 subagent 工具在 operate 下正常执行", async () => {
    const tool = makeTool("subagent");
    const [wrapped] = wrapWithSessionPermission([tool], {
      getPermissionMode: () => "operate",
    });
    const result = await wrapped.execute("call-1", { task: "x" }, null, null, ctx);
    expect(tool.execute).toHaveBeenCalledOnce();
    expect(result.details.executed).toBe(true);
  });
});
