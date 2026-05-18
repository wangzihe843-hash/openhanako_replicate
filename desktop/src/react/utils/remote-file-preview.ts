import type { PreviewItem } from '../types';
import type { DeskFile } from '../types';
import type { FileRef } from '../types/file-ref';
import { hanaFetch } from '../hooks/use-hana-fetch';
import { openPreview } from '../stores/preview-actions';
import { useStore } from '../stores';
import { resolveServerConnection } from '../services/server-connection';
import { resolveFileRefUrl } from '../services/resource-url';
import { BINARY_PREVIEW_TYPES, PREVIEWABLE_EXTS, openFilePreview } from './file-preview';
import { extOfName, inferKindByExt, isMediaKind } from './file-kind';
import { openMediaViewerForRef } from './open-media-viewer';
import { showError } from './ui-helpers';

export interface WorkbenchPreviewInput {
  file: DeskFile;
  rootId?: string;
  subdir: string;
}

export interface FileRefPreviewContext {
  origin: 'desk' | 'session';
  sessionPath?: string;
  messageId?: string;
  blockIdx?: number;
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function isWebRuntime(): boolean {
  return typeof document !== 'undefined'
    && document.documentElement.getAttribute('data-platform') === 'web';
}

function encodeWorkbenchContentPath({
  rootId = 'default',
  subdir,
  name,
}: {
  rootId?: string;
  subdir: string;
  name: string;
}): string {
  const params = new URLSearchParams();
  params.set('rootId', rootId || 'default');
  params.set('subdir', subdir || '');
  params.set('name', name);
  return `/api/mobile/workbench/content?${params.toString()}`;
}

function previewId(prefix: string, key: string): string {
  return `${prefix}-${encodeURIComponent(key)}`;
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

async function readContentForPreview(contentPath: string, previewType: string): Promise<string> {
  const res = await hanaFetch(contentPath);
  if (BINARY_PREVIEW_TYPES.has(previewType)) {
    return blobToBase64(await res.blob());
  }
  return res.text();
}

async function openRemoteContentPreview({
  contentPath,
  id,
  title,
  ext,
  mediaRef,
  mediaContext,
}: {
  contentPath: string;
  id: string;
  title: string;
  ext: string;
  mediaRef?: FileRef;
  mediaContext: { origin: 'desk' | 'session'; sessionPath?: string };
}): Promise<void> {
  const mediaKind = inferKindByExt(ext);
  if (isMediaKind(mediaKind) && mediaRef) {
    openMediaViewerForRef(mediaRef, mediaContext);
    return;
  }

  const previewType = PREVIEWABLE_EXTS[ext];
  if (previewType && previewType !== 'docx' && previewType !== 'xlsx') {
    const content = await readContentForPreview(contentPath, previewType);
    const previewItem: PreviewItem = {
      id,
      type: previewType,
      title,
      content,
      ext,
      language: previewType === 'code' ? ext : undefined,
      storageKind: 'remote-content',
    };
    openPreview(previewItem);
    return;
  }

  openPreview({
    id,
    type: 'file-info',
    title,
    content: '',
    ext,
    storageKind: 'remote-content',
  });
}

export async function openMobileWorkbenchPreview(input: WorkbenchPreviewInput): Promise<void> {
  if (input.file.isDir) return;
  const name = input.file.name;
  const ext = extOfName(name) || '';
  const rootId = input.rootId || 'default';
  const contentPath = encodeWorkbenchContentPath({ rootId, subdir: input.subdir, name });
  const connection = resolveServerConnection(useStore.getState());
  const studioId = connection?.studioId || 'default';
  const mediaKind = inferKindByExt(ext);
  const mediaRef: FileRef | undefined = isMediaKind(mediaKind)
    ? {
        id: `workbench:${rootId}:${input.subdir}:${name}`,
        kind: mediaKind,
        source: 'desk',
        name,
        path: '',
        ext,
        resource: {
          resourceId: `workbench:${rootId}:${input.subdir}:${name}`,
          studioId,
          links: { self: contentPath, content: contentPath },
        },
      }
    : undefined;

  try {
    await openRemoteContentPreview({
      contentPath,
      id: previewId('workbench', `${rootId}:${input.subdir}:${name}`),
      title: name,
      ext,
      mediaRef,
      mediaContext: { origin: 'desk' },
    });
  } catch (err) {
    console.error('[remote-preview] workbench preview failed:', err);
    showError(getErrorMessage(err));
  }
}

export async function openFileRefPreview(file: FileRef, context: FileRefPreviewContext): Promise<void> {
  if (file.status === 'expired') return;
  if (isMediaKind(file.kind)) {
    openMediaViewerForRef(file, {
      origin: context.origin,
      sessionPath: context.sessionPath,
    });
    return;
  }

  if (!isWebRuntime() && file.path) {
    await openFilePreview(file.path, file.name, file.ext || extOfName(file.name) || '', {
      origin: context.origin,
      sessionPath: context.sessionPath,
      messageId: context.messageId,
      fileId: file.fileId,
      blockIdx: context.blockIdx,
    });
    return;
  }

  const contentPath = file.resource?.links.content;
  if (!contentPath) return;

  try {
    await openRemoteContentPreview({
      contentPath,
      id: previewId('resource', file.resource?.resourceId || file.id),
      title: file.name,
      ext: file.ext || extOfName(file.name) || '',
      mediaContext: {
        origin: context.origin,
        sessionPath: context.sessionPath,
      },
    });
  } catch (err) {
    console.error('[remote-preview] session file preview failed:', err);
    showError(getErrorMessage(err));
  }
}

export function fileRefDownloadUrl(file: FileRef): string | null {
  if (file.status === 'expired') return null;
  try {
    const resolved = resolveFileRefUrl(file, {
      connection: resolveServerConnection(useStore.getState()),
      platform: typeof window !== 'undefined' ? window.platform : null,
      preferLocalFile: false,
    });
    return resolved.mode === 'local-file' ? null : resolved.url;
  } catch {
    return null;
  }
}
