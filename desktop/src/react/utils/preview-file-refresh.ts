import { useStore } from '../stores';
import { upsertPreviewItem } from '../stores/preview-actions';

export async function refreshPreviewItemsFromFile(filePath: string): Promise<void> {
  const snapshot = await window.platform?.readFileSnapshot?.(filePath);
  const content = snapshot?.content ?? await window.platform?.readFile?.(filePath);
  if (content == null) return;

  const state = useStore.getState();
  for (const item of state.previewItems || []) {
    if (item.filePath !== filePath) continue;
    upsertPreviewItem({
      ...item,
      content,
      fileVersion: snapshot?.version ?? item.fileVersion,
    });
  }
}
