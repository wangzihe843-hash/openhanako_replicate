// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useStore } from '../../stores';
import { BridgePanel } from '../../components/BridgePanel';

const mock = vi.hoisted(() => ({ fetch: vi.fn(), loadMessages: vi.fn(), clearMeta: vi.fn() }));
vi.mock('../../hooks/use-hana-fetch', () => ({ hanaFetch: mock.fetch }));
vi.mock('../../stores/session-actions', () => ({ loadMessages: mock.loadMessages }));
vi.mock('../../stores/stream-invalidator', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../stores/stream-invalidator')>(),
  clearSessionStreamMeta: mock.clearMeta,
}));
vi.mock('../../components/chat/ChatTranscript', () => ({ ChatTranscript: () => null }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
const status = { feishu: { configured: true, status: 'connected' }, telegram: { configured: true, status: 'connected' } };
const response = (data: unknown) => ({ json: async () => data });
const sessions = (name: string) => ({ sessions: [{ sessionKey: name, chatId: name, displayName: name, sessionPath: `/sessions/${name}` }] });
const sessionCalls = () => mock.fetch.mock.calls.filter(([url]) => String(url).includes('/api/bridge/sessions?'));
const selectTab = (platform: string) => fireEvent.click(screen.getByRole('button', { name: `settings.bridge.${platform}` }));
const flush = () => act(async () => {});
async function message(text: string, agentId = 'agent-a') {
  await act(async () => {
    useStore.setState({ bridgeLatestMessage: { agentId, text, platform: 'feishu' } } as never);
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  window.t = ((key: string) => key) as typeof window.t;
  localStorage.setItem('hana_bridge_tab', 'feishu');
  useStore.setState({
    activePanel: 'bridge', currentAgentId: 'agent-a', bridgeDotConnected: false,
    agents: [
      { id: 'agent-a', name: 'Agent A', yuan: 'hanako', hasAvatar: false },
      { id: 'agent-b', name: 'Agent B', yuan: 'hanako', hasAvatar: false },
    ],
    bridgeStatusTrigger: 0, bridgeLatestMessage: null,
  } as never);
  mock.fetch.mockImplementation(async (url: string) => response(url.includes('/status') ? status : sessions('contact')));
  mock.loadMessages.mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

it('keeps the new platform contacts, overlay and status when an old JSON body arrives late', async () => {
  const oldBody = deferred<unknown>();
  mock.fetch.mockImplementation(async (url: string) => {
    if (url.includes('/status')) return response(status);
    if (url.includes('platform=feishu')) return { json: () => oldBody.promise };
    return response(sessions('Telegram contact'));
  });
  render(<BridgePanel />);
  await flush();
  selectTab('telegram');
  await flush();
  expect(screen.getByText('Telegram contact')).toBeInTheDocument();
  await act(async () => oldBody.resolve(sessions('Old Feishu contact')));
  expect(screen.queryByText('Old Feishu contact')).not.toBeInTheDocument();
  expect(screen.getByText('Telegram contact')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'settings.bridge.telegram' }).className).toContain('bridgeTabActive');
  expect(document.querySelector('#bridgeOverlay')).toBeNull();
  expect(localStorage.getItem('hana_bridge_tab')).toBe('telegram');
});

it('rejects the first platform request after Feishu -> Telegram -> Feishu', async () => {
  const old = deferred<ReturnType<typeof response>>();
  let feishuRequests = 0;
  mock.fetch.mockImplementation(async (url: string) => {
    if (url.includes('/status')) return response(status);
    if (url.includes('platform=feishu') && feishuRequests++ === 0) return old.promise;
    return response(sessions('Newest contact'));
  });
  render(<BridgePanel />);
  await flush();
  selectTab('telegram');
  selectTab('feishu');
  await flush();
  await act(async () => old.resolve(response(sessions('Obsolete contact'))));
  expect(screen.getByText('Newest contact')).toBeInTheDocument();
  expect(screen.queryByText('Obsolete contact')).not.toBeInTheDocument();
});

it('only accepts the newest refresh within the same context', async () => {
  const old = deferred<ReturnType<typeof response>>();
  render(<BridgePanel />);
  await flush();
  mock.fetch.mockImplementationOnce(async () => response(status)).mockImplementationOnce(() => old.promise);
  await message('first');
  await act(async () => useStore.setState({ currentAgentId: 'agent-b' }));
  await act(async () => old.resolve(response(sessions('Obsolete refresh'))));
  expect(screen.queryByText('Obsolete refresh')).not.toBeInTheDocument();
  expect(screen.getByText('contact')).toBeInTheDocument();
  expect(sessionCalls().every(([url]) => String(url).includes('agentId=agent-a'))).toBe(true);
});

it('rejects old agent responses after independently selecting another bridge agent', async () => {
  const old = deferred<ReturnType<typeof response>>();
  mock.fetch.mockImplementation(async (url: string) => {
    if (url.includes('/status')) return response(status);
    if (url.includes('agentId=agent-a')) return old.promise;
    return response(sessions('Agent B contact'));
  });
  render(<BridgePanel />);
  await flush();
  fireEvent.click(screen.getByRole('button', { name: /Agent A/ }));
  fireEvent.click(screen.getByRole('button', { name: /Agent B/ }));
  await flush();
  await act(async () => old.resolve(response(sessions('Agent A old contact'))));
  expect(screen.getByText('Agent B contact')).toBeInTheDocument();
  expect(screen.queryByText('Agent A old contact')).not.toBeInTheDocument();
  expect(useStore.getState().currentAgentId).toBe('agent-a');
});

it.each(['hide', 'unmount'] as const)('retires pending status and platform requests on %s', async (mode) => {
  const oldStatus = deferred<ReturnType<typeof response>>();
  mock.fetch.mockImplementation(async (url: string) => url.includes('/status') ? oldStatus.promise : response(sessions('Old contact')));
  const view = render(<BridgePanel />);
  await flush();
  if (mode === 'hide') await act(async () => useStore.setState({ activePanel: null }));
  else view.unmount();
  await act(async () => oldStatus.resolve(response(status)));
  expect(useStore.getState().bridgeDotConnected).toBe(false);
  expect(screen.queryByText('Old contact')).not.toBeInTheDocument();
});

it('keeps the newest standalone status when an earlier refresh finishes later', async () => {
  const oldStatus = deferred<ReturnType<typeof response>>();
  render(<BridgePanel />);
  await flush();
  mock.fetch.mockImplementationOnce(() => oldStatus.promise);
  await act(async () => useStore.setState({ bridgeStatusTrigger: 1 }));
  await act(async () => useStore.setState({ bridgeStatusTrigger: 2 }));
  await act(async () => oldStatus.resolve(response({ feishu: { configured: false, status: 'error' } })));
  expect(useStore.getState().bridgeDotConnected).toBe(true);
  expect(document.querySelector('#bridgeOverlay')).toBeNull();
});

it('does not reopen a transcript when its load completes after a platform switch', async () => {
  const old = deferred<void>();
  mock.loadMessages.mockReturnValue(old.promise);
  render(<BridgePanel />);
  await flush();
  fireEvent.click(screen.getByText('contact'));
  selectTab('telegram');
  await act(async () => old.resolve());
  expect(document.querySelector('#bridgeChatHeader')).toBeNull();
});

it('does not clear a newer selection when an older reset finishes', async () => {
  const reset = deferred<ReturnType<typeof response>>();
  render(<BridgePanel />);
  await flush();
  fireEvent.click(screen.getByText('contact'));
  await flush();
  useStore.getState().initSession('/sessions/contact', [], false);
  expect(useStore.getState().chatSessions['/sessions/contact']).toBeDefined();
  mock.fetch.mockImplementation(async (url: string) => {
    if (url.includes('/reset?')) return reset.promise;
    return response(url.includes('/status') ? status : sessions('New contact'));
  });
  fireEvent.click(screen.getByRole('button', { name: 'bridge.resetContext' }));
  selectTab('telegram');
  await flush();
  fireEvent.click(screen.getByText('New contact'));
  await flush();
  await act(async () => reset.resolve(response({})));
  expect(document.querySelector('#bridgeChatHeader')?.textContent).toContain('New contact');
  expect(mock.clearMeta).toHaveBeenCalledWith('/sessions/contact');
  expect(useStore.getState().chatSessions['/sessions/contact']).toBeUndefined();
});

it('coalesces three messages into one leading and one trailing refresh', async () => {
  vi.useFakeTimers();
  render(<BridgePanel />);
  await flush();
  mock.fetch.mockClear();
  await message('one');
  await act(async () => vi.advanceTimersByTimeAsync(200));
  await message('two');
  await act(async () => vi.advanceTimersByTimeAsync(200));
  await message('three');
  expect(sessionCalls()).toHaveLength(1);
  await act(async () => vi.advanceTimersByTimeAsync(499));
  expect(sessionCalls()).toHaveLength(1);
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(sessionCalls()).toHaveLength(2);
  await message('next burst');
  expect(sessionCalls()).toHaveLength(3);
});

it('cancels the old trailing refresh on a platform switch and does not replay the latest message', async () => {
  vi.useFakeTimers();
  render(<BridgePanel />);
  await flush();
  await message('one');
  mock.fetch.mockClear();
  selectTab('telegram');
  await flush();
  expect(sessionCalls()).toHaveLength(1);
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(sessionCalls()).toHaveLength(1);
  expect(String(sessionCalls()[0][0])).toContain('platform=telegram');
});

it('ignores messages for another agent and cancels trailing refresh while hidden', async () => {
  vi.useFakeTimers();
  render(<BridgePanel />);
  await flush();
  mock.fetch.mockClear();
  await message('other agent', 'agent-b');
  expect(sessionCalls()).toHaveLength(0);
  await message('current agent');
  expect(sessionCalls()).toHaveLength(1);
  await act(async () => useStore.setState({ activePanel: null }));
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(sessionCalls()).toHaveLength(1);
  await act(async () => useStore.setState({ activePanel: 'bridge' }));
  expect(sessionCalls()).toHaveLength(2);
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(sessionCalls()).toHaveLength(2);
});
