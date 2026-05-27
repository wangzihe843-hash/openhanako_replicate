import { EditorView, WidgetType, Decoration } from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';
import { EditorState, RangeSetBuilder, StateField, Transaction } from '@codemirror/state';
import {
  findMarkdownCoverRenderRange,
  parseMarkdownCover,
  resolveMarkdownCoverImagePath,
  updateMarkdownCoverLayout,
  type MarkdownCover,
  type MarkdownCoverLayoutPatch,
} from '../utils/markdown-cover';
import { markdownImageContextFacet } from './md-decorations';

function clamp(value: number | undefined, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Number(value)));
}

function resolveCoverImageUrl(cover: MarkdownCover, markdownFilePath?: string, getFileUrl?: (path: string) => string | undefined): string | null {
  const imagePath = resolveMarkdownCoverImagePath(markdownFilePath, cover.image);
  if (!imagePath) return null;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(imagePath)) return imagePath;
  return getFileUrl?.(imagePath) || imagePath;
}

function updateCoverLayout(view: EditorView, patch: MarkdownCoverLayoutPatch): void {
  const source = view.state.doc.toString();
  const nextSource = updateMarkdownCoverLayout(source, patch);
  if (nextSource === source) return;
  view.dispatch({
    changes: { from: 0, to: source.length, insert: nextSource },
    annotations: Transaction.userEvent.of('input'),
  });
}

function parseCssNumber(value: string | undefined, fallback: number): number {
  const parsed = Number.parseFloat(value || "");
  return Number.isFinite(parsed) ? parsed : fallback;
}

interface MarkdownCoverEditorState {
  decorations: DecorationSet;
  hasTopCover: boolean;
}

class MarkdownCoverWidget extends WidgetType {
  constructor(
    readonly cover: MarkdownCover,
    readonly markdownFilePath?: string,
    readonly getFileUrl?: (path: string) => string | undefined,
    readonly isTopCover = false,
  ) {
    super();
  }

  eq(other: MarkdownCoverWidget): boolean {
    return this.cover.image === other.cover.image
      && this.cover.displayWidth === other.cover.displayWidth
      && this.cover.displayHeight === other.cover.displayHeight
      && this.cover.positionX === other.cover.positionX
      && this.cover.positionY === other.cover.positionY
      && this.markdownFilePath === other.markdownFilePath
      && this.isTopCover === other.isTopCover;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'cm-markdown-cover';
    if (this.isTopCover) wrapper.classList.add('cm-markdown-cover-top');
    wrapper.contentEditable = 'false';

    const displayWidth = clamp(this.cover.displayWidth, 40, 100, 100);
    const displayHeight = clamp(this.cover.displayHeight, 160, 720, 320);
    const positionX = clamp(this.cover.positionX, 0, 100, 50);
    const positionY = clamp(this.cover.positionY, 0, 100, 50);

    if (displayWidth >= 100) {
      wrapper.classList.add('cm-markdown-cover-bleed-x');
    } else {
      wrapper.style.width = `${displayWidth}%`;
    }
    wrapper.style.height = `${displayHeight}px`;

    const src = resolveCoverImageUrl(this.cover, this.markdownFilePath, this.getFileUrl);
    if (!src) {
      wrapper.classList.add('cm-markdown-cover-missing');
      wrapper.textContent = 'Cover 图片不可用';
      return wrapper;
    }

    const img = document.createElement('img');
    img.src = src;
    img.alt = '';
    img.draggable = false;
    img.style.objectPosition = `${positionX}% ${positionY}%`;
    wrapper.appendChild(img);

    const resize = document.createElement('div');
    resize.className = 'cm-markdown-cover-resize';
    wrapper.appendChild(resize);

    let drag: null | {
      kind: 'position' | 'height';
      startY: number;
      startHeight: number;
      startPositionY: number;
    } = null;

    const finishDrag = () => {
      if (!drag) return;
      drag = null;
      updateCoverLayout(view, {
        displayWidth,
        displayHeight: parseCssNumber(wrapper.style.height, displayHeight),
        positionX,
        positionY: parseCssNumber(img.style.objectPosition.split(/\s+/)[1], positionY),
      });
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', finishDrag);
      window.removeEventListener('pointercancel', finishDrag);
    };

    const onMove = (event: PointerEvent) => {
      if (!drag) return;
      const dy = event.clientY - drag.startY;
      if (drag.kind === 'height') {
        const nextHeight = clamp(drag.startHeight + dy, 160, 720, displayHeight);
        wrapper.style.height = `${nextHeight}px`;
        return;
      }
      const nextPositionY = clamp(
        drag.startPositionY - ((dy / Math.max(1, drag.startHeight)) * 100),
        0,
        100,
        positionY,
      );
      img.style.objectPosition = `${positionX}% ${nextPositionY}%`;
    };

    const beginDrag = (kind: 'position' | 'height', event: PointerEvent) => {
      event.preventDefault();
      event.stopPropagation();
      drag = {
        kind,
        startY: event.clientY,
        startHeight: parseCssNumber(wrapper.style.height, displayHeight),
        startPositionY: parseCssNumber(img.style.objectPosition.split(/\s+/)[1], positionY),
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', finishDrag);
      window.addEventListener('pointercancel', finishDrag);
    };

    img.addEventListener('pointerdown', (event) => beginDrag('position', event));
    resize.addEventListener('pointerdown', (event) => beginDrag('height', event));

    return wrapper;
  }
}

function buildMarkdownCoverEditorState(state: EditorState): MarkdownCoverEditorState {
  const source = state.doc.toString();
  const cover = parseMarkdownCover(source);
  const range = cover ? findMarkdownCoverRenderRange(source) : null;
  const builder = new RangeSetBuilder<Decoration>();
  if (!cover || !range) {
    return { decorations: builder.finish(), hasTopCover: false };
  }

  const imageContext = state.facet(markdownImageContextFacet);
  const hasTopCover = range.from === 0;
  builder.add(range.from, range.to, Decoration.replace({
    block: true,
    widget: new MarkdownCoverWidget(
      cover,
      imageContext.filePath || undefined,
      imageContext.getFileUrl || undefined,
      hasTopCover,
    ),
  }));

  return { decorations: builder.finish(), hasTopCover };
}

export const markdownCoverField = StateField.define<MarkdownCoverEditorState>({
  create(state) {
    return buildMarkdownCoverEditorState(state);
  },
  update(value, tr) {
    if (tr.docChanged) return buildMarkdownCoverEditorState(tr.state);
    return value;
  },
  provide: field => [
    EditorView.decorations.from(field, value => value.decorations),
    EditorView.editorAttributes.computeN([field], state => (
      state.field(field).hasTopCover ? [{ class: 'cm-markdown-has-top-cover' }] : []
    )),
  ],
});
