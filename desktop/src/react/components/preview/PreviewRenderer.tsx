/**
 * PreviewRenderer — PreviewItem 内容的声明式渲染
 *
 * 替代 PreviewPanel 中命令式 DOM 构建的 switch/case useEffect。
 * 每种 previewItem 类型对应一个 JSX 分支或子组件。
 */

import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent, type ReactNode } from 'react';
import { renderMarkdownPreview } from '../../utils/markdown';
import {
  parseMarkdownCover,
  removeMarkdownCover,
  resolveMarkdownCoverImagePath,
  stripMarkdownFrontMatterForPreview,
  updateMarkdownCoverLayout,
  type MarkdownCover,
  type MarkdownCoverLayoutPatch,
} from '../../utils/markdown-cover';
import {
  dispatchCoverNotice,
} from '../../utils/markdown-cover-generation';
import {
  isExternalCoverImagePath,
  regenerateMarkdownCoverWithPrompt,
  saveMarkdownCoverImage,
} from '../../utils/markdown-cover-actions';
import {
  applyMarkdownCoverImageDrop,
  hasMarkdownCoverDropImage,
} from '../../utils/markdown-cover-drop';
import { parseCSV, injectCopyButtons } from '../../utils/format';
import { fileIconSvg } from '../../utils/icons';
import { openFilePreview } from '../../utils/file-preview';
import { openInternalLink, resolveLinkTarget, type LinkOpenContext } from '../../utils/link-open';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import { useStore } from '../../stores';
import { upsertPreviewItem } from '../../stores/preview-actions';
import { useMermaidDiagrams } from '../../hooks/use-mermaid-diagrams';
import { LinkContextMenu, type LinkContextMenuState } from '../shared/LinkContextMenu';
import type { PreviewItem } from '../../types';

declare function t(key: string, vars?: Record<string, string | number>): string;

// ── LegacyMediaFallback ──
// image / svg 旧类型 previewItem 的隔离渲染组件。
// currentSessionPath 订阅收窄到此组件，不影响 html/markdown/code/csv 等主流路径。

function LegacyMediaFallback({ previewItem }: { previewItem: PreviewItem }) {
  const currentSessionPath = useStore(s => s.currentSessionPath);

  if (process.env.NODE_ENV !== 'production') {
    console.warn('[PreviewRenderer] 旧类型 image/svg previewItem，走 fallback，请通过文件重新打开以使用新 MediaViewer');
  }

  const onOpen = () => {
    if (!previewItem.filePath || !previewItem.ext) return;
    const context = currentSessionPath
      ? { origin: 'session' as const, sessionPath: currentSessionPath }
      : { origin: 'desk' as const };
    openFilePreview(previewItem.filePath, previewItem.title, previewItem.ext, context);
  };

  return (
    <div
      onClick={onOpen}
      role="button"
      tabIndex={0}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: 200,
        color: 'var(--text-muted)',
        cursor: 'default',
        fontSize: '0.85rem',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--text)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-muted)'; }}
    >
      <span>此图片预览已升级，点此在新查看器打开</span>
    </div>
  );
}

interface PreviewRendererProps {
  previewItem: PreviewItem;
}

// ── HtmlPreview ──
// srcDoc/blob 会继承主窗口 CSP，无法安全地为 Tailwind 等 CDN 单独放权。
// HTML preview 改走短期 server 文档：iframe 继续 sandbox，响应自己携带 preview 专用 CSP。

function HtmlPreview({ previewItem }: { previewItem: PreviewItem }) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSrc(null);
    setError(null);

    hanaFetch('/api/preview/html', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: previewItem.title,
        content: previewItem.content,
        sourceFilePath: previewItem.filePath,
      }),
    })
      .then(async (res) => {
        const data = await res.json().catch(() => null);
        if (!data || typeof data.previewUrl !== 'string' || !data.previewUrl) {
          throw new Error('invalid html preview response');
        }
        if (!cancelled) setSrc(data.previewUrl);
      })
      .catch((err) => {
        console.error('[PreviewRenderer] HTML preview registration failed:', err);
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      cancelled = true;
    };
  }, [previewItem.content, previewItem.filePath, previewItem.title]);

  if (error) {
    return <pre className="preview-code">{error}</pre>;
  }

  return (
    <iframe
      title={previewItem.title}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      src={src || undefined}
    />
  );
}

// ── MarkdownPreview ──

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function coverLayout(cover: MarkdownCover): Required<MarkdownCoverLayoutPatch> {
  return {
    displayWidth: clamp(cover.displayWidth ?? 100, 40, 100),
    displayHeight: clamp(cover.displayHeight ?? 320, 160, 720),
    positionX: clamp(cover.positionX ?? 50, 0, 100),
    positionY: clamp(cover.positionY ?? 50, 0, 100),
  };
}

function MarkdownCoverView({ previewItem, cover }: { previewItem: PreviewItem; cover: MarkdownCover }) {
  const [layout, setLayout] = useState(() => coverLayout(cover));
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [coverDropActive, setCoverDropActive] = useState(false);
  const layoutRef = useRef(layout);
  const dragRef = useRef<null | {
    kind: 'position' | 'height';
    startY: number;
    startLayout: Required<MarkdownCoverLayoutPatch>;
  }>(null);

  useEffect(() => {
    setLayout(coverLayout(cover));
  }, [cover.displayHeight, cover.displayWidth, cover.positionX, cover.positionY, cover.image]);

  useEffect(() => {
    layoutRef.current = layout;
  }, [layout]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [menu]);

  const imagePath = resolveMarkdownCoverImagePath(previewItem.filePath, cover.image);
  const imageUrl = imagePath && isExternalCoverImagePath(imagePath)
    ? imagePath
    : imagePath ? window.platform?.getFileUrl?.(imagePath) || imagePath : null;

  const persistLayout = useCallback(async (nextLayout: Required<MarkdownCoverLayoutPatch>) => {
    if (!previewItem.filePath || !window.platform?.writeFileIfUnchanged) return;
    const writeNext = async (content: string, version: PreviewItem['fileVersion']) => {
      const nextContent = updateMarkdownCoverLayout(content, nextLayout);
      const result = await window.platform?.writeFileIfUnchanged?.(previewItem.filePath!, nextContent, version || null);
      return { result, nextContent };
    };

    let { result, nextContent } = await writeNext(previewItem.content, previewItem.fileVersion);
    if (!result?.ok && result?.conflict && window.platform?.readFileSnapshot) {
      const snapshot = await window.platform.readFileSnapshot(previewItem.filePath);
      if (snapshot?.content != null) {
        ({ result, nextContent } = await writeNext(snapshot.content, snapshot.version));
      }
    }

    if (result?.ok) {
      upsertPreviewItem({ ...previewItem, content: nextContent, fileVersion: result.version });
      return;
    }
    dispatchCoverNotice('Cover 布局保存失败，文件可能已被外部修改。', 'error');
  }, [previewItem]);

  const deleteCover = useCallback(async () => {
    setMenu(null);
    if (!previewItem.filePath || !window.platform?.writeFileIfUnchanged) return;
    const writeNext = async (content: string, version: PreviewItem['fileVersion']) => {
      const nextContent = removeMarkdownCover(content);
      if (nextContent === content) return { result: { ok: true, version }, nextContent };
      const result = await window.platform?.writeFileIfUnchanged?.(previewItem.filePath!, nextContent, version || null);
      return { result, nextContent };
    };

    let { result, nextContent } = await writeNext(previewItem.content, previewItem.fileVersion);
    if (!result?.ok && result?.conflict && window.platform?.readFileSnapshot) {
      const snapshot = await window.platform.readFileSnapshot(previewItem.filePath);
      if (snapshot?.content != null) {
        ({ result, nextContent } = await writeNext(snapshot.content, snapshot.version));
      }
    }

    if (result?.ok) {
      upsertPreviewItem({ ...previewItem, content: nextContent, fileVersion: result.version });
      dispatchCoverNotice('已删除封面。', 'success');
      return;
    }
    dispatchCoverNotice('封面删除失败，文件可能已被外部修改。', 'error');
  }, [previewItem]);

  const finishDrag = useCallback(() => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag) void persistLayout(layoutRef.current);
  }, [persistLayout]);

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const dy = event.clientY - drag.startY;
      if (drag.kind === 'height') {
        setLayout(prev => ({
          ...prev,
          displayHeight: clamp(drag.startLayout.displayHeight + dy, 160, 720),
        }));
      } else {
        const delta = (dy / Math.max(1, drag.startLayout.displayHeight)) * 100;
        setLayout(prev => ({
          ...prev,
          positionY: clamp(drag.startLayout.positionY - delta, 0, 100),
        }));
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', finishDrag);
    window.addEventListener('pointercancel', finishDrag);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', finishDrag);
      window.removeEventListener('pointercancel', finishDrag);
    };
  }, [finishDrag]);

  const beginDrag = useCallback((kind: 'position' | 'height', event: React.PointerEvent) => {
    event.preventDefault();
    setMenu(null);
    dragRef.current = {
      kind,
      startY: event.clientY,
      startLayout: layout,
    };
  }, [layout]);

  const saveImage = useCallback(async () => {
    setMenu(null);
    await saveMarkdownCoverImage(imagePath);
  }, [imagePath]);

  const regenerateWithPrompt = useCallback(async () => {
    setMenu(null);
    await regenerateMarkdownCoverWithPrompt(previewItem.filePath);
  }, [previewItem.filePath]);

  const handleCoverDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!previewItem.filePath || !hasMarkdownCoverDropImage(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
    setCoverDropActive(true);
  }, [previewItem.filePath]);

  const handleCoverDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    setCoverDropActive(false);
  }, []);

  const handleCoverDrop = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!previewItem.filePath || !hasMarkdownCoverDropImage(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    setCoverDropActive(false);
    void applyMarkdownCoverImageDrop({
      filePath: previewItem.filePath,
      dataTransfer: event.dataTransfer,
    });
  }, [previewItem.filePath]);

  if (!imageUrl) return null;

  return (
    <div
      className={`markdown-cover${coverDropActive ? ' markdown-cover-drop-active' : ''}`}
      style={{
        width: `${layout.displayWidth}%`,
        height: `${layout.displayHeight}px`,
        marginLeft: 'auto',
        marginRight: 'auto',
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        setMenu({ x: event.clientX, y: event.clientY });
      }}
      onDragOver={handleCoverDragOver}
      onDragLeave={handleCoverDragLeave}
      onDrop={handleCoverDrop}
    >
      <img
        src={imageUrl}
        alt=""
        draggable={false}
        style={{ objectPosition: `${layout.positionX}% ${layout.positionY}%` }}
        onPointerDown={(event) => beginDrag('position', event)}
      />
      <div
        className="markdown-cover-resize"
        role="separator"
        aria-orientation="horizontal"
        onPointerDown={(event) => beginDrag('height', event)}
      />
      {menu && (
        <div
          className="markdown-cover-menu"
          style={{ left: `${menu.x}px`, top: `${menu.y}px` }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button type="button" onClick={saveImage}>{t('preview.cover.saveImage')}</button>
          <button type="button" onClick={regenerateWithPrompt}>{t('preview.cover.regenerateWithPrompt')}</button>
          <button type="button" className="markdown-cover-menu-danger" onClick={deleteCover}>{t('preview.cover.deleteCover')}</button>
        </div>
      )}
    </div>
  );
}

function isMarkdownTopCoverDrop(event: DragEvent<HTMLElement>): boolean {
  const rect = event.currentTarget.getBoundingClientRect();
  const y = Number.isFinite(event.clientY) ? event.clientY : rect.top;
  return y >= rect.top && y <= rect.top + 40;
}

function MarkdownCoverDropRail({ active }: { active: boolean }) {
  return (
    <div
      aria-hidden="true"
      className={`markdown-cover-drop-rail${active ? ' markdown-cover-drop-rail-active' : ''}`}
    />
  );
}

function MarkdownNoCoverDropHost({ filePath, children }: { filePath?: string; children: ReactNode }) {
  const [active, setActive] = useState(false);

  const handleDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!filePath || !hasMarkdownCoverDropImage(event.dataTransfer) || !isMarkdownTopCoverDrop(event)) {
      setActive(false);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
    setActive(true);
  }, [filePath]);

  const handleDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    setActive(false);
  }, []);

  const handleDrop = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!filePath || !hasMarkdownCoverDropImage(event.dataTransfer) || !isMarkdownTopCoverDrop(event)) return;
    event.preventDefault();
    event.stopPropagation();
    setActive(false);
    void applyMarkdownCoverImageDrop({
      filePath,
      dataTransfer: event.dataTransfer,
    });
  }, [filePath]);

  if (!filePath) return <>{children}</>;
  return (
    <div
      className="markdown-cover-drop-host"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <MarkdownCoverDropRail active={active} />
      {children}
    </div>
  );
}

function MarkdownPreview({ previewItem }: { previewItem: PreviewItem }) {
  const divRef = useRef<HTMLDivElement>(null);
  const [linkMenu, setLinkMenu] = useState<LinkContextMenuState | null>(null);
  const cover = useMemo(() => parseMarkdownCover(previewItem.content), [previewItem.content]);
  const body = useMemo(() => stripMarkdownFrontMatterForPreview(previewItem.content), [previewItem.content]);
  const linkContext = useMemo<LinkOpenContext>(() => ({
    origin: 'desk',
    baseFilePath: previewItem.filePath,
  }), [previewItem.filePath]);

  const findAnchor = useCallback((event: MouseEvent): HTMLAnchorElement | null => {
    const root = divRef.current;
    const target = event.target;
    if (!root || !(target instanceof Element)) return null;
    const anchor = target.closest<HTMLAnchorElement>('a[href]');
    if (!anchor || !root.contains(anchor)) return null;
    return anchor;
  }, []);

  const handleLinkClick = useCallback((event: MouseEvent) => {
    const anchor = findAnchor(event);
    if (!anchor) return;
    const href = anchor.getAttribute('href') || '';
    const context = {
      ...linkContext,
      label: anchor.textContent?.trim() || undefined,
    };
    if (resolveLinkTarget(href, context).kind === 'anchor') return;
    event.preventDefault();
    event.stopPropagation();
    void openInternalLink(href, context);
  }, [findAnchor, linkContext]);

  const handleLinkContextMenu = useCallback((event: MouseEvent) => {
    const anchor = findAnchor(event);
    if (!anchor) return;
    event.preventDefault();
    event.stopPropagation();
    setLinkMenu({
      href: anchor.getAttribute('href') || '',
      context: {
        ...linkContext,
        label: anchor.textContent?.trim() || undefined,
      },
      position: { x: event.clientX, y: event.clientY },
    });
  }, [findAnchor, linkContext]);

  useEffect(() => {
    if (divRef.current) {
      injectCopyButtons(divRef.current);
    }
  }, [body]);
  useMermaidDiagrams(divRef, [body]);

  return (
    <>
      {cover && <MarkdownCoverView previewItem={previewItem} cover={cover} />}
      {cover ? (
        <div
          ref={divRef}
          className="preview-markdown md-content markdown-has-cover"
          onClick={handleLinkClick}
          onContextMenu={handleLinkContextMenu}
          dangerouslySetInnerHTML={{
            __html: renderMarkdownPreview(body, {
              filePath: previewItem.filePath,
              getFileUrl: window.platform?.getFileUrl,
            }),
          }}
        />
      ) : (
        <MarkdownNoCoverDropHost filePath={previewItem.filePath}>
          <div
            ref={divRef}
            className="preview-markdown md-content"
            onClick={handleLinkClick}
            onContextMenu={handleLinkContextMenu}
            dangerouslySetInnerHTML={{
              __html: renderMarkdownPreview(body, {
                filePath: previewItem.filePath,
                getFileUrl: window.platform?.getFileUrl,
              }),
            }}
          />
        </MarkdownNoCoverDropHost>
      )}
      {linkMenu && (
        <LinkContextMenu
          state={linkMenu}
          onClose={() => setLinkMenu(null)}
        />
      )}
    </>
  );
}

// ── CsvPreview ──

function CsvPreview({ content }: { content: string }) {
  const rows = parseCSV(content);
  if (rows.length === 0) {
    return <div className="preview-csv"><table /></div>;
  }

  const headerRow = rows[0];
  const bodyRows = rows.slice(1);

  return (
    <div className="preview-csv">
      <table>
        <thead>
          <tr>
            {headerRow.map((cell, i) => (
              <th key={`csv-h-${i}`}>{cell}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {bodyRows.map((row, ri) => (
            <tr key={`csv-r-${ri}`}>
              {row.map((cell, ci) => (
                <td key={`csv-c-${ri}-${ci}`}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── PdfPreview ──
// data: URL 在 Electron 中无法渲染大 PDF，改用 blob URL 触发 Chromium 内置查看器

function PdfPreview({ content }: { content: string }) {
  const url = useMemo(() => {
    const raw = atob(content);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  }, [content]);

  useEffect(() => {
    return () => URL.revokeObjectURL(url);
  }, [url]);

  return <iframe className="preview-pdf" src={`${url}#toolbar=0&navpanes=0`} />;
}

// ── FileInfoPreview ──

function FileInfoPreview({ previewItem }: { previewItem: PreviewItem }) {
  const t = window.t ?? ((p: string) => p);
  const ext = previewItem.ext || '';

  return (
    <div className="preview-file-info">
      <div
        className="preview-file-icon"
        dangerouslySetInnerHTML={{ __html: fileIconSvg(ext) }}
      />
      <div className="preview-file-name">{previewItem.title}</div>
      <div className="preview-file-ext">
        {ext.toUpperCase()} {t('desk.fileLabel')}
      </div>
      <button
        className="preview-file-open-btn"
        onClick={() => {
          if (previewItem.filePath) window.platform?.openFile?.(previewItem.filePath);
        }}
      >
        {t('desk.openWithDefault')}
      </button>
    </div>
  );
}

// ── PreviewRenderer ──

export function PreviewRenderer({ previewItem }: PreviewRendererProps) {
  switch (previewItem.type) {
    case 'html':
      return <HtmlPreview previewItem={previewItem} />;

    case 'markdown':
      return <MarkdownPreview previewItem={previewItem} />;

    case 'code':
      return (
        <pre className="preview-code">
          <code className={previewItem.language ? `language-${previewItem.language}` : undefined}>
            {previewItem.content}
          </code>
        </pre>
      );

    case 'csv':
      return <CsvPreview content={previewItem.content} />;

    // image / svg：旧类型 previewItem 的 fallback。新路径不再产生此类 previewItem，
    // 持久化或旧 session 恢复时可能命中。点击后按 owner 路由到统一的 MediaViewer。
    case 'image':
    case 'svg':
      return <LegacyMediaFallback previewItem={previewItem} />;

    case 'pdf':
      return <PdfPreview content={previewItem.content} />;

    case 'docx':
      return (
        <div
          className="preview-docx md-content"
          dangerouslySetInnerHTML={{ __html: previewItem.content }}
        />
      );

    case 'xlsx':
      return (
        <div
          className="preview-csv"
          dangerouslySetInnerHTML={{ __html: previewItem.content }}
        />
      );

    case 'file-info':
      return <FileInfoPreview previewItem={previewItem} />;

    default:
      return (
        <pre className="preview-code">{previewItem.content}</pre>
      );
  }
}
