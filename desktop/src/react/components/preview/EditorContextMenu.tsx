/**
 * EditorContextMenu — 编辑器右键上下文菜单
 *
 * 由 PreviewEditor 内部挂载，自动适配所有渲染路径（主面板、Viewer 窗口等）。
 *
 * mode === 'markdown' && !readOnly 时显示格式化工具栏（B I S 等）；
 * readOnly 时只保留 复制 / 全选。
 *
 * 所有 document / window 引用走 ownerDocument / ownerWindow，
 * 保证在 DOM-adopted 子窗口中 portal 和事件监听指向正确的宿主。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { undo, redo } from '@codemirror/commands';
import {
  toggleBold,
  toggleItalic,
  toggleStrikethrough,
  toggleInlineCode,
  setHeading,
  toggleBlockquote,
  insertCodeBlock,
  insertHorizontalRule,
  toggleList,
} from '../../editor/markdown-commands';
import { useStore } from '../../stores';
import type { EditorView } from '@codemirror/view';

function label(key: string, fallback: string): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- viewer 窗口无 i18n，需安全降级
    const fn = (window as any).t as ((k: string) => string) | undefined;
    return fn ? fn(key) : fallback;
  } catch {
    return fallback;
  }
}

interface MenuState {
  position: { x: number; y: number };
  hasSelection: boolean;
  canUndo: boolean;
  canRedo: boolean;
}

function editorHasSelection(view: EditorView): boolean {
  return view.state.selection.ranges.some(r => !r.empty);
}

function editorCanUndo(view: EditorView): boolean {
  return undo({ state: view.state, dispatch: () => {} });
}

function editorCanRedo(view: EditorView): boolean {
  return redo({ state: view.state, dispatch: () => {} });
}

interface Props {
  getView: () => EditorView | null;
  containerRef: React.RefObject<HTMLDivElement | null>;
  mode: 'markdown' | 'code' | 'csv' | 'text';
  readOnly?: boolean;
}

export function EditorContextMenu({ getView, containerRef, mode, readOnly = false }: Props) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const ownerDoc = useCallback(
    () => containerRef.current?.ownerDocument ?? document,
    [containerRef],
  );
  const ownerWin = useCallback(
    () => containerRef.current?.ownerDocument?.defaultView ?? window,
    [containerRef],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;

    const handleContextMenu = (e: MouseEvent) => {
      const view = getView();
      if (!view) return;

      const target = e.target;
      if (!(target instanceof HTMLElement)) return;
      if (!container.contains(target)) return;

      e.preventDefault();
      e.stopPropagation();

      useStore.getState().clearQuoteCandidate?.();

      setMenu({
        position: { x: e.clientX, y: e.clientY },
        hasSelection: editorHasSelection(view),
        canUndo: !readOnly && editorCanUndo(view),
        canRedo: !readOnly && editorCanRedo(view),
      });
    };

    container.addEventListener('contextmenu', handleContextMenu);
    return () => container.removeEventListener('contextmenu', handleContextMenu);
  }, [getView, containerRef, readOnly]);

  useEffect(() => {
    if (!menu || !menuRef.current) return;
    const el = menuRef.current;
    const rect = el.getBoundingClientRect();
    const win = ownerWin();
    let { x, y } = menu.position;
    if (x + rect.width > win.innerWidth) x = win.innerWidth - rect.width - 4;
    if (y + rect.height > win.innerHeight) y = win.innerHeight - rect.height - 4;
    if (x < 0) x = 4;
    if (y < 0) y = 4;
    el.style.left = x + 'px';
    el.style.top = y + 'px';
  }, [menu, ownerWin]);

  useEffect(() => {
    if (!menu) return undefined;
    const doc = ownerDoc();
    const win = ownerWin();

    const close = () => setMenu(null);
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      close();
    };
    const handleCtx = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      close();
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    const handleScroll = () => close();

    const timer = setTimeout(() => {
      doc.addEventListener('click', handleClick, true);
      doc.addEventListener('contextmenu', handleCtx, true);
      doc.addEventListener('keydown', handleKeyDown);
      win.addEventListener('scroll', handleScroll, true);
    });

    return () => {
      clearTimeout(timer);
      doc.removeEventListener('click', handleClick, true);
      doc.removeEventListener('contextmenu', handleCtx, true);
      doc.removeEventListener('keydown', handleKeyDown);
      win.removeEventListener('scroll', handleScroll, true);
    };
  }, [menu, ownerDoc, ownerWin]);

  const close = useCallback(() => setMenu(null), []);

  const runEditCommand = useCallback(async (command: 'cut' | 'copy' | 'paste' | 'selectAll') => {
    const view = getView();
    if (!view) return;
    view.focus();
    try {
      await window.platform?.runEditCommand?.(command);
    } catch (err) {
      console.warn('[EditorContextMenu] edit command failed:', err);
    }
  }, [getView]);

  const handleUndo = useCallback(() => {
    const view = getView();
    if (view) { undo(view); view.focus(); }
  }, [getView]);

  const handleRedo = useCallback(() => {
    const view = getView();
    if (view) { redo(view); view.focus(); }
  }, [getView]);

  if (!menu) return null;

  const isMac = navigator.platform?.startsWith('Mac') || navigator.userAgent?.includes('Mac');
  const mod = isMac ? '⌘' : 'Ctrl+';
  const showFmt = mode === 'markdown' && !readOnly;

  return createPortal(
    <div
      className="context-menu"
      ref={menuRef}
      style={{ left: menu.position.x, top: menu.position.y }}
    >
      {!readOnly && (
        <MenuItem
          label={label('ctx.cut', '剪切')}
          shortcut={`${mod}X`}
          disabled={!menu.hasSelection}
          onClick={() => { close(); void runEditCommand('cut'); }}
        />
      )}
      <MenuItem
        label={label('ctx.copy', '复制')}
        shortcut={`${mod}C`}
        disabled={!menu.hasSelection}
        onClick={() => { close(); void runEditCommand('copy'); }}
      />
      {!readOnly && (
        <MenuItem
          label={label('ctx.paste', '粘贴')}
          shortcut={`${mod}V`}
          onClick={() => { close(); void runEditCommand('paste'); }}
        />
      )}
      <div className="context-menu-divider" />
      <MenuItem
        label={label('ctx.selectAll', '全选')}
        shortcut={`${mod}A`}
        onClick={() => { close(); void runEditCommand('selectAll'); }}
      />
      {!readOnly && (
        <>
          <div className="context-menu-divider" />
          <MenuItem
            label={label('ctx.undo', '撤销')}
            shortcut={`${mod}Z`}
            disabled={!menu.canUndo}
            onClick={() => { close(); handleUndo(); }}
          />
          <MenuItem
            label={label('ctx.redo', '重做')}
            shortcut={isMac ? '⇧⌘Z' : 'Ctrl+Y'}
            disabled={!menu.canRedo}
            onClick={() => { close(); handleRedo(); }}
          />
        </>
      )}

      {showFmt && (
        <>
          <div className="context-menu-divider" />
          <div className="context-menu-fmt-row">
            <FmtButton title={label('ctx.bold', '粗体')} onClick={() => { close(); const v = getView(); if (v) toggleBold(v); }}>
              <span className="context-menu-fmt-text" style={{ fontWeight: 700 }}>B</span>
            </FmtButton>
            <FmtButton title={label('ctx.italic', '斜体')} onClick={() => { close(); const v = getView(); if (v) toggleItalic(v); }}>
              <span className="context-menu-fmt-text" style={{ fontStyle: 'italic' }}>I</span>
            </FmtButton>
            <FmtButton title={label('ctx.strikethrough', '删除线')} onClick={() => { close(); const v = getView(); if (v) toggleStrikethrough(v); }}>
              <span className="context-menu-fmt-text" style={{ textDecoration: 'line-through' }}>S</span>
            </FmtButton>
            <FmtButton title={label('ctx.inlineCode', '行内代码')} onClick={() => { close(); const v = getView(); if (v) toggleInlineCode(v); }}>
              <svg viewBox="0 0 24 24"><polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" /></svg>
            </FmtButton>
            <FmtButton title={label('ctx.heading1', '标题 1')} onClick={() => { close(); const v = getView(); if (v) setHeading(v, 1); }}>
              <span className="context-menu-fmt-text" style={{ fontSize: '0.8em', fontWeight: 600 }}>H<sub>1</sub></span>
            </FmtButton>
            <FmtButton title={label('ctx.heading2', '标题 2')} onClick={() => { close(); const v = getView(); if (v) setHeading(v, 2); }}>
              <span className="context-menu-fmt-text" style={{ fontSize: '0.75em', fontWeight: 500 }}>H<sub>2</sub></span>
            </FmtButton>
            <FmtButton title={label('ctx.heading3', '标题 3')} onClick={() => { close(); const v = getView(); if (v) setHeading(v, 3); }}>
              <span className="context-menu-fmt-text" style={{ fontSize: '0.7em', fontWeight: 500 }}>H<sub>3</sub></span>
            </FmtButton>
          </div>
          <div className="context-menu-fmt-row">
            <FmtButton title={label('ctx.blockquote', '引用')} onClick={() => { close(); const v = getView(); if (v) toggleBlockquote(v); }}>
              <svg viewBox="0 0 24 24" style={{ fill: 'currentColor', stroke: 'none' }}>
                <path fillRule="evenodd" clipRule="evenodd" d="M20 5H4V19H20V5ZM4 3C2.89543 3 2 3.89543 2 5V19C2 20.1046 2.89543 21 4 21H20C21.1046 21 22 20.1046 22 19V5C22 3.89543 21.1046 3 20 3H4Z" />
                <path d="M9.06723 9.19629H12.0672L9.93267 14.8038H6.93267L9.06723 9.19629Z" />
                <path d="M14.0672 9.19629H17.0672L14.9327 14.8038H11.9327L14.0672 9.19629Z" />
              </svg>
            </FmtButton>
            <FmtButton title={label('ctx.codeBlock', '代码块')} onClick={() => { close(); const v = getView(); if (v) insertCodeBlock(v); }}>
              <svg viewBox="0 0 24 24">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <polyline points="9 8 7 12 9 16" />
                <polyline points="15 8 17 12 15 16" />
              </svg>
            </FmtButton>
            <FmtButton title={label('ctx.horizontalRule', '分隔线')} onClick={() => { close(); const v = getView(); if (v) insertHorizontalRule(v); }}>
              <svg viewBox="0 0 24 24"><line x1="3" y1="12" x2="21" y2="12" /></svg>
            </FmtButton>
            <FmtButton title={label('ctx.list', '列表')} onClick={() => { close(); const v = getView(); if (v) toggleList(v); }}>
              <svg viewBox="0 0 24 24">
                <line x1="9" y1="6" x2="20" y2="6" />
                <line x1="9" y1="12" x2="20" y2="12" />
                <line x1="9" y1="18" x2="20" y2="18" />
                <circle cx="4.5" cy="6" r="1.2" />
                <circle cx="4.5" cy="12" r="1.2" />
                <circle cx="4.5" cy="18" r="1.2" />
              </svg>
            </FmtButton>
          </div>
        </>
      )}
    </div>,
    ownerDoc().body,
  );
}

/* ── 子组件 ── */

function MenuItem({ label: text, shortcut, disabled, onClick }: {
  label: string;
  shortcut?: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <div
      className={`context-menu-item${disabled ? ' disabled' : ''}`}
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => {
        if (disabled) { e.preventDefault(); e.stopPropagation(); return; }
        e.stopPropagation();
        onClick();
      }}
    >
      <span className="context-menu-label">{text}</span>
      {shortcut && <span className="context-menu-shortcut">{shortcut}</span>}
    </div>
  );
}

function FmtButton({ title, onClick, children }: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="context-menu-fmt-btn"
      title={title}
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
    >
      {children}
    </div>
  );
}
