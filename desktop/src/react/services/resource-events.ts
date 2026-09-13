import { hanaFetch } from '../hooks/use-hana-fetch';
import { resolveServerConnection, type ServerConnection } from './server-connection';
import { useStore } from '../stores';

export type ResourceRef =
  | { kind: 'local-file'; path: string }
  | { kind: 'mount'; mountId: string; path: string };

type WatchLease = {
  connection: ServerConnection;
  subscriptionId: string | null;
  disposed: boolean;
  released: boolean;
  ready: Promise<void>;
};

type WatchEntry = {
  ownerIdentity: string;
  ref: ResourceRef;
  refCount: number;
  disposed: boolean;
  lease: WatchLease | null;
};

const watches = new Map<string, WatchEntry>();
let activeConnection: ServerConnection | null = null;
let connectionEpoch = 0;
let observedStoreIdentity: string | undefined;

export function resourceEventConnectionKey(connection: ServerConnection | null | undefined): string {
  if (!connection) return '';
  return JSON.stringify([
    connection.connectionId, connection.serverId, connection.serverNodeId,
    connection.studioId, connection.userId, connection.baseUrl,
    connection.credentialKind, connection.token,
  ]);
}

type ResourceEvent = {
  type?: string;
  sequence?: number;
  [key: string]: unknown;
};

type ResourceEventFetch = (
  path: string,
  opts?: RequestInit & { timeout?: number; throwOnHttpError?: boolean; connection?: ServerConnection },
) => Promise<{ json: () => Promise<any> }>;

type ResourceEventClientOptions = {
  fetchImpl?: ResourceEventFetch;
  applyEvent?: (event: ResourceEvent) => void;
  resubscribeWatches?: () => Promise<void> | void;
  refreshConnection?: () => void;
};

type ForegroundCatchUpOptions = {
  windowObj?: Pick<Window, 'addEventListener' | 'removeEventListener'> | null;
  documentObj?: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'> | null;
  catchUp?: () => Promise<unknown> | unknown;
  minIntervalMs?: number;
  now?: () => number;
};

export function createResourceEventClient({
  fetchImpl = hanaFetch,
  applyEvent,
  resubscribeWatches,
  refreshConnection,
}: ResourceEventClientOptions = {}) {
  let lastSeenSequence = 0;
  let epoch = 0;
  // Undefined supports standalone clients with an injected fetch implementation.
  // The shared renderer client is explicitly inactive until a connection is set.
  let connection: ServerConnection | null | undefined;
  const setConnection = (next: ServerConnection | null) => {
    epoch += 1;
    if (resourceEventConnectionKey(connection) !== resourceEventConnectionKey(next)) lastSeenSequence = 0;
    connection = next ? { ...next } : null;
  };

  const handleEvent = (event: ResourceEvent | null | undefined): void => {
    refreshConnection?.();
    if (connection === null || !isResourceEvent(event)) return;
    if (Number.isFinite(event.sequence) && Number(event.sequence) > lastSeenSequence) {
      lastSeenSequence = Math.floor(Number(event.sequence));
    }
  };

  const catchUpAfterReconnect = async (options: { applyEvent?: (event: ResourceEvent) => void } = {}) => {
    refreshConnection?.();
    if (connection === null) return null;
    const requestEpoch = epoch;
    const target = connection;
    const isCurrent = () => {
      refreshConnection?.();
      return requestEpoch === epoch;
    };
    const res = await fetchImpl(`/api/resource-io/events?since=${lastSeenSequence}`, {
      method: 'GET',
      throwOnHttpError: false,
      ...(target ? { connection: target } : {}),
    });
    if (!isCurrent()) return null;
    const data = await res.json();
    if (!isCurrent()) return null;
    if (data?.stale) {
      await resubscribeWatches?.();
      if (!isCurrent()) return null;
      if (Number.isFinite(data.latestSequence) && Number(data.latestSequence) > lastSeenSequence) {
        lastSeenSequence = Math.floor(Number(data.latestSequence));
      }
      return data;
    }

    const handler = options.applyEvent || applyEvent;
    for (const event of Array.isArray(data?.events) ? data.events : []) {
      if (!isCurrent()) return null;
      handleEvent(event);
      handler?.(event);
    }
    if (!isCurrent()) return null;
    if (Number.isFinite(data?.latestSequence) && Number(data.latestSequence) > lastSeenSequence) {
      lastSeenSequence = Math.floor(Number(data.latestSequence));
    }
    return data;
  };

  return {
    setConnection,
    handleEvent,
    catchUpAfterReconnect,
    lastSeenSequence: () => lastSeenSequence,
  };
}

const resourceEventClient = createResourceEventClient({
  fetchImpl: hanaFetch,
  resubscribeWatches: resubscribeActiveWatches,
  refreshConnection: syncResourceEventConnection,
});
resourceEventClient.setConnection(null);

/** Call before each WebSocket connection attempt, including disconnect/no target. */
export function setResourceEventConnection(connection: ServerConnection | null): void {
  observedStoreIdentity = resourceEventConnectionKey(resolveServerConnection(useStore.getState()));
  connectionEpoch += 1;
  activeConnection = connection ? { ...connection } : null;
  resourceEventClient.setConnection(activeConnection);
  for (const [key, entry] of watches) {
    if (entry.lease) releaseLease(entry.lease);
    if (activeConnection && entry.ownerIdentity === resourceEventConnectionKey(activeConnection)) {
      entry.lease = subscribeEntry(entry, activeConnection);
    } else {
      // Resource paths/mount IDs belong to the original server. Never migrate
      // old UI retains to another server before its effects have cleaned up.
      entry.disposed = true;
      entry.lease = null;
      watches.delete(key);
    }
  }
}


// Bootstrap watches/foreground requests even before the first socket, and fence
// a store connection switch while a fetch or its JSON body is still pending.
// Explicit socket targets remain authoritative while the store is unchanged.
function syncResourceEventConnection(): void {
  const connection = resolveServerConnection(useStore.getState());
  if (resourceEventConnectionKey(connection) !== observedStoreIdentity) setResourceEventConnection(connection);
}

function normalizeResourceRef(ref: ResourceRef): ResourceRef {
  if (ref.kind === 'local-file') {
    return { kind: 'local-file', path: ref.path };
  }
  return {
    kind: 'mount',
    mountId: ref.mountId,
    path: String(ref.path || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''),
  };
}

export function resourceWatchKey(ref: ResourceRef): string {
  const normalized = normalizeResourceRef(ref);
  if (normalized.kind === 'local-file') {
    const slashed = normalized.path.replace(/\\/g, '/').replace(/\/+$/g, '');
    return `local-file:${/^[A-Za-z]:/.test(slashed) ? slashed.toLowerCase() : slashed}`;
  }
  return `mount:${normalized.mountId}:${normalized.path}`;
}

export function retainResourceWatch(ref: ResourceRef): () => void {
  syncResourceEventConnection();
  const normalizedRef = normalizeResourceRef(ref);
  const key = resourceWatchKey(normalizedRef);
  let entry = watches.get(key);
  if (entry) entry.refCount += 1;
  else {
    entry = { ownerIdentity: resourceEventConnectionKey(activeConnection), ref: normalizedRef, refCount: 1, disposed: false, lease: null };
    watches.set(key, entry);
    if (activeConnection) entry.lease = subscribeEntry(entry, activeConnection);
  }
  const retainedEntry = entry;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseResourceWatch(key, retainedEntry);
  };
}

function subscribeEntry(entry: WatchEntry, connection: ServerConnection): WatchLease {
  const lease: WatchLease = {
    connection, subscriptionId: null, disposed: false, released: false, ready: Promise.resolve(),
  };
  lease.ready = hanaFetch('/api/resource-io/subscribe', {
    connection: lease.connection,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ purpose: 'resource-watch', resources: [entry.ref] }),
    throwOnHttpError: false,
  })
    .then(res => res.json())
    .then((data) => {
      if (typeof data?.subscriptionId === 'string') lease.subscriptionId = data.subscriptionId;
      else if (!lease.disposed) console.warn('[resource-events] watch failed:', data?.error || entry.ref);
      if (entry.disposed || entry.lease !== lease || lease.disposed) releaseLease(lease);
    })
    .catch((err) => {
      if (!lease.disposed) console.warn('[resource-events] watch failed:', err);
    });
  return lease;
}

export function retainLocalFileResourceWatch(filePath: string): () => void {
  return retainResourceWatch({ kind: 'local-file', path: filePath });
}

function releaseResourceWatch(key: string, entry: WatchEntry): void {
  if (watches.get(key) !== entry || entry.disposed) return;
  if (--entry.refCount > 0) return;
  watches.delete(key);
  entry.disposed = true;
  if (entry.lease) releaseLease(entry.lease);
}

function releaseLease(lease: WatchLease): void {
  lease.disposed = true;
  if (lease.released || !lease.subscriptionId) return;
  lease.released = true;
  void hanaFetch(`/api/resource-io/subscriptions/${encodeURIComponent(lease.subscriptionId)}`, {
    connection: lease.connection,
    method: 'DELETE',
    throwOnHttpError: false,
  }).catch((err) => {
    console.warn('[resource-events] unwatch failed:', err);
  });
}

async function resubscribeActiveWatches(): Promise<void> {
  const epoch = connectionEpoch;
  const connection = activeConnection;
  if (!connection) return;
  const entries = [...watches.values()].filter(entry => !entry.disposed);
  await Promise.all(entries.map(async (entry) => {
    if (epoch !== connectionEpoch || entry.disposed) return;
    if (entry.lease) releaseLease(entry.lease);
    entry.lease = subscribeEntry(entry, connection);
    await entry.lease.ready;
  }));
}

function isResourceEvent(event: ResourceEvent | null | undefined): event is ResourceEvent {
  return event?.type === 'resource.changed' || event?.type === 'resource.deleted' || event?.type === 'resource.renamed';
}

export function recordResourceEventCursor(event: ResourceEvent | null | undefined): void {
  resourceEventClient.handleEvent(event);
}

export function catchUpResourceEventsAfterReconnect(applyEvent?: (event: ResourceEvent) => void): Promise<unknown> {
  return resourceEventClient.catchUpAfterReconnect({ applyEvent });
}

export function bindResourceEventForegroundCatchUp(
  applyEvent?: (event: ResourceEvent) => void,
  options: ForegroundCatchUpOptions = {},
): () => void {
  const windowObj = options.windowObj ?? (typeof window !== 'undefined' ? window : null);
  const documentObj = options.documentObj ?? (typeof document !== 'undefined' ? document : null);
  if (!windowObj || !documentObj) return () => {};

  const minIntervalMs = Math.max(0, Math.floor(Number(options.minIntervalMs ?? 1000) || 0));
  const now = options.now ?? (() => Date.now());
  const catchUp = options.catchUp ?? (() => catchUpResourceEventsAfterReconnect(applyEvent));
  let disposed = false;
  let inFlight = false;
  let lastStartedAt = 0;

  const run = () => {
    if (disposed || documentObj.visibilityState === 'hidden') return;
    const startedAt = now();
    if (inFlight || (lastStartedAt && startedAt - lastStartedAt < minIntervalMs)) return;
    inFlight = true;
    lastStartedAt = startedAt;
    Promise.resolve(catchUp())
      .catch((err) => {
        console.warn('[resource-events] foreground catch-up failed:', err);
      })
      .finally(() => {
        inFlight = false;
      });
  };

  const onVisibilityChange = () => {
    if (documentObj.visibilityState === 'visible') run();
  };

  windowObj.addEventListener('focus', run);
  documentObj.addEventListener('visibilitychange', onVisibilityChange);
  return () => {
    disposed = true;
    windowObj.removeEventListener('focus', run);
    documentObj.removeEventListener('visibilitychange', onVisibilityChange);
  };
}
