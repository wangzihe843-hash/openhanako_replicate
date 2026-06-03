// lib/tools/workflow-tool.js
import { Type } from "../pi-sdk/index.js";
import { runWorkflowScript } from "../workflow/sandbox.js";
import { extractMeta } from "../workflow/meta.js";
import { createHostApi } from "../workflow/host-api.js";
import { createLimiter } from "../workflow/concurrency.js";
import { getToolSessionPath, getToolSessionCwd } from "./tool-session.js";
import { toolOk, toolError } from "./tool-result.js";

const WORKFLOW_DEADLINE_MS = 10 * 60 * 1000;
// 后台兜底超时：略大于内部 deadline，防 runWorkflowScript 在 deadline 之外卡死。
const WORKFLOW_TIMEOUT_BACKSTOP_MS = WORKFLOW_DEADLINE_MS + 30 * 1000;
const WORKFLOW_AGENT_MAX_CONCURRENT = 256;
const AGENT_TOTAL_BACKSTOP = 1000;

const WORKFLOW_DESCRIPTION = [
  "用一段确定性 JS 脚本编排多个子 agent（agent/parallel/pipeline）。",
  "适合：受控 fan-out、要保证不漏不偷懒、要把多个子 agent 的结果合成的任务。",
  "脚本必须以 `export const meta = { name, description }` 开头（纯字面量）。",
  "可用全局：agent(prompt, {model?, schema?, agentType?}) 同步返回结果（带 schema 返回校验对象）；",
  "parallel(thunks) 并发等齐（thunk 抛错落 null）；pipeline(items, ...stages) 每项独立穿过各 stage；log/phase/budget/args。",
  "脚本体二选一（等价）：① 顶层直接用上述全局，顶层 return 结果；② `export default async function({ agent, parallel, pipeline, log, phase, budget, args }) { ... }` 解构入参，函数内 return 结果。",
  "脚本拿不到 require/process/fs/net；禁用 Math.random/Date.now。",
  "工具立即返回任务 id 后在后台执行（不阻塞当前轮），脚本 return 值即该后台任务的最终结果，完成后自动回到对话。",
  "workflow 的 agent 节点是受控的一次性线程，允许高并发 fan-out（默认最多 256 个同时运行，总派发 1000 个）。",
].join("\n");

const PARAMETERS = Type.Object({
  script: Type.String({ description: "编排脚本，以 export const meta = {...} 开头" }),
  // 若本项目 typebox 封装无 Type.Any，用 Type.Unknown()。
  args: Type.Optional(Type.Any({ description: "传给脚本 args 全局的参数" })),
});

function makeLimiter() {
  return createLimiter({ maxConcurrent: WORKFLOW_AGENT_MAX_CONCURRENT, maxTotal: AGENT_TOTAL_BACKSTOP });
}

/** 一条 usage entry 的总 token（优先顶层 totalTokens，回退 input+output）。 */
function usageTokens(usage) {
  if (!usage) return 0;
  if (typeof usage.totalTokens === "number") return usage.totalTokens;
  return (usage.input?.totalTokens || 0) + (usage.output?.totalTokens || 0);
}

/** 按子节点 session 从 UsageLedger 汇总 token；无 ledger / 无记录返回 null（节点行不显示）。 */
function sumNodeTokens(ledger, childSessionPath) {
  if (!ledger?.list || !childSessionPath) return null;
  const { entries } = ledger.list({ childSessionPath });
  if (!entries?.length) return null;
  return entries.reduce((sum, e) => sum + usageTokens(e.usage), 0);
}

/**
 * @param {{
 *   executeIsolated: (prompt: string, isoOpts: object) => Promise<object>,
 *   getSessionPath?: () => string|null,
 *   getParentCwd?: () => string|null,
 *   getAgentId?: () => string|undefined,
 *   emitEvent?: (event: object, sessionPath: string|null) => void,
 *   resolveAgentId?: (agentType?: string) => string|undefined,
 *   getDeferredStore?: () => import("../deferred-result-store.js").DeferredResultStore|null,
 *   getSubagentRunStore?: () => import("../subagent-run-store.js").SubagentRunStore|null,
 *   getSubagentThreadStore?: () => import("../subagent-thread-store.js").SubagentThreadStore|null,
 * }} deps
 */
export function createWorkflowTool(deps) {
  return {
    name: "workflow",
    label: "Workflow",
    description: WORKFLOW_DESCRIPTION,
    parameters: PARAMETERS,
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const parentSessionPath = getToolSessionPath(ctx) || deps.getSessionPath?.() || null;
      const cwd = getToolSessionCwd(ctx) || deps.getParentCwd?.() || null;
      const agentId = deps.getAgentId?.() || undefined;

      // 先静态校验脚本头：非法脚本同步报错，不派后台任务
      // （禁止非用户预期 fallback：不把非法输入伪装成"已派出"）。
      let meta;
      try {
        ({ meta } = extractMeta(params.script));
      } catch (err) {
        return toolError(`workflow 脚本非法: ${err.message}`);
      }

      const store = deps.getDeferredStore?.();
      const runStore = deps.getSubagentRunStore?.();
      const threadStore = deps.getSubagentThreadStore?.();

      // deferred 基础设施不可用（或无 parent session）→ 同步兜底执行，调用方直接拿结果。
      // 与 subagent 一致：这是基础设施缺失时的等价行为，不是静默降级。
      if (!store || !parentSessionPath) {
        return _syncRun(deps, params, meta, { agentId, cwd, parentSessionPath });
      }

      const taskId = `workflow-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const summary = meta.name;
      const hub = deps.getActivityHub?.();
      const startedAt = Date.now();

      store.defer(taskId, parentSessionPath, { type: "workflow", summary });
      runStore?.register?.(taskId, { parentSessionPath, summary });
      hub?.upsert({ id: taskId, kind: "workflow", status: "running", sessionPath: parentSessionPath, agentId, summary, startedAt });

      // 后台任务独立生命周期：execute 的 signal 在返回后即失效，用自己的 AbortController；
      // 再加一道超时兜底（正常由 runWorkflowScript 内部 deadline 先触发）。
      const controller = new AbortController();
      const timeoutTimer = setTimeout(() => controller.abort(), WORKFLOW_TIMEOUT_BACKSTOP_MS);
      if (timeoutTimer.unref) timeoutTimer.unref();

      const limiter = makeLimiter();
      const hostApi = createHostApi({
        executeIsolated: (prompt, isoOpts) => deps.executeIsolated(prompt, isoOpts),
        baseIsoOpts: { agentId, cwd, parentSessionPath, subagentContext: true, subagentTaskId: taskId, emitEvents: true },
        limiter,
        signal: controller.signal,
        onProgress: (evt) => deps.emitEvent?.({ ...evt, type: "workflow_progress", taskId }, parentSessionPath),
        // 节点级活动 → ActivityHub 子 entry（右侧 WorkflowCard 展开的每个 agent 节点）。
        // 子 entry 自带 sessionPath(=parent) + parentTaskId，状态归属唯一确定，不靠前端从父 wf 推导。
        onAgentEvent: (evt) => {
          const childId = `${taskId}::${evt.nodeId}`;
          if (evt.phase === "start") {
            if (evt.threadId) {
              threadStore?.beginRun?.(evt.threadId, {
                kind: evt.threadKind || "workflow_node",
                parentTaskId: taskId,
                nodeId: evt.nodeId,
                parentSessionPath,
                agentId: evt.agentId || null,
                label: evt.label || null,
                summary: evt.label || evt.phaseLabel || summary,
              });
            }
            hub?.upsert({
              id: childId, kind: "workflow_agent", status: "running",
              sessionPath: parentSessionPath, parentTaskId: taskId,
              threadId: evt.threadId || null, threadKind: evt.threadKind || null,
              agentId: evt.agentId || null, label: evt.label || null,
              phaseLabel: evt.phaseLabel || null, startedAt: Date.now(),
            });
          } else if (evt.phase === "session") {
            if (evt.threadId) {
              threadStore?.attachSession?.(evt.threadId, evt.childSessionPath || null, {
                parentTaskId: taskId,
                nodeId: evt.nodeId,
              });
            }
            hub?.upsert({ id: childId, childSessionPath: evt.childSessionPath || null });
          } else if (evt.phase === "done") {
            // 从 UsageLedger 按子节点 session 汇总 token（usage 已在 executeIsolated 的 recordAssistantUsage 采集）。
            const node = hub?.get?.(childId);
            const tokens = sumNodeTokens(deps.getUsageLedger?.(), node?.childSessionPath);
            if (evt.threadId) {
              threadStore?.finishRun?.(evt.threadId, {
                status: "resolved",
                close: true,
              });
            }
            hub?.upsert({ id: childId, status: "done", finishedAt: Date.now(), ...(tokens != null ? { tokens } : {}) });
          } else if (evt.phase === "fail") {
            if (evt.threadId) {
              threadStore?.finishRun?.(evt.threadId, {
                status: "failed",
                close: true,
              });
            }
            hub?.upsert({ id: childId, status: "failed", finishedAt: Date.now() });
          }
        },
        budget: { total: null, spent: () => 0, remaining: () => Infinity }, // 二期接真 usage 计量
        args: params.args,
        resolveAgentId: deps.resolveAgentId,
      });

      // fire-and-forget：不 await。后台跑完 resolve/fail 写入 deferred store，
      // DeferredResultCoordinator 监听后以 <hana-background-result type="workflow"> steer 回灌主对话。
      runWorkflowScript(params.script, hostApi, { signal: controller.signal, deadlineMs: WORKFLOW_DEADLINE_MS })
        .then(({ result }) => {
          const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
          const finishedAt = Date.now();
          store.resolve(taskId, text);
          runStore?.resolve?.(taskId, text);
          hub?.upsert({ id: taskId, status: "done", finishedAt });
          // inline 概览块（聊天流工具卡）翻 done：复刻 subagent 的 block_update 范式，
          // 让聊天里那张卡随完成刷新状态 + 算总时长（finishedAt - startedAt）。
          deps.emitEvent?.({ type: "block_update", taskId, patch: { streamStatus: "done", finishedAt } }, parentSessionPath);
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
        `workflow "${summary}" 已派出后台执行（任务 ${taskId}），完成后结果会自动回到对话。`,
        { taskId, workflow: summary, streamStatus: "running", startedAt },
      );
    },
  };
}

/** deferred 基础设施不可用时同步执行，保留原同步语义（调用方直接拿合成结果）。 */
async function _syncRun(deps, params, meta, { agentId, cwd, parentSessionPath }) {
  const limiter = makeLimiter();
  // 与后台路径同款超时兜底：用 AbortController + WORKFLOW_TIMEOUT_BACKSTOP_MS 定时器，
  // 防 runWorkflowScript 在内部 deadline 之外卡死、把子 agent 留成孤儿（正常由内部 deadline 先触发）。
  const controller = new AbortController();
  const timeoutTimer = setTimeout(() => controller.abort(), WORKFLOW_TIMEOUT_BACKSTOP_MS);
  if (timeoutTimer.unref) timeoutTimer.unref();
  const hostApi = createHostApi({
    executeIsolated: (prompt, isoOpts) => deps.executeIsolated(prompt, isoOpts),
    baseIsoOpts: { agentId, cwd, parentSessionPath, subagentContext: true, emitEvents: true },
    limiter,
    signal: controller.signal,
    onProgress: (evt) => deps.emitEvent?.({ ...evt, type: "workflow_progress" }, parentSessionPath),
    budget: { total: null, spent: () => 0, remaining: () => Infinity },
    args: params.args,
    resolveAgentId: deps.resolveAgentId,
  });
  try {
    const { result } = await runWorkflowScript(params.script, hostApi, { signal: controller.signal, deadlineMs: WORKFLOW_DEADLINE_MS });
    const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
    return toolOk(
      `workflow "${meta.name}" 完成，派出 ${limiter.totalSpawned} 个 agent。\n\n结果:\n${text}`,
      { workflow: meta.name, agentsSpawned: limiter.totalSpawned, result },
    );
  } catch (err) {
    return toolError(`workflow 执行失败: ${err.message}`, { agentsSpawned: limiter.totalSpawned });
  } finally {
    clearTimeout(timeoutTimer);
  }
}
