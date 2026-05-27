/**
 * @vitest-environment jsdom
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PreviewRenderer } from '../../components/preview/PreviewRenderer';
import { clearAppFileDragPayload, writeAppFileDragPayload } from '../../utils/app-file-drag';
import type { PreviewItem } from '../../types';

const mocks = vi.hoisted(() => ({
  hanaFetch: vi.fn(),
}));

vi.mock('../../hooks/use-hana-fetch', () => ({
  hanaFetch: mocks.hanaFetch,
}));

function dataTransferStub() {
  const data = new Map<string, string>();
  return {
    effectAllowed: '',
    dropEffect: '',
    setData: (type: string, value: string) => { data.set(type, value); },
    getData: (type: string) => data.get(type) || '',
  } as unknown as DataTransfer;
}

function putWorkspaceImageOnDrag(dataTransfer: DataTransfer) {
  writeAppFileDragPayload(dataTransfer, {
    source: 'workspace',
    files: [{
      id: 'cover-source',
      name: 'cover-source.png',
      path: '/tmp/workspace/cover-source.png',
      mimeType: 'image/png',
    }],
  });
}

describe('PreviewRenderer HTML isolation', () => {
  const htmlContent = '<script src="https://cdn.tailwindcss.com"></script><div class="text-red-500">Hello</div>';
  const previewItem: PreviewItem = {
    id: 'html-demo',
    type: 'html',
    title: 'demo.html',
    content: htmlContent,
    filePath: '/tmp/demo.html',
    ext: 'html',
  };

  beforeEach(() => {
    mocks.hanaFetch.mockReset();
    mocks.hanaFetch.mockResolvedValue(new Response(JSON.stringify({
      previewUrl: 'http://127.0.0.1:14500/preview/html/pv_123?previewToken=preview_only_token',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
  });

  afterEach(() => {
    clearAppFileDragPayload();
    cleanup();
  });

  it('registers HTML and loads it through a sandboxed isolated preview URL instead of srcDoc', async () => {
    const { container } = render(<PreviewRenderer previewItem={previewItem} />);

    expect(mocks.hanaFetch).toHaveBeenCalledWith('/api/preview/html', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'demo.html',
        content: htmlContent,
      }),
    });

    const iframe = container.querySelector('iframe');
    expect(iframe).toBeTruthy();
    expect(iframe).toHaveAttribute('sandbox', 'allow-scripts');
    expect(iframe).toHaveAttribute('referrerpolicy', 'no-referrer');
    expect(iframe).not.toHaveAttribute('srcdoc');
    expect(iframe?.getAttribute('sandbox')).not.toContain('allow-same-origin');

    await waitFor(() => {
      expect(iframe).toHaveAttribute('src', 'http://127.0.0.1:14500/preview/html/pv_123?previewToken=preview_only_token');
    });
  });

  it('applies a workspace image dropped on the markdown cover', async () => {
    const dataTransfer = dataTransferStub();
    putWorkspaceImageOnDrag(dataTransfer);
    window.platform = {
      getFileUrl: vi.fn((path: string) => `file://${path}`),
      watchFile: vi.fn(async () => true),
      unwatchFile: vi.fn(async () => true),
    } as unknown as typeof window.platform;
    mocks.hanaFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      ok: true,
      cover: { image: '文本附件/demo-cover.png' },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    const markdownItem: PreviewItem = {
      id: 'markdown-demo',
      type: 'markdown',
      title: 'demo.md',
      content: [
        '---',
        'cover:',
        '  image: cover.png',
        '---',
        '# Demo',
      ].join('\n'),
      filePath: '/tmp/workspace/demo.md',
      ext: 'md',
    };
    const { container } = render(<PreviewRenderer previewItem={markdownItem} />);
    const cover = container.querySelector('.markdown-cover');
    expect(cover).toBeTruthy();

    fireEvent.dragOver(cover!, { dataTransfer });
    fireEvent.drop(cover!, { dataTransfer });

    await waitFor(() => {
      expect(mocks.hanaFetch).toHaveBeenCalledWith('/api/desk/beautify/cover/apply', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          filePath: '/tmp/workspace/demo.md',
          imageFilePath: '/tmp/workspace/cover-source.png',
          agentId: undefined,
        }),
      }));
    });
  });

  it('applies a workspace image dropped on the no-cover preview top rail without a pointer overlay', async () => {
    const dataTransfer = dataTransferStub();
    putWorkspaceImageOnDrag(dataTransfer);
    window.platform = {
      getFileUrl: vi.fn((path: string) => `file://${path}`),
      watchFile: vi.fn(async () => true),
      unwatchFile: vi.fn(async () => true),
    } as unknown as typeof window.platform;
    mocks.hanaFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      ok: true,
      cover: { image: '文本附件/demo-cover.png' },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    const markdownItem: PreviewItem = {
      id: 'markdown-demo',
      type: 'markdown',
      title: 'demo.md',
      content: '# Demo',
      filePath: '/tmp/workspace/demo.md',
      ext: 'md',
    };
    const { container } = render(<PreviewRenderer previewItem={markdownItem} />);
    const host = container.querySelector('.markdown-cover-drop-host');
    const rail = container.querySelector('.markdown-cover-drop-rail');
    expect(host).toBeTruthy();
    expect(rail).toBeTruthy();
    expect(rail).not.toHaveAttribute('ondrop');

    fireEvent.dragOver(host!, { dataTransfer, clientY: 12 });
    expect(rail).toHaveClass('markdown-cover-drop-rail-active');
    fireEvent.drop(host!, { dataTransfer, clientY: 12 });

    await waitFor(() => {
      expect(mocks.hanaFetch).toHaveBeenCalledWith('/api/desk/beautify/cover/apply', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          filePath: '/tmp/workspace/demo.md',
          imageFilePath: '/tmp/workspace/cover-source.png',
          agentId: undefined,
        }),
      }));
    });
  });
});
