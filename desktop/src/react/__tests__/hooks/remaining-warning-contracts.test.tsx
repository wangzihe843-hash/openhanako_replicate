// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../stores';
import { useI18n } from '../../hooks/use-i18n';
import { usePanel } from '../../hooks/use-panel';
import { usePluginIframe } from '../../hooks/use-plugin-iframe';
import { usePhoneStorageSnapshot } from '../../xingye/use-phone-storage-snapshot';
import { XINGYE_PHONE_CONTACTS_STORAGE_KEY } from '../../xingye/xingye-phone-store';
import { waitForSocketOpen } from '../../quick-chat/wait-for-socket';

const persistence = vi.hoisted(() => new Map<string, string>());
vi.mock('../../xingye/xingye-persistence', () => ({
  getXingyePersistenceStorage: () => ({
    getItem: (key: string) => persistence.get(key) ?? null,
    setItem: (key: string, value: string) => { persistence.set(key, value); },
  }),
}));

const originalTranslate = window.t;
beforeEach(() => {
  persistence.clear();
  useStore.setState({ activePanel: null, locale: 'en' });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.t = originalTranslate;
});

describe('remaining warning dependency contracts', () => {
  it('keeps fallback translation stable and invalidates memo consumers on locale change', () => {
    Reflect.deleteProperty(window, 't');
    const { result, rerender } = renderHook(() => useI18n());
    const fallback = result.current.t;
    rerender();
    expect(result.current.t).toBe(fallback);
    expect(fallback('example')).toBe('example');
    window.t = () => useStore.getState().locale === 'en' ? 'English' : '中文';
    rerender();
    const english = result.current.t;
    expect(english('example')).toBe('English');
    act(() => useStore.setState({ locale: 'zh-CN' }));
    expect(result.current.t).not.toBe(english);
    expect(result.current.t('example')).toBe('中文');
  });

  it('loads panels only on open, explicit ownership change, or changed stable loader', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { result, rerender } = renderHook(({ loader, owner }) => usePanel('activity', loader, owner), {
      initialProps: { loader: first, owner: 'agent-a' },
    });
    expect(first).not.toHaveBeenCalled();
    act(() => useStore.setState({ activePanel: 'activity' }));
    expect(first).toHaveBeenCalledTimes(1);
    rerender({ loader: first, owner: 'agent-a' });
    expect(first).toHaveBeenCalledTimes(1);
    rerender({ loader: first, owner: 'agent-b' });
    expect(first).toHaveBeenCalledTimes(2);
    rerender({ loader: second, owner: 'agent-b' });
    expect(second).toHaveBeenCalledTimes(1);
    act(() => result.current.close());
    rerender({ loader: first, owner: 'agent-c' });
    expect(first).toHaveBeenCalledTimes(2);
    act(() => useStore.setState({ activePanel: 'activity' }));
    expect(first).toHaveBeenCalledTimes(3);
  });

  it('reads immutable phone inputs and refreshes on phone and persistence events', () => {
    persistence.set(XINGYE_PHONE_CONTACTS_STORAGE_KEY, 'old');
    const { result, rerender } = renderHook(() => usePhoneStorageSnapshot());
    const old = result.current.storage;
    rerender();
    expect(result.current.storage).toBe(old);
    persistence.set(XINGYE_PHONE_CONTACTS_STORAGE_KEY, 'new');
    act(() => window.dispatchEvent(new Event('xingye-phone-changed')));
    expect(result.current.storage.getItem(XINGYE_PHONE_CONTACTS_STORAGE_KEY)).toBe('new');
    expect(old.getItem(XINGYE_PHONE_CONTACTS_STORAGE_KEY)).toBe('old');
    const beforeRevision = result.current.storage;
    act(() => window.dispatchEvent(new Event('xingye-persistence-changed')));
    expect(result.current.storage).not.toBe(beforeRevision);
    expect(result.current.version).toBe(2);
    expect(() => result.current.storage.setItem()).toThrow('read-only');
  });

  it('keeps iframe handshake state for equal size values and retries with the latest dimensions', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ width, height }) => usePluginIframe('https://plugin.test/page', {
      initialSize: { width, height },
    }), { initialProps: { width: 300, height: 200 } });
    const retry = result.current.retry;
    act(() => vi.advanceTimersByTime(5000));
    expect(result.current.status).toBe('error');
    rerender({ width: 300, height: 200 });
    expect(result.current.status).toBe('error');
    expect(result.current.retry).toBe(retry);
    rerender({ width: 400, height: 250 });
    expect(result.current.status).toBe('loading');
    expect(result.current.size).toEqual({ width: 400, height: 250 });
    act(() => vi.advanceTimersByTime(5000));
    act(() => result.current.retry());
    expect(result.current.status).toBe('loading');
    expect(result.current.size).toEqual({ width: 400, height: 250 });
  });
});

describe('socket timer initialization and cleanup', () => {
  function socket(readyState: number) {
    return Object.assign(new EventTarget(), { readyState }) as WebSocket;
  }
  it('handles aborted, already-open, and already-closed sockets without allocating a timer', async () => {
    vi.useFakeTimers();
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(waitForSocketOpen(socket(WebSocket.CONNECTING), cancelled.signal)).rejects.toThrow('Send cancelled');
    await expect(waitForSocketOpen(socket(WebSocket.OPEN), new AbortController().signal)).resolves.toBeUndefined();
    await expect(waitForSocketOpen(socket(WebSocket.CLOSED), new AbortController().signal)).rejects.toThrow('connection failed');
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['open', 'abort', 'timeout'])('releases timer and listeners after %s', async end => {
    vi.useFakeTimers();
    const ws = socket(WebSocket.CONNECTING);
    const controller = new AbortController();
    const remove = vi.spyOn(ws, 'removeEventListener');
    const pending = waitForSocketOpen(ws, controller.signal, 50);
    const observed = pending.then(() => 'open', (error: Error) => error.message);
    if (end === 'open') ws.dispatchEvent(new Event('open'));
    else if (end === 'abort') controller.abort();
    else vi.advanceTimersByTime(50);
    expect(await observed).toBe(end === 'open' ? 'open' : end === 'abort' ? 'Send cancelled' : 'WebSocket connection timed out');
    expect(remove).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });
});
