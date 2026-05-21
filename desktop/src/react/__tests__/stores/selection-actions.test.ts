import { EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { beforeEach, describe, expect, it } from 'vitest';
import { captureSelection, clearSelection } from '../../stores/selection-actions';
import { useStore } from '../../stores';
import type { PreviewItem } from '../../types';

const previewItem: PreviewItem = {
  id: 'preview-1',
  title: 'note.md',
  type: 'markdown',
  content: '',
  filePath: '/notes/note.md',
};

describe('captureSelection', () => {
  beforeEach(() => {
    useStore.getState().clearQuotedSelection();
    useStore.setState({ selectedIdsBySession: {} } as never);
  });

  it('uses the trimmed quoted text range for lineEnd when selection includes a trailing newline', () => {
    const doc = 'alpha\nbeta\ngamma';
    const state = EditorState.create({
      doc,
      selection: { anchor: 6, head: 11 },
    });

    captureSelection(previewItem, { state } as EditorView);

    expect(useStore.getState().quotedSelection).toMatchObject({
      text: 'beta',
      sourceTitle: 'note.md',
      sourceFilePath: '/notes/note.md',
      lineStart: 2,
      lineEnd: 2,
      charCount: 4,
    });
  });

  it('sets explicit message selection per session and removes empty session entries', () => {
    const state = useStore.getState();

    state.setMessageSelection('/session/a.jsonl', ['m2', 'm1', 'm2']);

    expect(useStore.getState().selectedIdsBySession['/session/a.jsonl']).toEqual(['m2', 'm1']);

    useStore.getState().setMessageSelection('/session/a.jsonl', []);

    expect(useStore.getState().selectedIdsBySession['/session/a.jsonl']).toBeUndefined();
  });
});

describe('clearSelection', () => {
  beforeEach(() => {
    useStore.getState().clearQuotedSelection();
  });

  it('清掉带 anchorRect 的浮动划词引用', () => {
    useStore.getState().setQuotedSelection({
      text: '划词选中的文字',
      sourceTitle: 'note.md',
      charCount: 7,
      anchorRect: { left: 0, right: 1, top: 0, bottom: 1, width: 1, height: 1 },
    });
    clearSelection();
    expect(useStore.getState().quotedSelection).toBeNull();
  });

  it('保留不带 anchorRect 的暂存引用（如「去和 TA 聊聊」兑换进来的）', () => {
    useStore.getState().setQuotedSelection({
      text: '秘密草稿正文',
      sourceTitle: '秘密空间 · TA 的草稿箱',
      charCount: 6,
    });
    clearSelection();
    expect(useStore.getState().quotedSelection).toMatchObject({ text: '秘密草稿正文' });
  });
});
