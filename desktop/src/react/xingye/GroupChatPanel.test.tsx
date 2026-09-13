/** @vitest-environment jsdom */
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../stores';
import type { Agent } from '../types';
import { GroupChatPanel } from './GroupChatPanel';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), trigger: vi.fn() }));
vi.mock('../hooks/use-hana-fetch', () => ({ hanaFetch: mocks.fetch }));
vi.mock('./xingye-group-chat-orchestrator', () => ({ triggerGroupChatReply: mocks.trigger }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const agent = { id: 'agent-a', name: 'Agent A', yuan: 'a', isPrimary: true, hasAvatar: false } as Agent;
const response = (data: unknown) => ({ ok: true, json: async () => data }) as Response;
const detail = (id: string, name: string) => response({ id, name, members: [agent.id], messages: [] });

describe('GroupChatPanel request ownership', () => {
  const requests = new Map<string, Promise<Response>[]>();
  beforeEach(() => {
    requests.clear();
    mocks.trigger.mockReset();
    useStore.setState({ userName: 'user', serverPort: '17333', serverToken: 'original-principal', activeServerConnection: null });
    mocks.fetch.mockReset().mockImplementation((path: string) => {
      if (path === '/api/channels') return Promise.resolve(response({ channels: ['a', 'b'].map((id) => ({ id, name: id, members: [agent.id] })) }));
      return requests.get(path)?.shift() ?? Promise.resolve(detail(path.split('/').at(-1)!, 'default'));
    });
  });
  afterEach(cleanup);

  it('review X11 invalidates details when the connection credential changes', async () => {
    const old = deferred<Response>();
    requests.set('/api/channels/a', [old.promise, Promise.resolve(detail('a', 'New principal'))]);
    render(<GroupChatPanel selectedAgent={agent} />);
    await screen.findByRole('button', { name: /# a/ });
    act(() => useStore.setState({ serverToken: 'another-principal' }));
    await screen.findByRole('heading', { name: '# New principal' });
    await act(async () => old.resolve(detail('a', 'Old principal')));
    expect(screen.queryByRole('heading', { name: '# Old principal' })).not.toBeInTheDocument();
  });

  it('ignores channel A arriving after channel B and triggers only the visible channel', async () => {
    const a = deferred<Response>();
    requests.set('/api/channels/a', [a.promise]);
    requests.set('/api/channels/b', [Promise.resolve(detail('b', 'Detail B'))]);
    render(<GroupChatPanel selectedAgent={agent} />);
    fireEvent.click(await screen.findByRole('button', { name: /# b/ }));
    await screen.findByRole('heading', { name: '# Detail B' });
    await act(async () => a.resolve(detail('a', 'Late A')));
    expect(screen.queryByRole('heading', { name: '# Late A' })).not.toBeInTheDocument();
    mocks.trigger.mockResolvedValue({ status: 'skipped', reason: 'skip' });
    fireEvent.click(screen.getByRole('button', { name: '提醒 TA 看群聊' }));
    await waitFor(() => expect(mocks.trigger).toHaveBeenCalledWith({ agent, channelId: 'b' }));
  });

  it('uses the newest request after an A to B to A round trip', async () => {
    const a1 = deferred<Response>();
    const a2 = deferred<Response>();
    const b = deferred<Response>();
    requests.set('/api/channels/a', [a1.promise, a2.promise]);
    requests.set('/api/channels/b', [b.promise]);
    render(<GroupChatPanel selectedAgent={agent} />);
    fireEvent.click(await screen.findByRole('button', { name: /# b/ }));
    fireEvent.click(screen.getByRole('button', { name: /# a/ }));
    await act(async () => a2.resolve(detail('a', 'Newest A')));
    await screen.findByRole('heading', { name: '# Newest A' });
    await act(async () => { b.resolve(detail('b', 'Late B')); a1.resolve(detail('a', 'Old A')); });
    expect(screen.getByRole('heading', { name: '# Newest A' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '# Old A' })).not.toBeInTheDocument();
  });

  it('does not apply a previous channel trigger result to the new channel', async () => {
    const triggerA = deferred<unknown>();
    mocks.trigger.mockReturnValueOnce(triggerA.promise).mockResolvedValueOnce({ status: 'skipped', reason: 'B result' });
    render(<GroupChatPanel selectedAgent={agent} />);
    fireEvent.click(await screen.findByRole('button', { name: '提醒 TA 看群聊' }));
    fireEvent.click(screen.getByRole('button', { name: /# b/ }));
    fireEvent.click(await screen.findByRole('button', { name: '提醒 TA 看群聊' }));
    await screen.findByText(/B result/);
    await act(async () => triggerA.resolve({ status: 'error', error: 'late A error' }));
    expect(screen.getByText(/B result/)).toBeInTheDocument();
    expect(screen.queryByText(/late A error/)).not.toBeInTheDocument();
  });

  it('can retry a failed detail read without changing selection', async () => {
    requests.set('/api/channels/a', [Promise.resolve({ ok: false } as Response), Promise.resolve(detail('a', 'Recovered A'))]);
    render(<GroupChatPanel selectedAgent={agent} />);
    fireEvent.click(await screen.findByRole('button', { name: '重新读取群聊消息' }));
    expect(await screen.findByRole('heading', { name: '# Recovered A' })).toBeInTheDocument();
  });
});
