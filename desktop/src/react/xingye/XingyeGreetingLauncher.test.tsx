/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../stores';
import { XingyeGreetingLauncher } from './XingyeGreetingLauncher';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), load: vi.fn(), switch: vi.fn() }));
vi.mock('../hooks/use-hana-fetch', () => ({ hanaFetch: mocks.fetch }));
vi.mock('../stores/session-actions', () => ({ loadSessions: mocks.load, switchSession: mocks.switch }));
const profile = { agentId: 'a', displayName: '甲', firstMessage: '{{char}}向{{user}}问好', alternateGreetings: ['另一开场'], updatedAt: 'now' };
function reply(agentId = 'a') { return new Response(JSON.stringify({ path: `/agents/${agentId}/sessions/new.jsonl`, sessionId: 'new', agentId })); }

beforeEach(() => {
  vi.clearAllMocks();
  useStore.setState({ serverPort: '1234', serverToken: 'test', activeServerConnection: null, activeServerConnectionId: null,
    serverConnections: {}, userName: '乙', currentSessionPath: '/old', currentSessionId: 'old', selectedAgentId: null });
  mocks.fetch.mockResolvedValue(reply());
  mocks.load.mockResolvedValue(undefined);
  mocks.switch.mockImplementation(async path => { useStore.setState({ currentSessionPath: path, currentSessionId: 'new' }); });
});
afterEach(cleanup);

describe('explicit greeting launcher', () => {
  it('previews and chooses a saved alternative, creates a new session and leaves old history untouched', async () => {
    const onCreated = vi.fn();
    render(<XingyeGreetingLauncher agentId="a" profile={profile} onCreated={onCreated} />);
    expect(screen.getByText('甲向乙问好')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('选择开场白'), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: '用此开场新建聊天' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledOnce());
    expect(mocks.fetch).toHaveBeenCalledWith('/api/sessions/new-detached', expect.objectContaining({
      body: expect.stringContaining('"xingyeGreetingIndex":1'), connection: expect.any(Object), signal: expect.any(AbortSignal),
    }));
    expect(JSON.parse(mocks.fetch.mock.calls[0][1].body)).toMatchObject({ agentId: 'a', xingyeGreetingExpectedText: '另一开场' });
    expect(mocks.switch).toHaveBeenCalledWith('/agents/a/sessions/new.jsonl');
  });

  it('supports an empty opening, reports unavailable connections and does not activate failed requests', async () => {
    render(<XingyeGreetingLauncher agentId="a" profile={{ ...profile, firstMessage: '', alternateGreetings: [] }} />);
    mocks.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: '创建失败' }), { status: 500 }));
    fireEvent.click(screen.getByRole('button', { name: '新建空白聊天' }));
    await screen.findByText('创建失败');
    expect(JSON.parse(mocks.fetch.mock.calls[0][1].body)).toMatchObject({ xingyeGreetingIndex: -1, xingyeGreetingExpectedText: '' });
    expect(mocks.switch).not.toHaveBeenCalled();
    act(() => useStore.setState({ serverPort: null }));
    fireEvent.click(screen.getByRole('button', { name: '新建空白聊天' }));
    expect(await screen.findByText('尚未连接服务器，请连接后重试。')).toBeInTheDocument();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it.each(['agent', 'server', 'session'])('ignores a late creation response after the %s changes', async change => {
    let resolve: (response: Response) => void = () => {};
    mocks.fetch.mockReturnValue(new Promise<Response>(done => { resolve = done; }));
    const view = render(<XingyeGreetingLauncher agentId="a" profile={profile} />);
    fireEvent.click(screen.getByRole('button', { name: '用此开场新建聊天' }));
    if (change === 'agent') view.rerender(<XingyeGreetingLauncher agentId="b" profile={{ ...profile, agentId: 'b' }} />);
    if (change === 'server') act(() => useStore.setState({ serverPort: '4321' }));
    if (change === 'session') act(() => useStore.setState({ currentSessionPath: '/other', currentSessionId: 'other' }));
    await act(async () => { resolve(reply()); });
    expect(mocks.load).not.toHaveBeenCalled();
    expect(mocks.switch).not.toHaveBeenCalled();
  });
});
