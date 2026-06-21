import type {
  ResourceChangedEvent,
  ResourceDeletedEvent,
  ResourceEvent,
  ResourceRenamedEvent,
} from "./types.ts";

type EventEmit = (event: ResourceEvent, sessionPath?: string | null) => void;

type ResourceEventBusOptions = {
  emit: EventEmit;
  now?: () => Date;
  dedupeSize?: number;
};

type ChangedInput = Omit<ResourceChangedEvent, "type" | "sequence" | "occurredAt">;
type DeletedInput = Omit<ResourceDeletedEvent, "type" | "sequence" | "occurredAt">;
type RenamedInput = Omit<ResourceRenamedEvent, "type" | "sequence" | "occurredAt">;

export class ResourceEventBus {
  declare _emit: EventEmit;
  declare _now: () => Date;
  declare _sequence: number;
  declare _dedupeSize: number;
  declare _recentChangedKeys: Set<string>;

  constructor({ emit, now = () => new Date(), dedupeSize = 512 }: ResourceEventBusOptions) {
    if (typeof emit !== "function") throw new Error("ResourceEventBus requires emit");
    this._emit = emit;
    this._now = now;
    this._sequence = 0;
    this._dedupeSize = dedupeSize;
    this._recentChangedKeys = new Set();
  }

  changed(input: ChangedInput): ResourceChangedEvent | null {
    const dedupeKey = changedDedupeKey(input);
    if (dedupeKey && this._recentChangedKeys.has(dedupeKey)) return null;
    if (dedupeKey) this._rememberChangedKey(dedupeKey);

    const event: ResourceChangedEvent = {
      ...input,
      type: "resource.changed",
      sequence: this._nextSequence(),
      occurredAt: this._now().toISOString(),
    };
    this._emit(event, input.sessionPath ?? null);
    return event;
  }

  deleted(input: DeletedInput): ResourceDeletedEvent {
    const event: ResourceDeletedEvent = {
      ...input,
      type: "resource.deleted",
      sequence: this._nextSequence(),
      occurredAt: this._now().toISOString(),
    };
    this._emit(event, input.sessionPath ?? null);
    return event;
  }

  renamed(input: RenamedInput): ResourceRenamedEvent {
    const event: ResourceRenamedEvent = {
      ...input,
      type: "resource.renamed",
      sequence: this._nextSequence(),
      occurredAt: this._now().toISOString(),
    };
    this._emit(event, input.sessionPath ?? null);
    return event;
  }

  _nextSequence(): number {
    this._sequence += 1;
    return this._sequence;
  }

  _rememberChangedKey(key: string): void {
    this._recentChangedKeys.add(key);
    while (this._recentChangedKeys.size > this._dedupeSize) {
      const first = this._recentChangedKeys.values().next().value;
      if (!first) break;
      this._recentChangedKeys.delete(first);
    }
  }
}

function changedDedupeKey(input: ChangedInput): string | null {
  const version = input.version;
  if (!version) return null;
  return JSON.stringify({
    resourceKey: input.resourceKey,
    changeType: input.changeType,
    mtimeMs: version.mtimeMs,
    size: version.size,
    sha256: version.sha256,
    etag: version.etag,
    sequence: version.sequence,
  });
}
