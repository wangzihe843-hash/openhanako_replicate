export interface SidebarUiProjectViewPrefs {
  collapsedProjectIds: string[];
  collapsedFolderIds: string[];
  showAllProjectIds: string[];
}

export interface SidebarUiPrefs {
  projectView: SidebarUiProjectViewPrefs;
}

export function normalizeSidebarUiPrefs(raw?: unknown): SidebarUiPrefs;
export function mergeSidebarUiPrefs(current?: unknown, partial?: unknown): SidebarUiPrefs;
