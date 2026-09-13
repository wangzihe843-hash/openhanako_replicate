/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerConnection } from '../../services/server-connection';

const state = vi.hoisted(() => ({ activeServerConnection: null as ServerConnection | null }));
vi.mock('../../stores', () => ({ useStore: { getState: () => state, setState: vi.fn() } }));
vi.mock('../../services/ws-message-handler', () => ({ handleServerMessage: vi.fn(), applyStreamingStatus: vi.fn() }));
vi.mock('../../services/stream-resume', () => ({ requestStreamResume: vi.fn(), injectHandlers: vi.fn(), injectWebSocketGetter: vi.fn() }));
vi.mock('../../utils/ui-helpers', () => ({ setStatus: vi.fn() }));
vi.mock('../../services/server-connection', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../services/server-connection')>(),
  requestConnectionWsTicket: () => new Promise<string>(() => {}),
}));


function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function connection(port: number): ServerConnection {
  return {
    connectionId: 'local', kind: 'local', serverId: `server-${port}`, studioId: `studio-${port}`,
    label: 'Test', baseUrl: `http://localhost:${port}`, wsUrl: `ws://localhost:${port}`,
    token: 'synthetic-test-token', authState: 'user', trustState: 'local',
    credentialKind: 'loopback_token', capabilities: ['resources'],
  };
}
const a = connection(19101), b = connection(19102);
const reply = (data: unknown) => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });

describe('resource events connection ownership through hanaFetch', () => {
  let api: typeof import('../../services/resource-events');
  let fetchMock: ReturnType<typeof vi.fn>;
  const releases: Array<() => void> = [];
  const activate = (next: ServerConnection | null) => {
    state.activeServerConnection = next;
    // Also runs against the old implementation to reproduce its real race.
    (api as typeof api & { setResourceEventConnection?: (c: ServerConnection | null) => void }).setResourceEventConnection?.(next);
  };
  beforeEach(async () => {
    vi.resetModules();
    fetchMock = vi.fn(async (url: string) => reply(url.endsWith('/subscribe') ? { subscriptionId: 'same-id' } : {}));
    vi.stubGlobal('fetch', fetchMock);
    api = await import('../../services/resource-events');
    activate(a);
  });
  afterEach(async () => {
    for (const release of releases.splice(0)) release();
    activate(null);
    await new Promise(resolve => setTimeout(resolve, 0));
    vi.unstubAllGlobals();
  });

  it.each([false, true])('ignores obsolete replay after server/epoch change (same server=%s)', async (sameServer) => {
    const oldBody = deferred<unknown>();
    const applied = vi.fn();
    let reads = 0;
    fetchMock.mockImplementation(async () => {
      if (++reads === 1) return { ok: true, json: () => oldBody.promise };
      return reply({ events: [{ type: 'resource.changed', sequence: 2, marker: 'new' }], latestSequence: 2 });
    });
    const old = api.catchUpResourceEventsAfterReconnect(applied);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    activate(sameServer ? { ...a } : b);
    await api.catchUpResourceEventsAfterReconnect(applied);
    oldBody.resolve({ events: [{ type: 'resource.changed', sequence: 9000, marker: 'old' }], latestSequence: 9000 });
    await old;
    await api.catchUpResourceEventsAfterReconnect(applied);
    expect(applied.mock.calls.some(([event]) => event.marker === 'old')).toBe(false);
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe(`${(sameServer ? a : b).baseUrl}/api/resource-io/events?since=2`);
  });

  it('pins late subscribe cleanup to A even when B receives the same subscription id', async () => {
    const oldSubscribe = deferred<unknown>();
    fetchMock.mockImplementation(async (url: string) => {
      if (url === `${a.baseUrl}/api/resource-io/subscribe`) return { ok: true, json: () => oldSubscribe.promise };
      return reply(url.endsWith('/subscribe') ? { subscriptionId: 'same-id' } : {});
    });
    const release = api.retainLocalFileResourceWatch('/tmp/shared.md');
    releases.push(release);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    activate(b);
    const releaseB = api.retainLocalFileResourceWatch('/tmp/shared.md');
    releases.push(releaseB);
    oldSubscribe.resolve({ subscriptionId: 'same-id' });
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(([url, opts]) => url === `${a.baseUrl}/api/resource-io/subscriptions/same-id` && opts.method === 'DELETE')).toBe(true));
    expect(fetchMock.mock.calls.some(([url, opts]) => url.startsWith(b.baseUrl) && opts.method === 'DELETE')).toBe(false);
    release(); // Retired A cleanup cannot touch the new B retain.
    releaseB();
    await vi.waitFor(() => expect(fetchMock.mock.calls.filter(([url, opts]) => url === `${b.baseUrl}/api/resource-io/subscriptions/same-id` && opts.method === 'DELETE')).toHaveLength(1));
  });

  it('does not resubscribe current watches or advance their cursor from an obsolete stale replay', async () => {
    const oldReplay = deferred<unknown>();
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith(`${a.baseUrl}/api/resource-io/events`)) return { ok: true, json: () => oldReplay.promise };
      return reply(url.endsWith('/subscribe') ? { subscriptionId: 'same-id' } : { events: [], latestSequence: 3 });
    });
    releases.push(api.retainLocalFileResourceWatch('/tmp/stale.md'));
    const old = api.catchUpResourceEventsAfterReconnect();
    activate(b);
    releases.push(api.retainLocalFileResourceWatch('/tmp/stale.md'));
    await api.catchUpResourceEventsAfterReconnect();
    await new Promise(resolve => setTimeout(resolve, 0));
    const before = fetchMock.mock.calls.filter(([url]) => url === `${b.baseUrl}/api/resource-io/subscribe`).length;
    oldReplay.resolve({ stale: true, latestSequence: 9000 });
    await old;
    await api.catchUpResourceEventsAfterReconnect();
    expect(fetchMock.mock.calls.filter(([url]) => url === `${b.baseUrl}/api/resource-io/subscribe`)).toHaveLength(before);
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe(`${b.baseUrl}/api/resource-io/events?since=3`);
  });

  it.each([
    { kind: 'local-file' as const, path: '/private/server-a.md' },
    { kind: 'mount' as const, mountId: 'private-a-mount', path: 'notes' },
  ])('retires the old $kind retain before UI cleanup without subscribing its ref on B', async (ref) => {
    const releaseA = api.retainResourceWatch(ref);
    releases.push(releaseA);
    await new Promise(resolve => setTimeout(resolve, 0));
    activate({ ...a }); // Same server reconnect must renew existing retain.
    await vi.waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => url === `${a.baseUrl}/api/resource-io/subscribe`)).toHaveLength(2));
    activate(b);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(fetchMock.mock.calls.filter(([url]) => url === `${b.baseUrl}/api/resource-io/subscribe`)).toHaveLength(0);
    const releaseB = api.retainResourceWatch(ref); // Explicit new UI ownership.
    releases.push(releaseB);
    await vi.waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => url === `${b.baseUrl}/api/resource-io/subscribe`)).toHaveLength(1));
    releaseA();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(fetchMock.mock.calls.some(([url, opts]) => url.startsWith(b.baseUrl) && opts.method === 'DELETE')).toBe(false);
  });

  it('resets a known high cursor when switching to a different server', async () => {
    api.recordResourceEventCursor({ type: 'resource.changed', sequence: 4000 });
    activate(b);
    await api.catchUpResourceEventsAfterReconnect();
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe(`${b.baseUrl}/api/resource-io/events?since=0`);
  });

  it('fences an in-progress stale resubscription when its server is replaced', async () => {
    const replacement = deferred<unknown>();
    let aSubscriptions = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (url === `${a.baseUrl}/api/resource-io/subscribe`) {
        if (++aSubscriptions === 2) return { ok: true, json: () => replacement.promise };
        return reply({ subscriptionId: 'original-a' });
      }
      if (url.startsWith(`${a.baseUrl}/api/resource-io/events`)) return reply({ stale: true, latestSequence: 9000 });
      return reply(url.endsWith('/subscribe') ? { subscriptionId: 'new-b' } : { events: [], latestSequence: 4 });
    });
    const release = api.retainLocalFileResourceWatch('/tmp/resubscribe.md');
    releases.push(release);
    await new Promise(resolve => setTimeout(resolve, 0));
    const old = api.catchUpResourceEventsAfterReconnect();
    await vi.waitFor(() => expect(aSubscriptions).toBe(2));
    activate(b);
    releases.push(api.retainLocalFileResourceWatch('/tmp/resubscribe.md'));
    await api.catchUpResourceEventsAfterReconnect();
    replacement.resolve({ subscriptionId: 'late-a' });
    await old;
    await api.catchUpResourceEventsAfterReconnect();
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe(`${b.baseUrl}/api/resource-io/events?since=4`);
    expect(fetchMock.mock.calls.some(([url, opts]) => url === `${a.baseUrl}/api/resource-io/subscriptions/late-a` && opts.method === 'DELETE')).toBe(true);
    expect(fetchMock.mock.calls.some(([url, opts]) => url.startsWith(b.baseUrl) && opts.method === 'DELETE')).toBe(false);
  });

  it('bootstraps retain before any socket and retires it at a cross-server connectWebSocket entry', async () => {
    vi.resetModules();
    state.activeServerConnection = a;
    api = await import('../../services/resource-events');
    releases.push(api.retainLocalFileResourceWatch('/tmp/before-socket.md'));
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === `${a.baseUrl}/api/resource-io/subscribe`)).toBe(true));
    state.activeServerConnection = b;
    const { connectWebSocket } = await import('../../services/websocket');
    connectWebSocket(); // Ticket stays pending; invalidation must precede await.
    expect(fetchMock.mock.calls.some(([url]) => url === `${b.baseUrl}/api/resource-io/subscribe`)).toBe(false);
    releases.push(api.retainLocalFileResourceWatch('/tmp/new-b.md'));
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === `${b.baseUrl}/api/resource-io/subscribe`)).toBe(true));
    expect(fetchMock.mock.calls.some(([url, opts]) => url === `${a.baseUrl}/api/resource-io/subscriptions/same-id` && opts.method === 'DELETE')).toBe(true);
    state.activeServerConnection = null;
    connectWebSocket(); // Also clears the foreground binding on next generation.
  });

  it('binds pure foreground replay to the store connection and ignores its old body after a switch', async () => {
    vi.resetModules();
    state.activeServerConnection = a;
    api = await import('../../services/resource-events');
    const body = deferred<unknown>();
    const applied = vi.fn();
    fetchMock.mockImplementation(async (url: string) => url.startsWith(a.baseUrl)
      ? { ok: true, json: () => body.promise }
      : reply({ events: [], latestSequence: 2 }));
    const listeners = new Map<string, () => void>();
    const cleanup = api.bindResourceEventForegroundCatchUp(applied, {
      windowObj: { addEventListener: (_type: string, fn: () => void) => listeners.set('focus', fn), removeEventListener: () => {} } as never,
      documentObj: { visibilityState: 'visible', addEventListener: () => {}, removeEventListener: () => {} } as never,
      minIntervalMs: 0,
    });
    listeners.get('focus')?.();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    state.activeServerConnection = b; // No socket and no explicit setter.
    body.resolve({ events: [{ type: 'resource.changed', sequence: 9000 }], latestSequence: 9000 });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(applied).not.toHaveBeenCalled();
    listeners.get('focus')?.();
    await vi.waitFor(() => expect(fetchMock.mock.calls.at(-1)?.[0]).toBe(`${b.baseUrl}/api/resource-io/events?since=0`));
    cleanup();
    const count = fetchMock.mock.calls.length;
    listeners.get('focus')?.();
    expect(fetchMock).toHaveBeenCalledTimes(count);
  });

  it('makes release closures idempotent and unable to dispose a replacement watch', async () => {
    const first = api.retainLocalFileResourceWatch('/tmp/reused.md');
    first();
    const second = api.retainLocalFileResourceWatch('/tmp/reused.md');
    releases.push(second);
    await new Promise(resolve => setTimeout(resolve, 0));
    const deletes = fetchMock.mock.calls.filter(([, opts]) => opts.method === 'DELETE').length;
    first();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(fetchMock.mock.calls.filter(([, opts]) => opts.method === 'DELETE')).toHaveLength(deletes);
  });
});
