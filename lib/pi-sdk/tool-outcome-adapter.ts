import { projectKnownLegacyToolFailures } from "../../shared/tool-outcome.ts";

const adaptedAgents = new WeakSet<object>();

/**
 * Pi 1.0 handles returned isError values before its native extension hook.
 * Leave that hook intact: echoing content would discard structuredContent.
 * Only project recognized legacy failures when replaying stored context.
 */
export function installToolOutcomeAdapter(session: any): void {
  const agent = session?.agent;
  if (!agent || adaptedAgents.has(agent)) return;

  const previousTransformContext = agent.transformContext;
  agent.transformContext = async (messages: unknown, signal?: AbortSignal) => {
    const transformed = typeof previousTransformContext === "function"
      ? await previousTransformContext(messages, signal)
      : messages;
    return projectKnownLegacyToolFailures(transformed);
  };
  adaptedAgents.add(agent);
}
