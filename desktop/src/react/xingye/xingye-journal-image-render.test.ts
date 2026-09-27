// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { XingyeJournalExport } from './xingye-journal-export';
import { loadJournalImage, renderJournalImagePages } from './xingye-journal-image';

const source = 'data:image/png;base64,AA==';
const journal: XingyeJournalExport = {
  schemaVersion: 1, contentType: 'xingye-journal-entry', sourceType: 'journal',
  confirmation: 'user-confirmed-heartbeat-draft', agent: { id: 'linwu', displayName: '林雾' },
  entry: {
    id: 'from-draft-image', title: '有图日记', body: `开头\n![照片](${source})\n结尾`,
    createdAt: '2026-09-27T10:00:00.000Z', dayKey: '2026-09-27', dateSmudged: false, mood: null,
  },
};

const drawImage = vi.fn();
const fillText = vi.fn();
const context = {
  fillStyle: '', font: '', textBaseline: '', textAlign: '',
  fillRect: vi.fn(), drawImage, fillText,
  measureText: vi.fn((value: string) => ({ width: Array.from(value).length * 18 })),
} as unknown as CanvasRenderingContext2D;

describe('journal image rendering', () => {
  beforeEach(() => {
    drawImage.mockReset();
    fillText.mockReset();
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { load: vi.fn(async () => [{}]), check: vi.fn(() => true) },
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(callback => {
      callback(new Blob(['png'], { type: 'image/png' }));
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('draws a decoded image and labels its embedded source without printing base64', async () => {
    const bitmap = { width: 120, height: 80, close: vi.fn() } as unknown as ImageBitmap;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Blob(['image'], { type: 'image/png' }), { headers: { 'content-type': 'image/png' } })));
    vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap));
    const loaded = await loadJournalImage(source);
    expect(loaded.error).toBeUndefined();
    const pages = await renderJournalImagePages(journal);
    expect(pages).toHaveLength(1);
    expect(document.fonts.load).toHaveBeenCalledWith('29px "Noto Serif SC"', expect.stringContaining('结尾'));
    expect(document.fonts.load).toHaveBeenCalledWith('38px "Noto Serif SC"', expect.stringContaining('有图日记'));
    expect(drawImage).toHaveBeenCalledOnce();
    expect(bitmap.close).toHaveBeenCalledOnce();
    expect(fillText.mock.calls.some(call => String(call[0]).includes('内嵌图片'))).toBe(true);
    expect(fillText.mock.calls.some(call => String(call[0]).includes('![照片]('))).toBe(false);
    expect(fillText.mock.calls.some(call => String(call[0]).includes('图片未加载'))).toBe(false);
  });

  it('decodes embedded images locally without a fetch(data:) request blocked by Electron CSP', async () => {
    const bitmap = { width: 8, height: 8, close: vi.fn() } as unknown as ImageBitmap;
    const fetchImage = vi.fn();
    const decodeImage = vi.fn(async (blob: Blob) => {
      expect(blob.type).toBe('image/png');
      expect(blob.size).toBe(1);
      return bitmap;
    });
    const loaded = await loadJournalImage(source, { fetchImage, decodeImage });
    expect(loaded.bitmap).toBe(bitmap);
    expect(fetchImage).not.toHaveBeenCalled();
    expect(decodeImage).toHaveBeenCalledOnce();
  });

  it('draws a visible failure placeholder and source label when image loading fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network unavailable'); }));
    const pages = await renderJournalImagePages(journal);
    expect(pages).toHaveLength(1);
    expect(drawImage).not.toHaveBeenCalled();
    expect(fillText.mock.calls.some(call => String(call[0]).includes('图片未加载'))).toBe(true);
    expect(fillText.mock.calls.some(call => String(call[0]).includes('内嵌图片'))).toBe(true);
  });

  it('keeps remote images as visible source text without bypassing the renderer network policy', async () => {
    const fetchImage = vi.fn();
    const result = await loadJournalImage('https://example.org/photo.png', { fetchImage });
    expect(result.bitmap).toBeNull();
    expect(result.error).toContain('不支持');
    expect(fetchImage).not.toHaveBeenCalled();
  });

  it('times out a stalled image decoder and closes its late bitmap', async () => {
    vi.useFakeTimers();
    try {
      let finishDecode!: (bitmap: ImageBitmap) => void;
      let markDecodeStarted!: () => void;
      const decodeStarted = new Promise<void>(resolve => { markDecodeStarted = resolve; });
      const decoded = new Promise<ImageBitmap>(resolve => { finishDecode = resolve; });
      const bitmap = { width: 120, height: 80, close: vi.fn() } as unknown as ImageBitmap;
      const blob = new Blob(['image'], { type: 'image/png' });
      const response = {
        ok: true, type: 'basic', body: null, headers: new Headers({ 'content-type': 'image/png' }),
        blob: async () => blob,
      } as Response;
      const pending = loadJournalImage(source, {
        fetchImage: vi.fn(async () => response),
        decodeImage: () => { markDecodeStarted(); return decoded; },
      });
      await decodeStarted;
      await vi.advanceTimersByTimeAsync(6000);
      const result = await pending;
      expect(result.bitmap).toBeNull();
      expect(result.error).toContain('超时');
      finishDecode(bitmap);
      await Promise.resolve();
      await Promise.resolve();
      expect(bitmap.close).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
});
