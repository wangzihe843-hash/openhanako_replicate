
import { createStructuredOutputTool } from "./structured-output.ts";
import { WorkflowJournal } from "./journal.ts";
import { resolveSubagentToolAccess } from "../tools/subagent-tool-policy.ts";

export const WORKFLOW_RUNTIME_CONTRACT = Symbol.for("hana.workflow.runtimeContract");

const AGENT_OPTION_KEYS = new Set(["label", "model", "agentType", "toolFilter", "access", "schema"]);

function normalizeAgentOptions(rawOpts) {
  if (rawOpts == null) return {};
  if (typeof rawOpts !== "object" || Array.isArray(rawOpts)) {
    throw new Error("workflow agent(prompt, opts) 的 opts 必须是对象。");
  }
  for (const key of Object.keys(rawOpts)) {
    if (!AGENT_OPTION_KEYS.has(key)) {
      throw new Error(
        `workflow agent() unsupported option "${key}". ` +
        "Use agent(prompt, { label?, model?, agentType?, access?, schema?, toolFilter? }); " +
        "put the task instructions in the first prompt argument.",
      );
    }
  }
  if (rawOpts.access != null && rawOpts.access !== "read" && rawOpts.access !== "write") {
    throw new Error('workflow agent() access must be "read" or "write".');
  }
  return rawOpts;
}

function normalizeAgentPrompt(prompt) {
  if (typeof prompt !== "string" || !prompt.trim()) {
    throw new Error("workflow agent(prompt, opts) requires a non-empty prompt string as the first argument.");
  }
  return prompt;
}

function createWorkflowRuntimeContract() {
  const calls = [];

  function trackAgentCall(meta, start) {
    const record = { ...meta, consumed: false };
    calls.push(record);
    let promise = null;

    const consume = () => {
      record.consumed = true;
      if (!promise) {
        promise = Promise.resolve().then(start);
      }
      return promise;
    };

    return new Proxy(Object.create(null), {
      get(_target, prop) {
        if (prop === "then") return (onFulfilled, onRejected) => consume().then(onFulfilled, onRejected);
        if (prop === "catch") return (onRejected) => consume().catch(onRejected);
        if (prop === "finally") return (onFinally) => consume().finally(onFinally);
        if (prop === Symbol.toStringTag) return "Promise";
        if (prop === "result") {
          throw new Error(
            "workflow agent() returns a Promise. Use \"const result = await agent(...)\" before reading the result; " +
            "do not use agent(...).result.",
          );
        }
        throw new Error(
          `workflow agent() returns a Promise. Await agent("${record.promptPreview}") before reading property "${String(prop)}".`,
        );
      },
    });
  }

  function assertNoUnawaitedAgentCalls() {
    const unawaited = calls.filter((call) => !call.consumed);
    if (!unawaited.length) return;
    const first = unawaited[0];
    throw new Error(
      `workflow agent() call ${first.nodeId} was not awaited. ` +
      'Use `const result = await agent("task prompt", { access, agentType })`; ' +
      "agent() does not return { result }.",
    );
  }

  return { trackAgentCall, assertNoUnawaitedAgentCalls };
}

/**
 * 组装注入沙箱的宿主 API。引擎层不认识 agent 名字，agentType→agentId 的解析由调用方注入 resolveAgentId。
 * @param {{
 *   executeIsolated: (prompt: string, isoOpts: object) => Promise<{ replyText?: string, error?: string|null }>,
 *   baseIsoOpts: object,
 *   limiter: { run: (thunk: () => Promise<any>) => Promise<any> },
 *   signal?: AbortSignal,
 *   onProgress?: (evt: object) => void,
 *   onAgentEvent?: (evt: { phase: 'start'|'session'|'done'|'fail', nodeId: string, threadId?: string|null, threadKind?: string|null, label?: string|null, agentId?: string|null, phaseLabel?: string|null, childSessionId?: string|null, childSessionPath?: string|null }) => void,
 *   budget?: { total: number|null, spent: () => number, remaining: () => number },
 *   args?: any,
 *   resolveAgentId?: (agentType?: string) => string|undefined,
 *   journal?: import("./journal.ts").WorkflowJournal|null,
 *   replayJournal?: import("./journal.ts").WorkflowJournal|null,
 *   runWorkflow?: (script: string, args?: any) => Promise<any>,
 * }} deps
 * @returns {{ agent: Function, parallel: Function, pipeline: Function, log: Function, phase: Function, workflow: Function, budget: any, args: any }}
 */
export function createHostApi(deps) {
  const { executeIsolated, baseIsoOpts, limiter, signal, budget, args, resolveAgentId } = deps;
  const onAgentEvent = typeof deps.onAgentEvent === "function" ? deps.onAgentEvent : () => {};
  const journal = deps.journal || null;
  const replayJournal = deps.replayJournal || null;
  const runtimeContract = createWorkflowRuntimeContract();
  let nodeSeq = 0;
  let currentPhase = null;

  function agent(prompt, rawOpts: { label?: string; model?: string; agentType?: string; toolFilter?: any; access?: "read"|"write"; schema?: any } = {}) {
    const normalizedPrompt = normalizeAgentPrompt(prompt);
    const opts = normalizeAgentOptions(rawOpts);

    // nodeId 在调用入口分配：用纯计数器，不依赖沙箱里被禁用的 Date.now/Math.random。
    const seq = ++nodeSeq;
    const nodeId = `node-${seq}`;
    const parentTaskId = typeof baseIsoOpts.subagentTaskId === "string" && baseIsoOpts.subagentTaskId
      ? baseIsoOpts.subagentTaskId
      : null;
    const threadId = parentTaskId ? `${parentTaskId}::${nodeId}` : null;
    const threadKind = threadId ? "workflow_node" : null;
    const label = typeof opts.label === "string" && opts.label ? opts.label : null;

    const startAgentNode = async () => {
      // ── journal 回放：cache hit 不消耗 limiter slot，瞬间返回 ──
      if (replayJournal) {
        const replayKey = WorkflowJournal.computeKey(normalizedPrompt, opts);
        const cached = replayJournal.tryReplay(seq, replayKey);
        if (cached) {
          onAgentEvent({ phase: "start", nodeId, threadId, threadKind, label, agentId: baseIsoOpts.agentId ?? null, phaseLabel: currentPhase });
          onAgentEvent({ phase: "done", nodeId, threadId, threadKind });
          journal?.record(seq, replayKey, cached.result, "ok");
          return cached.result;
        }
      }

      return limiter.run(async () => {
        if (signal?.aborted) throw new Error("workflow 已中止");

        // budget 硬上限：spent >= total 时拒绝新 agent
        if (budget?.total != null && budget.remaining() <= 0) {
          throw new Error(`workflow token 预算耗尽（已用 ${budget.spent()}）`);
        }

        const isoOpts = { ...baseIsoOpts, signal };
        if (threadId) {
          isoOpts.subagentThreadId = threadId;
          isoOpts.subagentThreadKind = threadKind;
        }
        if (opts.access === "read" || opts.access === "write") {
          const toolAccess = resolveSubagentToolAccess({
            access: opts.access,
            parentPermissionMode: baseIsoOpts.permissionMode || null,
          });
          isoOpts.permissionMode = toolAccess.permissionMode;
          if (toolAccess.customToolFilter) isoOpts.toolFilter = toolAccess.customToolFilter;
          if (toolAccess.builtinToolFilter) isoOpts.builtinFilter = toolAccess.builtinToolFilter;
        }
        if (opts.model) isoOpts.model = opts.model;
        let nodeAgentId = isoOpts.agentId ?? null;
        if (opts.agentType) {
          if (typeof resolveAgentId !== "function") {
            throw new Error(`workflow agentType "${opts.agentType}" cannot be resolved in this environment.`);
          }
          const id = resolveAgentId(opts.agentType);
          if (!id) throw new Error(`workflow agentType "${opts.agentType}" was not found.`);
          isoOpts.agentId = id;
          nodeAgentId = id;
        }
        if (opts.toolFilter) isoOpts.toolFilter = opts.toolFilter;

        // 节点级活动上报（→ workflow-tool → ActivityHub 子 entry，右侧 WorkflowCard 的每个 agent 节点行）。
        onAgentEvent({ phase: "start", nodeId, threadId, threadKind, label, agentId: nodeAgentId, phaseLabel: currentPhase });
        // 子 session 创建后回补稳定身份 + locator：ID 用于内部归属，path 用于实时流定位。
        isoOpts.onSessionReady = (sp, meta: any = {}) => onAgentEvent({
          phase: "session",
          nodeId,
          threadId,
          threadKind,
          childSessionId: typeof meta?.sessionId === "string" && meta.sessionId.trim() ? meta.sessionId.trim() : null,
          childSessionPath: sp,
        });

        let structured = null;
        let finalPrompt = normalizedPrompt;
        if (opts.schema) {
          structured = createStructuredOutputTool(opts.schema);
          isoOpts.extraCustomTools = [...(isoOpts.extraCustomTools || []), structured.tool];
          finalPrompt = normalizedPrompt + "\n\n完成后必须调用一次 structured_output 工具，返回严格符合所需 schema 的结果。";
        }

        const journalKey = journal ? WorkflowJournal.computeKey(normalizedPrompt, opts) : null;

        try {
          const res = await executeIsolated(finalPrompt, isoOpts);
          if (res?.error) throw new Error(`agent 失败: ${res.error}`);
          let result;
          if (structured) {
            const out = structured.getResult();
            if (out === undefined) throw new Error("agent 未调用 structured_output 返回结构化结果");
            result = out;
          } else {
            result = res?.replyText ?? "";
          }
          onAgentEvent({ phase: "done", nodeId, threadId, threadKind });
          if (journalKey) journal.record(seq, journalKey, result, "ok");
          return result;
        } catch (err) {
          onAgentEvent({ phase: "fail", nodeId, threadId, threadKind });
          if (journalKey) journal.record(seq, journalKey, null, "error");
          throw err;
        }
      });
    };

    return runtimeContract.trackAgentCall(
      { nodeId, promptPreview: normalizedPrompt.slice(0, 80) },
      startAgentNode,
    );
  }

  async function parallel(thunks) {
    const seq = ++nodeSeq;
    const stepNodeId = `step-${seq}`;
    onAgentEvent({ phase: "start", nodeId: stepNodeId, stepKind: "parallel", phaseLabel: currentPhase });
    try {
      const result = await Promise.all((thunks || []).map((thunk) =>
        Promise.resolve().then(thunk).catch(() => null)
      ));
      onAgentEvent({ phase: "done", nodeId: stepNodeId, stepKind: "parallel" });
      return result;
    } catch (err) {
      onAgentEvent({ phase: "fail", nodeId: stepNodeId, stepKind: "parallel" });
      throw err;
    }
  }

  async function pipeline(items, ...stages) {
    const seq = ++nodeSeq;
    const stepNodeId = `step-${seq}`;
    onAgentEvent({ phase: "start", nodeId: stepNodeId, stepKind: "pipeline", phaseLabel: currentPhase });
    try {
      const result = await Promise.all((items || []).map(async (item, index) => {
        let cur = item;
        for (const stage of stages) {
          try { cur = await stage(cur, item, index); }
          catch { return null; }
        }
        return cur;
      }));
      onAgentEvent({ phase: "done", nodeId: stepNodeId, stepKind: "pipeline" });
      return result;
    } catch (err) {
      onAgentEvent({ phase: "fail", nodeId: stepNodeId, stepKind: "pipeline" });
      throw err;
    }
  }

  // ── workflow 嵌套：子 workflow 共享 limiter / signal / budget，限一层 ──
  async function workflow(script, childArgs) {
    if (typeof deps.runWorkflow !== "function") {
      throw new Error("当前环境不支持 workflow 嵌套调用");
    }
    return deps.runWorkflow(script, childArgs);
  }

  const onProgress = typeof deps.onProgress === "function" ? deps.onProgress : () => {};
  function log(message) {
    const seq = ++nodeSeq;
    const stepNodeId = `step-${seq}`;
    const msg = String(message);
    onAgentEvent({ phase: "start", nodeId: stepNodeId, stepKind: "log", label: msg, phaseLabel: currentPhase });
    onAgentEvent({ phase: "done", nodeId: stepNodeId, stepKind: "log" });
    onProgress({ type: "log", message: msg });
  }
  function phase(title) {
    // 记住最近一次 phase 标题，作为后续 agent 节点的弱分组标签（best-effort，非契约）。
    currentPhase = String(title);
    onProgress({ type: "phase", title: currentPhase });
  }

  const api = { agent, parallel, pipeline, workflow, log, phase, budget, args };
  Object.defineProperty(api, WORKFLOW_RUNTIME_CONTRACT, {
    value: runtimeContract,
    enumerable: false,
  });
  return api;
}
