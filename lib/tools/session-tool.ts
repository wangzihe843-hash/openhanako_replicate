// session — 跨 session 协作工具（单工具多 action + 渐进式手册）。
// 读侧零副作用；写侧只产草稿卡（Task 5 实现），投递由用户确认后经 draft-store.apply 执行。
// 身份纪律：入参/输出只认 sessionId，path 仅在 manifest 解析后的内部下游出现，绝不进入工具输出文本。
import { Type, StringEnum } from "../pi-sdk/index.ts";
import { getToolSessionPath } from "./tool-session.ts";
import { loadSessionHistoryMessages } from "../../core/message-utils.ts";
import { searchSessions } from "../search/session-search.ts";
import { buildCompactTranscript } from "../session-collab/transcript.ts";
import { sessionToolHandbook, sessionToolUsageError } from "../session-collab/handbook.ts";

function textResult(text: string, details: any = undefined) {
  return { content: [{ type: "text", text }], ...(details ? { details } : {}) };
}

function usageError(action: string, reason: string) {
  return textResult(sessionToolUsageError(action, reason));
}

function sessionLine(engine: any, s: any): string {
  const streaming = engine.isSessionStreaming?.(s.path) === true;
  const modified = s.modified instanceof Date ? s.modified.toISOString() : (s.modified || "unknown");
  return [
    s.sessionId || engine.getSessionIdForPath?.(s.path) || "unknown-id",
    s.title || "(untitled)",
    `${s.agentName || s.agentId || "unknown"}`,
    s.modelId || "",
    modified,
    streaming ? "streaming" : "",
  ].filter(Boolean).join(" · ");
}

// manifest 上没有 title 字段（title 只存在于 engine.listSessions() 的条目里，读单个 session
// 不为了 title 再拉一次全量列表），归属字段是 ownerAgentId（见
// core/session-manifest/store.ts toRowManifest），resolveSessionOwnership 兜底同一语义。
function resolveTarget(engine: any, sessionId: string) {
  const manifest = engine.getSessionManifest?.(sessionId) || null;
  const path = manifest?.currentLocator?.path || null;
  if (!path) return null;
  const agentId = manifest?.ownerAgentId || engine.resolveSessionOwnership?.(path)?.agentId || null;
  return { path, agentId, manifest };
}

export function createSessionTool(deps: {
  getEngine: () => any;
  getDraftStore: () => any;
  listAgents: (() => any[]) | null;
  agentId: string;
  getAgentName: () => string;
}) {
  return {
    name: "session",
    label: "Session Collaboration",
    description: "Cross-session collaboration: list/read other sessions, send messages, create sessions. Call with action:\"?\" first for the full usage guide.",
    parameters: Type.Object({
      action: StringEnum(["list", "read", "send", "create", "?"],
        { description: 'Action. Call "?" first for the full usage guide.' }),
      sessionId: Type.Optional(Type.String({ description: "Target session id (required for read/send)" })),
      query: Type.Optional(Type.String({ description: "Keyword filter (optional for list)" })),
      mode: Type.Optional(StringEnum(["summary", "transcript"], { description: "read depth, default summary" })),
      cursor: Type.Optional(Type.String({ description: "Paging cursor from previous read result" })),
      count: Type.Optional(Type.Number({ description: "Turns per page (optional for read, default 10)" })),
      message: Type.Optional(Type.String({ description: "Message body (required for send/create)" })),
      agent: Type.Optional(Type.String({ description: "Target agent id (required for create)" })),
      model: Type.Optional(Type.String({ description: "Model override as provider/id (optional for create)" })),
      title: Type.Optional(Type.String({ description: "New session title (optional for create)" })),
    }),

    execute: async (_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: any) => {
      const engine = deps.getEngine();
      if (!engine) return textResult("session tool unavailable: engine not ready");
      const action = params?.action;

      if (action === "?") return textResult(sessionToolHandbook());

      if (action === "list") {
        let sessions = await engine.listSessions();
        const query = typeof params.query === "string" ? params.query.trim() : "";
        if (query) {
          let hits = searchSessions(sessions, query, { phase: "title" });
          if (!hits.length) hits = searchSessions(sessions, query, { phase: "content" });
          const byPath = new Map(sessions.map((s: any) => [s.path, s]));
          sessions = hits.map((h: any) => byPath.get(h.path)).filter(Boolean);
        }
        if (!sessions.length) return textResult(query ? `No sessions matched "${query}".` : "No sessions.");
        return textResult(sessions.map((s: any) => "- " + sessionLine(engine, s)).join("\n"));
      }

      if (action === "read") {
        const sessionId = typeof params.sessionId === "string" ? params.sessionId.trim() : "";
        if (!sessionId) return usageError("read", "sessionId is required for read.");
        const target = resolveTarget(engine, sessionId);
        if (!target) return usageError("read", `Session not found: ${sessionId}`);
        const mode = params.mode === "transcript" ? "transcript" : "summary";
        const agent = target.agentId ? engine.getAgent?.(target.agentId) || null : null;
        const meta = {
          sessionId,
          title: null as string | null, // manifest 不携带 title，读单 session 不为此再拉全量 listSessions
          agentId: target.agentId,
          agentName: agent?.agentName || target.agentId,
          isStreaming: engine.isSessionStreaming?.(target.path) === true,
        };

        if (mode === "summary") {
          const record = agent?.summaryManager?.getSummary?.(sessionId) || null;
          if (record?.summary?.trim()) {
            return textResult([
              `session ${sessionId} · agent ${meta.agentName} · summary (updated ${record.updated_at || "unknown"}):`,
              record.summary.trim(),
              "",
              'For details use mode:"transcript".',
            ].join("\n"));
          }
          return textResult([
            `session ${sessionId} · agent ${meta.agentName} — no summary exists for this session.`,
            'Use mode:"transcript" to read the actual turns. (Summaries are never generated on demand.)',
          ].join("\n"));
        }

        const messages = await loadSessionHistoryMessages(engine, target.path);
        try {
          const page = buildCompactTranscript(messages, { meta, cursor: params.cursor, count: params.count });
          const footer = page.cursor ? `\n(older turns: pass cursor:"${page.cursor}")` : "\n(reached the earliest turn)";
          return textResult(`${page.header}\n\n${page.body}${footer}`);
        } catch (err: any) {
          return usageError("read", err?.message || String(err));
        }
      }

      if (action === "send" || action === "create") {
        // Task 5 实现；先返回显式未实现错误，禁止静默
        void getToolSessionPath(ctx); // 预留：Task 5 用来判定"发给自己"应被拒绝
        return textResult(`action "${action}" not implemented yet`);
      }

      return usageError(String(action), `Unknown action: ${action}`);
    },
  };
}
