
import fs from "fs";
import path from "path";
import { mergeWorkspaceHistory, normalizeWorkspacePath } from "./workspace-history.ts";
import { normalizeWorkspaceUiState } from "./workspace-ui-state.ts";

const MISSING_PATH_CODES = new Set(["ENOENT", "ENOTDIR"]);

export function classifyWorkspacePathForGc(value, { statSync = fs.statSync } = {}) {
  const workspace = normalizeWorkspacePath(value);
  if (!workspace) return { path: null, status: "invalid", errorCode: null };
  try {
    statSync(workspace);
    return { path: workspace, status: "present", errorCode: null };
  } catch (err) {
    const errorCode = typeof err?.code === "string" ? err.code : null;
    if (!MISSING_PATH_CODES.has(errorCode)) {
      // EACCES/EBUSY/EPERM 等：无法判定是否真被删，保守保留（不剪）。
      return { path: workspace, status: "unknown", errorCode };
    }
    // ENOENT/ENOTDIR：只有当父目录仍存在时才算「确实被删」。若父目录也取不到——典型是
    // Windows 断开的网络盘/可移动盘整盘 ENOENT——多半是临时卸载而非删除，判为 unknown 予以保留；
    // 否则仅一次读取（getWorkspaceUiState 每次读都跑 GC）就会把该工作区保存的 UI 状态永久抹掉，
    // 重新挂盘也回不来。
    const parent = path.dirname(workspace);
    if (!parent || parent === workspace) {
      return { path: workspace, status: "unknown", errorCode };
    }
    try {
      statSync(parent);
      return { path: workspace, status: "missing", errorCode };
    } catch {
      return { path: workspace, status: "unknown", errorCode };
    }
  }
}

export function pruneMissingWorkspaceConfig(config: Record<string, any> = {}, options: Record<string, any> = {}) {
  const patch: Record<string, any> = {};

  if (Array.isArray(config.cwd_history)) {
    const current = mergeWorkspaceHistory(config.cwd_history, []);
    const cwdHistory = current.filter((item) => classifyWorkspacePathForGc(item, options).status !== "missing");
    if (!sameArray(current, cwdHistory)) {
      patch.cwd_history = cwdHistory;
    }
  }

  const lastCwd = normalizeWorkspacePath(config.last_cwd);
  if (lastCwd && classifyWorkspacePathForGc(lastCwd, options).status === "missing") {
    patch.last_cwd = null;
  }

  const homeFolder = normalizeWorkspacePath(config.desk?.home_folder);
  if (homeFolder && classifyWorkspacePathForGc(homeFolder, options).status === "missing") {
    patch.desk = { ...(patch.desk || {}), home_folder: null };
  }

  return {
    changed: Object.keys(patch).length > 0,
    patch,
  };
}

export function pruneMissingWorkspaceUiState(raw = {}, options = {}) {
  const state = normalizeWorkspaceUiState(raw, options);
  const workspaces = {};
  for (const [workspace, record] of Object.entries(state.workspaces || {})) {
    if (classifyWorkspacePathForGc(workspace, options).status === "missing") continue;
    workspaces[workspace] = record;
  }
  const next = normalizeWorkspaceUiState({ ...state, workspaces }, options);
  return {
    changed: JSON.stringify(next) !== JSON.stringify(state),
    state: next,
  };
}

function sameArray(a, b) {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}
