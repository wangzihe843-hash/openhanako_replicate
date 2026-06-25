// lib/tools/workflow-tool.js
import path from "node:path";
import { Type } from "../pi-sdk/index.ts";
import { t } from "../i18n.ts";
import { runWorkflowScript } from "../workflow/sandbox.ts";
import { extractMeta } from "../workflow/meta.ts";
import { createHostApi } from "../workflow/host-api.ts";
import { createLimiter } from "../workflow/concurrency.ts";
import { WorkflowJournal } from "../workflow/journal.ts";
import { getToolSessionPath, getToolSessionCwd } from "./tool-session.ts";
import { toolOk, toolError } from "./tool-result.ts";

const WORKFLOW_DEADLINE_MS = 10 * 60 * 1000;
// 后台兜底超时：略大于内部 deadline，防 runWorkflowScript 在 deadline 之外卡死。
const WORKFLOW_TIMEOUT_BACKSTOP_MS = WORKFLOW_DEADLINE_MS + 30 * 1000;
const WORKFLOW_AGENT_MAX_CONCURRENT = 256;
const AGENT_TOTAL_BACKSTOP = 1000;
const WORKFLOW_DESCRIPTION = [
  "Run a deterministic JavaScript orchestration script that delegates all real work to workflow agent() nodes.",
  "Use this for controlled fan-out, cross-verification, staged synthesis, or dynamic loops where each item must be handled.",
  "The script must start with: export const meta = { name: string, description: string }.",
  "Available globals: agent(prompt, opts), parallel(thunks), pipeline(items, ...stages), workflow(script, args), phase(title), log(message), budget, args.",
  'agent() signature is agent(prompt, { label?, model?, agentType?, access?: "read"|"write", schema?, toolFilter? }).',
  "Always await agent(): const result = await agent('task prompt', { access: 'read', agentType: 'hanako' }); agent() does not return { result }.",
  "To choose a target agent, use opts.agentType. Do not pass task in opts; put complete task instructions in the first prompt argument.",
  "The script cannot import modules or access require/process/fs/net. To read/write files or run tools, ask an agent() node to do it.",
].join("\n");

function buildParameters() {
  return Type.Object({
    script: Type.String({ description: "Orchestration script, must start with export const meta = {...}" }),
    args: Type.Optional(Type.Any({ description: "Arguments passed to the script's args global. Pass { budgetTokens: N } to set a token budget ceiling." })),
    resumeFromRunId: Type.Optional(Type.String({
      description: "Previous workflow runId (taskId) to resume from — cached agent nodes with unchanged prompt+opts return instantly, first change onward re-executes.",
    })),
  });
}

function makeLimiter() {
  return createLimiter({ maxConcurrent: WORKFLOW_AGENT_MAX_CONCURRENT, maxTotal: AGENT_TOTAL_BACKSTOP });
}

function declarativeNodesUnsupported(meta) {
  return Array.isArray(meta?.nodes);
}

/** 一条 usage entry 的总 token（优先顶层 totalTokens，回退 input+output）。 */
function usageTokens(usage) {
  if (!usage) return 0;
  if (typeof usage.totalTokens === "number") return usage.totalTokens;
  return (usage.input?.totalTokens || 0) + (usage.output?.totalTokens || 0);
}

/** 按子节点 session 从 UsageLedger 汇总 token；无 ledger / 无记录返回 null（节点行不显示）。 */
function sumNodeTokens(ledger, { childSessionId = null, childSessionPath = null } = {}) {
  if (!ledger?.list || (!childSessionId && !childSessionPath)) return null;
  const filter = childSessionId ? { childSessionId } : { childSessionPath };
  const { entries } = ledger.list(filter);
  if (!entries?.length) return null;
  return entries.reduce((sum, e) => sum + usageTokens(e.usage), 0);
}

function sessionIdForPath(deps, sessionPath) {
  const sessionId = deps.getSessionIdForPath?.(sessionPath);
  return typeof sessionId === "string" && sessionId.trim() ? sessionId.trim() : null;
}

function sessionRefForPath(deps, sessionPath) {
  const sessionId = sessionIdForPath(deps, sessionPath);
  return sessionId ? { sessionId, sessionPath } : null;
}

function sessionInputForPath(deps, sessionPath) {
  return sessionRefForPath(deps, sessionPath) || sessionPath;
}

/** 从 agent 数据目录派生 journal 存储路径。 */
function journalPath(journalDir, runId) {
  if (!journalDir || !runId) return null;
  return path.join(journalDir, `${runId}.jsonl`);
}

function workflowSessionDir(deps, runId) {
  const root = deps.getWorkflowSessionDir?.();
  return root && runId ? path.join(root, runId) : null;
}

function assertWorkflowResult(result) {
  if (result === undefined) {
    throw new Error("workflow returned undefined. Return a string, object, array, number, boolean, or null.");
  }
  return result;
}

function workflowResultToText(result) {
  assertWorkflowResult(result);
  if (typeof result === "string") return result;
  let text;
  try {
    text = JSON.stringify(result, null, 2);
  } catch (err) {
    throw new Error(`workflow result is not JSON-serializable: ${err?.message || err}`);
  }
  if (text === undefined) {
    throw new Error("workflow returned a non-serializable result. Return a string, object, array, number, boolean, or null.");
  }
  return text;
}

/** 构造接入 UsageLedger 的实时 budget 对象。 */
function makeBudget(ledger, taskId, budgetTotal) {
  const total = typeof budgetTotal === "number" && budgetTotal > 0 ? budgetTotal : null;
  function spent() {
    // workflow 子 agent 的 usage 由 session-coordinator 记成 attribution.{kind:"session", taskId:<本 workflow taskId>}
    // （subagentContext 分支，见 core/session-coordinator.js）——kind 不是 "subagent"（那是 source.actor.kind），
    // taskId 也不在 parentTaskId/subagentTaskId 上。所以按 attribution.taskId 精确归集本 workflow 的花销。
    // 无 taskId（_syncRun 兜底路径传 null）时不归集，避免把所有 null-taskId entry 误算进来。
    if (!ledger?.list || !taskId) return 0;
    const { entries } = ledger.list({});
    if (!entries?.length) return 0;
    let sum = 0;
    for (const e of entries) {
      if (e.attribution?.taskId === taskId) {
        sum += usageTokens(e.usage);
      }
    }
    return sum;
  }
  return {
    total,
    spent,
    remaining: () => total == null ? Infinity : Math.max(0, total - spent()),
  };
}

/**
 * @param {{
 *   executeIsolated: (prompt: string, isoOpts: object) => Promise<object>,
 *   getSessionPath?: () => string|null,
 *   getSessionIdForPath?: (sessionPath: string|null) => string|null,
 *   getSessionPermissionMode?: (sessionPath: string|null) => string|null,
 *   getParentCwd?: () => string|null,
 *   getAgentId?: () => string|undefined,
 *   emitEvent?: (event: object, sessionPath: string|null) => void,
 *   resolveAgentId?: (agentType?: string) => string|undefined,
 *   getDeferredStore?: () => import("../deferred-result-store.ts").DeferredResultStore|null,
 *   getSubagentRunStore?: () => import("../subagent-run-store.ts").SubagentRunStore|null,
 *   getSubagentThreadStore?: () => import("../subagent-thread-store.ts").SubagentThreadStore|null,
 *   getJournalDir?: () => string|null,
 *   getWorkflowSessionDir?: () => string|null,
 * }} deps
 */
export function createWorkflowTool(deps) {
  return {
    name: "workflow",
    label: "Workflow",
    description: WORKFLOW_DESCRIPTION,
    parameters: buildParameters(),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const parentSessionPath = getToolSessionPath(ctx) || deps.getSessionPath?.() || null;
      const parentSessionRef = sessionRefForPath(deps, parentSessionPath);
      const parentSessionId = parentSessionRef?.sessionId || null;
      const cwd = getToolSessionCwd(ctx) || deps.getParentCwd?.() || null;
      const agentId = deps.getAgentId?.() || undefined;
      const parentPermissionMode = parentSessionPath
        ? (deps.getSessionPermissionMode?.(parentSessionPath) || null)
        : null;

      // 先静态校验脚本头：非法脚本同步报错，不派后台任务
      // （禁止非用户预期 fallback：不把非法输入伪装成"已派出"）。
      let meta;
      try {
        ({ meta } = extractMeta(params.script));
      } catch (err) {
        return toolError(t("tool.workflow.scriptInvalid", { message: err.message }));
      }
      if (declarativeNodesUnsupported(meta)) {
        return toolError(
          "workflow meta.nodes is declarative metadata and is not executable yet; use agent()/parallel()/phase()/log() in the script body.",
        );
      }

      const store = deps.getDeferredStore?.();
      const runStore = deps.getSubagentRunStore?.();
      const threadStore = deps.getSubagentThreadStore?.();

      // deferred 基础设施不可用（或无 parent session）→ 同步兜底执行，调用方直接拿结果。
      // 与 subagent 一致：这是基础设施缺失时的等价行为，不是静默降级。
      if (!store || !parentSessionPath) {
        return _syncRun(deps, params, meta, { agentId, cwd, parentSessionPath, parentPermissionMode });
      }

      const taskId = `workflow-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const summary = meta.name;
      const hub = deps.getActivityHub?.();
      const startedAt = Date.now();

      store.defer(taskId, sessionInputForPath(deps, parentSessionPath), { type: "workflow", interlude: true, summary });
      runStore?.register?.(taskId, { parentSessionId, parentSessionPath, summary });
      hub?.upsert({ id: taskId, kind: "workflow", status: "running", sessionId: parentSessionId, sessionPath: parentSessionPath, agentId, summary, startedAt });

      // ── journal：断点续跑 ──
      const jDir = deps.getJournalDir?.() || null;
      let replayJournal = null;
      if (params.resumeFromRunId && jDir) {
        const oldPath = journalPath(jDir, params.resumeFromRunId);
        replayJournal = WorkflowJournal.load(oldPath);
        if (replayJournal.hasEntries) {
          deps.emitEvent?.({ type: "workflow_progress", taskId, message: t("tool.workflow.journalResuming", { count: replayJournal.totalEntries }) }, parentSessionPath);
        }
      }
      const journal = new WorkflowJournal(journalPath(jDir, taskId));

      // 后台任务独立生命周期：execute 的 signal 在返回后即失效，用自己的 AbortController；
      // 再加一道超时兜底（正常由 runWorkflowScript 内部 deadline 先触发）。
      const controller = new AbortController();
      const timeoutTimer = setTimeout(() => controller.abort(), WORKFLOW_TIMEOUT_BACKSTOP_MS);
      if (timeoutTimer.unref) timeoutTimer.unref();

      // ── budget：接 UsageLedger 实时计量 ──
      const ledger = deps.getUsageLedger?.();
      const budgetTotal = params.args?.budgetTokens ?? null;
      const budget = makeBudget(ledger, taskId, budgetTotal);

      const limiter = makeLimiter();
      const nodeSessionDir = workflowSessionDir(deps, taskId);

      const baseIsoOpts = {
        agentId,
        cwd,
        parentSessionId,
        parentSessionPath,
        subagentContext: true,
        subagentTaskId: taskId,
        emitEvents: true,
        approvalPolicy: "deny_on_prompt",
        allowHumanApproval: false,
        ...(nodeSessionDir ? { persist: nodeSessionDir } : {}),
        ...(parentPermissionMode ? { permissionMode: parentPermissionMode } : {}),
      };

      // ── workflow 嵌套：子 workflow 限一层，共享 limiter / signal / budget ──
      // journal 必须各自独立：每个 createHostApi 的 nodeSeq 都从 0 起，若子 workflow 与父
      // 共享同一个按 nodeSeq 索引的 journal，子节点 seq=1,2,3 会和父节点撞键——record() 覆盖
      // 内存 Map + 往同一 JSONL 追加重复 nodeSeq 行污染续跑，回放时还共用一个 _invalidatedAfter
      // 游标互相误伤。按调用序号给子 workflow 分配独立 journal 子路径（${taskId}.child-N），
      // 续跑时按同序号（脚本确定性保证调用顺序一致）回放对应子 journal。
      let childWorkflowSeq = 0;
      const childReplayJournals = [];
      const runWorkflow = (childScript, childArgs) => {
        const cIdx = ++childWorkflowSeq;
        const childJournal = new WorkflowJournal(journalPath(jDir, `${taskId}.child-${cIdx}`));
        const childReplay = (params.resumeFromRunId && jDir)
          ? WorkflowJournal.load(journalPath(jDir, `${params.resumeFromRunId}.child-${cIdx}`))
          : null;
        if (childReplay) childReplayJournals.push(childReplay);
        const childHostApi = createHostApi({
          executeIsolated: (prompt, isoOpts) => deps.executeIsolated(prompt, isoOpts),
          baseIsoOpts,
          limiter,
          signal: controller.signal,
          onProgress: (evt) => deps.emitEvent?.({ ...evt, type: "workflow_progress", taskId }, parentSessionPath),
          onAgentEvent: buildAgentEventHandler({ taskId, parentSessionId, parentSessionPath, summary, hub, threadStore, deps }),
          budget,
          args: childArgs,
          resolveAgentId: deps.resolveAgentId,
          journal: childJournal,
          replayJournal: childReplay,
        });
        return runWorkflowScript(childScript, childHostApi, {
          signal: controller.signal,
          deadlineMs: WORKFLOW_DEADLINE_MS,
        }).then(({ result }) => assertWorkflowResult(result));
      };

      const hostApi = createHostApi({
        executeIsolated: (prompt, isoOpts) => deps.executeIsolated(prompt, isoOpts),
        baseIsoOpts,
        limiter,
        signal: controller.signal,
        onProgress: (evt) => deps.emitEvent?.({ ...evt, type: "workflow_progress", taskId }, parentSessionPath),
        onAgentEvent: buildAgentEventHandler({ taskId, parentSessionId, parentSessionPath, summary, hub, threadStore, deps }),
        budget,
        args: params.args,
        resolveAgentId: deps.resolveAgentId,
        journal,
        replayJournal,
        runWorkflow,
      });

      // fire-and-forget：不 await。后台跑完 resolve/fail 写入 deferred store，
      // DeferredResultCoordinator 监听后以 <hana-background-result type="workflow"> steer 回灌主对话。
      runWorkflowScript(params.script, hostApi, { signal: controller.signal, deadlineMs: WORKFLOW_DEADLINE_MS })
        .then(({ result }) => {
          const text = workflowResultToText(result);
          const finishedAt = Date.now();
          const replayHits = (replayJournal?.replayHits ?? 0) + (journal?.replayHits ?? 0)
            + childReplayJournals.reduce((s, j) => s + (j?.replayHits ?? 0), 0);
          store.resolve(taskId, text);
          runStore?.resolve?.(taskId, text);
          hub?.upsert({ id: taskId, status: "done", finishedAt });
          deps.emitEvent?.({
            type: "block_update", taskId,
            patch: { streamStatus: "done", finishedAt, ...(replayHits > 0 ? { journalReplayHits: replayHits } : {}) },
          }, parentSessionPath);
        })
        .catch((err) => {
          const reason = err?.message || String(err);
          const finishedAt = Date.now();
          store.fail(taskId, reason);
          runStore?.fail?.(taskId, reason);
          hub?.upsert({ id: taskId, status: "failed", finishedAt });
          deps.emitEvent?.({ type: "block_update", taskId, patch: { streamStatus: "failed", finishedAt } }, parentSessionPath);
        })
        .finally(() => clearTimeout(timeoutTimer));

      return toolOk(
        t("tool.workflow.dispatched", { summary, taskId }),
        { taskId, runId: taskId, workflow: summary, streamStatus: "running", startedAt },
      );
    },
  };
}

/**
 * 提取 onAgentEvent handler：节点级活动 → ActivityHub 子 entry + ThreadStore。
 * 主流程和嵌套 workflow 共用，避免重复。
 */
function buildAgentEventHandler({ taskId, parentSessionId, parentSessionPath, summary, hub, threadStore, deps }) {
  return (evt) => {
    const childId = `${taskId}::${evt.nodeId}`;
    if (evt.phase === "start") {
      const isStep = typeof evt.stepKind === "string" && evt.stepKind;
      const kind = isStep ? "workflow_step" : "workflow_agent";
      if (!isStep && evt.threadId) {
        threadStore?.beginRun?.(evt.threadId, {
          kind: evt.threadKind || "workflow_node",
          parentTaskId: taskId,
          nodeId: evt.nodeId,
          parentSessionId,
          parentSessionPath,
          agentId: evt.agentId || null,
          label: evt.label || null,
          summary: evt.label || evt.phaseLabel || summary,
        });
      }
      hub?.upsert({
        id: childId, kind, status: "running",
        sessionId: parentSessionId,
        sessionPath: parentSessionPath, parentTaskId: taskId,
        threadId: isStep ? null : (evt.threadId || null),
        threadKind: isStep ? null : (evt.threadKind || null),
        agentId: isStep ? null : (evt.agentId || null),
        label: evt.label || null,
        phaseLabel: evt.phaseLabel || null,
        stepKind: evt.stepKind || null,
        startedAt: Date.now(),
      });
    } else if (evt.phase === "session") {
      if (evt.threadId) {
        threadStore?.attachSession?.(evt.threadId, evt.childSessionPath || null, {
          parentTaskId: taskId,
          nodeId: evt.nodeId,
          parentSessionId,
          parentSessionPath,
          childSessionId: evt.childSessionId || null,
        });
      }
      hub?.upsert({
        id: childId,
        childSessionId: evt.childSessionId || null,
        childSessionPath: evt.childSessionPath || null,
      });
    } else if (evt.phase === "done") {
      const isStep = typeof evt.stepKind === "string" && evt.stepKind;
      if (!isStep) {
        const node = hub?.get?.(childId);
        const tokens = sumNodeTokens(deps.getUsageLedger?.(), {
          childSessionId: node?.childSessionId || null,
          childSessionPath: node?.childSessionPath || null,
        });
        if (evt.threadId) {
          threadStore?.finishRun?.(evt.threadId, { status: "resolved", close: true });
        }
        hub?.upsert({ id: childId, status: "done", finishedAt: Date.now(), ...(tokens != null ? { tokens } : {}) });
      } else {
        hub?.upsert({ id: childId, status: "done", finishedAt: Date.now() });
      }
    } else if (evt.phase === "fail") {
      const isStep = typeof evt.stepKind === "string" && evt.stepKind;
      if (!isStep && evt.threadId) {
        threadStore?.finishRun?.(evt.threadId, { status: "failed", close: true });
      }
      hub?.upsert({ id: childId, status: "failed", finishedAt: Date.now() });
    }
  };
}

/** deferred 基础设施不可用时同步执行，保留原同步语义（调用方直接拿合成结果）。 */
async function _syncRun(deps, params, meta, { agentId, cwd, parentSessionPath, parentPermissionMode }) {
  const limiter = makeLimiter();
  const ledger = deps.getUsageLedger?.();
  const budgetTotal = params.args?.budgetTokens ?? null;
  // 与后台路径同款超时兜底：用 AbortController + WORKFLOW_TIMEOUT_BACKSTOP_MS 定时器，
  // 防 runWorkflowScript 在内部 deadline 之外卡死、把子 agent 留成孤儿（正常由内部 deadline 先触发）。
  const controller = new AbortController();
  const timeoutTimer = setTimeout(() => controller.abort(), WORKFLOW_TIMEOUT_BACKSTOP_MS);
  if (timeoutTimer.unref) timeoutTimer.unref();
  const parentSessionId = sessionIdForPath(deps, parentSessionPath);
  const hostApi = createHostApi({
    executeIsolated: (prompt, isoOpts) => deps.executeIsolated(prompt, isoOpts),
    baseIsoOpts: {
      agentId,
      cwd,
      parentSessionId,
      parentSessionPath,
      subagentContext: true,
      emitEvents: true,
      approvalPolicy: "deny_on_prompt",
      allowHumanApproval: false,
      ...(parentPermissionMode ? { permissionMode: parentPermissionMode } : {}),
    },
    limiter,
    signal: controller.signal,
    onProgress: (evt) => deps.emitEvent?.({ ...evt, type: "workflow_progress" }, parentSessionPath),
    budget: makeBudget(ledger, null, budgetTotal),
    args: params.args,
    resolveAgentId: deps.resolveAgentId,
  });
  try {
    const { result } = await runWorkflowScript(params.script, hostApi, { signal: controller.signal, deadlineMs: WORKFLOW_DEADLINE_MS });
    const text = workflowResultToText(result);
    return toolOk(
      t("tool.workflow.syncComplete", { name: meta.name, count: limiter.totalSpawned, result: text }),
      { workflow: meta.name, agentsSpawned: limiter.totalSpawned, result },
    );
  } catch (err) {
    return toolError(t("tool.workflow.executionFailed", { message: err.message }), { agentsSpawned: limiter.totalSpawned });
  } finally {
    clearTimeout(timeoutTimer);
  }
}
