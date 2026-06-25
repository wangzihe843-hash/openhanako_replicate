export const SESSION_PERMISSION_MODES = Object.freeze({
  AUTO: "auto",
  OPERATE: "operate",
  ASK: "ask",
  READ_ONLY: "read_only",
});

export const SESSION_APPROVAL_POLICIES = Object.freeze({
  INTERACTIVE: "interactive",
  DENY_ON_PROMPT: "deny_on_prompt",
  NEVER: "never",
});

export const DEFAULT_SESSION_PERMISSION_MODE = SESSION_PERMISSION_MODES.AUTO;
const BRIDGE_PERMISSION_MODE_VALUES = new Set([
  SESSION_PERMISSION_MODES.AUTO,
  SESSION_PERMISSION_MODES.OPERATE,
  SESSION_PERMISSION_MODES.READ_ONLY,
]);
const AUTOMATION_PERMISSION_MODE_VALUES = BRIDGE_PERMISSION_MODE_VALUES;

const INFORMATION_TOOLS = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "web_search",
  "web_fetch",
  "current_status",
  "search_memory",
  "recall_experience",
]);

const SIDE_EFFECT_TOOLS = new Set([
  "bash",
  "write",
  "edit",
  "computer",
  "automation",
  "cron",
  "dm",
  "channel",
  "install_skill",
  "update_settings",
  "todo_write",
  "stage_files",
  "present_files",
  "subagent",
  "workflow",
  "notify",
  "record_experience",
  "pin_memory",
  "unpin_memory",
]);

const AUTO_REVIEW_TOOLS = new Set([
  "automation",
  "browser",
  "channel",
  "dm",
  "install_skill",
  "notify",
  "pin_memory",
  "present_files",
  "record_experience",
  "stage_files",
  "terminal",
  "unpin_memory",
  "update_settings",
]);

// subagent 上下文固定边界（与 permission mode 无关）：哪怕 operate 也拦。收口在拦截层而非剥离——
// subagent 工具对模型仍可见，调用时被拦（Codex 式甲），保证缓存前缀统一。未来加禁用工具加到这里。
// 范畴：① 防自递归与间接扇出；② 长期记忆（subagent 不碰）；③ agent 一生/对外副作用。
// 不含 computer（有独立全局开关兜底）、search_memory/recall_experience（只读记忆，允许查）。
const SUBAGENT_BLOCKED_TOOLS = new Set([
  // ① 扇出
  "subagent",          // 防自递归
  "workflow",          // 间接扇出
  // ② 长期记忆（与「subagent 不带长期记忆」原则一致：可读不可写）
  "pin_memory",
  "unpin_memory",
  "record_experience",
  // ③ agent 生命周期 / 对外副作用
  "automation",
  "cron",
  "channel",
  "dm",
  "notify",
  "install_skill",
  "update_settings",
  "session_folders",
  // ④ 角色私有状态：subagent 不得替角色落草稿。否则一个后台任务能静默改写角色 draft 状态。
  //    与 strategy 无关地拦死：甲（intercept）这里硬拦；乙（strip）的白名单本就不含它。
  //    注意优先级——本拦截集先于下面 SILENT_DRAFT_TOOLS 的放行判定（见 classifySessionPermission），
  //    哪怕 subagent 的 ask 已坍缩成 operate、SILENT_DRAFT 本会放行，subagent 仍被这条拦死。
  "xingye_propose_draft",
]);

// 「静默草稿」工具：写的是非约束性草稿（落库后仍需用户在面板里「确认生成」才真正生效），
// 故没必要在 ASK 模式再弹一次工具确认——否则就是「批工具」+「面板确认」的冗余双重确认。
// 仅对【非 subagent】主 agent 生效：OPERATE/ASK 直接放行（不 prompt），READ_ONLY 仍按只读拦死。
// subagent 走不到这里——上面的 SUBAGENT_BLOCKED_TOOLS 已先把它拦死（优先级保证见 classify）。
const SILENT_DRAFT_TOOLS = new Set([
  "xingye_propose_draft",
]);

const BROWSER_READ_ACTIONS = new Set([
  "start",
  "navigate",
  "snapshot",
  "screenshot",
  "scroll",
  "wait",
  "show",
  "stop",
]);

const TERMINAL_READ_ACTIONS = new Set([
  "read",
  "list",
]);

const FILE_READ_ACTIONS = new Set([
  "stat",
]);

const DECLARED_READ_KINDS = new Set([
  "read",
  "readonly",
  "read_only",
]);

const DECLARED_AUTO_ALLOW_KINDS = new Set([
  "plugin_output",
  "session_file_output",
]);

export function normalizeSessionPermissionMode(raw) {
  if (typeof raw === "string") return normalizeSessionPermissionMode({ permissionMode: raw });
  if (raw?.permissionMode === SESSION_PERMISSION_MODES.AUTO) return SESSION_PERMISSION_MODES.AUTO;
  if (raw?.permissionMode === SESSION_PERMISSION_MODES.OPERATE) return SESSION_PERMISSION_MODES.OPERATE;
  if (raw?.permissionMode === SESSION_PERMISSION_MODES.ASK) return SESSION_PERMISSION_MODES.ASK;
  if (raw?.permissionMode === SESSION_PERMISSION_MODES.READ_ONLY) return SESSION_PERMISSION_MODES.READ_ONLY;
  if (raw?.accessMode === "operate") return SESSION_PERMISSION_MODES.OPERATE;
  if (raw?.accessMode === "read_only") return SESSION_PERMISSION_MODES.READ_ONLY;
  if (raw?.planMode === true) return SESSION_PERMISSION_MODES.READ_ONLY;
  return DEFAULT_SESSION_PERMISSION_MODE;
}

export function normalizeBridgePermissionMode(raw) {
  const source = typeof raw === "string" ? raw : raw?.permissionMode;
  if (BRIDGE_PERMISSION_MODE_VALUES.has(source)) return source;
  if (raw?.readOnly === true) return SESSION_PERMISSION_MODES.READ_ONLY;
  return SESSION_PERMISSION_MODES.AUTO;
}

export function normalizeAutomationPermissionMode(raw) {
  const source = typeof raw === "string" ? raw : raw?.permissionMode;
  if (AUTOMATION_PERMISSION_MODE_VALUES.has(source)) return source;
  return SESSION_PERMISSION_MODES.AUTO;
}

export function normalizeSessionApprovalPolicy(raw) {
  const source = typeof raw === "string" ? raw : raw?.approvalPolicy;
  if (source === SESSION_APPROVAL_POLICIES.INTERACTIVE) return SESSION_APPROVAL_POLICIES.INTERACTIVE;
  if (source === SESSION_APPROVAL_POLICIES.DENY_ON_PROMPT) return SESSION_APPROVAL_POLICIES.DENY_ON_PROMPT;
  if (source === SESSION_APPROVAL_POLICIES.NEVER) return SESSION_APPROVAL_POLICIES.NEVER;
  return SESSION_APPROVAL_POLICIES.INTERACTIVE;
}

export function resolveSessionApprovalPolicy({ mode, approvalPolicy, allowHumanApproval }: { mode?: any; approvalPolicy?: any; allowHumanApproval?: any } = {}) {
  const normalizedMode = normalizeSessionPermissionMode(mode);
  if (normalizedMode === SESSION_PERMISSION_MODES.OPERATE) return SESSION_APPROVAL_POLICIES.NEVER;
  if (normalizedMode === SESSION_PERMISSION_MODES.AUTO) return SESSION_APPROVAL_POLICIES.DENY_ON_PROMPT;
  if (approvalPolicy != null) return normalizeSessionApprovalPolicy(approvalPolicy);
  if (allowHumanApproval === false) return SESSION_APPROVAL_POLICIES.DENY_ON_PROMPT;
  return SESSION_APPROVAL_POLICIES.INTERACTIVE;
}

export function legacyAccessModeFromPermissionMode(mode) {
  return normalizeSessionPermissionMode(mode) === SESSION_PERMISSION_MODES.READ_ONLY ? "read_only" : "operate";
}

export function isReadOnlyPermissionMode(mode) {
  return normalizeSessionPermissionMode(mode) === SESSION_PERMISSION_MODES.READ_ONLY;
}

// 拦截分层（#1614）：deny 必须标明是哪一层拦的 + 怎么解锁，让模型/用户能自助走出去。
//   - subagent_blocklist：subagent 固定边界（任何档位都不可用）
//   - subagent_access：subagent 只读档（出路：access:"write" 重派 + 父会话可操作）
//   - conversation：conversation tool mode（出路：会话设置面板切到 write）
//   - session：普通会话只读档，如 plan 模式（出路：切换会话权限档）
function blocked(toolName, { code = "ACTION_BLOCKED_BY_READ_ONLY", message, layer = "session" }: { code?: string; message?: string; layer?: string } = {}) {
  return {
    action: "deny",
    code,
    message: message || `${toolName} is blocked in read-only mode.`,
    details: { toolName, layer },
  };
}

function blockedByReadOnly(toolName, context) {
  if (context?.isSubagent) {
    return blocked(toolName, {
      layer: "subagent_access",
      message: `${toolName} is blocked: this subagent runs in read-only mode. `
        + `For write access, re-dispatch the subagent with access:"write" — this requires the parent session to be in an operable (non read-only) mode; a subagent's permission can never exceed its parent session.`,
    });
  }
  if (context?.surface === "conversation") {
    return blocked(toolName, {
      layer: "conversation",
      message: `${toolName} is blocked: this conversation's tool permission is read-only. `
        + `The user can switch this conversation to write mode in its conversation settings panel.`,
    });
  }
  return blocked(toolName, {
    layer: "session",
    message: `${toolName} is blocked: this session is in read-only mode. `
      + `Switch the session permission mode out of read-only (e.g. leave plan mode) to use this tool.`,
  });
}

function prompt(toolName) {
  return {
    action: "prompt",
    kind: "tool_action_approval",
    details: { toolName },
  };
}

function review(toolName) {
  return {
    action: "review",
    kind: "tool_action_approval",
    details: { toolName },
  };
}

function declaredToolSessionPermission(context) {
  const value = context?.toolSessionPermission || context?.sessionPermission;
  return value && typeof value === "object" ? value : null;
}

function hasDeclaredPermissionBoundary(permission) {
  if (!permission) return false;
  return permission.readOnly === true
    || typeof permission.kind === "string"
    || permission.auto === "allow"
    || permission.auto === "review";
}

function isDeclaredReadOnly(permission) {
  if (!permission) return false;
  if (permission.readOnly === true) return true;
  return typeof permission.kind === "string" && DECLARED_READ_KINDS.has(permission.kind);
}

function isDeclaredAutoAllow(permission) {
  if (!permission) return false;
  if (permission.auto === "allow") return true;
  if (permission.auto === "review") return false;
  return typeof permission.kind === "string" && DECLARED_AUTO_ALLOW_KINDS.has(permission.kind);
}

function classifyDeclaredToolPermission(mode, toolName, context) {
  const permission = declaredToolSessionPermission(context);
  if (!hasDeclaredPermissionBoundary(permission)) return null;
  if (isDeclaredReadOnly(permission)) return { action: "allow" };
  if (mode === SESSION_PERMISSION_MODES.OPERATE) return { action: "allow" };
  if (mode === SESSION_PERMISSION_MODES.READ_ONLY) return blockedByReadOnly(toolName, context);
  if (mode === SESSION_PERMISSION_MODES.AUTO) {
    return isDeclaredAutoAllow(permission) ? { action: "allow" } : review(toolName);
  }
  return prompt(toolName);
}

function classifyBrowserAction(mode, action, context) {
  if (BROWSER_READ_ACTIONS.has(action)) return { action: "allow" };
  if (mode === SESSION_PERMISSION_MODES.READ_ONLY) return blockedByReadOnly("browser", context);
  if (mode === SESSION_PERMISSION_MODES.AUTO) return review("browser");
  if (mode === SESSION_PERMISSION_MODES.ASK) return prompt("browser");
  return { action: "allow" };
}

function classifyTerminalAction(mode, action, context) {
  if (TERMINAL_READ_ACTIONS.has(action)) return { action: "allow" };
  if (mode === SESSION_PERMISSION_MODES.READ_ONLY) return blockedByReadOnly("terminal", context);
  if (mode === SESSION_PERMISSION_MODES.AUTO) return review("terminal");
  if (mode === SESSION_PERMISSION_MODES.ASK) return prompt("terminal");
  return { action: "allow" };
}

function classifySessionFoldersAction(mode, action, context) {
  if (action === "list") return { action: "allow" };
  if (mode === SESSION_PERMISSION_MODES.READ_ONLY) return blockedByReadOnly("session_folders", context);
  return { action: "allow" };
}

function classifyFileAction(mode, action, context) {
  if (FILE_READ_ACTIONS.has(action)) return { action: "allow" };
  if (mode === SESSION_PERMISSION_MODES.READ_ONLY) return blockedByReadOnly("file", context);
  if (mode === SESSION_PERMISSION_MODES.ASK) return prompt("file");
  return { action: "allow" };
}

export function classifySessionPermission({ mode, toolName, params, context }: { mode?: any; toolName?: any; params?: any; context?: any } = {}) {
  let normalized = normalizeSessionPermissionMode(mode);
  const name = typeof toolName === "string" ? toolName : "";
  if (!name) return { action: "allow" };
  // subagent 上下文固定边界（与 mode 无关，优先于其它判定）：防自递归 + 禁越权工具。
  if (context?.isSubagent && SUBAGENT_BLOCKED_TOOLS.has(name)) {
    return blocked(name, {
      code: "ACTION_BLOCKED_IN_SUBAGENT",
      layer: "subagent_blocklist",
      message: `${name} is not available inside a subagent. `
        + `This tool is always blocked in subagent context regardless of access level; perform this action from the parent session instead.`,
    });
  }
  const declared = classifyDeclaredToolPermission(normalized, name, context);
  if (declared) return declared;
  if (INFORMATION_TOOLS.has(name)) return { action: "allow" };
  if (name === "browser") return classifyBrowserAction(normalized, params?.action, context);
  if (name === "terminal") return classifyTerminalAction(normalized, params?.action, context);
  // 静默草稿工具：在 ASK 提示兜底之前判定。OPERATE/ASK 一律放行（草稿非约束、面板还有「确认生成」，
  // 不该重复弹工具确认）；READ_ONLY 仍走下面的只读拦截。subagent 已在函数开头被 SUBAGENT_BLOCKED 拦死，
  // 走不到这里——故这里的放行只对主 agent 生效，二者组合时拦截优先。
  // 必须先于下面的 AUTO→review 兜底，否则 AUTO 模式会把草稿工具误送给异步审阅而非直接放行。
  if (SILENT_DRAFT_TOOLS.has(name) && normalized !== SESSION_PERMISSION_MODES.READ_ONLY) {
    return { action: "allow" };
  }
  if (name === "session_folders") return classifySessionFoldersAction(normalized, params?.action, context);
  if (name === "file") return classifyFileAction(normalized, params?.action, context);
  if (name === "computer") {
    if (normalized === SESSION_PERMISSION_MODES.READ_ONLY) return blockedByReadOnly(name, context);
    return { action: "allow" };
  }
  if (normalized === SESSION_PERMISSION_MODES.OPERATE) return { action: "allow" };
  if (normalized === SESSION_PERMISSION_MODES.READ_ONLY) return blockedByReadOnly(name, context);
  if (normalized === SESSION_PERMISSION_MODES.AUTO) {
    if (AUTO_REVIEW_TOOLS.has(name)) return review(name);
    if (SIDE_EFFECT_TOOLS.has(name)) return { action: "allow" };
    return review(name);
  }
  if (SIDE_EFFECT_TOOLS.has(name)) return prompt(name);
  return prompt(name);
}
