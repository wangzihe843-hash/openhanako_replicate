/**
 * markdown-commands.ts — CodeMirror 6 markdown 格式化命令
 *
 * 每个函数接收 EditorView，直接 dispatch transaction。
 * 行内标记（bold / italic / strikethrough / code）对选区做 wrap/unwrap；
 * 块级标记（heading / blockquote / code block / hr / list）操作行首。
 */

import { EditorView } from '@codemirror/view';
import { EditorSelection, Transaction } from '@codemirror/state';

/* ── helpers ── */

function wrapSelection(view: EditorView, marker: string): void {
  const { state } = view;
  const { from, to } = state.selection.main;
  const selected = state.sliceDoc(from, to);

  if (
    selected.length >= marker.length * 2
    && selected.startsWith(marker)
    && selected.endsWith(marker)
  ) {
    const inner = selected.slice(marker.length, selected.length - marker.length);
    view.dispatch({
      changes: { from, to, insert: inner },
      selection: EditorSelection.cursor(from + inner.length),
      annotations: Transaction.userEvent.of('input'),
    });
    return;
  }

  const before = state.sliceDoc(Math.max(0, from - marker.length), from);
  const after = state.sliceDoc(to, Math.min(state.doc.length, to + marker.length));
  if (before === marker && after === marker) {
    view.dispatch({
      changes: [
        { from: from - marker.length, to: from, insert: '' },
        { from: to, to: to + marker.length, insert: '' },
      ],
      selection: EditorSelection.single(from - marker.length, to - marker.length),
      annotations: Transaction.userEvent.of('input'),
    });
    return;
  }

  const wrapped = `${marker}${selected}${marker}`;
  view.dispatch({
    changes: { from, to, insert: wrapped },
    selection: selected.length > 0
      ? EditorSelection.single(from + marker.length, from + marker.length + selected.length)
      : EditorSelection.cursor(from + marker.length),
    annotations: Transaction.userEvent.of('input'),
  });
}

function toggleLinePrefix(view: EditorView, prefix: string, exclusive?: string[]): void {
  const { state } = view;
  const { from, to } = state.selection.main;
  const startLine = state.doc.lineAt(from);
  const endLine = state.doc.lineAt(to);

  const changes: Array<{ from: number; to: number; insert: string }> = [];
  let selShift = 0;

  for (let lineNum = startLine.number; lineNum <= endLine.number; lineNum++) {
    const line = state.doc.line(lineNum);
    const text = line.text;

    if (text.startsWith(prefix)) {
      changes.push({ from: line.from, to: line.from + prefix.length, insert: '' });
      if (lineNum === startLine.number) selShift = -prefix.length;
    } else {
      let stripLen = 0;
      if (exclusive) {
        for (const ex of exclusive) {
          if (text.startsWith(ex)) {
            stripLen = ex.length;
            break;
          }
        }
      }
      if (stripLen > 0) {
        changes.push({ from: line.from, to: line.from + stripLen, insert: prefix });
        if (lineNum === startLine.number) selShift = prefix.length - stripLen;
      } else {
        changes.push({ from: line.from, to: line.from, insert: prefix });
        if (lineNum === startLine.number) selShift = prefix.length;
      }
    }
  }

  view.dispatch({
    changes,
    selection: EditorSelection.cursor(Math.max(0, from + selShift)),
    annotations: Transaction.userEvent.of('input'),
  });
}

function insertBlockAtCursor(view: EditorView, block: string): void {
  const { state } = view;
  const { from } = state.selection.main;
  const line = state.doc.lineAt(from);

  const needsLeadingNewline = line.text.trim().length > 0;
  const insert = needsLeadingNewline ? `\n${block}\n` : `${block}\n`;
  const insertFrom = needsLeadingNewline ? line.to : line.from;

  view.dispatch({
    changes: { from: insertFrom, to: insertFrom, insert },
    selection: EditorSelection.cursor(insertFrom + insert.length),
    annotations: Transaction.userEvent.of('input'),
  });
}

/* ── public commands ── */

const HEADING_PREFIXES = ['# ', '## ', '### '];

export function toggleBold(view: EditorView): void {
  wrapSelection(view, '**');
  view.focus();
}

export function toggleItalic(view: EditorView): void {
  wrapSelection(view, '*');
  view.focus();
}

export function toggleStrikethrough(view: EditorView): void {
  wrapSelection(view, '~~');
  view.focus();
}

export function toggleInlineCode(view: EditorView): void {
  wrapSelection(view, '`');
  view.focus();
}

export function setHeading(view: EditorView, level: 1 | 2 | 3): void {
  const prefix = '#'.repeat(level) + ' ';
  toggleLinePrefix(view, prefix, HEADING_PREFIXES);
  view.focus();
}

export function toggleBlockquote(view: EditorView): void {
  toggleLinePrefix(view, '> ');
  view.focus();
}

export function insertCodeBlock(view: EditorView): void {
  const { state } = view;
  const { from, to } = state.selection.main;
  const selected = state.sliceDoc(from, to);

  if (selected.length > 0) {
    const wrapped = `\`\`\`\n${selected}\n\`\`\``;
    view.dispatch({
      changes: { from, to, insert: wrapped },
      selection: EditorSelection.cursor(from + wrapped.length),
      annotations: Transaction.userEvent.of('input'),
    });
  } else {
    insertBlockAtCursor(view, '```\n\n```');
    const cursor = view.state.selection.main.from;
    view.dispatch({
      selection: EditorSelection.cursor(cursor - 4),
    });
  }
  view.focus();
}

export function insertHorizontalRule(view: EditorView): void {
  insertBlockAtCursor(view, '---');
  view.focus();
}

export function toggleList(view: EditorView): void {
  toggleLinePrefix(view, '- ');
  view.focus();
}
