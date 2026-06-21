import fs from "fs";
import path from "path";
import { ResourceEventBus } from "./resource-event-bus.ts";
import { normalizeResourceRef, resourceKeyForRef } from "./resource-refs.ts";
import type { ResourceRef } from "./types.ts";

type WatchHandle = { close: () => void };
type WatchPath = (targetPath: string, handler: (changedPath?: string | null) => void) => WatchHandle;
type StatPath = (targetPath: string) => {
  exists: boolean;
  isDirectory: boolean;
  mtimeMs?: number;
  size?: number | null;
};

type Options = {
  emitEvent: (event: object, sessionPath?: string | null) => void;
  debounceMs?: number;
  watchPath?: WatchPath;
  statPath?: StatPath;
};

type Entry = {
  ref: ResourceRef;
  filePath: string;
  resourceKey: string;
  refCount: number;
  handle: WatchHandle;
  timer: ReturnType<typeof setTimeout> | null;
  pendingPath: string | null;
};

export class ResourceWatchRegistry {
  declare entries: Map<string, Entry>;
  declare debounceMs: number;
  declare watchPath: WatchPath;
  declare statPath: StatPath;
  declare eventBus: ResourceEventBus;

  constructor({
    emitEvent,
    debounceMs = 80,
    watchPath = defaultWatchPath,
    statPath = defaultStatPath,
  }: Options) {
    this.entries = new Map();
    this.debounceMs = debounceMs;
    this.watchPath = watchPath;
    this.statPath = statPath;
    this.eventBus = new ResourceEventBus({ emit: emitEvent });
  }

  retain(input: unknown): () => void {
    const ref = normalizeResourceRef(input);
    if (ref.kind !== "local-file") {
      throw new Error(`ResourceWatchRegistry only supports local-file watches for now: ${ref.kind}`);
    }
    const filePath = path.isAbsolute(ref.path) ? path.normalize(ref.path) : path.resolve(ref.path);
    const resourceKey = resourceKeyForRef({ kind: "local-file", path: filePath });
    const existing = this.entries.get(resourceKey);
    if (existing) {
      existing.refCount += 1;
      return () => this.release(resourceKey);
    }

    const entry: Entry = {
      ref: { kind: "local-file", path: filePath },
      filePath,
      resourceKey,
      refCount: 1,
      handle: this.watchPath(filePath, (changedPath) => this.schedule(entry, changedPath)),
      timer: null,
      pendingPath: null,
    };
    this.entries.set(resourceKey, entry);
    return () => this.release(resourceKey);
  }

  release(resourceKey: string): void {
    const entry = this.entries.get(resourceKey);
    if (!entry) return;
    if (entry.refCount > 1) {
      entry.refCount -= 1;
      return;
    }
    this.entries.delete(resourceKey);
    if (entry.timer) clearTimeout(entry.timer);
    entry.handle.close();
  }

  schedule(entry: Entry, changedPath?: string | null): void {
    if (!this.entries.has(entry.resourceKey)) return;
    if (changedPath) entry.pendingPath = changedPath;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.timer = null;
      this.emitSnapshot(entry);
    }, this.debounceMs);
  }

  emitSnapshot(entry: Entry): void {
    if (!this.entries.has(entry.resourceKey)) return;
    const eventPath = entry.pendingPath || entry.filePath;
    entry.pendingPath = null;
    const stat = this.statPath(eventPath);
    const resourceKey = resourceKeyForRef({ kind: "local-file", path: eventPath });
    const resource = {
      kind: "local-file" as const,
      provider: "local_fs",
      path: eventPath,
      filePath: eventPath,
    };
    if (!stat.exists) {
      this.eventBus.deleted({
        resourceKey,
        resource,
        source: "provider_watch",
        sessionPath: null,
      });
      return;
    }
    this.eventBus.changed({
      changeType: "modified",
      resourceKey,
      resource,
      version: {
        mtimeMs: stat.mtimeMs,
        size: stat.isDirectory ? null : stat.size ?? null,
      },
      source: "provider_watch",
      sessionPath: null,
    });
  }
}

function defaultWatchPath(targetPath: string, handler: (changedPath?: string | null) => void): WatchHandle {
  const watcher = fs.watch(targetPath, { persistent: false }, (_eventType, filename) => {
    const changedPath = filename
      ? path.join(targetPath, String(filename))
      : targetPath;
    handler(changedPath);
  });
  return { close: () => watcher.close() };
}

function defaultStatPath(targetPath: string) {
  try {
    const stat = fs.statSync(targetPath);
    return {
      exists: true,
      isDirectory: stat.isDirectory(),
      mtimeMs: stat.mtimeMs,
      size: stat.isDirectory() ? null : stat.size,
    };
  } catch (err) {
    if ((err as any)?.code === "ENOENT") {
      return { exists: false, isDirectory: false, size: null };
    }
    throw err;
  }
}
