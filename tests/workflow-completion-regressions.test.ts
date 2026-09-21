import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHostApi, WorkflowNodeCompletionError } from "../lib/workflow/host-api.ts";
import { WorkflowJournal } from "../lib/workflow/journal.ts";
import { runWorkflowScript } from "../lib/workflow/sandbox.ts";
import { createWorkflowTool } from "../lib/tools/workflow-tool.ts";
import { SubagentThreadStore } from "../lib/subagent-thread-store.ts";

const META = "export const meta = { name: 'completion-regression', description: 'test' };\n";
const roots: string[] = [];
function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-workflow-completion-"));
  roots.push(root);
  return root;
}
function deferred<T>() {
  let resolve: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve: (value: T) => resolve(value) };
}
function host(journal: WorkflowJournal, failCompletion = false) {
  const execute = vi.fn(async () => ({ replyText: "effect-completed" }));
  const api = createHostApi({
    executeIsolated: execute,
    baseIsoOpts: { permissionMode: "read_only" },
    limiter: { run: (fn: () => Promise<unknown>) => fn() },
    journal,
    onAgentEvent: (event: { phase: string; stepKind?: string }) => {
      if (failCompletion && event.phase === "done" && !event.stepKind) {
        throw Object.assign(new Error("ENOSPC: completed metadata save failed"), { code: "ENOSPC" });
      }
    },
  });
  return { api, execute };
}

type Outcome = { taskId: string; status: "resolved" | "failed"; value: string };
function background(journalDir: string, execute = vi.fn(async () => ({ replyText: "effect-completed" }))) {
  const threads = new SubagentThreadStore();
  const outcomes: Outcome[] = [];
  const store = {
    defer: vi.fn(),
    resolve: vi.fn((taskId: string, value: string) => { outcomes.push({ taskId, status: "resolved", value }); }),
    fail: vi.fn((taskId: string, value: string) => { outcomes.push({ taskId, status: "failed", value }); }),
  };
  const tool = createWorkflowTool({
    executeIsolated: execute,
    getDeferredStore: () => store,
    getSubagentThreadStore: () => threads,
    getJournalDir: () => journalDir,
    getSessionPermissionMode: () => "read_only",
  });
  const dispatch = (body: string, resumeFromRunId?: string) => tool.execute("test", {
    script: META + body,
    ...(resumeFromRunId ? { resumeFromRunId } : {}),
  }, undefined, undefined, {
    sessionManager: { getSessionFile: () => "/test-parent.jsonl", getCwd: () => journalDir },
  });
  const finished = async (index = 0) => {
    await vi.waitFor(() => expect(outcomes.length).toBeGreaterThan(index));
    return outcomes[index];
  };
  return { threads, execute, store, dispatch, finished };
}

function failCompletedMetadata(threads: SubagentThreadStore) {
  return vi.spyOn(threads, "_save").mockImplementation(() => {
    if ([...threads._threads.values()].some((thread) => thread.lastRunStatus === "resolved")) {
      throw Object.assign(new Error("EACCES: completed metadata save failed"), { code: "EACCES" });
    }
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("workflow completion failures", () => {
  it("keeps the successful result and never retries execution after completion metadata fails", async () => {
    const journal = new WorkflowJournal(null);
    const { api, execute } = host(journal, true);
    await expect(api.agent("write once")).rejects.toMatchObject({
      code: "WORKFLOW_NODE_COMPLETION_FAILED", completedResult: "effect-completed",
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(journal.tryReplay(1, WorkflowJournal.computeKey("write once", {}))).toEqual({ hit: true, result: "effect-completed" });
  });

  it.each([
    "return await parallel([() => agent('write once')])",
    "return await pipeline(['write once'], value => agent(value))",
    "try { await agent('write once'); } catch {} return 'recovered';",
  ])("does not let script recovery hide a completion failure: %s", async (body) => {
    const { api, execute } = host(new WorkflowJournal(null), true);
    await expect(runWorkflowScript(META + body, api)).rejects.toBeInstanceOf(WorkflowNodeCompletionError);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("surfaces a journal append failure, retaining only an explicitly non-durable in-memory result", async () => {
    const journalPath = path.join(tempRoot(), "run.jsonl");
    const journal = new WorkflowJournal(journalPath);
    vi.spyOn(fs, "appendFileSync").mockImplementation(() => { throw new Error("ENOSPC: journal full"); });
    const { api, execute } = host(journal);
    await expect(api.agent("write once")).rejects.toMatchObject({ completedResult: "effect-completed" });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(journal.isDurable).toBe(false);
    expect(journal.tryReplay(1, WorkflowJournal.computeKey("write once", {}))?.result).toBe("effect-completed");
    expect(WorkflowJournal.load(journalPath).hasEntries).toBe(false);
  });

  it("records success under the options used when execution began", async () => {
    const journal = new WorkflowJournal(null);
    const gate = deferred<{ replyText: string }>();
    const { api, execute } = host(journal);
    execute.mockImplementationOnce(() => gate.promise);
    const options = { label: "before" };
    const running = Promise.resolve(api.agent("write once", options));
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    options.label = "after";
    gate.resolve({ replyText: "effect-completed" });
    await running;
    expect(journal.tryReplay(1, WorkflowJournal.computeKey("write once", { label: "before" }))?.result).toBe("effect-completed");
  });

  it("bounds the diagnostic preview while preserving the original result on the error", () => {
    const result = { text: "x".repeat(100_000) };
    const error = new WorkflowNodeCompletionError("node-1", result, new Error("y".repeat(100_000)));
    expect(error.message.length).toBeLessThan(3500);
    expect(error.completedResult).toBe(result);
  });

  it("persists the success before real finishRun fails and resumes without executing its effect again", async () => {
    const root = tempRoot();
    const fixture = background(root);
    const fault = failCompletedMetadata(fixture.threads);
    await fixture.dispatch("return await agent('write once')");
    const first = await fixture.finished();
    expect(first.status).toBe("failed");
    expect(first.value).toContain("effect-completed");
    expect(first.value).toContain("resumeFromRunId");
    expect(first.value).toContain("位置与输入未变");
    expect(fixture.execute).toHaveBeenCalledTimes(1);
    fault.mockRestore();
    await fixture.dispatch("return await agent('write once')", first.taskId);
    expect(await fixture.finished(1)).toMatchObject({ status: "resolved", value: "effect-completed" });
    expect(fixture.execute).toHaveBeenCalledTimes(1);
  });

  it("does not advertise safe resume if journal persistence itself failed", async () => {
    const blockedDir = path.join(tempRoot(), "not-a-directory");
    fs.writeFileSync(blockedDir, "fixture");
    const fixture = background(blockedDir);
    await fixture.dispatch("return await agent('write once')");
    const outcome = await fixture.finished();
    expect(outcome.status).toBe("failed");
    expect(outcome.value).toContain("effect-completed");
    expect(outcome.value).toContain("无法保证续跑跳过已执行节点");
    expect(outcome.value).not.toContain("可用 resumeFromRunId");
    expect(fixture.execute).toHaveBeenCalledTimes(1);
    expect(fixture.store.resolve).not.toHaveBeenCalled();
  });

  it.each([
    "return await parallel([() => agent('write once')])",
    "return await pipeline(['write once'], value => agent(value))",
    "try { await workflow(args.child); } catch {} return 'recovered';",
    "agent('write once').catch(() => null); return 'returned before the node';",
    "workflow(args.child).catch(() => null); return 'returned before the child';",
  ])("background run fails even when completion errors are consumed: %s", async (body) => {
    const gate = deferred<{ replyText: string }>();
    const execute = vi.fn(() => gate.promise);
    const fixture = background(tempRoot(), execute);
    failCompletedMetadata(fixture.threads);
    const child = JSON.stringify(META + "agent('write once').catch(() => null); return 'child returned';");
    await fixture.dispatch(body.replace("args.child", child));
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    gate.resolve({ replyText: "effect-completed" });
    const outcome = await fixture.finished();
    expect(outcome.status).toBe("failed");
    expect(outcome.value).toContain("完成结果记录失败");
    expect(outcome.value).toContain("effect-completed");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(fixture.store.resolve).not.toHaveBeenCalled();
  });
});
