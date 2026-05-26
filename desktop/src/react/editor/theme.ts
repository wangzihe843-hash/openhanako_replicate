import { EditorView } from '@codemirror/view';

export const codeTheme = EditorView.theme({
  '&': { fontSize: '0.84rem' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'var(--font-mono)',
    lineHeight: '1.7',
  },
});

export const markdownTheme = EditorView.theme({
  '&': { fontSize: 'var(--editor-markdown-font-size)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'var(--font-serif)',
    lineHeight: 'var(--editor-markdown-line-height)',
    padding: 'var(--space-md) 0',
  },
  '.cm-content': { padding: '0 var(--editor-markdown-content-padding-x)' },
  '.cm-activeLine': { backgroundColor: 'transparent' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent' },
  '.cm-cursor': { borderLeftColor: 'var(--text)' },
  '.cm-md-mark': {
    backgroundColor: 'var(--cm-md-mark-bg, rgba(255, 248, 143, 0.72))',
    borderRadius: '2px',
    padding: '0 1px',
  },
  '.cm-math-widget': {
    fontFamily: 'var(--font-serif)',
  },
  '.cm-math-block-widget': {
    display: 'block',
    overflowX: 'auto',
    padding: 'var(--space-xs) 0',
    borderRadius: 'var(--radius-sm)',
    cursor: 'text',
  },
  '.cm-math-block-widget:hover': {
    backgroundColor: 'var(--overlay-subtle)',
  },
  '.cm-markdown-cover': {
    position: 'relative',
    minHeight: '160px',
    maxHeight: '720px',
    margin: '0 auto var(--space-md)',
    overflow: 'hidden',
    backgroundColor: 'var(--bg-card)',
    borderBottom: '1px solid var(--overlay-light)',
    userSelect: 'none',
    touchAction: 'none',
  },
  '.cm-markdown-cover img': {
    display: 'block',
    width: '100%',
    height: '100%',
    objectFit: 'cover',
    cursor: 'grab',
  },
  '.cm-markdown-cover img:active': {
    cursor: 'grabbing',
  },
  '.cm-markdown-cover-resize': {
    position: 'absolute',
    left: '0',
    right: '0',
    bottom: '0',
    height: '10px',
    cursor: 'ns-resize',
  },
  '.cm-markdown-cover-resize::after': {
    content: '""',
    position: 'absolute',
    left: '50%',
    bottom: '3px',
    width: '56px',
    height: '2px',
    transform: 'translateX(-50%)',
    borderRadius: '999px',
    backgroundColor: 'var(--overlay-medium, rgba(0, 0, 0, 0.16))',
    opacity: '0',
    transition: 'opacity var(--duration-fast)',
  },
  '.cm-markdown-cover:hover .cm-markdown-cover-resize::after': {
    opacity: '0.8',
  },
  '.cm-markdown-cover-missing': {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderLeft: '3px solid var(--accent, var(--mood-text, var(--text-muted)))',
    backgroundColor: 'var(--overlay-subtle)',
    color: 'var(--text-muted)',
    fontSize: '0.7rem',
  },
});
