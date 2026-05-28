const MAX_IDS = 256;
const MAX_ID_LENGTH = 240;

function cleanId(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_ID_LENGTH) return "";
  return trimmed;
}

function uniqueIds(values) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const id = cleanId(value);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= MAX_IDS) break;
  }
  return out;
}

export function normalizeSidebarUiPrefs(raw = {}) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const projectView = source.projectView && typeof source.projectView === "object" && !Array.isArray(source.projectView)
    ? source.projectView
    : {};
  return {
    projectView: {
      collapsedProjectIds: uniqueIds(projectView.collapsedProjectIds),
      collapsedFolderIds: uniqueIds(projectView.collapsedFolderIds),
      showAllProjectIds: uniqueIds(projectView.showAllProjectIds),
    },
  };
}

export function mergeSidebarUiPrefs(current = {}, partial = {}) {
  const base = normalizeSidebarUiPrefs(current);
  const patch = partial && typeof partial === "object" && !Array.isArray(partial) ? partial : {};
  const patchProjectView = patch.projectView && typeof patch.projectView === "object" && !Array.isArray(patch.projectView)
    ? patch.projectView
    : {};
  const nextProjectView = { ...base.projectView };
  for (const key of ["collapsedProjectIds", "collapsedFolderIds", "showAllProjectIds"]) {
    if (Object.prototype.hasOwnProperty.call(patchProjectView, key)) {
      nextProjectView[key] = uniqueIds(patchProjectView[key]);
    }
  }
  return normalizeSidebarUiPrefs({ projectView: nextProjectView });
}
