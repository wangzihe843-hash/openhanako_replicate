/**
 * @vitest-environment jsdom
 */
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it } from 'vitest';
import { markdownCoverField } from '../../editor/cover-field';
import { markdownImageContextFacet } from '../../editor/md-decorations';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('markdown cover editor field', () => {
  it('renders cover frontmatter as an editor widget without exposing raw YAML text', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: [
          '---',
          'cover:',
          '  image: 文本附件/cover.png',
          '  displayWidth: 72',
          '  displayHeight: 280',
          '  positionY: 64',
          '---',
          '# Demo',
        ].join('\n'),
        extensions: [
          markdownImageContextFacet.of({
            filePath: '/vault/notes/day.md',
            getFileUrl: (filePath) => `file://${filePath}`,
          }),
          markdownCoverField,
        ],
      }),
    });

    const cover = parent.querySelector('.cm-markdown-cover') as HTMLElement | null;
    const img = parent.querySelector('.cm-markdown-cover img');

    expect(cover).toBeInstanceOf(HTMLElement);
    expect(cover?.classList.contains('cm-markdown-cover-top')).toBe(true);
    expect(view.dom.classList.contains('cm-markdown-has-top-cover')).toBe(true);
    expect(cover?.style.width).toBe('72%');
    expect(cover?.style.height).toBe('280px');
    expect(parent.textContent).not.toContain('cover:');
    expect(parent.textContent).toContain('Demo');
    expect(img?.getAttribute('src')).toBe('file:///vault/notes/文本附件/cover.png');
    expect((img as HTMLElement | null)?.style.objectPosition).toBe('50% 64%');

    view.destroy();
  });

  it('does not hide non-cover frontmatter fields in editor mode', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: [
          '---',
          'title: Demo Note',
          'cover:',
          '  image: 文本附件/cover.png',
          'tags:',
          '  - writing',
          '---',
          '# Demo',
        ].join('\n'),
        extensions: [
          markdownImageContextFacet.of({
            filePath: '/vault/notes/day.md',
            getFileUrl: (filePath) => `file://${filePath}`,
          }),
          markdownCoverField,
        ],
      }),
    });

    expect(parent.querySelector('.cm-markdown-cover')).toBeInstanceOf(HTMLElement);
    expect(parent.querySelector('.cm-markdown-cover')?.classList.contains('cm-markdown-cover-top')).toBe(false);
    expect(view.dom.classList.contains('cm-markdown-has-top-cover')).toBe(false);
    expect(parent.textContent).toContain('title: Demo Note');
    expect(parent.textContent).toContain('tags:');
    expect(parent.textContent).not.toContain('cover:');

    view.destroy();
  });

  it('marks full-width covers as horizontal bleed blocks', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: [
          '---',
          'cover:',
          '  image: 文本附件/cover.png',
          '---',
          '# Demo',
        ].join('\n'),
        extensions: [
          markdownImageContextFacet.of({
            filePath: '/vault/notes/day.md',
            getFileUrl: (filePath) => `file://${filePath}`,
          }),
          markdownCoverField,
        ],
      }),
    });

    const cover = parent.querySelector('.cm-markdown-cover') as HTMLElement | null;

    expect(cover?.classList.contains('cm-markdown-cover-top')).toBe(true);
    expect(cover?.classList.contains('cm-markdown-cover-bleed-x')).toBe(true);
    expect(cover?.style.width).toBe('');
    expect(cover?.style.marginLeft).toBe('');
    expect(cover?.style.marginRight).toBe('');

    view.destroy();
  });
});
