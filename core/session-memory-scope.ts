import { normalizeMemoryScopeContext, type MemoryScopeContext } from "../shared/memory-scope.ts";
import { getChannelPostRetryContext } from "../lib/task-outcome/effect-ledger.ts";

/** Branch-local, durable metadata. Never inferred from dialogue or model output. */
export const SESSION_MEMORY_SCOPE_RECORD = "hana-memory-scope";

type ScopeEntry = { type?: string; customType?: string; data?: { memoryScope?: unknown } };
type RuntimeTool = { name: string; execute(...args: unknown[]): unknown };

export function memoryScopeFromBranch(branch: ScopeEntry[], agentId: string): MemoryScopeContext {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry?.type !== "custom" || entry.customType !== SESSION_MEMORY_SCOPE_RECORD) continue;
    if (!entry.data || !Object.hasOwn(entry.data, "memoryScope") || !entry.data.memoryScope
      || typeof entry.data.memoryScope !== "object" || Array.isArray(entry.data.memoryScope)) {
      throw new Error("Invalid persisted memory scope; repair or restore the scope record before continuing");
    }
    const scope = normalizeMemoryScopeContext(entry.data?.memoryScope, agentId);
    if (scope.agentId !== agentId) throw new Error("Memory scope does not belong to this session's agent");
    return scope;
  }
  return normalizeMemoryScopeContext(undefined, agentId);
}

/** Pure narrative sessions cannot execute arbitrary tools, including deferred/plugin tools. */
export function guardMemoryScopeTools<T extends RuntimeTool>(tools: T[], getScope: () => MemoryScopeContext): T[] {
  return tools.map((tool) => ({
    ...tool,
    execute: async (...args: unknown[]) => {
      const scope = getScope();
      if (scope.realm === "story" && tool.name !== "search_memory") {
        throw new Error("story_tool_disabled: narrative sessions allow scoped memory search only; use a reality session for real actions");
      }
      if (getChannelPostRetryContext()) {
        const readOnly = new Set(["search_memory", "current_status", "read", "grep", "find", "ls", "web_search", "web_fetch"]);
        const supportedEffect = tool.name === "channel" && (args[1] as { action?: string } | null)?.action === "post";
        if (!readOnly.has(tool.name) && !supportedEffect) {
          throw new Error("task_retry_tool_disabled: this action has no supported retry receipt; start a separate task explicitly");
        }
      }
      return tool.execute(...args);
    },
  }) as T);
}
