// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QuickChatApp } from '../QuickChatApp';
import { useStore } from '../../stores';

const { translate } = vi.hoisted(() => ({ translate: (key: string) => key }));
vi.mock('../../hooks/use-i18n', () => ({ useI18n: () => ({ t: translate }) }));
vi.mock('../../stores/agent-actions', () => ({ applyAgentIdentity: vi.fn(), loadAvatars: vi.fn() }));
vi.mock('../../stores/session-actions', () => ({ loadMessages: vi.fn() }));
vi.mock('../../services/ws-message-handler', () => ({ handleServerMessage: vi.fn() }));
vi.mock('../../components/input/SendButton', () => ({ SendButton: (props: any) => <button disabled={props.disabled} onClick={props.onSend}>Send</button> }));
vi.mock('../../components/input/PlanModeButton', () => ({ PlanModeButton: () => null }));
vi.mock('../../components/input/AttachedFilesBar', () => ({ AttachedFilesBar: ({ files }: any) => <span>{files.map((file: any) => file.name).join(',')}</span> }));
vi.mock('../../components/chat/ChatTranscript', () => ({ ChatTranscript: () => null }));

class Socket extends EventTarget {
  static OPEN = 1; static CONNECTING = 0; static CLOSED = 3;
  static instances: Socket[] = [];
  readyState = 0;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  send = vi.fn();
  constructor() { super(); Socket.instances.push(this); }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')); this.onclose?.(); }
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
}

async function startSend() {
  render(<QuickChatApp />);
  await screen.findByLabelText('Hana');
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'keep my draft' } });
  fireEvent.click(screen.getByText('Send'));
  await waitFor(() => expect(Socket.instances).toHaveLength(1));
  return Socket.instances[0];
}

describe('QuickChatApp connection failures', () => {
  beforeEach(() => {
    Socket.instances = [];
    vi.stubGlobal('WebSocket', Socket);
    window.hana = { getServerPort: async () => 3210, getServerToken: async () => 'test', quickChatResize: vi.fn() } as any;
    useStore.setState({ sessions: [], chatSessions: {}, streamingSessions: [], currentSessionPath: null, currentSessionId: null });
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const path = new URL(input).pathname;
      const body = path === '/api/agents' ? { agents: [{ id: 'hana', name: 'Hana', isPrimary: true }] }
        : path === '/api/health' ? { agentId: 'hana', agent: 'Hana' }
        : path === '/api/sessions/new-detached' ? { path: '/quick', sessionId: 'quick', agentId: 'hana' }
        : { permissionMode: 'ask' };
      return new Response(JSON.stringify(body));
    }));
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('REVIEW ignores a detached-session response after unmount instead of rebinding the shared store', async () => {
    let release!: (value: Response) => void;
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((input, init) => new URL(String(input)).pathname === '/api/sessions/new-detached'
      ? new Promise<Response>(resolve => { release = resolve; }) : original(input, init));
    const { unmount } = render(<QuickChatApp />);
    await screen.findByLabelText('Hana');
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'cancelled draft' } });
    fireEvent.click(screen.getByText('Send'));
    await waitFor(() => expect(release).toBeTypeOf('function'));
    unmount();
    useStore.setState({ currentSessionPath: '/new-owner', currentSessionId: 'new-owner' });
    await act(async () => { release(new Response(JSON.stringify({ path: '/late-old', sessionId: 'late-old', agentId: 'hana' }))); });
    expect(useStore.getState().currentSessionPath).toBe('/new-owner');
    expect(useStore.getState().sessions.some(item => item.path === '/late-old')).toBe(false);
    expect(Socket.instances).toHaveLength(0);
  });

  it('REVIEW releases sending after a dispatched prompt disconnects before status', async () => {
    const ws = await startSend();
    await act(async () => { ws.open(); });
    expect(ws.send).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'new draft' } });
    await act(async () => { ws.close(); });
    expect((screen.getByText('Send') as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('new draft');
  });

  it('REVIEW preserves a newly retyped identical draft while sending its earlier revision', async () => {
    const ws = await startSend();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'another draft' } });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'keep my draft' } });
    await act(async () => { ws.open(); });
    expect(ws.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(ws.send.mock.calls[0][0]).text).toBe('keep my draft');
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('keep my draft');
  });

  it('REVIEW retains an attachment added during handshake while removing only sent attachments', async () => {
    const { container } = render(<QuickChatApp />);
    await screen.findByLabelText('Hana');
    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    fireEvent.change(fileInput, { target: { files: [new File(['first'], 'first.png', { type: 'image/png' })] } });
    await screen.findByText('first.png');
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'pictures' } });
    fireEvent.click(screen.getByText('Send'));
    await waitFor(() => expect(Socket.instances).toHaveLength(1));
    fireEvent.change(fileInput, { target: { files: [new File(['second'], 'second.png', { type: 'image/png' })] } });
    await screen.findByText('first.png,second.png');
    await act(async () => { Socket.instances[0].open(); });
    const payload = JSON.parse(Socket.instances[0].send.mock.calls[0][0]);
    expect(payload.displayMessage.attachments.map((item: { name: string }) => item.name)).toEqual(['first.png']);
    expect(await screen.findByText('second.png')).toBeTruthy();
  });

  it.each(['close', 'error'])('F8 retains the draft and permits retry on %s before open', async (event) => {
    const ws = await startSend();
    await act(async () => { if (event === 'close') ws.close(); else ws.dispatchEvent(new Event('error')); });
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('keep my draft');
    expect((screen.getByText('Send') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByText('Send'));
    await waitFor(() => expect(Socket.instances).toHaveLength(2));
    await act(async () => { Socket.instances[1].open(); });
    expect(Socket.instances[1].send).toHaveBeenCalledTimes(1);
    expect(ws.send).not.toHaveBeenCalled();
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('');
  });

  it('F8 times out a stuck connection and never sends on its late open', async () => {
    vi.useFakeTimers();
    render(<QuickChatApp />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'keep my draft' } });
    fireEvent.click(screen.getByText('Send'));
    await act(async () => { await vi.advanceTimersByTimeAsync(30001); });
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('keep my draft');
    expect((screen.getByText('Send') as HTMLButtonElement).disabled).toBe(false);
    Socket.instances[0].open();
    expect(Socket.instances[0].send).not.toHaveBeenCalled();
  });
});
