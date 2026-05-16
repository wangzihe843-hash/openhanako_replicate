import { useEffect } from 'react';
import { useStore } from '../../stores';
import { subscribeWorkspaceChanges } from '../../services/workspace-change-events';
import type { WorkspaceChangePayload } from '../../types';

function normalizeDirectoryPath(value: string): string {
  const slashed = value.replace(/\\/g, '/');
  if (/^[A-Za-z]:\/?$/.test(slashed)) return slashed.endsWith('/') ? slashed : `${slashed}/`;
  return slashed.length > 1 ? slashed.replace(/\/+$/, '') : slashed;
}

function workspaceSubdirForAffectedDirectory(basePath: string, payload: WorkspaceChangePayload): string | null {
  if (!basePath) return null;
  const base = normalizeDirectoryPath(basePath);
  const root = normalizeDirectoryPath(payload.rootPath);
  const affected = normalizeDirectoryPath(payload.affectedDir);
  if (root !== base) return null;
  if (affected === base) return '';
  const prefix = base.endsWith('/') ? base : `${base}/`;
  if (!affected.startsWith(prefix)) return null;
  return affected.slice(prefix.length).replace(/^\/+|\/+$/g, '');
}

export function WorkspaceFileWatchBridge() {
  const deskBasePath = useStore(s => s.deskBasePath);

  useEffect(() => {
    const platform = window.platform;
    if (!deskBasePath || !platform?.watchWorkspace || !platform?.unwatchWorkspace) return undefined;
    let closed = false;
    void platform.watchWorkspace(deskBasePath)
      .then((ok) => {
        if (!ok) console.warn('[workspace-watch] watch failed:', deskBasePath);
        if (closed && ok) void platform.unwatchWorkspace?.(deskBasePath);
      })
      .catch((err) => {
        console.warn('[workspace-watch] watch failed:', err);
      });
    return () => {
      closed = true;
      void platform.unwatchWorkspace?.(deskBasePath);
    };
  }, [deskBasePath]);

  useEffect(() => subscribeWorkspaceChanges((payload) => {
    const state = useStore.getState();
    const subdir = workspaceSubdirForAffectedDirectory(state.deskBasePath, payload);
    if (subdir == null) return;
    state.markDeskTreeDirty(subdir);
  }), []);

  return null;
}
