// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { StrictMode, type ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WechatQrcodeOverlay } from '../WechatQrcodeOverlay';

const mock = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../../api', () => ({ hanaFetch: mock.fetch }));
vi.mock('../../helpers', () => ({ t: (key: string) => key }));
vi.mock('../../../ui', () => ({ Overlay: ({ open, children }: { open: boolean; children: ReactNode }) => open ? <div>{children}</div> : null }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { resolve, promise };
}
const response = (data: unknown) => ({ json: async () => data });
const qr = (id: string) => ({ ok: true, qrcodeId: id, qrcodeUrl: `https://example.invalid/${id}` });
const flush = () => act(async () => {});
const open = (agentId: string) => act(async () => {
  window.dispatchEvent(new CustomEvent('hana-show-wechat-qrcode', { detail: { agentId } }));
});
const writes = () => mock.fetch.mock.calls.filter(([url]) => String(url).startsWith('/api/bridge/config'));

beforeEach(() => {
  vi.useFakeTimers();
  mock.fetch.mockReset();
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

it('cannot save an old QR confirmation to the newly opened agent, including a late JSON body', async () => {
  const oldBody = deferred<unknown>();
  let generation = 0;
  mock.fetch.mockImplementation(async (url: string, options?: RequestInit) => {
    if (url.endsWith('/qrcode')) return response(qr(`qr-${++generation}`));
    if (url.endsWith('/qrcode-status')) {
      const id = JSON.parse(String(options?.body)).qrcodeId;
      return { json: () => id === 'qr-1' ? oldBody.promise : new Promise(() => {}) };
    }
    return response({ ok: true });
  });
  render(<WechatQrcodeOverlay />);
  await open('agent-a');
  fireEvent.click(screen.getByRole('button', { name: 'close' }));
  await open('agent-b');
  await act(async () => oldBody.resolve({ status: 'confirmed', botToken: 'test-old-token', userId: 'test-user' }));
  expect(writes()).toHaveLength(0);
  expect(screen.getByRole('img')).toHaveAttribute('src', 'https://example.invalid/qr-2');
});

it('ignores an old QR fetch after another agent opens the overlay', async () => {
  const old = deferred<ReturnType<typeof response>>();
  let calls = 0;
  mock.fetch.mockImplementation((url: string) => {
    if (url.endsWith('/qrcode')) return ++calls === 1 ? old.promise : Promise.resolve(response(qr('new')));
    return new Promise(() => {});
  });
  render(<WechatQrcodeOverlay />);
  await open('agent-a');
  await open('agent-b');
  await act(async () => old.resolve(response(qr('old'))));
  expect(screen.getByRole('img')).toHaveAttribute('src', 'https://example.invalid/new');
});

it('keeps the intended agent for successful saves and cancels an old automatic close on reopen', async () => {
  let qrs = 0;
  mock.fetch.mockImplementation(async (url: string) => {
    if (url.endsWith('/qrcode')) return response(qr(`qr-${++qrs}`));
    if (url.endsWith('/qrcode-status')) return qrs === 1 ? response({ status: 'confirmed', botToken: 'test-token', userId: 'test-user' }) : new Promise(() => {});
    return response({ ok: true });
  });
  render(<WechatQrcodeOverlay />);
  await open('agent-a');
  expect(writes()).toHaveLength(1);
  expect(writes()[0][0]).toBe('/api/bridge/config?agentId=agent-a');
  expect(screen.getByText('settings.bridge.wechatLoginSuccess')).toBeInTheDocument();
  await open('agent-b');
  await act(async () => vi.advanceTimersByTimeAsync(1500));
  expect(screen.getByRole('img')).toHaveAttribute('src', 'https://example.invalid/qr-2');
});

it('shows a save failure instead of claiming the login was saved', async () => {
  mock.fetch.mockImplementation(async (url: string) => {
    if (url.endsWith('/qrcode')) return response(qr('qr'));
    if (url.endsWith('/qrcode-status')) return response({ status: 'confirmed', botToken: 'test-token' });
    throw new Error('Configuration save failed');
  });
  render(<WechatQrcodeOverlay />);
  await open('agent-a');
  expect(screen.getByText('Configuration save failed')).toBeInTheDocument();
  expect(screen.queryByText('settings.bridge.wechatLoginSuccess')).not.toBeInTheDocument();
});

it('refreshes expired QR codes up to the limit and does not leave retry timers on unmount', async () => {
  let qrs = 0;
  mock.fetch.mockImplementation(async (url: string) => response(url.endsWith('/qrcode') ? qr(`qr-${++qrs}`) : { status: 'expired' }));
  const view = render(<StrictMode><WechatQrcodeOverlay /></StrictMode>);
  await open('agent-a');
  await flush();
  expect(qrs).toBe(3);
  expect(screen.getByText('settings.bridge.wechatExpired')).toBeInTheDocument();
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it('does not continue an old save with owner updates or close a newer flow', async () => {
  const saved = deferred<ReturnType<typeof response>>();
  let qrs = 0;
  mock.fetch.mockImplementation(async (url: string) => {
    if (url.endsWith('/qrcode')) return response(qr(`qr-${++qrs}`));
    if (url.endsWith('/qrcode-status')) return qrs === 1 ? response({ status: 'confirmed', botToken: 'test-token', userId: 'test-user' }) : new Promise(() => {});
    if (url.startsWith('/api/bridge/config')) return saved.promise;
    return response({ ok: true });
  });
  render(<WechatQrcodeOverlay />);
  await open('agent-a');
  expect(writes()).toHaveLength(1);
  await open('agent-b');
  await act(async () => saved.resolve(response({ ok: true })));
  expect(mock.fetch.mock.calls.some(([url]) => String(url).startsWith('/api/bridge/owner'))).toBe(false);
  await act(async () => vi.advanceTimersByTimeAsync(1500));
  expect(screen.getByRole('img')).toHaveAttribute('src', 'https://example.invalid/qr-2');
});

it('cancels a queued network retry when the overlay closes', async () => {
  mock.fetch.mockImplementation(async (url: string) => {
    if (url.endsWith('/qrcode')) return response(qr('qr'));
    throw new Error('temporary network failure');
  });
  render(<WechatQrcodeOverlay />);
  await open('agent-a');
  expect(vi.getTimerCount()).toBe(1);
  const calls = mock.fetch.mock.calls.length;
  fireEvent.click(screen.getByRole('button', { name: 'close' }));
  await act(async () => vi.advanceTimersByTimeAsync(1500));
  expect(vi.getTimerCount()).toBe(0);
  expect(mock.fetch).toHaveBeenCalledTimes(calls);
});
