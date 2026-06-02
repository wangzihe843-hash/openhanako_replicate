import { useStore } from '../stores';
import { upsertPreviewItem } from '../stores/preview-actions';
import { readFileForPreviewType } from './preview-file-content';

export async function refreshPreviewItemsFromFile(filePath: string): Promise<void> {
  const state = useStore.getState();
  for (const item of state.previewItems || []) {
    if (item.filePath !== filePath) continue;
    const read = await readFileForPreviewType(filePath, item.type);
    if (!read) continue;
    upsertPreviewItem({
      ...item,
      content: read.content,
      fileVersion: read.fileVersion ?? item.fileVersion,
    });
  }
}
