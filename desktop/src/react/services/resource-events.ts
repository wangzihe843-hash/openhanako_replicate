import { hanaFetch } from '../hooks/use-hana-fetch';

type ResourceRef =
  | { kind: 'local-file'; path: string };

type WatchEntry = {
  refCount: number;
  watchId: string | null;
  disposed: boolean;
  released: boolean;
  ready: Promise<void>;
};

const watches = new Map<string, WatchEntry>();

function resourceKey(ref: ResourceRef): string {
  if (ref.kind === 'local-file') {
    const slashed = ref.path.replace(/\\/g, '/').replace(/\/+$/g, '');
    return `local-file:${/^[A-Za-z]:/.test(slashed) ? slashed.toLowerCase() : slashed}`;
  }
  return JSON.stringify(ref);
}

export function retainResourceWatch(ref: ResourceRef): () => void {
  const key = resourceKey(ref);
  const existing = watches.get(key);
  if (existing) {
    existing.refCount += 1;
    return () => releaseResourceWatch(key);
  }

  const entry: WatchEntry = {
    refCount: 1,
    watchId: null,
    disposed: false,
    released: false,
    ready: Promise.resolve(),
  };
  entry.ready = hanaFetch('/api/resource-io/watch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ resource: ref }),
    throwOnHttpError: false,
  })
    .then(res => res.json())
    .then((data) => {
      if (typeof data?.watchId === 'string') entry.watchId = data.watchId;
      else console.warn('[resource-events] watch failed:', data?.error || ref);
      if (entry.disposed) releaseEntry(entry);
    })
    .catch((err) => {
      if (!entry.disposed) console.warn('[resource-events] watch failed:', err);
    });
  watches.set(key, entry);
  return () => releaseResourceWatch(key);
}

export function retainLocalFileResourceWatch(filePath: string): () => void {
  return retainResourceWatch({ kind: 'local-file', path: filePath });
}

function releaseResourceWatch(key: string): void {
  const entry = watches.get(key);
  if (!entry) return;
  if (entry.refCount > 1) {
    entry.refCount -= 1;
    return;
  }
  watches.delete(key);
  entry.disposed = true;
  void entry.ready.then(() => releaseEntry(entry));
}

function releaseEntry(entry: WatchEntry): void {
  if (entry.released || !entry.watchId) return;
  entry.released = true;
  void hanaFetch(`/api/resource-io/watch/${encodeURIComponent(entry.watchId)}`, {
    method: 'DELETE',
    throwOnHttpError: false,
  }).catch((err) => {
    console.warn('[resource-events] unwatch failed:', err);
  });
}
