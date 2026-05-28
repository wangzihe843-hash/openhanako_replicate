import { normalizeWorkspacePath, workspaceDisplayName } from "./workspace-history.js";

export const SESSION_PROJECTS_VERSION = 1;
export const SESSION_PROJECTS_FILENAME = "session-projects.json";
export const UNCATEGORIZED_PROJECT_ID = "cwd:";

const MAX_NAME_LENGTH = 80;
const MAX_ID_LENGTH = 240;

export function normalizeProjectName(value, fallback = "") {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (!trimmed) return fallback;
  return [...trimmed].slice(0, MAX_NAME_LENGTH).join("");
}

export function normalizeSessionProjectId(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_ID_LENGTH) return null;
  return trimmed;
}

export function autoProjectIdForCwd(cwd) {
  const normalized = normalizeWorkspacePath(cwd);
  if (!normalized) return UNCATEGORIZED_PROJECT_ID;
  return `cwd:${encodeURIComponent(normalized)}`;
}

export function isAutoProjectId(projectId) {
  return typeof projectId === "string" && projectId.startsWith("cwd:");
}

export function cwdFromAutoProjectId(projectId) {
  if (!isAutoProjectId(projectId)) return null;
  const encoded = projectId.slice(4);
  if (!encoded) return null;
  try {
    return normalizeWorkspacePath(decodeURIComponent(encoded));
  } catch {
    return null;
  }
}

export function autoProjectNameForCwd(cwd, fallback = "未指定项目") {
  return workspaceDisplayName(cwd, fallback) || fallback;
}

export function normalizeSessionProjectCatalog(input = {}) {
  const rawFolders = Array.isArray(input?.folders) ? input.folders : [];
  const folders = [];
  const folderIds = new Set();
  for (const [index, raw] of rawFolders.entries()) {
    if (!raw || typeof raw !== "object") continue;
    const id = normalizeSessionProjectId(raw.id);
    const name = normalizeProjectName(raw.name);
    if (!id || !name || folderIds.has(id)) continue;
    folderIds.add(id);
    folders.push({
      id,
      name,
      order: finiteOrder(raw.order, index),
    });
  }

  const rawProjects = Array.isArray(input?.projects) ? input.projects : [];
  const projects = [];
  const projectIds = new Set();
  for (const [index, raw] of rawProjects.entries()) {
    if (!raw || typeof raw !== "object") continue;
    const id = normalizeSessionProjectId(raw.id);
    const name = normalizeProjectName(raw.name);
    if (!id || !name || projectIds.has(id)) continue;
    const folderId = normalizeSessionProjectId(raw.folderId);
    projectIds.add(id);
    projects.push({
      id,
      name,
      folderId: folderId && folderIds.has(folderId) ? folderId : null,
      order: finiteOrder(raw.order, index),
    });
  }

  folders.sort(compareOrderedByName);
  projects.sort(compareOrderedByName);
  return { folders, projects };
}

export function serializeSessionProjectCatalog(catalog) {
  const normalized = normalizeSessionProjectCatalog(catalog);
  return {
    version: SESSION_PROJECTS_VERSION,
    folders: normalized.folders,
    projects: normalized.projects,
  };
}

function finiteOrder(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function compareOrderedByName(a, b) {
  return (a.order ?? 0) - (b.order ?? 0)
    || String(a.name || "").localeCompare(String(b.name || ""))
    || String(a.id || "").localeCompare(String(b.id || ""));
}
