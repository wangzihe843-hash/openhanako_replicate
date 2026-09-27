import '@fontsource/noto-serif-sc/400.css';
import type { XingyeJournalExport } from './xingye-journal-export';

const WIDTH = 900;
const HEIGHT = 1400;
const MARGIN = 76;
const FONT_FAMILY = '"Noto Serif SC", "Microsoft YaHei", "PingFang SC", sans-serif';
const IMAGE_HEIGHT = 286;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 12_000_000;
const IMAGE_TIMEOUT_MS = 6000;
const MARKDOWN_IMAGE_LINE = /^!\[([^\]]*)\]\(([^\s)]+)(?:\s+"[^"]*")?\)$/u;

interface JournalImageReference { alt: string; source: string }

export interface JournalImageLine {
  kind: 'title' | 'meta' | 'body' | 'image';
  text: string;
  image?: JournalImageReference;
  /** A source newline follows this line; soft wraps have no separator. */
  hardBreakAfter?: boolean;
  y: number;
}

export interface JournalImagePage {
  lines: JournalImageLine[];
}

function wrapLine(text: string, maxWidth: number, measure: (text: string) => number): string[] {
  if (!text) return [''];
  const characters = Array.from(text);
  const result: string[] = [];
  let offset = 0;
  while (offset < characters.length) {
    let low = 1;
    let high = characters.length - offset;
    let fit = 1;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      if (measure(characters.slice(offset, offset + middle).join('')) <= maxWidth) {
        fit = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    result.push(characters.slice(offset, offset + fit).join(''));
    offset += fit;
  }
  return result;
}

export function layoutJournalImagePages(
  document: XingyeJournalExport,
  measure: (text: string, kind: JournalImageLine['kind']) => number,
): JournalImagePage[] {
  const pages: JournalImagePage[] = [{ lines: [] }];
  let y = 106;
  const add = (text: string, kind: JournalImageLine['kind'], hardBreakAfter = false, image?: JournalImageReference) => {
    const lineHeight = kind === 'image' ? IMAGE_HEIGHT + 18 : kind === 'title' ? 58 : kind === 'meta' ? 39 : 48;
    if (y + lineHeight > HEIGHT - 110) {
      pages.push({ lines: [] });
      y = 106;
    }
    pages[pages.length - 1].lines.push({ kind, text, hardBreakAfter, y, image });
    y += lineHeight;
  };
  const width = WIDTH - MARGIN * 2;
  for (const part of wrapLine(document.entry.title, width, (value) => measure(value, 'title'))) add(part, 'title');
  y += 15;
  const date = document.entry.dateSmudged ? '日记日期不详' : document.entry.dayKey || '日记日期不详';
  const meta = `${document.agent.displayName} · ${date} · ${document.entry.createdAt}`;
  for (const part of wrapLine(meta, width, (value) => measure(value, 'meta'))) add(part, 'meta');
  if (document.entry.mood) {
    for (const part of wrapLine(`心情：${document.entry.mood}`, width, (value) => measure(value, 'meta'))) add(part, 'meta');
  }
  y += 36;
  const sourceLines = document.entry.body.split('\n');
  sourceLines.forEach((sourceLine, sourceIndex) => {
    const image = parseJournalImageReference(sourceLine);
    if (image) {
      // Keep the exact Markdown source for round-trip validation, but give a
      // base64 image one visual frame instead of wrapping megabytes of data.
      add(sourceLine, 'image', sourceIndex < sourceLines.length - 1, image);
      return;
    }
    const parts = wrapLine(sourceLine, width, (value) => measure(value, 'body'));
    parts.forEach((part, index) => add(part, 'body', index === parts.length - 1 && sourceIndex < sourceLines.length - 1));
  });
  return pages;
}

export function parseJournalImageReference(line: string): JournalImageReference | null {
  const match = MARKDOWN_IMAGE_LINE.exec(line.trim());
  return match ? { alt: match[1], source: match[2] } : null;
}

/** Reconstructs the source body from layout, so callers can verify page completeness. */
export function journalBodyFromImagePages(pages: readonly JournalImagePage[]): string {
  return pages.flatMap(page => page.lines)
    .filter(line => line.kind === 'body' || line.kind === 'image')
    .map(line => line.text + (line.hardBreakAfter ? '\n' : ''))
    .join('');
}

function setFont(context: CanvasRenderingContext2D, kind: JournalImageLine['kind']): void {
  context.font = `${kind === 'title' ? 38 : kind === 'meta' ? 23 : 29}px ${FONT_FAMILY}`;
}

function supportedImageSource(source: string): boolean {
  if (/^data:image\/(?:png|jpeg|webp|gif);base64,/iu.test(source)) {
    return source.length <= MAX_IMAGE_BYTES * 1.4;
  }
  try {
    const url = new URL(source);
    // The main renderer intentionally disallows arbitrary remote requests.
    // Keep those source lines visible as a fallback instead of bypassing CSP.
    return url.protocol === 'blob:' && url.origin === globalThis.location.origin;
  } catch {
    return false;
  }
}

function imageSourceLabel(source: string): string {
  if (source.startsWith('data:')) return `内嵌图片（${source.length} 字符）`;
  return source.length > 110 ? `${source.slice(0, 107)}…` : source;
}

function embeddedImageBlob(source: string): Blob {
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]*={0,2})$/iu.exec(source);
  if (!match) throw new Error('内嵌图片数据无效');
  const binary = atob(match[2]);
  if (binary.length > MAX_IMAGE_BYTES) throw new Error('图片超过 8 MB');
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes.buffer], { type: match[1].toLowerCase() });
}

export async function loadJournalImage(
  source: string,
  deps: {
    fetchImage?: typeof fetch;
    decodeImage?: (blob: Blob) => Promise<ImageBitmap>;
  } = {},
): Promise<{ bitmap: ImageBitmap | null; error?: string }> {
  if (!supportedImageSource(source)) return { bitmap: null, error: '图片地址不支持本地安全绘制' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMAGE_TIMEOUT_MS);
  try {
    let blob: Blob;
    if (source.startsWith('data:')) {
      // Electron's connect-src CSP blocks fetch(data:). Decode only the vetted
      // base64 image bytes locally, without adding a network permission.
      blob = embeddedImageBlob(source);
    } else {
      const response = await (deps.fetchImage || fetch)(source, {
        mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer', signal: controller.signal,
      });
      if (!response.ok || response.type === 'opaque') throw new Error('图片无法读取');
      const declaredBytes = Number(response.headers.get('content-length'));
      if (Number.isFinite(declaredBytes) && declaredBytes > MAX_IMAGE_BYTES) throw new Error('图片超过 8 MB');
      if (response.body) {
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > MAX_IMAGE_BYTES) {
            await reader.cancel();
            throw new Error('图片超过 8 MB');
          }
          chunks.push(value);
        }
        blob = new Blob(chunks as unknown as BlobPart[], { type: response.headers.get('content-type') || '' });
      } else {
        blob = await response.blob();
      }
    }
    if (blob.size > MAX_IMAGE_BYTES) throw new Error('图片超过 8 MB');
    if (!/^image\/(?:png|jpeg|webp|gif)$/iu.test(blob.type)) throw new Error('图片格式不支持');
    if (controller.signal.aborted) throw new Error('图片加载超时');
    let timedOut = false;
    let rejectTimeout: ((error: Error) => void) | null = null;
    const timeout = new Promise<never>((_, reject) => { rejectTimeout = reject; });
    const onAbort = () => {
      timedOut = true;
      rejectTimeout?.(new Error('图片加载超时'));
    };
    controller.signal.addEventListener('abort', onAbort, { once: true });
    const decoding = Promise.resolve().then(() => (deps.decodeImage || createImageBitmap)(blob)).then(bitmap => {
      // createImageBitmap cannot be canceled. Close a bitmap returned after our deadline.
      if (timedOut) { bitmap.close(); throw new Error('图片加载超时'); }
      return bitmap;
    });
    let bitmap: ImageBitmap;
    try {
      bitmap = await Promise.race([decoding, timeout]);
    } finally {
      controller.signal.removeEventListener('abort', onAbort);
    }
    if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > MAX_IMAGE_PIXELS) {
      bitmap.close();
      throw new Error('图片尺寸过大');
    }
    return { bitmap };
  } catch (error) {
    return { bitmap: null, error: error instanceof Error ? error.message : '图片未加载' };
  } finally {
    clearTimeout(timer);
  }
}

export async function renderJournalImagePages(document: XingyeJournalExport): Promise<Blob[]> {
  // Fontsource splits the Chinese font by unicode range. Loading only a sample
  // sentence can leave later pages using a fallback font when they contain
  // characters outside that sample.
  const fonts = globalThis.document.fonts;
  if (!fonts) throw new Error('当前环境无法确认中文字体，已取消长图生成。');
  const bodyGlyphs = [...new Set(Array.from([
    document.agent.displayName,
    document.entry.body,
    document.entry.mood || '',
    document.entry.createdAt,
    document.entry.dayKey || '',
    '星野日记用户已确认的内容来源版本图片未加载',
  ].join('')))].join('');
  const titleGlyphs = [...new Set(Array.from(document.entry.title))].join('') || '日记';
  const loaded = await fonts.load(`29px "Noto Serif SC"`, bodyGlyphs);
  const titleLoaded = await fonts.load(`38px "Noto Serif SC"`, titleGlyphs);
  if (!loaded.length || !titleLoaded.length
    || !fonts.check(`29px "Noto Serif SC"`, bodyGlyphs)
    || !fonts.check(`38px "Noto Serif SC"`, titleGlyphs)) {
    throw new Error('中文字体未加载完成，已取消长图生成。');
  }
  const canvas = globalThis.document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('当前环境无法绘制长图。');
  const pages = layoutJournalImagePages(document, (value, kind) => {
    setFont(context, kind);
    return context.measureText(value).width;
  });
  if (journalBodyFromImagePages(pages) !== document.entry.body) {
    throw new Error('长图排版校验失败，已取消保存以避免正文缺失。');
  }
  const blobs: Blob[] = [];
  for (const [index, page] of pages.entries()) {
    context.fillStyle = '#fffdf8';
    context.fillRect(0, 0, WIDTH, HEIGHT);
    context.fillStyle = '#d9c8b7';
    context.fillRect(MARGIN, 68, WIDTH - MARGIN * 2, 2);
    context.textBaseline = 'top';
    for (const line of page.lines) {
      if (line.kind === 'image' && line.image) {
        const frameWidth = WIDTH - MARGIN * 2;
        context.fillStyle = '#f4eee6';
        context.fillRect(MARGIN, line.y, frameWidth, IMAGE_HEIGHT);
        const loadedImage = await loadJournalImage(line.image.source);
        let imageDrawn = false;
        let imageError = loadedImage.error || '无法读取';
        if (loadedImage.bitmap) {
          const bitmap = loadedImage.bitmap;
          try {
            const scale = Math.min((frameWidth - 28) / bitmap.width, (IMAGE_HEIGHT - 28) / bitmap.height);
            const imageWidth = bitmap.width * scale;
            const imageHeight = bitmap.height * scale;
            context.drawImage(bitmap, MARGIN + (frameWidth - imageWidth) / 2, line.y + (IMAGE_HEIGHT - imageHeight) / 2, imageWidth, imageHeight);
            imageDrawn = true;
          } catch {
            imageError = '图片绘制失败';
          } finally {
            bitmap.close();
          }
        }
        if (!imageDrawn) {
          context.font = `23px ${FONT_FAMILY}`;
          context.fillStyle = '#6d5b51';
          context.fillText(`图片未加载：${imageError}`, MARGIN + 22, line.y + 90);
          context.fillText(line.image.alt || '无图片说明', MARGIN + 22, line.y + 132, frameWidth - 44);
        }
        context.font = `19px ${FONT_FAMILY}`;
        context.fillStyle = '#6d5b51';
        context.fillText(imageSourceLabel(line.image.source), MARGIN + 22, line.y + IMAGE_HEIGHT - 38, frameWidth - 44);
        continue;
      }
      setFont(context, line.kind);
      context.fillStyle = line.kind === 'meta' ? '#6d5b51' : '#352b27';
      context.fillText(line.text, MARGIN, line.y);
    }
    context.fillStyle = '#d9c8b7';
    context.fillRect(MARGIN, HEIGHT - 81, WIDTH - MARGIN * 2, 2);
    context.font = `20px ${FONT_FAMILY}`;
    context.fillStyle = '#746960';
    context.fillText('星野日记 · 用户已确认的内容 · 来源：journal · 版本 1', MARGIN, HEIGHT - 60);
    context.textAlign = 'right';
    context.fillText(`${index + 1} / ${pages.length}`, WIDTH - MARGIN, HEIGHT - 60);
    context.textAlign = 'left';
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('长图 PNG 生成失败。');
    blobs.push(blob);
  }
  return blobs;
}

export function downloadJournalImagePage(blob: Blob, document: XingyeJournalExport, index: number, count: number): void {
  const title = document.entry.title.replace(/[<>:"/\\|?*]/g, '_').replace(/\p{Cc}/gu, '_').replace(/[.\s]+$/g, '').slice(0, 36) || '无标题';
  const id = document.entry.id.replace(/[^A-Za-z0-9_-]/g, '_').slice(-24);
  const name = `日记-${title}-${id}-${String(index + 1).padStart(2, '0')}-共${count}页.png`;
  const url = URL.createObjectURL(blob);
  try {
    const anchor = globalThis.document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    anchor.rel = 'noopener';
    anchor.click();
  } finally {
    // Let the renderer begin reading before releasing the object URL.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
