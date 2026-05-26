import { DEFAULT_DISABLED_TOOL_NAMES } from "../../../shared/tool-categories.js";

export const BEAUTIFY_OPTIONAL_TOOL_NAME = "beautify";

export function isBeautifyEnabledForAgentConfig(agentConfig = {}) {
  const disabled = Array.isArray(agentConfig?.tools?.disabled)
    ? agentConfig.tools.disabled
    : DEFAULT_DISABLED_TOOL_NAMES;
  return !disabled.includes(BEAUTIFY_OPTIONAL_TOOL_NAME);
}
