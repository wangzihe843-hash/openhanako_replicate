/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, renderHook } from '@testing-library/react';

// useBoxSelection 用 useStore(selector) + useStore.getState()；mock 成同一份可变 state。
const storeFns = {
  setMessageSelection: vi.fn(),
  addMessagesToSelection: vi.fn(),
  toggleMessageSelection: vi.fn(),
  clearSelection: vi.fn(),
};
const mockState: Record<string, unknown> = {
  ...storeFns,
  selectedIdsBySession: {} as Record<string, string[]>,
};
vi.mock('../../stores', () => {
  const useStore: any = (selector: (s: any) => any) => selector(mockState);
  useStore.getState = () => mockState;
  return { useStore };
});

import { useBoxSelection } from '../../hooks/use-box-selection';

const SESSION = '/s/a.jsonl';

function makeParams() {
  return {
    messageElementsRef: { current: new Map<string, HTMLDivElement>() },
    orderedIds: [] as string[],
    sessionPath: SESSION,
    active: true,
  };
}

function downAt(result: { current: ReturnType<typeof useBoxSelection> }, x: number, y: number) {
  // onPointerDown 期望落点不在任何 [data-message-id] 内部（留白起手）。
  const target = document.createElement('div');
  act(() => {
    result.current.onPointerDown({
      button: 0,
      clientX: x,
      clientY: y,
      shiftKey: false,
      target,
    } as never);
  });
}

describe('useBoxSelection — pointercancel / blur teardown (FIX3)', () => {
  beforeEach(() => {
    Object.values(storeFns).forEach((fn) => fn.mockClear());
    mockState.selectedIdsBySession = {};
    // (pointer: fine) → enabled，启用桌面框选。
    window.matchMedia = vi.fn().mockReturnValue({
      matches: true,
      media: '(pointer: fine)',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }) as never;
    // rAF 置成 no-op：屏蔽拖拽中节流提交，只留 onUp 的同步提交作为「是否落选」的唯一信号。
    vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1 as never);
    vi.spyOn(window, 'cancelAnimationFrame').mockReturnValue(undefined as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('pointercancel mid-drag clears the box and commits NO selection', () => {
    const { result } = renderHook(() => useBoxSelection(makeParams()));

    downAt(result, 10, 10);
    act(() => { fireEvent(window, new PointerEvent('pointermove', { clientX: 200, clientY: 200 })); });
    expect(result.current.box).not.toBeNull(); // 拖动越过阈值后选框出现

    act(() => { fireEvent(window, new PointerEvent('pointercancel')); });

    expect(result.current.box).toBeNull();                 // 选框撤掉（fixed overlay 移除）
    expect(result.current.selectionModeActive).toBe(false); // user-select/cursor 锁解除
    expect(storeFns.setMessageSelection).not.toHaveBeenCalled(); // 半截拖拽不落成选中
  });

  it('window blur mid-drag tears down the drag the same way', () => {
    const { result } = renderHook(() => useBoxSelection(makeParams()));

    downAt(result, 10, 10);
    act(() => { fireEvent(window, new PointerEvent('pointermove', { clientX: 200, clientY: 200 })); });
    expect(result.current.box).not.toBeNull();

    act(() => { fireEvent(window, new Event('blur')); });

    expect(result.current.box).toBeNull();
    expect(storeFns.setMessageSelection).not.toHaveBeenCalled();
  });

  it('after pointercancel a subsequent pointerup is inert (dragRef already cleared)', () => {
    const { result } = renderHook(() => useBoxSelection(makeParams()));

    downAt(result, 10, 10);
    act(() => { fireEvent(window, new PointerEvent('pointermove', { clientX: 200, clientY: 200 })); });
    act(() => { fireEvent(window, new PointerEvent('pointercancel')); });

    storeFns.setMessageSelection.mockClear();
    act(() => { fireEvent(window, new PointerEvent('pointerup', { clientX: 200, clientY: 200 })); });

    expect(storeFns.setMessageSelection).not.toHaveBeenCalled();
    expect(result.current.box).toBeNull();
  });

  it('control: pointerup after a real drag DOES commit a selection (teardown is cancel-specific)', () => {
    const { result } = renderHook(() => useBoxSelection(makeParams()));

    downAt(result, 10, 10);
    act(() => { fireEvent(window, new PointerEvent('pointermove', { clientX: 200, clientY: 200 })); });
    act(() => { fireEvent(window, new PointerEvent('pointerup', { clientX: 200, clientY: 200 })); });

    expect(storeFns.setMessageSelection).toHaveBeenCalledTimes(1); // onUp 同步提交最终选择
    expect(result.current.box).toBeNull();
  });
});
