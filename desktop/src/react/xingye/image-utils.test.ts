/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_CHAT_BACKGROUND_BYTES,
  processChatBackgroundFile,
  validateChatBackgroundFile,
} from './image-utils';

describe('xingye image-utils', () => {
  let readerFails = false;
  let imageFails = false;
  let imageWidth = 1200;
  let imageHeight = 800;
  let canvasContext: CanvasRenderingContext2D | null;
  let canvasDataUrl = 'data:image/webp;base64,compressed';
  let createElementSpy: ReturnType<typeof vi.spyOn>;
  let originalCreateElement: typeof document.createElement;

  beforeEach(() => {
    readerFails = false;
    imageFails = false;
    imageWidth = 1200;
    imageHeight = 800;
    canvasContext = { drawImage: vi.fn() } as unknown as CanvasRenderingContext2D;
    canvasDataUrl = 'data:image/webp;base64,compressed';
    originalCreateElement = document.createElement.bind(document) as typeof document.createElement;

    class MockFileReader {
      result: string | ArrayBuffer | null = null;
      onload: ((event: ProgressEvent<FileReader>) => void) | null = null;
      onerror: ((event: ProgressEvent<FileReader>) => void) | null = null;

      readAsDataURL(file: File) {
        if (readerFails) {
          this.onerror?.(new ProgressEvent('error') as ProgressEvent<FileReader>);
          return;
        }

        this.result = `data:${file.type || 'image/jpeg'};base64,original`;
        this.onload?.(new ProgressEvent('load') as ProgressEvent<FileReader>);
      }
    }

    class MockImage {
      naturalWidth = imageWidth;
      naturalHeight = imageHeight;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;

      set src(_value: string) {
        if (imageFails) {
          this.onerror?.();
          return;
        }

        this.naturalWidth = imageWidth;
        this.naturalHeight = imageHeight;
        this.onload?.();
      }
    }

    vi.stubGlobal('FileReader', MockFileReader);
    vi.stubGlobal('Image', MockImage);
    createElementSpy = vi.spyOn(document, 'createElement').mockImplementation((tagName: string) => {
      if (tagName.toLowerCase() !== 'canvas') {
        return originalCreateElement(tagName);
      }

      return {
        width: 0,
        height: 0,
        getContext: vi.fn(() => canvasContext),
        toDataURL: vi.fn(() => canvasDataUrl),
      } as unknown as HTMLCanvasElement;
    });
  });

  afterEach(() => {
    createElementSpy?.mockRestore();
    vi.unstubAllGlobals();
  });

  it('accepts png, jpeg, jpg, and webp background files up to 3MB', () => {
    for (const type of ['image/png', 'image/jpeg', 'image/jpg', 'image/webp']) {
      const file = new File(['x'], `background.${type.split('/')[1]}`, { type });
      expect(() => validateChatBackgroundFile(file)).not.toThrow();
    }
  });

  it('accepts a blank MIME type when the extension is jpg', () => {
    const file = new File(['x'], 'background.jpg', { type: '' });

    expect(() => validateChatBackgroundFile(file)).not.toThrow();
  });

  it('rejects unsupported background file types', () => {
    const file = new File(['x'], 'background.gif', { type: 'image/gif' });

    expect(() => validateChatBackgroundFile(file)).toThrow('请选择 png / jpg / webp 图片');
  });

  it('rejects unsupported background extensions when MIME type is blank', () => {
    const file = new File(['x'], 'background.bmp', { type: '' });

    expect(() => validateChatBackgroundFile(file)).toThrow('请选择 png / jpg / webp 图片');
  });

  it('rejects background files larger than 3MB', () => {
    const file = new File([new Uint8Array(MAX_CHAT_BACKGROUND_BYTES + 1)], 'background.png', {
      type: 'image/png',
    });

    expect(() => validateChatBackgroundFile(file)).toThrow('图片不能超过 3MB');
  });

  it('returns the original data URL when the image width is at most 1600px', async () => {
    imageWidth = 1600;
    imageHeight = 900;
    const file = new File(['x'], 'background.png', { type: 'image/png' });

    await expect(processChatBackgroundFile(file)).resolves.toEqual({
      dataUrl: 'data:image/png;base64,original',
      width: 1600,
      height: 900,
    });
    expect(createElementSpy).not.toHaveBeenCalledWith('canvas');
  });

  it('compresses images wider than 1600px through canvas', async () => {
    imageWidth = 3200;
    imageHeight = 1800;
    const file = new File(['x'], 'background.jpg', { type: 'image/jpeg' });

    await expect(processChatBackgroundFile(file)).resolves.toEqual({
      dataUrl: 'data:image/webp;base64,compressed',
      width: 1600,
      height: 900,
    });
  });

  it('maps reader.onerror to a readable image read failure', async () => {
    readerFails = true;
    const file = new File(['x'], 'background.png', { type: 'image/png' });

    await expect(processChatBackgroundFile(file)).rejects.toThrow('图片读取失败');
  });

  it('maps img.onerror to a readable image decode failure', async () => {
    imageFails = true;
    const file = new File(['x'], 'background.png', { type: 'image/png' });

    await expect(processChatBackgroundFile(file)).rejects.toThrow('图片解码失败');
  });

  it('maps canvas failures to a readable image compression failure', async () => {
    imageWidth = 3200;
    canvasContext = null;
    const file = new File(['x'], 'background.png', { type: 'image/png' });

    await expect(processChatBackgroundFile(file)).rejects.toThrow('图片压缩失败');
  });
});
