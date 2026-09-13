export type XingyeStorageBackend = {
  readJson<T>(agentId: string, relativePath: string): Promise<T | null>;
  writeJson<T>(agentId: string, relativePath: string, data: T): Promise<void>;
  appendJsonl<T>(agentId: string, relativePath: string, record: T): Promise<void>;
  listJsonl<T>(agentId: string, relativePath: string): Promise<T[]>;
  writeJsonl<T>(agentId: string, relativePath: string, records: T[]): Promise<void>;
  /** Removes the first JSONL row whose `key` or `id` equals `recordId`; preserves order of remaining rows/lines. */
  deleteJsonlRecord(agentId: string, relativePath: string, recordId: string): Promise<boolean>;
  compareAndSwapJsonlRecord<T>(agentId: string, relativePath: string, recordId: string, expected: T, data: T): Promise<{ updated: boolean; record: T | null }>;
};

function key(agentId: string, relativePath: string): string {
  return `${agentId}::${relativePath}`;
}

// Development backends execute the comparison and write synchronously. Production
// performs this operation under the server's per-agent lock, across HTTP clients.
function compareAndSwapLines<T>(lines: string[], recordId: string, expected: T, data: T) {
  for (let i = 0; i < lines.length; i += 1) {
    let row;
    try { row = JSON.parse(lines[i]); } catch { continue; }
    if (jsonlRecordFieldAsString(row?.id) !== recordId && jsonlRecordFieldAsString(row?.key) !== recordId) continue;
    if (JSON.stringify(row) !== JSON.stringify(expected)) return { updated: false, record: row as T, lines };
    const next = [...lines];
    next[i] = JSON.stringify(data);
    return { updated: true, record: data, lines: next };
  }
  return { updated: false, record: null as T | null, lines };
}

/** Mirror server `xingye-storage.js` JSONL delete matching (ids + synthetic `${category}-${n}`). */
function jsonlRecordFieldAsString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function secretSpaceCategoryFromJsonlPath(relativePath: string): string | null {
  const norm = relativePath.replace(/\\/g, '/');
  const m = /^secret-space\/([^/]+)\.jsonl$/.exec(norm);
  return m?.[1] ?? null;
}

function jsonlRowMatchesDelete(
  recordId: string,
  relativePath: string,
  obj: Record<string, unknown>,
  parsedSuccessIndex: number,
): boolean {
  const rowKey = jsonlRecordFieldAsString(obj.key);
  const rowId = jsonlRecordFieldAsString(obj.id);
  if (recordId === rowKey || recordId === rowId) return true;
  const cat = secretSpaceCategoryFromJsonlPath(relativePath);
  if (!cat || rowKey || rowId) return false;
  return recordId === `${cat}-${parsedSuccessIndex}`;
}

export function createMemoryXingyeStorageBackend(): XingyeStorageBackend {
  const json = new Map<string, string>();
  const jsonl = new Map<string, string[]>();

  return {
    async compareAndSwapJsonlRecord<T>(agentId: string, relativePath: string, recordId: string, expected: T, data: T) {
      const k = key(agentId, relativePath);
      const result = compareAndSwapLines(jsonl.get(k) ?? [], recordId, expected, data);
      if (result.updated) jsonl.set(k, result.lines);
      return { updated: result.updated, record: result.record };
    },
    async readJson<T>(agentId: string, relativePath: string): Promise<T | null> {
      const raw = json.get(key(agentId, relativePath));
      if (raw == null) return null;
      try {
        return JSON.parse(raw) as T;
      } catch {
        return null;
      }
    },
    async writeJson<T>(agentId: string, relativePath: string, data: T): Promise<void> {
      json.set(key(agentId, relativePath), JSON.stringify(data));
    },
    async appendJsonl<T>(agentId: string, relativePath: string, record: T): Promise<void> {
      const k = key(agentId, relativePath);
      jsonl.set(k, [...(jsonl.get(k) ?? []), JSON.stringify(record)]);
    },
    async listJsonl<T>(agentId: string, relativePath: string): Promise<T[]> {
      const out: T[] = [];
      for (const line of jsonl.get(key(agentId, relativePath)) ?? []) {
        try {
          out.push(JSON.parse(line) as T);
        } catch {
          // skip malformed development fallback data
        }
      }
      return out;
    },
    async writeJsonl<T>(agentId: string, relativePath: string, records: T[]): Promise<void> {
      jsonl.set(key(agentId, relativePath), records.map((record) => JSON.stringify(record)));
    },
    async deleteJsonlRecord(agentId: string, relativePath: string, recordId: string): Promise<boolean> {
      const k = key(agentId, relativePath);
      const lines = jsonl.get(k) ?? [];
      const kept: string[] = [];
      let deleted = false;
      let parsedSuccessIndex = 0;
      for (const line of lines) {
        let obj: Record<string, unknown>;
        try {
          obj = JSON.parse(line) as Record<string, unknown>;
        } catch {
          kept.push(line);
          continue;
        }
        const match = !deleted && jsonlRowMatchesDelete(recordId, relativePath, obj, parsedSuccessIndex);
        if (match) {
          deleted = true;
        } else {
          kept.push(line);
        }
        parsedSuccessIndex += 1;
      }
      if (!deleted) return false;
      jsonl.set(k, kept);
      return true;
    },
  };
}

export function createLocalStorageXingyeBackend(
  storage: Pick<Storage, 'getItem' | 'setItem'>,
  keyForPath: (agentId: string, relativePath: string) => string,
): XingyeStorageBackend {
  return {
    async compareAndSwapJsonlRecord<T>(agentId: string, relativePath: string, recordId: string, expected: T, data: T) {
      const k = keyForPath(agentId, relativePath);
      const result = compareAndSwapLines((storage.getItem(k) ?? '').split('\n'), recordId, expected, data);
      if (result.updated) storage.setItem(k, result.lines.join('\n'));
      return { updated: result.updated, record: result.record };
    },
    async readJson<T>(agentId: string, relativePath: string): Promise<T | null> {
      const raw = storage.getItem(keyForPath(agentId, relativePath));
      if (raw == null) return null;
      try {
        return JSON.parse(raw) as T;
      } catch {
        return null;
      }
    },
    async writeJson<T>(agentId: string, relativePath: string, data: T): Promise<void> {
      storage.setItem(keyForPath(agentId, relativePath), JSON.stringify(data));
    },
    async appendJsonl<T>(agentId: string, relativePath: string, record: T): Promise<void> {
      const k = keyForPath(agentId, relativePath);
      const line = `${JSON.stringify(record)}\n`;
      storage.setItem(k, (storage.getItem(k) ?? '') + line);
    },
    async listJsonl<T>(agentId: string, relativePath: string): Promise<T[]> {
      const raw = storage.getItem(keyForPath(agentId, relativePath));
      if (!raw) return [];
      const out: T[] = [];
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          out.push(JSON.parse(trimmed) as T);
        } catch {
          // skip malformed development fallback data
        }
      }
      return out;
    },
    async writeJsonl<T>(agentId: string, relativePath: string, records: T[]): Promise<void> {
      const kp = keyForPath(agentId, relativePath);
      storage.setItem(kp, records.length ? `${records.map((record) => JSON.stringify(record)).join('\n')}\n` : '');
    },
    async deleteJsonlRecord(agentId: string, relativePath: string, recordId: string): Promise<boolean> {
      const kp = keyForPath(agentId, relativePath);
      const raw = storage.getItem(kp);
      if (!raw) return false;
      const lines = raw.split('\n');
      const kept: string[] = [];
      let deleted = false;
      let parsedSuccessIndex = 0;
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let obj: Record<string, unknown>;
        try {
          obj = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
          kept.push(trimmed);
          continue;
        }
        const match = !deleted && jsonlRowMatchesDelete(recordId, relativePath, obj, parsedSuccessIndex);
        if (match) {
          deleted = true;
        } else {
          kept.push(trimmed);
        }
        parsedSuccessIndex += 1;
      }
      if (!deleted) return false;
      storage.setItem(kp, kept.length ? `${kept.map((l) => `${l}\n`).join('')}` : '');
      return true;
    },
  };
}

type PostFn = (body: Record<string, unknown>) => Promise<any>;

function requireAgentId(agentId: string): void {
  if (typeof agentId !== 'string' || !agentId.trim()) {
    throw new Error('agentId is required');
  }
}

export function createAgentXingyeStorageBackend(post: PostFn): XingyeStorageBackend {
  return {
    async compareAndSwapJsonlRecord<T>(agentId: string, relativePath: string, recordId: string, expected: T, data: T) {
      requireAgentId(agentId);
      const response = await post({ action: 'compareAndSwapJsonlRecord', agentId, relativePath, recordId, expected, data });
      if (typeof response?.updated !== 'boolean') throw new Error('Invalid JSONL update response');
      return { updated: response.updated, record: (response.record ?? null) as T | null };
    },
    async readJson<T>(agentId: string, relativePath: string): Promise<T | null> {
      requireAgentId(agentId);
      const data = await post({ action: 'readJson', agentId, relativePath });
      if (data?.missing || data?.data == null) return null;
      return data.data as T;
    },
    async writeJson<T>(agentId: string, relativePath: string, body: T): Promise<void> {
      requireAgentId(agentId);
      await post({ action: 'writeJson', agentId, relativePath, data: body });
    },
    async appendJsonl<T>(agentId: string, relativePath: string, record: T): Promise<void> {
      requireAgentId(agentId);
      await post({ action: 'appendJsonl', agentId, relativePath, data: record });
    },
    async listJsonl<T>(agentId: string, relativePath: string): Promise<T[]> {
      requireAgentId(agentId);
      const data = await post({ action: 'listJsonl', agentId, relativePath });
      return Array.isArray(data?.records) ? data.records as T[] : [];
    },
    async writeJsonl<T>(agentId: string, relativePath: string, records: T[]): Promise<void> {
      requireAgentId(agentId);
      await post({ action: 'writeJsonl', agentId, relativePath, records });
    },
    async deleteJsonlRecord(agentId: string, relativePath: string, recordId: string): Promise<boolean> {
      requireAgentId(agentId);
      const data = await post({ action: 'deleteJsonlRecord', agentId, relativePath, recordId });
      return Boolean(data?.deleted);
    },
  };
}
