import { useEffect, useMemo, useRef } from 'react';
import { useStore } from '../../stores';
import { retainLocalFileResourceWatch } from '../../services/resource-events';
import {
  PREVIEW_DOCUMENT_CATCH_UP_REFRESH_OPTIONS,
  openPreviewDocumentWatchFilePaths,
  refreshOpenPreviewDocumentsForFilePath,
} from '../../utils/preview-document-refresh';

export function OpenPreviewDocumentWatchBridge() {
  const previewItems = useStore(s => s.previewItems);
  const openTabs = useStore(s => s.openTabs);
  const deskBasePath = useStore(s => s.deskBasePath);
  const deskWorkspaceMountId = useStore(s => s.deskWorkspaceMountId);
  const deskWorkspaceNativeRoot = useStore(s => s.deskWorkspaceNativeRoot);
  const studioWorkspaces = useStore(s => s.studioWorkspaces);
  const subscriptionsRef = useRef<Map<string, () => void>>(new Map());
  const watchPaths = useMemo(
    () => openPreviewDocumentWatchFilePaths(),
    [previewItems, openTabs, deskBasePath, deskWorkspaceMountId, deskWorkspaceNativeRoot, studioWorkspaces],
  );
  const watchPathsKey = watchPaths.join('\n');

  useEffect(() => {
    const nextPaths = new Set(watchPaths);
    for (const [filePath, unsubscribe] of subscriptionsRef.current) {
      if (nextPaths.has(filePath)) continue;
      unsubscribe();
      subscriptionsRef.current.delete(filePath);
    }

    for (const filePath of watchPaths) {
      if (!subscriptionsRef.current.has(filePath)) {
        subscriptionsRef.current.set(filePath, retainLocalFileResourceWatch(filePath));
      }
      void refreshOpenPreviewDocumentsForFilePath(
        filePath,
        PREVIEW_DOCUMENT_CATCH_UP_REFRESH_OPTIONS,
      ).catch((err) => {
        console.warn('[preview-resource] catch-up refresh failed:', filePath, err);
      });
    }
  }, [watchPathsKey]); // eslint-disable-line react-hooks/exhaustive-deps -- watchPathsKey is the reconciled subscription identity.

  useEffect(() => () => {
    for (const unsubscribe of subscriptionsRef.current.values()) unsubscribe();
    subscriptionsRef.current.clear();
  }, []);

  return null;
}
