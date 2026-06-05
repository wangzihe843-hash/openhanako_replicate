import {
  classifySessionPermission,
  normalizeSessionPermissionMode,
  SESSION_PERMISSION_MODES,
} from "../../core/session-permission-mode.js";
import { getToolSessionPath } from "./tool-session.js";
import { toolError, toolOk } from "./tool-result.js";
import { t } from "../i18n.js";

function findRuntimeCtx(args) {
  for (let i = args.length - 1; i >= 2; i--) {
    const value = args[i];
    if (value && typeof value === "object" && (value.sessionManager || value.sessionPath || value.agentId || value.model)) {
      return value;
    }
  }
  return null;
}

function buildToolApprovalRequest(confirmId, toolName, params) {
  return {
    type: "session_confirmation",
    confirmId,
    kind: "tool_action_approval",
    surface: "input",
    status: "pending",
    title: t("approval.toolAction.title"),
    body: t("approval.toolAction.body"),
    subject: {
      label: toolName,
      detail: summarizeParams(params),
    },
    severity: "elevated",
    actions: {
      confirmLabel: t("approval.confirm"),
      rejectLabel: t("approval.reject"),
    },
    payload: { toolName, params },
  };
}

function buildToolApprovalGatewayRequest(toolName, params, sessionPath) {
  const target = approvalTargetForTool(toolName, params);
  return {
    id: `${sessionPath || "session"}:${toolName}:${Date.now()}`,
    kind: "tool_action",
    sessionPath,
    agentId: null,
    toolName,
    actionName: typeof params?.action === "string" ? params.action : "execute",
    params: params && typeof params === "object" ? params : {},
    target,
    blastRadius: target.type === "url" || target.type === "domain" ? "external" : "workspace",
    reversibility: toolName === "bash" || toolName === "terminal" ? "unknown" : "moderate",
  };
}

function approvalTargetForTool(toolName, params = {}) {
  const command = typeof params.command === "string" ? params.command : "";
  if (command) return { type: "command", label: command };
  const path = typeof params.path === "string" ? params.path : typeof params.file_path === "string" ? params.file_path : "";
  if (path) return { type: "file", label: path, path };
  const url = typeof params.url === "string" ? params.url : "";
  if (url) return { type: "url", label: url, url };
  const label = typeof params.label === "string" && params.label.trim()
    ? params.label.trim()
    : toolName;
  return { type: "tool", label };
}

function summarizeParams(params) {
  if (!params || typeof params !== "object") return "";
  const keys = ["action", "path", "file_path", "command", "url", "key", "label"];
  for (const key of keys) {
    const value = params[key];
    if (typeof value === "string" && value.trim()) return `${key}: ${value.trim().slice(0, 160)}`;
  }
  return "";
}

function toStatus(action) {
  if (action === "confirmed") return "confirmed";
  if (action === "timeout") return "timeout";
  if (action === "aborted") return "aborted";
  return "rejected";
}

async function askForToolApproval(toolName, params, sessionPath, deps) {
  const confirmStore = deps.getConfirmStore?.() || deps.confirmStore || null;
  if (!confirmStore || !sessionPath) {
    return { allowed: false, status: "rejected", confirmId: "", reason: "confirmation-unavailable" };
  }
  const { confirmId, promise } = confirmStore.create(
    "tool_action_approval",
    { toolName, params },
    sessionPath,
  );
  deps.emitEvent?.({
    type: "session_confirmation",
    request: buildToolApprovalRequest(confirmId, toolName, params),
  }, sessionPath);
  const decision = await promise;
  const status = toStatus(decision?.action);
  return {
    allowed: status === "confirmed",
    status,
    confirmId,
  };
}

async function reviewToolApproval(toolName, params, sessionPath, deps) {
  const gateway = deps.getApprovalGateway?.() || deps.approvalGateway || null;
  if (!gateway || typeof gateway.review !== "function") {
    return {
      allowed: false,
      status: "ask_user",
      reason: "approval-gateway-unavailable",
    };
  }
  const request = buildToolApprovalGatewayRequest(toolName, params, sessionPath);
  const decision = await gateway.review(request, {
    sessionPath,
    permissionContext: deps.permissionContext || null,
  });
  if (decision?.action === "allow") {
    return { allowed: true, status: "approved", decision };
  }
  if (decision?.action === "ask_user") {
    return { allowed: false, status: "ask_user", decision, reason: decision.reason };
  }
  return {
    allowed: false,
    status: decision?.action === "hard_deny" ? "blocked" : "denied",
    decision,
    reason: decision?.reason || "auto approval denied this action",
  };
}

function resolveToolPermissionMode(deps, sessionPath) {
  if (typeof deps.getPermissionMode !== "function") return SESSION_PERMISSION_MODES.AUTO;
  const scoped = deps.getPermissionMode(sessionPath);
  const raw = scoped ?? deps.getPermissionMode();
  if (raw == null) return SESSION_PERMISSION_MODES.AUTO;
  return normalizeSessionPermissionMode(raw);
}

export function wrapWithSessionPermission(tools = [], deps = {}) {
  return tools.map((tool) => {
    if (!tool?.execute || tool._sessionPermissionWrapped) return tool;
    return {
      ...tool,
      _sessionPermissionWrapped: true,
      execute: async (...args) => {
        const params = args[1] || {};
        const ctx = findRuntimeCtx(args);
        const sessionPath = getToolSessionPath(ctx) || ctx?.sessionPath || deps.getSessionPath?.() || null;
        const mode = resolveToolPermissionMode(deps, sessionPath);
        const decision = classifySessionPermission({ mode, toolName: tool.name, params, context: deps.permissionContext });
        if (decision.action === "allow") {
          return tool.execute(...args);
        }
        if (decision.action === "deny") {
          return toolError(decision.message, {
            errorCode: decision.code,
            permissionMode: mode,
            toolName: tool.name,
            ...(decision.details || {}),
          });
        }
        if (decision.action === "review") {
          const review = await reviewToolApproval(tool.name, params, sessionPath, deps);
          if (review.allowed) {
            return tool.execute(...args);
          }
          if (review.status !== "ask_user") {
            return toolOk("Tool action was not approved.", {
              action: tool.name,
              confirmed: false,
              confirmation: {
                kind: "tool_action_approval",
                status: review.status,
                toolName: tool.name,
                reason: review.reason,
                reviewer: review.decision?.reviewer,
                risk: review.decision?.risk,
              },
            });
          }
        }

        const approval = await askForToolApproval(tool.name, params, sessionPath, deps);
        if (!approval.allowed) {
          return toolOk("Tool action was not approved.", {
            action: tool.name,
            confirmed: false,
            confirmation: {
              kind: "tool_action_approval",
              status: approval.status,
              confirmId: approval.confirmId,
              toolName: tool.name,
              reason: approval.reason,
            },
          });
        }
        return tool.execute(...args);
      },
    };
  });
}
