import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ ticket: vi.fn(), resume: vi.fn(), catchUp: vi.fn(), handle: vi.fn(), state: { streamingSessions: ['/active'], currentSessionPath: null, wsState: 'disconnected' } }));
vi.mock('../../services/ws-message-handler', () => ({ handleServerMessage: mocks.handle, applyStreamingStatus: vi.fn() }));
vi.mock('../../services/stream-resume', () => ({ requestStreamResume: mocks.resume, injectHandlers: vi.fn(), injectWebSocketGetter: vi.fn() }));
vi.mock('../../services/resource-events', () => ({ bindResourceEventForegroundCatchUp: () => () => {}, catchUpResourceEventsAfterReconnect: mocks.catchUp, recordResourceEventCursor: vi.fn(), setResourceEventConnection: vi.fn() }));
vi.mock('../../stores', () => ({ useStore: { getState: () => mocks.state, setState: (patch: object) => Object.assign(mocks.state, patch) } }));
vi.mock('../../utils/ui-helpers', () => ({ setStatus: vi.fn() }));
vi.mock('../../services/server-connection', () => ({ requestConnectionWsTicket: mocks.ticket, resolveServerConnection: () => ({ connectionId: 'remote' }), buildConnectionWsUrl: () => 'ws://mock.invalid', createLocalServerConnection: vi.fn() }));

class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 1;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor() { Socket.instances.push(this); }
  close() { this.onclose?.(); }
  send() {}
}

describe('websocket ticket reconnect', () => {
  beforeEach(() => {
    vi.resetModules(); vi.useFakeTimers(); vi.stubGlobal('WebSocket', Socket);
    Socket.instances = []; mocks.ticket.mockReset(); mocks.resume.mockReset(); mocks.handle.mockReset(); mocks.catchUp.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });
  it('REVIEW ignores resource catch-up callbacks belonging to an old socket generation', async () => {
    const callbacks: Array<(event: any) => void> = [];
    mocks.catchUp.mockImplementation((callback) => { callbacks.push(callback); return Promise.resolve(); });
    mocks.ticket.mockResolvedValue('ticket');
    const { connectWebSocket } = await import('../../services/websocket');
    connectWebSocket(); await vi.advanceTimersByTimeAsync(0); Socket.instances[0].onopen?.();
    connectWebSocket(); await vi.advanceTimersByTimeAsync(0); Socket.instances[1].onopen?.();
    callbacks[0]({ type: 'resource_changed', path: '/old' });
    expect(mocks.handle).not.toHaveBeenCalled();
    callbacks[1]({ type: 'resource_changed', path: '/new' });
    expect(mocks.handle).toHaveBeenCalledWith({ type: 'resource_changed', path: '/new' });
  });

  it('F7 retries repeated ticket failures and resumes streams after recovery', async () => {
    mocks.ticket.mockRejectedValueOnce(new Error('offline')).mockRejectedValueOnce(new Error('still offline')).mockResolvedValue('ticket');
    const { connectWebSocket } = await import('../../services/websocket');
    connectWebSocket();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    expect(mocks.ticket).toHaveBeenCalledTimes(3);
    expect(Socket.instances).toHaveLength(1);
    Socket.instances[0].onopen?.();
    await Promise.resolve();
    expect(mocks.state.wsState).toBe('connected');
    expect(mocks.resume).toHaveBeenCalledWith('/active');
  });
});
