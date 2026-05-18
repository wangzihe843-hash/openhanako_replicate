/**
 * @vitest-environment jsdom
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SelectionFloatingInput, SELECTION_OPEN_DELAY_MS } from '../../components/floating-input/SelectionFloatingInput';
import { useStore } from '../../stores';

vi.mock('../../hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

describe('SelectionFloatingInput focus behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
    vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id));
    useStore.setState({
      connected: true,
      currentSessionPath: '/tmp/session.jsonl',
      modelSwitching: false,
      quotedSelection: null,
      streamingSessions: [],
    } as never);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    useStore.setState({ quotedSelection: null } as never);
  });

  async function openSelectionFloatingInput() {
    act(() => {
      useStore.getState().setQuotedSelection({
        text: '选中文本',
        sourceTitle: 'doc',
        charCount: 4,
        anchorRect: { left: 300, right: 500, top: 120, bottom: 180, width: 200, height: 60 },
        updatedAt: 1,
      });
      vi.advanceTimersByTime(SELECTION_OPEN_DELAY_MS);
    });
    await act(async () => {
      vi.runOnlyPendingTimers();
    });
    return screen.getByLabelText('input.floatingInput');
  }

  async function finishCloseAnimation() {
    await act(async () => {
      vi.runOnlyPendingTimers();
    });
  }

  it('appears without taking focus away from the document', async () => {
    render(
      <>
        <button type="button">document focus</button>
        <SelectionFloatingInput />
      </>
    );
    const documentFocus = screen.getByRole('button', { name: 'document focus' });
    documentFocus.focus();

    await openSelectionFloatingInput();

    expect(screen.getByLabelText('input.floatingInput').tagName).toBe('TEXTAREA');
    expect(document.activeElement).toBe(documentFocus);
  });

  it('clears the quoted selection and closes when the user scrolls', async () => {
    render(<SelectionFloatingInput />);

    await openSelectionFloatingInput();

    fireEvent.scroll(document);

    expect(useStore.getState().quotedSelection).toBeNull();
    await finishCloseAnimation();
    expect(screen.queryByLabelText('input.floatingInput')).toBeNull();
  });

  it('clears the quoted selection and closes when the window loses focus', async () => {
    render(<SelectionFloatingInput />);

    await openSelectionFloatingInput();

    fireEvent.blur(window);

    expect(useStore.getState().quotedSelection).toBeNull();
    await finishCloseAnimation();
    expect(screen.queryByLabelText('input.floatingInput')).toBeNull();
  });

  it('keeps the floating input open for internal interaction and closes on outside focus', async () => {
    render(
      <>
        <button type="button">outside focus</button>
        <SelectionFloatingInput />
      </>
    );

    const input = await openSelectionFloatingInput();
    fireEvent.pointerDown(input);

    expect(useStore.getState().quotedSelection).not.toBeNull();
    expect(screen.getByLabelText('input.floatingInput')).toBe(input);

    fireEvent.focusIn(screen.getByRole('button', { name: 'outside focus' }));

    expect(useStore.getState().quotedSelection).toBeNull();
    await finishCloseAnimation();
    expect(screen.queryByLabelText('input.floatingInput')).toBeNull();
  });
});
