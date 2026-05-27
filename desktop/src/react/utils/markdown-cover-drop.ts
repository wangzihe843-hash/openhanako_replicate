import {
  clearAppFileDragPayload,
  readAppFileDragPayload,
  type AppDraggedFile,
} from './app-file-drag';
import { extOfName, isImageOrSvgExt } from './file-kind';
import { applyMarkdownCoverImage, dispatchCoverNotice } from './markdown-cover-generation';

function draggedFileIsImage(file: AppDraggedFile): boolean {
  if (file.isDirectory || !file.path) return false;
  const mime = file.mimeType?.toLowerCase() || '';
  if (mime.startsWith('image/')) return true;
  return isImageOrSvgExt(extOfName(file.name) || extOfName(file.path));
}

export function getMarkdownCoverDropImagePath(dataTransfer?: DataTransfer | null): string | null {
  const payload = readAppFileDragPayload(dataTransfer);
  const file = payload?.files.find(draggedFileIsImage);
  return file?.path || null;
}

export function hasMarkdownCoverDropImage(dataTransfer?: DataTransfer | null): boolean {
  return Boolean(getMarkdownCoverDropImagePath(dataTransfer));
}

export async function applyMarkdownCoverImageDrop({
  filePath,
  dataTransfer,
}: {
  filePath: string | null | undefined;
  dataTransfer?: DataTransfer | null;
}): Promise<boolean> {
  if (!filePath) return false;
  const payload = readAppFileDragPayload(dataTransfer);
  const imageFilePath = getMarkdownCoverDropImagePath(dataTransfer);
  if (!imageFilePath) return false;

  try {
    const result = await applyMarkdownCoverImage({ filePath, imageFilePath });
    dispatchCoverNotice(
      result.ok ? 'Cover 已更新。' : `Cover 更新失败：${result.error}`,
      result.ok ? 'success' : 'error',
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    dispatchCoverNotice(`Cover 更新失败：${message}`, 'error');
  } finally {
    if (payload) clearAppFileDragPayload(payload.dragId);
  }

  return true;
}
