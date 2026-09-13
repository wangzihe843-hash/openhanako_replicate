// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ProviderModelList } from '../ProviderModelList';
import { useSettingsStore, type ProviderSummary } from '../../../store';
import { hanaFetch } from '../../../api';
vi.mock('../../../api', () => ({ hanaFetch: vi.fn() }));
vi.mock('../../../../hooks/use-config', () => ({ invalidateConfigCache: vi.fn() }));
const summary: ProviderSummary = { type: 'api-key', auth_type: 'api-key', display_name: 'Provider', base_url: 'https://mock.invalid', api: 'openai-completions', api_key: '', models: [], custom_models: [], has_credentials: false, supports_oauth: false, can_delete: false };
const json = (body: unknown) => new Response(JSON.stringify(body));
function deferred() { let resolve!: (value: Response) => void; let reject!: (error: Error) => void; const promise = new Promise<Response>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
beforeEach(() => {
  window.t = ((key: string) => key) as typeof window.t;
  useSettingsStore.setState({ serverPort: 3210, serverToken: 'a', activeServerConnection: null, activeServerConnectionId: null, serverConnections: {}, showToast: vi.fn() });
  vi.mocked(hanaFetch).mockReset();
});
afterEach(cleanup);
it('S2 retains freshly fetched models when the initial cache GET arrives late', async () => {
  const old = deferred();
  vi.mocked(hanaFetch).mockImplementation((url) => url.endsWith('/discovered-models') ? old.promise : Promise.resolve(json({ models: [{ id: 'fresh-model' }] })));
  render(<ProviderModelList providerId="provider-a" summary={summary} onRefresh={vi.fn()} />);
  fireEvent.click(screen.getByTitle('settings.providers.fetchModels'));
  await screen.findByText('fresh-model');
  await act(async () => { old.resolve(json({ models: [{ id: 'stale-model' }] })); });
  expect(screen.getByText('fresh-model')).toBeInTheDocument();
  expect(screen.queryByText('stale-model')).not.toBeInTheDocument();
});
it('S2 ignores an old provider response after A to B to A', async () => {
  const old = deferred();
  vi.mocked(hanaFetch).mockReturnValueOnce(old.promise).mockImplementation(async () => json({ models: [{ id: 'current-model' }] }));
  const view = render(<ProviderModelList providerId="a" summary={summary} onRefresh={vi.fn()} />);
  view.rerender(<ProviderModelList providerId="b" summary={summary} onRefresh={vi.fn()} />);
  view.rerender(<ProviderModelList providerId="a" summary={summary} onRefresh={vi.fn()} />);
  expect(hanaFetch).toHaveBeenCalledTimes(3);
  fireEvent.click(screen.getByText('settings.api.addModel'));
  await screen.findByText('current-model');
  await act(async () => { old.resolve(json({ models: [{ id: 'old-a' }] })); });
  expect(screen.getByText('current-model')).toBeInTheDocument();
  expect(screen.queryByText('old-a')).not.toBeInTheDocument();
});

it('S2 keeps the newest manual result and ignores an older manual failure', async () => {
  const old = deferred();
  let fetches = 0;
  vi.mocked(hanaFetch).mockImplementation(async (url) => url.endsWith('/discovered-models') ? json({ models: [] })
    : ++fetches === 1 ? old.promise : json({ models: [{ id: 'newest-manual' }] }));
  render(<ProviderModelList providerId="a" summary={summary} onRefresh={vi.fn()} />);
  fireEvent.click(screen.getByTitle('settings.providers.fetchModels'));
  fireEvent.click(screen.getByTitle('settings.providers.fetchModels'));
  await screen.findByText('newest-manual');
  await act(async () => { old.reject(new Error('late failure')); });
  expect(screen.getByText('newest-manual')).toBeInTheDocument();
  expect(screen.queryByText('settings.providers.fetchFailed')).not.toBeInTheDocument();
  expect(fetches).toBe(2);
});
it('S2 binds old requests to their connection and aborts them on a connection switch', async () => {
  const old = deferred();
  vi.mocked(hanaFetch).mockReturnValueOnce(old.promise).mockImplementation(async () => json({ models: [{ id: 'new-server' }] }));
  render(<ProviderModelList providerId="same-id" summary={summary} onRefresh={vi.fn()} />);
  const oldOptions = vi.mocked(hanaFetch).mock.calls[0][1];
  expect(oldOptions?.connection?.baseUrl).toContain(':3210');
  act(() => useSettingsStore.setState({ serverPort: 4321, serverToken: 'b' }));
  await waitFor(() => expect(hanaFetch).toHaveBeenCalledTimes(2));
  expect(oldOptions?.signal?.aborted).toBe(true);
  expect(vi.mocked(hanaFetch).mock.calls[1][1]?.connection?.baseUrl).toContain(':4321');
  fireEvent.click(screen.getByText('settings.api.addModel'));
  await screen.findByText('new-server');
  await act(async () => { old.resolve(json({ models: [{ id: 'old-server' }] })); });
  expect(screen.queryByText('old-server')).not.toBeInTheDocument();
  expect(screen.getByText('new-server')).toBeInTheDocument();
});
it('S2 retires accepted configuration writes on unmount without replaying them or refreshing a new owner', async () => {
  const ack = deferred();
  vi.mocked(hanaFetch).mockImplementation(async (_url, options) => options?.method === 'PUT' ? ack.promise : json({ models: [{ id: 'pick-me' }] }));
  const onRefresh = vi.fn<() => Promise<void>>();
  const view = render(<ProviderModelList providerId="a" summary={summary} onRefresh={onRefresh} />);
  fireEvent.click(screen.getByText('settings.api.addModel'));
  fireEvent.click(await screen.findByText('pick-me'));
  await waitFor(() => expect(vi.mocked(hanaFetch).mock.calls.filter(([, options]) => options?.method === 'PUT')).toHaveLength(1));
  const writeOptions = vi.mocked(hanaFetch).mock.calls.find(([, options]) => options?.method === 'PUT')?.[1];
  view.unmount();
  expect(writeOptions?.signal?.aborted).toBe(true);
  await act(async () => { ack.resolve(json({ ok: true })); });
  expect(onRefresh).not.toHaveBeenCalled();
  expect(vi.mocked(hanaFetch).mock.calls.filter(([, options]) => options?.method === 'PUT')).toHaveLength(1);
});
it('S2 clears hint timers on unmount', async () => {
  vi.useFakeTimers();
  const scheduled = vi.spyOn(globalThis, 'setTimeout');
  const cleared = vi.spyOn(globalThis, 'clearTimeout');
  try {
    vi.mocked(hanaFetch).mockImplementation(async () => json({ models: [{ id: 'model' }] }));
    const view = render(<ProviderModelList providerId="a" summary={summary} onRefresh={vi.fn()} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    fireEvent.click(screen.getByTitle('settings.providers.fetchModels'));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const hintCall = scheduled.mock.calls.findIndex(([, delay]) => delay === 2500);
    expect(hintCall).toBeGreaterThanOrEqual(0);
    const hintTimer = scheduled.mock.results[hintCall].value;
    view.unmount();
    expect(cleared).toHaveBeenCalledWith(hintTimer);
  } finally { scheduled.mockRestore(); cleared.mockRestore(); vi.useRealTimers(); }
});

it('S2 preserves the second StrictMode lifetime when the first request resolves late', async () => {
  const first = deferred();
  vi.mocked(hanaFetch).mockReturnValueOnce(first.promise).mockImplementation(async () => json({ models: [{ id: 'strict-current' }] }));
  render(<StrictMode><ProviderModelList providerId="a" summary={summary} onRefresh={vi.fn()} /></StrictMode>);
  fireEvent.click(screen.getByText('settings.api.addModel'));
  await screen.findByText('strict-current');
  expect(vi.mocked(hanaFetch).mock.calls[0][1]?.signal?.aborted).toBe(true);
  await act(async () => { first.resolve(json({ models: [{ id: 'strict-retired' }] })); });
  expect(screen.queryByText('strict-retired')).not.toBeInTheDocument();
  expect(screen.getByText('strict-current')).toBeInTheDocument();
});
