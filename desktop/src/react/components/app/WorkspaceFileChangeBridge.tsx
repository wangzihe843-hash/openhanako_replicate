import { useEffect, useMemo, useRef } from 'react';
import { useStore } from '../../stores';
import { retainLocalFileResourceWatch } from '../../services/resource-events';

function normalizeSubdir(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

function joinWorkspaceRoot(basePath: string, subdir: string): string {
  const normalizedSubdir = normalizeSubdir(subdir);
  if (!normalizedSubdir) return basePath;
  const separator = /^[A-Za-z]:\\/.test(basePath) || (basePath.includes('\\') && !basePath.includes('/')) ? '\\' : '/';
  return `${basePath.replace(/[\\/]+$/, '')}${separator}${normalizedSubdir.replace(/\//g, separator)}`;
}

function workspaceWatchRoots(basePath: string, expandedPaths: string[]): string[] {
  if (!basePath) return [];
  const roots = new Set<string>([basePath]);
  for (const subdir of expandedPaths) {
    const normalized = normalizeSubdir(subdir);
    if (normalized) roots.add(joinWorkspaceRoot(basePath, normalized));
  }
  return [...roots];
}

export function WorkspaceFileChangeBridge() {
  const deskBasePath = useStore(s => s.deskBasePath);
  const deskWorkspaceMountId = useStore(s => s.deskWorkspaceMountId);
  const deskExpandedPaths = useStore(s => s.deskExpandedPaths);
  const subscriptionsRef = useRef<Map<string, () => void>>(new Map());
  const watchedRoots = useMemo(
    () => (deskWorkspaceMountId ? [] : workspaceWatchRoots(deskBasePath, deskExpandedPaths)),
    [deskBasePath, deskExpandedPaths, deskWorkspaceMountId],
  );
  const watchedRootsKey = watchedRoots.join('\n');

  useEffect(() => {
    const nextRoots = new Set(watchedRoots);
    for (const [root, unsubscribe] of subscriptionsRef.current) {
      if (nextRoots.has(root)) continue;
      unsubscribe();
      subscriptionsRef.current.delete(root);
    }
    for (const root of watchedRoots) {
      if (subscriptionsRef.current.has(root)) continue;
      subscriptionsRef.current.set(root, retainLocalFileResourceWatch(root));
    }
  }, [watchedRootsKey]); // eslint-disable-line react-hooks/exhaustive-deps -- watchedRootsKey is the reconciled subscription identity.

  useEffect(() => () => {
    for (const unsubscribe of subscriptionsRef.current.values()) unsubscribe();
    subscriptionsRef.current.clear();
  }, []);

  return null;
}

export const WorkspaceFileWatchBridge = WorkspaceFileChangeBridge;
