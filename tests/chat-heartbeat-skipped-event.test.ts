import { describe, expect, it, vi } from 'vitest';
import { createChatRoute } from '../server/routes/chat.ts';
import { createWsClientRecord, wsClientCanReceiveEvent } from '../server/ws-scope.ts';

describe('heartbeat skipped WebSocket delivery', () => {
  it('forwards the actual hub subscription event to a local socket without a success activity', () => {
    type Socket = { readyState: number; send: ReturnType<typeof vi.fn> };
    type Handlers = { onOpen: (event: object, ws: Socket) => void; onClose: (event: object, ws: Socket) => void };
    let factory!: (context: object) => Handlers;
    let subscriber!: (event: Record<string, unknown>, path: string | null) => void;
    const hub = { subscribe: vi.fn((fn: typeof subscriber) => { subscriber = fn; }), send: vi.fn(), eventBus: { emit: vi.fn() } };
    const engine = { agentName: 'Hana', abortAllStreaming: vi.fn(), getSessionByPath: vi.fn(), isSessionStreaming: () => false, isSessionSwitching: () => false, steerSession: () => false, slashDispatcher: null };
    createChatRoute(engine, hub, { upgradeWebSocket: (fn: typeof factory) => { factory = fn; return () => new Response(null); } });
    const handlers = factory({});
    const ws = { readyState: 1, send: vi.fn() };
    handlers.onOpen({}, ws);
    try {
      ws.send.mockClear();
      const message = { type: 'heartbeat_skipped', agentId: 'agent-a', reason: 'quiet-hours' };
      subscriber(message, null);
      expect(ws.send.mock.calls.map(([raw]) => JSON.parse(String(raw)))).toEqual([message]);
      // Preserve the existing activity boundary: do not turn this into a global broadcast.
      expect(wsClientCanReceiveEvent(createWsClientRecord(), message)).toBe(false);
    } finally { handlers.onClose({}, ws); }
  });
});
