import { useStore } from '../stores';
import type { PreviewItem, RemoteWorkbenchContentRef } from '../types';
import {
  PREVIEW_FILE_CATCH_UP_REFRESH_OPTIONS,
  PREVIEW_FILE_CHANGE_REFRESH_OPTIONS,
  refreshPreviewItemsFromFile,
  type PreviewFileRefreshOptions,
} from './preview-file-refresh';
import {
  isRemoteWorkbenchContentRef,
  normalizeWorkbenchContentRef,
  refreshPreviewItemsFromRemoteWorkbenchTarget,
} from './remote-file-preview';

export type PreviewDocumentTarget =
  | { kind: 'local-file'; filePath: string }
  | { kind: 'workbench-file'; target: RemoteWorkbenchContentRef };

export type PreviewDocumentRefreshOptions = PreviewFileRefreshOptions;

export const PREVIEW_DOCUMENT_CHANGE_REFRESH_OPTIONS: PreviewDocumentRefreshOptions = PREVIEW_FILE_CHANGE_REFRESH_OPTIONS;
export const PREVIEW_DOCUMENT_CATCH_UP_REFRESH_OPTIONS: PreviewDocumentRefreshOptions = PREVIEW_FILE_CATCH_UP_REFRESH_OPTIONS;

function previewDocumentTargetKey(target: PreviewDocumentTarget): string {
  if (target.kind === 'local-file') return `local:${target.filePath}`;
  const normalized = normalizeWorkbenchContentRef(target.target);
  return [
    'workbench',
    normalized.mountId || normalized.rootId || 'default',
    normalized.subdir || '',
    normalized.name,
  ].join(':');
}

function previewDocumentTargetFromItem(item: PreviewItem | undefined | null): PreviewDocumentTarget | null {
  if (!item) return null;
  if (isRemoteWorkbenchContentRef(item.remoteContentRef)) {
    return { kind: 'workbench-file', target: item.remoteContentRef };
  }
  if (item.filePath && item.storageKind !== 'remote-content') {
    return { kind: 'local-file', filePath: item.filePath };
  }
  return null;
}

function openPreviewDocumentTargets(): PreviewDocumentTarget[] {
  const state = useStore.getState();
  const itemsById = new Map((state.previewItems || []).map(item => [item.id, item]));
  const targets: PreviewDocumentTarget[] = [];
  const seen = new Set<string>();

  for (const id of state.openTabs || []) {
    const target = previewDocumentTargetFromItem(itemsById.get(id));
    if (!target) continue;
    const key = previewDocumentTargetKey(target);
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push(target);
  }

  return targets;
}

export async function refreshPreviewDocumentTarget(
  target: PreviewDocumentTarget,
  options: PreviewDocumentRefreshOptions = PREVIEW_DOCUMENT_CHANGE_REFRESH_OPTIONS,
): Promise<void> {
  if (target.kind === 'local-file') {
    await refreshPreviewItemsFromFile(target.filePath, options);
    return;
  }
  await refreshPreviewItemsFromRemoteWorkbenchTarget(target.target, options);
}

export async function refreshOpenPreviewDocuments(
  options: PreviewDocumentRefreshOptions = PREVIEW_DOCUMENT_CATCH_UP_REFRESH_OPTIONS,
): Promise<void> {
  const targets = openPreviewDocumentTargets();
  if (targets.length === 0) return;
  await Promise.all(targets.map(target => refreshPreviewDocumentTarget(target, options)));
}
