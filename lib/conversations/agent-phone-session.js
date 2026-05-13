/**
 * Agent Phone session policy helpers.
 *
 * The runner lives in hub/agent-executor.js because it needs Engine session
 * context. This module keeps the reusable policy pieces pure and testable.
 */

import path from "path";
import { READ_ONLY_BUILTIN_TOOLS } from "../../core/config-coordinator.js";
import { safeConversationStem } from "./agent-phone-projection.js";

export const AGENT_PHONE_TOOL_MODES = Object.freeze({
  READ_ONLY: "read_only",
  WRITE: "write",
});

export const AGENT_PHONE_COMPACTION = Object.freeze({
  IDLE_TOKENS: 120_000,
  HARD_TOKENS: 180_000,
});

const READ_ONLY_CUSTOM_TOOLS = new Set([
  "search_memory",
  "recall_experience",
  "web_search",
  "web_fetch",
  "current_status",
]);

const PHONE_EXCLUDED_TOOL_NAMES = new Set([
  "browser",
  "chrome",
  "channel",
  "dm",
]);

export function getAgentPhoneSessionDir(agentDir, conversationId) {
  return path.join(agentDir, "phone", "sessions", safeConversationStem(conversationId));
}

export function getAgentPhoneRefreshDate(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function shouldRefreshAgentPhoneSession(meta = {}, now = new Date()) {
  return meta?.lastRefreshedDate !== getAgentPhoneRefreshDate(now);
}

export function isAgentPhoneSessionPath(sessionPath) {
  if (!sessionPath || typeof sessionPath !== "string") return false;
  const parts = path.normalize(sessionPath).split(path.sep).filter(Boolean);
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (parts[i] === "phone" && parts[i + 1] === "sessions") return true;
  }
  return false;
}

export function normalizeAgentPhoneToolMode(mode) {
  return mode === AGENT_PHONE_TOOL_MODES.WRITE
    ? AGENT_PHONE_TOOL_MODES.WRITE
    : AGENT_PHONE_TOOL_MODES.READ_ONLY;
}

export function shouldCompactAgentPhoneSession({
  tokens,
  isActive = false,
  idleTokens = AGENT_PHONE_COMPACTION.IDLE_TOKENS,
  hardTokens = AGENT_PHONE_COMPACTION.HARD_TOKENS,
} = {}) {
  if (typeof tokens !== "number") return null;
  if (tokens >= hardTokens) return "hard";
  if (!isActive && tokens >= idleTokens) return "idle";
  return null;
}

export function filterAgentPhoneTools({ tools = [], customTools = [] } = {}, { toolMode = AGENT_PHONE_TOOL_MODES.READ_ONLY } = {}) {
  if (normalizeAgentPhoneToolMode(toolMode) === AGENT_PHONE_TOOL_MODES.WRITE) {
    return {
      tools: tools.filter((tool) => !PHONE_EXCLUDED_TOOL_NAMES.has(tool.name)),
      customTools: customTools.filter((tool) => !PHONE_EXCLUDED_TOOL_NAMES.has(tool.name)),
    };
  }

  return {
    tools: tools.filter((tool) => READ_ONLY_BUILTIN_TOOLS.includes(tool.name)),
    customTools: customTools.filter((tool) => READ_ONLY_CUSTOM_TOOLS.has(tool.name)),
  };
}
