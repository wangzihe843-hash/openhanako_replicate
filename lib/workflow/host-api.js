import { createStructuredOutputTool } from "./structured-output.js";

/**
 * 组装注入沙箱的宿主 API。引擎层不认识 agent 名字，agentType→agentId 的解析由调用方注入 resolveAgentId。
 * @param {{
 *   executeIsolated: (prompt: string, isoOpts: object) => Promise<{ replyText?: string, error?: string|null }>,
 *   baseIsoOpts: object,
 *   limiter: { run: (thunk: () => Promise<any>) => Promise<any> },
 *   signal?: AbortSignal,
 *   onProgress?: (evt: object) => void,
 *   onAgentEvent?: (evt: { phase: 'start'|'session'|'done'|'fail', nodeId: string, threadId?: string|null, threadKind?: string|null, label?: string|null, agentId?: string|null, phaseLabel?: string|null, childSessionPath?: string|null }) => void,
 *   budget?: { total: number|null, spent: () => number, remaining: () => number },
 *   args?: any,
 *   resolveAgentId?: (agentType?: string) => string|undefined,
 * }} deps
 * @returns {{ agent: Function, parallel: Function, pipeline: Function, log: Function, phase: Function, budget: any, args: any }}
 */
export function createHostApi(deps) {
  const { executeIsolated, baseIsoOpts, limiter, signal, budget, args, resolveAgentId } = deps;
  const onAgentEvent = typeof deps.onAgentEvent === "function" ? deps.onAgentEvent : () => {};
  let nodeSeq = 0;
  let currentPhase = null;

  async function agent(prompt, opts = {}) {
    // nodeId 在调用入口分配：用纯计数器，不依赖沙箱里被禁用的 Date.now/Math.random。
    const nodeId = `node-${++nodeSeq}`;
    const parentTaskId = typeof baseIsoOpts.subagentTaskId === "string" && baseIsoOpts.subagentTaskId
      ? baseIsoOpts.subagentTaskId
      : null;
    const threadId = parentTaskId ? `${parentTaskId}::${nodeId}` : null;
    const threadKind = threadId ? "workflow_node" : null;
    const label = typeof opts.label === "string" && opts.label ? opts.label : null;
    return limiter.run(async () => {
      if (signal?.aborted) throw new Error("workflow 已中止");
      const isoOpts = { ...baseIsoOpts, signal };
      if (threadId) {
        isoOpts.subagentThreadId = threadId;
        isoOpts.subagentThreadKind = threadKind;
      }
      if (opts.model) isoOpts.model = opts.model;
      let nodeAgentId = isoOpts.agentId ?? null;
      if (opts.agentType && typeof resolveAgentId === "function") {
        const id = resolveAgentId(opts.agentType);
        if (id) { isoOpts.agentId = id; nodeAgentId = id; }
      }
      if (opts.toolFilter) isoOpts.toolFilter = opts.toolFilter;

      // 节点级活动上报（→ workflow-tool → ActivityHub 子 entry，右侧 WorkflowCard 的每个 agent 节点行）。
      onAgentEvent({ phase: "start", nodeId, threadId, threadKind, label, agentId: nodeAgentId, phaseLabel: currentPhase });
      // 子 session 创建后回补 childSessionPath（节点行展开看实时流用）。
      isoOpts.onSessionReady = (sp) => onAgentEvent({ phase: "session", nodeId, threadId, threadKind, childSessionPath: sp });

      let structured = null;
      let finalPrompt = prompt;
      if (opts.schema) {
        structured = createStructuredOutputTool(opts.schema);
        isoOpts.extraCustomTools = [...(isoOpts.extraCustomTools || []), structured.tool];
        finalPrompt = prompt + "\n\n完成后必须调用一次 structured_output 工具，返回严格符合所需 schema 的结果。";
      }

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
        return result;
      } catch (err) {
        onAgentEvent({ phase: "fail", nodeId, threadId, threadKind });
        throw err;
      }
    });
  }

  async function parallel(thunks) {
    return Promise.all((thunks || []).map((thunk) =>
      Promise.resolve().then(thunk).catch(() => null)
    ));
  }

  async function pipeline(items, ...stages) {
    return Promise.all((items || []).map(async (item, index) => {
      let cur = item;
      for (const stage of stages) {
        try { cur = await stage(cur, item, index); }
        catch { return null; }
      }
      return cur;
    }));
  }

  const onProgress = typeof deps.onProgress === "function" ? deps.onProgress : () => {};
  function log(message) { onProgress({ type: "log", message: String(message) }); }
  function phase(title) {
    // 记住最近一次 phase 标题，作为后续 agent 节点的弱分组标签（best-effort，非契约）。
    currentPhase = String(title);
    onProgress({ type: "phase", title: currentPhase });
  }

  return { agent, parallel, pipeline, log, phase, budget, args };
}
