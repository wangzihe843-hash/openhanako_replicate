import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChatRoute } from '../server/routes/chat.ts';
import { authenticateDeviceCredential, createDeviceCredential, revokeDevice, revokeDeviceCredential } from '../core/device-registry.ts';

describe('remote websocket lifecycle and studio events', () => {
  let home: string;
  let factory: any;
  let publish: any;
  let engine: any;
  const sockets: any[] = [];
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'server-ws-'));
    engine = { hanakoHome: home, getRuntimeContext: () => ({ studioId: 'studio-a' }), abortAllStreaming: vi.fn() };
    createChatRoute(engine, { subscribe: (fn) => { publish = fn; }, eventBus: { emit: vi.fn() } }, {
      upgradeWebSocket: (fn) => { factory = fn; return () => new Response(null); },
    });
  });
  afterEach(() => {
    for (const { handlers, ws } of sockets.splice(0)) handlers.onClose({}, ws);
    vi.useRealTimers();
    fs.rmSync(home, { recursive: true, force: true });
  });
  function issue(options = {}) {
    const issued = createDeviceCredential(home, {
      serverNodeId: 'node', userId: 'user', studioIds: ['studio-a'], scopes: ['chat'], ...options,
    });
    return { ...issued, principal: authenticateDeviceCredential(home, issued.secret) };
  }
  function connect(principal) {
    const handlers = factory({ req: { method: 'GET', url: 'http://localhost/ws' }, get: () => principal });
    const ws = { readyState: 1, send: vi.fn(), close: vi.fn() };
    sockets.push({ handlers, ws });
    handlers.onOpen({}, ws);
    return { handlers, ws };
  }
  it.each(['device', 'credential'])('immediately closes a revoked %s and excludes it from later broadcasts', (kind) => {
    const revoked = issue();
    const other = connect(issue().principal);
    const { ws, handlers } = connect(revoked.principal);
    if (kind === 'device') revokeDevice(home, revoked.device.deviceId);
    else revokeDeviceCredential(home, revoked.credential.credentialId);
    expect(ws.close).toHaveBeenCalledWith(1008, expect.any(String));
    handlers.onMessage({ data: JSON.stringify({ type: 'context_usage', sessionPath: '/missing' }) }, ws);
    publish({ type: 'notification', title: 'new event' });
    expect(ws.send).not.toHaveBeenCalled();
    expect(other.ws.send).toHaveBeenCalled();
    expect(other.ws.close).not.toHaveBeenCalled();
  });
  it('rejects a captured principal when revoked before websocket open', () => {
    const revoked = issue();
    revokeDeviceCredential(home, revoked.credential.credentialId);
    const { ws } = connect(revoked.principal);
    expect(ws.close).toHaveBeenCalledWith(1008, expect.any(String));
    publish({ type: 'notification', title: 'new event' });
    expect(ws.send).not.toHaveBeenCalled();
  });
  it('removes the revocation listener and expiry timer on socket close', () => {
    vi.useFakeTimers();
    const issued = issue({ expiresAt: new Date(Date.now() + 1000).toISOString() });
    const { handlers, ws } = connect(issued.principal);
    handlers.onClose({}, ws);
    revokeDevice(home, issued.device.deviceId);
    vi.advanceTimersByTime(1001);
    expect(ws.close).not.toHaveBeenCalled();
    handlers.onMessage({ data: JSON.stringify({ type: 'context_usage' }) }, ws);
    expect(ws.send).not.toHaveBeenCalled();
  });
  it('closes an already open socket when its credential expires', () => {
    vi.useFakeTimers();
    const { ws } = connect(issue({ expiresAt: new Date(Date.now() + 1000).toISOString() }).principal);
    expect(ws.close).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1001);
    expect(ws.close).toHaveBeenCalledWith(1008, expect.any(String));
  });
  it.each(['channel_new_message', 'channel_created', 'dm_new_message', 'conversation_agent_activity'])(
    'delivers %s only to a reader in the publishing studio', (type) => {
      const allowed = connect(issue().principal).ws;
      const otherStudio = connect(issue({ studioIds: ['studio-b'] }).principal).ws;
      const noRead = connect(issue({ scopes: ['resources.read'] }).principal).ws;
      publish({ type, channelName: 'general', from: 'a', to: 'b', activity: { status: 'running' } });
      expect(allowed.send).toHaveBeenCalledOnce();
      expect(JSON.parse(allowed.send.mock.calls[0][0])).toMatchObject({ type, studioId: 'studio-a' });
      expect(otherStudio.send).not.toHaveBeenCalled();
      expect(noRead.send).not.toHaveBeenCalled();
      allowed.send.mockClear();
      publish({ type, studioId: 'studio-b', channelName: 'other', activity: { status: 'running' } });
      expect(allowed.send).not.toHaveBeenCalled();
      expect(otherStudio.send).toHaveBeenCalledOnce();
    },
  );
});
