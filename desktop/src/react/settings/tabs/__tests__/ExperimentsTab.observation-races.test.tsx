// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ExperimentsTab } from '../ExperimentsTab';
import { useSettingsStore } from '../../store';
import { hanaFetch } from '../../api';
import { createRemoteResource } from '../../resource-state';
vi.mock('../../api', () => ({ hanaFetch: vi.fn() }));
vi.mock('../ComputerUseSection', () => ({ ComputerUseSection: () => null }));
const experiment = { id: 'memory.cache_snapshot_reflection', titleKey: 'snapshot', descriptionKey: 'description', owner: 'memory', value: 'shadow', status: 'alpha', risk: 'low', restartPolicy: 'immediate' };
const observation = (text: string) => ({ observation: { summaryPreview: text } });
const json = (body: unknown) => new Response(JSON.stringify(body));
function deferred() { let resolve!: (value: Response) => void; let reject!: (error: Error) => void; const promise = new Promise<Response>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
beforeEach(() => {
  window.t = ((key: string) => key) as typeof window.t;
  useSettingsStore.setState({ platformName: 'linux', settingsSnapshot: createRemoteResource(), agents: [{ id: 'a', name: 'A', isPrimary: true, yuan: 'hanako', hasAvatar: false }], serverPort: 3210, serverToken: 'a', activeServerConnection: null, activeServerConnectionId: null, serverConnections: {}, showToast: vi.fn() });
  vi.mocked(hanaFetch).mockReset();
  vi.mocked(hanaFetch).mockImplementation(async (url, init) => {
    if (url === '/api/experiments') return json({ experiments: [experiment] });
    if (init?.method === 'PATCH') return json({ value: JSON.parse(String(init.body)).value });
    if (init?.method === 'DELETE') return json({ ok: true });
    return json(observation('visible observation'));
  });
});
afterEach(cleanup);
it('S1 keeps a cleared observation cleared when an older GET acknowledges later', async () => {
  const old = deferred();
  const original = vi.mocked(hanaFetch).getMockImplementation()!;
  let reads = 0;
  vi.mocked(hanaFetch).mockImplementation((url, init) => url.includes('/observation') && !init?.method && ++reads === 2 ? old.promise : original(url, init));
  render(<ExperimentsTab />);
  await screen.findByText('visible observation');
  fireEvent.click(screen.getByRole('switch', { name: 'settings.experiments.cacheSnapshot.observeOnly' }));
  await waitFor(() => expect(screen.getByRole('switch', { name: 'settings.experiments.cacheSnapshot.observeOnly' })).toBeEnabled());
  fireEvent.click(screen.getByRole('switch', { name: 'settings.experiments.cacheSnapshot.observeOnly' }));
  await waitFor(() => expect(reads).toBe(2));
  fireEvent.click(screen.getByText('settings.experiments.cacheSnapshot.clearObservation'));
  await waitFor(() => expect(screen.queryByText('visible observation')).not.toBeInTheDocument());
  await act(async () => { old.resolve(json(observation('stale observation'))); });
  expect(screen.queryByText('stale observation')).not.toBeInTheDocument();
});
it('S1 ignores an old primary agent response after switching A to B', async () => {
  const old = deferred();
  const original = vi.mocked(hanaFetch).getMockImplementation()!;
  vi.mocked(hanaFetch).mockImplementation((url, init) => url.endsWith('agentId=a') ? old.promise : original(url, init));
  render(<ExperimentsTab />);
  await waitFor(() => expect(vi.mocked(hanaFetch).mock.calls.some(([url]) => url.includes('agentId=a'))).toBe(true));
  act(() => useSettingsStore.setState({ agents: [{ id: 'b', name: 'B', isPrimary: true, yuan: 'hanako', hasAvatar: false }] }));
  await screen.findByText('visible observation');
  await act(async () => { old.resolve(json(observation('old agent'))); });
  expect(screen.queryByText('old agent')).not.toBeInTheDocument();
});

it('S1 keeps a failed clear recoverable and exposes the failure without discarding the visible observation', async () => {
  const deletion = deferred();
  const original = vi.mocked(hanaFetch).getMockImplementation()!;
  vi.mocked(hanaFetch).mockImplementation((url, options) => options?.method === 'DELETE' ? deletion.promise : original(url, options));
  render(<ExperimentsTab />);
  await screen.findByText('visible observation');
  fireEvent.click(screen.getByText('settings.experiments.cacheSnapshot.clearObservation'));
  expect(screen.getByText('settings.experiments.cacheSnapshot.clearObservation')).toBeDisabled();
  await act(async () => { deletion.reject(new Error('cannot clear')); });
  expect(screen.getByText('visible observation')).toBeInTheDocument();
  expect(screen.getByText('settings.experiments.cacheSnapshot.clearObservation')).toBeEnabled();
  expect(useSettingsStore.getState().showToast).toHaveBeenCalledWith('cannot clear', 'error');
});
it('S1 ignores a late clear failure across connection A to B to A and binds the DELETE to original A', async () => {
  const deletion = deferred();
  const original = vi.mocked(hanaFetch).getMockImplementation()!;
  vi.mocked(hanaFetch).mockImplementation((url, options) => options?.method === 'DELETE' ? deletion.promise : original(url, options));
  render(<ExperimentsTab />);
  await screen.findByText('visible observation');
  fireEvent.click(screen.getByText('settings.experiments.cacheSnapshot.clearObservation'));
  const options = vi.mocked(hanaFetch).mock.calls.find(([, init]) => init?.method === 'DELETE')?.[1];
  expect(options?.connection?.baseUrl).toContain(':3210');
  act(() => useSettingsStore.setState({ serverPort: 4321 }));
  await screen.findByText('visible observation');
  act(() => useSettingsStore.setState({ serverPort: 3210 }));
  await screen.findByText('visible observation');
  expect(options?.signal?.aborted).toBe(true);
  await act(async () => { deletion.reject(new Error('late old clear failure')); });
  expect(screen.getByText('visible observation')).toBeInTheDocument();
  expect(useSettingsStore.getState().showToast).not.toHaveBeenCalled();
});
it('S1 aborts a pending read on close and prevents its late result after reopening', async () => {
  const old = deferred();
  const original = vi.mocked(hanaFetch).getMockImplementation()!;
  let reads = 0;
  vi.mocked(hanaFetch).mockImplementation((url, options) => url.includes('/observation') && ++reads === 1 ? old.promise : original(url, options));
  const first = render(<ExperimentsTab />);
  await waitFor(() => expect(reads).toBe(1));
  const options = vi.mocked(hanaFetch).mock.calls.find(([url]) => url.includes('/observation'))?.[1];
  first.unmount();
  expect(options?.signal?.aborted).toBe(true);
  render(<ExperimentsTab />);
  await screen.findByText('visible observation');
  await act(async () => { old.resolve(json(observation('closed old read'))); });
  expect(screen.queryByText('closed old read')).not.toBeInTheDocument();
});
