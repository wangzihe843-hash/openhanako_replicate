/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformApi, PreviewItem } from '../../types';

const mockState: { previewItems: PreviewItem[] } = { previewItems: [] };
const mockUpsertPreviewItem = vi.fn();

vi.mock('../../stores', () => ({
  useStore: {
    getState: () => mockState,
  },
}));

vi.mock('../../stores/preview-actions', () => ({
  upsertPreviewItem: mockUpsertPreviewItem,
}));

describe('refreshPreviewItemsFromFile', () => {
  beforeEach(() => {
    mockState.previewItems = [];
    mockUpsertPreviewItem.mockReset();
    window.platform = {
      readFileSnapshot: vi.fn(async (filePath: string) => ({
        content: `text:${filePath}`,
        version: { mtimeMs: 10, size: 20, sha256: 'text-hash' },
      })),
      readFile: vi.fn(async (filePath: string) => `legacy:${filePath}`),
      readDocxHtml: vi.fn(async (filePath: string) => `<p>docx:${filePath}</p>`),
      readXlsxHtml: vi.fn(async (filePath: string) => `<table><tr><td>${filePath}</td></tr></table>`),
      readFileBase64: vi.fn(async (filePath: string) => `pdf:${filePath}`),
    } as unknown as PlatformApi;
  });

  it('reloads matching preview items through their own preview type reader', async () => {
    mockState.previewItems = [
      {
        id: 'doc',
        type: 'docx',
        title: 'report.docx',
        content: '<p>old</p>',
        filePath: '/tmp/report.docx',
        ext: 'docx',
      },
      {
        id: 'other',
        type: 'markdown',
        title: 'other.md',
        content: '# Old',
        filePath: '/tmp/other.md',
        ext: 'md',
      },
    ];

    const { refreshPreviewItemsFromFile } = await import('../../utils/preview-file-refresh');
    await refreshPreviewItemsFromFile('/tmp/report.docx');

    expect(window.platform?.readDocxHtml).toHaveBeenCalledWith('/tmp/report.docx');
    expect(window.platform?.readFileSnapshot).not.toHaveBeenCalled();
    expect(mockUpsertPreviewItem).toHaveBeenCalledTimes(1);
    expect(mockUpsertPreviewItem).toHaveBeenCalledWith({
      ...mockState.previewItems[0],
      content: '<p>docx:/tmp/report.docx</p>',
      fileVersion: undefined,
    });
  });
});
