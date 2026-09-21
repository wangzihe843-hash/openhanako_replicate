import type { JSONContent } from '@tiptap/core';

/** 草稿本地版本始终记录；持久化监听在 app-init 注册。 */
export interface DraftSyncListener {
  scope?(): string;
  canonicalKey?(key: string): string;
  onSet(key: string, text: string, doc: JSONContent | null): void;
  onClear(key: string): void;
}

interface DraftMutationToken {
  key: string;
  version: number;
}

let listener: DraftSyncListener | null = null;
let mutationVersion = 0;
interface DraftMutation {
  key: string;
  scope: string;
  version: number;
  hydrationBarrier: number;
  cleared: boolean;
  pending: boolean;
  draft: { text: string; doc: JSONContent | null } | null;
}

const mutations = new Map<string, DraftMutation>();
const hydrations = new Set<{ startedAtVersion: number }>();

function releaseAcknowledgedDrafts(): void {
  const oldestHydration = Math.min(...[...hydrations].map(item => item.startedAtVersion));
  for (const [key, mutation] of mutations) {
    if (!mutation.pending && mutation.draft && mutation.hydrationBarrier <= oldestHydration) {
      mutations.set(key, { ...mutation, draft: null });
    }
  }
}

function scopedKey(key: string, scope = listener?.scope?.() || ''): string {
  return JSON.stringify([scope, key]);
}

function bindUnscopedMutations(scope: string): void {
  if (!scope) return;
  // Startup input belongs to the first resolved connection, never every later one.
  for (const [identity, mutation] of mutations) {
    if (mutation.scope) continue;
    const key = scopedKey(mutation.key, scope);
    const previous = mutations.get(key);
    if (!previous || mutation.version > previous.version) {
      mutations.set(key, { ...mutation, scope });
    }
    mutations.delete(identity);
  }
}

/** Local writes remain authoritative even when archive retires the runtime cache. */
export function captureDraftHydrationGuard() {
  const scope = listener?.scope?.() || '';
  bindUnscopedMutations(scope);
  const hydration = { startedAtVersion: mutationVersion };
  hydrations.add(hydration);
  const canonicalKey = listener?.canonicalKey || ((key: string) => key);
  const latestMutations = () => {
    const latest = new Map<string, DraftMutation>();
    for (const mutation of mutations.values()) {
      if (mutation.scope !== scope && mutation.scope !== '') continue;
      const identity = canonicalKey(mutation.key);
      const previous = latest.get(identity);
      if (!previous || mutation.version > previous.version) {
        latest.set(identity, mutation);
      }
    }
    return latest;
  };
  return {
    canHydrate(key: string): boolean {
      const latest = latestMutations().get(canonicalKey(key));
      return !latest || (!latest.cleared && !latest.pending && latest.hydrationBarrier <= hydration.startedAtVersion);
    },
    pendingDrafts() {
      return [...latestMutations()].flatMap(([key, mutation]) => (
        mutation.draft && (mutation.pending || mutation.hydrationBarrier > hydration.startedAtVersion)
          ? [{ key, ...mutation.draft }]
          : []
      ));
    },
    dispose(): void {
      hydrations.delete(hydration);
      releaseAcknowledgedDrafts();
    },
  };
}

export function captureDraftMutation(key: string): DraftMutationToken | null {
  const identity = scopedKey(key);
  const mutation = mutations.get(identity);
  return mutation ? { key: identity, version: mutation.version } : null;
}

export function acknowledgeDraftMutation(token: DraftMutationToken | null): void {
  if (!token) return;
  const mutation = mutations.get(token.key);
  if (mutation?.version === token.version) {
    // A pre-commit GET cannot replace either a clear or a newer non-empty draft.
    // Keep its text/doc only while an older GET still needs the local snapshot.
    mutations.set(token.key, { ...mutation, hydrationBarrier: ++mutationVersion, cleared: false, pending: false });
    releaseAcknowledgedDrafts();
  }
}

export function registerDraftSyncListener(next: DraftSyncListener | null): void {
  listener = next;
  bindUnscopedMutations(listener?.scope?.() || '');
}

function recordMutation(key: string, draft: DraftMutation['draft']): void {
  const scope = listener?.scope?.() || '';
  bindUnscopedMutations(scope);
  const version = ++mutationVersion;
  mutations.set(scopedKey(key, scope), {
    key, scope, version, hydrationBarrier: version, cleared: draft === null, pending: true, draft,
  });
}

export function notifyDraftSet(key: string, text: string, doc: JSONContent | null): void {
  recordMutation(key, text.trim() ? { text, doc } : null);
  listener?.onSet(key, text, doc);
}

export function notifyDraftCleared(key: string): void {
  recordMutation(key, null);
  listener?.onClear(key);
}
