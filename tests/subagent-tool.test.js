import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSubagentTool, composeReuseKey } from "../lib/tools/subagent-tool.js";
import { ReusableSubagentStore } from "../lib/reusable-subagent-store.js";

// ---- helpers ----------------------------------------------------------------

/** Mock Pi SDK ctx with sessionManager */
const mockCtx = (sp = "/test/session.jsonl", cwd = undefined) => ({
  sessionManager: {
    getSessionFile: () => sp,
    ...(cwd ? { getCwd: () => cwd } : {}),
  },
});

/**
 * Build a mock executeIsolated that:
 *  - calls opts.onSessionReady(sessionPath) synchronously if provided
 *  - resolves with the given result
 */
function makeExecuteIsolated(
  result = { replyText: "done", error: null, sessionPath: "/test/child.jsonl" },
) {
  return vi.fn().mockImplementation((_prompt, opts) => {
    if (typeof opts?.onSessionReady === "function") {
      opts.onSessionReady("/test/child.jsonl");
    }
    return Promise.resolve(result);
  });
}

function makeDeps(overrides = {}) {
  return {
    executeIsolated: makeExecuteIsolated(),
    resolveUtilityModel: () => "utility-model",
    getDeferredStore: () => ({
      defer: vi.fn(),
      resolve: vi.fn(),
      fail: vi.fn(),
      query: vi.fn(() => ({ meta: {} })),
      _save: vi.fn(),
    }),
    getSessionPath: () => "/test/session.jsonl",
    listAgents: vi.fn(() => [
      { id: "hana", name: "Hana", model: "claude-3-5-sonnet", summary: "主 agent" },
      { id: "other-agent", name: "Other", model: "gpt-4", summary: "专家 agent" },
    ]),
    currentAgentId: "hana",
    agentDir: "/test/agents/hana",
    emitEvent: vi.fn(),
    persistSubagentSessionMeta: vi.fn(async () => {}),
    getSubagentRunStore: () => null,
    ...overrides,
  };
}

// ---- tests ------------------------------------------------------------------

describe("subagent-tool (executeIsolated 原子模式)", () => {
  let mockStore;
  let deps;

  beforeEach(() => {
    mockStore = { defer: vi.fn(), resolve: vi.fn(), fail: vi.fn(), query: vi.fn(() => ({ meta: {} })), _save: vi.fn() };
    deps = makeDeps({ getDeferredStore: () => mockStore });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // 1. fire-and-forget: returns immediately with taskId / streamStatus / sessionPath
  it("dispatches task and returns immediately with running status", async () => {
    const tool = createSubagentTool(deps);
    const task = "任务：查一下项目状态\n\n请阅读当前仓库的未提交改动，并总结风险。";
    const result = await tool.execute("call_1", { task }, null, null, mockCtx());

    // t() returns the key path when locale is not loaded in tests
    expect(result.content[0].text).toMatch(/task-id|subagentDispatched/);
    expect(result.details).toBeDefined();
    expect(result.details.taskId).toMatch(/^subagent-/);
    expect(result.details.streamStatus).toBe("running");
    expect(result.details.sessionPath).toBeNull();
    expect(result.details.task).toBe(task);
    expect(result.details.taskTitle).toBe("任务：查一下项目状态");
    expect(result.details.agentId).toBe("hana");
    expect(result.details.agentName).toBe("Hana");
    expect(result.details.requestedAgentId).toBe("hana");
    expect(result.details.requestedAgentNameSnapshot).toBe("Hana");
    expect(result.details.executorAgentId).toBe("hana");
    expect(result.details.executorAgentNameSnapshot).toBe("Hana");
    expect(result.details.executorMetaVersion).toBe(1);

    // store.defer is called before returning
    expect(mockStore.defer).toHaveBeenCalledWith(
      expect.stringMatching(/^subagent-/),
      "/test/session.jsonl",
      expect.objectContaining({ type: "subagent", summary: "任务：查一下项目状态" }),
    );
  });

  it("默认甲（Codex）：派单不剥离工具（无 toolFilter/builtinFilter）+ permissionMode operate + subagentContext", async () => {
    const capture = makeExecuteIsolated();
    const tool = createSubagentTool(makeDeps({ executeIsolated: capture, getDeferredStore: () => mockStore }));
    await tool.execute("call_1", { task: "干活" }, null, null, mockCtx());
    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(1));
    const opts = capture.mock.calls[0][1];
    expect(opts.toolFilter).toBeUndefined();      // 甲：不剥离自定义工具，给全集
    expect(opts.builtinFilter).toBeUndefined();   // 甲：不剥离内置工具，给全集
    expect(opts.permissionMode).toBe("operate");  // 无 access + 无父档 → operate（历史默认全权）
    expect(opts.subagentContext).toBe(true);      // → classify 防自递归
  });

  it("self-dispatch emits actual agent identity with session-ready patch", async () => {
    const emitEvent = vi.fn();
    const persistSubagentSessionMeta = vi.fn(async () => {});
    const tool = createSubagentTool(makeDeps({
      getDeferredStore: () => mockStore,
      emitEvent,
      persistSubagentSessionMeta,
    }));

    const result = await tool.execute("call_1", { task: "当前 agent 自己执行" }, null, null, mockCtx());
    const { taskId } = result.details;

    await vi.waitFor(() => {
      expect(emitEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "block_update",
          taskId,
          patch: expect.objectContaining({
            streamKey: "/test/child.jsonl",
            agentId: "hana",
            agentName: "Hana",
            requestedAgentId: "hana",
            requestedAgentNameSnapshot: "Hana",
            executorAgentId: "hana",
            executorAgentNameSnapshot: "Hana",
          }),
        }),
        "/test/session.jsonl",
      );
    });

    await vi.waitFor(() => {
      expect(persistSubagentSessionMeta).toHaveBeenCalledWith(
        "/test/child.jsonl",
        expect.objectContaining({
          executorAgentId: "hana",
          executorAgentNameSnapshot: "Hana",
          executorMetaVersion: 1,
        }),
      );
    });
  });

  it("records the subagent run in the durable run store across dispatch, session ready, and completion", async () => {
    const runStore = {
      register: vi.fn(),
      attachSession: vi.fn(),
      resolve: vi.fn(),
      fail: vi.fn(),
      abort: vi.fn(),
    };
    const tool = createSubagentTool(makeDeps({
      getDeferredStore: () => mockStore,
      getSubagentRunStore: () => runStore,
    }));

    const result = await tool.execute("call_1", { task: "写一份校准报告" }, null, null, mockCtx());
    const { taskId } = result.details;

    expect(runStore.register).toHaveBeenCalledWith(
      taskId,
      expect.objectContaining({
        parentSessionPath: "/test/session.jsonl",
        summary: "写一份校准报告",
        requestedAgentId: "hana",
        requestedAgentNameSnapshot: "Hana",
      }),
    );

    await vi.waitFor(() => {
      expect(runStore.attachSession).toHaveBeenCalledWith(
        taskId,
        "/test/child.jsonl",
        expect.objectContaining({
          executorAgentId: "hana",
          executorAgentNameSnapshot: "Hana",
        }),
      );
    });

    await vi.waitFor(() => {
      expect(runStore.resolve).toHaveBeenCalledWith(taskId, "done");
    });
  });

  it("uses the original first line as taskTitle and dispatches task unchanged", async () => {
    const executeIsolated = makeExecuteIsolated();
    const tool = createSubagentTool(makeDeps({
      executeIsolated,
      getDeferredStore: () => mockStore,
    }));

    const task = "你是一个生活规划助手。请为用户制定一份**一周生活规律建议**，涵盖以下五个方面：\n\n1. 作息\n2. 运动";
    const result = await tool.execute("call_1", { task }, null, null, mockCtx());

    expect(result.details.taskTitle).toBe("你是一个生活规划助手。请为用户制定一份**一周生活规律建议**，涵盖以下五个方面：");
    expect(executeIsolated).toHaveBeenCalledWith(
      task,
      expect.any(Object),
    );
  });

  // 2. deferred store resolves on success
  it("resolves deferred store on success", async () => {
    const tool = createSubagentTool(deps);
    await tool.execute("call_1", { task: "成功的任务" }, null, null, mockCtx());

    await vi.waitFor(() => {
      expect(mockStore.resolve).toHaveBeenCalledWith(
        expect.stringMatching(/^subagent-/),
        "done",
      );
    });
    expect(mockStore.fail).not.toHaveBeenCalled();
  });

  it("inherits cwd and parent session identity from the tool execution ctx", async () => {
    const captureExecute = makeExecuteIsolated({ replyText: "done", error: null, sessionPath: "/test/child.jsonl" });
    const tool = createSubagentTool(makeDeps({
      executeIsolated: captureExecute,
      getDeferredStore: () => mockStore,
      getParentCwd: () => "/focused/cwd",
    }));

    await tool.execute(
      "call_1",
      { task: "在当前会话目录写文件" },
      null,
      null,
      mockCtx("/test/parent.jsonl", "/actual/parent/cwd"),
    );

    expect(captureExecute).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        cwd: "/actual/parent/cwd",
        parentSessionPath: "/test/parent.jsonl",
        fileReadSessionPaths: ["/test/parent.jsonl"],
      }),
    );
  });

  it("fails deferred store when the run finishes without text or produced files", async () => {
    const emptyExecute = makeExecuteIsolated({
      replyText: "",
      error: null,
      sessionPath: "/test/child.jsonl",
      stopReason: "stop",
      sessionFiles: [],
    });
    const tool = createSubagentTool(makeDeps({
      executeIsolated: emptyExecute,
      getDeferredStore: () => mockStore,
    }));

    await tool.execute("call_1", { task: "需要产物的任务" }, null, null, mockCtx());

    await vi.waitFor(() => {
      expect(mockStore.fail).toHaveBeenCalledWith(
        expect.stringMatching(/^subagent-/),
        expect.any(String),
      );
    });
    expect(mockStore.resolve).not.toHaveBeenCalled();
  });

  it("fails deferred store when the final assistant message did not finish cleanly", async () => {
    const truncatedExecute = makeExecuteIsolated({
      replyText: "partial answer",
      error: null,
      sessionPath: "/test/child.jsonl",
      stopReason: "length",
      sessionFiles: [],
    });
    const tool = createSubagentTool(makeDeps({
      executeIsolated: truncatedExecute,
      getDeferredStore: () => mockStore,
    }));

    await tool.execute("call_1", { task: "长输出任务" }, null, null, mockCtx());

    await vi.waitFor(() => {
      expect(mockStore.fail).toHaveBeenCalledWith(
        expect.stringMatching(/^subagent-/),
        expect.stringMatching(/length|limit|未完成|截断/),
      );
    });
    expect(mockStore.resolve).not.toHaveBeenCalled();
  });

  it("resolves with produced file summary when file output exists without final text", async () => {
    const fileExecute = makeExecuteIsolated({
      replyText: "",
      error: null,
      sessionPath: "/test/child.jsonl",
      stopReason: "stop",
      sessionFiles: [{ filePath: "/workspace/report.md", label: "report.md" }],
    });
    const tool = createSubagentTool(makeDeps({
      executeIsolated: fileExecute,
      getDeferredStore: () => mockStore,
    }));

    await tool.execute("call_1", { task: "生成报告文件" }, null, null, mockCtx());

    await vi.waitFor(() => {
      expect(mockStore.resolve).toHaveBeenCalledWith(
        expect.stringMatching(/^subagent-/),
        expect.stringContaining("/workspace/report.md"),
      );
    });
    expect(mockStore.fail).not.toHaveBeenCalled();
  });

  // 3. deferred store fails when executeIsolated returns an error
  it("fails deferred store when result.error is set", async () => {
    const failingExecute = vi.fn().mockImplementation((_prompt, opts) => {
      opts?.onSessionReady?.("/test/child.jsonl");
      return Promise.resolve({ replyText: null, error: "boom", sessionPath: null });
    });
    const tool = createSubagentTool(makeDeps({
      executeIsolated: failingExecute,
      getDeferredStore: () => mockStore,
    }));

    await tool.execute("call_1", { task: "会失败的任务" }, null, null, mockCtx());

    await vi.waitFor(() => {
      expect(mockStore.fail).toHaveBeenCalledWith(
        expect.stringMatching(/^subagent-/),
        "boom",
      );
    });
    expect(mockStore.resolve).not.toHaveBeenCalled();
  });

  it("does not silently fallback to current agent when delegated execution fails", async () => {
    const executeIsolated = vi.fn().mockRejectedValue(new Error("delegated boom"));
    const emitEvent = vi.fn();
    const tool = createSubagentTool(makeDeps({
      executeIsolated,
      getDeferredStore: () => mockStore,
      emitEvent,
      listAgents: vi.fn(() => [
        { id: "hana", name: "Hana" },
        { id: "butter", name: "butter" },
      ]),
    }));

    const result = await tool.execute("call_1", { task: "委派任务", agent: "butter" }, null, null, mockCtx());

    expect(result.details.requestedAgentId).toBe("butter");
    expect(result.details.executorAgentId).toBe("butter");
    await vi.waitFor(() => {
      expect(mockStore.fail).toHaveBeenCalledWith(
        expect.stringMatching(/^subagent-/),
        "delegated boom",
      );
    });
    expect(executeIsolated).toHaveBeenCalledTimes(1);
    expect(executeIsolated).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ agentId: "butter" }),
    );
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "block_update",
        patch: expect.objectContaining({ streamStatus: "failed", summary: "delegated boom" }),
      }),
      "/test/session.jsonl",
    );
  });

  // 4. emits block_update with streamStatus: done on success
  it("emits block_update with streamStatus done on success", async () => {
    const emitEvent = vi.fn();
    const tool = createSubagentTool(makeDeps({
      getDeferredStore: () => mockStore,
      emitEvent,
    }));

    const result = await tool.execute("call_1", { task: "完成的任务" }, null, null, mockCtx());
    const { taskId } = result.details;

    await vi.waitFor(() => {
      expect(emitEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "block_update",
          taskId,
          patch: expect.objectContaining({ streamStatus: "done" }),
        }),
        "/test/session.jsonl",
      );
    });
  });

  // 5. emits block_update with streamStatus: failed on failure
  it("emits block_update with streamStatus failed on failure", async () => {
    const emitEvent = vi.fn();
    const errorExecute = vi.fn().mockImplementation((_prompt, opts) => {
      opts?.onSessionReady?.("/test/child.jsonl");
      return Promise.resolve({ replyText: null, error: "network error", sessionPath: null });
    });
    const tool = createSubagentTool(makeDeps({
      executeIsolated: errorExecute,
      getDeferredStore: () => mockStore,
      emitEvent,
    }));

    const result = await tool.execute("call_1", { task: "失败的任务" }, null, null, mockCtx());
    const { taskId } = result.details;

    await vi.waitFor(() => {
      expect(emitEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "block_update",
          taskId,
          patch: expect.objectContaining({ streamStatus: "failed" }),
        }),
        "/test/session.jsonl",
      );
    });
  });

  it("does not time out subagent work before the 15 minute default", async () => {
    vi.useFakeTimers();
    const pendingExecute = vi.fn().mockImplementation((_prompt, opts) => {
      opts?.onSessionReady?.("/test/child.jsonl");
      return new Promise((_resolve, reject) => {
        opts?.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    });
    const emitEvent = vi.fn();
    const tool = createSubagentTool(makeDeps({
      executeIsolated: pendingExecute,
      getDeferredStore: () => mockStore,
      emitEvent,
    }));

    const result = await tool.execute("call_1", { task: "长任务" }, null, null, mockCtx());
    expect(result.details.streamStatus).toBe("running");

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(mockStore.fail).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    await vi.waitFor(() => {
      expect(mockStore.fail).toHaveBeenCalledWith(
        expect.stringMatching(/^subagent-/),
        expect.any(String),
      );
    });
    expect(emitEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "block_update",
        patch: expect.objectContaining({ streamStatus: "failed" }),
      }),
      "/test/session.jsonl",
    );
  });

  // 6. per-session concurrent limit: rejects 11th task on the same session
  it("rejects new work when the per-session limit (10) is reached", async () => {
    const pending = [];
    const blockingExecute = vi.fn().mockImplementation((_prompt, opts) => {
      opts?.onSessionReady?.("/test/child.jsonl");
      return new Promise((resolve) => pending.push(resolve));
    });
    const tool = createSubagentTool(makeDeps({
      executeIsolated: blockingExecute,
      getDeferredStore: () => mockStore,
    }));

    // Dispatch 10 tasks on the same session (fire-and-forget)
    const results = [];
    for (let i = 0; i < 10; i++) {
      results.push(await tool.execute(`call_${i}`, { task: `任务 ${i}` }, null, null, mockCtx()));
    }
    for (const r of results) {
      expect(r.details.streamStatus).toBe("running");
    }

    // 11th task on the same session must be rejected
    const blocked = await tool.execute("call_10", { task: "第十一个任务" }, null, null, mockCtx());
    expect(blocked.content[0].text).toMatch(/10|subagentMaxConcurrent/);
    expect(blocked.details).toBeUndefined();

    // Cleanup
    for (const resolve of pending) {
      resolve({ replyText: "ok", error: null, sessionPath: null });
    }
  });

  // 6b. different sessions each get their own per-session quota
  it("allows different sessions to each run up to per-session limit", async () => {
    const pending = [];
    const blockingExecute = vi.fn().mockImplementation((_prompt, opts) => {
      opts?.onSessionReady?.("/test/child.jsonl");
      return new Promise((resolve) => pending.push(resolve));
    });
    const tool = createSubagentTool(makeDeps({
      executeIsolated: blockingExecute,
      getDeferredStore: () => mockStore,
    }));

    // Session A: dispatch 10 tasks
    for (let i = 0; i < 10; i++) {
      const r = await tool.execute(`call_a${i}`, { task: `任务 A${i}` }, null, null, mockCtx("/session/a.jsonl"));
      expect(r.details.streamStatus).toBe("running");
    }

    // Session B: should still be able to dispatch 10 tasks (independent quota)
    for (let i = 0; i < 10; i++) {
      const r = await tool.execute(`call_b${i}`, { task: `任务 B${i}` }, null, null, mockCtx("/session/b.jsonl"));
      expect(r.details.streamStatus).toBe("running");
    }

    // Session A: 11th task should be rejected
    const blockedA = await tool.execute("call_a10", { task: "第十一个 A" }, null, null, mockCtx("/session/a.jsonl"));
    expect(blockedA.content[0].text).toMatch(/10|subagentMaxConcurrent/);
    expect(blockedA.details).toBeUndefined();

    // Session B: 11th task should also be rejected
    const blockedB = await tool.execute("call_b10", { task: "第十一个 B" }, null, null, mockCtx("/session/b.jsonl"));
    expect(blockedB.content[0].text).toMatch(/10|subagentMaxConcurrent/);
    expect(blockedB.details).toBeUndefined();

    // Cleanup
    for (const resolve of pending) {
      resolve({ replyText: "ok", error: null, sessionPath: null });
    }
  });

  // 6c. global limit (20) rejects when total across all sessions exceeds it
  it("rejects when global limit (20) is reached across sessions", async () => {
    const pending = [];
    const blockingExecute = vi.fn().mockImplementation((_prompt, opts) => {
      opts?.onSessionReady?.("/test/child.jsonl");
      return new Promise((resolve) => pending.push(resolve));
    });
    const tool = createSubagentTool(makeDeps({
      executeIsolated: blockingExecute,
      getDeferredStore: () => mockStore,
    }));

    // Fill up 20 tasks across 4 sessions (5 each, under per-session limit of 8)
    for (let s = 0; s < 4; s++) {
      for (let i = 0; i < 5; i++) {
        const r = await tool.execute(`call_${s}_${i}`, { task: `任务` }, null, null, mockCtx(`/session/${s}.jsonl`));
        expect(r.details.streamStatus).toBe("running");
      }
    }

    // 21st task from a new session (per-session is fine, but global is full)
    const blocked = await tool.execute("call_4_0", { task: "第21个" }, null, null, mockCtx("/session/4.jsonl"));
    expect(blocked.content[0].text).toMatch(/20|subagentMaxConcurrent/);
    expect(blocked.details).toBeUndefined();

    // Cleanup
    for (const resolve of pending) {
      resolve({ replyText: "ok", error: null, sessionPath: null });
    }
  });

  // 7. discovery mode: agent="?" lists agents (excluding self)
  it("lists agents in discovery mode (agent=?)", async () => {
    const noopExecute = vi.fn();
    const tool = createSubagentTool(makeDeps({
      executeIsolated: noopExecute,
      listAgents: () => [
        { id: "hana", name: "Hana", model: "claude-3-5-sonnet", summary: "主 agent" },
        { id: "other-agent", name: "Other", model: "gpt-4", summary: "专家 agent" },
      ],
      currentAgentId: "hana",
    }));

    const result = await tool.execute("call_1", { task: "", agent: "?" });

    expect(result.content[0].text).toContain("other-agent");
    expect(result.content[0].text).toContain("Other");
    // self should be excluded
    expect(result.content[0].text).not.toContain("hana (");
    // executeIsolated must not be called in discovery mode
    expect(noopExecute).not.toHaveBeenCalled();
  });

  // 8. cross-agent delegation: agentId forwarded in opts
  it("passes agentId to executeIsolated when delegating to another agent", async () => {
    const captureExecute = makeExecuteIsolated({ replyText: "delegated", error: null, sessionPath: "/test/child.jsonl" });
    const tool = createSubagentTool(makeDeps({
      executeIsolated: captureExecute,
      getDeferredStore: () => mockStore,
    }));

    const result = await tool.execute("call_1", { task: "专项任务", agent: "other-agent" }, null, null, mockCtx());

    expect(result.details.agentId).toBe("other-agent");
    expect(captureExecute).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ agentId: "other-agent" }),
    );
  });

  it("passes parent session files as read-only scopes to isolated execution", async () => {
    const captureExecute = makeExecuteIsolated({ replyText: "ok", error: null, sessionPath: "/test/child.jsonl" });
    const tool = createSubagentTool(makeDeps({
      executeIsolated: captureExecute,
      getDeferredStore: () => mockStore,
    }));

    await tool.execute("call_1", { task: "读取 parent 附件" }, null, null, mockCtx("/test/parent.jsonl"));

    expect(captureExecute).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        fileReadSessionPaths: ["/test/parent.jsonl"],
      }),
    );
  });

  // 9. unknown agent returns error without calling executeIsolated
  it("returns error when agent id is unknown", async () => {
    const noopExecute = vi.fn();
    const tool = createSubagentTool(makeDeps({ executeIsolated: noopExecute }));

    const result = await tool.execute("call_1", { task: "任务", agent: "nonexistent" });

    expect(result.content[0].text).toMatch(/agentNotFound|not found|不存在|找不到 agent/);
    expect(noopExecute).not.toHaveBeenCalled();
  });

  // 9b. LLM 把 roster 里的显示名当 id 用：name → id 兜底匹配
  it("resolves display name to id when caller passes name instead of id", async () => {
    const captureExecute = makeExecuteIsolated({ replyText: "ok", error: null, sessionPath: "/test/child.jsonl" });
    const tool = createSubagentTool(makeDeps({
      executeIsolated: captureExecute,
      getDeferredStore: () => mockStore,
      listAgents: () => [
        { id: "hana", name: "Hana" },
        { id: "ming", name: "明" },
      ],
      currentAgentId: "hana",
    }));

    const result = await tool.execute("call_1", { task: "委派", agent: "明" }, null, null, mockCtx());

    expect(result.details.agentId).toBe("ming");
    expect(captureExecute).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ agentId: "ming" }),
    );
  });

  // 10. sync fallback when deferred store is unavailable
  it("falls back to sync execution when deferred store is unavailable", async () => {
    const syncExecute = makeExecuteIsolated({ replyText: "sync result", error: null, sessionPath: null });
    const tool = createSubagentTool(makeDeps({
      executeIsolated: syncExecute,
      getDeferredStore: () => null,
      getSessionPath: () => null,
    }));

    const result = await tool.execute("call_1", { task: "同步任务" });

    // sync fallback returns the reply text directly (no details / streamStatus)
    expect(result.content[0].text).toBe("sync result");
    expect(result.details).toBeUndefined();
  });
});

describe("subagent-tool 权限档（Codex 式：access 参数 + 继承父会话）", () => {
  let mockStore;
  beforeEach(() => {
    mockStore = { defer: vi.fn(), resolve: vi.fn(), fail: vi.fn(), query: vi.fn(() => ({ meta: {} })), _save: vi.fn() };
  });
  afterEach(() => { vi.useRealTimers(); });

  async function captureOpts(params, extraDeps = {}) {
    const capture = makeExecuteIsolated();
    const tool = createSubagentTool(makeDeps({
      executeIsolated: capture,
      getDeferredStore: () => mockStore,
      ...extraDeps,
    }));
    await tool.execute("call_1", params, null, null, mockCtx());
    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(1));
    return capture.mock.calls[0][1];
  }

  it("access:read → 派单 permissionMode=read_only（探索者只读，真实 write 由拦截层挡）", async () => {
    const opts = await captureOpts({ task: "调研", access: "read" });
    expect(opts.permissionMode).toBe("read_only");
    expect(opts.subagentContext).toBe(true);
  });

  it("access:write → 派单 permissionMode=operate（执行者可操作）", async () => {
    const opts = await captureOpts({ task: "改代码", access: "write" });
    expect(opts.permissionMode).toBe("operate");
  });

  it("access:read 压过父会话可操作档（显式优先）", async () => {
    const opts = await captureOpts(
      { task: "只读审查", access: "read" },
      { getSessionPermissionMode: () => "operate" },
    );
    expect(opts.permissionMode).toBe("read_only");
  });

  it("省略 access + 父会话只读(plan) → 继承 read_only", async () => {
    const opts = await captureOpts(
      { task: "跟随父档" },
      { getSessionPermissionMode: () => "read_only" },
    );
    expect(opts.permissionMode).toBe("read_only");
  });

  it("省略 access + 父会话可操作 → 继承 operate", async () => {
    const opts = await captureOpts(
      { task: "跟随父档" },
      { getSessionPermissionMode: () => "operate" },
    );
    expect(opts.permissionMode).toBe("operate");
  });

  it("省略 access + 父会话先问(ask) → operate（后台不能交互确认，绝不挂在确认上）", async () => {
    const opts = await captureOpts(
      { task: "跟随父档" },
      { getSessionPermissionMode: () => "ask" },
    );
    expect(opts.permissionMode).toBe("operate");
  });

  it("非法 access 值按省略处理（继承父只读档）", async () => {
    const opts = await captureOpts(
      { task: "x", access: "garbage" },
      { getSessionPermissionMode: () => "read_only" },
    );
    expect(opts.permissionMode).toBe("read_only");
  });

  it("getSessionPermissionMode 按 parentSessionPath 反查（不从焦点推导）", async () => {
    const getSessionPermissionMode = vi.fn(() => "read_only");
    await captureOpts({ task: "x" }, { getSessionPermissionMode });
    expect(getSessionPermissionMode).toHaveBeenCalledWith("/test/session.jsonl");
  });
});

describe("subagent-tool 复用模式 (instance)", () => {
  let mockStore;
  beforeEach(() => {
    mockStore = { defer: vi.fn(), resolve: vi.fn(), fail: vi.fn(), query: vi.fn(() => ({ meta: {} })), _save: vi.fn() };
  });
  afterEach(() => { vi.useRealTimers(); });

  const REUSE_KEY = composeReuseKey("/test/session.jsonl", "other-agent", "探索");

  it("首跑：persist 指向 reusable 目录、无 resumeSessionPath、subagentContext 仍剥离记忆、beginRun 落库", async () => {
    const reuseStore = new ReusableSubagentStore();
    const capture = makeExecuteIsolated({ replyText: "ok", error: null, sessionPath: "/test/child.jsonl" });
    const tool = createSubagentTool(makeDeps({
      executeIsolated: capture,
      getDeferredStore: () => mockStore,
      getReusableSubagentStore: () => reuseStore,
    }));

    const res = await tool.execute("c1", { task: "探索任务", agent: "other-agent", instance: "探索" }, null, null, mockCtx());
    expect(res.details.reuseInstance).toBe("探索");

    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(1));
    const opts = capture.mock.calls[0][1];
    expect(opts.persist).toMatch(/subagent-sessions[/\\]reusable$/);
    expect(opts.resumeSessionPath).toBeUndefined(); // 首跑无历史
    expect(opts.subagentContext).toBe(true); // 复用不改记忆档位（forSubagent 剥离记忆三段）

    await vi.waitFor(() => {
      const rec = reuseStore.get(REUSE_KEY);
      expect(rec?.childSessionPath).toBe("/test/child.jsonl");
      expect(rec?.runCount).toBe(1);
    });
  });

  it("二跑：resume 上次的 childSessionPath（续接历史），runCount 累加到 2", async () => {
    const reuseStore = new ReusableSubagentStore();
    const capture = makeExecuteIsolated({ replyText: "ok", error: null, sessionPath: "/test/child.jsonl" });
    const tool = createSubagentTool(makeDeps({
      executeIsolated: capture,
      getDeferredStore: () => mockStore,
      getReusableSubagentStore: () => reuseStore,
    }));

    await tool.execute("c1", { task: "第一次", agent: "other-agent", instance: "探索" }, null, null, mockCtx());
    await vi.waitFor(() => expect(reuseStore.get(REUSE_KEY)?.childSessionPath).toBe("/test/child.jsonl"));

    await tool.execute("c2", { task: "第二次", agent: "other-agent", instance: "探索" }, null, null, mockCtx());
    await vi.waitFor(() => {
      expect(capture).toHaveBeenCalledTimes(2);
      expect(capture.mock.calls[1][1].resumeSessionPath).toBe("/test/child.jsonl");
    });
    expect(reuseStore.get(REUSE_KEY)?.runCount).toBe(2);
  });

  it("不同后缀 = 独立实例（独立 reuseKey，各自 runCount=1）", async () => {
    const reuseStore = new ReusableSubagentStore();
    const tool = createSubagentTool(makeDeps({
      getDeferredStore: () => mockStore,
      getReusableSubagentStore: () => reuseStore,
    }));

    await tool.execute("c1", { task: "探索", agent: "other-agent", instance: "探索" }, null, null, mockCtx());
    await tool.execute("c2", { task: "下笔", agent: "other-agent", instance: "下笔" }, null, null, mockCtx());

    await vi.waitFor(() => {
      expect(reuseStore.get(composeReuseKey("/test/session.jsonl", "other-agent", "探索"))?.runCount).toBe(1);
      expect(reuseStore.get(composeReuseKey("/test/session.jsonl", "other-agent", "下笔"))?.runCount).toBe(1);
    });
    expect(reuseStore.size).toBe(2);
  });

  it("per-session 隔离：同 agent+后缀，不同对话 = 不同实例（B 不续 A 的历史）", async () => {
    const reuseStore = new ReusableSubagentStore();
    const capture = makeExecuteIsolated({ replyText: "ok", error: null, sessionPath: "/test/child.jsonl" });
    const tool = createSubagentTool(makeDeps({
      executeIsolated: capture,
      getDeferredStore: () => mockStore,
      getReusableSubagentStore: () => reuseStore,
    }));

    // 对话 A 首跑「other-agent·探索」→ 落库到 A 的 reuseKey
    await tool.execute("c1", { task: "t", agent: "other-agent", instance: "探索" }, null, null, mockCtx("/session/a.jsonl"));
    await vi.waitFor(() =>
      expect(reuseStore.get(composeReuseKey("/session/a.jsonl", "other-agent", "探索"))?.childSessionPath).toBe("/test/child.jsonl"));

    // 对话 B 派同 agent+后缀 → 不同 reuseKey，首跑无 resume（绝不串 A 的历史）
    await tool.execute("c2", { task: "t", agent: "other-agent", instance: "探索" }, null, null, mockCtx("/session/b.jsonl"));
    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(2));
    expect(capture.mock.calls[1][1].resumeSessionPath).toBeUndefined();

    // 两个独立实例（A 与 B 各一）
    expect(reuseStore.size).toBe(2);
    expect(reuseStore.get(composeReuseKey("/session/b.jsonl", "other-agent", "探索"))).toBeTruthy();
  });

  it("不带 instance：维持一次性，persist 不进 reusable 子目录、不碰复用账本", async () => {
    const reuseStore = new ReusableSubagentStore();
    const capture = makeExecuteIsolated({ replyText: "ok", error: null, sessionPath: "/test/child.jsonl" });
    const tool = createSubagentTool(makeDeps({
      executeIsolated: capture,
      getDeferredStore: () => mockStore,
      getReusableSubagentStore: () => reuseStore,
    }));

    await tool.execute("c1", { task: "一次性", agent: "other-agent" }, null, null, mockCtx());
    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(1));
    const opts = capture.mock.calls[0][1];
    expect(opts.persist).toMatch(/subagent-sessions$/); // 非 reusable 子目录
    expect(opts.resumeSessionPath).toBeUndefined();
    expect(reuseStore.size).toBe(0); // 完全没碰复用账本
  });

  it("同实例并发：串行排队，第二次派单返回「已排队」反馈、executeIsolated 不并发", async () => {
    const reuseStore = new ReusableSubagentStore();
    const pending = [];
    const blockingExecute = vi.fn().mockImplementation((_p, opts) => {
      opts?.onSessionReady?.("/test/child.jsonl");
      return new Promise((resolve) => pending.push(resolve));
    });
    const tool = createSubagentTool(makeDeps({
      executeIsolated: blockingExecute,
      getDeferredStore: () => mockStore,
      getReusableSubagentStore: () => reuseStore,
    }));

    const r1 = await tool.execute("c1", { task: "t1", agent: "other-agent", instance: "探索" }, null, null, mockCtx());
    expect(r1.details.streamStatus).toBe("running");
    await vi.waitFor(() => expect(blockingExecute).toHaveBeenCalledTimes(1));

    const r2 = await tool.execute("c2", { task: "t2", agent: "other-agent", instance: "探索" }, null, null, mockCtx());
    expect(r2.content[0].text).toMatch(/subagentReuseQueued|排队|queued|busy/);

    // 串行：第一个未结束前，第二个不开始
    await new Promise((r) => setTimeout(r, 0));
    expect(blockingExecute).toHaveBeenCalledTimes(1);

    // 放行第一个 → 第二个才开始
    pending[0]({ replyText: "ok", error: null, sessionPath: "/test/child.jsonl" });
    await vi.waitFor(() => expect(blockingExecute).toHaveBeenCalledTimes(2));

    pending.forEach((res) => res({ replyText: "ok", error: null, sessionPath: null }));
  });
});
