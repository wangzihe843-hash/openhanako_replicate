import type { FileRef } from '../types/file-ref';
import { buildConnectionUrl, type ServerConnection } from './server-connection';

export type FileRefUrlMode = 'local-file' | 'resource-content' | 'inline-data';

export interface FileRefUrlResult {
  mode: FileRefUrlMode;
  url: string;
}

export interface ResourceUrlPlatform {
  getFileUrl?: (path: string) => string;
}

export function resolveFileRefUrl(ref: FileRef, {
  connection,
  platform,
  preferLocalFile = true,
}: {
  connection?: ServerConnection | null;
  platform?: ResourceUrlPlatform | null;
  preferLocalFile?: boolean;
}): FileRefUrlResult {
  const isLocalTransport = !connection || connection.kind === 'local';
  const getFileUrl = platform?.getFileUrl;
  const canUseLocalFile = preferLocalFile
    && isLocalTransport
    && !!ref.path
    && typeof getFileUrl === 'function';

  if (canUseLocalFile) {
    return { mode: 'local-file', url: getFileUrl(ref.path) };
  }

  const resource = ref.resource;
  const contentLink = resource?.links.content;
  if (contentLink) {
    if (!connection) {
      throw new Error(`resource URL requires server connection: ${resource.resourceId}`);
    }
    return {
      mode: 'resource-content',
      url: buildConnectionUrl(connection, contentLink, { includeTokenQuery: true }),
    };
  }

  if (ref.inlineData) {
    return {
      mode: 'inline-data',
      url: `data:${ref.inlineData.mimeType};base64,${ref.inlineData.base64}`,
    };
  }

  if (ref.path && isLocalTransport) {
    if (typeof getFileUrl !== 'function') {
      throw new Error('platform.getFileUrl not available and resource content link missing');
    }
    return { mode: 'local-file', url: getFileUrl(ref.path) };
  }

  if (ref.path) {
    throw new Error(`remote file ref requires resource content link: ${ref.id}`);
  }

  throw new Error(`file ref lacks local path, resource content link, and inline data: ${ref.id}`);
}
